import { createElement, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Text, useInput, usePaste } from 'ink';
import { textOf, type Locale, type SessionSummary } from '@ligule/core/tui.js';
import { editDraft } from './draft.js';
import { hit, keyHint } from './keymap.js';
import { PanelFrame } from './panels.js';
import { TUI_COLORS } from './ui-style.js';

export interface SessionPickerProps {
  readonly items: readonly SessionSummary[];
  readonly current: string;
  readonly locale: Locale;
  readonly height: number;
  readonly columns: number;
  readonly running: boolean;
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
  readonly interactive?: boolean;
  readonly active?: boolean;
}

function matches(session: SessionSummary, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLocaleLowerCase();
  return [session.name, session.id, session.mode?.name ?? '']
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

function sessionLabel(session: SessionSummary, locale: Locale, current: string): string {
  const unnamed = textOf(locale, '未命名', 'Unnamed');
  const archived = session.archived ? textOf(locale, '已归档', 'archived') : '';
  const currentLabel = session.id === current ? textOf(locale, '当前', 'current') : '';
  const time = session.updatedAt.slice(0, 19).replace('T', ' ');
  const title = session.name === '' ? unnamed : session.name;
  const markers = [archived, currentLabel].filter(Boolean).join(' · ');
  return `${title} · ${session.id.slice(0, 8)}  ${time}${markers === '' ? '' : `  ${markers}`}`;
}

function sessionDetail(session: SessionSummary, locale: Locale): string | undefined {
  if (session.error !== undefined) {
    return textOf(locale, `无法恢复：${session.error.code}`, `Cannot resume: ${session.error.code}`);
  }
  if (session.archived) return textOf(locale, '已归档；仍可恢复', 'Archived; can still be resumed');
  return undefined;
}

export function SessionPicker({
  items,
  current,
  locale,
  height,
  columns,
  running,
  onClose,
  onSelect,
  interactive = true,
  active = true,
}: SessionPickerProps): ReactElement | null {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(current);
  useEffect(() => {
    if (!active) { setQuery(''); setSelectedId(current); }
  }, [active, current]);
  const filtered = items.filter((item) => matches(item, query));
  const selectedIndex = Math.max(0, filtered.findIndex((item) => item.id === selectedId));
  const selected = filtered[selectedIndex];
  const maxRows = Math.max(0, Math.floor(height));
  const contentHeight = maxRows === 0 ? 0 : maxRows <= 2 ? 1 : maxRows - 2;
  const start = Math.max(0, Math.min(selectedIndex, filtered.length - contentHeight));
  const visible = filtered.slice(start, start + contentHeight);
  const selectedVisible = selected !== undefined && visible.some((item) => item.id === selected.id);
  const t = (zh: string, en: string) => textOf(locale, zh, en);

  useInput((input, key) => {
    if (!active) return;
    if (hit('list-close', input, key)) {
      onClose();
      return;
    }
    if (hit('list-open', input, key)) {
      if (!running && selectedVisible && selected.error === undefined) onSelect(selected.id);
      return;
    }

    const step = hit('list-up', input, key) ? -1
      : hit('list-down', input, key) ? 1
        : hit('list-page-up', input, key) ? -Math.max(1, contentHeight)
          : hit('list-page-down', input, key) ? Math.max(1, contentHeight)
            : null;
    if (hit('list-first', input, key)) {
      if (filtered[0] !== undefined) setSelectedId(filtered[0].id);
      return;
    }
    if (hit('list-last', input, key)) {
      if (filtered.at(-1) !== undefined) setSelectedId(filtered.at(-1)!.id);
      return;
    }
    if (step !== null) {
      const index = Math.max(0, Math.min(filtered.length - 1, selectedIndex + step));
      if (filtered[index] !== undefined) setSelectedId(filtered[index].id);
      return;
    }
    if (key.backspace) {
      setQuery((value) => editDraft(value, value.length, '', { backspace: true }).draft);
      return;
    }
    if (input !== '' && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab) {
      setQuery((value) => editDraft(value, value.length, input, {}).draft);
    }
  }, { isActive: interactive });

  usePaste((text) => {
    if (!active) return;
    const pasted = text.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ');
    if (pasted !== '') setQuery((value) => editDraft(value, value.length, pasted, {}).draft);
  }, { isActive: interactive });

  const summary = t(`${query || '搜索'} · ${filtered.length}/${items.length} 份`, `${query || 'Search'} · ${filtered.length}/${items.length} sessions`);
  const hint = running
    ? t(`运行中不可恢复 · ${keyHint('list-close')} 关闭`, `Resume unavailable while running · ${keyHint('list-close')} close`)
    : t(`${keyHint('list-up', 'list-down')} 选择 · ${keyHint('list-page-up', 'list-page-down')} 翻页 · ${keyHint('list-first', 'list-last')} 首尾 · ${keyHint('list-open')} 恢复 · ${keyHint('list-close')} 关闭`, `${keyHint('list-up', 'list-down')} select · ${keyHint('list-page-up', 'list-page-down')} page · ${keyHint('list-first', 'list-last')} ends · ${keyHint('list-open')} resume · ${keyHint('list-close')} close`);
  const status = running
    ? t('当前轮次结束后才能恢复会话', 'Finish the current turn before resuming a session')
    : selected === undefined
      ? t('没有匹配的会话', 'No matching sessions')
      : [selected.id === current ? t('当前会话', 'Current session') : '', sessionDetail(selected, locale)].filter(Boolean).join(' · ');

  const footer = [status, hint].filter((part): part is string => part !== undefined).join(' · ');

  if (!active) return null;
  return createElement(PanelFrame, { width: Math.max(1, columns) },
    ...(maxRows < 2 ? [] : [createElement(Text, { key: 'heading', bold: true, color: TUI_COLORS.accent, wrap: 'truncate-end' }, summary)]),
    ...visible.map((item) => {
      const isSelected = item.id === selected?.id;
      const label = sessionLabel(item, locale, current);
      return createElement(Text, {
        key: item.id,
        bold: isSelected,
        color: isSelected ? TUI_COLORS.accent : undefined,
        wrap: 'truncate-end',
      }, `${isSelected ? '›' : ' '} ${label}`);
    }),
    ...(maxRows > 0 && maxRows <= 2 && selected === undefined
      ? [createElement(Text, { key: 'empty', color: TUI_COLORS.muted, wrap: 'truncate-end' }, status ?? t('没有匹配的会话', 'No matching sessions'))]
      : []),
    ...(maxRows > 2 ? [createElement(Text, { key: 'footer', color: TUI_COLORS.muted, wrap: 'truncate-end' }, footer)] : []),
  );
}
