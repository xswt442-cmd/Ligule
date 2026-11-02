// 记录的只读入口：完整行参与校验，未完成的尾行只报告长度，不修改文件。
import { readFile } from 'node:fs/promises';
import { KernelRuntimeError } from '../errors.js';
import { parseSessionEvents, type SessionEvent, type SessionRecord } from './format.js';

export interface ReadSessionRecord extends SessionRecord {
  readonly completeBytes: number;
  readonly truncatedBytes: number;
  readonly lastSeq: number;
}

export function parseSessionBytes(bytes: Buffer): ReadSessionRecord {
  const completeBytes = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a
    ? bytes.length
    : bytes.lastIndexOf(0x0a) + 1;
  const objects: SessionEvent[] = [];
  for (const [index, line] of bytes.subarray(0, completeBytes).toString('utf8').split('\n').entries()) {
    if (line === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('a session line must be an object');
      }
      objects.push(value as SessionEvent);
    } catch (cause) {
      throw new KernelRuntimeError('session_line_invalid', { cause, detail: `line ${index + 1}` });
    }
  }
  const record = parseSessionEvents(objects);
  const last = objects.filter((event) => event.kind !== 'session').at(-1);
  return {
    ...record,
    completeBytes,
    truncatedBytes: bytes.length - completeBytes,
    lastSeq: typeof last?.seq === 'number' ? last.seq : -1,
  };
}

export async function readSessionRecord(path: string): Promise<ReadSessionRecord> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return parseSessionBytes(Buffer.alloc(0));
    throw new KernelRuntimeError('session_read_failed', { cause, detail: path });
  }
  return parseSessionBytes(bytes);
}
