import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertDelegationMode, assertDelegationModelSelection, boundedOutputTokens, createDelegationGrant,
  listDelegationGrants, requireDelegationGrant,
} from '../dist/host/agent-control.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost } from './helpers/tui-host.ts';

const root = resolve('testplace');

async function fixture(run) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'delegation-dims-'));
  const projectRoot = join(directory, 'project');
  const storePath = join(directory, 'agent-control.json');
  await mkdir(projectRoot);
  try { await run({ directory, projectRoot, storePath }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function input(projectRoot, overrides = {}) {
  return {
    name: 'Grant with session dims',
    projectRoot,
    defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only',
    defaultNetwork: 'policy', maxNetwork: 'policy',
    defaultPolicy: 'ask', allowedPolicies: ['ask'],
    allowOperator: true,
    confirmFullAccess: false, confirmUnrestrictedNetwork: false,
    expiresAt: null,
    ...overrides,
  };
}

const readOnlyBoundary = () => createPermissionContext('read-only', 'policy', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});

function grantOptions(storePath, grantId, projectRoot) {
  return {
    grantId, storePath, operator: true,
    validate: () => requireDelegationGrant(storePath, grantId, projectRoot),
  };
}

test('a grant persists mode, model, and output budget dimensions and rejects malformed values', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const empty = await listDelegationGrants(storePath);
    await assert.rejects(createDelegationGrant(storePath, input(projectRoot, { allowedModes: ['FULL'] }), empty.version), { code: 'agent_control_scope_invalid' });
    await assert.rejects(createDelegationGrant(storePath, input(projectRoot, { allowedModes: ['full', 'full'] }), empty.version), { code: 'agent_control_scope_invalid' });
    for (const allowedModels of [['has space'], ['/leading'], ['service/'], ['a//b']]) {
      await assert.rejects(createDelegationGrant(storePath, input(projectRoot, { allowedModels }), empty.version), { code: 'agent_control_scope_invalid' });
    }
    await assert.rejects(createDelegationGrant(storePath, input(projectRoot, { allowedModels: ['legacy/ok', 'legacy/ok'] }), empty.version), { code: 'agent_control_scope_invalid' });
    for (const maxOutputTokens of [0, -1, 1.5, 1_000_001]) {
      await assert.rejects(createDelegationGrant(storePath, input(projectRoot, { maxOutputTokens }), empty.version), { code: 'agent_control_scope_invalid' });
    }
    assert.equal((await listDelegationGrants(storePath)).grants.length, 0);

    const created = await createDelegationGrant(storePath, input(projectRoot, {
      allowedModes: ['minimal', 'full'], allowedModels: ['legacy/local-test-model'], maxOutputTokens: 512,
    }), empty.version);
    const stored = JSON.parse(await readFile(storePath, 'utf8'));
    assert.deepEqual(stored.grants[0].allowedModes, ['minimal', 'full']);
    assert.deepEqual(stored.grants[0].allowedModels, ['legacy/local-test-model']);
    assert.equal(stored.grants[0].maxOutputTokens, 512);
    const loaded = await requireDelegationGrant(storePath, created.grants[0].id, projectRoot);
    assert.deepEqual(loaded.allowedModes, ['minimal', 'full']);
    assert.equal(Object.isFrozen(loaded.allowedModes), true);
    assert.equal(loaded.maxOutputTokens, 512);
    assert.throws(() => assertDelegationMode(loaded, 'review'), { code: 'agent_control_mode_denied' });
    assert.doesNotThrow(() => assertDelegationMode(loaded, 'full'));
    assert.throws(() => assertDelegationModelSelection(loaded, 'legacy/other'), { code: 'agent_control_model_denied' });
    assert.doesNotThrow(() => assertDelegationModelSelection(loaded, 'legacy/local-test-model'));
    assert.equal(boundedOutputTokens(loaded, 512), 512);
    assert.throws(() => boundedOutputTokens(loaded, 513), { code: 'agent_control_output_tokens_exceeds_grant' });
    assert.equal(boundedOutputTokens(undefined, 99_999), 99_999);

    stored.grants[0].allowedModes = ['Not A Mode'];
    await writeFile(storePath, `${JSON.stringify(stored)}\n`);
    await assert.rejects(listDelegationGrants(storePath), { code: 'agent_control_store_invalid' });
  });
});

test('grants written before the dimensions existed load without inventing limits', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const stored = JSON.parse(await readFile(storePath, 'utf8'));
    assert.equal(Object.hasOwn(stored.grants[0], 'allowedModes'), false);
    assert.equal(Object.hasOwn(stored.grants[0], 'maxOutputTokens'), false);
    const loaded = await requireDelegationGrant(storePath, created.grants[0].id, projectRoot);
    assert.equal(loaded.allowedModes, undefined);
    assert.equal(loaded.allowedModels, undefined);
    assert.equal(loaded.maxOutputTokens, undefined);
    assert.doesNotThrow(() => assertDelegationMode(loaded, 'full'));
    assert.doesNotThrow(() => assertDelegationModelSelection(loaded, 'legacy/anything'));
    assert.equal(boundedOutputTokens(loaded, 8192), 8192);
  });
});

