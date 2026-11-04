// 只读用量聚合：把会话里的 `usage` 事件按用途（主 Agent / 复审）求和。
// 约定：`input` 是端点报回的输入总量，可能已含缓存命中；`cachedInput` 是其中的缓存部分，
// 两者不能相加。任何一路缺失都记成“未知”，绝不把缺失当成 0。
import type { UsagePurpose } from './usage.js';

export interface UsageBucket {
  /** 记录到的模型请求次数。 */
  requests: number;
  /** 端点报回的输入 Token 总数（可能包含缓存命中部分）。 */
  input: number;
  /** 端点报回的输出 Token 总数。 */
  output: number;
  /** 输入里由缓存提供的部分，是 `input` 的子集。 */
  cachedInput: number;
  /** `input - cachedInput`；缓存或输入有任何未知时为 null。 */
  uncachedInput: number | null;
  /** 本地估算的输入总量，用于校准与对照。 */
  estimatedInput: number;
  /** 缺少输入计数的请求数（未知不等于 0）。 */
  unknownInputRequests: number;
  /** 缺少输出计数的请求数。 */
  unknownOutputRequests: number;
}

export interface UsageSummary {
  readonly agent: UsageBucket;
  readonly reviewer: UsageBucket;
}

interface Counter {
  requests: number;
  input: number;
  output: number;
  cachedInput: number;
  estimatedInput: number;
  unknownInputRequests: number;
  unknownOutputRequests: number;
  /** 报回了输入、也报回了缓存字段的请求数；与 inputRequests 不等就无法确定未缓存部分。 */
  cacheKnownRequests: number;
  inputRequests: number;
}

function emptyCounter(): Counter {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cachedInput: 0,
    estimatedInput: 0,
    unknownInputRequests: 0,
    unknownOutputRequests: 0,
    cacheKnownRequests: 0,
    inputRequests: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function purposeOf(value: unknown): UsagePurpose {
  return value === 'reviewer' ? 'reviewer' : 'agent';
}

function add(counter: Counter, event: Record<string, unknown>): void {
  counter.requests += 1;
  const input = count(event.input);
  const output = count(event.output);
  const estimated = count(event.estimated);
  if (estimated !== null) counter.estimatedInput += estimated;
  if (input === null) counter.unknownInputRequests += 1;
  else {
    counter.input += input;
    counter.inputRequests += 1;
  }
  if (output === null) counter.unknownOutputRequests += 1;
  else counter.output += output;
  const cache = isRecord(event.cache) ? event.cache : undefined;
  const hit = cache === undefined ? null : count(cache.hitInputTokens);
  if (cache !== undefined && hit !== null) {
    counter.cachedInput += hit;
    if (input !== null) counter.cacheKnownRequests += 1;
  }
}

function bucketOf(counter: Counter): UsageBucket {
  // 只有“每个有输入的请求都报了缓存”时才能确定未缓存部分；否则宁可报未知。
  const cacheComplete = counter.inputRequests > 0
    && counter.inputRequests === counter.cacheKnownRequests
    && counter.unknownInputRequests === 0;
  return {
    requests: counter.requests,
    input: counter.input,
    output: counter.output,
    cachedInput: counter.cachedInput,
    uncachedInput: cacheComplete ? Math.max(counter.input - counter.cachedInput, 0) : null,
    estimatedInput: counter.estimatedInput,
    unknownInputRequests: counter.unknownInputRequests,
    unknownOutputRequests: counter.unknownOutputRequests,
  };
}

export function summarizeUsage(events: readonly unknown[]): UsageSummary {
  const agent = emptyCounter();
  const reviewer = emptyCounter();
  for (const event of events) {
    if (!isRecord(event) || event.kind !== 'usage') continue;
    add(purposeOf(event.purpose) === 'reviewer' ? reviewer : agent, event);
  }
  return { agent: bucketOf(agent), reviewer: bucketOf(reviewer) };
}
