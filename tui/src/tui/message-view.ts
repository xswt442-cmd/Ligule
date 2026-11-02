import { createElement as h, Fragment, useMemo } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { textOf as chooseText, type Locale } from '@ligule/core/tui.js';
import { displayWidth } from './commands.js';
import type { MarkdownLine } from './markdown.js';
import { markdownLines } from './markdown.js';
import { classifyToolFailure, clipToWidth, foldTextForColumns, toolCallSummary } from './message-format.js';
import type { TranscriptItem } from './transcript.js';
import { TUI_COLORS } from './ui-style.js';
import { keyHint } from './keymap.js';

const MARK_STYLES: Readonly<Record<string, { readonly bold?: boolean; readonly italic?: boolean; readonly strikethrough?: boolean; readonly color?: string }>> = {
  'md-strong': { bold: true },
  'md-em': { italic: true },
  'md-del': { strikethrough: true, color: TUI_COLORS.muted },
  'md-codespan': { color: TUI_COLORS.info },
};

const CODE_COLORS: Readonly<Record<string, string>> = {
  keyword: TUI_COLORS.info,
  string: TUI_COLORS.success,
  number: TUI_COLORS.warning,
  comment: TUI_COLORS.muted,
  title: TUI_COLORS.accent,
  literal: TUI_COLORS.warning,
  built_in: TUI_COLORS.info,
};

export interface MarkdownRowsProps {
  readonly text: string;
  readonly columns?: number;
}

export function MarkdownRows({ text, columns = 80 }: MarkdownRowsProps): ReactElement {
  const lines = useMemo(() => markdownLines(text, columns), [text, columns]);
  const marked = (line: MarkdownLine) => line.spans?.map((span, part) => h(Text, { key: part, ...(span.scope === undefined ? {} : MARK_STYLES[span.scope] ?? {}) }, span.text)) ?? [];
  return h(Fragment, null, lines.map((line, index) => {
    if (line.kind === 'code') return h(Text, { key: index, wrap: 'wrap' }, '  ', line.spans === undefined ? line.text : line.spans.map((span, part) => {
      const scope = span.scope?.split('.')[0];
      return h(Text, { key: part, color: scope === undefined ? undefined : CODE_COLORS[scope] }, span.text);
    }));
    if (line.kind === 'heading') return h(Text, { key: index, bold: true, wrap: 'wrap' }, line.spans === undefined ? line.text : marked(line));
    if (line.spans !== undefined) return h(Text, { key: index, wrap: 'wrap' }, marked(line));
    return h(Text, { key: index, wrap: 'wrap' }, line.text);
  }));
}

export interface MessageRowProps {
  readonly row: TranscriptItem;
  readonly expanded: boolean;
  readonly columns: number;
  readonly locale?: Locale;
}

function previewHint(hidden: number, locale: Locale, subject?: string): string | null {
  if (hidden === 0) return null;
  return chooseText(locale, `  …还有 ${hidden} 字 · ${keyHint('expand-or-history')} 查看完整${subject ?? '记录'}`, `  …${hidden} more characters · ${keyHint('expand-or-history')} for full ${subject ?? 'record'}`);
}

// 成功结果的收敛阈值：行数少且每行都能排在窗口里，就只留一行摘要；
// 长输出或宽行仍给有界预览，免得把内容挤没。
const SHORT_RESULT_LINES = 12;

function fitsOneSummary(text: string, columns: number): boolean {
  if (text === '') return true;
  const lines = text.split('\n');
  return lines.length <= SHORT_RESULT_LINES && lines.every((line) => displayWidth(line) <= columns);
}

function targetSuffix(target: string | undefined, base: string, columns: number): string {
  if (target === undefined || target === '') return '';
  const budget = columns - displayWidth(base) - 1;
  return budget < 8 ? '' : ` ${clipToWidth(target, budget)}`;
}

