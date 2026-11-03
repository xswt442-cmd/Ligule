import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDelegationGrant, listDelegationGrants, requireDelegationGrant, revokeDelegationGrant, assertDelegationMcpServer, assertDelegationMcpTool, assertDelegationPermission, assertDelegationPolicy } from '../dist/host/agent-control.js';
import type { CreateDelegationGrantInput } from '../dist/host/agent-control.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost } from './helpers/tui-host.ts';
import { createConfig } from '../dist/kernel/config.js';
import { serveHost } from '../dist/host/host.js';
import { hostProviderFromConfig } from '../dist/host/provider.js';
import { createMemoryConnectionPair } from '../dist/host/memory.js';
import { createConnection } from '../dist/host/connection.js';
import { TRUSTED_AGENT_CONTROL_ORIGIN } from '../dist/host/agent-control-runtime.js';

const root = resolve('testplace');

type FixturePaths = { directory: string; projectRoot: string; storePath: string };

type StoredGrant = {
  id: string;
  source?: string;
  allowScreenCapture?: boolean;
  confirmedScreenCapture?: boolean;
  expiresAt?: string | null;
  revokedAt?: string | null;
};

type StoredStore = { grants: StoredGrant[]; audit: { source?: string }[] };

type GrantList = {
  version: string;
  grants: { id: string; revokedAt?: string | null; confirmedPartialWorkspaceWrite?: boolean }[];
};

type SessionStatus = {
  screenCapture?: unknown;
  delegation: { allowScreenCapture: boolean };
  permission: { profile: string; changeAllowed: boolean };
  policy?: string;
};

type SessionConfiguration = { permission: { profile: string }; applies?: string };

type GrantHandle = { storePath: string; id: string };

async function fixture(run: (paths: FixturePaths) => unknown | Promise<unknown>) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'agent-control-'));
  const projectRoot = join(directory, 'project');
  const storePath = join(directory, 'agent-control.json');
  await mkdir(projectRoot);
  try { await run({ directory, projectRoot, storePath }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function input(projectRoot: string, overrides: Partial<CreateDelegationGrantInput> = {}): CreateDelegationGrantInput {
  return {
    name: 'Codex local task',
    projectRoot,
    defaultPermissionProfile: 'workspace-write',
    maxPermissionProfile: 'workspace-write',
    defaultNetwork: 'policy',
    maxNetwork: 'policy',
    defaultPolicy: 'ask',
    allowedPolicies: ['ask', 'auto'],
    allowOperator: false,
    confirmFullAccess: false,
    confirmUnrestrictedNetwork: false,
    expiresAt: null,
    ...overrides,
  };
}

test('screen capture requires an independent explicit confirmation and never follows Operator', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const empty = await listDelegationGrants(storePath);
    await assert.rejects(createDelegationGrant(storePath, input(projectRoot, { allowScreenCapture: true }), empty.version), { code: 'screen_capture_confirmation_required' });
    const ordinary = await createDelegationGrant(storePath, input(projectRoot, { allowOperator: true }), empty.version);
    assert.equal(ordinary.grants[0].allowScreenCapture, false);
    const explicit = await createDelegationGrant(storePath, input(projectRoot, { allowScreenCapture: true, confirmScreenCapture: true }), ordinary.version);
    const grant = explicit.grants.find(item => item.allowScreenCapture)!;
    assert.equal(grant.confirmedScreenCapture, true);
    assert.equal((await requireDelegationGrant(storePath, grant.id, projectRoot)).allowScreenCapture, true);
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as StoredStore;
    stored.grants.find(item => item.id === grant.id)!.source = 'legacy';
    await writeFile(storePath, JSON.stringify(stored));
    await assert.rejects(listDelegationGrants(storePath), { code: 'agent_control_store_invalid' });
  });
});

