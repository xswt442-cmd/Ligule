// 终端命令表和候选清单的纯计算逻辑。
// 命令和提示模板由 Host 提供并展开，界面不维护副本。
import stringWidth from 'string-width';
import { textOf, type AskAnswer, type AskQuestion, type Locale } from '@ligule/core/tui.js';
const WIDTH_CACHE_LIMIT = 1024;
const widthCache = new Map<string, number>();

export interface UiCommand {
  readonly name: string;
  readonly usage: string;
  readonly text: string;
  readonly hint: string;
  /** 该命令能否在轮次运行期间使用。 */
  readonly whenRunning: boolean;
}

/** Host 返回的提示模板结构，与 `status.get` 中的字段保持一致。 */
export interface TemplateCommand {
  readonly command: string;
  readonly description?: string;
  readonly hint?: string;
}

export interface Candidate {
  readonly name: string;
  readonly text: string;
  readonly hint: string;
  readonly source: 'ui' | 'template';
}

// 命令按使用频率排序；此顺序也是帮助列表中的显示顺序。
export const UI_COMMANDS = Object.freeze([
  { name: 'help', usage: '/help', text: '列出命令与按键', hint: '', whenRunning: true },
  { name: 'mode', usage: '/mode [名字]', text: '查看或切换工具模式', hint: '[名字]', whenRunning: true },
  { name: 'model', usage: '/model [服务 模型]', text: '列出模型服务，或切换当前会话的模型', hint: '[服务 模型]', whenRunning: true },
  { name: 'think', usage: '/think [none|low|high|max|default]', text: '查看或修改本会话的思考档', hint: '[档位]', whenRunning: true },
  { name: 'credentials', usage: '/credentials', text: '检查当前模型的凭据状态', hint: '', whenRunning: true },
  { name: 'mcp', usage: '/mcp [list|add|remove|trust|confirm|revoke|tools]', text: '管理本机 MCP Server 配置、信任与工具', hint: '[操作]', whenRunning: false },
  { name: 'extensions', usage: '/extensions [on|off]', text: '列出用户扩展，或停用与启用', hint: '[on|off] [名称]', whenRunning: false },
  { name: 'trust', usage: '/trust [revoke]', text: '查看工作区信任，或撤销信任并退出', hint: '[revoke]', whenRunning: false },
  { name: 'policy', usage: '/policy [ask|auto|none|reset]', text: '查看或修改审批方式', hint: '[ask|auto|none|reset]', whenRunning: true },
  { name: 'permission', usage: '/permission [read-only|workspace-write|full-access|network]', text: '查看或修改本会话的 OS 权限', hint: '[档位|network]', whenRunning: false },
  { name: 'screen', usage: '/screen [on [confirm]|off]', text: '单独授权或撤销本会话截图', hint: '[on [confirm]|off]', whenRunning: true },
  { name: 'browser', usage: '/browser [stop|resume]', text: '查看或控制本会话浏览器', hint: '[stop|resume]', whenRunning: true },
  { name: 'control', usage: '/control [list|create|revoke <id>|copy <id>]', text: '管理本地外部 Agent 授权', hint: '[操作]', whenRunning: false },
  { name: 'status', usage: '/status', text: '查看会话状态', hint: '', whenRunning: true },
  { name: 'compact', usage: '/compact', text: '压缩上下文（需要 limits.contextTokens）', hint: '', whenRunning: true },
  { name: 'tools', usage: '/tools', text: '列出可用工具', hint: '', whenRunning: true },
  { name: 'show', usage: '/show [序号]', text: '查看完整记录；不带序号收起', hint: '[序号]', whenRunning: true },
  { name: 'sub', usage: '/sub [序号]', text: '查看子任务记录；不带序号收起', hint: '[序号]', whenRunning: true },
  { name: 'new', usage: '/new', text: '创建新会话', hint: '', whenRunning: false },
  { name: 'queue', usage: '/queue [list|pause|continue|drop <序号>|clear]', text: '查看、暂停、继续或收回待发送消息', hint: '[动作]', whenRunning: true },
  { name: 'bind', usage: '/bind [<动作> <键的写法>|reset <动作>|default]', text: '查看或修改快捷键', hint: '[动作 键|reset <动作>|default]', whenRunning: true },
  { name: 'copy', usage: '/copy', text: '复制最近的回答', hint: '', whenRunning: true },
  { name: 'export', usage: '/export <路径>', text: '将会话与子任务导出为 Markdown', hint: '<路径>', whenRunning: true },
  { name: 'sessions', usage: '/sessions', text: '浏览工作区会话（UTC 时间）', hint: '', whenRunning: true },
  { name: 'find', usage: '/find <文字>', text: '搜索工作区会话', hint: '<文字>', whenRunning: true },
  { name: 'resume', usage: '/resume <id> [模式名]', text: '通过唯一编号前缀恢复会话', hint: '<id> [模式名]', whenRunning: false },
  { name: 'takeover', usage: '/takeover', text: '接管当前外控会话', hint: '', whenRunning: true },
  { name: 'branch', usage: '/branch [序号]', text: '复制会话，或从完整轮次创建分支', hint: '[序号]', whenRunning: false },
  { name: 'rename', usage: '/rename <文字>', text: '重命名会话', hint: '<文字>', whenRunning: true },
  { name: 'archive', usage: '/archive', text: '归档会话', hint: '', whenRunning: true },
  { name: 'unarchive', usage: '/unarchive', text: '取消归档', hint: '', whenRunning: true },
  { name: 'quit', usage: '/quit', text: '退出（Ctrl+C 同样）', hint: '', whenRunning: true },
] as const satisfies readonly UiCommand[]);

