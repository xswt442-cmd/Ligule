import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConnection, createConfig, createMemoryConnectionPair, createPermissionContext, modeDirectories, serveHost } from '../core/dist/index.js';
import { providerFromConfig } from '../core/dist/host/provider.js';
import { createMediaStore } from '../core/dist/capability/media.js';
import { BROWSER_SERVER } from '../core/dist/capability/browser-policy.js';
import { workspaceDataDirectory } from '../core/dist/session/list.js';
import type { Server } from 'node:http';
import type { Connection } from '../core/dist/host/connection.js';
import type { Host, HostOptions } from '../core/dist/host/host.js';
import type { MemoryConnectionPair } from '../core/dist/host/memory.js';
import type { ConfigSnapshot } from '../core/dist/kernel/config.js';

const browserEntry = process.env.LIGULE_PLAYWRIGHT_MCP_ENTRY;
const browserExecutable = process.env.LIGULE_BROWSER_EXE;
const backendUnavailable = browserEntry === undefined || browserEntry === ''
  || browserExecutable === undefined || browserExecutable === '';

type PlanStep = { text?: string; name?: string; args?: unknown; serverTool?: string; hold?: boolean };
type BrowserTestConfig = ConfigSnapshot & { boundary: string; policy: NonNullable<HostOptions['policy']> };
type BrowserStatus = { browser: { connected: boolean; paused: boolean } };
type BrowserContext = {
  root: string;
  dataRoot: string;
  config: BrowserTestConfig;
  connection: Connection;
  pageHits: (string | undefined)[];
  pageOrigin: string;
  setPlan(steps: PlanStep[]): void;
  controllerWaiting: ReturnType<typeof deferred<unknown>>;
  controllerClosed: ReturnType<typeof deferred<void>>;
  getPlanLength(): number;
  getControllerFailure(): unknown;
};

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(promise: Promise<unknown>, label: string, milliseconds = 15_000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('browser_test_address_missing');
  return `http://127.0.0.1:${address.port}`;
}

