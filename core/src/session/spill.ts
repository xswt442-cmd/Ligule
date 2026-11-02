import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelRuntimeError } from '../errors.js';

export const SPILL_NAME = /^result-\d+-[a-f0-9]{8}\.json$/;

export interface SpillOptions {
  readonly limit: number;
  readonly directory: string;
  readonly name: string;
  readonly readWithCompact?: boolean;
}

// 超限结果完整保存到 Session 目录，返回值保留首尾内容、说明和读取引用。
// 总字节数包含标记；先计算标记长度，再分配首尾内容预算。
export async function spillContent(text: string, { limit, directory, name, readWithCompact = false }: SpillOptions): Promise<string> {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return text;
  const baseNote = `\n[omitted: full output is ${bytes.length} bytes, kept in ${name}]\n`;
  const hint = `[read via compact: action=spill, name=${name}]\n`;
  const note = readWithCompact && Buffer.byteLength(baseNote + hint, 'utf8') <= limit ? baseNote + hint : baseNote;
  const budget = Math.max(0, limit - Buffer.byteLength(note, 'utf8'));
  const half = Math.floor(budget / 2);
  // 新会话可能尚无记录目录，写入前先创建目录。
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), text, 'utf8');
  } catch (error) {
    // 完整结果未能保存时无法返回有效引用；将错误作为运行时故障抛出，不返回丢失内容的截断结果。
    throw new KernelRuntimeError('session_spill_failed', { cause: error });
  }
  // 字节截断可能切开多字节字符；Node 会用替换字符表示残缺序列，并增加输出字节数。
  // 因此移除首尾不完整字符，确保最终结果仍不超过上限。
  return `${bytes.subarray(0, half).toString('utf8').replace(/\uFFFD+$/, '')}${note}${bytes.subarray(bytes.length - half).toString('utf8').replace(/^\uFFFD+/, '')}`;
}