test('an Operator Host startup option cannot exceed a grant without screen permission', async () => {
  await fixture(async ({ projectRoot, directory, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot, { allowOperator: true }), (await listDelegationGrants(storePath)).version);
    const grantId = created.grants[0].id;
    const config = createConfig({ user: { boundary: projectRoot, workspaceRoot: projectRoot, host: { sessionDirectory: join(directory, 'sessions') } } });
    const pair = createMemoryConnectionPair();
    const host = serveHost({ ...pair.host, config, provider: hostProviderFromConfig(config), screenCaptureConsent: true,
      agentControl: { grantId, storePath, operator: true, validate: () => requireDelegationGrant(storePath, grantId, projectRoot) },
    });
    const client = createConnection(pair.client);
    try {
      const { sessionId } = await client.request('session.create', { projectRoot }) as { sessionId: string };
      const status = await client.request('status.get', { sessionId }) as SessionStatus;
      assert.deepEqual(status.screenCapture, { enabled: false, source: 'none', changeAllowed: false });
      assert.equal(status.delegation.allowScreenCapture, false);
      await assert.rejects(client.request('screen-capture.set', { sessionId, enabled: true, confirmScreenCapture: true }), { code: 'screen_capture_control_unavailable' });
    } finally { pair.client.output.end(); await host.release(); }
  });
});

test('delegation grants bind to a canonical project and reject a different project', async () => {
  await fixture(async ({ projectRoot, directory, storePath }) => {
    const empty = await listDelegationGrants(storePath);
    const created = await createDelegationGrant(storePath, input(projectRoot), empty.version);
    assert.equal(created.grants.length, 1);
    assert.equal(created.grants[0].projectRoot, projectRoot);
    assert.equal(created.grants[0].source, 'trusted-ui');
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as StoredStore;
    assert.equal(stored.audit[0].source, 'trusted-ui');
    assert.equal((await requireDelegationGrant(storePath, created.grants[0].id, projectRoot)).id, created.grants[0].id);
    await assert.rejects(requireDelegationGrant(storePath, created.grants[0].id, directory), { code: 'agent_control_project_forbidden' });
    await assert.rejects(createDelegationGrant(storePath, input(projectRoot), empty.version), { code: 'agent_control_version_stale' });
  });
});

test('existing grants without a recorded origin remain usable without inventing one', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const legacy = JSON.parse(await readFile(storePath, 'utf8')) as StoredStore;
    delete legacy.grants[0].source;
    delete legacy.grants[0].allowScreenCapture;
    delete legacy.grants[0].confirmedScreenCapture;
    delete legacy.audit[0].source;
    await writeFile(storePath, `${JSON.stringify(legacy)}\n`);

    const loaded = await listDelegationGrants(storePath);
    assert.equal(loaded.grants[0].source, 'legacy');
    assert.equal(loaded.grants[0].allowScreenCapture, false);
    assert.equal(loaded.grants[0].confirmedScreenCapture, false);
    assert.deepEqual(loaded.grants[0].allowedMcpServers, []);
    assert.deepEqual(loaded.grants[0].allowedMcpTools, []);
    assert.equal((await requireDelegationGrant(storePath, created.grants[0].id, projectRoot)).source, 'legacy');

    await revokeDelegationGrant(storePath, created.grants[0].id, loaded.version);
    const rewritten = JSON.parse(await readFile(storePath, 'utf8')) as StoredStore;
    assert.equal(rewritten.grants[0].source, 'legacy');
    assert.equal(rewritten.audit[0].source, 'legacy');
  });
});

test('full access and unrestricted network require separate grant confirmations', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const empty = await listDelegationGrants(storePath);
    const elevated = input(projectRoot, {
      defaultPermissionProfile: 'full-access', maxPermissionProfile: 'full-access',
      defaultNetwork: 'unrestricted', maxNetwork: 'unrestricted',
      confirmFullAccess: true, confirmUnrestrictedNetwork: true,
    });
    await assert.rejects(createDelegationGrant(storePath, { ...elevated, confirmFullAccess: false }, empty.version), { code: 'agent_control_full_access_confirmation_required' });
    await assert.rejects(createDelegationGrant(storePath, { ...elevated, confirmUnrestrictedNetwork: false }, empty.version), { code: 'agent_control_unrestricted_network_confirmation_required' });
    const created = await createDelegationGrant(storePath, elevated, empty.version);
    assert.equal(created.grants[0].confirmedFullAccess, true);
    assert.equal(created.grants[0].confirmedUnrestrictedNetwork, true);
  });
});

test('delegation ceilings reject permission and policy escalation', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const grant = created.grants[0];
    assertDelegationPermission(grant, 'read-only', 'disabled');
    assertDelegationPermission(grant, 'workspace-write', 'policy');
    assert.throws(() => assertDelegationPermission(grant, 'full-access', 'policy'), { code: 'agent_control_permission_exceeds_grant' });
    assert.throws(() => assertDelegationPermission(grant, 'read-only', 'unrestricted'), { code: 'agent_control_permission_exceeds_grant' });
    assertDelegationPolicy(grant, 'auto');
    assert.throws(() => assertDelegationPolicy(grant, 'never'), { code: 'agent_control_policy_exceeds_grant' });
  });
});

