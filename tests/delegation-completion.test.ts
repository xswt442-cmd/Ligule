import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createControl } from '../core/dist/host/control.js';
import { createPermissionContext } from '../core/dist/kernel/permission.js';
import { withTuiHost, waitFor } from '../core/tests/helpers/tui-host.ts';

const outputSchema = {
  type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false,
};
const permission = createPermissionContext('workspace-write', 'disabled', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});
type RecordedResult = {
  state?: string;
  stopReason?: string;
  code?: string;
  validation?: { status?: string };
  output?: { structured?: unknown };
  artifacts?: unknown;
  content?: { sessionId: string; result?: RecordedResult };
};
type SessionRecord = {
  kind?: string;
  text?: string;
  status?: string;
  code?: string;
  tool?: string;
  completedBy?: string;
  result?: RecordedResult;
};
const config = { policy: { mode: 'auto' }, loop: { iterations: 4, modelCalls: 4 } };

async function readEvents(directory: string, id: string): Promise<SessionRecord[]> {
  return (await readFile(join(directory, `${id}.jsonl`), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as SessionRecord);
}

test('a missing delegated result fails the saved turn, preserves writes, and pauses the queue', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      const started = control.start(sessionId, JSON.stringify({ tool: 'create', args: { path: 'work.txt', content: 'completed side effect' } }), { outputSchema });
      const queued = await control.send(sessionId, 'send', 'Continue with an ordinary conversation.') as { queued: boolean };
      assert.equal(queued.queued, true);
      const stopped = await control.await(started.operationId, 10_000);
      assert.equal(await readFile(join(projectDirectory, 'work.txt'), 'utf8'), 'completed side effect');
      assert.equal(stopped.state, 'failed');
      assert.equal(stopped.code, 'delegation_result_missing');
      assert.equal(stopped.result!.state, 'failed');
      assert.equal(stopped.result!.stopReason, 'validation_failed');
      assert.equal(stopped.result!.validation.status, 'invalid');
      assert.deepEqual(stopped.result!.artifacts, [{ kind: 'session', sessionId }]);
      assert.equal(stopped.queuePaused, true);
      assert.equal(stopped.queue.length, 1);
      const events = await readEvents(sessionDirectory, sessionId);
      const turns = events.filter(event => event.kind === 'turn');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].status, 'failed');
      assert.equal(turns[0].code, 'delegation_result_missing');
      assert.ok(events.some(event => event.kind === 'assistant' && event.text !== ''));
      const continued = await control.send(sessionId, 'continue');
      const completed = await control.await(continued.currentOperationId!, 10_000);
      assert.equal(completed.state, 'done');
      assert.equal(completed.result!.validation.status, 'not_requested');
    } finally {
      await control.release();
    }
  }, { config, permission });
});

test('an invalid structured submission followed by text cannot complete a delegated run', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      const started = control.start(sessionId, JSON.stringify({ tool: 'ligule_delegation_result', args: { result: { answer: 42 } } }), { outputSchema });
      const stopped = await control.await(started.operationId, 10_000);
      assert.equal(stopped.state, 'failed');
      assert.equal(stopped.result!.stopReason, 'validation_failed');
      assert.equal(stopped.result!.validation.status, 'invalid');
      const events = await readEvents(sessionDirectory, sessionId);
      assert.ok(events.some(event => event.kind === 'tool' && event.result?.code === 'delegation_result_invalid'));
      assert.deepEqual(events.filter(event => event.kind === 'turn').map(event => event.status), ['failed']);
    } finally {
      await control.release();
    }
  }, { config, permission });
});

