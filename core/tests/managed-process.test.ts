import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig, createDecisionChain, createKernel, createManagedProcessRegistry, createPermissionContext, managedProcessPlugin, managedProcessTool } from '../dist/index.js';
import { isTrusted, setTrusted } from '../dist/kernel/workspace-trust.js';

// Kernel 调用与 Registry 的公开结果都是不透明记录，这里按测试实际读取的字段声明其形状。
type ManagedProcessResult = {
  id: string;
  status: string;
  ready: boolean;
  port: number;
  logs: string;
  failure: string;
  startupFailure: { code: string };
  terminationFailure: { code: string | null; detail: string };
  terminationPending: boolean;
  cleanupPending: boolean;
};

const permission = createPermissionContext('workspace-write', 'unrestricted', {
  filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
}, {
  profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
  limitations: ['Windows workspace-write provides partial filesystem and network isolation.'],
  partialWorkspaceWriteConfirmationRequired: true,
  partialWorkspaceWriteConfirmed: true,
  workspaceTrusted: true,
});

async function availableLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForRequest(url: string): Promise<Response> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      return response;
    } catch {
      await delay(20);
    }
  }
  assert.fail(`server at ${url} did not accept an HTTP request`);
}

async function waitForUnavailable(url: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
    } catch {
      return;
    }
    await delay(20);
  }
  assert.fail(`server at ${url} remained reachable`);
}

async function waitForFile(path: string, within = 5_000): Promise<void> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(20);
  }
  assert.fail(`file ${path} was not created`);
}

