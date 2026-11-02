import { createElement, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Locale } from '@ligule/core/tui.js';
import { hit, keyHint } from './keymap.js';
import { HELP_TABS, helpEntries, helpTabTitle, type HelpTab } from './help.js';
import type { TemplateCommand } from './commands.js';
import { wrapLine } from './viewport.js';
import { TUI_COLORS, type TuiColorRole } from './ui-style.js';

export interface PanelFrameProps {
  readonly children?: ReactNode;
  readonly tone?: TuiColorRole;
  readonly width?: number;
}

export function PanelFrame({ children, tone = 'accent', width }: PanelFrameProps): ReactElement {
  return createElement(Box, {
    flexDirection: 'column',
    ...(width === undefined ? {} : { width: Math.max(1, width) }),
    borderStyle: 'single',
    borderTop: false,
    borderBottom: false,
    borderLeft: true,
    borderRight: false,
    borderColor: TUI_COLORS[tone],
    paddingX: 1,
  }, children);
}

type HelpPanelProps = {
  readonly templates: readonly TemplateCommand[];
  readonly locale: Locale;
  readonly columns: number;
  readonly height: number;
  readonly onClose: () => void;
  readonly active?: boolean;
  readonly interactive?: boolean;
};

function boundedOffset(offset: number, count: number, height: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, count - height)));
}

function wrapHelpEntries(tab: HelpTab, templates: readonly TemplateCommand[], locale: Locale, columns: number): string[] {
  return helpEntries(tab, templates, locale).flatMap((entry) => {
    const line = entry.description === '' ? entry.key : `${entry.key}  ${entry.description}`;
    return wrapLine(line, Math.max(1, columns));
  });
}

export function HelpPanel({ templates, locale, columns, height, onClose, active = true, interactive = true }: HelpPanelProps): ReactElement | null {
  const [tabIndex, setTabIndex] = useState(0);
  const tab = HELP_TABS[tabIndex] ?? HELP_TABS[0];
  const rows = wrapHelpEntries(tab, templates, locale, Math.max(1, columns - 3));
  const pageHeight = Math.max(1, height);
  const [offset, setOffset] = useState(0);
  const visibleOffset = boundedOffset(offset, rows.length, pageHeight);

  useInput((input, key) => {
    if (!active) return;
    if (hit('panel-close', input, key)) {
      onClose();
      return;
    }
    if (hit('panel-left', input, key)) {
      setTabIndex((current) => (current + HELP_TABS.length - 1) % HELP_TABS.length);
      setOffset(0);
      return;
    }
    if (hit('panel-right', input, key)) {
      setTabIndex((current) => (current + 1) % HELP_TABS.length);
      setOffset(0);
      return;
    }
    if (hit('panel-up', input, key)) setOffset((current) => boundedOffset(current - 1, rows.length, pageHeight));
    else if (hit('panel-down', input, key)) setOffset((current) => boundedOffset(current + 1, rows.length, pageHeight));
    else if (hit('panel-page-up', input, key)) setOffset((current) => boundedOffset(current - pageHeight, rows.length, pageHeight));
    else if (hit('panel-page-down', input, key)) setOffset((current) => boundedOffset(current + pageHeight, rows.length, pageHeight));
  }, { isActive: interactive });

  const hint = locale === 'zh'
    ? `${keyHint('panel-left', 'panel-right')} 切换分类 · ${keyHint('panel-up', 'panel-down')} 移动 · ${keyHint('panel-page-up', 'panel-page-down')} 翻页 · ${keyHint('panel-close')} 关闭`
    : `${keyHint('panel-left', 'panel-right')} categories · ${keyHint('panel-up', 'panel-down')} move · ${keyHint('panel-page-up', 'panel-page-down')} pages · ${keyHint('panel-close')} close`;

  if (!active) return null;
  return createElement(PanelFrame, { width: columns },
    createElement(Box, { flexDirection: 'row' }, ...HELP_TABS.map((item, index) => createElement(Text, {
      key: item,
      bold: index === tabIndex,
      color: index === tabIndex ? TUI_COLORS.accent : undefined,
    }, `${index === tabIndex ? '›' : ' '} ${helpTabTitle(item, locale)}${index === HELP_TABS.length - 1 ? '' : '  '}`))),
    ...rows.slice(visibleOffset, visibleOffset + pageHeight).map((line, index) =>
      createElement(Text, { key: `${visibleOffset + index}`, wrap: 'truncate-end' }, line)),
    createElement(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, hint),
  );
}

