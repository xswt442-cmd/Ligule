import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { App } from '../dist/tui/app.js';
import type { TuiClient } from '../dist/tui/app.js';
import type { Connection } from '@ligule/core/tui.js';
import { completeFrame } from './helpers/frames.ts';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { columns: number; rows: number; isTTY: boolean };

async function waitUntilSessionClosed(context: { client: Connection }, sessionId: string): Promise<void> {
  await waitFor(async () => {
    try { await context.client.request('status.get', { sessionId }); return false; }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'session_not_open') return true;
      if (code === 'session_closing') return false;
      throw error;
    }
  }, { within: 15_000 });
}

type AppHandle = {
  frame: () => string;
  stdin: FakeInput;
  submit: (text: string) => Promise<void>;
  wait: (condition: () => boolean | Promise<boolean>) => Promise<void>;
};

async function withApp(context: { client: Connection; sessionId: string; projectDirectory: string }, run: (app: AppHandle) => Promise<void>): Promise<void> {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true }) as FakeOutput;
  const stdin: FakeInput = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk.toString(); });
  const frame = () => completeFrame(painted);
  const instance = render(createElement(App, {
    client: context.client as TuiClient,
    sessionId: context.sessionId,
    stdout: stdout as unknown as NodeJS.WriteStream,
    info: { boundary: context.projectDirectory },
  }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false, interactive: true });
  const wait = (condition: () => boolean | Promise<boolean>) => waitFor(condition, { within: 15_000, read: frame });
  const submit = async (text: string) => {
    stdin.write(text);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    stdin.write(String.fromCharCode(13));
  };
  try {
    await wait(() => frame().includes('审批 逐次审批'));
    await run({ frame, stdin, submit, wait });
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
  }
}

test('resume opens the target before retiring the old lock and keeps a same-session resume open', async () => {
  await withTuiHost(async (context) => {
    const target = await context.client.request('session.create', {}) as { sessionId: string };
    await withApp(context, async ({ frame, stdin, submit, wait }) => {
      await submit(`/resume ${target.sessionId.slice(0, 8)}`);
      await wait(() => frame().includes(`会话 ${target.sessionId.slice(0, 8)}`));
      assert.ok(context.requests.some((request) => request.method === 'session.open' && (request.params as { sessionId?: string }).sessionId === target.sessionId));
      assert.ok(context.requests.some((request) => request.method === 'session.close' && (request.params as { sessionId?: string }).sessionId === context.sessionId));

      const old = await context.client.request('session.open', { projectRoot: context.projectDirectory, sessionId: context.sessionId }) as { sessionId: string };
      assert.equal(old.sessionId, context.sessionId, 'the previous Host lock was retired and can be reacquired');
      await context.client.request('session.close', { sessionId: context.sessionId });

      const closesBefore = context.requests.filter((request) => request.method === 'session.close' && (request.params as { sessionId?: string }).sessionId === target.sessionId).length;
      const statusReadsBefore = context.requests.filter((request) => request.method === 'status.get' && (request.params as { sessionId?: string }).sessionId === target.sessionId).length;
      await submit(`/resume ${target.sessionId} minimal`);
      await wait(() => frame().includes(`会话 ${target.sessionId.slice(0, 8)}`));
      assert.equal(context.requests.filter((request) => request.method === 'session.close' && (request.params as { sessionId?: string }).sessionId === target.sessionId).length, closesBefore,
        'resuming the current session with a mode must not close its active Host state');
      await wait(() => context.requests.filter((request) => request.method === 'status.get' && (request.params as { sessionId?: string }).sessionId === target.sessionId).length > statusReadsBefore);
      await context.client.request('status.get', { sessionId: target.sessionId });
    });
  });
});

test('a read failure after session.open closes the unused target and preserves the active session', async () => {
  await withTuiHost(async (context) => {
    const target = await context.client.request('session.create', {}) as { sessionId: string };
    await withApp(context, async ({ frame, stdin, submit, wait }) => {
      await submit('/sessions');
      await wait(() => frame().includes(target.sessionId.slice(0, 8)));
      await appendFile(join(context.sessionDirectory, `${target.sessionId}.jsonl`), 'this is not a session event\n');
      stdin.write(target.sessionId.slice(0, 8));
      await wait(() => frame().includes('1/2 份'));
      stdin.write('\r');
      await wait(() => frame().includes('无法恢复会话：session_line_invalid'));

      assert.ok(context.requests.some((request) => request.method === 'session.open' && (request.params as { sessionId?: string }).sessionId === target.sessionId));
      assert.ok(context.requests.some((request) => request.method === 'session.close' && (request.params as { sessionId?: string }).sessionId === target.sessionId),
        'the successfully opened but unreadable target is closed');
      await waitUntilSessionClosed(context, target.sessionId);
      await context.client.request('status.get', { sessionId: context.sessionId });
    });
  });
});

test('new creates one session and releases the previous Host lock', async () => {
  await withTuiHost(async (context) => {
    const createsBefore = context.requests.filter((request) => request.method === 'session.create').length;
    await withApp(context, async ({ frame, submit, wait }) => {
      await submit('/new');
      await wait(() => {
        const shown = /会话 ([a-f\d-]{8})/u.exec(frame())?.[1];
        return shown !== undefined && shown !== context.sessionId.slice(0, 8);
      });
      assert.equal(context.requests.filter((request) => request.method === 'session.create').length, createsBefore + 1);
      assert.equal(context.requests.filter((request) => request.method === 'session.close' && (request.params as { sessionId?: string }).sessionId === context.sessionId).length, 1);
      const reopened = await context.client.request('session.open', { projectRoot: context.projectDirectory, sessionId: context.sessionId }) as { sessionId: string };
      assert.equal(reopened.sessionId, context.sessionId);
      await context.client.request('session.close', { sessionId: context.sessionId });
    });
  });
});

test('new releases its created lock when the previous session cannot be retired', async () => {
  await withTuiHost(async (context) => {
    const createsBefore = context.requests.filter((request) => request.method === 'session.create').length;
    await withApp(context, async ({ frame, submit, wait }) => {
      await context.client.request('session.close', { sessionId: context.sessionId });
      await submit('/new');
      await wait(() => frame().includes('无法关闭当前会话：session_not_open'));
      const created = context.requests.filter((request) => request.method === 'session.create');
      assert.equal(created.length, createsBefore + 1);
      const release = context.requests.filter((request) => request.method === 'session.close').at(-1)!;
      assert.notEqual((release.params as { sessionId?: string }).sessionId, context.sessionId, 'the newly created session is released after retirement fails');
      await waitUntilSessionClosed(context, (release.params as { sessionId: string }).sessionId);
    });
  });
});