async function healthUrl(t: TestContext): Promise<URL> {
  const server = createHttpServer((_request, response) => {
    response.statusCode = 200;
    response.end('ready');
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  t.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return new URL(`http://127.0.0.1:${address.port}/health`);
}

function managedLease(onStop: (calls: number, finish: (code: number) => void) => void | Promise<void> = (_calls, finish) => finish(0)) {
  let finish!: (value: number) => void;
  let fail!: (reason: unknown) => void;
  const completion = new Promise<number>((resolve, reject) => { finish = resolve; fail = reject; });
  let calls = 0;
  return {
    lease: {
      completion,
      logs: () => '',
      async stop() {
        calls += 1;
        return onStop(calls, finish);
      },
    },
    finish,
    fail,
    get calls() { return calls; },
  };
}

test('managed process start returns after loopback readiness and stop releases its port', async (t) => {
  const previousHome = process.env.LIGULE_HOME;
  const directory = await mkdtemp(join(tmpdir(), 'ligule-managed-process-'));
  const workspace = join(directory, 'workspace');
  const home = join(directory, 'home');
  await Promise.all([mkdir(workspace), mkdir(home)]);
  process.env.LIGULE_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  });
  const port = await availableLoopbackPort();
  const url = `http://127.0.0.1:${port}/`;
  await writeFile(join(workspace, 'server.mjs'), "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
  const command = `node "${join(workspace, 'server.mjs').replaceAll('\\', '/')}" ${port}`;
  const kernel = createKernel({
    config: createConfig({ user: { boundary: workspace } }),
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
    permission,
  });
  await setTrusted(workspace, true);
  let grantActive = true;
  const registry = createManagedProcessRegistry({
    validateOwner: async () => {
      if (!grantActive) throw new Error('delegation grant revoked');
    },
  });
  const dispose = managedProcessPlugin(registry).setup(kernel) as () => void;
  t.after(async () => {
    await dispose();
    await registry.close();
  });

  let started: ManagedProcessResult;
  try {
    started = await kernel.call('managed_process', { action: 'start', command, readyUrl: url }) as ManagedProcessResult;
  } catch (error) {
    const failure = error as { code?: string; detail?: unknown };
    if (process.platform === 'linux' && failure.code === 'permission_sandbox_unavailable'
      && String(failure.detail ?? '').includes('bwrap: setting up uid map: Permission denied')) {
      t.skip('this Linux runner denies bubblewrap user-namespace mapping');
      return;
    }
    throw error;
  }
  assert.equal(started.status, 'running');
  assert.equal(started.ready, true);
  assert.equal(started.port, port);
  const response = await waitForRequest(url);
  assert.equal(await response.text(), 'managed-ready');

  const status = await kernel.call('managed_process', { action: 'status', id: started.id }) as ManagedProcessResult;
  assert.equal(status.status, 'running');
  assert.match(status.logs, /listening/);

  const stopped = await kernel.call('managed_process', { action: 'stop', id: started.id }) as ManagedProcessResult;
  assert.equal(stopped.status, 'stopped');
  await waitForUnavailable(url);

  const latePort = await availableLoopbackPort();
  const lateUrl = `http://127.0.0.1:${latePort}/`;
  const latePath = join(workspace, 'late-server.mjs');
  const startedMarker = join(workspace, 'late-server-started.txt');
  const lateMarker = join(workspace, 'late-server-ran.txt');
  await writeFile(latePath, [
    "import { writeFileSync } from 'node:fs';",
    "import { createServer } from 'node:http';",
    `writeFileSync(new URL('./late-server-started.txt', import.meta.url), 'started');`,
    `setTimeout(() => { writeFileSync(new URL('./late-server-ran.txt', import.meta.url), 'late'); createServer((_request, response) => response.end('late')).listen(${latePort}, '127.0.0.1'); }, 800);`,
  ].join('\n'));
  const controller = new AbortController();
  const pendingStart = kernel.call('managed_process', {
    action: 'start',
    command: `node "${latePath.replaceAll('\\', '/')}"`,
    readyUrl: lateUrl,
  }, { signal: controller.signal });
  await waitForFile(startedMarker);
  controller.abort();
  await assert.rejects(pendingStart, { code: 'exec_cancelled' });
  await delay(1_000);
  assert.equal(existsSync(lateMarker), false, 'cancellation prevents the delayed server from starting');
  await waitForUnavailable(lateUrl);

  const shortPort = await availableLoopbackPort();
  const shortUrl = `http://127.0.0.1:${shortPort}/`;
  const shortPath = join(workspace, 'short-server.mjs');
  await writeFile(shortPath, [
    "import { createServer } from 'node:http';",
    `const server = createServer((_request, response) => response.end('short-lived'));`,
    `server.listen(${shortPort}, '127.0.0.1', () => setTimeout(() => process.exit(0), 250));`,
  ].join('\n'));
  let shortStarted: ManagedProcessResult | undefined;
  try {
    shortStarted = await kernel.call('managed_process', {
      action: 'start',
      command: `node "${shortPath.replaceAll('\\', '/')}"`,
      readyUrl: shortUrl,
    }) as ManagedProcessResult;
  } catch (error) {
    const failure = error as { code: string };
    assert.ok(['managed_process_exited', 'managed_process_not_ready'].includes(failure.code), failure.code);
  }
  await waitForUnavailable(shortUrl);
  await delay(100);
  if (shortStarted !== undefined) {
    const deadline = Date.now() + 2_000;
    let status!: ManagedProcessResult;
    while (Date.now() < deadline) {
      status = await kernel.call('managed_process', { action: 'status', id: shortStarted.id }) as ManagedProcessResult;
      if (status.status !== 'running') break;
      await delay(20);
    }
    assert.notEqual(status.status, 'running', JSON.stringify(status));
  }

  const revokedPort = await availableLoopbackPort();
  const revokedUrl = `http://127.0.0.1:${revokedPort}/`;
  const revoked = await kernel.call('managed_process', {
    action: 'start',
    command: `node "${join(workspace, 'server.mjs').replaceAll('\\', '/')}" ${revokedPort}`,
    readyUrl: revokedUrl,
  }) as ManagedProcessResult;
  assert.equal((await waitForRequest(revokedUrl)).status, 200);
  grantActive = false;
  await waitForUnavailable(revokedUrl);
  const revokedStatusDeadline = Date.now() + 2_000;
  let revokedStatus!: ManagedProcessResult;
  while (Date.now() < revokedStatusDeadline) {
    revokedStatus = await kernel.call('managed_process', { action: 'status', id: revoked.id }) as ManagedProcessResult;
    if (revokedStatus.status === 'stopped') break;
    await delay(20);
  }
  assert.equal(revokedStatus.status, 'stopped', JSON.stringify(revokedStatus));
  assert.match(revokedStatus.failure, /Grant is no longer valid/);
});

test('an exec Policy denial also blocks managed start before spawning the command', async (t) => {
  const port = await availableLoopbackPort();
  const registry = createManagedProcessRegistry();
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    policy: createDecisionChain({ rules: [{ tool: 'exec', decision: 'deny' }] }),
    permission,
  });
  const dispose = managedProcessPlugin(registry).setup(kernel) as () => void;
  t.after(async () => {
    await dispose();
    await registry.close();
  });

  await assert.rejects(
    () => kernel.call('managed_process', {
      action: 'start',
      command: `node -e "require('http').createServer((request, response) => response.end('should-not-run')).listen(${port}, '127.0.0.1')"`,
      readyUrl: `http://127.0.0.1:${port}/`,
    }),
    { code: 'policy_denied' },
  );
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`));
});

test('managed process refuses readiness URLs outside loopback before starting a command', async () => {
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
    permission,
  });
  await setTrusted(process.cwd(), true);
  const registry = createManagedProcessRegistry();
  const dispose = managedProcessPlugin(registry).setup(kernel) as () => void;
  try {
    await assert.rejects(
      () => kernel.call('managed_process', { action: 'start', command: 'node -e "process.exit(0)"', readyUrl: 'https://example.com/' }),
      { code: 'managed_process_url_invalid' },
    );
  } finally {
    await dispose();
    await registry.close();
  }
});

test('managed process waits for a successful health response after a transient HTTP 503', async (t) => {
  let healthy = false;
  let requests = 0;
  const server = createHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = healthy ? 200 : 503;
    response.end();
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease!: (value: number) => void;
  const lease = {
    completion: new Promise<number>((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  t.after(async () => {
    await registry.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  let settled = false;
  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease).finally(() => { settled = true; });
  const deadline = Date.now() + 1_000;
  while (requests === 0 && Date.now() < deadline) await delay(10);
  assert.ok(requests > 0, 'readiness URL was checked');
  await delay(250);
  assert.equal(settled, false, 'HTTP 503 is not readiness');
  assert.ok(requests <= 6, `HTTP 503 retry was not bounded: ${requests} requests in 250ms`);

  healthy = true;
  const started = await pending;
  assert.equal(started.ready, true);
  assert.equal(started.status, 'running');
});

test('managed process becomes ready immediately on HTTP 200 without a retry delay', async (t) => {
  let requests = 0;
  const server = createHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = 200;
    response.end();
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease!: (value: number) => void;
  const lease = {
    completion: new Promise<number>((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  t.after(async () => {
    await registry.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const startedAt = Date.now();
  const started = await registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease);
  assert.equal(started.ready, true);
  assert.equal(requests, 1);
  assert.ok(Date.now() - startedAt < 500, 'HTTP 200 should not wait for the retry interval');
});

test('managed process retries after a timed-out health request and observes cancellation', async (t) => {
  let requests = 0;
  const server = createHttpServer(() => { requests += 1; });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease!: (value: number) => void;
  const lease = {
    completion: new Promise<number>((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  const controller = new AbortController();
  t.after(async () => {
    await registry.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease, controller.signal);
  const secondRequestDeadline = Date.now() + 1_800;
  while (requests < 2 && Date.now() < secondRequestDeadline) await delay(10);
  assert.equal(requests, 2, 'a timed-out request should be followed by a delayed retry');
  controller.abort();
  await assert.rejects(pending, { code: 'exec_cancelled' });
  assert.equal(requests, 2, 'cancellation should stop further probes');
});

test('cancelled managed startup preserves both cancellation and process-stop failure', async (t) => {
  let requests = 0;
  const server = createHttpServer(() => { requests += 1; });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  const stopFailure = Object.assign(new Error('simulated process-tree stop failure'), { code: 'exec_terminate_failed' });
  const owned = managedLease(() => { throw stopFailure; });
  const controller = new AbortController();
  t.after(async () => {
    await registry.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), owned.lease, controller.signal);
  const requestDeadline = Date.now() + 1_000;
  while (requests === 0 && Date.now() < requestDeadline) await delay(10);
  assert.equal(requests, 1, 'startup must be waiting for the health response before cancellation');
  controller.abort();

  let startFailure!: { detail: string };
  await assert.rejects(pending, (error) => {
    const failure = error as { code?: string; detail: string; cause?: unknown };
    startFailure = failure;
    assert.equal(failure.code, 'exec_cancelled');
    assert.match(failure.detail, /startup failed.*exec_cancelled.*termination (?:also )?failed.*exec_terminate_failed/u);
    assert.ok(failure.cause instanceof AggregateError);
    const errors = failure.cause.errors as unknown[];
    assert.equal(errors.length, 2);
    assert.equal(errors[1], stopFailure);
    assert.equal((errors[0] as { code?: string }).code, 'exec_cancelled');
    return true;
  });
  assert.equal(owned.calls, 2, 'a settled stop failure should receive the existing bounded retry');
  const id = /managed process ([a-f0-9-]{36}) startup failed/u.exec(startFailure.detail)?.[1];
  assert.ok(id, 'the failed process handle remains addressable for status inspection');
  const status = registry.status(id) as ManagedProcessResult;
  assert.equal(status.startupFailure.code, 'exec_cancelled');
  assert.equal(status.terminationFailure.code, 'exec_terminate_failed');
  assert.equal(status.terminationPending, true);
});

test('cancellation racing with natural process exit keeps the start cancelled and stops only once', async (t) => {
  let requests = 0;
  const server = createHttpServer(() => { requests += 1; });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let releaseStop!: () => void;
  const stopPending = new Promise<void>((resolve) => { releaseStop = resolve; });
  const owned = managedLease(() => stopPending);
  const finishLease = owned.finish;
  const controller = new AbortController();
  t.after(async () => {
    releaseStop();
    await registry.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), owned.lease, controller.signal);
  const requestDeadline = Date.now() + 1_000;
  while (requests === 0 && Date.now() < requestDeadline) await delay(10);
  assert.equal(requests, 1);
  controller.abort();
  const stopDeadline = Date.now() + 1_000;
  while (owned.calls === 0 && Date.now() < stopDeadline) await delay(1);
  assert.equal(owned.calls, 1, 'the abort listener must start one stop request');
  finishLease(0);
  await assert.rejects(pending, { code: 'exec_cancelled' });
  releaseStop();
  await registry.close();
  assert.equal(owned.calls, 1, 'natural exit must settle the shared stop without duplicating it');
});

test('managed process readiness exits promptly when the owned process terminates', async (t) => {
  let requests = 0;
  const server = createHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = 503;
    response.end();
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const registry = createManagedProcessRegistry();
  let finishLease!: (value: number) => void;
  const lease = {
    completion: new Promise<number>((resolve) => { finishLease = resolve; }),
    logs: () => '',
    async stop() { finishLease(0); },
  };
  t.after(async () => {
    await registry.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const pending = registry.start(new URL(`http://127.0.0.1:${address.port}/health`), lease);
  const firstRequestDeadline = Date.now() + 1_000;
  while (requests === 0 && Date.now() < firstRequestDeadline) await delay(10);
  assert.equal(requests, 1);
  finishLease(1);
  await assert.rejects(pending, { code: 'managed_process_exited' });
  assert.equal(requests, 1, 'process exit should stop further readiness probes');
});