export type PanelChoice = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};

type ChoicePanelProps = {
  readonly title: string;
  readonly options: readonly PanelChoice[];
  readonly selected?: string;
  readonly locale: Locale;
  readonly height: number;
  readonly onClose: () => void;
  readonly onSelect: (choice: PanelChoice) => void;
  readonly loading?: boolean;
  readonly columns?: number;
  readonly active?: boolean;
  readonly interactive?: boolean;
};

export function ChoicePanel({ title, options, selected, locale, height, onClose, onSelect, loading = false, columns = 80, active = true, interactive = true }: ChoicePanelProps): ReactElement | null {
  const [cursorId, setCursorId] = useState<string>();
  const indexOfCursor = options.findIndex(option => option.id === cursorId);
  const selectedIndex = indexOfCursor >= 0 ? indexOfCursor : Math.max(0, options.findIndex(option => option.id === selected));
  useEffect(() => { if (!active) setCursorId(undefined); }, [active]);
  const pageHeight = Math.max(1, height);

  useInput((input, key) => {
    if (!active) return;
    if (hit('panel-close', input, key)) {
      setCursorId(undefined);
      onClose();
      return;
    }
    if (options.length === 0) return;
    if (hit('panel-up', input, key)) setCursorId(options[Math.max(0, selectedIndex - 1)]?.id);
    else if (hit('panel-down', input, key)) setCursorId(options[Math.min(options.length - 1, selectedIndex + 1)]?.id);
    else if (hit('panel-page-up', input, key)) setCursorId(options[Math.max(0, selectedIndex - pageHeight)]?.id);
    else if (hit('panel-page-down', input, key)) setCursorId(options[Math.min(options.length - 1, selectedIndex + pageHeight)]?.id);
    else if (hit('panel-select', input, key) && !loading) {
      const choice = options[selectedIndex];
      if (choice !== undefined) { setCursorId(undefined); onSelect(choice); }
    }
  }, { isActive: interactive });

  const contentColumns = Math.max(1, columns - 3);
  const allRows = options.flatMap((option, optionIndex) => {
    const isSelected = optionIndex === selectedIndex;
    const labelRows = wrapLine(option.label, Math.max(1, contentColumns - 2)).map((text) => ({ text, optionIndex, description: false }));
    const detailRows = isSelected && option.description !== undefined
      ? wrapLine(`  ${option.description}`, contentColumns).map((text) => ({ text, optionIndex, description: true }))
      : [];
    return [...labelRows, ...detailRows];
  });
  const selectedStart = allRows.findIndex((row) => row.optionIndex === selectedIndex);
  const start = boundedOffset(selectedStart, allRows.length, pageHeight);
  const visibleRows = allRows.slice(start, start + pageHeight);
  const status = loading
    ? (locale === 'zh' ? '正在读取…' : 'Loading…')
    : options.length === 0
      ? (locale === 'zh' ? '没有可选项' : 'No options available')
      : '';
  const hint = locale === 'zh'
    ? `${keyHint('panel-up', 'panel-down', 'panel-page-up', 'panel-page-down')} 选择 · ${keyHint('panel-select')} 确认 · ${keyHint('panel-close')} 关闭`
    : `${keyHint('panel-up', 'panel-down', 'panel-page-up', 'panel-page-down')} select · ${keyHint('panel-select')} confirm · ${keyHint('panel-close')} close`;

  if (!active) return null;
  return createElement(PanelFrame, { width: columns, tone: loading ? 'warning' : 'accent' },
    createElement(Text, { bold: true, wrap: 'truncate-end' }, title),
    ...visibleRows.map((row, index) => {
      const rowIndex = start + index;
      const isSelected = row.optionIndex === selectedIndex;
      return createElement(Text, {
        key: `${rowIndex}`,
        wrap: 'truncate-end',
        color: isSelected ? row.description ? TUI_COLORS.muted : TUI_COLORS.accent : undefined,
        bold: isSelected && !row.description,
      }, row.description ? row.text : `${isSelected ? '›' : ' '} ${row.text}`);
    }),
    ...(status === '' ? [] : [createElement(Text, { key: 'status', color: TUI_COLORS.muted }, status)]),
    createElement(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, hint),
  );
}
