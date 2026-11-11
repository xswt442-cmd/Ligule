// 将会话记录投影为界面行。显示已落盘事件和当前流式片段。
// 记录结构由 `core/src/session/session.ts` 定义；此模块只负责展示数据。
// 卡片标题显示操作结果，正文显示面向用户的内容。
import type { ProviderDiagnostic } from './status';

export type ToolCall = { id: string; name: string; args?: Record<string, unknown> };

export type FileDelivery = {
  kind: 'file'; sessionId: string; path: string; mimeType: string;
  bytes: number; sha256: string; description?: string;
};

export type ImageReference = {
  kind: 'image';
  version: 1;
  id: string;
  workspace: string;
  sessionId: string;
  source: 'file' | 'desktop' | 'browser' | 'document';
  mimeType: 'image/png';
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
};

export type Verdict = {
  decision?: string;
  via?: string;
  capability?: string;
  level?: string;
  forced?: boolean;
  rule?: string;
  answer?: string;
};

export type Record_ = {
  seq?: number;
  kind: string;
  name?: string;
  archived?: boolean;
  // 模板展开后保留原始用户输入；界面显示原文，模型收到展开后的 `text`。
  text?: string;
  raw?: string;
  origin?: string;
  toolCalls?: ToolCall[];
  tool?: string;
  callId?: string;
  // 执行耗时由 Kernel 写入事件。未执行或恢复补写结果的调用没有耗时。
  durationMs?: number;
  // 工具调用记录保存输入参数，供派生结果说明其来源。
  args?: Record<string, unknown>;
  result?: {
    kind?: string;
    failed?: boolean;
    code?: string;
    reason?: string;
    content?: unknown;
    spilled?: string;
    images?: ImageReference[];
  };
  // 权限判定结果写入记录并显示在界面中，但不进入模型上下文。
  verdict?: Verdict;
  // 完整结束的轮次可作为会话分支点。
  status?: string;
  code?: string;
  diagnostics?: ProviderDiagnostic;
  iterations?: number;
  modelCalls?: number;
  // `session.read` 返回的轮次参数快照；记录中没有该事件时不显示对应数据。
  model?: string | null;
  policy?: string;
  policySource?: string;
  mode?: string;
  // 标记由恢复流程补写的结果。
  recovery?: { assistantSeq?: number; safeToRedo?: boolean };
};

// 根据展示设置过滤记录类型，避免虚拟列表测量不渲染的行。
export const shownIn = (verbosity: string, row: Row): boolean =>
  !(verbosity === 'brief' && (row.kind === 'reasoning' || row.kind === 'call' || row.kind === 'result' || row.kind === 'context'))
  && !(verbosity === 'standard' && (row.kind === 'reasoning' || row.kind === 'context'));

export function callRowFoldLabel(text: string, t: (chinese: string, english: string) => string): string {
  return text.trim().startsWith('{') ? t('看参数', 'View arguments') : t('看全文', 'Show more');
}

export type Row = {
  id: number;
  kind: 'question' | 'answer' | 'reasoning' | 'call' | 'result' | 'refusal' | 'failure' | 'round' | 'context' | 'meta' | 'error';
  text: string;
  status?: string;
  // 对应的会话事件序号；界面本地生成的行没有该字段。
  seq?: number;
  source?: 'controller';
  // 实际执行的能力名称；MCP 调用显示 `mcp:<服务器>/<工具>`。
  tool?: string;
  code?: string;
  diagnostics?: ProviderDiagnostic;
  callId?: string;
  images?: ImageReference[];
  deliveries?: FileDelivery[];
  // 卡片标题下方显示目标对象和操作摘要。
  summary?: string;
  // 卡片右侧显示退出码、溢出文件、判定、派生会话和耗时等状态。
  notes?: string[];
  // 系统摘要和状态读数保留中英文版本；切换语言不修改模型正文或工具输出。
  english?: { text?: string; summary?: string; notes?: string[] };
  // 写入操作的变更行数：删除行数和新增行数。
  diff?: { added: number; removed: number };
};

