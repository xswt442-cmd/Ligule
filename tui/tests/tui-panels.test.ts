import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { render } from 'ink';
import { applyOverrides, CURRENT } from '../dist/tui/keymap.js';
import { HelpPanel, ChoicePanel } from '../dist/tui/panels.js';
import type { PanelChoice } from '../dist/tui/panels.js';
import { completeFrame } from './helpers/frames.ts';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { columns: number; isTTY: boolean };

function terminal() {
  const stdout = new PassThrough() as FakeOutput;
  stdout.columns = 80;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk.toString(); });
  const stdin = new PassThrough() as FakeInput;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => {};
  stdin.unref = () => {};
  const instance = (node: ReactElement) => render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  return { stdin, stdout, painted: () => painted, render: instance };
}

type Terminal = ReturnType<typeof terminal>;

function visible(tty: Terminal) {
  return completeFrame(tty.painted()).replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '');
}

async function waitFor(tty: Terminal, predicate: (output: string) => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate(visible(tty))) {
    if (Date.now() > deadline) throw new Error(`panel output did not reach the expected state: ${visible(tty)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

test('HelpPanel changes category, pages wrapped entries, and closes on Escape', async () => {
  const tty = terminal();
  let closed = false;
  const templates = Array.from({ length: 12 }, (_, index) => ({
    command: `item-${String(index).padStart(2, '0')}`,
    description: `template description ${index}`,
  }));
  const instance = tty.render(createElement(HelpPanel, {
    templates, locale: 'zh', columns: 34, height: 2, onClose: () => { closed = true; },
  }));
  try {
    await waitFor(tty, (output) => output.includes('命令'));
    tty.stdin.write('\u001b[C');
    await waitFor(tty, (output) => output.includes('› 按键'));
    tty.stdin.write('\u001b[C');
    await waitFor(tty, (output) => output.includes('› 提示模板'));
    tty.stdin.write('\u001b[6~');
    await waitFor(tty, (output) => output.includes('/item-01'));
    tty.stdin.write('\u001b');
    await waitFor(tty, () => closed);
  } finally {
    instance.unmount();
  }
  assert.equal(closed, true);
});

test('ChoicePanel follows personal key bindings for movement, selection, hints, and close', async () => {
  const before = { ...CURRENT };
  try {
    applyOverrides({ 'panel-up': 'k', 'panel-down': 'j', 'panel-close': 'q' });
    const tty = terminal();
    let selected: PanelChoice | undefined;
    let closed = false;
    const instance = tty.render(createElement(ChoicePanel, {
      title: 'Choose one',
      options: [
        { id: 'first', label: 'First', description: 'First detail' },
        { id: 'second', label: 'Second', description: 'Second detail' },
      ],
      locale: 'en',
      height: 4,
      onClose: () => { closed = true; },
      onSelect: (choice) => { selected = choice; },
    }));
    try {
      await waitFor(tty, (output) => output.includes('Choose one'));
      assert.match(visible(tty), /J.*select/s);
      tty.stdin.write('j');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      tty.stdin.write('\r');
      await waitFor(tty, () => selected !== undefined);
      tty.stdin.write('q');
      await waitFor(tty, () => closed);
    } finally {
      instance.unmount();
    }
    assert.equal(selected!.id, 'second');
    assert.equal(closed, true);
  } finally {
    applyOverrides(Object.fromEntries(Object.entries(before).map(([action, spec]) => [action, spec])));
  }
});

test('ChoicePanel cannot confirm an empty or loading choice list', async () => {
  for (const options of [[], [{ id: 'busy', label: 'Busy' }]]) {
    const tty = terminal();
    let selected = false;
    let closed = false;
    const instance = tty.render(createElement(ChoicePanel, {
      title: 'Loading choices',
      options,
      loading: options.length > 0,
      locale: 'en',
      height: 3,
      onClose: () => { closed = true; },
      onSelect: () => { selected = true; },
    }));
    try {
      await waitFor(tty, (output) => output.includes('Loading choices'));
      tty.stdin.write('\r');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      assert.equal(selected, false);
      tty.stdin.write('\u001b');
      await waitFor(tty, () => closed);
    } finally {
      instance.unmount();
    }
  }
});
