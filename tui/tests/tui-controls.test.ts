import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { render } from 'ink';
import { modeDirectories } from '../../core/dist/kernel/modes.js';
import { modeOptions } from '../dist/tui/mode-options.js';
import type { TuiClient } from '../dist/tui/app.js';
import { completeFrame } from './helpers/frames.ts';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

const shippedModes = fileURLToPath(new URL('../../core/modes/', import.meta.url));
const options = {
  config: {
    model: {
      services: [{
        id: 'alpha',
        name: 'Alpha',
        api: 'chat-completions',
        baseURL: 'http://127.0.0.1',
        apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY',
        models: ['first-model', 'second-model'],
      }],
      selection: { provider: 'alpha', model: 'first-model' },
    },
  },
  interactive: true,
};

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { isTTY: boolean; columns: number; rows: number };

function fakeTerminal() {
  const stdin = new PassThrough() as FakeInput;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => {};
  stdin.unref = () => {};
  const stdout = new PassThrough() as FakeOutput;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 36;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk.toString(); });
  return { stdin, stdout, frame: () => completeFrame(painted) };
}

async function until(terminal: ReturnType<typeof fakeTerminal>, condition: (frame: string) => boolean) {
  await waitFor(() => condition(terminal.frame()), {
    within: 10_000,
    every: 10,
    read: terminal.frame,
  });
}

test('TUI screen consent requires the explicit confirmation command and can be revoked without a model run', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
    const { App } = await import('../dist/tui/app.js');
    const terminal = fakeTerminal();
    const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, stdout: terminal.stdout as unknown as NodeJS.WriteStream, interactive: true }),
      { stdin: terminal.stdin as unknown as NodeJS.ReadStream, stdout: terminal.stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false, interactive: true });
    const submit = async (text: string) => {
      terminal.stdin.write(text);
      await new Promise(resolve => setTimeout(resolve, 60));
      terminal.stdin.write('\r');
    };
    try {
      await until(terminal, frame => frame.includes('read-only'));
      await submit('/screen on');
      await until(terminal, frame => frame.includes('截图会读取现有画面'));
      assert.equal(requests.some(request => request.method === 'screen-capture.set'), false);
      await submit('/screen on confirm');
      await until(terminal, frame => frame.includes('本会话截图已授权'));
      assert.equal((await (client as TuiClient).request('status.get', { sessionId })).screenCapture!.enabled, true);
      await submit('/screen off');
      await until(terminal, frame => frame.includes('本会话截图授权已撤销'));
      assert.equal((await (client as TuiClient).request('status.get', { sessionId })).screenCapture!.enabled, false);
      assert.equal(requests.some(request => request.method === 'run.start'), false);
    } finally { instance.unmount(); }
  }, { interactive: true, permissionControl: true });
});

