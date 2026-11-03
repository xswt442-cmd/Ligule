import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConfig } from '../dist/kernel/config.js';
import { createHost } from '../dist/host/host.js';
import type { Host } from '../dist/host/host.js';
import { loadHostEnvironment } from '../dist/host/environment.js';
import { createDelegationGrant, listDelegationGrants, revokeDelegationGrant } from '../dist/host/agent-control.js';
import type { CreateDelegationGrantInput } from '../dist/host/agent-control.js';
import { setTrusted } from '../dist/kernel/workspace-trust.js';

const testplace = resolve('testplace');
const runner = fileURLToPath(new URL('./fixtures/agent-control-mcp-server.mjs', import.meta.url));

type FixturePaths = { directory: string; projectRoot: string; otherProject: string; home: string };

type DelegationView = {
  grantId: string;
  name: string;
  source: string;
  defaultPermissionProfile: string;
  maxPermissionProfile: string;
  defaultNetwork: string;
  maxNetwork: string;
  defaultPolicy: string;
  allowedPolicies: string[];
  allowOperator: boolean;
};

type ToolReply = {
  isError?: boolean;
  structuredContent: {
    sessionId: string;
    operationId: string;
    nextCursor: number;
    state: string;
    source: string;
    events: { kind: string; source?: string }[];
    effective: { permission: { profile: string; network: string }; policy: { mode: string }; search: unknown };
    delegation: DelegationView;
    records: { json: string }[];
    receipt: { runId: string };
    result: { json: string };
  };
};

type ControlStatus = {
  sessionId: string;
  state: string;
  ownership: string;
  nextCursor: number;
  pendingInteractions: { type: string; requestId: string; details: { questions: { question: string }[] } }[];
};

type ControlConfiguration = {
  sessionId: string;
  selectedModel?: string | null;
  policy: string;
  permission: { profile: string };
  applies?: string;
  delegation: DelegationView;
};

type SessionRecordLine = { kind?: string; origin?: string; text?: string; run?: { runId?: string } };

