import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHost } from '../dist/host/host.js';
import { createConfig } from '../dist/kernel/config.js';
import { createKernel } from '../dist/kernel/kernel.js';
import { createLoop } from '../dist/kernel/loop.js';
import { createDecisionChain } from '../dist/kernel/policy.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { DEFAULT_PERMISSION_CONTEXT } from '../dist/kernel/permission.js';
import { createTelemetry } from '../dist/kernel/telemetry.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { HostOptions } from '../dist/host/host.js';
import type { HostProvider } from '../dist/host/provider.js';
import type { ModelProvider, ModelRequest } from '../dist/kernel/loop.js';

type TelemetryRecord = { timestamp?: string; component?: string; severity?: string; type: string; callId?: string; runId?: string; sessionId?: string; outcome?: string; executionId?: string; parentExecutionId?: string; parentRunId?: string; parentCallId?: string; inputTokens?: number; outputTokens?: number; durationMs?: number; provider?: string; model?: string; code?: string; errorCode?: string };
type RequestRecord = { path: string | undefined; body: Buffer };
type SessionEventView = { kind?: string; tool?: string; result: { content: { sessionId: string } } };
type SetupOptions = {
  telemetry?: boolean;
  provider: HostProvider;
  permission?: HostOptions['permission'];
  permissionControl?: boolean;
  policyMode?: 'ask' | 'auto';
  configLayers?: HostOptions['configLayers'];
  logger?: HostOptions['logger'];
};

const testRoot = join(process.cwd(), 'testplace', 'telemetry-host');

async function filesUnder(directory: string): Promise<string[]> {
  const result = [];
  for (const name of (await readdir(directory)).filter(name => /^segment-[0-9]{8}\.jsonl$/u.test(name))) {
    result.push(await readFile(join(directory, name), 'utf8'));
  }
  return result;
}

async function waitForTelemetry(directory: string, predicate: (records: TelemetryRecord[]) => boolean): Promise<TelemetryRecord[]> {
  const deadline = Date.now() + 5000;
  let records: TelemetryRecord[] = [];
  do {
    records = (await filesUnder(directory)).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line) as TelemetryRecord));
    if (predicate(records)) return records;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`expected telemetry events were not persisted: ${JSON.stringify(records.map(({ type, callId, outcome, errorCode }) => ({ type, callId, outcome, errorCode })))}`);
}

async function setupHost(t: TestContext, { telemetry, provider, permission, permissionControl = false, policyMode = 'ask', configLayers, logger }: SetupOptions) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'case-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const sessions = join(root, 'sessions');
  const telemetryDirectory = join(root, 'telemetry');
  await Promise.all([mkdir(project), mkdir(sessions), mkdir(telemetryDirectory, { mode: 0o700 })]);
  if (process.platform !== 'win32') await chmod(telemetryDirectory, 0o700);
  const config = createConfig({ user: {
    boundary: project,
    workspaceRoot: project,
    host: { sessionDirectory: sessions },
    loop: { iterations: 5, modelCalls: 5 },
    policy: { mode: policyMode },
  } });
  const client = {
    notify() {},
    async request(method: string, params: unknown) {
      if (method === 'approval.request') {
        approvals.push(params as { tool?: string });
        return { decision: 'allow' };
      }
      return undefined;
    },
  };
  const approvals: { tool?: string }[] = [];
  const host = createHost({ config, provider, policy: config.policy as HostOptions['policy'], interactive: true,
    permissionControl,
    ...(configLayers === undefined ? {} : { configLayers }),
    ...(permission === undefined ? {} : { permission }),
    ...(logger === undefined ? {} : { logger }),
    ...(telemetry === true ? { telemetry: { enabled: true, directory: telemetryDirectory } } : {}),
  });
  t.after(async () => host.release());
  const { sessionId } = await host.handle({ method: 'session.create', params: {} }, client) as { sessionId: string };
  return { host, client, project, sessions, sessionId, telemetryDirectory, approvals };
}

