// Transcript display helpers keep presentation limits separate from session facts.
import { displayWidth } from './commands.js';
import { wrapLine } from './viewport.js';
import { textOf as localized, type Locale } from '@ligule/core/tui.js';

const textOf = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F\u200E-\u200F\u202A-\u202E\u2066-\u2069]/g;

function limitGraphemes(text: string, limit: number): string {
  let shown = '';
  for (const { segment } of graphemes.segment(text)) {
    if (shown.length + segment.length > limit) break;
    shown += segment;
  }
  return shown;
}

export interface FoldedText {
  readonly shown: string;
  readonly hidden: number;
}

export function foldText(text: unknown, expanded: boolean, limit = 3, maxChars = 400): FoldedText {
  return foldTextByColumns(text, expanded, limit, maxChars);
}

function foldTextByColumns(text: unknown, expanded: boolean, limit: number, maxChars: number, columns?: number): FoldedText {
  const full = textOf(text);
  if (expanded) return { shown: full, hidden: 0 };
  let shown: string;
  if (columns === undefined || columns < 1) {
    const lines = full.split('\n');
    shown = lines.length > limit ? lines.slice(0, limit).join('\n') : full;
  } else {
    let rowsLeft = Math.max(1, limit);
    const lines = full.split('\n');
    let visible = '';
    for (const [index, line] of lines.entries()) {
      if (rowsLeft === 0) break;
      if (index > 0) visible += '\n';
      const wrapped = wrapLine(line, columns);
      if (wrapped.length <= rowsLeft) {
        visible += line;
        rowsLeft -= wrapped.length;
      } else {
        visible += wrapped.slice(0, rowsLeft).join('');
        rowsLeft = 0;
      }
    }
    shown = visible;
  }
  const cut = shown.length > maxChars ? limitGraphemes(shown, maxChars) : shown;
  return { shown: cut, hidden: full.length - cut.length };
}

const TARGET_KEYS = ['path', 'file', 'target', 'command', 'url', 'uri', 'cwd', 'query'] as const;

function safeSummaryValue(value: string): string {
  return value.replace(TERMINAL_CONTROL, (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`);
}

export interface ToolCallPreview {
  readonly summary: string;
  readonly hasDetails: boolean;
}

// 结果行只需要一个代表性目标（读的哪个文件、跑的哪条命令），不重复整个参数摘要。
export function toolTarget(serializedArguments: string): string {
  let value: unknown;
  try {
    value = JSON.parse(serializedArguments);
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  const args = value as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const entry = args[key];
    if (typeof entry === 'string' && entry !== '') return safeSummaryValue(entry);
    if (Array.isArray(entry) && entry.length > 0 && entry.every((part) => typeof part === 'string')) return safeSummaryValue(entry.join(', '));
  }
  return '';
}

// 单行摘要按显示宽度截断，宽字形与转义后的控制字符都按实际列数计算。
export function clipToWidth(value: string, columns: number): string {
  if (columns < 1) return '';
  if (displayWidth(value) <= columns) return value;
  let fitted = '';
  for (const { segment } of graphemes.segment(value)) {
    if (displayWidth(fitted + segment + '…') > columns) break;
    fitted += segment;
  }
  return `${fitted}…`;
}

// The summary names a useful destination while the original serialized arguments remain available in detail view.
export function toolCallSummary(serializedArguments: string, columns = 80, locale: Locale = 'en'): ToolCallPreview {
  let value: unknown;
  try {
    value = JSON.parse(serializedArguments);
  } catch {
    return { summary: localized(locale, '参数无法摘要', 'arguments not summarized'), hasDetails: serializedArguments !== '' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { summary: '', hasDetails: serializedArguments !== '' && serializedArguments !== 'null' };
  const args = value as Record<string, unknown>;
  const parts = TARGET_KEYS.flatMap((key) => {
    const entry = args[key];
    if (typeof entry === 'string' && entry !== '') return [`${key}: ${safeSummaryValue(entry)}`];
    if (Array.isArray(entry) && entry.every((part) => typeof part === 'string')) return [`${key}: ${safeSummaryValue(entry.join(', '))}`];
    return [];
  });
  const unknownCount = Object.keys(args).filter((key) => !TARGET_KEYS.includes(key as typeof TARGET_KEYS[number])).length;
  const omittedTargets = Math.max(0, parts.length - 2);
  const summary = parts.slice(0, 2).join(' · ');
  const fallback = summary === '' && Object.keys(args).length > 0
    ? localized(locale, `${Object.keys(args).length} 个参数字段`, `${Object.keys(args).length} argument field${Object.keys(args).length === 1 ? '' : 's'}`) : summary;
  const tail = [unknownCount > 0 && summary !== '' ? localized(locale, `另有 ${unknownCount} 个字段`, `+${unknownCount} other field${unknownCount === 1 ? '' : 's'}`) : '',
    omittedTargets > 0 ? localized(locale, `另有 ${omittedTargets} 个目标`, `+${omittedTargets} more target${omittedTargets === 1 ? '' : 's'}`) : ''].filter(Boolean).join(' · ');
  const combined = [fallback, tail].filter(Boolean).join(' · ');
  let fitted = '';
  for (const { segment } of graphemes.segment(combined)) {
    if (displayWidth(fitted + segment + '…') > columns) break;
    fitted += segment;
  }
  return {
    summary: fitted.length === combined.length ? combined : `${fitted}…`,
    hasDetails: Object.keys(args).length > 0,
  };
}

export function foldTextForColumns(text: unknown, expanded: boolean, columns: number, limit = 3, maxChars = 400): FoldedText {
  return foldTextByColumns(text, expanded, limit, maxChars, Math.max(1, columns));
}

export function classifyToolFailure(code: string | undefined): 'cancelled' | 'unavailable' | 'failure' {
  if (code?.endsWith('_cancelled') === true) return 'cancelled';
  if (code?.endsWith('_unavailable') === true || code?.endsWith('_missing') === true) return 'unavailable';
  return 'failure';
}
