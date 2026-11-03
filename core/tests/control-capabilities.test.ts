import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerScopeOf, mayRecordHumanRun, maySetPermission, requireTrustedUi, runChannelOf, runOriginBasis, runScopesOf } from '../dist/host/capabilities.js';

// 外控身份/能力判定表是 P6-A 的唯一事实来源；这里固定它对四种通道的取值，
// 防止 Host 再次按请求参数或单个布尔位推导权限。

test('run scopes follow the trusted channel, not request parameters', () => {
  const ui = { permissionControl: true };
  const controller = { permissionControl: false };
  const bridge = { permissionControl: false, agentControl: { operator: false } };
  assert.equal(runScopesOf(ui, false, 'controller:grant-a'), undefined, 'the trusted local UI can read every scope');
  assert.deepEqual(runScopesOf(bridge, true, 'controller:grant-a'), ['human', 'controller:grant-a'], 'the authenticated bridge reads human runs and its own controller scope');
  assert.deepEqual(runScopesOf(controller, false, 'controller:grant-a'), ['controller:grant-a'], 'a grant-bound controller only reads its own scope');
  assert.deepEqual(runScopesOf(controller, false, controllerScopeOf(undefined)), ['controller:local'], 'a grant-less local controller keeps the local scope');
});

test('only the trusted UI or an authenticated bridge can record a human run', () => {
  assert.equal(mayRecordHumanRun({ permissionControl: true }, false), true);
  assert.equal(mayRecordHumanRun({ permissionControl: false }, true), true);
  assert.equal(mayRecordHumanRun({ permissionControl: false }, false), false);
  assert.equal(mayRecordHumanRun({ permissionControl: false, agentControl: { operator: true } }, false), false,
    'operator-ness does not turn a controller connection into a human source');
});

test('session export requires the trusted local UI', () => {
  assert.throws(() => requireTrustedUi('session-export', { permissionControl: false }),
    { code: 'session_export_trusted_ui_required' });
  assert.doesNotThrow(() => requireTrustedUi('session-export', { permissionControl: true }));
});

test('controller scope is derived from the authenticated grant', () => {
  assert.equal(controllerScopeOf(undefined), 'controller:local');
  assert.equal(controllerScopeOf('6f0e6f0b-6f0e-4f0b-8f0e-6f0e6f0e6f0e'), 'controller:6f0e6f0b-6f0e-4f0b-8f0e-6f0e6f0e6f0e');
});

test('permission changes need a trusted channel', () => {
  assert.equal(maySetPermission({ permissionControl: true }, false), true, 'the trusted local UI may change permission');
  assert.equal(maySetPermission({ permissionControl: false }, true), true, 'the authenticated local bridge may change permission for the human');
  assert.equal(maySetPermission({ permissionControl: false, agentControl: { operator: true } }, false), true,
    'a granted operator keeps its bounded permission ability');
  assert.equal(maySetPermission({ permissionControl: false, agentControl: { operator: false } }, false), false);
  assert.equal(maySetPermission({ permissionControl: false }, false), false, 'a plain MCP client never changes permission');
});

test('run provenance describes the channel and the basis, not the request', () => {
  assert.equal(runChannelOf({ permissionControl: true }, false), 'trusted-ui');
  assert.equal(runChannelOf({ permissionControl: false }, true), 'agent-control-bridge');
  assert.equal(runChannelOf({ permissionControl: false }, false), 'mcp');
  assert.equal(runOriginBasis({ permissionControl: true }, false), 'permission-control');
  assert.equal(runOriginBasis({ permissionControl: false }, true), 'agent-control-bridge');
  assert.equal(runOriginBasis({ permissionControl: false }, false), 'caller-scope-default');
});