test('a failed managed stop stays pending and Registry close retries it', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  const owned = managedLease((calls, finish) => {
    if (calls < 3) throw new Error(`simulated termination failure ${calls}`);
    finish(0);
  });
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;

  await assert.rejects(registry.stop(started.id), /simulated termination failure 2/u);
  assert.equal((registry.status(started.id) as ManagedProcessResult).status, 'failed');
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationPending, true);
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationFailure.code, null);
  assert.match((registry.status(started.id) as ManagedProcessResult).terminationFailure.detail, /simulated termination failure 2/u);

  await registry.close();
  assert.equal(owned.calls, 3);
  assert.equal((registry.status(started.id) as ManagedProcessResult).status, 'stopped');
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationPending, false);
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationFailure, undefined);
});

test('Registry close reports repeated managed stop failures instead of treating them as complete', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  const owned = managedLease(() => { throw new Error('simulated process may still be alive'); });
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;

  await assert.rejects(registry.stop(started.id), /simulated process may still be alive/u);
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationPending, true);
  await assert.rejects(registry.close(), /simulated process may still be alive/u);
  assert.equal(owned.calls, 4);
  assert.equal((registry.status(started.id) as ManagedProcessResult).status, 'failed');
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationPending, true);

  owned.finish(0);
  await registry.close();
  assert.equal((registry.status(started.id) as ManagedProcessResult).status, 'stopped');
});

