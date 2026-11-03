import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunAcceptance, isRunAcceptance } from '../dist/session/run.js';

// Run 接受记录的格式规则：版本 1 只允许旧字段；版本 2 起必须同时带 via/resolvedBy。
// 旧记录必须继续可读，新记录不能让来源证据缺一半。

test('run acceptance version 2 records channel provenance', () => {
  const run = createRunAcceptance('session-a', 'hello', undefined, 'human', undefined,
    { via: 'trusted-ui', resolvedBy: 'permission-control' });
  assert.equal(run.version, 2);
  assert.equal(run.via, 'trusted-ui');
  assert.equal(run.resolvedBy, 'permission-control');
  assert.equal(isRunAcceptance(run), true);
});

test('run acceptance version 1 keeps its old shape and rejects provenance keys', () => {
  const run = createRunAcceptance('session-a', 'hello', undefined, 'controller:local');
  assert.equal(run.version, 1);
  assert.equal(isRunAcceptance(run), true);
  assert.equal(isRunAcceptance({ ...run, via: 'trusted-ui' }), false,
    'a version 1 record cannot carry provenance');
  assert.equal(isRunAcceptance({ ...run, resolvedBy: 'permission-control' }), false);
});

test('run acceptance version 2 requires both provenance fields to be safe', () => {
  const run = createRunAcceptance('session-a', 'hello', undefined, 'human', undefined,
    { via: 'agent-control-bridge', resolvedBy: 'agent-control-bridge' });
  assert.equal(isRunAcceptance({ ...run, via: undefined }), false);
  assert.equal(isRunAcceptance({ ...run, resolvedBy: undefined }), false);
  assert.equal(isRunAcceptance({ ...run, version: 1 }), false,
    'a version 1 record cannot carry provenance');
  assert.equal(isRunAcceptance({ ...run, via: 'Trusted UI' }), false);
  assert.equal(isRunAcceptance({ ...run, resolvedBy: '..' }), false);
  assert.throws(() => createRunAcceptance('session-a', 'hello', undefined, 'human', undefined,
    { via: 'has space', resolvedBy: 'permission-control' }), { code: 'run_provenance_invalid' });
  assert.throws(() => createRunAcceptance('session-a', 'hello', undefined, 'human', undefined,
    { via: 'trusted-ui', resolvedBy: '' }), { code: 'run_provenance_invalid' });
});
