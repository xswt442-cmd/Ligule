import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createControl } from '../core/dist/host/control.js';
import { createPermissionContext } from '../core/dist/kernel/permission.js';
import { runSummary } from '../core/dist/kernel/run-summary.js';
import { withTuiHost, waitFor } from '../core/tests/helpers/tui-host.ts';

const permission = createPermissionContext('workspace-write', 'disabled', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'unavailable', process: 'unavailable',
});

async function events(directory, sessionId) {
  return (await readFile(join(directory, `${sessionId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
}

test('P3 present records a verified file artifact and returns it in the completed delegated run', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory }) => {
    const source = Buffer.from('P3 file delivery content');
    await writeFile(join(projectDirectory, 'report.txt'), source);
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      await control.configure(sessionId, { mode: 'full' });
      const started = control.start(sessionId, JSON.stringify({
        tool: 'present', args: { files: [{ path: 'report.txt', description: 'Final report' }] },
      }));
      const result = await control.await(started.operationId, 10_000);
      assert.equal(result.state, 'done');
      const artifact = result.result.artifacts.find(item => item.kind === 'file');
      assert.ok(artifact);
      assert.equal(artifact.sessionId, sessionId);
      assert.equal(artifact.path, 'report.txt');
      assert.equal(artifact.sha256, createHash('sha256').update(source).digest('hex'));
      assert.equal(artifact.description, 'Final report');
      assert.equal(result.result.usage.modelCalls, 2);
      assert.equal(result.result.task.modelCalls, 2);
      const record = await events(sessionDirectory, sessionId);
      assert.ok(record.some(item => item.kind === 'artifact' && item.artifacts[0].sha256 === artifact.sha256));
      assert.ok(record.some(item => item.kind === 'turn' && item.status === 'completed'));
    } finally { await control.release(); }
  }, { permission, config: { policy: { mode: 'auto' }, loop: { iterations: 4, modelCalls: 4 } } });
});

test('P3 delegated maxModelCalls remains bounded and reports known usage after failure', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory, providerRequests }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      const started = control.start(sessionId, JSON.stringify({ tool: 'find', args: { pattern: '**' } }), {
        budget: { maxModelCalls: 1 },
      });
      const done = await control.await(started.operationId, 10_000);
      assert.equal(done.state, 'failed');
      assert.equal(done.code, 'task_model_budget_exhausted');
      assert.equal(done.result.stopReason, 'budget_exhausted');
      assert.equal(done.result.task.modelCalls, 1);
      assert.equal(done.result.task.maxModelCalls, 1);
      assert.ok(done.result.usage.iterations > 0);
      assert.ok(done.result.usage.modelCalls > 0);
      assert.equal(providerRequests.length, 1);
      const record = await events(sessionDirectory, sessionId);
      const turn = record.find(item => item.kind === 'turn');
      assert.equal(turn.status, 'failed');
      assert.equal(turn.code, 'task_model_budget_exhausted');
      assert.equal(turn.task.modelCalls, 1);
      const invalid = control.start(sessionId, 'not started', { budget: { maxModelCalls: 5 } });
      const denied = await control.await(invalid.operationId, 10_000);
      assert.equal(denied.state, 'failed');
      assert.equal(denied.code, 'task_budget_exceeds_limit');
      assert.equal(providerRequests.length, 1);
    } finally { await control.release(); }
  }, { permission, config: { policy: { mode: 'auto' }, loop: { iterations: 4, modelCalls: 4 } } });
});

test('P3 parent and subagent share logical model-call budget', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory, providerRequests }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      await control.configure(sessionId, { mode: 'full' });
      const started = control.start(sessionId, JSON.stringify({
        tool: 'subagent', args: { task: 'Independent analysis' },
      }), { budget: { maxModelCalls: 2 } });
      const result = await control.await(started.operationId, 10_000);
      assert.equal(result.state, 'failed');
      assert.equal(result.code, 'task_model_budget_exhausted');
      assert.equal(result.result.task.modelCalls, 2);
      assert.equal(providerRequests.length, 2);
      const record = await events(sessionDirectory, sessionId);
      const child = record.find(item => item.kind === 'tool' && item.tool === 'subagent');
      assert.ok(child);
      assert.equal(child.result.content.result.state, 'completed');
    } finally { await control.release(); }
  }, { permission, config: { policy: { mode: 'auto' }, loop: { iterations: 4, modelCalls: 4 } } });
});

test('P3 parent result includes files presented by an internal subagent', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory }) => {
    const bytes = Buffer.from('child delivery');
    await writeFile(join(projectDirectory, 'child-report.txt'), bytes);
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      await control.configure(sessionId, { mode: 'full' });
      const childTask = JSON.stringify({
        tool: 'present', args: { files: [{ path: 'child-report.txt', description: 'Child report' }] },
      });
      const started = control.start(sessionId, JSON.stringify({
        tool: 'subagent', args: { task: childTask },
      }), { budget: { maxModelCalls: 4 } });
      const done = await control.await(started.operationId, 10_000);
      assert.equal(done.state, 'done');
      const artifact = done.result.artifacts.find(item => item.kind === 'file');
      assert.ok(artifact);
      assert.equal(artifact.path, 'child-report.txt');
      assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.ok(artifact.sessionId.startsWith(`${sessionId}.sub-`));
      assert.equal(done.result.task.modelCalls, 4);
      const history = await events(sessionDirectory, sessionId);
      const childResult = history.find(item => item.kind === 'tool' && item.tool === 'subagent').result.content;
      assert.deepEqual(childResult.result.artifacts.find(item => item.kind === 'file'), artifact);
    } finally { await control.release(); }
  }, { permission, config: { policy: { mode: 'auto' }, loop: { iterations: 6, modelCalls: 6 } } });
});

test('P3 request timeout is visible through Control and a later run can start normally', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory, providerRequests }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      const started = control.start(sessionId, 'Long provider request', { budget: { requestTimeoutMs: 25 } });
      const stopped = await control.await(started.operationId, 10_000);
      assert.equal(stopped.state, 'failed');
      assert.equal(stopped.code, 'task_request_timeout');
      assert.equal(stopped.result.stopReason, 'request_timeout');
      assert.equal(stopped.result.task.modelCalls, 1);
      assert.ok(stopped.result.usage.iterations >= 1);
      const record = await events(sessionDirectory, sessionId);
      assert.equal(record.filter(item => item.kind === 'turn').at(-1).code, 'task_request_timeout');
      const again = control.start(sessionId, 'Second request', { budget: { requestTimeoutMs: 1000 } });
      const done = await control.await(again.operationId, 10_000);
      assert.equal(done.state, 'done');
      assert.equal(done.result.task.modelCalls, 1);
      assert.equal(providerRequests.length, 2);
    } finally { await control.release(); }
  }, { permission, delayMs: 125, config: { policy: { mode: 'auto' }, loop: { iterations: 4, modelCalls: 4, requestTimeoutMs: 1000 } } });
});

test('interaction wait budget aborts a pending question without starting another model request', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory, providerRequests }) => {
    await client.request('mode.set', { sessionId, name: 'full' });
    let questionSeen = false;
    client.onRequest((message) => {
      if (message.method === 'question.request') questionSeen = true;
    });
    const questions = JSON.stringify([{ question: 'Wait for a human?', options: [], multiSelect: false }]);
    const run = client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'ask_user_question', args: { questions } }),
    });
    await waitFor(() => questionSeen, { within: 3000 });
    await assert.rejects(run, (error) => {
      const summary = runSummary(error);
      assert.equal(summary?.task?.modelCalls, 1);
      assert.equal(summary?.iterations, 1);
      assert.equal(typeof summary?.userSeq, 'number');
      return error.code === 'task_interaction_timeout';
    });
    assert.equal(providerRequests.length, 1);
    const record = await events(sessionDirectory, sessionId);
    const turn = record.find(item => item.kind === 'turn');
    assert.equal(turn.code, 'task_interaction_timeout');
    assert.equal(turn.task.modelCalls, 1);
    assert.equal((await client.request('status.get', { sessionId })).task.modelCalls, 1);
  }, { interactive: true, permission, config: {
    policy: { mode: 'auto' },
    loop: { iterations: 4, modelCalls: 4, taskTimeoutMs: 400, requestTimeoutMs: 200, interactionWaitTimeoutMs: 400 },
  } });
});