async function fixture(run: (paths: FixturePaths) => unknown | Promise<unknown>) {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'agent-control-mcp-'));
  const projectRoot = join(directory, 'project');
  const otherProject = join(directory, 'other-project');
  const home = join(directory, 'ligule-home');
  await Promise.all([mkdir(projectRoot), mkdir(otherProject), mkdir(home)]);
  try { await run({ directory, projectRoot, otherProject, home }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function connect(projectRoot: string, home: string, grantId: string | undefined, operator: boolean, extraEnvironment: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runner, projectRoot, grantId ?? '', operator ? 'operator' : ''],
    cwd: projectRoot,
    env: { ...process.env, LIGULE_HOME: home, ...extraEnvironment } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agent-control-acceptance', version: 'test' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

async function startModelServer() {
  const requests: unknown[] = [];
  let call = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    call += 1;
    const frames: unknown[] = call === 1
      ? [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'local-question', type: 'function', function: {
            name: 'ask_user_question',
            arguments: JSON.stringify({ questions: JSON.stringify([{ question: 'Choose a route', options: [{ label: 'north' }, { label: 'south' }], multiSelect: false }]) }),
          } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]
      : [
          { choices: [{ index: 0, delta: { content: 'The local answer was received.' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test_provider_address_missing');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() { await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())); },
  };
}

function codeOf(result: unknown) {
  const first = (result as { content?: { type: string; text?: string }[] }).content?.find((item) => item.type === 'text');
  if (first === undefined) return undefined;
  try { return JSON.parse(first.text as string).code; } catch { return undefined; }
}

test('a real stdio MCP process uses its grant ceiling and detects revocation', async () => {
  await fixture(async ({ projectRoot, otherProject, home }) => {
    const trustPath = join(home, 'tui-trust.json');
    const storePath = join(home, 'agent-control.json');
    await setTrusted(projectRoot, true, trustPath);
    const input: CreateDelegationGrantInput = {
      name: 'stdio acceptance', projectRoot,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy', maxNetwork: 'policy',
      defaultPolicy: 'ask', allowedPolicies: ['ask', 'auto', 'none'], allowOperator: true,
      confirmPartialWorkspaceWrite: true,
      confirmFullAccess: false, confirmUnrestrictedNetwork: false, expiresAt: null,
    };
    const created = await createDelegationGrant(storePath, input, (await listDelegationGrants(storePath)).version);
    const grant = created.grants[0];
    const { client, stderr } = await connect(projectRoot, home, grant.id, true);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === 'ligule_session_create'));
      assert.ok(listed.tools.some((tool) => tool.name === 'ligule_run_await'));
      assert.equal(listed.tools.some((tool) => tool.name.includes('agent-control.create')), false);
      const receiptTool = listed.tools.find((tool) => tool.name === 'ligule_run_get');
      assert.match(receiptTool?.description ?? '', /without opening its writer/u);

      const made = await client.callTool({
        name: 'ligule_session_create',
        arguments: { projectRoot, initial: { permission: { profile: 'workspace-write', network: 'policy' }, policy: 'auto' } },
      }) as unknown as ToolReply;
      assert.equal(made.isError, undefined);
      const sessionId = made.structuredContent.sessionId;
      assert.equal(typeof sessionId, 'string');

      const missingSessionRun = await client.callTool({ name: 'ligule_run_get', arguments: {
        sessionId: 'session-not-opened-by-this-control', runId: 'run-not-owned',
      } }) as unknown as ToolReply;
      assert.equal(missingSessionRun.isError, true);
      assert.equal(codeOf(missingSessionRun), 'session_not_found');

      const config = await client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }) as unknown as ToolReply;
      assert.equal(config.isError, undefined, `${JSON.stringify(config)}\n${stderr()}`);
      assert.equal(config.structuredContent.effective.permission.profile, 'workspace-write');
      assert.equal(config.structuredContent.effective.permission.network, 'policy');
      assert.equal(config.structuredContent.delegation.maxPermissionProfile, 'workspace-write');
      assert.equal(config.structuredContent.delegation.maxNetwork, 'policy');
      assert.equal(config.structuredContent.effective.policy.mode, 'auto');
      assert.deepEqual(config.structuredContent.effective.search, { configured: false, available: false, code: 'search_not_configured' });

      const noApproval = await client.callTool({
        name: 'ligule_session_configure', arguments: { sessionId, changes: { policy: 'none' } },
      }) as unknown as ToolReply;
      assert.equal(noApproval.isError, undefined, `${JSON.stringify(noApproval)}\n${stderr()}`);
      assert.equal(noApproval.structuredContent.effective.policy.mode, 'none');
      const legacyNever = await client.callTool({
        name: 'ligule_session_configure', arguments: { sessionId, changes: { policy: 'never' } },
      }) as unknown as ToolReply;
      assert.equal(legacyNever.isError, true);
      assert.equal(codeOf(legacyNever), 'agent_control_policy_exceeds_grant');

      const missingRun = await client.callTool({ name: 'ligule_run_await', arguments: { operationId: 'missing', timeoutMs: 0 } }) as unknown as ToolReply;
      assert.equal(missingRun.isError, true);
      assert.equal(codeOf(missingRun), 'operation_not_found');

      const tooHigh = await client.callTool({
        name: 'ligule_session_configure',
        arguments: { sessionId, changes: { permission: { profile: 'full-access' } } },
      }) as unknown as ToolReply;
      assert.equal(tooHigh.isError, true);
      assert.equal(codeOf(tooHigh), 'agent_control_permission_exceeds_grant');
      const crossProject = await client.callTool({
        name: 'ligule_session_create', arguments: { projectRoot: otherProject },
      }) as unknown as ToolReply;
      assert.equal(crossProject.isError, true);
      assert.equal(codeOf(crossProject), 'control_project_forbidden');

      const revoked = await revokeDelegationGrant(storePath, grant.id, (await listDelegationGrants(storePath)).version);
      assert.equal(revoked.grants[0].revokedAt !== null, true);
      const afterRevoke = await client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }) as unknown as ToolReply;
      assert.equal(afterRevoke.isError, true);
      assert.equal(codeOf(afterRevoke), 'agent_control_grant_revoked');
      const afterRevokeRun = await client.callTool({
        name: 'ligule_run_start', arguments: { sessionId, input: 'must not run after grant revocation' },
      }) as unknown as ToolReply;
      assert.equal(afterRevokeRun.isError, true);
      assert.equal(codeOf(afterRevokeRun), 'agent_control_grant_revoked');
    } finally {
      await client.close();
    }
  });
});

