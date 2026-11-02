// 会话以追加式 JSONL 事件记录作为事实来源；恢复和模型上下文都从记录重建。
// 写入失败时回退文件长度，清除未完成的末行，避免重试时产生重复序号。
// 新记录首行保存会话元数据和格式版本；版本或事件类型无法识别时拒绝重建。
// 压缩摘要和检查点保存在独立文件中。读取前会验证覆盖事件的哈希，校验失败时忽略检查点。
// 记录读写失败会抛出 `KernelRuntimeError` 并中止循环，不能当作普通工具失败处理。
import { mkdir, open, truncate, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError, KernelRuntimeError } from '../errors.js';
import { loadCheckpointFile, type CompactionBlock } from './checkpoint.js';
import { checkedImageReferences } from './media.js';
import { createSessionHeader } from './format.js';
import { readSessionRecord } from './record.js';
import { acquireSessionLock } from './lock.js';
import type { SessionEvent, PendingSessionEvent, SessionHeader } from './format.js';
import type { ReadSessionRecord } from './record.js';
import type { SessionLock } from './lock.js';
import { createStreamDraft, readStreamDraft, type StreamDraftWriter, type ProvisionalOutput } from './stream-draft.js';

export interface SessionMetadata {
  readonly projectRoot?: string;
  readonly workspace?: string;
  readonly workspaceOrigin?: 'explicit' | 'default';
  readonly mode?: { readonly name: string; readonly layer: string };
}

export interface CreateSessionLogOptions {
  readonly directory: string;
  readonly id: string;
  readonly meta?: SessionMetadata | (() => SessionMetadata | undefined);
}

export interface SessionLog {
  readonly directory: string;
  readonly path: string;
  append(event: PendingSessionEvent): Promise<SessionEvent>;
  acquire(): Promise<void>;
  close(): Promise<void>;
  read(): Promise<SessionEvent[]>;
  header(): Promise<SessionHeader | undefined>;
  modelView(): Promise<unknown[]>;
  beginOutput(userSeq: number | undefined, onFailure: (error: KernelRuntimeError) => void): StreamDraftWriter;
  readProvisionalOutput(events: readonly SessionEvent[]): Promise<ProvisionalOutput | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectModelView(events: readonly SessionEvent[], blocks: readonly Pick<CompactionBlock, 'fromSeq' | 'toSeq' | 'text'>[] = []): unknown[] {
  const view = [];
  let blockIndex = 0;
  let reasoning = '';
  for (const event of events) {
    while (blockIndex < blocks.length && event.seq > blocks[blockIndex].toSeq) blockIndex += 1;
    const block = blocks[blockIndex];
    if (block !== undefined && event.seq >= block.fromSeq) {
      if (event.seq === block.fromSeq) view.push({ role: 'user', text: block.text });
      continue;
    }
    if (event.kind === 'user') {
      reasoning = '';
      view.push({ role: 'user', text: event.text });
    } else if (event.kind === 'reasoning') {
      reasoning += typeof event.text === 'string' ? event.text : '';
    } else if (event.kind === 'assistant') {
      const assistantReasoning = typeof event.reasoning === 'string' ? event.reasoning : reasoning;
      view.push({ role: 'assistant', text: event.text, toolCalls: event.toolCalls,
        ...(assistantReasoning === '' ? {} : { reasoning: assistantReasoning }) });
      reasoning = '';
    } else if (event.kind === 'tool') {
      if (!isRecord(event.result)) throw new TypeError('a tool event has no result object');
      const result = event.result;
      const content = result.content === '' && result.failed ? `${result.code}: ${result.reason ?? 'no output'}` : result.content;
      view.push({ role: 'tool', id: event.callId, tool: event.tool, content, failed: result.failed, code: result.code,
        ...(result.images === undefined ? {} : { images: checkedImageReferences(result.images) }) });
    }
  }
  return view;
}

/**
 * @param {{ directory: string, id: string, meta?: { projectRoot?: string, mode?: { name: string, layer: string } } |
 *   (() => { projectRoot?: string, mode?: { name: string, layer: string } } | undefined) }} options
 *   `meta` 提供首行会话元数据；可以使用函数，以便在创建记录时解析最终模式。
 */
export function createSessionLog({ directory, id, meta }: CreateSessionLogOptions): SessionLog {
  if (typeof directory !== 'string' || directory === '') throw new KernelError('session_directory_required');
  if (typeof id !== 'string' || id === '') throw new KernelError('session_id_required');
  const path = join(directory, `${id}.jsonl`);
  let nextSeq = 0;
  // 首行元数据只写一次。读写前需知道现有记录的末尾序号，以及文件是否仍为空。
  // Host 打开会话时会先读取记录，因此读取操作不能清除待写首行的状态。
  let needsHeader = false;
  let writableProbed = false;
  let ownership: SessionLock | undefined;
  let retained = false;
  let stopped = false;

  async function takeOwnership(): Promise<void> {
    if (stopped) throw new KernelRuntimeError('session_closed', { detail: path });
    if (ownership === undefined) {
      ownership = await acquireSessionLock(path);
      writableProbed = false;
    }
    ownership.assertOwned();
  }

  async function loadEvents(repair = false): Promise<ReadSessionRecord> {
    const record = await readSessionRecord(path);
    if (repair && record.truncatedBytes > 0) await truncate(path, record.completeBytes);
    return record;
  }

  // 首次写入前读取文件尾部，确保新事件序号紧接最后一条记录。
  // 只有完全空的文件才会写入新会话首行。
  async function probe(): Promise<boolean> {
    if (writableProbed) return needsHeader;
    const { events, header, lastSeq } = await loadEvents(true);
    nextSeq = lastSeq + 1;
    needsHeader = header === undefined && events.length === 0;
    writableProbed = true;
    return needsHeader;
  }

  async function appendOnce(event: PendingSessionEvent): Promise<SessionEvent> {
    const writeHeader = await probe();
    const written: SessionEvent = { seq: nextSeq, ...event };
    const lines: string[] = [];
    if (writeHeader) {
      lines.push(JSON.stringify(createSessionHeader({
        id,
        ...(typeof meta === 'function' ? meta() ?? {} : meta ?? {}),
        createdAt: new Date().toISOString(),
      })));
      // 首行不计入事件序号，因此首个事件仍从 0 开始。
      needsHeader = false;
    }
    lines.push(JSON.stringify(written));
    const line = `${lines.join('\n')}\n`;
    let handle: FileHandle;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(path, 'a');
    } catch (error) {
      writableProbed = false;
      throw new KernelRuntimeError('session_write_failed', { cause: error });
    }
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    let size;
    try {
      ({ size } = await handle.stat());
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } catch (error) {
      writableProbed = false;
      // 回退到写入前的文件长度，避免重试时重复写入相同序号，然后继续抛出原始错误。
      await close();
      // 无法读取原文件长度时不截断文件，以免丢失已有记录。
      // 下一次持有锁的写入会检查并修复末尾残缺行。
      try {
        if (size !== undefined) await truncate(path, size);
      } catch (rollbackError) {
        throw new KernelRuntimeError('session_rollback_failed', { cause: rollbackError });
      }
      throw new KernelRuntimeError('session_write_failed', { cause: error });
    }
    await close();
    nextSeq += 1;
    return written;
  }

