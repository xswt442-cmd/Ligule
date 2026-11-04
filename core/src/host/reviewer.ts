import type { ModelProvider } from '../kernel/loop.js';
import {
  buildReviewInput, parseReviewReply, type ReviewFacts,
} from '../kernel/reviewer.js';
import type { PolicyReview, PolicyReviewOutcome, PolicyReviewRecord, PolicyReviewRequest } from '../kernel/policy.js';

/**
 * Host 侧复审（Reviewer）执行器：持有独立模型路由、预算和计数，把 Kernel 的复审请求变成一次
 * 受控的模型调用。任何失败都返回 `ask-human`，由既有审批通道接手——绝不因为复审不可用而放行。
 */
export interface ReviewerSettings {
  readonly model?: string;
  readonly baseURL?: string;
  readonly api?: 'messages' | 'chat-completions';
  readonly apiKeyEnv?: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxPerRun: number;
  readonly maxTotalTokens: number;
}

export interface ReviewerUsage {
  readonly calls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly failures: number;
  readonly lastCode?: string;
}

export interface SessionReviewer {
  readonly review: PolicyReview;
  readonly usage: () => ReviewerUsage;
}

const DEFAULTS = Object.freeze({
  maxInputTokens: 2000,
  maxOutputTokens: 400,
  timeoutMs: 20_000,
  maxPerRun: 8,
  maxTotalTokens: 40_000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 从配置读取复审设置。未写 `[reviewer]` 或 `enabled` 不为真时返回 undefined：
 * 未配置复审的 `auto` 行为必须与 P9.5 完全一致。
 */
export function reviewerSettings(config: Record<string, unknown>): ReviewerSettings | undefined {
  const table = config.reviewer;
  if (!isRecord(table) || table.enabled !== true) return undefined;
  const api = table.api === 'messages' || table.api === 'chat-completions' ? table.api : undefined;
  return {
    ...(typeof table.model === 'string' && table.model !== '' ? { model: table.model } : {}),
    ...(typeof table.baseURL === 'string' && table.baseURL !== '' ? { baseURL: table.baseURL } : {}),
    ...(api === undefined ? {} : { api }),
    ...(typeof table.apiKeyEnv === 'string' && table.apiKeyEnv !== '' ? { apiKeyEnv: table.apiKeyEnv } : {}),
    maxInputTokens: positive(table.maxInputTokens, DEFAULTS.maxInputTokens),
    maxOutputTokens: positive(table.maxOutputTokens, DEFAULTS.maxOutputTokens),
    timeoutMs: positive(table.timeoutMs, DEFAULTS.timeoutMs),
    maxPerRun: positive(table.maxPerRun, DEFAULTS.maxPerRun),
    maxTotalTokens: positive(table.maxTotalTokens, DEFAULTS.maxTotalTokens),
  };
}

export interface ReviewerDeps {
  readonly settings: ReviewerSettings;
  readonly provider: ModelProvider;
  /** 由 Host 装配可信事实；Kernel 只传当前动作。 */
  readonly factsOf: (request: PolicyReviewRequest) => ReviewFacts;
  readonly logger?: (message: string, detail?: Record<string, unknown>) => void;
}

export function createSessionReviewer({ settings, provider, factsOf, logger }: ReviewerDeps): SessionReviewer {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let unknownInput = false;
  let unknownOutput = false;
  let failures = 0;
  let lastCode: string | undefined;

  const askHuman = (reasonCode: string, reason: string): PolicyReviewOutcome => {
    lastCode = reasonCode;
    return { decision: 'ask-human', reasonCode, reason };
  };

  const review: PolicyReview = async (request: PolicyReviewRequest): Promise<PolicyReviewOutcome> => {
    if (calls >= settings.maxPerRun) return askHuman('review_budget_exhausted', 'Review 次数已达本次运行上限，转人工审批。');
    const built = buildReviewInput(factsOf(request), { maxInputTokens: settings.maxInputTokens });
    if (!built.ok) {
      failures += 1;
      return askHuman(built.code, built.detail ?? '复审输入不满足要求，转人工审批。');
    }
    if (inputTokens + built.input.estimatedInputTokens > settings.maxTotalTokens) {
      return askHuman('review_budget_exhausted', 'Review 累计输入已超预算，转人工审批。');
    }
    calls += 1;
    inputTokens += built.input.estimatedInputTokens;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    timer.unref?.();
    let text = '';
    let reasoned = false;
    try {
      for await (const event of provider.stream({
        system: built.input.system,
        tools: [],
        messages: [{ role: 'user', text: built.input.user }],
      }, { signal: controller.signal })) {
        if (event.type === 'text') text += event.text;
        if (event.type === 'reasoning') reasoned = true;
        if (event.type === 'usage') {
          if (typeof event.input === 'number') inputTokens += event.input; else unknownInput = true;
          if (typeof event.output === 'number') outputTokens += event.output; else unknownOutput = true;
        }
        if (event.type === 'tool-call') {
          // 复审绝不能自己调用工具；出现工具调用说明装配或模型越界，直接转人工。
          failures += 1;
          logger?.('reviewer tried to call a tool', { tool: event.name });
          return askHuman('review_reply_invalid', '复审返回了工具调用，转人工审批。');
        }
        if (event.type === 'finish') break;
      }
    } catch (error) {
      failures += 1;
      const aborted = controller.signal.aborted;
      logger?.('reviewer request failed', { code: aborted ? 'review_timeout' : 'review_failed' });
      return askHuman(aborted ? 'review_timeout' : 'review_failed', aborted
        ? `复审在 ${settings.timeoutMs} 毫秒内没有返回结果，转人工审批。`
        : '复审请求失败，转人工审批。');
    } finally {
      clearTimeout(timer);
    }
    if (reasoned) logger?.('reviewer returned reasoning text');
    const parsed = parseReviewReply(text);
    if (!parsed.ok) {
      failures += 1;
      logger?.('reviewer reply was unusable', { code: parsed.code });
      return askHuman(parsed.code, '复审回复不可解析，转人工审批。');
    }
    const record: PolicyReviewRecord = {
      decision: parsed.decision,
      reasonCode: parsed.reasonCode,
      fingerprint: built.input.fingerprint,
      inputVersion: built.input.inputVersion,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    };
    logger?.('reviewer decided', { decision: record.decision, reasonCode: record.reasonCode, fingerprint: record.fingerprint });
    return record;
  };

  return {
    review,
    usage: () => ({
      calls,
      inputTokens: unknownInput ? null : inputTokens,
      outputTokens: unknownOutput ? null : outputTokens,
      failures,
      ...(lastCode === undefined ? {} : { lastCode }),
    }),
  };
}