type CommandName = typeof UI_COMMANDS[number]['name'];
const ENGLISH_COMMANDS: Record<CommandName, readonly [string, string, string]> = {
  help: ['/help', 'List commands and shortcuts', ''],
  mode: ['/mode [name]', 'Show or change the tool mode', '[name]'],
  model: ['/model [service model]', 'List services or change this session’s model', '[service model]'],
  think: ['/think [none|low|high|max|default]', 'Show or change this session’s thinking level', '[level]'],
  credentials: ['/credentials', 'Check credentials for the current model', ''],
  mcp: ['/mcp [list|add|remove|trust|confirm|revoke|tools]', 'Manage local MCP server configuration, trust, and tools', '[action]'],
  extensions: ['/extensions [on|off]', 'List user extensions, or disable and enable them', '[on|off] [name]'],
  trust: ['/trust [revoke]', 'View workspace trust, or revoke it and exit', '[revoke]'],
  policy: ['/policy [ask|auto|none|reset]', 'Show or change the approval mode', '[ask|auto|none|reset]'],
  permission: ['/permission [read-only|workspace-write|full-access|network]', 'View or change this session’s operating-system permissions', '[profile|network]'],
  screen: ['/screen [on [confirm]|off]', 'Authorize or revoke screen capture for this Session', '[on [confirm]|off]'],
  browser: ['/browser [stop|resume]', 'Show or control this Session’s browser', '[stop|resume]'],
  control: ['/control [list|create|revoke <id>|copy <id>]', 'Manage local external Agent grants', '[action]'],
  status: ['/status', 'Show session status', ''],
  compact: ['/compact', 'Compact context (requires limits.contextTokens)', ''],
  tools: ['/tools', 'List available tools', ''],
  show: ['/show [seq]', 'View an event; omit seq to close', '[seq]'],
  sub: ['/sub [seq]', 'View a subtask; omit seq to close', '[seq]'],
  new: ['/new', 'Start a new session', ''],
  queue: ['/queue [list|pause|continue|drop <n>|clear]', 'List, pause, resume, or recover queued messages', '[action]'],
  bind: ['/bind [<action> <key>|reset <action>|default]', 'View or change keyboard shortcuts', '[action key|reset <action>|default]'],
  copy: ['/copy', 'Copy the latest answer', ''],
  export: ['/export <path>', 'Export conversation and subtasks as Markdown', '<path>'],
  sessions: ['/sessions', 'Browse this workspace’s sessions (UTC)', ''],
  find: ['/find <text>', 'Search this workspace’s conversations', '<text>'],
  resume: ['/resume <id> [mode]', 'Resume a session by its unique ID prefix', '<id> [mode]'],
  takeover: ['/takeover', 'Take over the externally controlled session', ''],
  branch: ['/branch [seq]', 'Copy the session, or branch at a completed turn', '[seq]'],
  rename: ['/rename <text>', 'Rename this session', '<text>'],
  archive: ['/archive', 'Archive this session', ''],
  unarchive: ['/unarchive', 'Restore this session from the archive', ''],
  quit: ['/quit', 'Exit (also Ctrl+C)', ''],
};

