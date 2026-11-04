// 未配置上下文窗口也保存端点实际报回的用量；窗口只控制压缩策略。
import { isImageReference } from './media.js';
export interface ModelRequest {
  readonly system?: string;
  readonly tools?: unknown;
  readonly messages: unknown[];
}

export interface ProviderCacheUsage {
  readonly source: 'chat-completions' | 'anthropic-messages';
  // Exact response field paths and values prevent an OpenAI-compatible endpoint from being mislabeled as DeepSeek.
  readonly sourceFields: readonly { readonly field: string; readonly tokens: number | null }[];
  readonly hitInputTokens: number | null;
  readonly missInputTokens: number | null;
  readonly creationInputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  // Describes the provider's raw input field; normalized event.input may already sum cache components.
  readonly providerInputIncludesCache: boolean;
  readonly consistent: boolean | null;
}

export interface ProviderUsageEvent {
  readonly type: 'usage';
  readonly input: number | null;
  readonly output: number | null;
  readonly cache?: ProviderCacheUsage;
}

// 按字节数除以四得到粗略 Token 估算；具体偏差由服务端用量持续校准。
export function estimateTokens(value: unknown): number {
  function imageCount(item: unknown): number {
    if (isImageReference(item)) return 1;
    if (Array.isArray(item)) return item.reduce((sum, child) => sum + imageCount(child), 0);
    if (typeof item === 'object' && item !== null) return Object.values(item).reduce<number>((sum, child) => sum + imageCount(child), 0);
    return 0;
  }
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8') / 4) + imageCount(value) * 4096;
}

export function estimateRequest(request: ModelRequest): number {
  return estimateTokens({ system: request.system ?? '', tools: request.tools ?? [], messages: request.messages });
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cacheUsage(value: unknown): ProviderCacheUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.source !== 'chat-completions' && item.source !== 'anthropic-messages') return undefined;
  if (!Array.isArray(item.sourceFields) || item.sourceFields.length > 8 || !item.sourceFields.every((field) =>
    typeof field === 'object' && field !== null && !Array.isArray(field)
    && typeof (field as Record<string, unknown>).field === 'string'
    && ((field as Record<string, unknown>).tokens === null || tokenCount((field as Record<string, unknown>).tokens) !== null))
    || typeof item.providerInputIncludesCache !== 'boolean'
    || (item.consistent !== null && typeof item.consistent !== 'boolean')) return undefined;
  const count = (field: unknown) => field === null ? null : tokenCount(field);
  const hitInputTokens = count(item.hitInputTokens);
  const missInputTokens = count(item.missInputTokens);
  const creationInputTokens = count(item.creationInputTokens);
  const uncachedInputTokens = count(item.uncachedInputTokens);
  if ([item.hitInputTokens, item.missInputTokens, item.creationInputTokens, item.uncachedInputTokens]
    .some((field, index) => field !== null && [hitInputTokens, missInputTokens, creationInputTokens, uncachedInputTokens][index] === null)) {
    return undefined;
  }
  return { source: item.source, sourceFields: item.sourceFields as ProviderCacheUsage['sourceFields'],
    hitInputTokens, missInputTokens, creationInputTokens, uncachedInputTokens,
    providerInputIncludesCache: item.providerInputIncludesCache, consistent: item.consistent as boolean | null };
}

// 用量事件按用途分开记账：主 Agent 的模型调用与可选复审（Reviewer）不能混在一起统计。
export type UsagePurpose = 'agent' | 'reviewer';

export function usageEvent(request: ModelRequest, events: unknown[], purpose: UsagePurpose = 'agent'): {
  kind: 'usage'; ignorable: true; purpose: UsagePurpose; input: number | null; output: number | null;
  estimated: number; measurement: 'request-v1'; cache?: ProviderCacheUsage;
} | null {
  const raw = [...events].reverse().find((event) => typeof event === 'object' && event !== null
    && !Array.isArray(event) && (event as { type?: unknown }).type === 'usage');
  if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const usage = raw as { input?: unknown; output?: unknown; cache?: unknown };
  const input = tokenCount(usage.input);
  const output = tokenCount(usage.output);
  const cache = cacheUsage(usage.cache);
  // Keep null as unknown; Number(null) would turn a missing provider total into a measured zero.
  if (input === null && output === null && cache === undefined) return null;
  return {
    kind: 'usage',
    ignorable: true,
    purpose,
    input,
    output,
    estimated: estimateRequest(request),
    measurement: 'request-v1',
    ...(cache === undefined ? {} : { cache }),
  };
}
