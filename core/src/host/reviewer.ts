import type { ModelProvider } from '../kernel/loop.js';
import {
  buildReviewInput, parseReviewReply, type ReviewFacts,
} from '../kernel/reviewer.js';
import type { PolicyReview, PolicyReviewOutcome, PolicyReviewRecord, PolicyReviewRequest } from '../kernel/policy.js';
import { usageEvent } from '../session/usage.js';

/**
 * Host 侧复审（Reviewer）执行器：预算和计数由它持有，模型路由则由调用方按当前 Run 的
 * Session generation 提供。任何失败都返回 `ask-human`，由既有审批通道接手——绝不因为
 * 复审不可用而放行。
 */
export interface ReviewerSettings {
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
  /** 每次 `loop.run` 开始前调用：`maxPerRun` 限制的是一轮之内的复审次数，不是整个会话。 */
  readonly beginRun: () => void;
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
  // 只认布尔真值：项目配置里的 `enabled = "true"` 不会悄悄打开付费请求。
  if (!isRecord(table) || table.enabled !== true) return undefined;
  return {
    maxInputTokens: positive(table.maxInputTokens, DEFAULTS.maxInputTokens),
    maxOutputTokens: positive(table.maxOutputTokens, DEFAULTS.maxOutputTokens),
    timeoutMs: positive(table.timeoutMs, DEFAULTS.timeoutMs),
    maxPerRun: positive(table.maxPerRun, DEFAULTS.maxPerRun),
    maxTotalTokens: positive(table.maxTotalTokens, DEFAULTS.maxTotalTokens),
  };
}

/** 已移除的复审路由字段：复审永远跟随当前 Session 的模型，不再单独选择端点或凭据。 */export const REVIEWER_ROUTE_FIELDS = ['model', 'baseURL', 'api', 'apiKeyEnv'] as const;

/**
 * 列出配置里残留的路由字段。它们不再生效，Host 必须明确拒绝而不是静默忽略：
 * 一个项目配置里的 `baseURL` 不能看起来像“已经生效”。
 */
export function reviewerRouteFields(config: Record<string, unknown>): readonly string[] {
  const table = config.reviewer;
  if (!isRecord(table)) return [];
  return REVIEWER_ROUTE_FIELDS.filter((field) => table[field] !== undefined);
}

/**
 * 合并层与可信层的预算取较小值：项目配置只能收紧复审预算，不能把上限调大，
 * 也不能靠 `enabled` 自行打开付费请求（启用判定在 Host 侧只认可信层）。
 */
export function narrowReviewerSettings(merged: ReviewerSettings, trusted: ReviewerSettings): ReviewerSettings {
  return {
    maxInputTokens: Math.min(merged.maxInputTokens, trusted.maxInputTokens),
    maxOutputTokens: Math.min(merged.maxOutputTokens, trusted.maxOutputTokens),
    timeoutMs: Math.min(merged.timeoutMs, trusted.timeoutMs),
    maxPerRun: Math.min(merged.maxPerRun, trusted.maxPerRun),
    maxTotalTokens: Math.min(merged.maxTotalTokens, trusted.maxTotalTokens),
  };
}

export interface ReviewerDeps {
  readonly settings: ReviewerSettings;
  /**
   * 取当前 Run 的 Session 模型路由。用取值函数而不是实例：模型切换只在 Host 既有轮次
   * 边界生效，复审不能拿一个创建会话时的旧 Provider 继续跑。
   */
  readonly provider: () => ModelProvider;
  /** 由 Host 装配可信事实；Kernel 只传当前动作。 */
  readonly factsOf: (request: PolicyReviewRequest) => ReviewFacts;
  readonly logger?: (message: string, detail?: Record<string, unknown>) => void;
  /** 每次复审拿到端点用量后回调一次，Host 用它写 `purpose: 'reviewer'` 的 usage 事件。 */
  readonly onUsage?: (event: ReturnType<typeof usageEvent>) => void;
}

function reportUsage(
  events: readonly unknown[],
  system: string,
  user: string,
  onUsage: ReviewerDeps['onUsage'],
): void {
  if (onUsage === undefined) return;
  // 端点完全不报用量时也要留下这次请求：否则 `/usage` 会显示“复审一次都没调过”。
  const event = usageEvent({ system, tools: [], messages: [{ role: 'user', text: user }] }, [...events], 'reviewer', {
    unknownWhenUnreported: true,
  });
  if (event !== null) onUsage(event);
}