export function localizedCommand(command: UiCommand, locale: Locale): UiCommand {
  if (locale === 'zh') return command;
  const [usage, text, hint] = ENGLISH_COMMANDS[command.name as CommandName];
  return { ...command, usage, text, hint };
}

export function findUiCommand(name: string): UiCommand | undefined {
  return UI_COMMANDS.find((command) => command.name === name);
}

// 写入摘要说明操作对象、删除内容和新增内容。
// 不显示未读取的正文；删除只说明移入回收站，整份写入不推测目标是新建还是覆盖。
export type Change = { readonly summary: string; readonly action: string; readonly before: string; readonly after: string };

export function describeChange(tool: string, args: Record<string, unknown>, locale: Locale = 'zh'): Change {
  const t = (zh: string, en: string) => textOf(locale, zh, en);
  const path = typeof args.path === 'string' ? args.path : '';
  const count = (value: unknown) => String(value ?? '').split('\n').length;
  const empty: Change = { summary: '', action: '', before: '', after: '' };
  // 缺少路径时不生成目标摘要；展开详情仍显示原始参数。
  if (path === '') return empty;
  if ((tool === 'write' || tool === 'create') && typeof args.content === 'string') {
    return {
      summary: t(`${path}：写入 ${count(args.content)} 行`, `${path}: write ${count(args.content)} lines`),
      action: t('写入完整文件；覆盖已有文件前必须完整读取', 'Write the entire file; overwriting requires reading the existing file first'),
      before: '',
      after: args.content,
    };
  }
  if (tool === 'edit' && typeof args.anchor === 'string') {
    const replacement = typeof args.replacement === 'string' ? args.replacement : '';
    return {
      summary: t(`${path}：替换 ${count(args.anchor)} 行，写入 ${count(replacement)} 行`, `${path}: replace ${count(args.anchor)} lines with ${count(replacement)} lines`),
      action: t(`${path}：替换匹配内容`, `${path}: replace matched text`),
      before: args.anchor,
      after: replacement,
    };
  }
  if (tool === 'delete') {
    return { summary: t(`将 ${path} 移入系统回收站`, `Move ${path} to the system recycle bin`), action: t(`若系统回收站不可用或拒绝目标，操作会报错并保留原文件`, `If the system recycle bin is unavailable or refuses the target, the operation reports an error and leaves the source in place`), before: '', after: '' };
  }
  return empty;
}

export type InputRoute =
  | { readonly kind: 'command'; readonly name: string; readonly argument: string }
  | { readonly kind: 'run'; readonly text: string }
  | { readonly kind: 'blocked'; readonly usage: string };

const INVOCATION = /^\/([^\s]*)(?:\s+([\s\S]*))?$/;

// 将用户输入分类为内置命令或 Host 处理的提示模板。未知斜杠命令交给 Host 展开。
// `blocked` 表示命令存在但当前轮次不能执行，与未知命令分开处理。
export function routeInput(text: string, running: boolean): InputRoute {
  const trimmed = text.trim();
  const matched = INVOCATION.exec(trimmed);
  if (matched === null) return { kind: 'run', text: trimmed };
  const name = matched[1].toLowerCase();
  if (name === '') return { kind: 'command', name: 'help', argument: '' };
  const command = findUiCommand(name);
  if (command === undefined) return { kind: 'run', text: trimmed };
  if (running && !command.whenRunning) return { kind: 'blocked', usage: command.usage };
  return { kind: 'command', name: command.name, argument: matched[2] ?? '' };
}

const ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  policy: ['ask', 'auto', 'none', 'reset'],
  permission: ['read-only', 'workspace-write', 'full-access', 'network'],
  screen: ['on', 'off'],
  'screen on': ['confirm'],
  browser: ['stop', 'resume'],
  'permission network': ['policy', 'disabled', 'unrestricted'],
  queue: ['list', 'pause', 'continue', 'drop', 'clear'],
  mcp: ['list', 'add', 'remove', 'trust', 'confirm', 'revoke', 'tools'],
  extensions: ['list', 'on', 'off'],
  trust: ['revoke'],
  control: ['list', 'create', 'revoke', 'copy'],
  bind: ['reset', 'default'],
};