test('Guardian and cleanup completion errors surface without reporting a stopped process', async (t) => {
  const ready = await healthUrl(t);
  for (const code of ['exec_guardian_failed', 'exec_sandbox_cleanup_failed', 'exec_termination_cleanup_failed']) {
    const registry = createManagedProcessRegistry();
    const failure = Object.assign(new Error(`simulated ${code}`), { code });
    const owned = managedLease(() => { throw failure; });
    const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
    owned.fail(failure);

    await assert.rejects(registry.stop(started.id), { code });
    const status = registry.status(started.id) as ManagedProcessResult;
    assert.equal(status.status, 'failed');
    assert.equal(status.terminationPending, code === 'exec_guardian_failed' || code === 'exec_termination_cleanup_failed');
    assert.equal(status.cleanupPending, code === 'exec_sandbox_cleanup_failed' || code === 'exec_termination_cleanup_failed');
    await assert.rejects(registry.close(), { code });
    assert.notEqual((registry.status(started.id) as ManagedProcessResult).status, 'stopped');
  }
});

test('a cleaned interrupted completion does not report unknown liveness or pending cleanup', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  const owned = managedLease();
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
  owned.fail(Object.assign(new Error('command ended with an unknown exit status'), { code: 'exec_process_interrupted' }));
  await delay(0);

  const status = registry.status(started.id) as ManagedProcessResult;
  assert.equal(status.status, 'failed');
  assert.equal(status.terminationPending, false);
  assert.equal(status.cleanupPending, false);
  await registry.close();
  assert.equal(owned.calls, 0, 'confirmed interruption and cleanup do not need another Lease stop');
});

