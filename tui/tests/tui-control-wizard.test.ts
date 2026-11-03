import test from 'node:test';
import assert from 'node:assert/strict';
import { controlGrantRequest, controlWizardNext, parseControlWizardInput } from '../dist/tui/control-wizard.js';
import type { ControlWizard, ControlWizardOutcome, ControlWizardValues } from '../dist/tui/control-wizard.js';

type WizardFailure = Extract<ControlWizardOutcome, { kind: 'error' | 'abort' }>;
type WizardStep = Extract<ControlWizardOutcome, { kind: 'step' }>;
type WizardServers = Extract<ControlWizardOutcome, { kind: 'mcp-servers' }>;

const t = (zh: string) => zh;

function wizard(step: number, values: ControlWizardValues = {}): ControlWizard {
  return { step, values, mcpServers: ['notes'], mcpTools: ['mcp:notes/read'] };
}

test('control wizard skips confirmations that the ceilings do not require', () => {
  const readOnly: ControlWizardValues = { defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only', defaultNetwork: 'disabled', maxNetwork: 'disabled' };
  assert.equal(controlWizardNext(11, readOnly), -1, '只读且网络 disabled 不需要额外确认');
  assert.equal(controlWizardNext(11, { ...readOnly, maxNetwork: 'unrestricted' }), 14);
  assert.equal(controlWizardNext(12, { ...readOnly, maxPermissionProfile: 'workspace-write', maxNetwork: 'policy' }), -1);
  assert.equal(controlWizardNext(13, { ...readOnly, maxNetwork: 'policy' }), -1);
});

test('control wizard rejects ceilings below the defaults', () => {
  const lower = parseControlWizardInput(
    wizard(2, { defaultPermissionProfile: 'full-access' }),
    'read-only',
    t,
  ) as WizardFailure;
  assert.equal(lower.kind, 'error');
  assert.match(lower.message, /权限上限不能低于默认权限/);

  const network = parseControlWizardInput(
    wizard(4, { defaultNetwork: 'unrestricted' }),
    'policy',
    t,
  ) as WizardFailure;
  assert.equal(network.kind, 'error');
  assert.match(network.message, /网络上限不能低于默认网络范围/);
});

test('control wizard keeps policy lists distinct and inclusive of the default', () => {
  const duplicated = parseControlWizardInput(wizard(6, { defaultPolicy: 'ask' }), 'ask,ask', t);
  assert.equal(duplicated.kind, 'error');
  const missingDefault = parseControlWizardInput(wizard(6, { defaultPolicy: 'ask' }), 'auto,never', t);
  assert.equal(missingDefault.kind, 'error');
  const legacy = parseControlWizardInput(wizard(6, { defaultPolicy: 'ask' }), 'ask,none', t);
  assert.equal(legacy.kind, 'error');
  const ok = parseControlWizardInput(wizard(6, { defaultPolicy: 'ask' }), 'ask,never', t) as WizardStep;
  assert.equal(ok.kind, 'step');
  assert.deepEqual(ok.wizard.values.allowedPolicies, ['ask', 'never']);
  const onlyNoPrompts = parseControlWizardInput(wizard(6, { defaultPolicy: 'never' }), 'never', t) as WizardStep;
  assert.equal(onlyNoPrompts.kind, 'step');
  assert.deepEqual(onlyNoPrompts.wizard.values.allowedPolicies, ['never']);
});

test('control wizard defers MCP tool listing and aborts when trust is refused', () => {
  const servers = parseControlWizardInput(wizard(8), 'notes', t) as WizardServers;
  assert.equal(servers.kind, 'mcp-servers');
  assert.deepEqual(servers.values.allowedMcpServers, ['notes']);
  assert.deepEqual(servers.values.allowedMcpTools, []);

  const unknown = parseControlWizardInput(wizard(8), 'other', t);
  assert.equal(unknown.kind, 'error');

  const refused = parseControlWizardInput(wizard(11), 'no', t) as WizardFailure;
  assert.equal(refused.kind, 'abort');
  assert.match(refused.message, /授权未创建/);

  const accepted = parseControlWizardInput(wizard(11), 'yes', t) as WizardStep;
  assert.equal(accepted.kind, 'step');
  assert.equal(accepted.wizard.values.confirmWorkspaceTrust, true);
});

test('control wizard only accepts an explicit empty expiry or none for no expiration', () => {
  for (const input of ['', 'none', 'NONE']) {
    const result = parseControlWizardInput(wizard(10), input, t) as WizardStep;
    assert.equal(result.kind, 'step');
    assert.equal(result.wizard.values.expiresAt, null);
  }
  for (const input of [',', ' , ', ',,']) {
    const result = parseControlWizardInput(wizard(10), input, t);
    assert.equal(result.kind, 'error', `invalid expiry ${JSON.stringify(input)} must not create an unlimited grant`);
  }
});

test('control wizard submits and maps values onto the create request', () => {
  const values: ControlWizardValues = {
    name: 'grant',
    defaultPermissionProfile: 'workspace-write',
    maxPermissionProfile: 'full-access',
    defaultNetwork: 'policy',
    maxNetwork: 'unrestricted',
    defaultPolicy: 'ask',
    allowedPolicies: ['ask', 'never'],
    allowOperator: true,
    allowedMcpServers: ['notes'],
    allowedMcpTools: ['mcp:notes/read'],
    expiresAt: null,
    confirmFullAccess: true,
    confirmUnrestrictedNetwork: true,
    confirmPartialWorkspaceWrite: true,
    confirmWorkspaceTrust: true,
  };
  const done = parseControlWizardInput(wizard(13, values), 'yes', t) as WizardStep;
  // 上限是 full-access、网络 unrestricted，第 13 步之后还要确认不受限网络。
  assert.equal(done.kind, 'step');
  assert.equal(done.wizard.step, 14);

  const request = controlGrantRequest(
    { ...values, confirmUnrestrictedNetwork: true },
    '/project',
    'v1',
  );
  assert.deepEqual(request, {
    version: 'v1',
    grantName: 'grant',
    projectRoot: '/project',
    defaultPermissionProfile: 'workspace-write',
    maxPermissionProfile: 'full-access',
    defaultNetwork: 'policy',
    maxNetwork: 'unrestricted',
    defaultPolicy: 'ask',
    allowedPolicyAlways: false,
    allowedPolicyAsk: true,
    allowedPolicyAuto: false,
    allowedPolicyNever: true,
    allowOperator: true,
    allowedMcpServers: ['notes'],
    allowedMcpTools: ['mcp:notes/read'],
    confirmFullAccess: true,
    confirmUnrestrictedNetwork: true,
    confirmPartialWorkspaceWrite: true,
    confirmWorkspaceTrust: true,
    expiresAt: '',
  });
});