// 候选只插入草稿；执行和危险选项的确认仍经过原来的命令处理。
export function candidatesOf(
  draft: string,
  templates: readonly TemplateCommand[] = [],
  limit = Infinity,
  locale: Locale = 'zh',
): Candidate[] {
  if (!draft.startsWith('/')) return [];
  const typed = draft.slice(1);
  if (/\s/.test(typed)) {
    const words = typed.toLowerCase().split(/\s+/);
    const argument = words.pop() ?? '';
    const head = words.join(' ');
    const command = findUiCommand(words[0] ?? '');
    if (command !== undefined) {
      return (ARGUMENTS[head] ?? []).filter(value => value.startsWith(argument)).map(value => ({
        name: `${head} ${value}`, text: localizedCommand(command, locale).text, hint: '', source: 'ui' as const,
      })).slice(0, limit);
    }
  }
  const prefix = typed.toLowerCase();
  const fromUi = UI_COMMANDS.map(command => localizedCommand(command, locale)).map((command) => ({
    name: command.name,
    text: command.text,
    hint: command.hint,
    source: 'ui' as const,
  }));
  const fromTemplates = templates
    .filter(template => findUiCommand(template.command) === undefined)
    .map((template) => ({
      name: template.command,
      text: template.description ?? '',
      hint: template.hint ?? '',
      source: 'template' as const,
    }));
  const rank = (candidate: Candidate) => candidate.name.toLowerCase().startsWith(prefix) ? 0 : 1;
  return [...fromUi, ...fromTemplates]
    .filter(candidate => candidate.name.toLowerCase().includes(prefix) || candidate.text.toLowerCase().includes(prefix))
    .sort((left, right) => rank(left) - rank(right))
    .slice(0, limit);
}

// 按终端显示列宽对齐表格，正确处理全角和中日韩字符的双列宽度。
export function displayWidth(text: string): number {
  if (text.length > 32) return stringWidth(text);
  const known = widthCache.get(text);
  if (known !== undefined) return known;
  const width = stringWidth(text);
  if (widthCache.size < WIDTH_CACHE_LIMIT) widthCache.set(text, width);
  return width;
}

/** `sessions.list` 返回的会话数据中，界面需要展示的字段。 */
export interface SessionRow {
  readonly id: string;
  readonly updatedAt: string;
  readonly events: number;
  readonly mode: { readonly name: string } | null;
  /** 用户设置的会话名称；未命名时为空字符串。 */
  readonly name?: string;
  /** 归档状态只影响列表显示，记录仍可恢复。 */
  readonly archived?: boolean;
  readonly unanswered: number;
  readonly truncatedBytes?: number;
  readonly error?: { readonly code: string; readonly detail: string };
}

/** 限制一次显示的会话条数，避免列表超出终端可用空间。 */
export const SESSION_ROWS = 20;

// 每个会话显示为一行。完整 ID 可直接用于 `/resume`，时间取记录文件的 UTC 修改时间。
export function sessionLines(listed: readonly SessionRow[], current = '', locale: Locale = 'zh'): string[] {
  const t = (zh: string, en: string) => textOf(locale, zh, en);
  if (listed.length === 0) return [t('此工作区暂无会话', 'No sessions in this workspace')];
  return listed.map((item) => [
    item.updatedAt.slice(0, 19).replace('T', ' '),
    item.id,
    t(`${item.events} 条`, `${item.events} events`),
    `mode:${item.mode?.name ?? '-'}`,
    item.name === undefined || item.name === '' ? '' : `「${item.name}」`,
    item.archived === true ? t('已归档', 'archived') : '',
    item.unanswered > 0 ? t(`未收尾 ${item.unanswered} 次派发`, `${item.unanswered} unresolved calls`) : '',
    (item.truncatedBytes ?? 0) > 0 ? t(`尾行未完成 ${item.truncatedBytes} 字节`, `${item.truncatedBytes} incomplete bytes`) : '',
    item.error === undefined ? '' : t(`无法恢复：${item.error.code} · ${item.error.detail}`, `Cannot resume: ${item.error.code} · ${item.error.detail}`),
    item.id === current ? t('← 当前会话', '← current session') : '',
  ].filter((cell) => cell !== '').join('  '));
}