  // 并发工具调用可能同时写入同一记录，因此序号分配、写入和失败回退必须串行执行。
  // 同一实例的读取也排队，避免读到未完成的追加或过期序号。
  let pending: Promise<unknown> = Promise.resolve();

  // 一次写入失败不会阻止队列中的下一次写入；每个错误仍返回给原调用方。
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = pending.then(action, action);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  function append(event: PendingSessionEvent): Promise<SessionEvent> {
    return serialize(async () => {
      await takeOwnership();
      try {
        return await appendOnce(event);
      } finally {
        if (!retained) {
          const lease = ownership;
          ownership = undefined;
          if (lease !== undefined) await lease.release();
        }
      }
    });
  }

  // 读取全部事件；首行元数据由 `header()` 单独提供，不属于事件。
  // 同时刷新末尾序号和空文件状态，确保先读后写时仍能补写首行元数据。
  async function readOnce(): Promise<SessionEvent[]> {
    const { events, header, lastSeq, truncatedBytes } = await loadEvents();
    if (truncatedBytes > 0) writableProbed = false;
    nextSeq = lastSeq + 1;
    needsHeader = header === undefined && events.length === 0;
    return events;
  }

  const session: SessionLog = {
    directory,
    path,
    append,
    beginOutput: (userSeq, onFailure) => createStreamDraft(directory, id, userSeq, onFailure),
    readProvisionalOutput: events => readStreamDraft(directory, id, events),
    acquire: () => serialize(async () => {
      await takeOwnership();
      retained = true;
    }),
    close: () => serialize(async () => {
      stopped = true;
      retained = false;
      const lease = ownership;
      ownership = undefined;
      if (lease !== undefined) await lease.release();
    }),
    read: () => serialize(readOnce),
    // 旧记录没有首行时按 legacy-v0 读取，不在读取过程中修改文件。
    header: () => serialize(async () => (await loadEvents()).header),

    // 从记录重建模型上次看到的上下文。投影必须包含助手调用和对应工具结果，才能生成合法请求。
    // 推理事件保留在记录中供界面查看，不发送给模型。
    // 压缩块通过校验时，各块用摘要替换其覆盖范围，其余事件保持原样；原始日志不会被修改。
    async modelView(): Promise<unknown[]> {
      const events = await this.read();
      const { blocks } = await loadCheckpointFile({ directory, id, events });
      return projectModelView(events, blocks);
    },
  };
  return session;
}
