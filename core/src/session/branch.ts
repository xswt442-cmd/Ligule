// 创建分支时将父记录前缀复制到新会话，保持父记录不变。
// 未指定位置时复制完整记录；指定事件序号时，仅复制到该完整结束轮次。
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../errors.js';
import { workspaceIdentity } from '../workspace-identity.js';
import { createSessionHeader, type SessionModeIdentity } from './format.js';
import { createCheckpointFile, loadCheckpointFile, writeCheckpointFile } from './checkpoint.js';
import { parseSessionBytes } from './record.js';

export interface BranchResult {
  sessionId: string;
  parentSessionId: string;
  // 分支复制的末尾事件序号；父会话后续事件不会进入分支。
  at: number;
  events: number;
}

function unavailable(detail: string): KernelError {
  return new KernelError('session_branch_point_unavailable', { detail });
}

// 原样复制事件行，包括可忽略的未知事件和未识别字段，并保持序号连续。
// 新分支使用自己的首行元数据；没有首行的旧记录仍保留全部事件。
function prefixLines(text: string, boundary: number): string[] {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const event = JSON.parse(line) as { kind?: unknown; seq?: unknown };
    if (event.kind === 'session') continue;
    if (typeof event.seq === 'number' && event.seq > boundary) break;
    kept.push(line);
  }
  return kept;
}

function modeInForce(kept: string[], fallback: SessionModeIdentity | undefined): SessionModeIdentity | undefined {
  let mode = fallback;
  for (const line of kept) {
    const event = JSON.parse(line) as { kind?: string; name?: unknown; layer?: unknown };
    if (event.kind === 'mode' && typeof event.name === 'string') {
      mode = { name: event.name, layer: String(event.layer ?? '') };
    }
  }
  return mode;
}

export async function branchSession(
  directory: string,
  parentSessionId: string,
  { at, projectRoot }: { at?: number; projectRoot?: string },
): Promise<BranchResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, `${parentSessionId}.jsonl`));
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') throw new KernelError('session_not_found', { detail: parentSessionId });
    throw cause;
  }
  const record = parseSessionBytes(bytes);
  const text = bytes.subarray(0, record.completeBytes).toString('utf8');
  const last = record.events.at(-1);
  const boundary = at ?? (last?.seq ?? -1);
  if (at !== undefined) {
    // 只有正常结束轮次对应的标记可作为分支点；取消、失败和达到上限的轮次没有标记。
    // 旧记录无法证明轮次边界时返回错误，不猜测分支位置。
    const marker = record.events.find((event) => event.kind === 'turn' && event.seq === at && event.status === 'completed');
    if (marker === undefined) {
      throw unavailable(`${parentSessionId} has no completed turn at event ${at}; copying the whole record takes no \`at\``);
    }
  }
  const kept = prefixLines(text, boundary);
  const id = randomUUID();
  const header = createSessionHeader({
    id,
    projectRoot,
    // 分支继承父记录中的工作区身份和来源。
    // 父记录未保存这些信息时，分支也保持未指定，不用当前目录或默认值补猜。
    workspace: record.header?.workspace ?? (projectRoot === undefined || projectRoot === '' ? undefined : workspaceIdentity(projectRoot)),
    workspaceOrigin: record.header?.workspaceOrigin,
    createdAt: new Date().toISOString(),
    mode: modeInForce(kept, record.header?.mode),
  });
  // 将父会话 ID 和分支位置写入新会话的元数据，不发送给模型。
  const written = [JSON.stringify({ ...header, branchOf: parentSessionId, branchAt: boundary }), ...kept];
  const path = join(directory, `${id}.jsonl`);
  // 先写入临时文件再重命名，避免未完成的分支出现在 `.jsonl` 列表中。
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, `${written.join('\n')}\n`, 'utf8');
    await rename(temporary, path);
  } catch (cause) {
    throw new KernelError('session_branch_failed', { cause, detail: `${parentSessionId} at ${boundary}: ${(cause as Error).message}` });
  }
  // 分支携带完全落在复制前缀内的压缩块；块的摘要按父记录事件校验，通过后改写为分支身份。
  // 校验失败或块跨越分支点时不携带，分支从全量事件投影，下一次压缩会重建摘要。
  const { blocks } = await loadCheckpointFile({ directory, id: parentSessionId, events: record.events });
  const carried = blocks.filter((block) => block.toSeq <= boundary);
  if (carried.length > 0) {
    try {
      await writeCheckpointFile(directory, id, createCheckpointFile({ id, blocks: carried }));
    } catch {
      // 记录已写入并可见；块文件是可重建的派生数据，携带失败不使分支失败，
      // 否则调用方重试会不断产生没有块文件的孤立分支。
    }
  }
  return { sessionId: id, parentSessionId, at: boundary, events: kept.length };
}