test('Host enables loopback OTLP only from the user configuration layer', async (t) => {
  const requests: RequestRecord[] = [];
  const receiver = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, body: Buffer.concat(chunks) });
    response.writeHead(200, { connection: 'close' });
    response.end();
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(async () => {
    receiver.closeAllConnections();
    if (receiver.listening) await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
  });
  const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/traces`;
  const provider = { async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'finish', reason: 'stop' }; } } as unknown as HostProvider;
  await mkdir(testRoot, { recursive: true });
  const userDataRoot = await mkdtemp(join(testRoot, 'otlp-user-data-'));
  const previousDataRoot = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = userDataRoot;
  t.after(async () => {
    if (previousDataRoot === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousDataRoot;
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const userConfigured = await setupHost(t, { provider, configLayers: { user: { telemetry: { enabled: true, otlpEndpoint: endpoint } } } });
  await userConfigured.host.handle({ method: 'run.start', params: { sessionId: userConfigured.sessionId, input: 'trace user config' } }, userConfigured.client);
  await userConfigured.host.release();
  assert.ok(requests.some(request => request.path === '/v1/traces' && request.body.byteLength > 0));
  const localRecords = (await filesUnder(join(userDataRoot, 'telemetry'))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line) as TelemetryRecord));
  assert.ok(localRecords.length > 0);
  assert.ok(localRecords.every(event => typeof event.timestamp === 'string' && typeof event.component === 'string'
    && typeof event.severity === 'string' && typeof event.type === 'string'));

  requests.length = 0;
  const projectConfigured = await setupHost(t, { provider, configLayers: { project: { telemetry: { enabled: true, otlpEndpoint: endpoint } } } });
  await projectConfigured.host.handle({ method: 'run.start', params: { sessionId: projectConfigured.sessionId, input: 'project config remains disabled' } }, projectConfigured.client);
  await projectConfigured.host.release();
  assert.deepEqual(requests, []);
});

test('Host telemetry uses execution IDs plus Session and parent-call links, and excludes sensitive content', async (t) => {
  const provider = {
    name: 'vendor/local-test-provider',
    model: 'vendor/local-test-model',
    async *stream({ tools, messages }: ModelRequest) {
      const hasChildTool = tools.some(tool => tool.name === 'subagent');
      const hasToolResult = messages.some(message => message.role === 'tool');
      if (hasChildTool && !hasToolResult) {
        yield { type: 'tool-call', id: 'parent-call-1', name: 'subagent', args: { task: 'child task' } };
        yield { type: 'usage', input: 3, output: 1 };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (!hasChildTool && !hasToolResult) {
        yield { type: 'tool-call', id: 'child-call-1', name: 'create', args: {
          path: 'child-secret-path.txt', content: 'CHILD_CONTENT_SECRET',
        } };
        yield { type: 'usage', input: 3, output: 1 };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'text', text: 'MODEL_OUTPUT_SECRET' };
        yield { type: 'usage', input: 3, output: 1 };
        yield { type: 'finish', reason: 'stop' };
      }
    },
  } as unknown as HostProvider;
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const hostContext = await setupHost(t, { provider, permission, permissionControl: true, telemetry: true });
  const accepted = await hostContext.host.handle({ method: 'run.start', params: {
    sessionId: hostContext.sessionId, input: 'PARENT_PROMPT_SECRET',
  } }, hostContext.client) as { runId: string };
  assert.equal(typeof accepted.runId, 'string');
  await hostContext.host.handle({ method: 'run.wait', params: {
    sessionId: hostContext.sessionId, runId: accepted.runId, origin: 'human',
  } }, hostContext.client);
  assert.ok(hostContext.approvals.some(item => item.tool === 'create'));

  const parent = await hostContext.host.handle({ method: 'session.read', params: { sessionId: hostContext.sessionId } }, hostContext.client) as { events: SessionEventView[] };
  const delegated = parent.events.find(event => event.kind === 'tool' && event.tool === 'subagent') as SessionEventView;
  assert.ok(delegated);
  const childSessionId = delegated.result.content.sessionId;
  assert.equal(typeof childSessionId, 'string');
  const childLines = (await readFile(join(hostContext.sessions, `${childSessionId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind?: string; status?: string; runId?: string });
  assert.ok(childLines.some(event => event.kind === 'turn' && event.status === 'completed'));
  assert.ok(childLines.filter(event => event.kind === 'turn').every(event => event.runId === undefined));
  const records = await waitForTelemetry(hostContext.telemetryDirectory, events =>
    events.some(event => event.type === 'run.finished' && event.runId === accepted.runId)
      && events.some(event => event.type === 'tool.finished' && event.callId === 'parent-call-1' && event.outcome === 'success'));
  await hostContext.host.release();

  const parentStart = records.find(event => event.type === 'run.started' && event.sessionId === hostContext.sessionId);
  const childStart = records.find(event => event.type === 'run.started' && event.sessionId === childSessionId);
  assert.ok(parentStart);
  assert.ok(childStart, 'child run telemetry event missing');
  assert.match(parentStart.runId as string, /^[0-9a-f-]{36}$/u);
  assert.equal(childStart.runId, undefined);
  assert.equal(childStart.parentExecutionId, parentStart.executionId);
  assert.equal(childStart.parentRunId, parentStart.runId);
  assert.equal(childStart.parentCallId, 'parent-call-1');
  const approval = records.find(event => event.type === 'approval.finished' && event.callId === 'child-call-1');
  assert.ok(approval);
  assert.equal(approval.sessionId, childSessionId);
  assert.equal(approval.runId, undefined);
  assert.equal(approval.parentRunId, parentStart.runId);
  assert.equal(approval.executionId, childStart.executionId);
  assert.equal(approval.parentExecutionId, parentStart.executionId);
  assert.equal(approval.parentCallId, 'parent-call-1');
  assert.ok(records.some(event => event.type === 'tool.finished' && event.callId === 'parent-call-1' && event.outcome === 'success'), JSON.stringify(records));
  const model = records.find(event => event.type === 'model.finished' && event.executionId === parentStart.executionId);
  assert.ok(model);
  assert.equal(model.provider, undefined);
  assert.equal(model.model, undefined);
  assert.equal(model.inputTokens, 3);
  assert.equal(model.outputTokens, 1);
  assert.ok((model.durationMs as number) >= 0);
  assert.doesNotMatch(JSON.stringify(records), /PARENT_PROMPT_SECRET|CHILD_CONTENT_SECRET|child-secret-path|MODEL_OUTPUT_SECRET/u);
});