// 工具结果可以是字符串或包含 `text` 字段的结构化对象。
function fileDeliveriesOf(tool: string | undefined, content: unknown): FileDelivery[] {
  if (tool !== 'present' && tool !== 'subagent') return [];
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return [];
  const outer = content as Record<string, unknown>;
  const child = tool === 'subagent' && outer.result !== null && typeof outer.result === 'object'
    ? outer.result as Record<string, unknown> : undefined;
  const artifacts = tool === 'present' ? outer.artifacts : child?.artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts.filter((item): item is FileDelivery => item !== null && typeof item === 'object'
    && item.kind === 'file' && typeof item.sessionId === 'string'
    && typeof item.path === 'string' && typeof item.mimeType === 'string'
    && typeof item.sha256 === 'string' && typeof item.bytes === 'number');
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

// 将 `mcp.call` 显示为实际能力名称，供权限说明和审批卡阅读。
export function capabilityOf(name?: string, args?: Record<string, unknown>): string {
  if (name === 'mcp.call' && typeof args?.server === 'string' && typeof args?.tool === 'string') {
    return `mcp:${args.server}/${args.tool}`;
  }
  return name ?? '';
}

// 结构化工具结果将 `text` 显示为正文，其余允许字段用于卡片状态。
function payloadOf(result: Record_['result']): { text?: string; exitCode?: unknown; effectiveCapability?: unknown; sessionId?: unknown } {
  const content = result?.content;
  return typeof content === 'object' && content !== null
    ? content as { text?: string; exitCode?: unknown; effectiveCapability?: unknown; sessionId?: unknown }
    : {};
}

// 写入摘要显示目标路径及删除、新增行数；缺少路径时不生成占位路径。
// 审批详情使用 `action`、`before` 和 `after` 展示目标及变更内容。
// 未读取的正文不显示。删除仅说明移入回收站；整份写入不推测目标文件是否已存在。
export type Change = { summary: string; diff?: { added: number; removed: number }; action: string; before: string; after: string };

export function changeOf(tool: string, args: Record<string, unknown>, locale: 'zh' | 'en' = 'zh'): Change {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const path = typeof args.path === 'string' ? args.path : '';
  const lines = (value: unknown) => String(value ?? '').split('\n').length;
  const none: Change = { summary: '', action: '', before: '', after: '' };
  if (path === '') return none;
  if ((tool === 'write' || tool === 'create') && typeof args.content === 'string') {
    const added = lines(args.content);
    return {
      summary: t(`${path}：写入 ${added} 行`, `${path}: write ${added} lines`),
      diff: { added, removed: 0 },
      action: t('写入完整文件；覆盖已有文件前必须完整读取', 'Write the entire file; overwriting requires reading the existing file first'),
      before: '',
      after: args.content,
    };
  }
  if (tool === 'edit' && typeof args.anchor === 'string') {
    const replacement = typeof args.replacement === 'string' ? args.replacement : '';
    return {
      summary: t(`${path}：替换 ${lines(args.anchor)} 行，写入 ${lines(replacement)} 行`, `${path}: replace ${lines(args.anchor)} lines with ${lines(replacement)} lines`),
      diff: { added: lines(replacement), removed: lines(args.anchor) },
      action: t(`${path}：替换匹配内容`, `${path}: replace matched text`),
      before: args.anchor,
      after: replacement,
    };
  }
  if (tool === 'edit' && Array.isArray(args.changes)) {
    const changes = args.changes;
    if (changes.length === 0) return none;
    if (!changes.every((change) => typeof change === 'object' && change !== null
      && typeof (change as Record<string, unknown>).oldText === 'string'
      && typeof (change as Record<string, unknown>).newText === 'string')) return none;
    const pairs = changes as { oldText: string; newText: string }[];
    const changedLines = (value: string) => {
      if (value === '') return 0;
      const count = value.split(/\r\n|\n|\r/u).length;
      return /(?:\r\n|\n|\r)$/u.test(value) ? count - 1 : count;
    };
    const removed = pairs.reduce((total, change) => total + changedLines(change.oldText), 0);
    const added = pairs.reduce((total, change) => total + changedLines(change.newText), 0);
    const before = pairs.map((change, index) => `[${index + 1}]\n${change.oldText}`).join('\n\n');
    const after = pairs.map((change, index) => `[${index + 1}]\n${change.newText === '' ? t('（空）', '(empty)') : change.newText}`).join('\n\n');
    return {
      summary: t(`${path}：精确替换 ${pairs.length} 处（删除 ${removed} 行，写入 ${added} 行）`, `${path}: replace ${pairs.length} exact matches (${removed} lines removed, ${added} added)`),
      diff: { added, removed },
      action: t(`${path}：逐处替换唯一匹配内容`, `${path}: replace each unique exact match`),
      before,
      after,
    };
  }
  if (tool === 'delete') {
    return { summary: t(`将 ${path} 移入系统回收站`, `Move ${path} to the system recycle bin`), action: t(`若系统回收站不可用或拒绝目标，操作会报错并保留原文件`, `If the system recycle bin is unavailable or refuses the target, the operation reports an error and leaves the source in place`), before: '', after: '' };
  }
  return none;
}

// 审批详情将写入操作显示为删除和新增内容，并使用减号和加号标记。
// 其他工具按原参数显示，不补造内容。
export function changeBody(change: Change, args: Record<string, unknown>, locale: 'zh' | 'en' = 'zh'): string {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  if (change.action === '') return typeof args.content === 'string' ? args.content : JSON.stringify(args, null, 2);
  const mark = (text: string, sign: string): string[] =>
    text === '' ? [`${sign}${t('（空）', '(empty)')}`] : text.split('\n').map((line) => `${sign} ${line}`);
  return [change.action,
    ...(change.before === '' ? [] : [t('原内容:', 'Before:'), ...mark(change.before, '-')]),
    ...(change.after === '' ? [] : [t('新内容:', 'After:'), ...mark(change.after, '+')]),
  ].join('\n');
}

// 优先用命令、路径、地址或 MCP 能力名说明操作对象；都不存在时显示参数摘要。
function argSummary(tool: string, args: Record<string, unknown>): string {
  if (tool === 'ask_user_question') {
    let questions: unknown = args.questions;
    if (typeof questions === 'string') {
      try {
        questions = JSON.parse(questions);
      } catch {
        // 格式无效时在展开详情中保留原始参数。
        return '';
      }
    }
    if (!Array.isArray(questions)) return '';
    return questions.flatMap((question: unknown) => {
      if (typeof question !== 'object' || question === null) return [];
      const fields = question as Record<string, unknown>;
      const title = fields.header ?? fields.question;
      return typeof title === 'string' && title.trim() !== '' ? [title.trim()] : [];
    }).join(' · ').slice(0, 160);
  }
  const single = args.command ?? args.path ?? args.url ?? args.pattern ?? args.query ?? args.task;
  if (typeof single === 'string' && single !== '') return single;
  // MCP 能力名称已显示在标题中，摘要只展示调用输入。
  const rest = tool === 'mcp.call' ? { ...args, server: undefined, tool: undefined } : args;
  const line = JSON.stringify(rest);
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

// 将判定结果、审批状态、命中规则和策略档位转换为界面文案。
function verdictNote(verdict: Verdict, locale: 'zh' | 'en'): string {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  if (typeof verdict.decision !== 'string') return '';
  const outcome = verdict.decision === 'deny' ? t('已拒绝', 'Denied') : verdict.via === 'ask' ? t('审批通过', 'Approved') : t('自动允许', 'Allowed automatically');
  // 连续拒绝只会收紧到「逐项审批」；none/never 档不受影响，不能显示成档位变化。
  const escalated = verdict.forced === true && verdict.via === 'ask' && verdict.level !== undefined && verdict.level !== 'none' && verdict.level !== 'never' && verdict.level !== 'ask';
  const level = verdict.level === undefined ? '' : ` (${verdict.level}${escalated ? '→ask' : ''})`;
  const rule = typeof verdict.rule === 'string' && verdict.rule !== '' ? t(` · 规则：${verdict.rule}`, ` · Rule: ${verdict.rule}`) : '';
  return `${outcome}${level}${rule}`;
}

function toolNotes(record: Record_, result: NonNullable<Record_['result']>, locale: 'zh' | 'en'): string[] {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const payload = payloadOf(result);
  const notes: string[] = [];
  if (payload.exitCode !== undefined) notes.push(t(`退出码 ${String(payload.exitCode)}`, `Exit code ${String(payload.exitCode)}`));
  if (result.spilled !== undefined) notes.push(t(`完整结果：${result.spilled}`, `Full result: ${result.spilled}`));
  const verdict = verdictNote(record.verdict ?? {}, locale);
  if (verdict !== '') notes.push(verdict);
  if (typeof payload.sessionId === 'string') notes.push(t(`子任务 ${payload.sessionId}`, `Subtask ${payload.sessionId}`));
  if (record.recovery !== undefined) {
    notes.push(record.recovery.safeToRedo === true ? t('中断恢复 · 可重试', 'Recovered after interruption · retry available') : t('中断恢复 · 外部操作结果未知', 'Recovered after interruption · external outcome unknown'));
  }
  return notes;
}

// 没有参数时不显示空对象。
function argsText(args: Record<string, unknown> | undefined): string {
  return args === undefined || Object.keys(args).length === 0 ? '' : textOf(args);
}

let sequence = 0;
const nextId = (): number => (sequence += 1);

export function metaRow(kind: 'meta' | 'error', text: string, english?: string): Row {
  return { id: nextId(), kind, text, ...(english === undefined ? {} : { english: { text: english } }) };
}

// 记录中的耗时由 Kernel 测量，不包含审批等待。
// 界面计时包含等待时间，因此只用于当前仍在运行的轮次。
function secondsNote(ms: number, locale: 'zh' | 'en' = 'zh'): string {
  const seconds = ms / 1000;
  const shown = seconds < 10 ? seconds.toFixed(1) : Math.round(seconds);
  return locale === 'zh' ? `用时 ${shown} 秒` : `${shown}s`;
}

export function durationNote(startedAt: number, now: number): string {
  return secondsNote(now - startedAt);
}

// 关闭提问卡片时将题目和已输入答案留在转录中。
// 每个请求只能答复一次；卡片关闭后内容不能再提交给 Host。
export function questionEcho(ask: { questions: { id: string; question: string }[] }, drafts: Record<string, { picked: string[]; extra: string }> = {}, locale: 'zh' | 'en' = 'zh'): string {
  return ask.questions.map((question, index) => {
    const typed = [...(drafts[question.id]?.picked ?? []), (drafts[question.id]?.extra ?? '').trim()].filter((one) => one !== '');
    const prefix = locale === 'zh' ? `第 ${index + 1} 题「${question.question}」：` : `Question ${index + 1}: “${question.question}” — `;
    const answer = typed.length === 0
      ? (locale === 'zh' ? '没有作答' : 'No answer entered')
      : typed.join(locale === 'zh' ? '、' : ', ');
    return `${prefix}${answer}`;
  }).join(locale === 'zh' ? '；' : '; ');
}

export function projectRecord(record: Record_, options: { startedAt?: number; now?: number } = {}): Row[] {
  // 每行保留来源事件序号，供搜索结果定位到对应记录。
  const at = record.seq === undefined ? {} : { seq: record.seq };
  return projected(record, options).map((row) => ({ ...row, ...at }));
}

export function appendProjectedRecords(current: Row[], records: readonly Record_[]): Row[] {
  const last = current.reduce((max, row) => Math.max(max, row.seq ?? 0), 0);
  const appended = records
    .filter((record) => record.seq !== undefined && record.seq > last)
    .flatMap((record) => projectRecord(record));
  return appended.length === 0 ? current : [...current, ...appended];
}

function projected(record: Record_, options: { startedAt?: number; now?: number }): Row[] {
  if (record.kind === 'user') return [{
    id: nextId(), kind: 'question', text: record.raw ?? record.text ?? '',
    ...(record.origin === 'controller' ? { source: 'controller' as const } : {}),
  }];
  // 有轮次参数快照时添加一行摘要；记录中没有快照时不生成该行。
  if (record.kind === 'turnContext') {
    const facts = [record.model, record.mode, record.policy].filter((part): part is string => typeof part === 'string' && part !== '');
    if (facts.length === 0) return [];
    const values = facts.join(' · ');
    return [{ id: nextId(), kind: 'context', text: `本轮参数：${values}`, english: { text: `Turn settings: ${values}` } }];
  }
  if (record.kind === 'reasoning') return [{ id: nextId(), kind: 'reasoning', text: record.text ?? '' }];
  // 完整结束的轮次作为分支点显示，并提供创建分支的入口。
  if (record.kind === 'turn') {
    const states: Record<string, string> = { completed: '本轮已完成', cancelled: '本轮已取消', failed: '本轮失败', interrupted: '本轮意外中断' };
    const status = record.status ?? '';
    return states[status] === undefined ? [] : [{
      id: nextId(), kind: 'round', status, code: record.code, diagnostics: record.diagnostics, text: states[status],
    }];
  }
  if (record.kind === 'assistant') {
    const rows: Row[] = record.text === '' || record.text === undefined
      ? []
      : [{ id: nextId(), kind: 'answer', text: record.text }];
    for (const call of record.toolCalls ?? []) {
      rows.push({
        id: nextId(),
        kind: 'call',
        tool: capabilityOf(call.name, call.args),
        callId: call.id,
        summary: argSummary(call.name, call.args ?? {}),
        text: argsText(call.args),
      });
    }
    return rows;
  }
  if (record.kind === 'tool') {
    const result = record.result ?? {};
    const kind = result.failed !== true ? 'result' : result.kind === 'refusal' ? 'refusal' : 'failure';
    const payload = payloadOf(result);
    const notes = toolNotes(record, result, 'zh');
    const englishNotes = toolNotes(record, result, 'en');
    const change = changeOf(record.tool ?? '', record.args ?? {});
    // 优先使用记录中保存的字段，确保重开会话后仍保持一致。
    const duration = typeof record.durationMs === 'number' ? record.durationMs
      : options.startedAt === undefined ? undefined : (options.now ?? Date.now()) - options.startedAt;
    if (duration !== undefined) {
      notes.push(secondsNote(duration));
      englishNotes.push(secondsNote(duration, 'en'));
    }
    return [{
      id: nextId(),
      kind,
      tool: typeof payload.effectiveCapability === 'string'
        ? payload.effectiveCapability
        : capabilityOf(record.tool, record.args),
      code: result.code,
      callId: record.callId,
      ...(result.failed !== true && Array.isArray(result.images) ? { images: result.images } : {}),
      ...(result.failed !== true ? { deliveries: fileDeliveriesOf(record.tool, result.content) } : {}),
      summary: change.summary,
      diff: change.diff,
      notes,
      english: { notes: englishNotes, summary: changeOf(record.tool ?? '', record.args ?? {}, 'en').summary },
      // 失败和拒绝结果显示原因正文，不显示协议封装字段。
      text: typeof payload.text === 'string' ? payload.text : textOf(result.reason ?? result.content),
    }];
  }
  return [];
}
