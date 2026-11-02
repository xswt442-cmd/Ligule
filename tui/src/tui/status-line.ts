// 状态行与预算提示的纯函数：只根据快照拼文本，不读时钟、不发请求、不改状态。
import { displayWidth } from './commands.js';
import { keyHint } from './keymap.js';
import { textOf as chooseText, type Locale } from '@ligule/core/tui.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function fitLine(text: string, columns: number): string {
  if (columns <= 0) return '';
  if (displayWidth(text) <= columns) return text;
  let shown = '';
  for (const { segment } of graphemes.segment(text)) {
    if (displayWidth(`${shown}${segment}…`) > columns) break;
    shown += segment;
  }
  return `${shown}…`;
}

export interface TaskBudget {
  readonly modelCalls: number;
  readonly maxModelCalls: number;
  readonly timeoutMs: number;
  readonly interactionWaitMs: number;
  readonly interactionWaitTimeoutMs: number;
  readonly executionElapsedMs: number;
  readonly executionPaused: boolean;
}

export interface StatusProgress {
  readonly phase: 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';
  readonly lastProgressAt: number;
  readonly modelCalls: number;
  readonly task?: TaskBudget;
}

/** buildStatusLine 只关心运行标志、执行阶段与预算，不关心会话的其余字段。 */
export interface StatusLike {
  readonly running?: boolean;
  readonly progress?: StatusProgress | null;
  readonly task?: TaskBudget | null;
}

// Token 数是本地估算值，并使用波浪号标明，避免误认为模型服务返回的精确用量。
export interface ContextUsage {
  readonly estimated: number;
  readonly window: number;
  readonly threshold: number;
}

function durationLabel(milliseconds: number, locale: Locale): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const units: readonly [number, string, string][] = locale === 'en'
    ? [[86_400, 'd', 'd'], [3_600, 'h', 'h'], [60, 'm', 'm'], [1, 's', 's']]
    : [[86_400, '天', '天'], [3_600, '小时', '小时'], [60, '分', '分'], [1, '秒', '秒']];
  let remaining = totalSeconds;
  const parts: string[] = [];
  for (const [seconds, short, long] of units) {
    const count = Math.floor(remaining / seconds);
    if (count === 0 && parts.length === 0 && seconds !== 1) continue;
    if (count > 0) {
      parts.push(locale === 'en' ? `${count}${short}` : `${count}${long}`);
      remaining -= count * seconds;
      if (parts.length === 2) break;
    }
  }
  return parts.length === 0 ? (locale === 'en' ? '0s' : '0秒') : parts.join(locale === 'en' ? ' ' : '');
}

export function activeRunBudgetSegment(status: StatusLike | null, locale: Locale = 'zh'): string {
  if (status?.running !== true) return '';
  const task = status.progress === null || status.progress === undefined ? status.task : status.progress.task;
  if (task === undefined || task === null) {
    const calls = status.progress?.modelCalls;
    const usage = Number.isSafeInteger(calls)
      ? locale === 'en' ? `model calls ${calls}` : `模型调用 ${calls}`
      : '';
    const preparing = locale === 'en' ? 'run budget initializing' : 'Run 预算准备中';
    return ` · ${[usage, preparing].filter(Boolean).join(' · ')}`;
  }
  const values = [task.modelCalls, task.maxModelCalls, task.timeoutMs, task.interactionWaitMs, task.interactionWaitTimeoutMs, task.executionElapsedMs];
  if (!values.every(Number.isSafeInteger) || values.some(value => value < 0) || task.timeoutMs < 1 || task.maxModelCalls < 1
    || task.interactionWaitTimeoutMs < 1 || typeof task.executionPaused !== 'boolean') {
    return locale === 'en' ? ' · run budget details unavailable' : ' · Run 预算信息暂不可用';
  }
  const remaining = Math.max(0, task.timeoutMs - task.executionElapsedMs);
  const calls = locale === 'en' ? `model calls ${task.modelCalls}/${task.maxModelCalls}` : `模型调用 ${task.modelCalls}/${task.maxModelCalls}`;
  const deadline = locale === 'en'
    ? `execution ${durationLabel(remaining, locale)} left`
    : `执行剩余 ${durationLabel(remaining, locale)}`;
  const interactions = locale === 'en'
    ? `interaction wait ${durationLabel(task.interactionWaitMs, locale)}/${durationLabel(task.interactionWaitTimeoutMs, locale)}`
    : `累计交互等待 ${durationLabel(task.interactionWaitMs, locale)}/${durationLabel(task.interactionWaitTimeoutMs, locale)}`;
  const paused = task.executionPaused ? (locale === 'en' ? ' · deadline paused' : ' · 执行期限已暂停') : '';
  return ` · Run ${calls} · ${deadline} · ${interactions}${paused}`;
}

