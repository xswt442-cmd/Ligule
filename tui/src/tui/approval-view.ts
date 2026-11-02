import { createElement } from 'react';
import type { ReactElement } from 'react';
import { Text } from 'ink';
import type { Locale } from '@ligule/core/tui.js';
import { displayWidth } from './commands.js';
import { keyHint } from './keymap.js';
import { PanelFrame } from './panels.js';
import { TUI_COLORS } from './ui-style.js';
import { viewportPosition, wrapLine } from './viewport.js';

export interface ApprovalDisplay {
  readonly tool: string;
  readonly detail: string;
  readonly change: string;
  readonly backend: string;
  readonly reason: string;
  readonly content: string;
  readonly rememberable: boolean;
  readonly rememberScopes: readonly ('session' | 'project' | 'user')[];
  readonly rememberHintKey: 'file' | 'tool' | 'command' | 'mcp' | '';
  readonly rememberTargetOptions: readonly ('file' | 'workspace' | 'tool' | 'command')[];
  readonly rememberTarget?: 'file' | 'workspace' | 'tool' | 'command';
  readonly identityDigest?: string;
  readonly detailsSummary?: string;
  readonly detailsLoading?: boolean;
  readonly detailsError?: string;
}

export interface ApprovalLayout {
  readonly titleLines: readonly string[];
  readonly targetLines: readonly string[];
  readonly scopeLines: readonly string[];
  readonly actionLines: readonly string[];
  readonly warningLines: readonly string[];
  readonly bodyLines: readonly string[];
  readonly bodyFooter: string;
  readonly bodyHeight: number;
  readonly canApprove: boolean;
  readonly columns: number;
}

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

function lines(value: string, columns: number): string[] {
  return value === '' ? [] : wrapLine(value, columns);
}

function packActions(actions: readonly string[], columns: number): string[] {
  const rows: string[] = [];
  let current = '';
  for (const action of actions) {
    const combined = current === '' ? action : `${current} · ${action}`;
    if (displayWidth(combined) <= columns) {
      current = combined;
      continue;
    }
    if (current !== '') rows.push(current);
    const wrapped = wrapLine(action, columns);
    rows.push(...wrapped.slice(0, -1));
    current = wrapped.at(-1) ?? '';
  }
  if (current !== '') rows.push(current);
  return rows;
}

function rememberRange(ask: ApprovalDisplay, locale: Locale): string | undefined {
  if (!ask.rememberable || ask.rememberHintKey === '') return undefined;
  if (ask.rememberHintKey === 'file') {
    return ask.rememberTarget === 'workspace'
      ? text(locale, '记忆范围：此工作区内同类文件操作', 'Remember: this file operation type in this workspace')
      : text(locale, '记忆范围：仅此文件', 'Remember: this file only');
  }
  if (ask.rememberHintKey === 'command') {
    return text(locale, '记忆范围：此命令及其精确参数边界', 'Remember: this exact command and argument boundary');
  }
  if (ask.rememberHintKey === 'mcp') {
    const digest = ask.identityDigest?.slice(0, 12) ?? text(locale, '未知', 'unavailable');
    return text(locale,
      `记忆范围：同一 MCP 工具、参数及服务器配置摘要 ${digest}`,
      `Remember: same MCP tool, arguments, and server configuration digest ${digest}`);
  }
  return text(locale, '记忆范围：此工具能力的全部参数', 'Remember: all arguments for this tool capability');
}

function bodySummary(ask: ApprovalDisplay, locale: Locale, includeDetailsSummary: boolean): string[] {
  return [
    ask.change,
    ask.backend === '' ? '' : text(locale, `执行环境：${ask.backend}`, `Execution environment: ${ask.backend}`),
    ask.reason === '' ? '' : text(locale, `原因：${ask.reason}`, `Reason: ${ask.reason}`),
    includeDetailsSummary ? ask.detailsSummary ?? '' : '',
    ask.detailsLoading ? text(locale, '正在读取完整待审批内容…', 'Loading the full pending content…') : '',
    ask.detailsError === undefined ? '' : text(locale, `完整内容读取失败：${ask.detailsError}`, `Could not read full details: ${ask.detailsError}`),
  ].filter((value) => value !== '');
}

