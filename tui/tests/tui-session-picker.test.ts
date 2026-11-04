import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { SessionPicker } from '../dist/tui/session-picker.js';
import type { SessionPickerProps } from '../dist/tui/session-picker.js';
import { displayWidth } from '../dist/tui/commands.js';
import type { SessionSummary } from '@ligule/core/tui.js';
import { completeFrame } from './helpers/frames.ts';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { columns: number; isTTY: boolean };

function terminal(columns = 80) {
  const stdout = new PassThrough() as FakeOutput;
  stdout.columns = columns;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk.toString(); });
  const stdin = new PassThrough() as FakeInput;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => {};
  stdin.unref = () => {};
  return {
    stdin,
    painted: () => completeFrame(painted),
    render: (props: SessionPickerProps) => render(createElement(SessionPicker, props), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false, patchConsole: false, interactive: true,
    }),
  };
}

type Terminal = ReturnType<typeof terminal>;

async function waitFor(tty: Terminal, predicate: (output: string) => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate(tty.painted())) {
    if (Date.now() > deadline) throw new Error('session picker output did not reach the expected state');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

const sessions: SessionSummary[] = [
  {
    id: '01abcdef-1111-2222-3333-444444444444', formatVersion: 1, projectRoot: 'C:/work', workspace: 'work', workspaceOrigin: 'header',
    createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-03T10:11:12.000Z', events: 4, lastSeq: 3,
    mode: { name: 'minimal', layer: 'user', digest: 'a' }, name: 'Release checklist 会话', archived: false,
    unanswered: 0, truncatedBytes: 0,
  },
  {
    id: '02abcdef-1111-2222-3333-444444444444', formatVersion: 1, projectRoot: 'C:/work', workspace: 'work', workspaceOrigin: 'header',
    createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-04T10:11:12.000Z', events: 7, lastSeq: 6,
    mode: { name: 'full', layer: 'project', digest: 'b' }, name: '', archived: true,
    unanswered: 0, truncatedBytes: 0,
  },
  {
    id: '03abcdef-1111-2222-3333-444444444444', formatVersion: 1, projectRoot: 'C:/work', workspace: 'work', workspaceOrigin: 'header',
    createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-05T10:11:12.000Z', events: 0, lastSeq: 0,
    mode: null, name: 'Unreadable session', archived: false,
    unanswered: 0, truncatedBytes: 0, error: { code: 'session_header_invalid', detail: 'invalid header' },
  },
];

function props(overrides: Partial<SessionPickerProps> = {}): SessionPickerProps {
  return {
    items: sessions,
    current: sessions[0].id,
    locale: 'en',
    height: 8,
    columns: 80,
    running: false,
    onClose() {},
    onSelect() {},
    ...overrides,
  };
}

test('SessionPicker filters by name, id, and mode, and paste adds one-line search text', async () => {
  const tty = terminal();
  const selected: string[] = [];
  const instance = tty.render(props({ onSelect: (id) => selected.push(id) }));
  try {
    await waitFor(tty, (output) => output.includes('Release checklist'));
    assert.match(tty.painted(), /Release checklist 会话 · 01abcdef/);
    assert.ok(tty.painted().indexOf('Release checklist') < tty.painted().indexOf('01abcdef'));
    tty.stdin.write('minimal');
    await waitFor(tty, (output) => output.includes('1/3 sessions'));
    assert.match(tty.painted(), /Release checklist/);
    assert.doesNotMatch(tty.painted(), /Unnamed/);
    tty.stdin.write('\x7f'.repeat(7));
    await waitFor(tty, (output) => output.includes('3/3 sessions'));
    tty.stdin.write('\x1b[200~Unreadable\nsession\x1b[201~');
    await waitFor(tty, (output) => output.includes('Unreadable session'));
    await waitFor(tty, (output) => output.includes('1/3 sessions'));
    assert.match(tty.painted(), /Cannot resume: session_header_invalid/);
    tty.stdin.write('\r');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.deepEqual(selected, [], 'an unreadable session is reported as non-resumable');
    tty.stdin.write('\x7f'.repeat('Unreadable session'.length));
    await waitFor(tty, (output) => output.includes('3/3 sessions'));
    tty.stdin.write('会话');
    await waitFor(tty, (output) => output.includes('1/3 sessions'));
    tty.stdin.write('\x7f');
    await waitFor(tty, (output) => output.includes('1/3 sessions'));
    tty.stdin.write('\x7f');
    await waitFor(tty, (output) => output.includes('3/3 sessions'));
    tty.stdin.write('\x1b[200~02abcdef\x1b[201~');
    await waitFor(tty, (output) => output.includes('1/3 sessions'));
    assert.match(tty.painted(), /Unnamed · 02abcdef/);
  } finally {
    instance.unmount();
  }
});

test('SessionPicker does not select empty or unreadable sessions and restores selection navigation', async () => {
  const tty = terminal();
  const selected: string[] = [];
  let closed = false;
  const instance = tty.render(props({
    onSelect: (id) => selected.push(id),
    onClose: () => { closed = true; },
  }));
  try {
    await waitFor(tty, (output) => output.includes('Release checklist'));
    tty.stdin.write('\x1b[200~does-not-exist\x1b[201~');
    await waitFor(tty, (output) => output.includes('No matching sessions'));
    tty.stdin.write('\r');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.deepEqual(selected, []);

    tty.stdin.write('\x1b');
    await waitFor(tty, () => closed);
    instance.unmount();
  } finally {
    instance.unmount();
  }

  const next = terminal();
  const resumed: string[] = [];
  const reopened = next.render(props({ onSelect: (id) => resumed.push(id) }));
  try {
    await waitFor(next, (output) => output.includes('Release checklist'));
    next.stdin.write('\x1b[F');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    next.stdin.write('\x1b[A');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    next.stdin.write('\r');
    await waitFor(next, () => resumed.length === 1);
    assert.deepEqual(resumed, [sessions[1].id]);
  } finally {
    reopened.unmount();
  }
});

test('SessionPicker blocks recovery while a turn runs, then remains closable', async () => {
  const tty = terminal();
  const selected: string[] = [];
  let closed = false;
  const instance = tty.render(props({
    running: true,
    onSelect: (id) => selected.push(id),
    onClose: () => { closed = true; },
  }));
  try {
    await waitFor(tty, (output) => output.includes('Finish the current turn'));
    tty.stdin.write('\r');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.deepEqual(selected, []);
    tty.stdin.write('\x1b');
    await waitFor(tty, () => closed);
  } finally {
    instance.unmount();
  }

  const resumed: string[] = [];
  const afterTurn = terminal();
  const reopened = afterTurn.render(props({ running: false, onSelect: (id) => resumed.push(id) }));
  try {
    await waitFor(afterTurn, (output) => output.includes('Release checklist'));
    afterTurn.stdin.write('\r');
    await waitFor(afterTurn, () => resumed.length === 1);
    assert.equal(resumed[0], sessions[0].id);
  } finally {
    reopened.unmount();
  }
});

test('SessionPicker respects narrow width and total panel height', async () => {
  const tty = terminal(24);
  const instance = tty.render(props({ columns: 24, height: 4 }));
  try {
    await waitFor(tty, (output) => output.includes('Search'));
    const rows = tty.painted().split('\n').filter((line) => line !== '');
    assert.ok(rows.length <= 4, `expected at most four rendered rows, got ${rows.length}`);
    assert.ok(rows.every((line) => displayWidth(line) <= 24), rows.join('\n'));
    assert.match(tty.painted(), /› Release checklist/, 'the selected session title remains visible when metadata is truncated');
    assert.match(tty.painted(), /Current session/, 'the active-session status remains visible when row metadata is truncated');
  } finally {
    instance.unmount();
  }
});

test('SessionPicker only resumes a visible selection at heights zero, one, and two', async () => {
  for (const height of [0, 1, 2]) {
    const tty = terminal();
    const selected: string[] = [];
    const instance = tty.render(props({ height, onSelect: (id) => selected.push(id) }));
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      const frame = tty.painted();
      if (height === 0) {
        assert.doesNotMatch(frame, /Release checklist/);
      } else {
        assert.match(frame, /Release checklist 会话 · 01abcdef/);
        assert.match(frame, /› Release checklist 会话/, 'the selected row keeps a non-color selection marker');
        assert.equal(frame.includes('Search ·'), height === 2, 'height two spends one line on the heading');
      }

      tty.stdin.write('\r');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      assert.deepEqual(selected, height === 0 ? [] : [sessions[0].id], `height ${height}`);
    } finally {
      instance.unmount();
    }
  }
});