test('operator mode without a grant still cannot elevate permission', async () => {
  await fixture(async ({ projectRoot, home }) => {
    await setTrusted(projectRoot, true, join(home, 'tui-trust.json'));
    const { client, stderr } = await connect(projectRoot, home, undefined, true);
    try {
      const made = await client.callTool({ name: 'ligule_session_create', arguments: { projectRoot } }) as unknown as ToolReply;
      assert.equal(made.isError, undefined);
      const sessionId = made.structuredContent.sessionId;
      const current = await client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }) as unknown as ToolReply;
      assert.equal(current.structuredContent?.effective?.permission?.profile, 'read-only', `${JSON.stringify(current)}\n${stderr()}`);
      const elevate = await client.callTool({
        name: 'ligule_session_configure',
        arguments: { sessionId, changes: { permission: { profile: 'workspace-write' } } },
      }) as unknown as ToolReply;
      assert.equal(elevate.isError, true);
      assert.equal(codeOf(elevate), 'permission_control_unavailable');
    } finally { await client.close(); }
  });
});

test('a second local Host can observe and take over the active MCP-owned Session', async () => {
  await fixture(async ({ projectRoot, home }) => {
    await setTrusted(projectRoot, true, join(home, 'tui-trust.json'));
    const storePath = join(home, 'agent-control.json');
    const createdGrant = await createDelegationGrant(storePath, {
      name: 'Desktop observation grant', projectRoot,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy', maxNetwork: 'policy',
      defaultPolicy: 'ask', allowedPolicies: ['ask', 'auto'], allowOperator: true,
      confirmPartialWorkspaceWrite: true, confirmFullAccess: false, confirmUnrestrictedNetwork: false, expiresAt: null,
    }, (await listDelegationGrants(storePath)).version);
    const grant = createdGrant.grants[0];
    const previousHome = process.env.LIGULE_HOME;
    process.env.LIGULE_HOME = home;
    const { client, stderr } = await connect(projectRoot, home, grant.id, true);
    let host: Host | undefined;
    try {
      const made = await client.callTool({ name: 'ligule_session_create', arguments: { projectRoot } }) as unknown as ToolReply;
      assert.equal(made.isError, undefined, `${JSON.stringify(made)}\n${stderr()}`);
      const sessionId = made.structuredContent.sessionId;
      const { layers, ...environment } = await loadHostEnvironment(projectRoot, fileURLToPath(new URL('../modes/', import.meta.url)));
      host = createHost({
        ...environment,
        config: createConfig({ user: { ...environment.config, workspaceRoot: projectRoot } }),
        configLayers: layers,
        permissionControl: true,
      });
      const localConnection = { notify() {}, async request() { return { decision: 'deny' }; } };

      const observed = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'status', after: 0, limit: 10, waitMs: 0 },
      } }, localConnection) as ControlStatus;
      assert.equal(observed.sessionId, sessionId);
      assert.equal(observed.state, 'idle');
      assert.equal(observed.ownership, 'external');

      const configuration = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'configuration' },
      } }, localConnection) as ControlConfiguration;
      assert.equal(configuration.sessionId, sessionId);
      assert.ok(configuration.selectedModel === null || typeof configuration.selectedModel === 'string');
      assert.equal(configuration.policy, 'ask');
      assert.equal(configuration.permission.profile, 'read-only');
      assert.equal(configuration.delegation.grantId, grant.id);
      assert.equal(configuration.delegation.name, 'Desktop observation grant');
      assert.equal(configuration.delegation.source, 'trusted-ui');
      assert.equal(configuration.delegation.defaultPermissionProfile, 'read-only');
      assert.equal(configuration.delegation.maxPermissionProfile, 'workspace-write');
      assert.equal(configuration.delegation.defaultNetwork, 'policy');
      assert.equal(configuration.delegation.maxNetwork, 'policy');
      assert.equal(configuration.delegation.defaultPolicy, 'ask');
      assert.deepEqual(configuration.delegation.allowedPolicies, ['ask', 'auto']);
      assert.equal(configuration.delegation.allowOperator, true);

      // 本地人类可以通过桥在 Session 空闲时调整权限；普通 MCP 客户端没有这个入口。
      const relaxed = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'permission', permissionProfile: 'workspace-write', confirmPartialWorkspaceWrite: true },
      } }, localConnection) as ControlConfiguration;
      assert.equal(relaxed.permission.profile, 'workspace-write');
      assert.equal(relaxed.applies, 'now');
      const reread = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'configuration' },
      } }, localConnection) as ControlConfiguration;
      assert.equal(reread.permission.profile, 'workspace-write', 'the change is visible on the next configuration read');

      await assert.rejects(host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'permission', permissionProfile: 'full-access' },
      } }, localConnection), { code: 'agent_control_permission_exceeds_grant' },
      'a human change is still bounded by the Grant ceiling');
      const restored = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'permission', permissionProfile: 'read-only' },
      } }, localConnection) as ControlConfiguration;
      assert.equal(restored.permission.profile, 'read-only');

      const takeover = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'takeover' },
      } }, localConnection);
      assert.deepEqual(takeover, { sessionId, ownership: 'human', released: true, operationId: null });

      const refused = await client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'continue' } }) as unknown as ToolReply;
      assert.equal(refused.isError, true);
      assert.equal(codeOf(refused), 'control_session_taken_over');

      const reopened = await host.handle({ method: 'session.open', params: { projectRoot, sessionId } }, localConnection) as { sessionId: string };
      assert.equal(reopened.sessionId, sessionId);
    } finally {
      await host?.release();
      await client.close();
      if (previousHome === undefined) delete process.env.LIGULE_HOME;
      else process.env.LIGULE_HOME = previousHome;
    }
  });
});

