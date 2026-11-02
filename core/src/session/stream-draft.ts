import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError, KernelRuntimeError } from '../errors.js';
import type { SessionEvent } from './format.js';

const CHANNEL_CHARACTERS = 8192;
const FILE_BYTES = 128 * 1024;
const FLUSH_BYTES = 16 * 1024;
const FLUSH_MS = 250;

export interface ProvisionalOutput {
  readonly provisional: true;
  readonly responseId: string;
  readonly userSeq: number | null;
  readonly updatedAt: string;
  readonly text: string;
  readonly reasoning: string;
  readonly textCharacters: number;
  readonly reasoningCharacters: number;
  readonly truncated: boolean;
}

export interface StreamDraftWriter {
  readonly responseId: string;
  readonly failure: KernelRuntimeError | undefined;
  append(event: { readonly type: 'text' | 'reasoning'; readonly text: string }): Promise<void>;
  flush(): Promise<void>;
  discard(): Promise<KernelRuntimeError | undefined>;
}

function tail(text: string): string {
  let kept = text.slice(-CHANNEL_CHARACTERS);
  const first = kept.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) kept = kept.slice(1);
  return kept;
}

export function createStreamDraft(directory: string, sessionId: string, userSeq: number | undefined, onFailure: (error: KernelRuntimeError) => void): StreamDraftWriter {
  const responseId = randomUUID();
  const path = join(directory, `${sessionId}.stream.json`);
  let text = '';
  let reasoning = '';
  let textCharacters = 0;
  let reasoningCharacters = 0;
  let bytes = 0;
  let dirty = false;
  let written = false;
  let failure: KernelRuntimeError | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();

  function stopTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function flush(): Promise<void> {
    stopTimer();
    if (failure !== undefined) return Promise.reject(failure);
    if (!dirty) return pending;
    dirty = false;
    bytes = 0;
    const snapshot = JSON.stringify({
      formatVersion: 1, sessionId, provisional: true, responseId, userSeq: userSeq ?? null,
      updatedAt: new Date().toISOString(), text, reasoning, textCharacters, reasoningCharacters,
      truncated: textCharacters > text.length || reasoningCharacters > reasoning.length,
    });
    pending = pending.then(async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, snapshot, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, path);
        written = true;
      } catch (cause) {
        try { await rm(temporary, { force: true }); }
        catch (cleanup) { cause = new AggregateError([cause, cleanup], 'stream snapshot write and cleanup failed'); }
        failure = new KernelRuntimeError('session_stream_write_failed', { cause });
        onFailure(failure);
        throw failure;
      }
    });
    return pending;
  }

  return {
    responseId,
    get failure() { return failure; },
    async append(event) {
      await pending;
      if (event.type === 'text') { textCharacters += event.text.length; text = tail(text + event.text); }
      else { reasoningCharacters += event.text.length; reasoning = tail(reasoning + event.text); }
      bytes += Buffer.byteLength(event.text, 'utf8');
      dirty = true;
      if (!written || bytes >= FLUSH_BYTES) await flush();
      else if (timer === undefined) {
        timer = setTimeout(() => {
          // flush 将失败送入运行中的取消通道；此处只处理计时回调的 Promise 拒绝。
          void flush().catch(() => undefined);
        }, FLUSH_MS);
        timer.unref();
      }
    },
    flush,
    async discard() {
      stopTimer();
      dirty = false;
      // 写入错误已由 failure 与 onFailure 报告，清理仍须等待进行中的写入结束。
      await pending.catch(() => undefined);
      if (!written) return undefined;
      try { await rm(path, { force: true }); }
      catch (cause) { return new KernelRuntimeError('session_stream_cleanup_failed', { cause }); }
      return undefined;
    },
  };
}

export async function readStreamDraft(directory: string, sessionId: string, events: readonly SessionEvent[]): Promise<ProvisionalOutput | null> {
  const path = join(directory, `${sessionId}.stream.json`);
  let value: unknown;
  try {
    if ((await stat(path)).size > FILE_BYTES) throw new Error('stream snapshot exceeds its byte limit');
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new KernelError('session_stream_invalid', { cause });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('session_stream_invalid');
  const item = value as Record<string, unknown>;
  if (item.formatVersion !== 1 || item.sessionId !== sessionId || item.provisional !== true
    || typeof item.responseId !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.responseId)
    || (item.userSeq !== null && (!Number.isSafeInteger(item.userSeq) || Number(item.userSeq) < 0))
    || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))
    || typeof item.text !== 'string' || item.text.length > CHANNEL_CHARACTERS
    || typeof item.reasoning !== 'string' || item.reasoning.length > CHANNEL_CHARACTERS
    || !Number.isSafeInteger(item.textCharacters) || Number(item.textCharacters) < item.text.length
    || !Number.isSafeInteger(item.reasoningCharacters) || Number(item.reasoningCharacters) < item.reasoning.length
    || typeof item.truncated !== 'boolean') throw new KernelError('session_stream_invalid');
  if (events.some(event => event.kind === 'assistant' && event.responseId === item.responseId)) return null;
  return {
    provisional: true, responseId: item.responseId, userSeq: item.userSeq as number | null,
    updatedAt: item.updatedAt, text: item.text, reasoning: item.reasoning,
    textCharacters: Number(item.textCharacters), reasoningCharacters: Number(item.reasoningCharacters),
    truncated: item.truncated,
  };
}