test('a grant mode ceiling is enforced when a session switches modes', async () => {
  let grant;
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(client.request('session.configure', { sessionId, mode: 'full' }), { code: 'agent_control_mode_denied' });
    assert.equal((await client.request('status.get', { sessionId })).mode, 'minimal');
  }, {
    permission: readOnlyBoundary,
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { allowedModes: ['minimal'] }), (await listDelegationGrants(storePath)).version);
      grant = { storePath, id: created.grants[0].id };
      return grantOptions(storePath, grant.id, projectDirectory);
    },
  });
  assert.ok(grant);
});

test('a listed mode remains selectable under the same grant', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await client.request('session.configure', { sessionId, mode: 'full' });
    assert.equal((await client.request('status.get', { sessionId })).mode, 'full');
  }, {
    permission: readOnlyBoundary,
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { allowedModes: ['minimal', 'full'] }), (await listDelegationGrants(storePath)).version);
      return grantOptions(storePath, created.grants[0].id, projectDirectory);
    },
  });
});

test('a grant model ceiling rejects a configured model that the grant does not list', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(
      client.request('session.configure', { sessionId, provider: 'legacy', model: 'local-test-model' }),
      { code: 'agent_control_model_denied' },
    );
  }, {
    permission: readOnlyBoundary,
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { allowedModels: ['legacy/other-model'] }), (await listDelegationGrants(storePath)).version);
      return grantOptions(storePath, created.grants[0].id, projectDirectory);
    },
  });
});

test('a bare model id in the grant matches the selected model', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await client.request('session.configure', { sessionId, provider: 'legacy', model: 'local-test-model' });
    assert.equal((await client.request('status.get', { sessionId })).model, 'local-test-model');
  }, {
    permission: readOnlyBoundary,
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { allowedModels: ['local-test-model'] }), (await listDelegationGrants(storePath)).version);
      return grantOptions(storePath, created.grants[0].id, projectDirectory);
    },
  });
});

test('a grant output ceiling rejects a higher explicit budget and caps the provider request', async () => {
  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    await assert.rejects(client.request('session.configure', { sessionId, outputTokens: 513 }), { code: 'agent_control_output_tokens_exceeds_grant' });
    await client.request('session.configure', { sessionId, outputTokens: 512 });
    const started = await client.request('run.start', { sessionId, origin: 'controller', input: 'hello under the ceiling' });
    const done = await client.request('run.wait', { sessionId, origin: 'controller', runId: started.runId });
    assert.match(done.text, /hello under the ceiling/u);
    assert.equal(providerRequests.length > 0, true);
    assert.equal(providerRequests[0].max_tokens, 512);
  }, {
    permission: readOnlyBoundary,
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { maxOutputTokens: 512 }), (await listDelegationGrants(storePath)).version);
      return grantOptions(storePath, created.grants[0].id, projectDirectory);
    },
  });
});

test('a grant output ceiling bounds the provider even when the session keeps no explicit budget', async () => {
  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    const started = await client.request('run.start', { sessionId, origin: 'controller', input: 'default budget under ceiling' });
    const done = await client.request('run.wait', { sessionId, origin: 'controller', runId: started.runId });
    assert.match(done.text, /default budget under ceiling/u);
    assert.equal(providerRequests[0].max_tokens, 128);
  }, {
    permission: readOnlyBoundary,
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { maxOutputTokens: 128 }), (await listDelegationGrants(storePath)).version);
      return grantOptions(storePath, created.grants[0].id, projectDirectory);
    },
  });
});

test('the trusted UI grant form passes mode, model, and budget dimensions through the protocol', async () => {
  await withTuiHost(async ({ client, projectDirectory }) => {
    const listed = await client.request('agent-control.list', {});
    assert.equal(listed.grants.length, 0);
    const created = await client.request('agent-control.create', {
      version: listed.version, grantName: 'UI dims', projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only',
      defaultNetwork: 'policy', maxNetwork: 'policy',
      defaultPolicy: 'ask', allowedPolicyAsk: true, allowedPolicyAuto: false, allowedPolicyNever: false,
      allowOperator: false, confirmFullAccess: false, confirmUnrestrictedNetwork: false, confirmWorkspaceTrust: true,
      allowedModes: ['minimal'], allowedModels: ['local-test-model'], maxOutputTokens: 256,
      expiresAt: '',
    });
    assert.deepEqual(created.grants[0].allowedModes, ['minimal']);
    assert.deepEqual(created.grants[0].allowedModels, ['local-test-model']);
    assert.equal(created.grants[0].maxOutputTokens, 256);
    await assert.rejects(client.request('agent-control.create', {
      version: created.version, grantName: 'bad dims', projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only',
      defaultNetwork: 'policy', maxNetwork: 'policy',
      defaultPolicy: 'ask', allowedPolicyAsk: true, allowedPolicyAuto: false, allowedPolicyNever: false,
      allowOperator: false, confirmFullAccess: false, confirmUnrestrictedNetwork: false, confirmWorkspaceTrust: true,
      allowedModes: ['Not A Mode'], expiresAt: '',
    }), { code: 'agent_control_scope_invalid' });
  }, { permissionControl: true });
});
