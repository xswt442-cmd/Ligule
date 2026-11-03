import test from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionContext, permissionDenial } from '../dist/kernel/permission.js';
import type { PermissionCapabilities, PermissionContextOptions, PermissionNetwork, PermissionProfile } from '../dist/kernel/permission.js';
import { createKernel } from '../dist/kernel/kernel.js';
import { createConfig } from '../dist/kernel/config.js';
import { createDecisionChain } from '../dist/kernel/policy.js';

const linux: PermissionCapabilities = Object.freeze({ filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full' });

function permission(profile: PermissionProfile, network: PermissionNetwork = 'policy', capabilities: PermissionCapabilities = linux, options: PermissionContextOptions = {}) {
  return createPermissionContext(profile, network, capabilities, options);
}

test('permission snapshots are validated, copied, and immutable', () => {
  const capabilities = { ...linux };
  const state = permission('workspace-write', 'policy', capabilities);
  capabilities.filesystemWrite = 'unavailable';
  assert.equal(state.capabilities.filesystemWrite, 'full');
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.capabilities), true);
  assert.throws(() => createPermissionContext('danger', 'policy', linux), { code: 'permission_profile_invalid' });
  assert.throws(() => createPermissionContext('read-only', 'outside', linux), { code: 'permission_network_mode_invalid' });
  assert.throws(() => createPermissionContext('read-only', 'policy', { ...linux, leaked: 'full' }), { code: 'permission_capabilities_invalid' });
});

test('read-only permits bounded reads and refuses file writes before Policy can ask', () => {
  const state = permission('read-only');
  assert.equal(permissionDenial(state, 'read'), undefined);
  assert.deepEqual(permissionDenial(state, 'write'), {
    code: 'permission_read_only', reason: 'this session only permits reads',
  });
});

test('workspace-write permits commands when the backend reports partial confinement', () => {
  const state = permission('workspace-write', 'policy', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  });
  assert.equal(permissionDenial(state, 'read'), undefined);
  assert.equal(permissionDenial(state, 'write'), undefined);
  assert.equal(permissionDenial(state, 'exec'), undefined);
});

test('Windows partial workspace-write requires explicit trusted confirmation for writes and commands', () => {
  const state = createPermissionContext('workspace-write', 'unrestricted', linux, {
    profiles: { readOnly: 'unavailable', workspaceWrite: 'partial' },
    limitations: ['Windows workspace writes are partial.'],
    partialWorkspaceWriteConfirmationRequired: true,
  });
  assert.equal(permissionDenial(state, 'write')?.code, 'permission_partial_sandbox_confirmation_required');
  assert.equal(permissionDenial(state, 'exec')?.code, 'permission_partial_sandbox_confirmation_required');

  const confirmed = createPermissionContext('workspace-write', 'unrestricted', linux, {
    profiles: { readOnly: 'unavailable', workspaceWrite: 'partial' },
    partialWorkspaceWriteConfirmationRequired: true,
    partialWorkspaceWriteConfirmed: true,
  });
  assert.equal(permissionDenial(confirmed, 'write'), undefined);
  assert.equal(permissionDenial(confirmed, 'exec'), undefined);
});

test('a profile marked unavailable refuses command execution even when aggregate capabilities are available', () => {
  const state = createPermissionContext('read-only', 'policy', linux, {
    profiles: { readOnly: 'unavailable', workspaceWrite: 'partial' },
  });
  assert.equal(permissionDenial(state, 'exec')?.code, 'permission_sandbox_unavailable');
});

test('workspace-write refuses command execution when filesystem confinement is unavailable', () => {
  const state = permission('workspace-write', 'policy', {
    filesystemRead: 'partial', filesystemWrite: 'unavailable', network: 'full', process: 'full',
  });
  assert.equal(permissionDenial(state, 'exec')?.code, 'permission_sandbox_unavailable');
  const unreadable = permission('workspace-write', 'policy', {
    filesystemRead: 'unavailable', filesystemWrite: 'partial', network: 'full', process: 'full',
  });
  assert.equal(permissionDenial(unreadable, 'exec')?.code, 'permission_sandbox_unavailable');
});