test('Host defaults telemetry off', async (t) => {
  const provider = { async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'finish', reason: 'stop' }; } } as unknown as HostProvider;
  const context = await setupHost(t, { provider });
  await context.host.handle({ method: 'run.start', params: { sessionId: context.sessionId, input: 'ordinary input' } }, context.client);
  assert.deepEqual(await readdir(context.telemetryDirectory), []);
});

test('Host reports an unknown telemetry temporary file without disclosing its path or contents', async (t) => {
  const provider = { async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'finish', reason: 'stop' }; } } as unknown as HostProvider;
  const diagnostics: { message: string; fields: Record<string, unknown> }[] = [];
  const context = await setupHost(t, {
    provider,
    telemetry: true,
    logger: {
      debug() {},
      log(message: string, fields: Record<string, unknown>) { diagnostics.push({ message, fields }); },
    },
  });
  const temporaryName = `telemetry.manifest.${randomUUID()}.tmp`;
  const contents = 'unknown user-owned telemetry data';
  await writeFile(join(context.telemetryDirectory, temporaryName), contents);

  await context.host.handle({ method: 'run.start', params: { sessionId: context.sessionId, input: 'diagnose telemetry storage' } }, context.client);
  await context.host.release();

  assert.equal(await readFile(join(context.telemetryDirectory, temporaryName), 'utf8'), contents);
  assert.deepEqual(diagnostics, [{
    message: 'telemetry storage unavailable',
    fields: { code: 'telemetry_manifest_temp_unknown', severity: 'error' },
  }]);
});

test('Host release stays bounded when the telemetry file flush never settles', async (t) => {
  const provider = { async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'finish', reason: 'stop' }; } } as unknown as HostProvider;
  const context = await setupHost(t, { provider, telemetry: true });
  await context.host.handle({ method: 'run.start', params: { sessionId: context.sessionId, input: 'create telemetry record' } }, context.client);
  const probe = await open(join(context.telemetryDirectory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  prototype.sync = () => new Promise(() => {});
  try {
    const started = Date.now();
    await context.host.release();
    assert.ok(Date.now() - started < 1_000);
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
});

test('Loop classifies permission and tool restrictions as refused outcomes', async (t) => {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'refusal-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = createConfig({ user: { boundary: directory } });
  const telemetry = createTelemetry({ enabled: true, directory });
  for (const [name, code, permission, restrict] of [
    ['write_file', 'permission_read_only', createPermissionContext('read-only', 'disabled', DEFAULT_PERMISSION_CONTEXT.capabilities), false],
    ['read_file', 'tool_denied', undefined, true],
  ] as [string, string, HostOptions['permission'], boolean][]) {
    const kernel = createKernel({ config, ...(permission === undefined ? {} : { permission }), policy: createDecisionChain({ mode: 'auto' }) });
    kernel.register({ name, description: name, access: name === 'write_file' ? 'write' : 'read',
      parameters: { type: 'object', properties: {} }, run: () => 'unused' });
    if (restrict) kernel.restrict([name]);
    let modelCalls = 0;
    const provider = { async *stream() {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: 'tool-call', id: `${name}-call`, name, args: {} };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'text', text: 'finished' };
        yield { type: 'finish', reason: 'stop' };
      }
    } } as unknown as ModelProvider;
    const loop = createLoop({ kernel, provider, telemetry, sessionId: `session-${name}` });
    await loop.run('input');
  }
  await telemetry.flush();
  await telemetry.shutdown();
  const records = (await filesUnder(directory)).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line) as TelemetryRecord));
  for (const callId of ['write_file-call', 'read_file-call']) {
    assert.ok(records.some(event => event.type === 'tool.finished' && event.callId === callId && event.outcome === 'refused'), JSON.stringify(records));
  }
});
