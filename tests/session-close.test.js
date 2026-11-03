import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectMcp } from './helpers/mcp-control.mjs';
import { requestAgentControl } from '../core/dist/host/agent-control-runtime.js';
import { setTrusted } from '../core/dist/kernel/workspace-trust.js';
import { createHost } from '../core/dist/host/host.js';
import { createControl } from '../core/dist/host/control.js';
import { createChatCompletionsProvider } from '../core/dist/model/chat-completions.js';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(process.env.LIGULE_MCP_E2E_WORKSPACE_ROOT ?? repoRoot);
const cliPath = resolve(process.env.LIGULE_MCP_CLI ?? join(repoRoot, 'tui', 'dist', 'cli.js'));
const sdkRoot = resolve(process.env.LIGULE_MCP_SDK_ROOT ?? join(repoRoot, 'core', 'node_modules', '@modelcontextprotocol', 'sdk'));
const tempParent = resolve(process.env.LIGULE_MCP_E2E_TEMP_ROOT ?? join(workspaceRoot, 'testplace', 'tmp'));
const apiKeyName = 'LIGULE_SESSION_CLOSE_TEST_KEY';
const apiKey = randomUUID();

function structured(result, label) {
  assert.equal(result.isError, undefined, `${label}: ${JSON.stringify(result.structuredContent ?? result)}`);
  assert.ok(result.structuredContent !== undefined, `${label}: missing structuredContent`);
  return result.structuredContent;
}

function errorCode(result) {
  assert.equal(result.isError, true, 'expected an MCP tool error');
  let payload = {};
  try { payload = JSON.parse(result.content?.[0]?.text ?? '{}'); } catch { /* The SDK may return a non-JSON error message. */ }
  return result.structuredContent?.code ?? payload.code;
}

