import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render, Text } from 'ink';
import { PanelFrame } from '../dist/tui/panels.js';
import { TUI_COLORS } from '../dist/tui/ui-style.js';
import { completeFrame } from './helpers/frames.ts';

test('semantic colors inherit terminal palette roles and PanelFrame adds no vertical border rows', async () => {
  assert.deepEqual(TUI_COLORS, {
    accent: 'green', success: 'green', muted: 'gray', warning: 'yellow', error: 'red', info: 'cyan',
  });
  const stdout = new PassThrough() as PassThrough & { columns: number; isTTY: boolean };
  stdout.columns = 24;
  stdout.isTTY = true;
  let output = '';
  stdout.on('data', (chunk) => { output += chunk.toString(); });
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => {};
  stdin.unref = () => {};
  const instance = render(createElement(PanelFrame, { width: 24 }, createElement(Text, null, '› Active option')), {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false, interactive: true,
  });
  try {
    const deadline = Date.now() + 2_000;
    while (!completeFrame(output).includes('Active option')) {
      if (Date.now() > deadline) throw new Error('panel frame was not rendered');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    const frame = completeFrame(output);
    assert.match(frame, /│\s+› Active option/);
    assert.doesNotMatch(frame, /[┌┐└┘─]/);
    assert.ok(frame.split('\n').filter((line: string) => line.includes('│')).every((line: string) => line.startsWith('│') && !line.slice(1).includes('│')));
    assert.equal(frame.split('\n').filter((line: string) => line.includes('Active option')).length, 1);
  } finally {
    instance.unmount();
  }
});
