import type { SessionLog } from '../session/session.js';
import type { EvidenceItem, EvidenceSource, ReviewEvidence } from '../kernel/reviewer.js';

/**
 * 复审用的可信证据选择。
 *
 * 证据只来自原始 Session 事件和 Host 当前状态：这里不解析自然语言，也不相信摘要或工具输出。
 * 每条证据都带事件 `seq`，复审结论必须能回查到产生它的那一条记录。
 */

export type { EvidenceItem, EvidenceSource, ReviewEvidence };

export interface ReviewEvidenceOptions {
  /** 待决工具名，用于挑相关历史。 */
  readonly tool?: string;
  /** 最多保留几条历史。 */
  readonly historyLimit?: number;
  /** 当前 Grant 是否有效；undefined 表示本次没有 Grant 约束。 */
  readonly grantActive?: boolean;
}

type RawEvent = { readonly seq?: unknown; readonly kind?: unknown };

function textOf(event: Record<string, unknown>): string | undefined {
  const text = event.text;
  return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}

function seqOf(event: RawEvent): number | undefined {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : undefined;
}

function summarizeToolParams(params: unknown): string {
  if (typeof params !== 'object' || params === null) return '';
  const record = params as Record<string, unknown>;
  for (const key of ['command', 'path', 'filePath', 'url', 'pattern', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return `${key}=${value.length > 160 ? `${value.slice(0, 160)}…` : value}`;
  }
  return '';
}

/**
 * 从原始记录里挑出复审需要的证据。读取失败返回 `undefined`：调用方应保留上一份快照，
 * 而不是把“读不出来”当成“没有约束”。
 */
/** 权限等级：数值越大越宽松；只用于判断“这一次是不是收紧”。 */
const PROFILE_LEVEL: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
const NETWORK_LEVEL: Record<string, number> = { disabled: 0, policy: 1, unrestricted: 2 };

/**
 * 证据读不到时的固定结论。授权的安全性依赖“证据仍然是当前的”，
 * 所以这里只允许转人工：绝不复用上一轮缓存的约束去做自动放行。
 */
export const REVIEW_EVIDENCE_UNAVAILABLE_REASON = 'the session log could not be read, so the review evidence is stale';

export type StaleReviewOutcome = {
  readonly decision: 'ask-human';
  readonly reasonCode: 'review_evidence_unavailable';
  readonly reason: string;
};

export function staleReviewOutcome(): StaleReviewOutcome {
  return { decision: 'ask-human', reasonCode: 'review_evidence_unavailable', reason: REVIEW_EVIDENCE_UNAVAILABLE_REASON };
}

export async function selectReviewEvidence(
  session: SessionLog,
  options: ReviewEvidenceOptions = {},
): Promise<ReviewEvidence | undefined> {
  let events: readonly Record<string, unknown>[];
  try {
    // 直接读原始日志：不消费 compaction 摘要，摘要坏了也不影响授权判断。
    events = (await session.read()) as unknown as readonly Record<string, unknown>[];
  } catch {
    return undefined;
  }
  const historyLimit = options.historyLimit ?? 3;
  const constraints: EvidenceItem[] = [];
  const revoked: EvidenceItem[] = [];
  const history: EvidenceItem[] = [];
  let task: EvidenceItem | undefined;
  let previousPermission: { profile?: unknown; network?: unknown } | undefined;

  for (const event of events) {
    const seq = seqOf(event);
    if (seq === undefined) continue;
    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'user') {
      const text = textOf(event);
      if (text === undefined) continue;
      // 可信本地 UI 记的 Run 是 human；外控（controller:*）写进来的同一段文字只是请求，
      // 不能和人类禁令并列为授权事实。
      const scope = (event.run as { callerScope?: unknown } | undefined)?.callerScope;
      const fromController = typeof scope === 'string' && scope !== 'human';
      const item: EvidenceItem = { seq, source: fromController ? 'controller' : 'user', text };
      constraints.push(item);
      task = item;
      continue;
    }
    if (kind === 'sessionPermission') {
      const profile = event.profile;
      const network = event.network;
      // 权限降档就是一次可机器判定的“撤销”：按等级比较，workspace-write → read-only 也算收紧。
      const lowered = (rank: Record<string, number>, before: unknown, after: unknown): boolean => {
        const from = typeof before === 'string' ? rank[before] : undefined;
        const to = typeof after === 'string' ? rank[after] : undefined;
        return from !== undefined && to !== undefined && to < from;
      };
      const narrowed = previousPermission !== undefined
        && (lowered(NETWORK_LEVEL, previousPermission.network, network)
          || lowered(PROFILE_LEVEL, previousPermission.profile, profile));
      if (narrowed) {
        revoked.push({ seq, source: 'permission', text: `permission narrowed to profile=${String(profile)} network=${String(network)}` });
      }
      previousPermission = { profile, network };
      continue;
    }
    if (kind === 'sessionPolicyRule') {
      // 记录里规则嵌在 `rule` 对象下（见 session/format.ts 的 sessionPolicyRule 校验）。
      const rule = typeof event.rule === 'object' && event.rule !== null && !Array.isArray(event.rule)
        ? event.rule as Record<string, unknown>
        : undefined;
      if (rule?.decision === 'deny') {
        revoked.push({
          seq,
          source: 'policy',
          text: `rule ${String(rule.tool)}${typeof rule.match === 'string' ? ` match=${rule.match}` : ''} denies`,
        });
      }
      continue;
    }
    if (kind === 'tool') {
      const name = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : '';
      if (options.tool !== undefined && name !== options.tool) continue;
      const decision = typeof event.decision === 'string' ? event.decision : undefined;
      const params = summarizeToolParams(event.params ?? event.args);
      history.push({
        seq,
        source: 'tool',
        text: `${name}${decision === undefined ? '' : ` ${decision}`}${params === '' ? '' : ` ${params}`}`,
      });
      if (history.length > historyLimit) history.shift();
      continue;
    }
  }
  if (options.grantActive === false) {
    const last = events.reduce<number | undefined>((found, event) => seqOf(event) ?? found, undefined);
    revoked.push({ seq: last ?? 0, source: 'grant', text: 'the operator grant is not active' });
  }
  return {
    constraints,
    revoked,
    history,
    ...(task === undefined ? {} : { task }),
  };
}
