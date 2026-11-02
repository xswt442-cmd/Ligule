// 工具结果分别记录内容、失败状态、错误码和拒绝原因；调用方根据类别和错误码处理。
// 工具执行失败与权限拒绝是不同结果，必须分开保存和统计。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelRuntimeError } from './error.js';
import { checkedImageReferences, isImageToolResult, type ImageReference } from '../media.js';

type EmptyExtra = Record<never, never>;
type ToolResultShape<Kind extends string, Failed extends boolean, Extra extends object> = {
  readonly kind: Kind;
  readonly failed: Failed;
  readonly code: string | undefined;
  readonly reason: string | undefined;
  readonly content: unknown;
  readonly images?: readonly ImageReference[];
} & Extra;

export interface ResultLimitConfig {
  readonly limits?: { readonly resultBytes?: number };
}

export interface SpillOptions {
  readonly limit: number;
  readonly directory: string;
  readonly name: string;
  readonly readWithCompact?: boolean;
}

export function resultOf(
  content: unknown,
  extra?: object,
): ToolResultShape<'result', false, EmptyExtra> {
  if (isImageToolResult(content)) {
    if (typeof content.text !== 'string' || Object.keys(content).length !== 3) throw new TypeError('an image tool result needs text and images only');
    return { kind: 'result', failed: false, code: undefined, reason: undefined, content: content.text,
      images: checkedImageReferences(content.images), ...extra };
  }
  return { kind: 'result', failed: false, code: undefined, reason: undefined, content, ...extra };
}

// 拒绝原因放入 `reason` 供用户查看；`content` 提供给模型。
export function refusalOf(code: string, reason: string): ToolResultShape<'refusal', true, EmptyExtra> {
  return { kind: 'refusal', failed: true, code, reason, content: '' };
}

export function failureOf(
  code: string,
  extra?: object,
): ToolResultShape<'failure', true, EmptyExtra> {
  return { kind: 'failure', failed: true, code, reason: undefined, content: '', ...extra };
}

// 工具结果注入模型前的字节上限；配置层可覆盖默认值。
export const DEFAULT_RESULT_BYTES = 16_000;

export function resultLimit(config: ResultLimitConfig): number {
  return config.limits?.resultBytes ?? DEFAULT_RESULT_BYTES;
}

// 超限结果完整保存到文件，返回值保留首尾内容、说明和读取引用。
// 总字节数包含标记；先计算标记长度，再分配首尾内容预算。
// 从记录读取文件名前必须校验，避免构造指向记录目录外的路径。
export const SPILL_NAME = /^result-\d+-[a-f0-9]{8}\.json$/;

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
    // 完整结果未能保存时无法返回有效引用；将错误作为 Kernel 故障抛出，不返回丢失内容的截断结果。
    throw new KernelRuntimeError('session_spill_failed', { cause: error });
  }
  // 字节截断可能切开多字节字符；Node 会用替换字符表示残缺序列，并增加输出字节数。
  // 因此移除首尾不完整字符，确保最终结果仍不超过上限。
  return `${bytes.subarray(0, half).toString('utf8').replace(/\uFFFD+$/, '')}${note}${bytes.subarray(bytes.length - half).toString('utf8').replace(/^\uFFFD+/, '')}`;
}
