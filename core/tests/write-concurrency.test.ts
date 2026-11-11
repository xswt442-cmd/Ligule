import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../dist/host/host.js';
import type { Host } from '../dist/host/host.js';
import type { ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import { createConfig, createPermissionContext, MESSAGES_CAPABILITIES } from '../dist/index.js';
import { testHostProvider } from './helpers/provider.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const workspaceWrite = createPermissionContext('workspace-write', 'disabled', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});

test('two Sessions in one Host preserve simultaneous exact edits to different parts of one file', async () => {
  const temporaryRoot = process.env.LIGULE_TEST_TEMP_ROOT ?? join(repository, 'testplace', 'tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'write-concurrency-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const sessions = join(workspace, '.ligule', 'sessions');
  const target = join(workspace, 'target.txt');
  const previousHome = process.env.LIGULE_HOME;
  const padding = 'x'.repeat(2 * 1024 * 1024);
  let host: Host | undefined;
  await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
  process.env.LIGULE_HOME = home;

  let arrivals = 0;
  let releasePair = (): void => {};
  let pairReady = new Promise<void>((resolve) => { releasePair = resolve; });
  const resetPair = () => {
    arrivals = 0;
    pairReady = new Promise<void>((resolve) => { releasePair = resolve; });
  };
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'write-concurrency-test',
    async *stream(request: ModelRequest): AsyncGenerator<ProviderEvent> {
      const userAt = request.messages.findLastIndex((message) => message.role === 'user');
      const currentMessages = request.messages.slice(userAt + 1);
      if (currentMessages.some((message) => message.role === 'tool')) {
        yield { type: 'text', text: 'done' };
        return;
      }
      const lastUser = request.messages[userAt];
      const writerA = lastUser?.role === 'user' && lastUser.text.includes('writer A');
      arrivals += 1;
      if (arrivals === 2) releasePair();
      await pairReady;
      yield {
        type: 'tool-call',
        id: writerA ? 'write-a' : 'write-b',
        name: 'edit',
        args: {
          path: writerA ? 'target.txt' : './target.txt',
          changes: [{ oldText: writerA ? 'A_ANCHOR' : 'B_ANCHOR', newText: writerA ? 'A_CHANGED' : 'B_CHANGED' }],
        },
      };
    },
  });
  const config = createConfig({ user: {
    boundary: workspace,
    workspaceRoot: workspace,
    host: { sessionDirectory: sessions },
  } });
  const client = { notify() {}, async request(method: string) { throw new Error(`unexpected ${method}`); } };

  try {
    host = createHost({ config, provider, permission: workspaceWrite, policy: { mode: 'auto' }, interactive: false });
    const sessionA = await host.handle({ method: 'session.create', params: { projectRoot: workspace } }, client) as { sessionId: string };
    const sessionB = await host.handle({ method: 'session.create', params: { projectRoot: workspace } }, client) as { sessionId: string };

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await writeFile(target, `A_ANCHOR\n${padding}\nB_ANCHOR\n`, 'utf8');
      resetPair();
      await Promise.all([
        host.handle({ method: 'run.start', params: { sessionId: sessionA.sessionId, input: 'writer A' } }, client),
        host.handle({ method: 'run.start', params: { sessionId: sessionB.sessionId, input: 'writer B' } }, client),
      ]);
      const result = await readFile(target, 'utf8');
      assert.ok(result.includes('A_CHANGED'), `attempt ${attempt + 1} lost writer A's edit`);
      assert.ok(result.includes('B_CHANGED'), `attempt ${attempt + 1} lost writer B's edit`);
    }
  } finally {
    await host?.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
