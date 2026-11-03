import assert from 'node:assert/strict';
import test from 'node:test';
import { controlPresets, presetGrantCeiling } from '../dist/host/control-presets.js';
import { withTuiHost } from './helpers/tui-host.ts';

type AgentControlList = { version: string };

type AgentControlGrant = {
  maxPermissionProfile: string;
  maxNetwork: string;
  allowOperator: boolean;
  allowedMcpServers: unknown[];
};

test('safe presets stay inside the minimal permission envelope', () => {
  const presets = controlPresets({ partialWorkspaceWriteConfirmationRequired: true, partialWorkspaceWriteConfirmed: false });
  assert.deepEqual(presets.map(preset => preset.id), ['reader', 'workspace']);
  for (const preset of presets) {
    assert.ok(['read-only', 'workspace-write'].includes(preset.maxPermissionProfile), preset.id);
    assert.ok(['read-only', 'workspace-write'].includes(preset.defaultPermissionProfile), preset.id);
    assert.equal(preset.maxNetwork, 'policy', preset.id);
    assert.equal(preset.defaultNetwork, 'policy', preset.id);
    assert.equal(preset.defaultPolicy, 'ask', preset.id);
    assert.equal(preset.allowOperator, false, preset.id);
    assert.ok(preset.allowedPolicies.every(policy => policy === 'ask' || policy === 'none'), preset.id);
  }
});

test('the observer preset grants nothing beyond reading', () => {
  const [reader] = controlPresets({ partialWorkspaceWriteConfirmationRequired: false, partialWorkspaceWriteConfirmed: false });
  assert.equal(reader.id, 'reader');
  assert.equal(reader.defaultPermissionProfile, 'read-only');
  assert.equal(reader.maxPermissionProfile, 'read-only');
  assert.equal(reader.confirmWorkspaceTrust, true, 'creating a grant records project trust explicitly');
  assert.equal(reader.confirmPartialWorkspaceWrite, false);
  assert.deepEqual(presetGrantCeiling(reader), { maxPermissionProfile: 'read-only', maxNetwork: 'policy', allowOperator: false });
});

test('the collaborator preset asks for project trust but only warns once for partial isolation', () => {
  const [, first] = controlPresets({ partialWorkspaceWriteConfirmationRequired: true, partialWorkspaceWriteConfirmed: false });
  assert.equal(first.id, 'workspace');
  assert.equal(first.defaultPermissionProfile, 'read-only');
  assert.equal(first.maxPermissionProfile, 'workspace-write');
  assert.equal(first.confirmWorkspaceTrust, true);
  assert.equal(first.confirmPartialWorkspaceWrite, true);

  const [, repeated] = controlPresets({ partialWorkspaceWriteConfirmationRequired: false, partialWorkspaceWriteConfirmed: true });
  assert.equal(repeated.confirmPartialWorkspaceWrite, false);

  const [, notRequired] = controlPresets({ partialWorkspaceWriteConfirmationRequired: false, partialWorkspaceWriteConfirmed: false });
  assert.equal(notRequired.confirmPartialWorkspaceWrite, false);
});

test('a preset ceiling never widens what the grant may grant', () => {
  const presets = controlPresets({ partialWorkspaceWriteConfirmationRequired: false, partialWorkspaceWriteConfirmed: false });
  for (const preset of presets) {
    const ceiling = presetGrantCeiling(preset);
    assert.ok(['read-only', 'workspace-write'].includes(ceiling.maxPermissionProfile));
    assert.equal(ceiling.maxNetwork, 'policy');
    assert.equal(ceiling.allowOperator, false);
  }
});

test('the observer preset creates a grant whose ceiling the Host accepts verbatim', async () => {
  const [reader] = controlPresets({ partialWorkspaceWriteConfirmationRequired: false, partialWorkspaceWriteConfirmed: false });
  await withTuiHost(async ({ client, projectDirectory }) => {
    const before = await client.request('agent-control.list', {}) as AgentControlList;
    const created = await client.request('agent-control.create', {
      version: before.version,
      grantName: 'preset-reader-test',
      projectRoot: projectDirectory,
      defaultPermissionProfile: reader.defaultPermissionProfile,
      maxPermissionProfile: reader.maxPermissionProfile,
      defaultNetwork: reader.defaultNetwork,
      maxNetwork: reader.maxNetwork,
      defaultPolicy: reader.defaultPolicy,
      allowedPolicyAsk: reader.allowedPolicies.includes('ask'),
      allowedPolicyAuto: (reader.allowedPolicies as readonly string[]).includes('auto'),
      allowedPolicyNone: reader.allowedPolicies.includes('none'),
      allowOperator: reader.allowOperator,
      allowedMcpServers: [],
      allowedMcpTools: [],
      confirmFullAccess: false,
      confirmUnrestrictedNetwork: false,
      confirmPartialWorkspaceWrite: reader.confirmPartialWorkspaceWrite,
      confirmWorkspaceTrust: reader.confirmWorkspaceTrust,
      expiresAt: '',
    });
    const grant = (created as { grants: AgentControlGrant[] }).grants.at(-1)!;
    assert.equal(grant.maxPermissionProfile, 'read-only');
    assert.equal(grant.maxNetwork, 'policy');
    assert.equal(grant.allowOperator, false);
    assert.deepEqual(grant.allowedMcpServers, []);
  }, { permissionControl: true });
});
