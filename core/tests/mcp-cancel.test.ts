import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createConfig, createConnection, createMemoryConnectionPair, createMcpRegistry, MESSAGES_CAPABILITIES,
  modeDirectories, mcpServerConfigs, serveHost, createPermissionContext,
} from '../dist/index.js';
import { listMcpTrust, mcpTrustPathOf, setMcpServerTrust } from '../dist/host/mcp-trust.js';
import type { HostOptions } from '../dist/host/host.js';
import type { HostProvider } from '../dist/host/provider.js';
import type { ModelRequest } from '../dist/kernel/loop.js';

type CodedError = { code?: string };
type SessionEventView = { kind: string; tool?: string; result: { content: { schemaDigest: string } } };
type TrustView = { version: string; servers: { identityDigest: string; trust: { trusted: boolean } }[] };

const fixturePath = fileURLToPath(new URL('./fixtures/mcp-cancellable.mjs', import.meta.url));
const externalPermission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'full',
});

async function withDirectory(run: (directory: string) => Promise<void>) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'mcp-cancel-'));
  const absoluteDirectory = resolve(directory);
  assert.equal(absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  try {
    await run(directory);
  } finally {
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`mcp_fixture_marker_missing: ${path}`);
}

async function waitForProcessExit(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the fixture must publish a positive process id');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as CodedError).code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`mcp_fixture_process_still_running: ${pid}`);
}

function registryFor(directory: string, { initializeDelay = 0, listDelay = 0, disconnectAfterCall = false }: { initializeDelay?: number; listDelay?: number; disconnectAfterCall?: boolean } = {}) {
  const pidPath = join(directory, 'mcp.pid');
  const listStartedPath = join(directory, 'list.started');
  const callStartedPath = join(directory, 'call.started');
  const configs = mcpServerConfigs({ mcp: { servers: { slow: {
    command: process.execPath,
    args: [fixturePath, pidPath, listStartedPath, callStartedPath, String(initializeDelay), String(listDelay), String(disconnectAfterCall)],
  } } } });
  return { registry: createMcpRegistry(configs), pidPath, listStartedPath, callStartedPath };
}

async function rejectedQuickly(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await Promise.race([
    promise.then(() => ({ status: 'resolved' }), (error: unknown) => ({ status: 'rejected', error })),
    delay(2000).then(() => ({ status: 'timeout' })),
  ]);
  assert.equal(outcome.status, 'rejected', 'the SDK request rejects promptly after cancellation');
  return 'error' in outcome ? outcome.error : undefined;
}

test('the SDK cancels a real delayed MCP tool call through AbortSignal', async () => {
  await withDirectory(async (directory) => {
    const { registry, pidPath, callStartedPath } = registryFor(directory);
    try {
      const definition = await registry.definition('slow', 'wait');
      assert.equal(definition.name, 'wait');
      const controller = new AbortController();
      const pending = registry.call('slow', 'wait', { milliseconds: 30000 }, controller.signal);
      await waitForFile(callStartedPath);
      const cancelled = rejectedQuickly(pending);
      controller.abort();
      const error = await cancelled;
      assert.ok(error instanceof Error);
    } finally {
      await registry.close();
    }
    await waitForProcessExit(Number(await readFile(pidPath, 'utf8')));
  });
});

test('a timed out call is not replayed and the same connection can serve a later call', async () => {
  await withDirectory(async (directory) => {
    const { registry, pidPath, callStartedPath } = registryFor(directory);
    try {
      await registry.definition('slow', 'wait');
      const error = await rejectedQuickly(registry.call('slow', 'wait', { milliseconds: 30000 }, AbortSignal.timeout(100)));
      assert.ok(error instanceof Error);
      const recovered = await registry.call('slow', 'wait', { milliseconds: 1 }) as { content: { text: string }[] };
      assert.equal(recovered.content[0].text, 'waited 1 ms');
      assert.equal((await readFile(callStartedPath, 'utf8')).trim().split(/\r?\n/).length, 2, 'the timed out call was dispatched once');
    } finally {
      await registry.close();
    }
    await waitForProcessExit(Number(await readFile(pidPath, 'utf8')));
  });
});

