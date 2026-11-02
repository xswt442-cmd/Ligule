// 从会话记录汇总权限判定，不在 Kernel 中另存计数器。
// 结果区分自动允许、用户审批和拒绝，并包含命中规则及拒绝码。
import type { SessionEvent } from './format.js';

export interface VerdictCounts {
  capability: string;
  auto: number;
  asked: number;
  allowed: number;
  denied: number;
  codes: Record<string, number>;
  rules: Record<string, number>;
  levels: Record<string, number>;
}

interface RecordedVerdict {
  decision?: unknown;
  via?: unknown;
  capability?: unknown;
  level?: unknown;
  forced?: unknown;
  rule?: unknown;
  answer?: unknown;
}

// 因连续拒绝触发的强制审批单独标记为 `ask(forced)`，区别于配置策略的一般审批。
function levelOf(verdict: RecordedVerdict): string {
  const level = typeof verdict.level === 'string' ? verdict.level : 'unknown';
  // 连续拒绝只会把 auto 收紧到 ask；none/never 本身不审批，ask 也没有被改变。
  const tightened = verdict.via === 'ask' && level !== 'none' && level !== 'never' && level !== 'ask' && level !== 'unknown';
  return verdict.forced === true && tightened ? `${level}→ask` : level;
}

function bump(table: Record<string, number>, key: string): void {
  table[key] = (table[key] ?? 0) + 1;
}

export function summarizeVerdicts(events: SessionEvent[]): VerdictCounts[] {
  const byCapability = new Map<string, VerdictCounts>();
  for (const event of events) {
    if (event.kind !== 'tool') continue;
    const verdict = event.verdict as RecordedVerdict | undefined;
    // 未经过权限判定的调用不参与统计。
    if (typeof verdict?.decision !== 'string') continue;
    const capability = typeof verdict.capability === 'string' && verdict.capability !== ''
      ? verdict.capability
      : String(event.tool ?? '');
    const item = byCapability.get(capability)
      ?? { capability, auto: 0, asked: 0, allowed: 0, denied: 0, codes: {}, rules: {}, levels: {} };
    byCapability.set(capability, item);
    bump(item.levels, levelOf(verdict));
    // 同时统计放行和拒绝规则的命中次数，用于评估规则效果。
    if (typeof verdict.rule === 'string' && verdict.rule !== '') bump(item.rules, verdict.rule);
    if (verdict.decision === 'deny') {
      item.denied += 1;
      const code = (event.result as { code?: string } | undefined)?.code ?? 'unknown';
      bump(item.codes, code);
      continue;
    }
    item.allowed += 1;
    if (verdict.via === 'ask') item.asked += 1;
    else item.auto += 1;
  }
  return [...byCapability.values()].sort((left, right) => left.capability.localeCompare(right.capability));
}

// 每个能力名称单独汇总，展示值直接来自结构化统计结果。
export function formatVerdicts(counts: VerdictCounts[]): string[] {
  return counts.map((item) => {
    const rules = Object.entries(item.rules).map(([rule, count]) => `"${rule}"×${count}`).join(' ');
    const codes = Object.entries(item.codes).map(([code, count]) => `${code}×${count}`).join(' ');
    const levels = Object.entries(item.levels).map(([level, count]) => `${level}×${count}`).join(' ');
    return `${item.capability}  自动 ${item.auto}  问过 ${item.asked}  没让做 ${item.denied}`
      + `  档位 ${levels}`
      + (rules === '' ? '' : `  命中规则 ${rules}`)
      + (codes === '' ? '' : `  码 ${codes}`);
  });
}
