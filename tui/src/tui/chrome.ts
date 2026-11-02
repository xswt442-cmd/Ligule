import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { textOf, type Locale } from '@ligule/core/tui.js';
import { displayWidth } from './commands.js';
import { keyHint } from './keymap.js';
import { TUI_COLORS } from './ui-style.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function fit(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text;
  let shown = '';
  for (const { segment } of graphemes.segment(text)) {
    if (displayWidth(shown + segment + '…') > columns) break;
    shown += segment;
  }
  return columns <= 0 ? '' : `${shown}…`;
}

export function Welcome({ version, boundary, columns, locale }: {
  readonly version: string; readonly boundary?: string; readonly columns: number; readonly locale: Locale;
}): ReactElement {
  return h(Box, { flexDirection: 'column', paddingX: 1, marginBottom: 1, width: columns },
    h(Text, null, h(Text, { color: TUI_COLORS.accent }, '❧ '), h(Text, { bold: true }, 'ligule'), h(Text, { color: TUI_COLORS.muted }, `  v${version}`)),
    h(Text, { color: TUI_COLORS.muted, wrap: 'truncate-middle' }, boundary ?? ''),
    h(Text, { wrap: 'truncate-end' }, textOf(locale,
      columns >= 64 ? '欢迎使用 Ligule  /help 命令与快捷键  /resume 恢复会话' : '欢迎使用 Ligule  /help 查看命令',
      columns >= 64 ? 'Welcome to Ligule  /help commands and keys  /resume sessions' : 'Welcome to Ligule  /help commands')));
}

export interface ConfigurationProps {
  readonly model: string;
  readonly mode: string;
  readonly policy: string;
  readonly thinking?: string;
  readonly permission?: string;
  readonly external?: boolean;
  readonly columns: number;
  readonly locale: Locale;
}

// 思考档只在会话明确覆盖了模型默认值时显示，避免默认情况下多占一行宽度。
export function thinkingText(effort: string | undefined, locale: Locale): string {
  if (effort === undefined || effort === 'default') return '';
  const label = effort === 'none' ? textOf(locale, '无', 'none')
    : effort === 'low' ? textOf(locale, '低', 'low')
      : effort === 'high' ? textOf(locale, '高', 'high')
        : effort === 'max' ? textOf(locale, '最高', 'max') : effort;
  return textOf(locale, `思考 ${label}`, `Thinking ${label}`);
}

export function configurationText({ model, mode, policy, thinking, permission, external = false, columns, locale }: ConfigurationProps): string {
  if (external) return fit(textOf(locale, `外控模型 ${model}`, `External model ${model}`), columns);
  const approval = policy === 'never' ? textOf(locale, '旧 never，需迁移', 'legacy never; migrate')
    : policy === 'none' ? textOf(locale, '不受审批', 'none')
      : policy === 'auto' ? textOf(locale, '自动判定', 'auto') : textOf(locale, '逐次审批', 'ask');
  const policyText = textOf(locale, `审批 ${approval}`, `Approval ${approval}`);
  const modeText = textOf(locale, `工具模式 ${mode}`, `Tools ${mode}`);
  const permissionText = permission === undefined || permission === '' ? ''
    : textOf(locale, `权限 ${permission}`, `Access ${permission}`);
  const modelText = columns >= 60 ? textOf(locale, `模型 ${model}`, `Model ${model}`) : model;
  const modelKey = columns >= 72 ? ` ${keyHint('model-picker')}` : '';
  const effortText = thinkingText(thinking, locale);
  const sep = '  ·  ';
  const narrowSep = ' · ';
  const candidates: readonly (readonly string[])[] = [
    [modelText + modelKey, effortText, modeText, permissionText, policyText],
    // 窄一档时先省掉模型标签与快捷键提示，把宽度留给模式、权限与审批的完整措辞。
    [modelText, effortText, modeText, permissionText, policyText],
    [model, effortText, modeText, permissionText, policyText],
    [model, effortText, fit(modeText, 12), fit(permissionText, 14), policyText],
    // 再窄一档：模式也只留值，仍保住思考、权限与审批。
    [model, effortText, mode, fit(permissionText, 14), policyText],
    [fit(modelText, 16), effortText, fit(modeText, 10), fit(permissionText, 12), policyText],
    [fit(modelText, 16), fit(modeText, 12), permissionText, policyText],
    [permissionText, policyText],
  ];
  // 第一种布局保留原始间距，其余用紧凑分隔符换一点宽度。
  const joined = candidates.map((candidate, index) => ({
    line: candidate.filter(part => part !== '').join(index === 0 || index === 6 ? sep : narrowSep),
  }));
  // 控制台最后两列容易被窗口边缘吞掉（写入末列还会触发换行），按 columns-2 排版更稳。
  const available = Math.max(8, columns - 2);
  for (const { line } of joined) {
    if (displayWidth(line) <= available) return line;
  }
  const compactApproval = policy === 'never' ? textOf(locale, '旧never', 'legacy')
    : policy === 'none' ? textOf(locale, '无审批', 'none')
      : policy === 'auto' ? textOf(locale, '自动', 'auto') : approval;
  if (displayWidth(policyText) <= available) return policyText;
  return fit(compactApproval, available);
}

export function ConfigurationLine(props: ConfigurationProps): ReactElement {
  return h(Text, { color: TUI_COLORS.muted, wrap: 'truncate-end' }, configurationText(props));
}

export interface ProgressSnapshot {
  readonly phase: 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';
  readonly lastProgressAt: number;
}

export function ProgressLine({ progress, seconds, marker, columns, locale, now = Date.now() }: {
  readonly progress?: ProgressSnapshot | null; readonly seconds: number; readonly marker: string;
  readonly columns: number; readonly locale: Locale; readonly now?: number;
}): ReactElement {
  const phase = progress === undefined || progress === null ? textOf(locale, '正在运行', 'Working') : {
    preparing: textOf(locale, '准备上下文', 'Preparing context'),
    model_request: textOf(locale, '请求模型', 'Requesting model'),
    tool_execution: textOf(locale, '执行工具', 'Running tools'),
    compaction: textOf(locale, '压缩上下文', 'Compacting context'),
    awaiting_approval: textOf(locale, '等待审批', 'Waiting for approval'),
    awaiting_input: textOf(locale, '等待回答', 'Waiting for an answer'),
    settling: textOf(locale, '正在收尾', 'Finishing'),
  }[progress.phase];
  const elapsed = `${Math.max(0, Math.floor(seconds))}s`;
  const interrupt = textOf(locale, `${keyHint('interrupt')} 取消`, `${keyHint('interrupt')} stop`);
  const idle = progress === undefined || progress === null ? 0 : Math.max(0, Math.floor((now - progress.lastProgressAt) / 1000));
  const detail = idle >= 15 && columns >= 80 ? textOf(locale, `  ·  ${idle}s 无新活动`, `  ·  ${idle}s since activity`) : '';
  const label = `${marker} ${phase}  ${elapsed}  ·  ${interrupt}${detail}`;
  const compact = `${marker} ${elapsed}  ${interrupt}`;
  return h(Text, { wrap: 'truncate-end' },
    h(Text, { color: TUI_COLORS.accent }, displayWidth(label) <= columns ? label : compact));
}
