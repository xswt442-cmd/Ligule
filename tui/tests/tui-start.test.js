import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createConfig } from '../../core/dist/kernel/config.js';
import { DEFAULT_MODE, modeDirectories } from '../../core/dist/kernel/modes.js';
import { hostProviderFromConfig } from '../../core/dist/host/host.js';
import { listSessions } from '../../core/dist/session/list.js';
import { createSessionLog } from '../../core/dist/session/session.js';
import { runTui } from '../dist/tui/start.js';
import { readInput } from '../dist/tui/input-store.js';
import { completeFrame } from './helpers/frames.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

async function createTerminal() {
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 30, isTTY: true });
  const stderr = new PassThrough();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => {},
    unref: () => {},
  });
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk.toString(); });
  return { stdin, stdout, stderr, frame: () => completeFrame(painted), allOutput: () => painted };
}

async function typeAndSubmit(terminal, text) {
  terminal.stdin.write(text);
  const draft = `› ${text}`;
  await waitFor(() => terminal.frame().includes(draft) || terminal.allOutput().slice(-1_000).includes(draft), { within: 10_000, read: terminal.allOutput });
  terminal.stdin.write('\r');
}

function visible(terminal, text) {
  return terminal.frame().includes(text) || terminal.allOutput().includes(text);
}

test('runTui starts without a model, records the failed turn, stays usable, and releases its lock', { timeout: 180_000 }, async () => {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'tui-start-pending-'));
  const absoluteDirectory = resolve(directory);
  assert.equal(absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  const projectDirectory = join(directory, 'project');
  const sessionDirectory = join(directory, 'sessions');
  await Promise.all([mkdir(projectDirectory), mkdir(sessionDirectory)]);

  const config = createConfig({ user: {
    boundary: projectDirectory,
    workspaceRoot: projectDirectory,
    host: { sessionDirectory },
    policy: { mode: 'ask' },
  } });
  const modesDirectory = fileURLToPath(new URL('../../core/modes/', import.meta.url));
  const terminal = await createTerminal();
  let finished = false;
  let runError;
  const running = runTui({
    config,
    provider: hostProviderFromConfig(config),
    policy: config.policy,
    modeName: DEFAULT_MODE,
    modePaths: modeDirectories(projectDirectory, modesDirectory),
    locale: 'en',
    stdout: terminal.stdout,
    stdin: terminal.stdin,
    stderr: terminal.stderr,
    historyFile: join(directory, 'history.jsonl'),
    inputFile: join(directory, 'inputs.jsonl'),
    keyFile: join(directory, 'keys.json'),
  }).then(
    () => { finished = true; },
    (error) => { runError = error; finished = true; },
  );

  try {
    await waitFor(() => finished || visible(terminal, 'Describe a task'), { within: 10_000, read: terminal.allOutput });
    assert.equal(runError, undefined);
    assert.equal(finished, false, 'the TUI remains open after the initial frame');

    await typeAndSubmit(terminal, '/model');
    await waitFor(() => visible(terminal, 'No model services configured'), { within: 10_000, read: terminal.allOutput });

    await typeAndSubmit(terminal, 'ordinary input without a model');
    await waitFor(() => visible(terminal, 'host_model_config_missing'), { within: 10_000, read: terminal.allOutput });
    assert.equal(finished, false, 'a failed model request does not exit the TUI');

    const sessions = await listSessions(sessionDirectory, { projectRoot: projectDirectory });
    assert.equal(sessions.length, 1);
    const record = await createSessionLog({ directory: sessionDirectory, id: sessions[0].id }).read();
    const failedTurn = record.find((event) => event.kind === 'turn');
    assert.equal(failedTurn.status, 'failed');
    assert.equal(failedTurn.code, 'host_model_config_missing');

    await typeAndSubmit(terminal, '/help');
    await waitFor(() => visible(terminal, '/resume <id> [mode]'), { within: 10_000, read: terminal.allOutput });
    assert.equal(finished, false, 'help remains available after the failed turn');
    terminal.stdin.write('\u001b');
    await waitFor(() => terminal.frame().includes('Describe a task') && !terminal.frame().includes('Prompt templates'), { within: 10_000, read: terminal.allOutput });

    await typeAndSubmit(terminal, '/quit');
    await waitFor(() => finished, { within: 10_000, read: terminal.allOutput });
    await running;

    const nextOwner = createSessionLog({ directory: sessionDirectory, id: sessions[0].id });
    await nextOwner.acquire();
    await nextOwner.close();
    assert.deepEqual(await readInput(join(directory, 'inputs.jsonl'), projectDirectory, sessions[0].id), { projectRoot: projectDirectory, sessionId: sessions[0].id, draft: '', queued: [] });
  } finally {
    if (!finished) {
      terminal.stdin.write('\u0003');
      await waitFor(() => finished, { within: 10_000, read: terminal.allOutput }).catch(() => {});
    }
    await running;
    terminal.stdin.end();
    terminal.stdout.end();
    terminal.stderr.end();
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
});