test('a real stdio disconnect fails without retry, then a new registry explicitly reconnects', async () => {
  await withDirectory(async (directory) => {
    const disconnected = registryFor(directory, { disconnectAfterCall: true });
    let oldProcessId;
    try {
      await disconnected.registry.definition('slow', 'wait');
      oldProcessId = Number(await readFile(disconnected.pidPath, 'utf8'));
      await rejectedQuickly(disconnected.registry.call('slow', 'wait', { milliseconds: 1 }));
      await waitForProcessExit(oldProcessId);
      await rejectedQuickly(disconnected.registry.toolsOf('slow'));
      assert.equal(Number(await readFile(disconnected.pidPath, 'utf8')), oldProcessId, 'the registry did not start another server process');
      assert.equal((await readFile(disconnected.callStartedPath, 'utf8')).trim().split(/\r?\n/).length, 1, 'the disconnected call was dispatched once');
    } finally {
      await disconnected.registry.close();
    }
    await waitForProcessExit(oldProcessId);

    const rebuilt = registryFor(directory);
    let newProcessId;
    try {
      const definition = await rebuilt.registry.definition('slow', 'wait');
      newProcessId = Number(await readFile(rebuilt.pidPath, 'utf8'));
      assert.notEqual(newProcessId, oldProcessId, 'explicit registry recreation starts a new server process');
      const recovered = await rebuilt.registry.call('slow', 'wait', { milliseconds: 1 }) as { content: { text: string }[] };
      assert.equal(recovered.content[0].text, 'waited 1 ms');
      assert.equal((await readFile(rebuilt.callStartedPath, 'utf8')).trim().split(/\r?\n/).length, 2, 'only the explicitly issued call reached the new process');
      assert.equal(definition.name, 'wait');
    } finally {
      await rebuilt.registry.close();
    }
    await waitForProcessExit(newProcessId);
  });
});

test('cancellation stops MCP initialization and tools/list requests', async () => {
  await withDirectory(async (directory) => {
    const initializing = registryFor(directory, { initializeDelay: 30000 });
    try {
      const controller = new AbortController();
      const pending = initializing.registry.toolsOf('slow', controller.signal);
      await waitForFile(initializing.pidPath);
      const cancelled = rejectedQuickly(pending);
      controller.abort();
      assert.ok(await cancelled instanceof Error);
    } finally {
      await initializing.registry.close();
    }
    await waitForProcessExit(Number(await readFile(initializing.pidPath, 'utf8')));

    const listing = registryFor(directory, { listDelay: 30000 });
    try {
      const controller = new AbortController();
      const pending = listing.registry.toolsOf('slow', controller.signal);
      await waitForFile(listing.listStartedPath);
      const cancelled = rejectedQuickly(pending);
      controller.abort();
      assert.ok(await cancelled instanceof Error);
    } finally {
      await listing.registry.close();
    }
    await waitForProcessExit(Number(await readFile(listing.pidPath, 'utf8')));
  });
});