export function contextSegment(usage: ContextUsage | null | undefined, locale: Locale = 'zh'): string {
  if (usage === null || usage === undefined) return '';
  return `ctx:~${usage.estimated}/${usage.window}${usage.estimated > usage.threshold ? chooseText(locale, ' 超限', ' over limit') : ''}`;
}

// 元数据行显示会话、目录、上下文和运行状态；模型与控制入口显示在输入框下方。
// 空间不足时先截短目录，再隐藏上下文和记录数，并保留取消提示。
export interface StatusLineOptions {
  readonly sessionId: string;
  readonly name?: string;
  readonly boundary?: string;
  readonly status: StatusLike | null;
  readonly running: boolean;
  readonly seconds: number;
  readonly expanded: boolean;
  readonly columns?: number;
  readonly locale?: Locale;
  readonly now?: number;
}

export function buildStatusLine({ sessionId, name, boundary, status, running, seconds, expanded, columns, locale = 'zh', now = Date.now() }: StatusLineOptions): string {
  const t = (zh: string, en: string) => chooseText(locale, zh, en);
  // 命名过的会话显示名称；未命名时退回短编号。
  const titled = name === undefined ? '' : name.trim();
  const id = `${chooseText(locale, '会话', 'session')} ${titled === '' ? sessionId.slice(0, 8) : titled}`;
  const root = boundary === undefined ? '' : boundary;
  const leaf = root === '' ? '' : root.split(/[\\/]/).filter(Boolean).pop() ?? '';
  let base = `${id}${leaf === '' ? '' : ` · ${leaf}`}`;
  // 预算、计数与完整标识符只进 /status；常驻行只留会话、执行阶段与可操作提示。
  const progress = status?.progress;
  const phaseHint = progress === undefined || progress === null ? '' : {
    preparing: t('准备上下文', 'Preparing context'),
    model_request: t('请求模型', 'Requesting model'),
    tool_execution: t('执行工具', 'Running tools'),
    compaction: t('压缩上下文', 'Compacting context'),
    awaiting_approval: t('等待审批', 'Waiting for approval'),
    awaiting_input: t('等待用户输入', 'Waiting for your input'),
    settling: t('正在收尾', 'Finishing'),
  }[progress.phase];
  const idleSeconds = progress === undefined || progress === null ? 0 : Math.max(0, Math.floor((now - progress.lastProgressAt) / 1000));
  const hints = (running
    ? `${phaseHint === '' ? '' : `${phaseHint} · `}${Math.floor(seconds)}${t(' 秒，', 's, ')}${keyHint('interrupt')} ${t('打断', 'stop')}`
    : '')
    + (expanded ? `${running ? ' · ' : ''}${t('已展开（', 'expanded (')}${keyHint('expand-or-history')}${t(' 收起）', ' to close)')}` : '');
  let tail = hints;
  let showIdle = true;
  const line = () => [base, ...(showIdle && running && progress !== undefined && progress !== null ? [`${idleSeconds}${t(' 秒无新进展', 's without progress')}`] : []), tail].filter(part => part !== '').join(' · ');
  const over = () => columns !== undefined && columns > 0 && displayWidth(line()) > columns;
  if (over()) base = id;
  if (over()) base = '';
  if (over()) showIdle = false;
  if (over() && running) tail = `${phaseHint} · ${keyHint('interrupt')} ${t('打断', 'stop')}`;
  if (over() && running) tail = `${keyHint('interrupt')} ${t('打断', 'stop')}`;
  if (over() && running) tail = keyHint('interrupt');
  return columns === undefined ? line() : fitLine(line(), columns);
}