function completion(step: PlanStep, id: number) {
  if (step.text !== undefined) {
    return { choices: [{ index: 0, message: { role: 'assistant', content: step.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }
  return { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{
    id: `browser-call-${id}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) },
  }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

function serverCallPlan(tool: string, args: unknown): PlanStep[] {
  return [
    { name: 'mcp.inspect', args: { server: BROWSER_SERVER, tool } },
    { name: 'mcp.call', serverTool: tool, args },
    { text: 'browser operation finished' },
  ];
}

async function withBrowserHost(run: (context: BrowserContext) => Promise<void>, { denyTool = 'browser_close' }: { denyTool?: string } = {}) {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'browser-host-'));
  const dataRoot = join(root, 'data');
  await mkdir(dataRoot);
  const keyName = 'LIGULE_BROWSER_HOST_TEST_KEY';
  const prior = { home: process.env.LIGULE_HOME, key: process.env[keyName] };
  process.env.LIGULE_HOME = dataRoot;
  process.env[keyName] = randomBytes(24).toString('hex');

  const pageHits: (string | undefined)[] = [];
  const page = createServer((request, response) => {
    pageHits.push(request.url);
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Ligule Browser Host</title><h1 id="ready">Ready</h1><button id="action">Local page</button>');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  let controllerOrigin;
  let plan: PlanStep[] = [];
  let responseId = 0;
  let controllerFailure: unknown;
  const controllerWaiting = deferred<unknown>();
  const controllerClosed = deferred<void>();
  const controller = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const step = plan.shift();
      if (step === undefined) throw new Error('browser_controller_step_missing');
      if (step.hold === true) {
        response.once('close', () => { if (!response.writableEnded) controllerClosed.resolve(); });
        controllerWaiting.resolve(body);
        return;
      }
      let args = step.args;
      if (step.name === 'mcp.call' && step.serverTool !== undefined) {
        const previous = body.messages.at(-1);
        assert.equal(previous.role, 'tool');
        const inspected = JSON.parse(previous.content);
        assert.equal(inspected.tool, step.serverTool);
        args = {
          server: BROWSER_SERVER,
          tool: step.serverTool,
          arguments: JSON.stringify(step.args),
          schemaDigest: inspected.schemaDigest,
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completion({ ...step, args }, ++responseId)));
    } catch (error) {
      controllerFailure ??= error;
      response.writeHead(500);
      response.end('local controller failed');
    }
  });

  let host: Host | undefined;
  let pair: MemoryConnectionPair | undefined;
  try {
    const pageOrigin = await listen(page);
    controllerOrigin = await listen(controller);
    const service = {
      id: 'local-browser-controller',
      name: 'Local browser test controller',
      api: 'chat-completions',
      baseURL: `${controllerOrigin}/v1`,
      apiKeyEnv: keyName,
      models: ['local-browser-controller'],
      modelSettings: [{ id: 'local-browser-controller', contextTokens: 64_000, outputTokens: 2_048, imageInput: true }],
    };
    const config = createConfig({ user: {
      boundary: root,
      workspaceRoot: root,
      userHome: dataRoot,
      host: { sessionDirectory: join(root, 'sessions') },
      browser: { provider: 'playwright-mcp', entryPoint: browserEntry, executablePath: browserExecutable },
      model: {
        api: service.api,
        baseURL: service.baseURL,
        model: service.models[0],
        apiKeyEnv: service.apiKeyEnv,
        services: [service],
        selection: { provider: service.id, model: service.models[0] },
        retry: { maxAttempts: 1, baseDelayMs: 1, retry429: false, retry5xx: false, retryTransport: false },
        capabilities: { streaming: false },
      },
      loop: { iterations: 24, modelCalls: 24 },
      policy: {
        mode: 'none',
        rules: denyTool === undefined ? [] : [{ tool: `mcp:${BROWSER_SERVER}/${denyTool}`, decision: 'deny', reason: 'browser host test denial' }],
      },
    } }) as BrowserTestConfig;
    pair = createMemoryConnectionPair();
    host = serveHost({ ...pair.host, config: config as ConfigSnapshot, provider: providerFromConfig(config), policy: config.policy,
      modeName: 'full', modePaths: modeDirectories(root, resolve('core/modes')), permissionControl: true,
      permission: createPermissionContext('full-access', 'unrestricted', {
        filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
      }) });
    const connection = createConnection(pair.client);
    await run({ root, dataRoot, config, connection, pageHits, pageOrigin, setPlan: (steps) => { plan = [...steps]; },
      controllerWaiting, controllerClosed, getPlanLength: () => plan.length, getControllerFailure: () => controllerFailure,
    });
  } finally {
    try {
      pair?.client.output.end();
      await host?.release();
    } finally {
      page.closeAllConnections();
      controller.closeAllConnections();
      try {
        await Promise.all([new Promise((resolveClose) => page.close(resolveClose)),
          new Promise((resolveClose) => controller.close(resolveClose))]);
      } finally {
        if (prior.home === undefined) delete process.env.LIGULE_HOME;
        else process.env.LIGULE_HOME = prior.home;
        if (prior.key === undefined) delete process.env[keyName];
        else process.env[keyName] = prior.key;
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

test('real Browser Host enforces trust, Permission, Policy, filtering and sticky Stop', {
  skip: backendUnavailable ? 'set LIGULE_PLAYWRIGHT_MCP_ENTRY and LIGULE_BROWSER_EXE for headless backend integration' : false,
}, async () => {
  await withBrowserHost(async ({ root, connection, pageHits, pageOrigin, setPlan, getPlanLength, getControllerFailure }) => {
    const sessionId = (await connection.request('session.create', { projectRoot: root }) as { sessionId: string }).sessionId;
    const trustList = await connection.request('mcp.trust.list', { projectRoot: root, sessionId }) as { servers: { name: string; identityDigest: string }[] };
    const browser = trustList.servers.find((item) => item.name === BROWSER_SERVER);
    assert.ok(browser);
    assert.deepEqual((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, false);
    await assert.rejects(
      connection.request('mcp.trust.tools', { projectRoot: root, sessionId, server: BROWSER_SERVER }),
      { code: 'mcp_server_untrusted' },
    );
    assert.equal((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, false);

    await connection.request('mcp.trust.set', { projectRoot: root, sessionId, server: BROWSER_SERVER,
      identityDigest: browser.identityDigest, scope: 'session', trusted: true, confirmTrust: true, confirmExternalAccess: true });
    await connection.request('permission.set', { sessionId, permissionProfile: 'read-only', permissionNetwork: 'disabled' });
    await assert.rejects(
      connection.request('mcp.trust.tools', { projectRoot: root, sessionId, server: BROWSER_SERVER }),
      { code: 'permission_external_access_requires_full_access' },
    );
    assert.equal((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, false);

    await connection.request('permission.set', { sessionId, permissionProfile: 'full-access', permissionNetwork: 'unrestricted',
      confirmFullAccess: true, confirmNetwork: true });
    const tools = await connection.request('mcp.trust.tools', { projectRoot: root, sessionId, server: BROWSER_SERVER }) as { tools: { name: string }[] };
    const names = tools.tools.map((item) => item.name);
    assert.ok(names.includes('browser_navigate'));
    assert.ok(names.includes('browser_take_screenshot'));
    assert.equal(names.some((name) => /evaluate|upload|install|resize|file/u.test(name)), false);

    setPlan([
      { name: 'mcp.call', args: { server: BROWSER_SERVER, tool: 'browser_close', arguments: '{}', schemaDigest: 'not-inspected' } },
      { text: 'policy refusal recorded' },
    ]);
    await connection.request('run.start', { sessionId, input: 'try the policy-denied close operation' });
    assert.equal(getPlanLength(), 0);
    assert.deepEqual(pageHits, [], 'the policy denial happens before the browser tool is called');
    let raw = await readFile(join(root, 'sessions', `${sessionId}.jsonl`), 'utf8');
    assert.ok(raw.includes('policy_denied'));
    assert.equal((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, true,
      'the trusted tool listing connected the MCP server but the denied call did not navigate the page');

    setPlan(serverCallPlan('browser_take_screenshot', { scale: 'css', type: 'png', target: 'body' }));
    await connection.request('run.start', { sessionId, input: 'try a forbidden screenshot target' });
    assert.equal(getPlanLength(), 0);
    raw = await readFile(join(root, 'sessions', `${sessionId}.jsonl`), 'utf8');
    assert.ok(raw.includes('mcp_arguments_invalid'), 'filtered screenshot arguments are rejected before the browser tool runs');
    assert.deepEqual(pageHits, []);

    await connection.request('browser.stop', { sessionId });
    let browserStatus = (await connection.request('status.get', { sessionId }) as BrowserStatus).browser;
    assert.equal(browserStatus.paused, true);
    assert.equal(browserStatus.connected, false);
    await assert.rejects(
      connection.request('mcp.trust.tools', { projectRoot: root, sessionId, server: BROWSER_SERVER }),
      { code: 'browser_stopped' },
    );
    await connection.request('browser.resume', { sessionId });
    browserStatus = (await connection.request('status.get', { sessionId }) as BrowserStatus).browser;
    assert.equal(browserStatus.paused, false);
    assert.equal(browserStatus.connected, false, 'resume never starts a backend process');

    await connection.request('permission.set', { sessionId, permissionProfile: 'read-only', permissionNetwork: 'disabled' });
    await assert.rejects(connection.request('browser.resume', { sessionId }), { code: 'permission_external_access_requires_full_access' });
    await connection.request('permission.set', { sessionId, permissionProfile: 'full-access', permissionNetwork: 'unrestricted',
      confirmFullAccess: true, confirmNetwork: true });
    await connection.request('mcp.trust.set', { projectRoot: root, sessionId, server: BROWSER_SERVER,
      identityDigest: browser.identityDigest, scope: 'session', trusted: false });
    await assert.rejects(
      connection.request('mcp.trust.tools', { projectRoot: root, sessionId, server: BROWSER_SERVER }),
      { code: 'mcp_server_untrusted' },
    );
    assert.equal((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, false);
    assert.equal(pageOrigin.startsWith('http://127.0.0.1:'), true);
    assert.equal(getControllerFailure(), undefined);
  });
});

test('real headless Browser Host persists screenshots and stops servers on cancellation and Session close', {
  skip: backendUnavailable ? 'set LIGULE_PLAYWRIGHT_MCP_ENTRY and LIGULE_BROWSER_EXE for headless backend integration' : false,
}, async () => {
  await withBrowserHost(async ({ root, dataRoot, config, connection, pageHits, pageOrigin, setPlan,
    controllerWaiting, controllerClosed, getPlanLength, getControllerFailure }) => {
    const sessionId = (await connection.request('session.create', { projectRoot: root }) as { sessionId: string }).sessionId;
    const trustList = await connection.request('mcp.trust.list', { projectRoot: root, sessionId }) as { servers: { name: string; identityDigest: string }[] };
    const browser = trustList.servers.find((item) => item.name === BROWSER_SERVER);
    assert.ok(browser);
    await connection.request('mcp.trust.set', { projectRoot: root, sessionId, server: BROWSER_SERVER,
      identityDigest: browser.identityDigest, scope: 'session', trusted: true, confirmTrust: true, confirmExternalAccess: true });
    await connection.request('mcp.trust.tools', { projectRoot: root, sessionId, server: BROWSER_SERVER });

    setPlan(serverCallPlan('browser_navigate', { url: pageOrigin }));
    await connection.request('run.start', { sessionId, input: 'open the local test page' });
    setPlan(serverCallPlan('browser_take_screenshot', { scale: 'css', type: 'png' }));
    await connection.request('run.start', { sessionId, input: 'capture the current local page' });
    const browserEvents = (await readFile(join(root, 'sessions', `${sessionId}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const failedBrowserCalls = browserEvents.filter(event => event.kind === 'tool' && event.result?.failed === true);
    assert.deepEqual(failedBrowserCalls.map(event => event.result), [], 'browser workflow must not hide failed tool calls');
    assert.ok(pageHits.includes('/'));
    assert.equal((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, true);

    const raw = await readFile(join(root, 'sessions', `${sessionId}.jsonl`), 'utf8');
    const events = raw.trim().split('\n').map((line) => JSON.parse(line));
    const screenshotEvent = events.find((event) => event.kind === 'tool' && event.tool === 'mcp.call'
      && event.result?.failed !== true && event.result?.images?.length > 0);
    assert.ok(screenshotEvent);
    const [reference] = screenshotEvent.result.images;
    assert.equal(reference.source, 'browser');
    assert.equal(reference.sessionId, sessionId);
    const media = createMediaStore(config, sessionId);
    assert.ok((await media.read(reference)).length > 0);

    setPlan([{ hold: true }]);
    const running = connection.request('run.start', { sessionId, input: 'wait for cancellation' });
    await waitFor(controllerWaiting.promise, 'controller request');
    await connection.request('run.cancel', { sessionId });
    await assert.rejects(running, (error) => ['loop_cancelled', 'provider_cancelled'].includes((error as { code: string }).code));
    await waitFor(controllerClosed.promise, 'cancelled controller response');
    assert.equal(getPlanLength(), 0);
    assert.equal((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, false,
      'cancelling a turn revokes the Browser MCP process');
    const browserDirectory = join(workspaceDataDirectory({ boundary: root, workspaceRoot: root, userHome: dataRoot }), 'browser', 'sessions', sessionId);
    assert.deepEqual((await readdir(browserDirectory)).sort(), ['.ligule-lease.lock', '.ligule-owner.json'],
      'cancellation clears transient output while preserving the Session owner and lease');

    setPlan(serverCallPlan('browser_navigate', { url: pageOrigin }));
    await connection.request('run.start', { sessionId, input: 'reopen the local test page' });
    assert.equal((await connection.request('status.get', { sessionId }) as BrowserStatus).browser.connected, true);
    await connection.request('session.close', { sessionId });
    await assert.rejects(connection.request('status.get', { sessionId }), { code: 'session_not_open' });
    await assert.rejects(access(browserDirectory), { code: 'ENOENT' });
    assert.equal(getControllerFailure(), undefined);
  });
});