test('revoking MCP trust ends its stdio server while an operation is running', { timeout: 15000 }, async () => {
  await withDirectory(async (directory) => {
    const project = join(directory, 'project');
    const home = join(directory, 'home');
    const sessionDirectory = join(directory, 'sessions');
    await Promise.all([mkdir(project), mkdir(home), mkdir(sessionDirectory)]);
    const pidPath = join(directory, 'mcp.pid');
    const listStartedPath = join(directory, 'list.started');
    const callStartedPath = join(directory, 'call.started');
    const serverSettings = {
      command: process.execPath,
      args: [fixturePath, pidPath, listStartedPath, callStartedPath, '0', '0'],
    };
    const priorHome = process.env.LIGULE_HOME;
    process.env.LIGULE_HOME = home;
    const config = createConfig({ user: {
      boundary: project,
      host: { sessionDirectory },
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'host-cancel-test' },
      loop: { iterations: 4, modelCalls: 4 },
      mcp: { servers: { slow: serverSettings } },
      policy: { mode: 'auto' },
    } });
    const trustPath = mcpTrustPathOf();
    const trustVersion = (await listMcpTrust(trustPath)).version;
    const identity = mcpServerConfigs({ mcp: { servers: { slow: serverSettings } } }, process.env, project)[0].identityDigest;
    await setMcpServerTrust(trustPath, { scope: 'project', projectRoot: project, server: 'slow', identityDigest: identity, trusted: true }, trustVersion);
    let phase = 0;
    const provider = {
      name: 'local-operation-provider',
      model: 'host-cancel-test',
      capabilities: MESSAGES_CAPABILITIES,
      async *stream(request: ModelRequest, { signal }: { signal?: AbortSignal } = {}) {
        if (signal?.aborted) throw signal.reason;
        const lastUser = [...request.messages].reverse().find((message) => message.role === 'user') as { text: string };
        const operation = JSON.parse(lastUser.text);
        if (operation.tool === 'mcp.inspect' && phase === 0) {
          phase += 1;
          yield { type: 'tool-call', id: 'inspect', name: 'mcp.inspect', args: operation.args };
        } else if (operation.tool === 'mcp.inspect') {
          yield { type: 'text', text: 'definition read' };
        } else {
          yield { type: 'tool-call', id: 'call', name: 'mcp.call', args: operation.args };
        }
      },
    } as unknown as HostProvider;
    const pair = createMemoryConnectionPair();
    const host = serveHost({
      ...pair.host,
      config,
      provider,
      policy: config.policy as HostOptions['policy'],
      permission: externalPermission,
      interactive: true,
      permissionControl: true,
      modeName: 'minimal',
      modePaths: modeDirectories(project, fileURLToPath(new URL('../modes/', import.meta.url)), home),
    });
    const client = createConnection(pair.client);
    client.onRequest(async (message) => {
      if (message.method === 'approval.request') return { decision: 'allow' };
      throw new Error(`unexpected client request: ${message.method}`);
    });
    try {
      const { sessionId } = await client.request('session.create', {}) as { sessionId: string };
      await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'mcp.inspect', args: { server: 'slow', tool: 'wait' } }),
      });
      const { events } = await client.request('session.read', { sessionId }) as { events: SessionEventView[] };
      const inspected = events.find((event) => event.kind === 'tool' && event.tool === 'mcp.inspect') as SessionEventView;
      const schemaDigest = inspected.result.content.schemaDigest;
      const callInput = JSON.stringify({
        tool: 'mcp.call',
        args: {
          server: 'slow',
          tool: 'wait',
          arguments: JSON.stringify({ milliseconds: 30000 }),
          schemaDigest,
        },
      });
      const startedAt = Date.now();
      const settled = client.request('run.start', { sessionId, input: callInput }).then(
        (value) => ({ status: 'resolved', value }),
        (error) => ({ status: 'rejected', error }),
      );
      await waitForFile(callStartedPath);
      const processId = Number(await readFile(pidPath, 'utf8'));
      const trust = await client.request('mcp.trust.list', { projectRoot: project }) as TrustView;
      assert.equal(trust.servers[0].trust.trusted, true);
      await client.request('mcp.trust.set', {
        projectRoot: project, server: 'slow', identityDigest: trust.servers[0].identityDigest,
        scope: 'project', trusted: false, version: trust.version,
      });
      await waitForProcessExit(processId);
      await host.release();
      const result = await settled;
      assert.equal(result.status, 'rejected');
      assert.ok(Date.now() - startedAt < 5000, 'revoking trust and stopping the Host finish the delayed operation promptly');
    } finally {
      pair.client.output.end();
      await host.release();
      if (priorHome === undefined) delete process.env.LIGULE_HOME;
      else process.env.LIGULE_HOME = priorHome;
    }
  });
});