test('Ctrl+C saves a fresh unsent draft before the debounce interval', { timeout: 20_000 }, async () => {
  const scratch = resolve('testplace/tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'tui-exit-'));
  const projectDirectory = join(directory, 'project');
  const sessionDirectory = join(directory, 'sessions');
  await mkdir(projectDirectory);
  const config = createConfig({ user: { boundary: projectDirectory, workspaceRoot: projectDirectory, host: { sessionDirectory } } });
  const terminal = await createTerminal();
  let finished = false;
  const running = runTui({
    config, provider: hostProviderFromConfig(config),
    modeName: DEFAULT_MODE, modePaths: modeDirectories(projectDirectory, fileURLToPath(new URL('../../core/modes/', import.meta.url))),
    locale: 'en', stdout: terminal.stdout, stdin: terminal.stdin, stderr: terminal.stderr,
    historyFile: join(directory, 'history.jsonl'), inputFile: join(directory, 'inputs.jsonl'), keyFile: join(directory, 'keys.json'),
  }).finally(() => { finished = true; });
  try {
    await waitFor(() => visible(terminal, 'Describe a task'), { within: 10_000, read: terminal.allOutput });
    terminal.stdin.write('unsent fresh draft');
    await waitFor(() => visible(terminal, '› unsent fresh draft'), { within: 10_000, read: terminal.allOutput });
    terminal.stdin.write('\u0003');
    await running;
    const sessions = await listSessions(sessionDirectory, { projectRoot: projectDirectory });
    assert.equal(sessions.length, 1);
    assert.deepEqual(await readInput(join(directory, 'inputs.jsonl'), projectDirectory, sessions[0].id), { projectRoot: projectDirectory, sessionId: sessions[0].id, draft: 'unsent fresh draft', queued: [] });
  } finally {
    if (!finished) terminal.stdin.write('\u0003');
    await running;
    terminal.stdin.end();
    terminal.stdout.end();
    terminal.stderr.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the credentials command shows the reference and source without exposing the secret', { timeout: 180_000 }, async () => {
  await withTuiHost(async ({ client, projectDirectory, sessionId }) => {
    const React = await import('react');
    const { render } = await import('ink');
    const { App } = await import('../dist/tui/app.js');
    const terminal = await createTerminal();
    const instance = render(React.createElement(App, {
      client,
      sessionId,
      info: { boundary: projectDirectory },
      locale: 'en',
      interactive: true,
      history: { entries: [], remember: async () => [] },
      inputs: { read: async () => ({ draft: '', queued: [] }), write: async () => {} },
      keys: { read: async () => ({ overrides: {}, refused: [] }), write: async () => {} },
    }), { stdout: terminal.stdout, stdin: terminal.stdin, stderr: terminal.stderr, exitOnCtrlC: false, patchConsole: false, interactive: true });

    try {
      await waitFor(() => visible(terminal, 'Describe a task'), { within: 10_000, read: terminal.allOutput });
      await typeAndSubmit(terminal, '/credentials');
      await waitFor(() => visible(terminal, 'LIGULE_TUI_TEST_API_KEY') && visible(terminal, 'environment'), { within: 10_000, read: terminal.allOutput });
      assert.doesNotMatch(terminal.allOutput(), /test-key/u);
    } finally {
      instance.unmount();
      terminal.stdin.end();
      terminal.stdout.end();
      terminal.stderr.end();
    }
  });
});
