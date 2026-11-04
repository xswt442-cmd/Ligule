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
      const item: EvidenceItem = { seq, source: 'user', text };
      constraints.push(item);
      task = item;
      continue;
    }
    if (kind === 'sessionPermission') {
      const profile = event.profile;
      const network = event.network;
      // 权限降档就是一次可机器判定的“撤销”：早期允许联网的约束在这里被收紧。
      const narrowed = previousPermission !== undefined
        && ((previousPermission.network === 'unrestricted' && network !== 'unrestricted')
          || (previousPermission.profile === 'full-access' && profile !== 'full-access'));
      if (narrowed) {
        revoked.push({ seq, source: 'permission', text: `permission narrowed to profile=${String(profile)} network=${String(network)}` });
      }
      previousPermission = { profile, network };
      continue;
    }
    if (kind === 'sessionPolicyRule') {
      if (event.decision === 'deny') {
        revoked.push({
          seq,
          source: 'policy',
          text: `rule ${String(event.tool)}${typeof event.match === 'string' ? ` match=${event.match}` : ''} denies`,
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