test('a sandbox setup failure does not report that a command is running or needs cleanup', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  const owned = managedLease();
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
  owned.fail(Object.assign(new Error('sandbox setup failed before command creation'), { code: 'exec_sandbox_setup_failed' }));
  await delay(0);

  const status = registry.status(started.id) as ManagedProcessResult;
  assert.equal(status.status, 'failed');
  assert.equal(status.terminationPending, false);
  assert.equal(status.cleanupPending, false);
  await registry.close();
  assert.equal(owned.calls, 0);
});

test('Registry distinguishes confirmed termination from failed temporary cleanup and retries the cleanup', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  const cleanupFailure = Object.assign(new Error('temporary cleanup failed'), { code: 'exec_temp_cleanup_failed' });
  const owned = managedLease((calls, finish) => {
    if (calls === 1) throw cleanupFailure;
    finish(0);
  });
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
  owned.fail(cleanupFailure);
  await delay(0);

  const pending = registry.status(started.id) as ManagedProcessResult;
  assert.equal(pending.status, 'failed');
  assert.equal(pending.terminationPending, false);
  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.terminationFailure, undefined, 'a confirmed exit with cleanup pending is not a termination failure');

  await registry.close();
  const recovered = registry.status(started.id) as ManagedProcessResult;
  assert.equal(owned.calls, 2);
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.terminationPending, false);
  assert.equal(recovered.cleanupPending, false);
});

test('a timed-out cleanup retry preserves confirmed process termination', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  let releaseStop!: () => void;
  const stopPending = new Promise<void>((resolve) => { releaseStop = resolve; });
  const cleanupFailure = Object.assign(new Error('temporary cleanup failed'), { code: 'exec_temp_cleanup_failed' });
  const owned = managedLease(() => stopPending);
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
  owned.fail(cleanupFailure);
  await delay(0);

  const stopping = registry.stop(started.id);
  try {
    await assert.rejects(stopping, { code: 'exec_temp_cleanup_failed' });
    const pending = registry.status(started.id) as ManagedProcessResult;
    assert.equal(pending.status, 'failed');
    assert.equal(pending.terminationPending, false);
    assert.equal(pending.cleanupPending, true);
    assert.equal(pending.terminationFailure, undefined, 'a cleanup timeout is not a process termination failure');
  } finally {
    releaseStop();
  }

  await registry.close();
  const recovered = registry.status(started.id) as ManagedProcessResult;
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.terminationPending, false);
  assert.equal(recovered.cleanupPending, false);
});

