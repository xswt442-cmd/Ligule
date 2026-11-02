// 历史浏览的光标与选择只存在于界面；窗口按终端列数换行后再分页。
import { markdownLines } from './markdown.js';
import { displayWidth } from './commands.js';
import { textOf, type Locale } from '@ligule/core/tui.js';

export interface TranscriptRow {
  readonly kind: string;
  readonly text: string;
  readonly tool?: string;
  readonly code?: string;
  readonly seq?: number;
  readonly spilled?: string;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function wrapLine(text: string, columns: number): string[] {
  const lines: string[] = [''];
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (segment === '\n') { lines.push(''); width = 0; continue; }
    const size = displayWidth(segment);
    if (width + size > Math.max(1, columns) && lines.at(-1) !== '') {
      lines.push('');
      width = 0;
    }
    lines[lines.length - 1] += segment;
    width += size;
  }
  return lines;
}

export function transcriptLines(rows: readonly TranscriptRow[], columns: number, locale: Locale = 'zh'): string[] {
  const t = (zh: string, en: string) => textOf(locale, zh, en);
  return rows.flatMap((row) => {
    const identity = row.seq === undefined ? '' : t(`第 ${row.seq} 条 · `, `#${row.seq} · `);
    const label = row.tool ?? ({ question: t('你', 'You'), answer: t('助手', 'Assistant'), reasoning: t('推理', 'Reasoning'), meta: t('状态', 'Status') }[row.kind] ?? row.kind);
    const heading = `${identity}${label}${row.code === undefined ? '' : ` · ${row.code}`}`;
    const content = row.kind === 'answer'
      ? markdownLines(row.text, columns).map((line) => line.text).join('\n')
      : row.text;
    return [...wrapLine(heading, columns), ...wrapLine(content, columns), ...(row.spilled === undefined ? [] : wrapLine(t(`完整结果文件：${row.spilled}`, `Full result file: ${row.spilled}`), columns)), ''];
  });
}

export function viewportPosition(cursor: number, count: number, height: number, offset = 0): { cursor: number; offset: number } {
  const selected = Math.max(0, Math.min(cursor, count - 1));
  const start = selected < offset ? selected : selected >= offset + height ? selected - height + 1 : offset;
  return { cursor: selected, offset: Math.max(0, Math.min(start, Math.max(0, count - height))) };
}

export function selectedText(lines: readonly string[], cursor: number, anchor: number | null): string {
  const start = anchor === null ? cursor : Math.min(anchor, cursor);
  const end = anchor === null ? cursor : Math.max(anchor, cursor);
  return lines.slice(start, end + 1).join('\n');
}
