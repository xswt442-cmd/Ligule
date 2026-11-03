import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LoggingMessageNotificationSchema } from '../core/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import { createConnection } from '../core/dist/host/connection.js';
import { hostProviderFromConfig, serveHost } from '../core/dist/host/host.js';
import { createMemoryConnectionPair } from '../core/dist/host/memory.js';
import { detectPermissionCapabilities } from '../core/dist/capability/permission-capabilities.js';
import { createConfig } from '../core/dist/kernel/config.js';
import { modeDirectories } from '../core/dist/kernel/modes.js';
import { createPermissionContext } from '../core/dist/kernel/permission.js';
import { listenFetchable } from './helpers/port.ts';
import { connectMcp } from './helpers/mcp-control.mjs';
import { requestAgentControl } from '../core/dist/host/agent-control-runtime.js';
import { setTrusted } from '../core/dist/kernel/workspace-trust.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(process.env.LIGULE_MCP_E2E_WORKSPACE_ROOT ?? repoRoot);
const testplaceRoot = resolve(process.env.LIGULE_MCP_E2E_TESTPLACE_ROOT ?? join(workspaceRoot, 'testplace'));
const cliPath = resolve(process.env.LIGULE_MCP_CLI ?? join(repoRoot, 'tui', 'dist', 'cli.js'));
const sdkRoot = resolve(process.env.LIGULE_MCP_SDK_ROOT ?? join(repoRoot, 'core', 'node_modules', '@modelcontextprotocol', 'sdk'));

function recordTrace(trace, action, fields = {}) {
  trace.push({ time: new Date().toISOString(), action, ...fields });
}

function toolData(result, action) {
  assert.equal(result.isError, undefined, `${action}: ${JSON.stringify(result.structuredContent ?? result)}`);
  assert.ok(result.structuredContent !== undefined, `${action}: MCP result has no structuredContent`);
  return result.structuredContent;
}

function toolFailurePayload(result) {
  let payload;
  try { payload = JSON.parse(result.content?.[0]?.text ?? '{}'); }
  catch { payload = {}; }
  const actual = result.structuredContent?.code ?? payload.code;
  return { ...payload, code: actual };
}

function toolFailureCode(result) {
  return toolFailurePayload(result).code;
}