export function MessageRow({ row, expanded, columns, locale = 'zh' }: MessageRowProps): ReactElement {
  const t = (zh: string, en: string) => chooseText(locale, zh, en);
  if (row.kind === 'question') return h(Box, { marginBottom: 1 }, h(Text, { color: TUI_COLORS.accent, wrap: 'wrap' }, row.source === 'controller'
    ? `← ${t('外部 Agent', 'External agent')}: ${row.text}`
    : `› ${row.text}`));
  if (row.kind === 'reasoning') {
    const prefix = t('· 推理 ', '· Reasoning ');
    const folded = foldTextForColumns(row.text, expanded, Math.max(1, columns - displayWidth(prefix)), 1);
    return h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: TUI_COLORS.muted, wrap: 'wrap' }, `${prefix}${folded.shown}`),
      previewHint(folded.hidden, locale) === null ? null : h(Text, { color: TUI_COLORS.muted, wrap: 'wrap' }, previewHint(folded.hidden, locale, t('推理', 'reasoning'))));
  }
  if (row.kind === 'answer') return h(Box, { flexDirection: 'column', marginBottom: 1 }, h(MarkdownRows, { text: row.text, columns }));
  if (row.kind === 'call') {
    const tool = row.tool ?? t('工具调用', 'Tool call');
    const summary = toolCallSummary(row.text, Math.max(1, columns - displayWidth(`→ ${tool} · `)), locale);
    const details = foldTextForColumns(row.text, expanded, columns, 3);
    const hint = summary.hasDetails ? chooseText(locale, `  · ${keyHint('expand-or-history')} 查看完整参数`, `  · ${keyHint('expand-or-history')} for full arguments`) : null;
    return h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: TUI_COLORS.info, wrap: 'wrap' }, `→ ${tool}${expanded ? '' : summary.summary === '' ? '' : ` · ${summary.summary}`}`),
      expanded ? h(Text, { wrap: 'wrap' }, details.shown) : null,
      hint === null ? null : h(Text, { color: TUI_COLORS.muted, wrap: 'wrap' }, hint));
  }
  if (row.kind === 'result') {
    const tool = row.tool ?? t('工具结果', 'Tool result');
    const lineCount = row.text === '' ? 0 : row.text.split('\n').length;
    const note = [
      row.exitCode === undefined ? '' : t(`退出码 ${row.exitCode}`, `exit ${row.exitCode}`),
      row.spilled === undefined ? '' : t(`完整结果 ${row.spilled}`, `full result ${row.spilled}`),
      lineCount > 1 ? t(`${lineCount} 行`, `${lineCount} lines`) : '',
    ].filter(Boolean).join(' · ');
    const head = `✓ ${tool}`;
    const tail = note === '' ? '' : ` · ${note}`;
    const header = `${head}${targetSuffix(row.target, `${head}${tail}`, columns)}${tail}`;
    // 成功且短：工具、对象、行数压成一行；完整内容仍可用 Ctrl+O 查看。
    if (!expanded && fitsOneSummary(row.text, columns)) {
      return h(Box, { marginBottom: 1 }, h(Text, { color: TUI_COLORS.success, wrap: 'wrap' }, header));
    }
    const folded = foldTextForColumns(row.text, expanded, columns, 3);
    return h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: TUI_COLORS.success, wrap: 'wrap' }, header),
      folded.shown === '' ? null : h(Text, { wrap: 'wrap' }, folded.shown),
      previewHint(folded.hidden, locale, t('结果', 'result')) === null ? null : h(Text, { color: TUI_COLORS.muted, wrap: 'wrap' }, previewHint(folded.hidden, locale, t('结果', 'result'))));
  }
  if (row.kind === 'refusal' || row.kind === 'failure') {
    const state = classifyToolFailure(row.code);
    const isRefusal = row.kind === 'refusal' && state === 'failure';
    const folded = foldTextForColumns(row.text, expanded, columns, 3);
    const hint = previewHint(folded.hidden, locale);
    const label = isRefusal ? t('拒绝请求', 'refused the request') : state === 'cancelled' ? t('已取消', 'cancelled') : state === 'unavailable' ? t('不可用', 'unavailable') : t('失败', 'failed');
    const head = `${isRefusal ? '⚑' : state === 'cancelled' ? '↷' : state === 'unavailable' ? '◌' : '✗'} ${row.tool ?? t('工具', 'Tool')}`;
    const tail = `${label}${row.code === undefined ? '' : ` (${row.code})`}`;
    // 失败不收缩：错误码和原因留在原地，必要时用 Ctrl+O 看完整记录。
    return h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: isRefusal ? TUI_COLORS.warning : state === 'failure' ? TUI_COLORS.error : TUI_COLORS.muted, wrap: 'wrap' }, `${head}${targetSuffix(row.target, `${head} ${tail}`, columns)} ${tail}`),
      folded.shown === '' ? null : h(Text, { wrap: 'wrap' }, folded.shown),
      hint === null ? null : h(Text, { color: TUI_COLORS.muted, wrap: 'wrap' }, hint));
  }
  if (row.kind === 'meta') return h(Text, { color: TUI_COLORS.muted, wrap: 'wrap' }, `· ${row.text}`);
  return h(Box, { marginBottom: 1 }, h(Text, { color: TUI_COLORS.error, wrap: 'wrap' }, `! ${row.text}`));
}