test('Registry retains both liveness and cleanup uncertainty when both fail', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(async () => { await registry.close().catch(() => undefined); });
  const failure = Object.assign(new Error('termination and temporary cleanup are unconfirmed'), {
    code: 'exec_termination_cleanup_failed',
  });
  const owned = managedLease(() => { throw failure; });
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
  owned.fail(failure);
  await delay(0);

  const status = registry.status(started.id) as ManagedProcessResult;
  assert.equal(status.status, 'failed');
  assert.equal(status.terminationPending, true);
  assert.equal(status.cleanupPending, true);
  await assert.rejects(registry.close(), { code: 'exec_termination_cleanup_failed' });
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationPending, true);
  assert.equal((registry.status(started.id) as ManagedProcessResult).cleanupPending, true);
});

test('natural Lease completion during an explicit stop confirms process termination', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  let releaseStop!: () => void;
  const stopPending = new Promise<void>((resolve) => { releaseStop = resolve; });
  const owned = managedLease(() => stopPending);
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;

  const stopping = registry.stop(started.id);
  const stopStartedDeadline = Date.now() + 1_000;
  while (owned.calls === 0 && Date.now() < stopStartedDeadline) await delay(1);
  assert.equal(owned.calls, 1);
  assert.equal((registry.status(started.id) as ManagedProcessResult).status, 'stopping');

  owned.finish(3);
  const stopped = await stopping;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.terminationPending, false);

  releaseStop();
  await registry.close();
  assert.equal(owned.calls, 1);
});

test('concurrent and repeated close calls share one bounded Lease request when it never settles', { timeout: 20_000 }, async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  const owned = managedLease(() => new Promise<void>(() => {}));
  const started = await registry.start(ready, owned.lease) as ManagedProcessResult;

  const start = Date.now();
  const outcomes = await Promise.allSettled([registry.stop(started.id), registry.close()]);
  assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'
    && outcome.reason?.code === 'exec_terminate_failed'), JSON.stringify(outcomes));
  assert.ok(Date.now() - start < 7_000, 'concurrent close and stop must share the bounded attempt');
  assert.equal(owned.calls, 1, 'a timed-out Lease.stop request must not be duplicated concurrently');
  assert.equal((registry.status(started.id) as ManagedProcessResult).status, 'failed');
  assert.equal((registry.status(started.id) as ManagedProcessResult).terminationPending, true);

  const repeatStart = Date.now();
  await assert.rejects(registry.close(), { code: 'exec_terminate_failed' });
  assert.ok(Date.now() - repeatStart < 7_000, 'repeated close must reuse the pending stop request');
  assert.equal(owned.calls, 1, 'repeated close must not create another unsettled Lease.stop request');

  const retryStart = Date.now();
  await assert.rejects(registry.close(), { code: 'exec_terminate_failed' });
  assert.ok(Date.now() - retryStart < 7_000, 'a repeated close must reuse the one in-flight Lease request');
  assert.equal(owned.calls, 1, 'a timed-out Lease.stop request must not accumulate on repeated close');

  owned.finish(0);
  await registry.close();
});

test('Registry retains a bounded terminal history without pruning uncertain processes', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  const uncertain = managedLease(() => { throw new Error('simulated process may still be alive'); });
  const uncertainStart = await registry.start(ready, uncertain.lease) as ManagedProcessResult;
  await assert.rejects(registry.stop(uncertainStart.id), /simulated process may still be alive/u);

  const ids: string[] = [];
  for (let index = 0; index < 150; index += 1) {
    const owned = managedLease();
    const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
    ids.push(started.id);
    await registry.stop(started.id);
  }

  assert.equal((registry.status(uncertainStart.id) as ManagedProcessResult).status, 'failed');
  assert.equal((registry.status(uncertainStart.id) as ManagedProcessResult).terminationPending, true);
  assert.throws(() => registry.status(ids[0]), { code: 'managed_process_not_found' });
  assert.throws(() => registry.status(ids[21]), { code: 'managed_process_not_found' });
  assert.equal((registry.status(ids[22]) as ManagedProcessResult).status, 'stopped');
  assert.equal((registry.status(ids.at(-1)!) as ManagedProcessResult).status, 'stopped');

  uncertain.finish(0);
  await registry.close();
});