test('a trusted grant can narrow the policy ceiling and never exceeds it', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const snapshot = await createDelegationGrant(storePath, input(projectRoot, {
      defaultPolicy: 'auto', allowedPolicies: ['ask', 'auto'],
    }), (await listDelegationGrants(storePath)).version);
    assert.equal(snapshot.grants[0].defaultPolicy, 'auto');
    assertDelegationPolicy(snapshot.grants[0], 'auto');
    assertDelegationPolicy(snapshot.grants[0], 'ask');
    assert.throws(() => assertDelegationPolicy(snapshot.grants[0], 'never'), { code: 'agent_control_policy_exceeds_grant' });
    assert.throws(() => assertDelegationPolicy(snapshot.grants[0], 'always'), { code: 'agent_control_policy_exceeds_grant' });

    // 授权档位本身也必须落在四档契约里；`none` 不再是合法枚举值。
    await assert.rejects(
      () => createDelegationGrant(storePath, input(projectRoot, {
        name: 'Legacy grant', allowedPolicies: ['ask', 'none' as never],
      }), snapshot.version),
      { code: 'agent_control_policy_limit_invalid' },
    );
  });
});

test('Agent Control MCP limits require an allowed server and an exact tool capability', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const allowed = {
      ...input(projectRoot),
      allowedMcpServers: ['playwright'],
      allowedMcpTools: ['mcp:playwright/browser_click'],
    };
    const snapshot = await createDelegationGrant(storePath, allowed, (await listDelegationGrants(storePath)).version);
    const grant = snapshot.grants[0];
    assertDelegationMcpServer(grant, 'playwright');
    assertDelegationMcpTool(grant, 'mcp:playwright/browser_click');
    assert.throws(() => assertDelegationMcpServer(grant, 'filesystem'), { code: 'agent_control_mcp_server_denied' });
    assert.throws(() => assertDelegationMcpTool(grant, 'mcp:playwright/browser_navigate'), { code: 'agent_control_mcp_tool_denied' });
    const currentVersion = (await listDelegationGrants(storePath)).version;
    await assert.rejects(
      () => createDelegationGrant(storePath, { ...input(projectRoot), allowedMcpServers: ['playwright'], allowedMcpTools: ['mcp:filesystem/read_file'] },
        currentVersion),
      { code: 'agent_control_mcp_limit_invalid' },
    );
  });
});

test('revoked and expired grants cannot be used', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const revoked = await revokeDelegationGrant(storePath, created.grants[0].id, created.version);
    await assert.rejects(requireDelegationGrant(storePath, created.grants[0].id, projectRoot), { code: 'agent_control_grant_revoked' });
    await assert.rejects(revokeDelegationGrant(storePath, created.grants[0].id, revoked.version), { code: 'agent_control_grant_revoked' });

    const next = await createDelegationGrant(storePath, input(projectRoot), revoked.version);
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as StoredStore;
    stored.grants[1].expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(storePath, `${JSON.stringify(stored)}\n`);
    await assert.rejects(requireDelegationGrant(storePath, next.grants[1].id, projectRoot), { code: 'agent_control_grant_expired' });
  });
});

test('trusted Host clients can create and revoke grants while untrusted Host clients cannot', async () => {
  await withTuiHost(async ({ client, projectDirectory }) => {
    const before = await client.request('agent-control.list', {}) as GrantList;
    const created = await client.request('agent-control.create', {
      version: before.version,
      grantName: 'desktop test',
      projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy', maxNetwork: 'policy',
      defaultPolicy: 'ask', allowedPolicyAsk: true, allowedPolicyAuto: false, allowedPolicyNever: false, allowOperator: false,
      confirmFullAccess: false, confirmUnrestrictedNetwork: false, confirmWorkspaceTrust: true, expiresAt: '',
    }) as GrantList;
    assert.equal(created.grants.length, 1);
    const revoked = await client.request('agent-control.revoke', { grantId: created.grants[0].id, version: created.version }) as GrantList;
    assert.ok(revoked.grants[0].revokedAt);
  }, { permissionControl: true });

  await withTuiHost(async ({ client }) => {
    await assert.rejects(client.request('agent-control.list', {}), { code: 'agent_control_trusted_ui_required' });
  });
});