test('read-only command execution needs usable filesystem, process, and network enforcement', () => {
  assert.equal(permissionDenial(permission('read-only'), 'exec'), undefined);
  assert.equal(permissionDenial(permission('read-only', 'policy', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  }), 'exec'), undefined);
  assert.equal(permissionDenial(permission('read-only', 'policy', {
    filesystemRead: 'unavailable', filesystemWrite: 'full', network: 'full', process: 'full',
  }), 'exec')?.code, 'permission_sandbox_unavailable');
  assert.equal(permissionDenial(permission('read-only', 'policy', {
    filesystemRead: 'partial', filesystemWrite: 'unavailable', network: 'full', process: 'full',
  }), 'exec')?.code, 'permission_sandbox_unavailable');
  assert.equal(permissionDenial(permission('read-only', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'partial', process: 'full',
  }), 'exec')?.code, 'permission_sandbox_unavailable');
  assert.equal(permissionDenial(permission('read-only', 'unrestricted', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'partial', process: 'full',
  }, { profiles: { readOnly: 'partial', workspaceWrite: 'partial' } }), 'exec')?.code,
  'permission_network_isolation_unavailable');
  assert.equal(permissionDenial(permission('read-only', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'partial',
  }), 'exec')?.code, 'permission_process_isolation_unavailable');
});

test('external processes and unclassified tools require full-access', () => {
  for (const profile of ['read-only', 'workspace-write'] as PermissionProfile[]) {
    assert.equal(permissionDenial(permission(profile), 'external')?.code, 'permission_external_access_requires_full_access');
    assert.equal(permissionDenial(permission(profile), 'unknown')?.code, 'permission_external_access_requires_full_access');
  }
  assert.equal(permissionDenial(permission('full-access', 'policy'), 'external')?.code, 'permission_external_network_unrestricted_required');
  assert.equal(permissionDenial(permission('full-access', 'unrestricted'), 'external'), undefined);
});

test('network tools follow the session network setting while shell egress stays separately enforced', () => {
  assert.equal(permissionDenial(permission('workspace-write', 'policy'), 'network'), undefined);
  assert.equal(permissionDenial(permission('workspace-write', 'disabled'), 'network')?.code, 'permission_network_denied');
  assert.equal(permissionDenial(permission('workspace-write', 'policy', {
    filesystemRead: 'partial', filesystemWrite: 'full', network: 'partial', process: 'full',
  }), 'exec')?.code, 'permission_network_isolation_unavailable');
  assert.equal(permissionDenial(permission('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'full', network: 'unavailable', process: 'full',
  }), 'exec'), undefined);
});

test('full-access still requires network enforcement when shell egress is not explicitly unrestricted', () => {
  assert.equal(permissionDenial(permission('full-access', 'policy'), 'exec')?.code, 'permission_network_isolation_unavailable');
  assert.equal(permissionDenial(permission('full-access', 'policy', {
    filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'partial', process: 'unavailable',
  }), 'exec')?.code, 'permission_network_isolation_unavailable');
  assert.equal(permissionDenial(permission('full-access', 'unrestricted'), 'exec'), undefined);
  assert.equal(permissionDenial(permission('full-access', 'disabled'), 'network')?.code, 'permission_network_denied');
});

test('full-access shell execution requires process ownership even with unrestricted networking', () => {
  assert.equal(permissionDenial(permission('full-access', 'unrestricted', {
    filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
  }), 'exec')?.code, 'permission_process_isolation_unavailable');
  assert.equal(permissionDenial(permission('full-access', 'unrestricted', {
    filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'partial',
  }), 'exec')?.code, 'permission_process_isolation_unavailable');
  assert.equal(permissionDenial(permission('full-access', 'unrestricted'), 'exec'), undefined);
});

test('external access requires process ownership while unknown access keeps its classification semantics', () => {
  const unavailable: PermissionCapabilities = {
    filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
  };
  assert.equal(permissionDenial(permission('full-access', 'unrestricted', unavailable), 'external')?.code,
    'permission_process_isolation_unavailable');
  assert.equal(permissionDenial(permission('full-access', 'unrestricted', unavailable), 'unknown'), undefined);
  assert.equal(permissionDenial(permission('full-access', 'unrestricted'), 'external'), undefined);
});

test('an external MCP call without process ownership is denied before Policy approval and process start', async () => {
  let asked = false;
  let started = false;
  const events: Record<string, unknown>[] = [];
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: permission('full-access', 'unrestricted', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    }),
    policy: createDecisionChain({ mode: 'ask', ask: async () => { asked = true; return true; } }),
    session: { directory: process.cwd(), append: async (event) => { events.push(event); } },
  });
  kernel.register({
    name: 'mcp.call', description: 'Call an external MCP process.', access: 'external',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => { started = true; return {}; },
  });

  await assert.rejects(kernel.call('mcp.call', {}), { code: 'permission_process_isolation_unavailable' });
  assert.equal(asked, false);
  assert.equal(started, false);
  const recorded = events[0].permission as { source: string; code: string };
  assert.equal(recorded.source, 'kernel-preflight');
  assert.equal(recorded.code, 'permission_process_isolation_unavailable');
});