test('Desktop human input and question answers reach the single MCP-owned real Host', async () => {
  await fixture(async ({ projectRoot, home }) => {
    const model = await startModelServer();
    const projectSettings = join(projectRoot, '.ligule');
    await mkdir(projectSettings);
    await writeFile(join(home, 'config.toml'), [
      '[model]',
      'api = "chat-completions"',
      `baseURL = "${model.baseURL}"`,
      'model = "agent-control-test-model"',
      'apiKeyEnv = "LIGULE_AGENT_CONTROL_TEST_KEY"',
      '[loop]',
      'iterations = 5',
      'modelCalls = 5',
      '[policy]',
      'mode = "ask"',
      '',
    ].join('\n'));
    await setTrusted(projectRoot, true, join(home, 'tui-trust.json'));
    const previousHome = process.env.LIGULE_HOME;
    process.env.LIGULE_HOME = home;
    const { client, stderr } = await connect(projectRoot, home, undefined, false, { LIGULE_AGENT_CONTROL_TEST_KEY: 'test-key' });
    let host: Host | undefined;
    try {
      const made = await client.callTool({ name: 'ligule_session_create', arguments: { projectRoot } }) as unknown as ToolReply;
      assert.equal(made.isError, undefined, `${JSON.stringify(made)}\n${stderr()}`);
      const sessionId = made.structuredContent.sessionId;
      const { layers, ...environment } = await loadHostEnvironment(projectRoot, fileURLToPath(new URL('../modes/', import.meta.url)));
      host = createHost({
        ...environment,
        config: createConfig({ user: { ...environment.config, workspaceRoot: projectRoot } }),
        configLayers: layers,
        permissionControl: true,
      });
      const localConnection = { notify() {}, async request() { return { decision: 'deny' }; } };
      const started = await client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'Ask the local user which route to take.' } }) as unknown as ToolReply;
      assert.equal(started.isError, undefined, `${JSON.stringify(started)}\n${stderr()}`);
      const operationId = started.structuredContent.operationId;
      assert.equal(started.structuredContent.source, 'controller');
      assert.equal(started.structuredContent.events.some((event) => event.kind === 'run.started' && event.source === 'controller'), true);
      let cursor = started.structuredContent.nextCursor;
      let waiting: ControlStatus | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        waiting = await host.handle({ method: 'session.control', params: {
          projectRoot, sessionId, request: { action: 'status', after: cursor, limit: 20, waitMs: 5_000 },
        } }, localConnection) as ControlStatus;
        cursor = waiting.nextCursor;
        if (waiting.pendingInteractions.some((item) => item.type === 'question')) break;
      }
      const question = waiting?.pendingInteractions.find((item) => item.type === 'question');
      assert.ok(question, `human question was not delivered\n${JSON.stringify(waiting)}\n${stderr()}`);
      assert.equal(question.details.questions[0].question, 'Choose a route');

      const answered = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: {
          action: 'reply', requestId: question.requestId, type: 'question',
          answers: [{ id: 'q1', selected: ['north'] }],
        },
      } }, localConnection) as { source: string };
      assert.equal(answered.source, 'human');
      const eventStatus = await client.callTool({ name: 'ligule_run_status', arguments: { operationId, after: 0, limit: 50 } }) as unknown as ToolReply;
      assert.equal(eventStatus.isError, undefined, `${JSON.stringify(eventStatus)}\n${stderr()}`);
      assert.equal(eventStatus.structuredContent.events.some((event) => event.kind === 'interaction.resolved' && event.source === 'human'), true);
      const resolved = await client.callTool({ name: 'ligule_run_await', arguments: { operationId, timeoutMs: 10_000 } }) as unknown as ToolReply;
      if (resolved.isError === true) {
        const current = await client.callTool({ name: 'ligule_run_status', arguments: { operationId, after: 0, limit: 20 } }) as unknown as ToolReply;
        assert.fail(`${JSON.stringify({ resolved, current })}\n${stderr()}`);
      }
      assert.equal(resolved.structuredContent.state, 'done', `${JSON.stringify(resolved)}\n${stderr()}`);

      const humanInput = await host.handle({ method: 'session.control', params: {
        projectRoot, sessionId, request: { action: 'send', input: 'Please keep the northern route.' },
      } }, localConnection) as { accepted: boolean; queued: boolean; operationId: string };
      assert.equal(humanInput.accepted, true);
      assert.equal(humanInput.queued, false);
      const humanStatus = await client.callTool({ name: 'ligule_run_status', arguments: { operationId: humanInput.operationId } }) as unknown as ToolReply;
      assert.equal(humanStatus.structuredContent.source, 'human');
      assert.equal(humanStatus.structuredContent.events.some((event) => event.kind === 'run.started' && event.source === 'human'), true);
      const humanRun = await client.callTool({ name: 'ligule_run_await', arguments: { operationId: humanInput.operationId, timeoutMs: 10_000 } }) as unknown as ToolReply;
      assert.equal(humanRun.structuredContent.state, 'done', `${JSON.stringify(humanRun)}\n${stderr()}`);
      assert.equal(model.requests.length, 3);

      const transcript = await client.callTool({ name: 'ligule_session_read', arguments: { sessionId, limit: 50 } }) as unknown as ToolReply;
      const records = transcript.structuredContent.records.map((item) => JSON.parse(item.json) as SessionRecordLine);
      const users = records.filter((item) => item.kind === 'user');
      assert.ok(users.some((item) => item.origin === 'controller' && item.text === 'Ask the local user which route to take.'));
      const humanRecord = users.find((item) => item.origin === 'human' && item.text === 'Please keep the northern route.');
      assert.ok(humanRecord);
      const humanRunId = humanRecord.run?.runId;
      assert.equal(typeof humanRunId, 'string');
      const humanResult = await client.callTool({ name: 'ligule_run_get', arguments: {
        sessionId, runId: humanRunId, offset: 0,
      } }) as unknown as ToolReply;
      assert.equal(humanResult.isError, undefined, `${JSON.stringify(humanResult)}\n${stderr()}`);
      assert.equal(humanResult.structuredContent.receipt.runId, humanRunId);
      assert.equal(JSON.parse(humanResult.structuredContent.result.json).state, 'completed');

      const closed = await client.callTool({ name: 'ligule_session_close', arguments: { sessionId } }) as unknown as ToolReply;
      assert.equal(closed.isError, undefined, `${JSON.stringify(closed)}\n${stderr()}`);
      const receiptAfterClose = await client.callTool({ name: 'ligule_run_get', arguments: {
        sessionId, runId: humanRunId, offset: 0,
      } }) as unknown as ToolReply;
      assert.equal(receiptAfterClose.isError, undefined, `${JSON.stringify(receiptAfterClose)}\n${stderr()}`);
      assert.equal(receiptAfterClose.structuredContent.receipt.runId, humanRunId);
      assert.equal(JSON.parse(receiptAfterClose.structuredContent.result.json).state, 'completed');
    } finally {
      await host?.release();
      await client.close();
      if (previousHome === undefined) delete process.env.LIGULE_HOME;
      else process.env.LIGULE_HOME = previousHome;
      await model.close();
    }
  });
});