export function buildApprovalLayout(
  ask: ApprovalDisplay,
  expanded: boolean,
  columns: number,
  rows: number,
  locale: Locale,
  rememberOpen = false,
): ApprovalLayout {
  const contentColumns = Math.max(1, Math.floor(columns) - 3);
  const lineCount = Math.max(0, Math.floor(rows));
  const titleLines = wrapLine(text(locale, `允许执行 ${ask.tool}？`, `Allow ${ask.tool}?`), contentColumns);
  const missingTarget = ask.detail.trim() === '';
  const targetText = missingTarget
    ? text(locale, `目标未提供 · 工具：${ask.tool}`, `Target not provided · Tool: ${ask.tool}`)
    : text(locale, '目标：', 'Target: ') + ask.detail;
  const targetLines = wrapLine(targetText, contentColumns);
  // 记住规则收在第二层：默认只留按 m 的入口，展开后才显示记忆范围与规则选项。
  const range = rememberOpen ? rememberRange(ask, locale) : undefined;
  const scopeLines = range === undefined ? [] : wrapLine(range, contentColumns);
  const rememberable = ask.rememberable;
  const allowAction = rememberable
    ? text(locale, '1 允许一次', '1 Allow once')
    : `${keyHint('approve')} ${text(locale, '允许一次', 'Allow once')}`;
  const rememberChoices = rememberable ? ask.rememberScopes.map((scope, index) => {
    const label = scope === 'session' ? text(locale, '记住本会话', 'Remember this session')
      : scope === 'project' ? text(locale, '记住本项目', 'Remember this project')
        : text(locale, '记住所有项目', 'Remember all projects');
    return `${index + 2} ${label}`;
  }) : [];
  const scopeToggle = rememberable && ask.rememberTargetOptions.includes('file') && ask.rememberTargetOptions.includes('workspace')
    ? [text(locale, 'w 切换文件/工作区范围', 'w switch file/workspace scope')]
    : [];
  const rememberToggle = rememberable
    ? [`${keyHint('approval-remember')} ${rememberOpen ? text(locale, '收起记住选项', 'hide remember choices') : text(locale, '记住规则…', 'remember rule…')}`]
    : [];
  const denyAction = `${keyHint('deny')} ${text(locale, '拒绝', 'Deny')}`;
  const detailAction = `${keyHint('expand-or-history')} ${text(locale, '查看详情', 'View details')}`;
  const cancelAction = `${keyHint('approval-cancel')} ${text(locale, '取消本轮', 'Cancel this turn')}`;
  const actions = rememberOpen && rememberable
    ? [allowAction, ...rememberChoices, ...scopeToggle, ...rememberToggle, denyAction, detailAction, cancelAction]
    : [allowAction, denyAction, detailAction, cancelAction, ...rememberToggle];
  const actionLines = packActions(actions, contentColumns);
  const summary = bodySummary(ask, locale, !expanded);
  const bodyText = expanded
    ? [...summary, ...(ask.content === '' ? [] : [ask.content])].join('\n\n')
    : [...summary, ...(missingTarget && ask.content !== '' ? [ask.content] : [])].join('\n\n');
  const bodyLines = lines(bodyText, contentColumns);
  const fixedLineCount = titleLines.length + targetLines.length + scopeLines.length + actionLines.length;
  const bodyFooter = bodyLines.length === 0 ? '' : text(locale,
    `改动 {current}/{total} 行 · ${keyHint('approval-page-up', 'approval-page-down')} 分页 · ${keyHint('approval-top', 'approval-bottom')} 到两端`,
    `Changes {current}/{total} lines · ${keyHint('approval-page-up', 'approval-page-down')} pages · ${keyHint('approval-top', 'approval-bottom')} start/end`);
  const footerHeight = bodyFooter === '' ? 0 : wrapLine(bodyFooter
    .replaceAll('{current}', String(bodyLines.length))
    .replaceAll('{total}', String(bodyLines.length)), contentColumns).length;
  const bodyHeight = Math.max(0, lineCount - fixedLineCount - footerHeight);
  const bodyFits = bodyLines.length === 0 || bodyHeight >= 1 && footerHeight >= 1;
  const canApprove = fixedLineCount <= lineCount && bodyFits;
  if (!canApprove) {
    return {
      titleLines: [],
      targetLines: [],
      scopeLines: [],
      actionLines: [
        denyAction,
        cancelAction,
        ...(rememberOpen && rememberable ? rememberToggle : []),
      ],
      warningLines: wrapLine(text(locale, '请放大窗口后再审批。', 'Enlarge window to review.'), contentColumns),
      bodyLines,
      bodyFooter: '',
      bodyHeight: 0,
      canApprove: false,
      columns: Math.max(1, Math.floor(columns)),
    };
  }
  return {
    titleLines,
    targetLines,
    scopeLines,
    actionLines,
    warningLines: [],
    bodyLines,
    bodyFooter,
    bodyHeight,
    canApprove: true,
    columns: Math.max(1, Math.floor(columns)),
  };
}

export interface ApprovalPanelProps {
  readonly layout: ApprovalLayout;
  readonly cursor: number;
}

export function ApprovalPanel({ layout, cursor }: ApprovalPanelProps): ReactElement {
  const position = viewportPosition(cursor, layout.bodyLines.length, layout.bodyHeight);
  const bodyVisible = layout.bodyHeight > 0
    ? layout.bodyLines.slice(position.offset, position.offset + layout.bodyHeight)
    : [];
  const bodyFooterLines = layout.bodyFooter === '' ? [] : wrapLine(layout.bodyFooter
    .replace('{current}', String(position.cursor + 1))
    .replace('{total}', String(layout.bodyLines.length)), Math.max(1, layout.columns - 3));
  return createElement(PanelFrame, { width: layout.columns, tone: 'warning' },
    ...layout.titleLines.map((line, index) => createElement(Text, { key: `title:${index}`, bold: true, color: TUI_COLORS.warning }, line)),
    ...layout.targetLines.map((line, index) => createElement(Text, { key: `target:${index}` }, line)),
    ...layout.scopeLines.map((line, index) => createElement(Text, { key: `scope:${index}`, color: TUI_COLORS.info }, line)),
    ...layout.warningLines.map((line, index) => createElement(Text, { key: `warning:${index}`, bold: true, color: TUI_COLORS.warning }, line)),
    ...bodyVisible.map((line, index) => createElement(Text, { key: `body:${position.offset + index}`, wrap: 'truncate-end' }, line)),
    ...(bodyVisible.length === 0 ? [] : bodyFooterLines.map((line, index) => createElement(Text, { key: `body-footer:${index}`, color: TUI_COLORS.muted }, line))),
    ...layout.actionLines.map((line, index) => createElement(Text, { key: `action:${index}` }, line)),
  );
}
