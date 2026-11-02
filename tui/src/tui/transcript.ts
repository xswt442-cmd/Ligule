import { textOf as chooseText, type Locale, type SessionEvent } from '@ligule/core/tui.js';
import { providerDiagnosticText, runtimeFailureText } from './errors.js';
import { toolTarget } from './message-format.js';

// SessionEvent 是记录事实源；投影只生成展示行，不改记录，也不把行号当作事件序号。
export type TuiRecord = SessionEvent;

export interface TranscriptItem {
  kind: string;
  text: string;
  source?: 'controller';
  tool?: string;
  // 调用的代表性目标（路径、命令等），让成功结果也能压成一行。
  target?: string;
  code?: string;
  exitCode?: number;
  spilled?: string;
  seq?: number;
}

const MODE_LAYERS: Readonly<Record<string, string>> = { shipped: '随包', user: '全局', project: '项目' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2));

function targetOf(tool: string, args: Record<string, unknown> | undefined): string {
  if (tool === 'mcp.call') {
    const nested = args?.arguments;
    if (typeof nested === 'string') return toolTarget(nested);
    if (isRecord(nested)) return toolTarget(JSON.stringify(nested));
  }
  return toolTarget(JSON.stringify(args ?? {}));
}

interface TuiToolResult {
  readonly content?: unknown;
  readonly reason?: unknown;
  readonly failed?: unknown;
  readonly kind?: unknown;
  readonly code?: unknown;
  readonly spilled?: unknown;
}

export function resultParts(result: TuiToolResult): { text: string; exitCode?: unknown; capability?: unknown } {
  const payload = isRecord(result.content) ? result.content : {};
  return {
    text: typeof payload.text === 'string' ? payload.text : textOf(result.reason ?? result.content),
    exitCode: payload.exitCode,
    capability: payload.effectiveCapability,
  };
}

export function capabilityOf(name: string, args?: Record<string, unknown>): string {
  if (name === 'mcp.call' && typeof args?.server === 'string' && typeof args?.tool === 'string') return `mcp:${args.server}/${args.tool}`;
  return name;
}

export function projectRecord(record: TuiRecord, locale: Locale = 'zh'): TranscriptItem[] {
  const t = (zh: string, en: string) => chooseText(locale, zh, en);
  if (record.kind === 'turn') {
    const names: Readonly<Record<string, readonly [string, string]>> = { completed: ['本轮已完成', 'Turn completed'], cancelled: ['本轮已取消', 'Turn cancelled'], failed: ['本轮失败', 'Turn failed'], interrupted: ['本轮意外中断', 'Turn interrupted'] };
    const label = typeof record.status === 'string' ? names[record.status] : undefined;
    const guidance = typeof record.code === 'string' ? runtimeFailureText(record.code, locale) : undefined;
    const diagnostics = providerDiagnosticText(record.diagnostics, locale);
    return label === undefined ? [] : [{ kind: record.status === 'failed' ? 'error' : 'meta', text: `${chooseText(locale, label[0], label[1])}${typeof record.code === 'string' ? ` (${record.code})` : ''}${guidance === undefined ? '' : `\n${guidance}`}${diagnostics === undefined ? '' : `\n${diagnostics}`}` }];
  }
  if (record.kind === 'user') return [{
    kind: 'question', text: typeof record.raw === 'string' ? record.raw : typeof record.text === 'string' ? record.text : '',
    ...(record.origin === 'controller' ? { source: 'controller' } : {}),
  }];
  if (record.kind === 'reasoning') return [{ kind: 'reasoning', text: typeof record.text === 'string' ? record.text : '' }];
  if (record.kind === 'assistant') {
    const rows: TranscriptItem[] = typeof record.text !== 'string' || record.text === '' ? [] : [{ kind: 'answer', text: record.text }];
    const calls = Array.isArray(record.toolCalls) ? record.toolCalls.filter((call): call is Record<string, unknown> => isRecord(call) && typeof call.name === 'string') : [];
    for (const call of calls) {
      const args = isRecord(call.args) ? call.args : undefined;
      rows.push({ kind: 'call', tool: capabilityOf(String(call.name), args), text: JSON.stringify(call.args ?? {}) });
    }
    return rows;
  }
  if (record.kind === 'tool') {
    const result = isRecord(record.result) ? record.result : {};
    const kind = result.failed !== true ? 'result' : result.kind === 'refusal' ? 'refusal' : 'failure';
    const parts = resultParts(result);
    const row: TranscriptItem = { kind, tool: typeof parts.capability === 'string' ? parts.capability : capabilityOf(typeof record.tool === 'string' ? record.tool : '', isRecord(record.args) ? record.args : undefined), text: parts.text };
    const target = targetOf(typeof record.tool === 'string' ? record.tool : '', isRecord(record.args) ? record.args : undefined);
    if (target !== '') row.target = target;
    if (typeof result.code === 'string') row.code = result.code;
    if (typeof parts.exitCode === 'number') row.exitCode = parts.exitCode;
    if (typeof result.spilled === 'string') row.spilled = result.spilled;
    const payload = isRecord(result.content) ? result.content : {};
    const child = isRecord(payload.result) ? payload.result : {};
    const raw = record.tool === 'present' ? payload.artifacts : record.tool === 'subagent' ? child.artifacts : undefined;
    const deliveries = Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> =>
      isRecord(item) && item.kind === 'file' && typeof item.path === 'string'
        && typeof item.sha256 === 'string' && typeof item.bytes === 'number') : [];
    return [row, ...deliveries.map(item => ({
      kind: 'meta', text: t(`已交付文件：${item.path}（${item.bytes} 字节；SHA-256 ${String(item.sha256).slice(0, 12)}…；会话 ${item.sessionId}）`,
        `Delivered file: ${item.path} (${item.bytes} bytes; SHA-256 ${String(item.sha256).slice(0, 12)}…; Session ${item.sessionId})`),
    }))];
  }
  if (record.kind === 'mode') {
    const name = typeof record.name === 'string' ? record.name : '';
    const layer = typeof record.layer === 'string' ? record.layer : '';
    return [{ kind: 'meta', text: t(`工具模式：${name}（${MODE_LAYERS[layer] ?? layer}）`, `Tool mode: ${name} (${layer})`) }];
  }
  if (record.kind === 'label') {
    const parts = [];
    if (typeof record.name === 'string') parts.push(t(`名称：${record.name}`, `Name: ${record.name}`));
    if (typeof record.archived === 'boolean') parts.push(record.archived ? t('已归档', 'Archived') : t('已取消归档', 'Restored from archive'));
    return parts.length === 0 ? [] : [{ kind: 'meta', text: parts.join('，') }];
  }
  return [];
}