function toolFailure(result, code, action) {
  assert.equal(result.isError, true, `${action}: expected an MCP tool error`);
  const payload = toolFailurePayload(result);
  const actual = payload.code;
  assert.equal(actual, code, `${action}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(check, label, within = 10_000) {
  const until = Date.now() + within;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`mcp_e2e_wait_timeout:${label}`);
}

async function waitForOutcome(client, operationId) {
  return await waitFor(async () => {
    const result = toolData(await client.callTool({ name: 'ligule_run_status', arguments: { operationId } }), 'run_status');
    return result.state === 'running' ? undefined : result;
  }, `operation ${operationId} to settle`);
}

async function localControl(dataRoot, projectRoot, sessionId, request) {
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = dataRoot;
  try { return await requestAgentControl(projectRoot, sessionId, request); }
  finally {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
  }
}

async function waitForLocalInteraction(client, dataRoot, projectRoot, sessionId, operationId, label) {
  let cursor = 0;
  return await waitFor(async () => {
    const run = toolData(await client.callTool({ name: 'ligule_run_status', arguments: { operationId } }), `${label}_status`);
    if (run.state !== 'running') return { run };
    const snapshot = await localControl(dataRoot, projectRoot, sessionId, {
      action: 'status', after: cursor, limit: 50, waitMs: 0,
    });
    cursor = Math.max(cursor, snapshot.nextCursor);
    const interaction = snapshot.pendingInteractions?.[0];
    return interaction === undefined ? undefined : { run, interaction };
  }, label);
}

async function findHistoryRecord(client, sessionId, predicate) {
  let page = toolData(await client.callTool({ name: 'ligule_session_read', arguments: { sessionId, limit: 50 } }), 'session_read_history_page');
  for (;;) {
    const found = page.records.find(predicate);
    if (found !== undefined) return { record: found, page };
    if (!page.hasMore || page.nextBefore === null) return undefined;
    page = toolData(await client.callTool({
      name: 'ligule_session_read', arguments: { sessionId, limit: 50, before: page.nextBefore },
    }), 'session_read_history_older_page');
  }
}

function sse(response, delta) {
  const frames = [
    { choices: [{ index: 0, delta, finish_reason: delta.tool_calls === undefined ? 'stop' : 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
}

function tomlString(value) {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

async function seedFullAccessSession({ projectRoot, sessionDirectory, homeDirectory, baseURL, apiKeyName, capabilities }) {
  const config = createConfig({ user: {
    boundary: projectRoot,
    workspaceRoot: projectRoot,
    host: { sessionDirectory },
    model: {
      api: 'chat-completions',
      baseURL,
      model: 'operator-e2e-local',
      apiKeyEnv: apiKeyName,
      services: [{
        id: 'deepseek', name: 'DeepSeek', api: 'chat-completions',
        baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'OPERATOR_DEEPSEEK_KEY', models: ['deepseek-flash'],
      }],
    },
    policy: { mode: 'ask' },
    limits: { contextTokens: 200000 },
    loop: { iterations: 8, modelCalls: 16 },
  } });
  const permission = createPermissionContext('read-only', 'policy', capabilities);
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    config,
    provider: hostProviderFromConfig(config),
    policy: config.policy,
    interactive: true,
    permission,
    permissionControl: true,
    modeName: 'minimal',
    modePaths: modeDirectories(projectRoot, fileURLToPath(new URL('../core/modes/', import.meta.url)), homeDirectory),
  });
  const client = createConnection(pair.client);
  try {
    const created = await client.request('session.create', {
      projectRoot,
      initialMode: 'minimal',
      initialPolicy: 'ask',
      initialProvider: 'deepseek',
      initialModel: 'deepseek-flash',
      initialThinkingEffort: 'high',
      initialOutputTokens: 128000,
      initialLoopIterations: 5,
    });
    await client.request('permission.set', {
      sessionId: created.sessionId,
      permissionProfile: 'full-access',
      permissionNetwork: 'unrestricted',
      confirmFullAccess: true,
      confirmNetwork: true,
    });
    return created.sessionId;
  } finally {
    pair.client.output.end();
    await host.release();
  }
}

function gate() {
  let open;
  let started;
  const waiting = new Promise((resolve) => { open = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  let isStarted = false;
  let isOpen = false;
  return {
    get started() { return isStarted; },
    entered,
    waiting,
    markStarted() { isStarted = true; started(); },
    release() { if (!isOpen) { isOpen = true; open(); } },
  };
}

// This case starts four real stdio MCP servers in sequence (initial, reopen, operator, foreign
// rejection). Each server boots a fresh Host, which probes OS sandboxing/permissions first —
// measured here at about 6.4s for a small workspace and about 25s for this repository. The
// suite-level guard therefore covers four startups; the individual protocol steps are still
// bounded by their own waits, and the product has no timeout of its own here.
test('a real stdio MCP client controls, reads, cancels, and reopens Host sessions', { timeout: 180_000 }, async (t) => {
  const trace = [];
  const clients = new Set();
  const tempParent = resolve(process.env.LIGULE_MCP_E2E_TEMP_ROOT ?? join(testplaceRoot, 'tmp'));
  await mkdir(tempParent, { recursive: true });
  const tempRoot = await mkdtemp(join(tempParent, 'mcp-stdio-e2e-'));
  const verifiedTempRoot = await realpath(tempRoot);
  assert.ok(verifiedTempRoot.startsWith(`${await realpath(tempParent)}${process.platform === 'win32' ? '\\' : '/'}`));
  const projectRoot = join(tempRoot, 'project');
  const dataRoot = join(tempRoot, 'isolated-data-root');
  const sessionDirectory = join(projectRoot, 'sessions');
  await Promise.all([mkdir(projectRoot), mkdir(dataRoot)]);
  await mkdir(sessionDirectory);

  const approvalMarker = join(projectRoot, 'approval-denied.txt');
  const apiKeyName = 'LIGULE_MCP_E2E_API_KEY';
  const apiKey = 'local-stub-key';
  const httpRequests = [];
  const providerGates = new Map([
    ['MCP_E2E_GATE_A', gate()],
    ['MCP_E2E_GATE_B', gate()],
    ['MCP_E2E_CANCEL_GATE', gate()],
    ['MCP_E2E_DISCONNECT_GATE', gate()],
  ]);
  let callId = 0;
  const endpoint = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      const lastUser = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      const inputTags = ['MCP_E2E_DELAYED', 'MCP_E2E_LARGE_', 'MCP_E2E_CANCEL_GATE', 'MCP_E2E_EXEC_BLOCKED', 'MCP_E2E_DISCONNECT_GATE', 'MCP_E2E_APPROVAL_DENIED', 'MCP_E2E_STRUCTURED']
        .filter((tag) => lastUser.includes(tag));
      httpRequests.push({ url: request.url, model: body.model, inputTags, lastRole: body.messages.at(-1)?.role,
        toolNames: (body.tools ?? []).map((tool) => tool.function?.name) });
      if (body.messages.at(-1)?.role === 'tool') {
        sse(response, { content: 'MCP task finished' });
        return;
      }
      if (lastUser.includes('MCP_E2E_DELAYED')) {
        await delay(750);
        if (!response.destroyed) sse(response, { content: 'delayed task finished' });
        return;
      }
      if (lastUser.includes('MCP_E2E_STRUCTURED')) {
        assert.ok((body.tools ?? []).some((tool) => tool.function?.name === 'ligule_delegation_result'));
        callId += 1;
        sse(response, { tool_calls: [{ index: 0, id: `mcp-e2e-call-${callId}`, type: 'function', function: {
          name: 'ligule_delegation_result', arguments: JSON.stringify({ result: { answer: 'validated by Host' } }),
        } }] });
        return;
      }
      const waitingGate = [...providerGates].find(([tag]) => lastUser.includes(tag))?.[1];
      if (waitingGate !== undefined) {
        waitingGate.markStarted();
        await waitingGate.waiting;
        if (!response.destroyed) sse(response, { content: 'gated task finished' });
        return;
      }
      let tool;
      let args;
      if (lastUser.includes('MCP_E2E_EXEC_BLOCKED')) {
        tool = 'exec';
        args = { command: 'node --version' };
      } else if (lastUser.includes('MCP_E2E_APPROVAL_DENIED')) {
        tool = 'create';
        args = { path: 'approval-denied.txt', content: 'must not be written' };
      }
      if (tool === undefined) {
        sse(response, { content: 'MCP task finished' });
        return;
      }
      callId += 1;
      sse(response, { tool_calls: [{ index: 0, id: `mcp-e2e-call-${callId}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] });
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    }
  });

  let serverStarted = false;
  let logPath;
  const contexts = [];
  const key = `http://127.0.0.1:${await listenFetchable(endpoint)}/v1`;
  serverStarted = true;
  await writeFile(join(dataRoot, 'config.toml'), [
    '[model]',
    'api = "chat-completions"',
    `baseURL = ${tomlString(key)}`,
    'model = "mcp-e2e-local"',
    `apiKeyEnv = "${apiKeyName}"`,
    '',
    '[policy]',
    'mode = "ask"',
    '',
    '[host]',
    `sessionDirectory = ${tomlString(sessionDirectory)}`,
    '',
    '[loop]',
    'iterations = 6',
    'modelCalls = 12',
    '',
    '[limits]',
    'contextTokens = 200000',
    'execBytes = 8192',
  ].join('\n'));
  const foreignRoot = join(tempRoot, 'foreign-project');
  await mkdir(foreignRoot);

  const connect = async () => {
    await setTrusted(projectRoot, true, join(dataRoot, 'tui-trust.json'));
    const context = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey, sdkRoot });
    contexts.push(context);
    clients.add(context);
    return context;
  };
  const close = async (context) => {
    if (!clients.has(context)) return;
    clients.delete(context);
    await context.close();
  };

  try {
    const first = await connect();
    assert.equal(first.client.getServerVersion()?.name, 'ligule', 'SDK initialize returns the real server identity');
    recordTrace(trace, 'initialize', { server: first.client.getServerVersion() });

    const listed = await first.client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      'ligule_interaction_reply', 'ligule_run', 'ligule_run_await', 'ligule_run_cancel', 'ligule_run_get', 'ligule_run_start', 'ligule_run_status', 'ligule_session_close', 'ligule_session_configure', 'ligule_session_create',
      'ligule_session_list', 'ligule_session_open', 'ligule_session_read', 'ligule_session_send',
    ]);
    const readSchema = listed.tools.find((tool) => tool.name === 'ligule_session_read').inputSchema;
    assert.ok(readSchema.properties.at && readSchema.properties.offset, 'tools/list publishes bounded exact-event chunk reads');
    assert.deepEqual(readSchema.required, ['sessionId']);
    recordTrace(trace, 'tools_list', { toolNames });

    await assert.rejects(
      first.client.callTool({ name: 'not_a_ligule_tool', arguments: {} }),
      (error) => error.code === -32602,
      'unknown tools fail as MCP InvalidParams',
    );
    await assert.rejects(
      first.client.callTool({ name: 'ligule_session_create', arguments: {} }),
      (error) => error.code === -32602,
      'missing required schema arguments fail as MCP InvalidParams',
    );
    await assert.rejects(
      first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId: 'x', input: 'ok', extra: true } }),
      (error) => error.code === -32602,
      'additional arguments fail the declared schema',
    );
    recordTrace(trace, 'schema_rejections', { unknownTool: -32602, missingArgument: -32602, extraArgument: -32602 });

    const project = await realpath(projectRoot);
    const created = toolData(await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'session_create');
    const sessionId = created.sessionId;
    recordTrace(trace, 'session_create', { sessionId });
    const readOnlySettings = toolData(await first.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }), 'default_session_settings_read');
    assert.equal(readOnlySettings.applies, 'unchanged');
    const unauthorizedChange = await first.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 1024 } } });
    toolFailure(unauthorizedChange, 'control_operator_required', 'default_settings_change_denied');
    const opened = toolData(await first.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } }), 'session_open');
    assert.equal(opened.sessionId, sessionId);
    recordTrace(trace, 'session_open_existing', { sessionId });
    const legacy = toolData(await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'session_create_legacy_fixture');
    const legacyPath = join(sessionDirectory, `${legacy.sessionId}.jsonl`);
    await writeFile(legacyPath, `${JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: legacy.sessionId,
      projectRoot: project, createdAt: 'Thu, 01 Jan 2026 00:00:00 GMT'.padEnd(140, ' ') })}\n${JSON.stringify({ seq: 1, kind: 'label', name: 'n'.repeat(140) })}\n`);
    const sessions = toolData(await first.client.callTool({ name: 'ligule_session_list', arguments: { projectRoot: project, limit: 20 } }), 'session_list');
    assert.ok(sessions.sessions.some((session) => session.sessionId === sessionId));
    const normalizedLegacy = sessions.sessions.find((session) => session.sessionId === legacy.sessionId);
    assert.equal(normalizedLegacy.name.length, 120, 'legacy session names are bounded at the MCP boundary');
    assert.equal(normalizedLegacy.createdAt.length, 128, 'legacy timestamps are bounded at the MCP boundary');
    const legacyLines = (await readFile(legacyPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(legacyLines[0].createdAt.length, 140, 'MCP normalization does not rewrite the stored timestamp');
    assert.equal(legacyLines[1].name.length, 140, 'MCP normalization does not rewrite the stored name');
    recordTrace(trace, 'session_list', { count: sessions.sessions.length, includesCreated: true });

    const foreignCreate = await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: foreignRoot } });
    toolFailure(foreignCreate, 'control_project_forbidden', 'session_create_foreign_project');
    const foreignList = await first.client.callTool({ name: 'ligule_session_list', arguments: { projectRoot: foreignRoot } });
    toolFailure(foreignList, 'control_project_forbidden', 'session_list_foreign_project');
    const foreignOpen = await first.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: foreignRoot, sessionId } });
    toolFailure(foreignOpen, 'control_project_forbidden', 'session_open_foreign_project');
    const missingOpen = await first.client.callTool({
      name: 'ligule_session_open', arguments: { projectRoot: project, sessionId: '00000000-0000-4000-8000-000000000000' },
    });
    toolFailure(missingOpen, 'session_not_found', 'session_open_missing');
    recordTrace(trace, 'project_and_missing_session_boundaries', {
      create: toolFailureCode(foreignCreate), list: toolFailureCode(foreignList),
      open: toolFailureCode(foreignOpen), missing: toolFailureCode(missingOpen),
    });

    const startAt = performance.now();
    const delayed = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_DELAYED' } }), 'run_start_delayed');
    const startMs = Math.round(performance.now() - startAt);
    assert.ok(startMs < 700, `run_start waited ${startMs}ms for a deliberately delayed Provider`);
    assert.equal(delayed.state, 'running');
    const running = toolData(await first.client.callTool({ name: 'ligule_run_status', arguments: { operationId: delayed.operationId } }), 'run_status_running');
    assert.equal(running.state, 'running');
    const firstProviderRequest = await waitFor(() => httpRequests.find((entry) => entry.inputTags.includes('MCP_E2E_DELAYED')), 'delayed HTTP request');
    assert.ok(firstProviderRequest.toolNames.includes('ask_user_question'), 'the local UI can answer questions while an MCP-owned session is active');
    recordTrace(trace, 'run_start_returns_before_provider', { operationId: delayed.operationId, startMs, state: running.state });
    const delayedDone = toolData(await first.client.callTool({ name: 'ligule_run_await', arguments: {
      operationId: delayed.operationId, timeoutMs: 5_000,
    } }), 'run_await_delayed');
    assert.equal(delayedDone.state, 'done');
    assert.equal(delayedDone.timedOut, false);
    assert.equal(delayedDone.result.state, 'completed');
    assert.equal(delayedDone.result.output.text, 'delayed task finished');
    recordTrace(trace, 'run_await_done', { operationId: delayed.operationId, state: delayedDone.state, result: delayedDone.result.state });

    const singleCallRun = toolData(await first.client.callTool({ name: 'ligule_run', arguments: {
      sessionId, input: 'MCP_E2E_SINGLE_CALL', timeoutMs: 5_000,
    } }), 'run_delegate_and_await');
    assert.equal(singleCallRun.state, 'done');
    assert.equal(singleCallRun.timedOut, false);
    assert.equal(singleCallRun.result.output.text, 'MCP task finished');
    recordTrace(trace, 'run_delegate_and_await', {
      operationId: singleCallRun.operationId, state: singleCallRun.state, result: singleCallRun.result.state,
    });

    const largeInput = `MCP_E2E_LARGE_${'x'.repeat(13_000)}`;
    const largeRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: largeInput } }), 'run_start_large');
    const largeDone = await waitForOutcome(first.client, largeRun.operationId);
    assert.equal(largeDone.state, 'done');
    const foundLarge = await findHistoryRecord(first.client, sessionId, (record) => record.kind === 'user' && record.json.includes('MCP_E2E_LARGE_'));
    const userRecord = foundLarge?.record;
    assert.ok(userRecord, 'the large user record is in the persistent session history');
    assert.equal(userRecord.offset, 0);
    assert.ok(userRecord.totalCharacters > 8192);
    assert.ok(userRecord.json.length <= 8192);
    let reconstructed = userRecord.json;
    let offset = userRecord.nextOffset;
    while (offset !== null) {
      const chunk = toolData(await first.client.callTool({
        name: 'ligule_session_read', arguments: { sessionId, at: userRecord.seq, offset },
      }), 'session_read_chunk').records;
      assert.equal(chunk.length, 1);
      assert.equal(chunk[0].seq, userRecord.seq);
      assert.equal(chunk[0].offset, offset);
      assert.ok(chunk[0].json.length <= 8192);
      reconstructed += chunk[0].json;
      offset = chunk[0].nextOffset;
    }
    const fullUserRecord = JSON.parse(reconstructed);
    assert.equal(fullUserRecord.raw ?? fullUserRecord.text, largeInput, 'all chunks combine to the exact original record');
    assert.equal(reconstructed.length, userRecord.totalCharacters);
    recordTrace(trace, 'session_read_chunked_large_event', {
      seq: userRecord.seq, totalCharacters: userRecord.totalCharacters,
      chunks: Math.ceil(userRecord.totalCharacters / 8192), exactInputRestored: true,
    });

    const sessionB = toolData(await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'session_create_b');
    const operationA = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_GATE_A' } }), 'run_start_gate_a');
    const operationB = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId: sessionB.sessionId, input: 'MCP_E2E_GATE_B' } }), 'run_start_gate_b');
    await Promise.all([providerGates.get('MCP_E2E_GATE_A').entered, providerGates.get('MCP_E2E_GATE_B').entered]);
    const waitExpired = toolData(await first.client.callTool({ name: 'ligule_run_await', arguments: {
      operationId: operationB.operationId, timeoutMs: 1,
    } }), 'run_await_timeout');
    assert.equal(waitExpired.state, 'running');
    assert.equal(waitExpired.timedOut, true, 'a server wait timeout leaves the active run intact');
    const cancelledA = toolData(await first.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: operationA.operationId } }), 'run_cancel_a');
    assert.equal(cancelledA.state, 'cancelled');
    const stillRunningB = toolData(await first.client.callTool({ name: 'ligule_run_status', arguments: { operationId: operationB.operationId } }), 'run_status_b_after_cancel_a');
    assert.equal(stillRunningB.state, 'running', 'cancelling A leaves B blocked on its independent Provider response');
    providerGates.get('MCP_E2E_GATE_A').release();
    providerGates.get('MCP_E2E_GATE_B').release();
    const completedB = toolData(await first.client.callTool({ name: 'ligule_run_await', arguments: {
      operationId: operationB.operationId, timeoutMs: 5_000,
    } }), 'run_await_after_timeout');
    assert.equal(completedB.state, 'done');
    assert.equal(completedB.result.state, 'completed');
    recordTrace(trace, 'cancel_is_scoped_to_originating_session', {
      operationA: operationA.operationId, operationB: operationB.operationId,
      aState: cancelledA.state, bStateAfterCancelA: stillRunningB.state, bFinalState: completedB.state,
    });

    const cancelRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_CANCEL_GATE' } }), 'run_start_cancel_gate');
    await providerGates.get('MCP_E2E_CANCEL_GATE').entered;
    const concurrent = await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'must be rejected' } });
    toolFailure(concurrent, 'run_already_running', 'run_start_concurrent');
    const cancelled = toolData(await first.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: cancelRun.operationId } }), 'run_cancel_gate');
    assert.equal(cancelled.state, 'cancelled');
    providerGates.get('MCP_E2E_CANCEL_GATE').release();
    recordTrace(trace, 'run_cancel_is_scoped_to_active_operation', { operationId: cancelRun.operationId, state: cancelled.state, concurrentCode: toolFailureCode(concurrent) });

    const sandbox = await detectPermissionCapabilities();
    const sandboxAvailable = sandbox.capabilities.filesystemRead !== 'unavailable'
      && sandbox.capabilities.filesystemWrite !== 'unavailable'
      && sandbox.capabilities.network === 'full'
      && sandbox.capabilities.process === 'full';
    const blockedExec = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_EXEC_BLOCKED' } }), 'run_start_restricted_exec');
    const blockedState = await waitForLocalInteraction(first.client, dataRoot, project, sessionId, blockedExec.operationId, 'restricted Shell decision');
    const blockedApproval = blockedState.interaction;
    if (sandboxAvailable) {
      assert.equal(blockedApproval?.type, 'approval', 'the local user must receive a policy approval for the restricted Shell call');
      const denied = await localControl(dataRoot, project, sessionId, {
        action: 'reply', requestId: blockedApproval.requestId, type: 'approval', decision: 'deny',
      });
      assert.equal(denied.source, 'human');
    } else assert.equal(blockedApproval, undefined, 'unavailable sandbox capability must refuse before approval');
    assert.equal((await waitForOutcome(first.client, blockedExec.operationId)).state, 'done');
    const blockedExecResult = await findHistoryRecord(first.client, sessionId, (record) => record.kind === 'tool' && record.json.includes('node --version'));
    assert.ok(blockedExecResult, 'the restricted command attempt is recorded');
    const blockedExecRecord = JSON.parse(blockedExecResult.record.json);
    assert.equal(blockedExecRecord.result.kind, 'refusal');
    assert.equal(blockedExecRecord.result.code, blockedApproval === undefined ? 'permission_sandbox_unavailable' : 'ask_declined');
    recordTrace(trace, 'default_mcp_shell_attempt_refused_before_spawn', {
      code: blockedExecRecord.result.code, sandboxAvailable, approvalSource: blockedApproval === undefined ? null : 'human', sideEffectStarted: false,
    });

    const approvalRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_APPROVAL_DENIED' } }), 'run_start_approval');
    const approvalDone = await waitForOutcome(first.client, approvalRun.operationId);
    assert.equal(approvalDone.state, 'done');
    await assert.rejects(access(approvalMarker), (error) => error.code === 'ENOENT', 'the denied create operation left no file');
    const deniedToolRecord = await findHistoryRecord(first.client, sessionId, (record) => record.kind === 'tool' && record.json.includes('approval-denied.txt'));
    const deniedTool = deniedToolRecord === undefined ? undefined : JSON.parse(deniedToolRecord.record.json);
    assert.equal(deniedTool?.result?.kind, 'refusal');
    assert.equal(deniedTool?.result?.code, 'permission_read_only');
    recordTrace(trace, 'default_mcp_permission_refuses_write', { operationId: approvalRun.operationId, state: approvalDone.state, refusalCode: deniedTool.result.code, markerAbsent: true });

    const locked = await connect();
    const lockedResult = await locked.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } });
    toolFailure(lockedResult, 'session_locked', 'session_open_cross_process_lock');
    recordTrace(trace, 'cross_process_session_lock', { sessionId, errorCode: toolFailureCode(lockedResult) });
    await close(locked);

    const disconnectRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_DISCONNECT_GATE' } }), 'run_start_disconnect_gate');
    await providerGates.get('MCP_E2E_DISCONNECT_GATE').entered;
    const closeAt = performance.now();
    await close(first);
    providerGates.get('MCP_E2E_DISCONNECT_GATE').release();
    const closeMs = Math.round(performance.now() - closeAt);
    assert.ok(closeMs < 2_000, `stdio disconnect took ${closeMs}ms to release the Host`);
    recordTrace(trace, 'stdio_disconnect_releases_active_run', { operationId: disconnectRun.operationId, closeMs });

    const resumed = await connect();
    const reattached = toolData(await resumed.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } }), 'session_open_after_restart');
    assert.equal(reattached.sessionId, sessionId);
    const persisted = await findHistoryRecord(resumed.client, sessionId, (record) => record.kind === 'user' && record.json.includes('MCP_E2E_LARGE_'));
    assert.ok(persisted, 'the large user record persists after restart');
    const staleOperation = await resumed.client.callTool({ name: 'ligule_run_status', arguments: { operationId: disconnectRun.operationId } });
    toolFailure(staleOperation, 'operation_not_found', 'run_status_old_process_operation');
    recordTrace(trace, 'restart_reopens_history_and_rejects_old_operation', {
      sessionId, historyRecords: persisted.page.records.length, oldOperationCode: toolFailureCode(staleOperation),
    });
    await close(resumed);
    assert.ok(httpRequests.length >= 5, `expected real Provider HTTP traffic, saw ${httpRequests.length} requests`);
    recordTrace(trace, 'provider_stub_requests', { count: httpRequests.length, endpoint: '127.0.0.1 local HTTP stub' });
  } catch (error) {
    recordTrace(trace, 'test_failure', {
      errorName: error instanceof Error ? error.name : 'unknown',
      providerRequests: httpRequests.map(({ inputTags, lastRole }) => ({ inputTags, lastRole })),
    });
    throw error;
  } finally {
    for (const waiting of providerGates.values()) waiting.release();
    for (const context of [...clients]) {
      try { await close(context); } catch (error) { recordTrace(trace, 'cleanup_error', { code: error instanceof Error ? error.name : 'unknown' }); }
    }
    if (serverStarted) {
      endpoint.closeAllConnections();
      await new Promise((done) => endpoint.close(done));
    }
    const readings = join(testplaceRoot, 'readings', 'phase5');
    await mkdir(readings, { recursive: true });
    logPath = join(readings, `mcp-stdio-e2e-${Date.now()}.jsonl`);
    await writeFile(logPath, `${trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    t.diagnostic(`MCP E2E trace: ${logPath}`);
    await rm(verifiedTempRoot, { recursive: true, force: true });
  }
});

test('operator tools configure real sessions, answer Host interactions, and run bounded queues', { timeout: 60_000 }, async (t) => {
  const measured = await detectPermissionCapabilities();
  if (measured.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  const parent = resolve(process.env.LIGULE_MCP_E2E_TEMP_ROOT ?? join(testplaceRoot, 'tmp'));
  await mkdir(parent, { recursive: true });
  const tempRoot = await mkdtemp(join(parent, 'mcp-operator-e2e-'));
  const projectRoot = join(tempRoot, 'project');
  const dataRoot = join(tempRoot, 'data');
  const sessionDirectory = join(projectRoot, 'sessions');
  await Promise.all([mkdir(projectRoot), mkdir(dataRoot)]);
  await mkdir(sessionDirectory);
  const apiKeyName = 'LIGULE_MCP_OPERATOR_E2E_API_KEY';
  const fixtureCredential = 'local-operator-test-key';
  const markerAllowed = join(projectRoot, 'operator-approved.txt');
  const markerDenied = join(projectRoot, 'operator-denied.txt');
  const markerHardDenied = join(projectRoot, 'policy-forbidden.txt');
  const markerSensitive = join(projectRoot, 'operator-secret-executed.txt');
  const requests = [];
  const queueGate = gate();
  const cancelGate = gate();
  const draftGate = gate();
  let callId = 0;
  const endpoint = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const last = body.messages.at(-1);
    const userText = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    if (userText.includes('MCP_OPERATOR_DRAFT_GATE')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'A separately inspectable provisional fragment.' } }] })}\n\n`);
      await draftGate.waiting;
      if (!response.destroyed) response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (userText.includes('MCP_OPERATOR_RESULT_REPAIR')) {
      callId += 1;
      sse(response, { tool_calls: [{ index: 0, id: `operator-call-${callId}`, type: 'function', function: {
        name: 'ligule_delegation_result', arguments: JSON.stringify({ result: { answer: last?.role === 'tool' ? 'corrected result' : 42 } }),
      } }] });
      return;
    }
    if (userText.includes('MCP_OPERATOR_RESULT_INVALID') && last?.role !== 'tool') {
      callId += 1;
      sse(response, { tool_calls: [{ index: 0, id: `operator-call-${callId}`, type: 'function', function: {
        name: 'ligule_delegation_result', arguments: JSON.stringify({ result: { answer: 42 } }),
      } }] });
      return;
    }
    if (userText.includes('MCP_OPERATOR_STRUCTURED')) {
      assert.ok((body.tools ?? []).some((tool) => tool.function?.name === 'ligule_delegation_result'));
      assert.ok((body.tools ?? []).some((tool) => tool.function?.name === 'read'));
      assert.equal((body.tools ?? []).some((tool) => tool.function?.name === 'create'), false,
        'the per-run inline mode narrows the persistent full mode');
      callId += 1;
      sse(response, { tool_calls: [{ index: 0, id: `operator-call-${callId}`, type: 'function', function: {
        name: 'ligule_delegation_result', arguments: JSON.stringify({ result: { answer: 'validated by Host' } }),
      } }] });
      return;
    }
    if (userText.includes('MCP_OPERATOR_LOOP_LIMIT')) {
      callId += 1;
      sse(response, { tool_calls: [{ index: 0, id: `operator-call-${callId}`, type: 'function', function: { name: 'find', arguments: JSON.stringify({ pattern: '*' }) } }] });
      return;
    }
    if (last?.role === 'tool') { sse(response, { content: 'operator task completed' }); return; }
    const waiting = userText.includes('MCP_OPERATOR_QUEUE_GATE') ? queueGate
      : userText.includes('MCP_OPERATOR_CANCEL_GATE') ? cancelGate : undefined;
    if (waiting !== undefined) {
      waiting.markStarted();
      await waiting.waiting;
      if (!response.destroyed) sse(response, { content: 'gate released' });
      return;
    }
    let tool;
    let args;
    if (userText.includes('MCP_OPERATOR_APPROVE')) {
      tool = 'create'; args = { path: 'operator-approved.txt', content: 'approved by the operator' };
    } else if (userText.includes('MCP_OPERATOR_DENY')) {
      tool = 'create'; args = { path: 'operator-denied.txt', content: 'must remain absent' };
    } else if (userText.includes('MCP_OPERATOR_HARD_DENY')) {
      tool = 'create'; args = { path: 'policy-forbidden.txt', content: 'policy must remain final' };
    } else if (userText.includes('MCP_OPERATOR_QUESTION')) {
      tool = 'ask_user_question'; args = { questions: JSON.stringify([{ question: 'Which option should be used?', options: [{ label: 'Option A' }, { label: 'Option B' }] }]) };
    } else if (userText.includes('MCP_OPERATOR_SENSITIVE_APPROVAL')) {
      // 让 Operator 的敏感内容检查处理这次审批；原生命令避免先被脚本绑定检查拒绝。
      tool = 'exec'; args = { command: "echo 'Bearer synthetic-secret-token' > operator-secret-executed.txt" };
    } else if (userText.includes('MCP_OPERATOR_SENSITIVE_HEADER')) {
      tool = 'create'; args = { path: 'operator-secret-executed.txt', content: 'X-API-Key: synthetic-header-secret' };
    }
    if (tool === undefined) { sse(response, { content: 'operator task completed' }); return; }
    callId += 1;
    sse(response, { tool_calls: [{ index: 0, id: `operator-call-${callId}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] });
  });
  const baseURL = `http://127.0.0.1:${await listenFetchable(endpoint)}/v1`;
  await writeFile(join(dataRoot, 'config.toml'), [
    '[model]', 'api = "chat-completions"', `baseURL = ${tomlString(baseURL)}`,
    'model = "operator-e2e-local"', `apiKeyEnv = "${apiKeyName}"`, '',
    'services = [{ id = "deepseek", name = "DeepSeek", api = "chat-completions", baseURL = "https://api.deepseek.com/v1", apiKeyEnv = "OPERATOR_DEEPSEEK_KEY", models = ["deepseek-flash"] }]', '',
    '[policy]', 'mode = "ask"', '', '[host]', `sessionDirectory = ${tomlString(sessionDirectory)}`,
    '', '[limits]', 'contextTokens = 200000', '', '[loop]', 'iterations = 8', 'modelCalls = 16', '',
  ].join('\n'));
  let preauthorizedSessionId;
  let context;
  try {
    await setTrusted(projectRoot, true, join(dataRoot, 'tui-trust.json'));
    preauthorizedSessionId = await seedFullAccessSession({
      projectRoot, sessionDirectory, homeDirectory: dataRoot, baseURL, apiKeyName, capabilities: measured.capabilities,
    });
    context = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey: fixtureCredential, sdkRoot, operator: true });
  } catch (error) {
    endpoint.closeAllConnections();
    await new Promise((done) => endpoint.close(done));
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  const notifications = [];
  context.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { notifications.push(notification); });
  try {
    const names = (await context.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 14);
    const project = await realpath(projectRoot);
    const invalidInitialModel = await context.client.callTool({ name: 'ligule_session_create', arguments: {
      projectRoot: project, initial: { model: { provider: 'legacy', model: 'not-in-this-config' } },
    } });
    toolFailure(invalidInitialModel, 'model_not_available', 'unlisted_initial_model');
    const created = toolData(await context.client.callTool({ name: 'ligule_session_create', arguments: {
      projectRoot: project, initial: {
        mode: 'minimal', policy: 'ask', model: { provider: 'deepseek', model: 'deepseek-flash' },
        thinking: { effort: 'high' }, outputTokens: 128000, loopIterations: 5,
      },
    } }), 'operator_session_create');
    assert.equal(created.settingsApplied, true);
    const sessionId = preauthorizedSessionId;
    const opened = toolData(await context.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } }), 'operator_open_preconfigured_session');
    assert.equal(opened.sessionId, sessionId);

    const readSettings = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }), 'session_configure_read');
    assert.equal(readSettings.applies, 'unchanged');
    assert.equal(readSettings.effective.policy.mode, 'ask');
    assert.equal(readSettings.effective.loopIterations, 5);
    assert.equal(readSettings.effective.generation.model.provider, 'deepseek');
    assert.equal(readSettings.effective.generation.thinking.supported, true);
    assert.equal(readSettings.effective.generation.thinking.effort, 'high');
    assert.equal(readSettings.effective.generation.outputTokens, 128000);
    assert.equal(readSettings.effective.generation.maxOutputTokens, 393216,
      'MCP exposes the verified DeepSeek model ceiling instead of the adapter default');
    assert.ok(readSettings.available.services.some((service) => service.id === 'legacy' && service.models[0].id === 'operator-e2e-local'));
    const configuredLoop = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId, changes: { loopIterations: 7 },
    } }), 'session_configure_loop_limit');
    assert.equal(configuredLoop.applies, 'now');
    assert.equal(configuredLoop.effective.loopIterations, 7);
    const cappedSession = toolData(await context.client.callTool({ name: 'ligule_session_create', arguments: {
      projectRoot: project, initial: { mode: 'full', policy: 'auto', loopIterations: 2 },
    } }), 'operator_loop_cap_session');
    const loopRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: {
      sessionId: cappedSession.sessionId, input: 'MCP_OPERATOR_LOOP_LIMIT',
    } }), 'operator_loop_cap_run');
    const loopFailure = await waitForOutcome(context.client, loopRun.operationId);
    assert.equal(loopFailure.state, 'failed');
    assert.equal(loopFailure.code, 'loop_iteration_limit');
    const loopTerminal = await findHistoryRecord(context.client, cappedSession.sessionId,
      (record) => record.kind === 'turn' && record.json.includes('loop_iteration_limit'));
    assert.ok(loopTerminal, 'the configured loop cap records a failed turn instead of silently stopping');
    const loopTurn = JSON.parse(loopTerminal.record.json);
    assert.equal(loopTurn.iterations, 2);
    assert.equal(loopTurn.modelCalls, 2);

    const structuredSession = toolData(await context.client.callTool({ name: 'ligule_session_create', arguments: {
      projectRoot: project, initial: { mode: 'full', policy: 'auto', loopIterations: 5 },
    } }), 'operator_structured_session');
    const structuredRun = toolData(await context.client.callTool({ name: 'ligule_run', arguments: {
      sessionId: structuredSession.sessionId,
      input: 'MCP_OPERATOR_STRUCTURED',
      delegation: {
        mode: { type: 'inline', tools: ['read'], prompt: [] },
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
      },
      timeoutMs: 5_000,
    } }), 'operator_structured_run');
    assert.equal(structuredRun.state, 'done');
    assert.equal(structuredRun.result.validation.status, 'valid');
    assert.deepEqual(structuredRun.result.output.structured, { answer: 'validated by Host' });
    const structuredDigest = structuredRun.result.validation.schemaDigest;
    assert.equal(typeof structuredDigest, 'string');
    const structuredContext = await findHistoryRecord(context.client, structuredSession.sessionId,
      (record) => record.kind === 'turnContext' && record.json.includes(structuredDigest));
    assert.ok(structuredContext, 'the schema digest is recorded in the persistent turn context');
    const modeSnapshot = JSON.parse(structuredContext.record.json).delegationMode;
    assert.equal(modeSnapshot.source, 'inline');
    assert.ok(modeSnapshot.tools.includes('read'));
    assert.equal(modeSnapshot.tools.includes('create'), false);
    const restoredMode = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId: structuredSession.sessionId,
    } }), 'operator_structured_mode_restored');
    assert.equal(restoredMode.effective.mode, 'full');
    const drafting = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: {
      sessionId: structuredSession.sessionId, input: 'MCP_OPERATOR_DRAFT_GATE',
    } }), 'operator_draft_start');
    const pendingOutput = await waitFor(async () => {
      const page = toolData(await context.client.callTool({ name: 'ligule_session_read', arguments: { sessionId: structuredSession.sessionId } }), 'operator_provisional_read');
      return page.provisionalOutput ?? undefined;
    }, 'provisional output persisted through stdio MCP');
    assert.equal(pendingOutput.provisional, true);
    assert.equal(pendingOutput.text, 'A separately inspectable provisional fragment.');
    draftGate.release();
    assert.equal((await waitForOutcome(context.client, drafting.operationId)).state, 'done');
    const committedPage = toolData(await context.client.callTool({ name: 'ligule_session_read', arguments: { sessionId: structuredSession.sessionId } }), 'operator_committed_read');
    assert.equal(committedPage.provisionalOutput, null);
    for (const input of ['MCP_OPERATOR_RESULT_ABSENT', 'MCP_OPERATOR_RESULT_INVALID']) {
      const failedStructure = toolData(await context.client.callTool({ name: 'ligule_run', arguments: {
        sessionId: structuredSession.sessionId,
        input,
        delegation: { outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
        timeoutMs: 5_000,
      } }), 'operator_invalid_structure');
      assert.equal(failedStructure.state, 'failed');
      assert.equal(failedStructure.code, 'delegation_result_missing');
      assert.equal(failedStructure.result.state, 'failed');
      assert.equal(failedStructure.result.stopReason, 'validation_failed');
      assert.equal(failedStructure.result.validation.status, 'invalid');
      assert.deepEqual(failedStructure.result.artifacts, [{ kind: 'session', sessionId: structuredSession.sessionId }]);
      const failedTurn = await findHistoryRecord(context.client, structuredSession.sessionId,
        record => record.kind === 'turn' && record.json.includes('delegation_result_missing'));
      assert.equal(JSON.parse(failedTurn.record.json).status, 'failed');
      if (input.endsWith('INVALID')) {
        assert.ok(await findHistoryRecord(context.client, structuredSession.sessionId,
          record => record.kind === 'tool' && record.json.includes('delegation_result_invalid')));
      }
    }
    const correctedStructure = toolData(await context.client.callTool({ name: 'ligule_run', arguments: {
      sessionId: structuredSession.sessionId,
      input: 'MCP_OPERATOR_RESULT_REPAIR',
      delegation: { outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
      timeoutMs: 5_000,
    } }), 'operator_corrected_structure');
    assert.equal(correctedStructure.state, 'done');
    assert.equal(correctedStructure.result.validation.status, 'valid');
    assert.deepEqual(correctedStructure.result.output.structured, { answer: 'corrected result' });
    const invalidConfiguredModel = await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId, changes: { model: { provider: 'legacy', model: 'not-in-this-config' } },
    } });
    toolFailure(invalidConfiguredModel, 'model_not_available', 'unlisted_session_model');
    const generationChanged = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId, changes: {
        model: { provider: 'legacy', model: 'operator-e2e-local' }, thinking: null, outputTokens: 2048,
      },
    } }), 'session_configure_model_and_budget');
    assert.equal(generationChanged.applies, 'now');
    assert.equal(generationChanged.effective.generation.maxOutputTokens, 8192);
    const modeChanged = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { mode: 'full' } } }), 'session_configure_mode_full');
    assert.equal(modeChanged.applies, 'now');
    assert.equal(modeChanged.effective.mode, 'full');
    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { mode: 'minimal' } } }), 'session_configure_mode_minimal');
    const unsupported = await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { thinking: { effort: 'high' } } } });
    toolFailure(unsupported, 'provider_thinking_unsupported', 'unsupported_thinking');
    await assert.rejects(context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { mode: 'minimal', policy: 'ask' } } }),
      (error) => error.code === -32602, 'schema rejects cross-category partial configuration');
    const changed = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 1024 } } }), 'session_configure_output');
    assert.equal(changed.applies, 'now');
    assert.equal(changed.effective.generation.outputTokens, 1024);
    const simple = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_WIRE_BUDGET' } }), 'operator_budget_run');
    assert.equal((await waitForOutcome(context.client, simple.operationId)).state, 'done');
    assert.equal(requests.find((body) => body.messages.at(-1)?.content === 'MCP_OPERATOR_WIRE_BUDGET')?.max_tokens, 1024);

    const approveRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_APPROVE' } }), 'operator_approval_run');
    const approvalStatus = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: approveRun.operationId } }), 'operator_approval_status');
      return status.pendingInteractions.some((interaction) => interaction.type === 'approval') ? status : undefined;
    }, 'approval request');
    const approval = approvalStatus.pendingInteractions.find((interaction) => interaction.type === 'approval');
    assert.equal(approval.details.tool, 'create');
    assert.equal(approval.details.args.path, 'operator-approved.txt');
    assert.equal(approvalStatus.waitingFor, 'approval');
    const foreignSession = toolData(await context.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'operator_foreign_session');
    const foreignSettings = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId: foreignSession.sessionId,
    } }), 'operator_project_loop_default');
    assert.equal(foreignSettings.effective.loopIterations, 8, 'a session without an override inherits [loop].iterations');
    const wrongType = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: approval.requestId, type: 'question', answers: [{ id: 'q1', selected: ['Option A'] }],
    } });
    toolFailure(wrongType, 'control_interaction_type_mismatch', 'wrong_interaction_type');
    const wrongSession = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId: foreignSession.sessionId, requestId: approval.requestId, type: 'approval', decision: 'allow',
    } });
    toolFailure(wrongSession, 'control_interaction_session_mismatch', 'cross_session_reply');
    const accepted = toolData(await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: approval.requestId, type: 'approval', decision: 'allow',
    } }), 'operator_approval_reply');
    assert.equal(accepted.resolved, true);
    assert.equal((await waitForOutcome(context.client, approveRun.operationId)).state, 'done');
    assert.equal(await readFile(markerAllowed, 'utf8'), 'approved by the operator');
    const repeated = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: approval.requestId, type: 'approval', decision: 'allow',
    } });
    toolFailure(repeated, 'control_interaction_stale', 'duplicate_approval_reply');

    const denyRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_DENY' } }), 'operator_denial_run');
    const denyStatus = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: denyRun.operationId } }), 'operator_denial_status');
      return status.pendingInteractions.find((interaction) => interaction.type === 'approval');
    }, 'denial request');
    toolData(await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: denyStatus.requestId, type: 'approval', decision: 'deny',
    } }), 'operator_denial_reply');
    assert.equal((await waitForOutcome(context.client, denyRun.operationId)).state, 'done');
    await assert.rejects(access(markerDenied), (error) => error.code === 'ENOENT');

    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { policy: 'never' } } }), 'operator_set_never');
    const hardDenyRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_HARD_DENY' } }), 'operator_hard_deny_run');
    const hardDenyDone = await waitForOutcome(context.client, hardDenyRun.operationId);
    assert.equal(hardDenyDone.state, 'done');
    assert.equal(hardDenyDone.pendingInteractions.length, 0, 'a Policy hard denial is not exposed as an overridable approval');
    await assert.rejects(access(markerHardDenied), (error) => error.code === 'ENOENT');
    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { policy: 'ask' } } }), 'operator_restore_ask');

    const questionRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_QUESTION' } }), 'operator_question_run');
    const questionStatus = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: questionRun.operationId } }), 'operator_question_status');
      return status.pendingInteractions.find((interaction) => interaction.type === 'question');
    }, 'question request');
    assert.equal(questionStatus.details.questions[0].question, 'Which option should be used?');
    toolData(await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: questionStatus.requestId, type: 'question', answers: [{ id: 'q1', selected: ['Option B'] }],
    } }), 'operator_question_reply');
    assert.equal((await waitForOutcome(context.client, questionRun.operationId)).state, 'done');
    assert.ok((await findHistoryRecord(context.client, sessionId, (entry) => entry.kind === 'tool' && entry.json.includes('Option B'))));

    const sensitiveRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_SENSITIVE_APPROVAL' } }), 'operator_sensitive_approval_run');
    const sensitiveDone = await waitForOutcome(context.client, sensitiveRun.operationId);
    assert.equal(sensitiveDone.state, 'done');
    assert.equal(sensitiveDone.pendingInteractions.length, 0);
    const sensitiveToolRecord = await findHistoryRecord(context.client, sessionId,
      (entry) => entry.kind === 'tool' && entry.json.includes('operator-secret-executed.txt'));
    assert.ok(sensitiveToolRecord, 'the non-reviewable tool call is recorded in the Session');
    const sensitiveTool = JSON.parse(sensitiveToolRecord.record.json);
    assert.equal(sensitiveTool.result.kind, 'refusal');
    assert.equal(sensitiveTool.result.code, 'control_interaction_sensitive');
    await assert.rejects(access(markerSensitive), (error) => error.code === 'ENOENT', 'sensitive approval data is denied before the command side effect');

    const beforeSensitiveHeader = toolData(await context.client.callTool({
      name: 'ligule_session_read', arguments: { sessionId, limit: 50 },
    }), 'operator_sensitive_header_before');
    const lastBeforeSensitiveHeader = beforeSensitiveHeader.records.reduce((latest, entry) => Math.max(latest, entry.seq), 0);
    const sensitiveHeaderRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: {
      sessionId, input: 'MCP_OPERATOR_SENSITIVE_HEADER',
    } }), 'operator_sensitive_header_run');
    const sensitiveHeaderDone = await waitForOutcome(context.client, sensitiveHeaderRun.operationId);
    assert.equal(sensitiveHeaderDone.state, 'done');
    assert.equal(sensitiveHeaderDone.pendingInteractions.length, 0, 'credential header must not become an approvable interaction');
    const sensitiveHeaderToolRecord = await findHistoryRecord(context.client, sessionId,
      (entry) => entry.kind === 'tool' && entry.seq > lastBeforeSensitiveHeader);
    assert.ok(sensitiveHeaderToolRecord, 'the credential-bearing file operation is recorded in the Session');
    const sensitiveHeaderTool = JSON.parse(sensitiveHeaderToolRecord.record.json);
    assert.equal(sensitiveHeaderTool.result.kind, 'refusal');
    assert.equal(sensitiveHeaderTool.result.code, 'control_interaction_sensitive');
    await assert.rejects(access(markerSensitive), (error) => error.code === 'ENOENT', 'credential header is rejected without writing the file');

    const staleRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_APPROVE' } }), 'operator_stale_approval_run');
    const staleApproval = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: staleRun.operationId } }), 'operator_stale_approval_status');
      return status.pendingInteractions.find((interaction) => interaction.type === 'approval');
    }, 'approval to cancel');
    const cancelledInteractionRun = toolData(await context.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: staleRun.operationId } }), 'cancel_pending_approval');
    assert.equal(cancelledInteractionRun.state, 'cancelled');
    const lateReply = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: staleApproval.requestId, type: 'approval', decision: 'allow',
    } });
    toolFailure(lateReply, 'control_interaction_stale', 'late_reply_after_cancel');

    const queuedRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_QUEUE_GATE' } }), 'queue_gate_run');
    await queueGate.entered;
    const pendingBudget = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 512 } } }), 'queue_pending_budget');
    assert.equal(pendingBudget.applies, 'next_round');
    assert.equal(pendingBudget.pending.generation.outputTokens, 512);
    const pendingLoop = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId, changes: { loopIterations: 11 },
    } }), 'queue_pending_loop_limit');
    assert.equal(pendingLoop.applies, 'next_round');
    assert.equal(pendingLoop.pending.loopIterations, 11);
    const queuedFirst = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, input: 'queued first' } }), 'queue_first');
    const queuedSecond = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, input: 'queued second' } }), 'queue_second');
    assert.equal(queuedFirst.queued, true);
    toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, action: 'cancel_queued', queueItemId: queuedSecond.queueItemId } }), 'queue_cancel_second');
    queueGate.release();
    assert.equal((await waitForOutcome(context.client, queuedRun.operationId)).state, 'done');
    const firstQueuedOperation = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: queuedRun.operationId } }), 'queue_completed_status');
      return status.events.find((event) => event.kind === 'queue.started')?.newOperationId;
    }, 'auto-started queued run');
    assert.equal((await waitForOutcome(context.client, firstQueuedOperation)).state, 'done');
    await waitFor(() => requests.some((body) => body.messages.filter((message) => message.role === 'user').at(-1)?.content === 'queued first'), 'queued Provider request');
    assert.equal(requests.find((body) => body.messages.filter((message) => message.role === 'user').at(-1)?.content === 'queued first')?.max_tokens, 512);
    const tailStatus = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: firstQueuedOperation } }), 'queue_tail_status');
    assert.equal(tailStatus.queue.length, 0);
    const appliedLoop = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }), 'queue_applied_loop_limit');
    assert.equal(appliedLoop.effective.loopIterations, 11);
    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 1024 } } }), 'queue_restore_budget');
    const cancelRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_CANCEL_GATE' } }), 'queue_cancel_run');
    await cancelGate.entered;
    const remainsQueued = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, input: 'continue after cancellation' } }), 'queue_cancel_pending');
    const cancelledRun = toolData(await context.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: cancelRun.operationId } }), 'queue_cancel_active');
    assert.equal(cancelledRun.state, 'cancelled');
    assert.equal(cancelledRun.queuePaused, true);
    assert.equal(cancelledRun.queue.length, 1);
    cancelGate.release();
    const continued = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, action: 'continue' } }), 'queue_continue');
    assert.ok(continued.currentOperationId);
    assert.equal((await waitForOutcome(context.client, continued.currentOperationId)).state, 'done');
    assert.ok(notifications.length > 0, 'stdio client receives best-effort event notifications');
    const paged = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: firstQueuedOperation, after: 0, limit: 1 } }), 'event_page');
    assert.equal(paged.events.length, 1);
    assert.equal(paged.events[0].cursor, 1);
    assert.equal(paged.hasMoreEvents, true);
    t.diagnostic(`operator MCP notifications received: ${notifications.length}`);
    await context.close();
    context = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey: fixtureCredential, sdkRoot, operator: true });
    const reopened = toolData(await context.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } }), 'operator_session_reopen');
    assert.equal(reopened.sessionId, sessionId);
    const restored = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }), 'operator_settings_after_restart');
    assert.equal(restored.effective.generation.outputTokens, 1024, 'generation settings replay from Session JSONL after server restart');
    assert.equal(restored.effective.generation.model.model, 'operator-e2e-local');
    assert.equal(restored.effective.loopIterations, 11, 'session loop overrides replay from Session JSONL after server restart');
    const staleOperation = await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: simple.operationId } });
    toolFailure(staleOperation, 'operation_not_found', 'operator_old_operation_after_restart');
  } finally {
    queueGate.release();
    cancelGate.release();
    draftGate.release();
    await context.close();
    endpoint.closeAllConnections();
    await new Promise((done) => endpoint.close(done));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
