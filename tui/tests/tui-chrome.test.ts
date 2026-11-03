import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { render } from 'ink';
import { configurationText, ProgressLine, Welcome } from '../dist/tui/chrome.js';
import { displayWidth } from '../dist/tui/commands.js';
import { completeFrame } from './helpers/frames.ts';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };

async function paint(component: ReactElement, columns: number): Promise<string> {
  const stdout = Object.assign(new PassThrough(), { columns, rows: 24, isTTY: true });
  const stdin: FakeInput = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const instance = render(component, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false, interactive: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  const frame = completeFrame(output);
  instance.unmount();
  return frame;
}

test('configuration keeps approval visible and stays within narrow display widths', () => {
  for (const columns of [32, 50, 80, 120]) {
    for (const locale of ['zh', 'en'] as const) {
      for (const mode of ['minimal', 'very-long-mode-中文😀'.repeat(5)]) {
        for (const policy of ['never', 'always'] as const) {
          const text = configurationText({ model: 'very-long-model-中文😀'.repeat(5), mode, policy, columns, locale });
          assert.ok(displayWidth(text) <= columns, text);
          assert.ok(text.includes(locale === 'zh' ? (policy === 'never' ? '不审批' : '每次审批') : policy), text);
        }
      }
    }
  }
});

test('the configuration line shows a thinking override and hides the default', () => {
  const overridden = configurationText({ model: 'deepseek-flash', mode: 'full', policy: 'ask', thinking: 'high', columns: 120, locale: 'zh' });
  assert.match(overridden, /思考 高/);
  assert.match(configurationText({ model: 'deepseek-flash', mode: 'full', policy: 'ask', thinking: 'max', columns: 120, locale: 'en' }), /Thinking max/);
  for (const thinking of [undefined, 'default']) {
    assert.doesNotMatch(configurationText({ model: 'deepseek-flash', mode: 'full', policy: 'ask', thinking, columns: 120, locale: 'zh' }), /思考/);
  }
});

test('the configuration line keeps a two-column safety margin at console edges', () => {
  for (const locale of ['zh', 'en'] as const) {
    for (const columns of [80, 60, 40]) {
      const line = configurationText({ model: 'deepseek-flash', mode: 'minimal', policy: 'ask', permission: 'read-only', thinking: 'high', columns, locale });
      assert.ok(displayWidth(line) <= Math.max(8, columns - 2), `${locale}/${columns}: width ${displayWidth(line)} of ${line}`);
    }
  }
});

test('a narrow configuration line keeps the approval value readable', () => {
  for (const locale of ['zh', 'en'] as const) {
    for (const columns of [8, 10, 12, 16, 20]) {
      const line = configurationText({ model: 'long-model-name', mode: 'full', policy: 'ask', permission: 'read-only', columns, locale });
      assert.ok(displayWidth(line) <= Math.max(8, columns - 2), `${locale}/${columns}: ${line}`);
      assert.ok(line.includes(locale === 'zh' ? '逐次审批' : 'ask'), `${locale}/${columns}: ${line}`);
    }
  }
});

test('welcome uses a left-aligned compact block with useful commands', async () => {
  const frame = await paint(createElement(Welcome, { version: '0.0.7', boundary: 'C:/workspace/project', columns: 80, locale: 'zh' }), 80);
  assert.match(frame, /^ ❧ ligule/m);
  assert.match(frame, /\/help/);
  assert.match(frame, /\/resume/);
  assert.ok(frame.trimEnd().split('\n').length <= 4);
});

test('run progress keeps interruption visible and uses only the supplied Host phase', async () => {
  const frame = await paint(createElement(ProgressLine, {
    progress: { phase: 'tool_execution', lastProgressAt: 1000 }, seconds: 12, marker: '⠋', columns: 32, locale: 'zh', now: 6000,
  }), 32);
  assert.match(frame, /执行工具/);
  assert.match(frame, /12s/);
  assert.match(frame, /Esc.*取消/);
  assert.doesNotMatch(frame, /无新活动/);
});