test('a valid delegated result completes once and does not constrain the next ordinary turn', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      const started = control.start(sessionId, JSON.stringify({ tool: 'ligule_delegation_result', args: { result: { answer: 'checked' } } }), { outputSchema });
      const completed = await control.await(started.operationId, 10_000);
      assert.equal(completed.state, 'done');
      assert.equal(completed.result!.validation.status, 'valid');
      assert.deepEqual(completed.result!.output!.structured, { answer: 'checked' });
      const events = await readEvents(sessionDirectory, sessionId);
      assert.deepEqual(events.filter(event => event.kind === 'turn').map(event => [event.status, event.completedBy]), [['completed', 'ligule_delegation_result']]);
      const next = control.start(sessionId, 'Ordinary next turn.');
      assert.equal((await control.await(next.operationId, 10_000)).result!.validation.status, 'not_requested');
    } finally {
      await control.release();
    }
  }, { config, permission });
});

test('cancelling before a structured result preserves cancellation as the terminal reason', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory, providerRequests }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      const started = control.start(sessionId, 'Await the structured answer.', { outputSchema });
      await waitFor(() => providerRequests.length > 0);
      const stopped = await control.cancel(started.operationId);
      assert.equal(stopped.state, 'cancelled');
      assert.equal(stopped.result!.stopReason, 'cancelled');
      const events = await readEvents(sessionDirectory, sessionId);
      assert.deepEqual(events.filter(event => event.kind === 'turn').map(event => event.status), ['cancelled']);
    } finally {
      await control.release();
    }
  }, { config, permission, delayMs: 500 });
});

test('exhausting the existing loop budget preserves its reason before a structured submission', async () => {
  await withTuiHost(async ({ host, projectDirectory, sessionDirectory }) => {
    const control = createControl(host, projectDirectory, { operator: true });
    try {
      const { sessionId } = await control.create(projectDirectory);
      const started = control.start(sessionId, JSON.stringify({ tool: 'find', args: { pattern: '**' } }), { outputSchema });
      const stopped = await control.await(started.operationId, 10_000);
      assert.equal(stopped.state, 'failed');
      assert.equal(stopped.code, 'loop_iteration_limit');
      assert.equal(stopped.result!.stopReason, 'budget_exhausted');
      const events = await readEvents(sessionDirectory, sessionId);
      assert.deepEqual(events.filter(event => event.kind === 'turn').map(event => [event.status, event.code]), [['failed', 'loop_iteration_limit']]);
    } finally {
      await control.release();
    }
  }, { config: { ...config, loop: { iterations: 1, modelCalls: 1 } }, permission });
});

for (const scenario of ['missing', 'invalid', 'valid']) {
  test(`an internal child enforces the completion contract for ${scenario} output`, async () => {
    await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory }) => {
      await client.request('mode.set', { sessionId, name: 'full' });
      const task = scenario === 'missing'
        ? JSON.stringify({ tool: 'create', args: { path: 'child-work.txt', content: 'child side effect' } })
        : JSON.stringify({ tool: 'ligule_delegation_result', args: { result: { answer: scenario === 'valid' ? 'checked' : 42 } } });
      await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'subagent', args: { task, outputSchema } }) });
      const parentEvents = await readEvents(sessionDirectory, sessionId);
      const child = parentEvents.find(event => event.kind === 'tool' && event.tool === 'subagent')!.result!.content!;
      const childEvents = await readEvents(sessionDirectory, child.sessionId);
      const terminal = childEvents.filter(event => event.kind === 'turn');
      assert.equal(terminal.length, 1);
      if (scenario === 'valid') {
        assert.equal(child.result?.state, 'completed');
        assert.equal(child.result?.validation?.status, 'valid');
        assert.deepEqual(child.result?.output?.structured, { answer: 'checked' });
        assert.equal(terminal[0].status, 'completed');
      } else {
        assert.equal(child.result?.state, 'failed');
        assert.equal(child.result?.stopReason, 'validation_failed');
        assert.equal(child.result?.validation?.status, 'invalid');
        assert.equal(terminal[0].status, 'failed');
        assert.equal(terminal[0].code, 'delegation_result_missing');
        if (scenario === 'missing') assert.equal(await readFile(join(projectDirectory, 'child-work.txt'), 'utf8'), 'child side effect');
        else assert.ok(childEvents.some(event => event.kind === 'tool' && event.result?.code === 'delegation_result_invalid'));
      }
    }, { config, permission });
  });
}
