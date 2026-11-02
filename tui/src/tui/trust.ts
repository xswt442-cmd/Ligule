import { createElement, useState } from 'react';
import { Box, Text, render, useInput, usePaste, type RenderOptions } from 'ink';
import type { Locale } from '@ligule/core/tui.js';
import { isTrusted, setTrusted, trustPathOf } from './trust-store.js';

type TrustPromptProps = {
  readonly directory: string;
  readonly locale: Locale;
  readonly onDecision: (trusted: boolean) => void;
};

function TrustPrompt({ directory, locale, onDecision }: TrustPromptProps) {
  const [selected, setSelected] = useState(1);
  const chinese = locale === 'zh';
  const safeDirectory = directory.replace(/[\u0000-\u001f\u007f]/gu, '\uFFFD');
  const options = chinese ? ['信任并继续', '退出'] : ['Trust and continue', 'Exit'];
  // 信任确认只接收明确按键，终端粘贴不能提交选择。
  usePaste(() => {});

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) {
      onDecision(false);
      return;
    }
    if (key.upArrow || key.leftArrow) {
      setSelected((current) => (current + options.length - 1) % options.length);
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setSelected((current) => (current + 1) % options.length);
      return;
    }
    if (key.return) onDecision(selected === 0);
  });

  return createElement(Box, { flexDirection: 'column', paddingX: 1 },
    createElement(Text, { bold: true }, chinese ? '是否信任这个工作区？' : 'Trust this workspace?'),
    createElement(Text, null, safeDirectory),
    createElement(Text, null, chinese
      ? '项目配置、指南和技能可能影响模型行为。信任此工作区不会改变工具审批设置。'
      : 'Project configuration, guides, and skills can affect model behavior. Trusting it does not change tool approval settings.'),
    ...options.map((label, index) => createElement(Text, { key: label, color: selected === index ? 'cyan' : undefined },
      `${selected === index ? '›' : ' '} ${label}`)),
    createElement(Text, { dimColor: true }, chinese ? '↑↓ 或 ←→ 选择，Enter 确认，Esc 退出' : 'Use ↑↓ or ←→, Enter to confirm, Esc to exit'),
  );
}

export interface ConfirmWorkspaceTrustOptions {
  readonly locale?: Locale;
  readonly stdin?: RenderOptions['stdin'];
  readonly stdout?: RenderOptions['stdout'];
  readonly stderr?: RenderOptions['stderr'];
  readonly trustFile?: string;
}

export async function confirmWorkspaceTrust(
  directory: string,
  { locale = 'zh', stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, trustFile = trustPathOf() }: ConfirmWorkspaceTrustOptions = {},
): Promise<boolean> {
  if (await isTrusted(directory, trustFile)) return true;

  let resolveDecision!: (trusted: boolean) => void;
  let rejectDecision!: (error: unknown) => void;
  const decision = new Promise<boolean>((resolve, reject) => {
    resolveDecision = resolve;
    rejectDecision = reject;
  });
  let decided = false;
  const decide = (trusted: boolean): void => {
    if (decided) return;
    decided = true;
    if (!trusted) {
      resolveDecision(false);
      return;
    }
    void setTrusted(directory, true, trustFile).then(
      () => resolveDecision(true),
      rejectDecision,
    );
  };

  const instance = render(createElement(TrustPrompt, { directory, locale, onDecision: decide }), {
    stdin,
    stdout,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  try {
    return await decision;
  } finally {
    instance.unmount();
  }
}
