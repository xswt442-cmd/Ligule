import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { confirmWorkspaceTrust } from '../dist/tui/trust.js';
import { isTrusted, setTrusted } from '../dist/tui/trust-store.js';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { isTTY: boolean; columns: number };

const testRoot = resolve('testplace/tmp');

async function withSandbox<T>(run: (root: string) => Promise<T>) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'tui-trust-ui-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function terminal() {
  const stdout: FakeOutput = Object.assign(new PassThrough(), { columns: 90, isTTY: true });
  let painted = '';
  stdout.on('data', (chunk: Buffer | string) => { painted += chunk.toString(); });
  const stdin: FakeInput = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });
  return { stdin, stdout, painted: () => painted };
}

type Terminal = ReturnType<typeof terminal>;

async function waitForPrompt(tty: Terminal) {
  const deadline = Date.now() + 2_000;
  while (!tty.painted().includes('退出')) {
    if (Date.now() > deadline) throw new Error('trust prompt did not render');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

test('Enter on the default Exit option does not save trust', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const trustFile = join(root, 'trust.json');
    await mkdir(directory);
    const tty = terminal();
    const result = confirmWorkspaceTrust(directory, { stdin: tty.stdin as unknown as NodeJS.ReadStream, stdout: tty.stdout as unknown as NodeJS.WriteStream, trustFile });
    await waitForPrompt(tty);
    tty.stdin.write('\r');
    assert.equal(await result, false);
    assert.equal(await isTrusted(directory, trustFile), false);
    await assert.rejects(readFile(trustFile), (error: unknown) => (error as { code?: string }).code === 'ENOENT');
  });
});

test('Up and Enter trust the workspace and remember the choice', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const trustFile = join(root, 'trust.json');
    await mkdir(directory);
    const tty = terminal();
    const result = confirmWorkspaceTrust(directory, { stdin: tty.stdin as unknown as NodeJS.ReadStream, stdout: tty.stdout as unknown as NodeJS.WriteStream, trustFile });
    await waitForPrompt(tty);
    tty.stdin.write('\u001b[A');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    tty.stdin.write('\r');
    assert.equal(await result, true);
    assert.equal(await isTrusted(directory, trustFile), true);
  });
});

test('Escape exits and pasted y does not approve trust', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const trustFile = join(root, 'trust.json');
    await mkdir(directory);
    const tty = terminal();
    const result = confirmWorkspaceTrust(directory, { stdin: tty.stdin as unknown as NodeJS.ReadStream, stdout: tty.stdout as unknown as NodeJS.WriteStream, trustFile });
    await waitForPrompt(tty);
    tty.stdin.write('y');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    tty.stdin.write('\u001b');
    assert.equal(await result, false);
    assert.equal(await isTrusted(directory, trustFile), false);
  });
});

test('an already trusted workspace returns without rendering a prompt', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const trustFile = join(root, 'trust.json');
    await mkdir(directory);
    await setTrusted(directory, true, trustFile);
    const tty = terminal();
    assert.equal(await confirmWorkspaceTrust(directory, { stdin: tty.stdin as unknown as NodeJS.ReadStream, stdout: tty.stdout as unknown as NodeJS.WriteStream, trustFile }), true);
    assert.equal(tty.painted(), '');
  });
});
