// 工具结果分别记录内容、失败状态、错误码和拒绝原因；调用方根据类别和错误码处理。
// 工具执行失败与权限拒绝是不同结果，必须分开保存和统计。
import { checkedImageReferences, isImageToolResult, type ImageReference } from '../media.js';
export { spillContent, SPILL_NAME, type SpillOptions } from '../session/spill.js';

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