export function createSessionReviewer({ settings, provider, factsOf, logger, onUsage }: ReviewerDeps): SessionReviewer {
  let calls = 0;
  // 轮次内的调用次数由 beginRun 归零；`calls` 保留为整个会话的累计值，只用于用量展示。
  let runCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // 已经发出、尚未结算的请求所预留的输入估算与最大输出。并发复审靠它互斥，避免两个请求同时通过准入。
  let reservedTokens = 0;
  let unknownInput = false;
  let unknownOutput = false;
  let failures = 0;
  let lastCode: string | undefined;

  const askHuman = (reasonCode: string, reason: string): PolicyReviewOutcome => {
    lastCode = reasonCode;
    return { decision: 'ask-human', reasonCode, reason };
  };

  const review: PolicyReview = async (request: PolicyReviewRequest): Promise<PolicyReviewOutcome> => {
    if (runCalls >= settings.maxPerRun) return askHuman('review_budget_exhausted', 'Review 次数已达本次运行上限，转人工审批。');
    const built = buildReviewInput(factsOf(request), { maxInputTokens: settings.maxInputTokens });
    if (!built.ok) {
      failures += 1;
      return askHuman(built.code, built.detail ?? '复审输入不满足要求，转人工审批。');
    }
    // 路由在发请求之前取：这一轮复审与它审批的那次调用用同一个 Session 模型。
    // 取不到路由说明请求根本没发出去，因此不能占用预算额度，也不能启动超时计时器。
    let active: ModelProvider;
    try {
      active = provider();
    } catch (error) {
      failures += 1;
      logger?.('reviewer route unavailable', { reason: String(error) });
      return askHuman('review_unavailable', '复审没有可用的 Session 模型路由，转人工审批。');
    }
    // 预算按“已花掉的输入与输出 + 本次输入 + 本次回复的预留额度”判断；
    // 只算输入会让输出悄悄超出上限。
    const reservation = built.input.estimatedInputTokens + settings.maxOutputTokens;
    const spent = inputTokens + outputTokens;
    if (spent + reservedTokens + reservation > settings.maxTotalTokens) {
      return askHuman('review_budget_exhausted', 'Review 累计用量已超预算，转人工审批。');
    }
    // 先占位再发请求：只算已结算的用量，两个并发的复审会同时看到“还有额度”而一起超支。
    reservedTokens += reservation;
    calls += 1;
    runCalls += 1;
    // 预算只记一份：先用估算做准入检查，之后收到端点的真实输入量就替换它，绝不重复累加。
    let providerInputSeen = false;
    let providerOutputSeen = false;
    let budgetSettled = false;
    const settleBudget = (): void => {
      if (budgetSettled) return;
      budgetSettled = true;
      // 无论成功失败都要归还预留额度，否则一次失败会把预算永久吃掉。
      reservedTokens -= reservation;
      // 端点始终没报输入时退回估算，否则累计预算是空的、上限形同虚设。
      if (!providerInputSeen) inputTokens += built.input.estimatedInputTokens;
      // 输出同理：端点没报就按预留上限保守计费，未知输出不能把额度白还回去。
      if (!providerOutputSeen) {
        outputTokens += settings.maxOutputTokens;
        unknownOutput = true;
      }
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    timer.unref?.();
    let text = '';
    let reasoned = false;
    let toolCall: string | undefined;
    // 只有明确收到 finish.reason === 'stop' 才算完整说完。截断、触顶、工具调用中止或流直接结束
    // 都意味着回复后半段可能缺失，绝不能把这样的文本当成裁决使用。
    let finishReason: string | undefined;
    let finished = false;
    // 端点用量要按用途记账：先收集本次复审的全部流事件，结束后写成 purpose=reviewer 的用量事件。
    const collected: unknown[] = [];
    try {
      for await (const event of active.stream({
        system: built.input.system,
        tools: [],
        messages: [{ role: 'user', text: built.input.user }],
      }, { signal: controller.signal })) {
        collected.push(event);
        if (event.type === 'text') text += event.text;
        if (event.type === 'reasoning') reasoned = true;
        if (event.type === 'usage') {
          if (typeof event.input === 'number') { inputTokens += event.input; providerInputSeen = true; } else unknownInput = true;
          if (typeof event.output === 'number') { outputTokens += event.output; providerOutputSeen = true; } else unknownOutput = true;
        }
        if (event.type === 'tool-call') {
          // 复审绝不能自己调用工具；出现工具调用说明装配或模型越界，先记账再转人工。
          toolCall = event.name;
          break;
        }
        if (event.type === 'finish') {
          finishReason = event.reason;
          finished = true;
          break;
        }
      }
    } catch (error) {
      failures += 1;
      const aborted = controller.signal.aborted;
      logger?.('reviewer request failed', { code: aborted ? 'review_timeout' : 'review_failed' });
      settleBudget();
      reportUsage(collected, built.input.system, built.input.user, onUsage);
      return askHuman(aborted ? 'review_timeout' : 'review_failed', aborted
        ? `复审在 ${settings.timeoutMs} 毫秒内没有返回结果，转人工审批。`
        : '复审请求失败，转人工审批。');
    } finally {
      clearTimeout(timer);
    }
    settleBudget();
    reportUsage(collected, built.input.system, built.input.user, onUsage);
    if (toolCall !== undefined) {
      failures += 1;
      logger?.('reviewer tried to call a tool', { tool: toolCall });
      return askHuman('review_reply_invalid', '复审返回了工具调用，转人工审批。');
    }
    // 用量已经记完再判完整性：被截断的回复也要留下这一次真实消耗。
    if (!finished) {
      failures += 1;
      logger?.('reviewer reply had no finish event');
      return askHuman('review_incomplete', '复审回复没有正常结束（缺少结束事件），转人工审批。');
    }
    if (finishReason !== 'stop') {
      failures += 1;
      const truncated = finishReason === 'length' || finishReason === 'max_tokens';
      logger?.('reviewer reply ended early', { reason: finishReason });
      return askHuman(truncated ? 'review_reply_truncated' : 'review_reply_invalid', truncated
        ? `复审回复被截断（结束原因 ${finishReason}），转人工审批。`
        : `复审回复没有正常完成（结束原因 ${finishReason}），转人工审批。`);
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
      includedSeqs: built.includedSeqs,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    };
    logger?.('reviewer decided', { decision: record.decision, reasonCode: record.reasonCode, fingerprint: record.fingerprint });
    return record;
  };

  return {
    review,
    beginRun: () => { runCalls = 0; },
    usage: () => ({
      calls,
      inputTokens: unknownInput ? null : inputTokens,
      outputTokens: unknownOutput ? null : outputTokens,
      failures,
      ...(lastCode === undefined ? {} : { lastCode }),
    }),
  };
}