test('Windows partial Agent Control grants require explicit project-trust confirmation', async () => {
  const permission = createPermissionContext('read-only', 'policy', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, {
    profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
    limitations: ['Windows workspace-write has partial isolation.'],
    partialWorkspaceWriteConfirmationRequired: true,
  });
  await withTuiHost(async ({ client, projectDirectory }) => {
    const before = await client.request('agent-control.list', {}) as GrantList;
    const grant = {
      version: before.version,
      grantName: 'partial workspace test',
      projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only',
      maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy',
      maxNetwork: 'policy',
      defaultPolicy: 'ask',
      allowedPolicyAsk: true,
      allowedPolicyAuto: false,
      allowedPolicyNever: false,
      allowOperator: false,
      confirmFullAccess: false,
      confirmUnrestrictedNetwork: false,
      confirmWorkspaceTrust: true,
      expiresAt: '',
    };
    await assert.rejects(client.request('agent-control.create', grant), {
      code: 'permission_partial_sandbox_confirmation_required',
    });
    const created = await client.request('agent-control.create', {
      ...grant, confirmPartialWorkspaceWrite: true,
    }) as GrantList;
    assert.equal(created.grants[0].confirmedPartialWorkspaceWrite, true);
  }, { permissionControl: true, permission });
});

test('a delegated Host enforces the project, permission, policy and operator limits on every request', async () => {
  let grant!: GrantHandle;
  await withTuiHost(async ({ client, sessionId, projectDirectory, directory }) => {
    assert.equal(((await client.request('status.get', { sessionId })) as SessionStatus).permission.profile, 'read-only');
    const changed = await client.request('session.configure', { sessionId, permissionProfile: 'workspace-write' }) as SessionConfiguration;
    assert.equal(changed.permission.profile, 'workspace-write');
    await assert.rejects(
      client.request('session.configure', { sessionId, permissionProfile: 'full-access' }),
      { code: 'agent_control_permission_exceeds_grant' },
    );
    await assert.rejects(
      client.request('session.configure', { sessionId, policy: 'never' }),
      { code: 'agent_control_policy_exceeds_grant' },
    );
    await assert.rejects(
      client.request('session.create', { projectRoot: directory }),
      { code: 'agent_control_project_forbidden' },
    );
    const grantList = await listDelegationGrants(grant.storePath);
    await assert.rejects(client.request('agent-control.create', {
      version: grantList.version, grantName: 'forged', projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only',
      defaultNetwork: 'policy', maxNetwork: 'policy', defaultPolicy: 'ask',
      allowedPolicyAsk: true, allowedPolicyAuto: false, allowedPolicyNever: false,
      allowOperator: false, confirmFullAccess: false, confirmUnrestrictedNetwork: false, confirmWorkspaceTrust: true, expiresAt: '',
    }), { code: 'agent_control_trusted_ui_required' });
    const records = await client.request('session.read', { sessionId }) as { events: { kind?: string; source?: string }[] };
    assert.equal(records.events.filter((event) => event.kind === 'sessionPermission').at(-1)!.source, 'agent-control');
    const revoked = await revokeDelegationGrant(grant.storePath, grant.id, (await listDelegationGrants(grant.storePath)).version);
    assert.equal(revoked.grants[0].revokedAt !== null, true);
    await assert.rejects(client.request('status.get', { sessionId }), { code: 'agent_control_grant_revoked' });
  }, {
    permission: createPermissionContext('read-only', 'policy', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    }),
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory), (await listDelegationGrants(storePath)).version);
      grant = { storePath, id: created.grants[0].id };
      return {
        grantId: grant.id, storePath, operator: true,
        validate: () => requireDelegationGrant(storePath, grant.id, projectDirectory),
      };
    },
  });
});