function sendCompletion(response, text = 'session close run completed') {
  const frames = [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
}

async function createFixture(onRequest = async (_body, response) => sendCompletion(response)) {
  await mkdir(tempParent, { recursive: true });
  const verifiedParent = await realpath(tempParent);
  const tempRoot = await mkdtemp(join(verifiedParent, 'session-close-'));
  assert.ok((await realpath(tempRoot)).startsWith(`${verifiedParent}${process.platform === 'win32' ? '\\' : '/'}`));
  const projectRoot = join(tempRoot, 'project');
  const dataRoot = join(tempRoot, 'isolated-data-root');
  const sessionDirectory = join(projectRoot, 'sessions');
  await Promise.all([mkdir(projectRoot), mkdir(dataRoot)]);
  await mkdir(sessionDirectory);
  const endpoint = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      await onRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), response, request);
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    }
  });
  await new Promise((resolveListen, reject) => {
    endpoint.once('error', reject);
    endpoint.listen(0, '127.0.0.1', resolveListen);
  });
  const address = endpoint.address();
  assert.ok(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const tomlString = (value) => JSON.stringify(value.replaceAll('\\', '/'));
  await writeFile(join(dataRoot, 'config.toml'), [
    '[model]',
    'api = "chat-completions"',
    `baseURL = ${tomlString(baseURL)}`,
    'model = "session-close-test"',
    `apiKeyEnv = "${apiKeyName}"`,
    '',
    '[policy]',
    'mode = "ask"',
    '',
    '[host]',
    `sessionDirectory = ${tomlString(sessionDirectory)}`,
    '',
    '[loop]',
    'iterations = 3',
    'modelCalls = 6',
  ].join('\n'));
  await setTrusted(projectRoot, true, join(dataRoot, 'tui-trust.json'));
  const context = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey, sdkRoot });
  return {
    context, projectRoot, dataRoot, sessionDirectory,
    async dispose() {
      await context.close();
      await new Promise((resolveClose, reject) => endpoint.close((error) => error ? reject(error) : resolveClose()));
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function call(context, name, args) {
  return await context.client.callTool({ name, arguments: args });
}

async function waitFor(check, label, within = 10_000) {
  const until = Date.now() + within;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`session_close_wait_timeout:${label}`);
}

test('real MCP close releases the 64-session limit, retains history and operation status, and takeover cannot be reclaimed', { timeout: 120_000 }, async () => {
  const fixture = await createFixture();
  const { context, projectRoot, dataRoot, sessionDirectory } = fixture;
  try {
    const listed = await context.client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'ligule_session_close'), 'the MCP server exposes explicit session close');

    const owned = [];
    for (let index = 0; index < 64; index += 1) {
      const created = structured(await call(context, 'ligule_session_create', { projectRoot }), 'fill_session_limit');
      owned.push(created.sessionId);
    }
    const previousHome = process.env.LIGULE_HOME;
    process.env.LIGULE_HOME = dataRoot;
    try {
      const takeover = await requestAgentControl(projectRoot, owned[0], { action: 'takeover' });
      assert.equal(takeover.ownership, 'human');
    } finally {
      if (previousHome === undefined) delete process.env.LIGULE_HOME;
      else process.env.LIGULE_HOME = previousHome;
    }
    assert.equal(errorCode(await call(context, 'ligule_session_open', { projectRoot, sessionId: owned[0] })), 'control_session_taken_over');
    const descriptorDirectory = join(dataRoot, 'agent-control-runtime');
    const descriptors = await readdir(descriptorDirectory).catch(() => []);
    const descriptorSessions = await Promise.all(descriptors.filter((name) => name.endsWith('.json')).map(async (name) => {
      const descriptor = JSON.parse(await readFile(join(descriptorDirectory, name), 'utf8'));
      return descriptor.sessionId;
    }));
    assert.ok(!descriptorSessions.includes(owned[0]), 'takeover removes the old controller runtime descriptor');
    const releasedSlot = structured(await call(context, 'ligule_session_create', { projectRoot }), 'create_after_takeover');
    owned.push(releasedSlot.sessionId);
    for (const sessionId of owned.slice(1)) {
      structured(await call(context, 'ligule_session_close', { sessionId }), 'close_filled_session');
    }

    let firstClosed;
    for (let index = 0; index < 66; index += 1) {
      const created = structured(await call(context, 'ligule_session_create', { projectRoot }), `cycle_${index}_create`);
      const run = structured(await call(context, 'ligule_run', { sessionId: created.sessionId, input: `close cycle ${index}` }), `cycle_${index}_run`);
      assert.equal(run.state, 'done', `cycle ${index} completed through the real local HTTP provider`);
      structured(await call(context, 'ligule_session_close', { sessionId: created.sessionId }), `cycle_${index}_close`);
      const status = structured(await call(context, 'ligule_run_status', { operationId: run.operationId }), `cycle_${index}_operation_after_close`);
      assert.equal(status.state, 'done', 'closing keeps the completed operation queryable');
      if (index === 0) firstClosed = { sessionId: created.sessionId, operationId: run.operationId };
    }

    assert.ok(firstClosed);
    await access(join(sessionDirectory, `${firstClosed.sessionId}.jsonl`));
    const observer = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey, sdkRoot });
    try {
      structured(await observer.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot, sessionId: firstClosed.sessionId } }), 'reopen_closed_history_from_other_controller');
      const history = structured(await observer.client.callTool({ name: 'ligule_session_read', arguments: { sessionId: firstClosed.sessionId } }), 'read_closed_history');
      assert.ok(history.records.length > 0, 'the closed Session JSONL remains readable');
      assert.ok(history.records.some((entry) => JSON.parse(entry.json).kind === 'user'), 'the completed run remains in durable history');
      structured(await observer.client.callTool({ name: 'ligule_session_close', arguments: { sessionId: firstClosed.sessionId } }), 'observer_close');
    } finally {
      await observer.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('close refuses a running or queued session without cancelling or discarding its work', { timeout: 60_000 }, async () => {
  let markStarted;
  let releaseProvider;
  const started = new Promise((resolveStarted) => { markStarted = resolveStarted; });
  const waitForRelease = new Promise((resolveRelease) => { releaseProvider = resolveRelease; });
  const fixture = await createFixture(async (body, response) => {
    const input = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    if (typeof input === 'string' && input.includes('HOLD_CLOSE_TEST')) {
      markStarted();
      await waitForRelease;
    }
    if (!response.destroyed) sendCompletion(response, 'held run completed');
  });
  const { context, projectRoot } = fixture;
  try {
    const created = structured(await call(context, 'ligule_session_create', { projectRoot }), 'busy_session_create');
    const operation = structured(await call(context, 'ligule_run_start', { sessionId: created.sessionId, input: 'HOLD_CLOSE_TEST' }), 'busy_run_start');
    await started;
    const busyClose = await call(context, 'ligule_session_close', { sessionId: created.sessionId });
    assert.equal(errorCode(busyClose), 'control_session_busy');
    const queued = structured(await call(context, 'ligule_session_send', { sessionId: created.sessionId, input: 'preserve queued work' }), 'queue_while_running');
    assert.equal(queued.queued, true);
    assert.equal(errorCode(await call(context, 'ligule_session_close', { sessionId: created.sessionId })), 'control_session_busy');
    const stillRunning = structured(await call(context, 'ligule_run_status', { operationId: operation.operationId }), 'status_after_rejected_close');
    assert.equal(stillRunning.state, 'running');
    assert.equal(stillRunning.queue.length, 1);
    structured(await call(context, 'ligule_session_send', { sessionId: created.sessionId, action: 'clear_queue' }), 'explicit_clear_queue');
    releaseProvider();
    const completed = structured(await call(context, 'ligule_run_await', { operationId: operation.operationId, timeoutMs: 10_000 }), 'finish_running_operation');
    assert.equal(completed.state, 'done');
    structured(await call(context, 'ligule_session_close', { sessionId: created.sessionId }), 'close_after_idle');
  } finally {
    releaseProvider();
    await fixture.dispose();
  }
});

test('a plugin cleanup failure keeps the real Host session locked until close is retried', async () => {
  await withTuiHost(async ({ config, projectDirectory, sessionDirectory }) => {
    const provider = createChatCompletionsProvider({ baseUrl: config.model.baseURL, model: config.model.model, apiKeyEnv: config.model.apiKeyEnv });
    const failure = new Error('plugin disposal failed');
    const host = createHost({ config, provider, plugins: [{ name: 'cleanup-failure', setup: () => () => { throw failure; } }] });
    const observer = createHost({ config, provider });
    const control = createControl(host, projectDirectory);
    try {
      const { sessionId } = await control.create(projectDirectory);
      await assert.rejects(control.close(sessionId), error => error instanceof AggregateError && error.errors.includes(failure));
      assert.throws(() => control.start(sessionId, 'blocked while closing'), { code: 'control_session_closing' });
      await assert.rejects(observer.handle({ method: 'session.open', params: { projectRoot: projectDirectory, sessionId } }), { code: 'session_locked' });
      assert.deepEqual(await control.close(sessionId), { sessionId });
      await access(join(sessionDirectory, `${sessionId}.jsonl`));
      await observer.handle({ method: 'session.open', params: { projectRoot: projectDirectory, sessionId } });
      const history = await observer.handle({ method: 'session.read', params: { sessionId } });
      assert.ok(history.events.length > 0);
    } finally {
      await Promise.allSettled([control.release(), observer.release()]);
    }
  });
});