test('TUI control panels select a model, mode, and policy without running a request or changing the draft', async () => {
  let homeDirectory = '';
  await withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
    const { App } = await import('../dist/tui/app.js');
    const terminal = fakeTerminal();
    const modes = {
      read: () => modeOptions(modeDirectories(projectDirectory, shippedModes, homeDirectory)),
    };
    const instance = render(createElement(App, {
      client: client as TuiClient,
      sessionId,
      info: { boundary: projectDirectory, model: 'first-model' },
      modes,
      stdout: terminal.stdout as unknown as NodeJS.WriteStream,
      interactive: true,
    }), {
      stdin: terminal.stdin as unknown as NodeJS.ReadStream,
      stdout: terminal.stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    try {
      await until(terminal, (frame) => frame.includes('Ctrl+P') && frame.includes('first-model'));
      terminal.stdin.write('keep this draft');
      await until(terminal, (frame) => frame.includes('keep this draft'));

      terminal.stdin.write('\u0010');
      await until(terminal, (frame) => frame.includes('Alpha / first-model'));
      terminal.stdin.write('\u001b[B');
      await until(terminal, (frame) => frame.includes('› Alpha / second-model'));
      terminal.stdin.write('\r');
      await until(terminal, () => requests.some((request) => request.method === 'model.select'));
      const modelRequest = requests.find((request) => request.method === 'model.select')!;
      assert.deepEqual(modelRequest.params, { sessionId, provider: 'alpha', model: 'second-model' });
      await until(terminal, (frame) => frame.includes('模型 second-model'));
      assert.equal((await (client as TuiClient).request('status.get', { sessionId })).selectedModel, 'second-model');
      assert.equal(requests.filter((request) => request.method === 'run.start').length, 0);
      await until(terminal, (frame) => frame.includes('keep this draft'));

      terminal.stdin.write('\u0014');
      await until(terminal, (frame) => frame.includes('minimal') && frame.includes('full'));
      terminal.stdin.write('\u001b[A');
      await until(terminal, (frame) => frame.includes('› full'));
      terminal.stdin.write('\r');
      await until(terminal, () => requests.some((request) => request.method === 'mode.set'));
      assert.equal((requests.find((request) => request.method === 'mode.set')!.params as { name: string }).name, 'full');
      await until(terminal, (frame) => frame.includes('工具模式 full'));
      assert.equal((await (client as TuiClient).request('status.get', { sessionId })).mode, 'full');

      const beforePolicy = await (client as TuiClient).request('session.read', { sessionId });
      terminal.stdin.write('\u0001');
      await until(terminal, (frame) => frame.includes('自动判定') || frame.includes('Automatic decisions'));
      terminal.stdin.write('\u001b[B');
      await until(terminal, (frame) => frame.includes('› 自动判定') || frame.includes('› Automatic decisions'));
      terminal.stdin.write('\r');
      await until(terminal, () => requests.some((request) => request.method === 'policy.set'));
      assert.equal((requests.find((request) => request.method === 'policy.set')!.params as { mode: string }).mode, 'auto');
      await until(terminal, (frame) => frame.includes('审批 自动判定'));
      const afterPolicy = await (client as TuiClient).request('status.get', { sessionId });
      const afterPolicyRecord = await (client as TuiClient).request('session.read', { sessionId });
      assert.equal(afterPolicy.policy, 'auto');
      assert.equal(afterPolicyRecord.header!.projectRoot, beforePolicy.header!.projectRoot);
      assert.equal(afterPolicyRecord.header!.projectRoot, projectDirectory);
      assert.match(terminal.frame(), /keep this draft/);

      terminal.stdin.write('\u0015');
      await until(terminal, (frame) => !frame.includes('keep this draft'));
      terminal.stdin.write('/help');
      await until(terminal, (frame) => frame.includes('/help'));
      terminal.stdin.write('\r');
      await until(terminal, (frame) => frame.includes('命令'));
      terminal.stdin.write('\u001b[C');
      await until(terminal, (frame) => frame.includes('按键'));
      terminal.stdin.write('\u001b');
      await until(terminal, (frame) => !frame.includes('提示模板'));
      assert.equal(requests.filter((request) => request.method === 'run.start').length, 0);
      const transcript = await (client as TuiClient).request('session.read', { sessionId });
      assert.equal(transcript.events.some((event) => event.kind === 'user'), false);
    } finally {
      instance.unmount();
    }
  }, {
    ...options,
    setup: ({ homeDirectory: home }) => { homeDirectory = home; },
  });
});

test('TUI requires separate confirmation for full-access and unrestricted network permissions', async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { App } = await import('../dist/tui/app.js');
  const terminal = fakeTerminal();
  const instance = render(createElement(App, {
    client: client as TuiClient,
    sessionId,
    info: { boundary: projectDirectory },
    stdout: terminal.stdout as unknown as NodeJS.WriteStream,
    interactive: true,
  }), {
    stdin: terminal.stdin as unknown as NodeJS.ReadStream,
    stdout: terminal.stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  try {
    await until(terminal, (frame) => frame.includes('read-only'));
    terminal.stdin.write('/permission full-access');
    await until(terminal, (frame) => frame.includes('/permission full-access'));
    terminal.stdin.write('\r');
    await until(terminal, (frame) => frame.includes('我确认启用 full-access'));
    assert.equal(requests.some((request) => request.method === 'permission.set'), false);
    terminal.stdin.write('\r');
    await until(terminal, () => requests.some((request) => request.method === 'permission.set'));
    const fullAccessRequest = requests.find((request) => request.method === 'permission.set')!;
    assert.equal((fullAccessRequest.params as Record<string, unknown>).confirmFullAccess, true);
    assert.equal((fullAccessRequest.params as Record<string, unknown>).permissionProfile, 'full-access');
    await until(terminal, (frame) => frame.includes('权限已更新：full-access'));
    assert.equal((await (client as TuiClient).request('status.get', { sessionId })).permission!.profile, 'full-access');

    const beforeNetwork = requests.filter((request) => request.method === 'permission.set').length;
    terminal.stdin.write('/permission network unrestricted');
    await until(terminal, (frame) => frame.includes('/permission network unrestricted'));
    terminal.stdin.write('\r');
    await until(terminal, (frame) => frame.includes('我确认启用不受限网络'));
    assert.equal(requests.filter((request) => request.method === 'permission.set').length, beforeNetwork);
    terminal.stdin.write('\r');
    await until(terminal, () => requests.filter((request) => request.method === 'permission.set').length === beforeNetwork + 1);
    const networkRequest = requests.filter((request) => request.method === 'permission.set').at(-1)!;
    assert.equal((networkRequest.params as Record<string, unknown>).confirmNetwork, true);
    assert.equal((networkRequest.params as Record<string, unknown>).permissionNetwork, 'unrestricted');
    await until(terminal, (frame) => frame.includes('权限已更新：full-access · 网络 unrestricted'));
    assert.equal((await (client as TuiClient).request('status.get', { sessionId })).permission!.network, 'unrestricted');
    assert.equal(requests.filter((request) => request.method === 'run.start').length, 0);
  } finally {
    instance.unmount();
  }
}, { interactive: true, permissionControl: true }));