test('terminal history eviction follows completion time rather than start time', async (t) => {
  const ready = await healthUrl(t);
  const registry = createManagedProcessRegistry();
  t.after(() => registry.close());
  const longLived = managedLease(() => new Promise<void>(() => {}));
  const longStarted = await registry.start(ready, longLived.lease) as ManagedProcessResult;

  const ids: string[] = [];
  for (let index = 0; index < 150; index += 1) {
    const owned = managedLease();
    const started = await registry.start(ready, owned.lease) as ManagedProcessResult;
    ids.push(started.id);
    await registry.stop(started.id);
  }
  assert.equal((registry.status(longStarted.id) as ManagedProcessResult).status, 'running');
  assert.throws(() => registry.status(ids[0]), { code: 'managed_process_not_found' });
  assert.equal((registry.status(ids[22]) as ManagedProcessResult).status, 'stopped');

  longLived.finish(0);
  await longLived.lease.completion;
  assert.equal((registry.status(longStarted.id) as ManagedProcessResult).status, 'exited');
  assert.throws(() => registry.status(ids[22]), { code: 'managed_process_not_found' });
  assert.equal((registry.status(ids[23]) as ManagedProcessResult).status, 'stopped');
});

test('managed process checks an IPv6 readiness port on IPv6 loopback', async (t) => {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '::1', resolve));
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENOTSUP'].includes((error as { code?: string }).code ?? '')) {
      t.skip('IPv6 loopback is unavailable on this host');
      return;
    }
    throw error;
  }
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const tool = managedProcessTool(createManagedProcessRegistry());
  const preflight = tool.preflight! as (value: unknown) => unknown | Promise<unknown>;
  await assert.rejects(async () => preflight({
    action: 'start', command: 'node -e "process.exit(0)"', readyUrl: `http://[::1]:${address.port}/`,
  }), { code: 'managed_process_port_in_use' });
});

test('revoking shared workspace trust stops a managed process that started from trusted project code', { timeout: 15_000 }, async (t) => {
  const testplace = join(process.cwd(), 'testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'managed-process-trust-revocation-'));
  const workspace = join(directory, 'workspace');
  const home = join(directory, 'home');
  await Promise.all([mkdir(workspace), mkdir(home)]);
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  const port = await availableLoopbackPort();
  const url = `http://127.0.0.1:${port}/`;
  const script = join(workspace, 'server.mjs');
  await writeFile(script, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((_request, response) => response.end('trusted-server-ready')).listen(port, '127.0.0.1');\n");
  await setTrusted(workspace, true);
  const registry = createManagedProcessRegistry({
    async validateWorkspaceTrust() {
      if (!(await isTrusted(workspace))) throw new Error('workspace trust was revoked');
    },
  });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: workspace, workspaceRoot: workspace } }),
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
    permission,
  });
  const dispose = managedProcessPlugin(registry).setup(kernel) as () => void;
  t.after(async () => {
    try {
      await dispose();
      await registry.close();
    } finally {
      if (previousHome === undefined) delete process.env.LIGULE_HOME;
      else process.env.LIGULE_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  let started: ManagedProcessResult;
  try {
    started = await kernel.call('managed_process', {
      action: 'start', command: `node "${script.replaceAll('\\', '/')}" ${port}`, readyUrl: url,
    }) as ManagedProcessResult;
  } catch (error) {
    const failure = error as { code?: string; detail?: unknown };
    if (process.platform === 'linux' && failure.code === 'permission_sandbox_unavailable'
      && String(failure.detail ?? '').includes('bwrap: setting up uid map: Permission denied')) {
      t.skip('this Linux runner denies bubblewrap user-namespace mapping');
      return;
    }
    throw error;
  }
  assert.equal(started.status, 'running');
  assert.equal(await (await fetch(url)).text(), 'trusted-server-ready');

  await setTrusted(workspace, false);
  await waitForUnavailable(url);
  const deadline = Date.now() + 3_000;
  let stopped = registry.status(started.id) as ManagedProcessResult;
  while (stopped.status === 'stopping' && Date.now() < deadline) {
    await delay(20);
    stopped = registry.status(started.id) as ManagedProcessResult;
  }
  assert.equal(stopped.status, 'stopped', JSON.stringify(stopped));
  assert.match(stopped.failure, /workspace trust was revoked/u);
});
