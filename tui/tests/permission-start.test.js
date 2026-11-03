import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createConfig } from '../../core/dist/kernel/config.js';
import { detectPermissionCapabilities } from '../../core/dist/capability/permission-capabilities.js';
import { hostProviderFromConfig } from '../../core/dist/host/host.js';
import { runTui } from '../dist/tui/start.js';
import { waitFor } from '../../core/tests/helpers/tui-host.ts';

function createTerminal() {
  const stdout = Object.assign(new PassThrough(), { columns: 180, rows: 30, isTTY: true });
  const stderr = new PassThrough();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => {},
    unref: () => {},
  });
  let output = '';
  stdout.on('data', (chunk) => { output += chunk.toString(); });
  return { stdin, stdout, stderr, output: () => output };
}

function plainOutput(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

test('runTui reports the platform capability snapshot supplied to its Host', { timeout: 30_000 }, async () => {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'tui-permission-start-'));
  const projectDirectory = join(directory, 'project');
  const sessionDirectory = join(directory, 'sessions');
  await Promise.all([mkdir(projectDirectory), mkdir(sessionDirectory)]);
  const config = createConfig({ user: {
    boundary: projectDirectory,
    workspaceRoot: projectDirectory,
    host: { sessionDirectory },
  } });
  const terminal = createTerminal();
  const snapshot = await detectPermissionCapabilities({ shellConfig: config, workspaceRoot: projectDirectory });
  let finished = false;
  let runError;
  const running = runTui({
    config,
    provider: hostProviderFromConfig(config),
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
    await waitFor(() => terminal.output().includes('Describe a task'), { within: 10_000, read: terminal.output });
    assert.equal(runError, undefined);
    terminal.stdin.write('/permission');
    await waitFor(() => plainOutput(terminal.output()).includes('/permission'), { within: 10_000, read: terminal.output });
    terminal.stdin.write('\r');
    const levels = snapshot.capabilities;
    const measured = [
      `read ${levels.filesystemRead}`,
      `write ${levels.filesystemWrite}`,
      `network ${levels.network}`,
      `process ${levels.process}`,
    ];
    await waitFor(() => measured.every((value) => plainOutput(terminal.output()).includes(value)), { within: 10_000, read: terminal.output });

    terminal.stdin.write('\u001b');
    await delay(100);
    terminal.stdin.write('/quit');
    await delay(100);
    terminal.stdin.write('\r');
    await waitFor(() => finished, { within: 10_000, read: terminal.output });
    await running;
    assert.equal(runError, undefined);
  } finally {
    if (!finished) terminal.stdin.write('\u0003');
    await running;
    terminal.stdin.end();
    terminal.stdout.end();
    terminal.stderr.end();
    await rm(directory, { recursive: true, force: true });
  }
});