test('session policy overrides survive reopening and remain inside the active grant ceiling', async () => {
  let grant!: GrantHandle;
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    await client.request('policy.set', { sessionId, mode: 'ask' });
    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    assert.equal(((await client.request('status.get', { sessionId })) as SessionStatus).policy, 'ask');

    await client.request('session.close', { sessionId });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as { kind?: string; override?: string });
    const state = lines.filter((event) => event.kind === 'sessionPolicy').at(-1);
    assert.ok(state);
    state.override = 'never';
    const forged = `${lines.map((event) => JSON.stringify(event)).join('\n')}\n`;
    await writeFile(path, forged);
    await assert.rejects(client.request('session.open', { sessionId }), { code: 'agent_control_policy_exceeds_grant' });
    assert.equal(await readFile(path, 'utf8'), forged);
  }, {
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { allowedPolicies: ['ask'] }), (await listDelegationGrants(storePath)).version);
      grant = { storePath, id: created.grants[0].id };
      return {
        grantId: grant.id, storePath, operator: true,
        validate: () => requireDelegationGrant(storePath, grant.id, projectDirectory),
      };
    },
  });
});

test('a grant without operator permission cannot change session settings', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(
      client.request('session.configure', { sessionId, permissionProfile: 'workspace-write' }),
      { code: 'agent_control_operator_required' },
    );
  }, {
    permission: createPermissionContext('read-only', 'policy', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    }),
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory), (await listDelegationGrants(storePath)).version);
      return {
        grantId: created.grants[0].id, storePath, operator: false,
        validate: () => requireDelegationGrant(storePath, created.grants[0].id, projectDirectory),
      };
    },
  });
});

test('the permission change flag follows the channel, not just the host', async () => {
  await fixture(async ({ projectRoot, directory, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const grantId = created.grants[0].id;
    const config = createConfig({ user: { boundary: projectRoot, workspaceRoot: projectRoot, host: { sessionDirectory: join(directory, 'sessions') } } });
    const pair = createMemoryConnectionPair();
    const host = serveHost({ ...pair.host, config, provider: hostProviderFromConfig(config),
      agentControl: { grantId, storePath, operator: false, validate: () => requireDelegationGrant(storePath, grantId, projectRoot) } });
    const client = createConnection(pair.client);
    const bridge = { notify() {}, async request() { return { decision: 'deny' }; }, [TRUSTED_AGENT_CONTROL_ORIGIN]: true as const };
    try {
      const { sessionId } = await client.request('session.create', { projectRoot }) as { sessionId: string };
      const ordinary = await client.request('status.get', { sessionId }) as SessionStatus;
      assert.equal(ordinary.permission.changeAllowed, false, 'an ordinary client may not change permission');
      const observed = await host.handle({ method: 'status.get', params: { projectRoot, sessionId } }, bridge) as SessionStatus;
      assert.equal(observed.permission.changeAllowed, true, 'the bridge may change permission, so the view must say so');
      const target = observed.permission.profile === 'read-only' ? 'workspace-write' : 'read-only';
      const changed = await host.handle({ method: 'permission.set', params: { sessionId, permissionProfile: target } }, bridge) as SessionConfiguration;
      assert.equal(changed.permission.profile, target);
      assert.equal(changed.applies, 'now');
      await assert.rejects(host.handle({ method: 'permission.set', params: { sessionId, permissionProfile: 'full-access' } }, bridge), { code: 'agent_control_permission_exceeds_grant' });
      await assert.rejects(host.handle({ method: 'permission.set', params: { sessionId, permissionProfile: 'workspace-write' } },
        { notify() {}, async request() { return { decision: 'deny' }; } }), { code: 'agent_control_operator_required' });
    } finally { pair.client.output.end(); await host.release(); }
  });
});

test('a bridge cannot change permission while a run is executing', async () => {
  await withTuiHost(async ({ client, host, sessionId }) => {
    const bridge = { notify() {}, async request() { return { decision: 'deny' }; }, [TRUSTED_AGENT_CONTROL_ORIGIN]: true as const };
    const started = await client.request('run.submit', { sessionId, input: 'slow bridge turn', requestKey: 'bridge-running' }) as { state: string; runId: string };
    assert.equal(started.state, 'running');
    await assert.rejects(host.handle({ method: 'permission.set', params: { sessionId, permissionProfile: 'read-only' } }, bridge),
      { code: 'permission_session_running' });
    await client.request('run.wait', { sessionId, runId: started.runId });
    const changed = await host.handle({ method: 'permission.set', params: { sessionId, permissionProfile: 'read-only' } }, bridge) as SessionConfiguration;
    assert.equal(changed.permission.profile, 'read-only');
  }, {
    delayMs: 1_500,
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory), (await listDelegationGrants(storePath)).version);
      const grantId = created.grants[0].id;
      return { grantId, storePath, operator: false, validate: () => requireDelegationGrant(storePath, grantId, projectDirectory) };
    },
  });
});
