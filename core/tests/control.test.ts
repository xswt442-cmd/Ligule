import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createControl } from '../dist/host/control.js';
import type { Host } from '../dist/host/host.js';
import type { RunResult } from '../dist/delegation.js';

const testplace = resolve('testplace');

test('await waits on the active run, returns the result once complete, and can time out without cancelling it', async () => {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'control-await-'));
  await (async () => {
    let finishRun!: (value: unknown) => void;
    let runCalls = 0;
    const host = {
      async handle({ method }: { method: string }) {
        if (method === 'session.create') return { sessionId: 'await-session' };
        if (method === 'run.start') {
          runCalls += 1;
          return new Promise((resolve) => { finishRun = resolve; });
        }
        throw new Error(`unexpected host method: ${method}`);
      },
      async release() {},
    };
    const control = createControl(host, directory);
    try {
      const { sessionId } = await control.create(directory);
      const started = control.start(sessionId, 'finish the task');
      const timedOut = await control.await(started.operationId, 1);
      assert.equal(timedOut.state, 'running');
      assert.equal(timedOut.timedOut, true);
      assert.equal(timedOut.result, null);

      const waiting = control.await(started.operationId, 5_000);
      finishRun({ text: 'Task complete', iterations: 3, modelCalls: 2 });
      const completed = await waiting;
      const result = completed.result as RunResult;
      assert.equal(completed.state, 'done');
      assert.equal(completed.timedOut, false);
      assert.equal(result.state, 'completed');
      assert.equal(result.stopReason, 'assistant_completed');
      assert.deepEqual(result.output, { text: 'Task complete' });
      assert.deepEqual(result.usage, { iterations: 3, modelCalls: 2 });
      assert.deepEqual(result.artifacts, [{ kind: 'session', sessionId }]);
      assert.equal(runCalls, 1);

      const repeated = await control.await(started.operationId, 0);
      assert.deepEqual(repeated.result, completed.result);
      assert.equal(runCalls, 1);
    } finally {
      await control.release();
      await rm(directory, { recursive: true, force: true });
    }
  })();
});

test('await rejects unknown operations and invalid wait bounds', async () => {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'control-await-'));
  await (async () => {
    const control = createControl({ async release() {} } as unknown as Host, directory);
    try {
      await assert.rejects(control.await('missing', 1), { code: 'operation_not_found' });
      await assert.rejects(control.await('missing', -1), { code: 'control_wait_timeout_invalid' });
    } finally {
      await control.release();
      await rm(directory, { recursive: true, force: true });
    }
  })();
});

test('control accepts a Windows path spelling that resolves to its bound project root', {
  skip: process.platform !== 'win32',
}, async () => {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'control-project-path-'));
  const host = {
    async handle({ method }: { method: string }) {
      if (method === 'session.create') return { sessionId: 'path-session' };
      throw new Error(`unexpected host method: ${method}`);
    },
    async release() {},
  };
  const control = createControl(host, directory.toUpperCase());
  try {
    const opened = await control.create(directory);
    assert.equal(opened.sessionId, 'path-session');
  } finally {
    await control.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed delegated run reports a requested structured result as invalid', async () => {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'control-await-'));
  await (async () => {
    const host = {
      async handle({ method }: { method: string }) {
        if (method === 'session.create') return { sessionId: 'schema-failure-session' };
        if (method === 'run.start') throw Object.assign(new Error('provider_transport_error'), { code: 'provider_transport_error' });
        throw new Error(`unexpected host method: ${method}`);
      },
      async release() {},
    };
    const control = createControl(host, directory);
    try {
      const { sessionId } = await control.create(directory);
      const started = control.start(sessionId, 'return a structured result', {
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      });
      const failed = await control.await(started.operationId, 5_000);
      const { validation } = failed.result as RunResult;
      assert.equal(failed.state, 'failed');
      assert.equal(validation.status, 'invalid');
      assert.match(validation.errors![0], /provider_transport_error/u);
    } finally {
      await control.release();
      await rm(directory, { recursive: true, force: true });
    }
  })();
});