/** `sessions.search` 返回的单条搜索结果。 */
export interface SearchRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
  readonly name?: string;
  readonly spilled?: string;
}

// 将已知事件类型显示为中文；未知类型原样显示。
const HIT_KINDS: Record<string, string> = { user: '问', assistant: '答', reasoning: '推理', tool: '工具', label: '名字' };

// 每行显示一条命中。会话 ID 前缀用于 `/resume`，事件序号用于 `/show`。
export function findLines(listed: readonly SearchRow[], current = '', locale: Locale = 'zh'): string[] {
  const t = (zh: string, en: string) => textOf(locale, zh, en);
  return listed.map((hit) => [
    hit.sessionId.slice(0, 8),
    hit.name === undefined || hit.name === '' ? '' : `「${hit.name}」`,
    t(`${HIT_KINDS[hit.kind] ?? hit.kind} 第 ${hit.seq} 条`, `${hit.kind} #${hit.seq}`),
    hit.text,
    hit.spilled === undefined ? '' : t(`整段在 ${hit.spilled}`, `Full result: ${hit.spilled}`),
    hit.sessionId === current ? t('← 当前会话', '← current session') : '',
  ].filter((cell) => cell !== '').join('  '));
}

// 识别当前输入中的 `@` 路径引用；`@` 必须位于行首或空白之后，以避免匹配邮箱地址。
const MENTION = /(?:^|(\s))@([^\s]*)$/;

/** 查找光标前尚未完成的路径引用；`start` 是 `@` 的位置。光标后已有文本时不匹配，以免替换时截断内容。 */
export function mentionToken(draft: string, caret: number): { readonly start: number; readonly text: string } | null {
  const after = draft.slice(caret);
  if (after !== '' && !/^\s/.test(after)) return null;
  const matched = MENTION.exec(draft.slice(0, caret));
  if (matched === null) return null;
  return { start: caret - matched[2].length - 1, text: matched[2] };
}

/** 选择候选后将 `@…` 替换为 `@路径 `，保留后续文本并更新光标位置。 */
export function insertMention(draft: string, caret: number, start: number, path: string): { readonly draft: string; readonly caret: number } {
  const inserted = `@${path} `;
  return { draft: draft.slice(0, start) + inserted + draft.slice(caret), caret: start + inserted.length };
}

/** 返回唯一匹配的会话，或说明前缀不匹配或不唯一。 */export type SessionPick = { readonly id: string } | { readonly code: 'tui_session_ambiguous' | 'tui_session_not_listed' };

// 支持通过会话 ID 前缀恢复，但必须在当前项目列表中唯一匹配。
export function resolveSessionId(argument: string, listed: readonly SessionRow[]): SessionPick {
  const wanted = argument.trim().toLowerCase();
  const exact = listed.find((item) => item.id.toLowerCase() === wanted);
  if (exact !== undefined) return { id: exact.id };
  const prefix = listed.filter((item) => item.id.toLowerCase().startsWith(wanted));
  if (prefix.length === 1) return { id: prefix[0].id };
  return { code: prefix.length > 1 ? 'tui_session_ambiguous' : 'tui_session_not_listed' };
}

/**
 * 有效选项编号用于选择对应选项；其他文本按自由回答原样保存，空输入表示未回答。
 * 不从自由文本猜测选项。单选题收到多个编号时按自由文本处理，避免静默丢弃输入。
 */
export function answerOf(question: AskQuestion, text: string): AskAnswer | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.split(/[,，、\s]+/).filter((one) => one !== '');
  const within = question.options.length > 0
    && tokens.every((one) => /^\d+$/.test(one))
    && tokens.every((one) => Number(one) >= 1 && Number(one) <= question.options.length)
    && (question.multiSelect || tokens.length === 1);
  if (!within) return { id: question.id, selected: [], custom: trimmed };
  return { id: question.id, selected: [...new Set(tokens.map((one) => question.options[Number(one) - 1].label))] };
}
