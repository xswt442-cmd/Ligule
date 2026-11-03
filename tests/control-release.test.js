import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { createControl } from '../core/dist/host/control.js';
import { createHost } from '../core/dist/host/host.js';
import { createConfig } from '../core/dist/kernel/config.js';
import { createChatCompletionsProvider } from '../core/dist/model/chat-completions.js';
import { withTuiHost, waitFor } from '../core/tests/helpers/tui-host.ts';

test('controller shutdown cancels a real Host run before draining a delayed read response', async () => {
  await withTuiHost(async ({ host, sessionId, projectDirectory, sessionDirectory, providerRequests, client }) => {
    const readGate = Promise.withResolvers();
    const reading = Promise.withResolvers();
    // Delay delivery of a real Host response until its active HTTP run settles.
    const controlled = {
      async handle(message, connection) {
        const work = host.handle(message, connection);
        if (message.method === 'run.start') work.then(readGate.resolve, readGate.resolve);
        const result = await work;
        if (message.method === 'session.read') {
          reading.resolve();
          await readGate.promise;
        }
        return result;
      },
      release: () => host.release(),
    };
    const control = createControl(controlled, projectDirectory);
    let pendingRead;
    let shutdown;
    const deadline = new AbortController();
    try {
      await control.open(projectDirectory, sessionId);
      control.start(sessionId, 'read the project status');
      await waitFor(() => providerRequests.length > 0);
      pendingRead = control.read(sessionId, undefined, 10);
      await reading.promise;
      shutdown = control.release();
      assert.equal(control.release(), shutdown, 'repeated shutdown shares one completion');
      await assert.rejects(control.list(projectDirectory, 10), { code: 'control_closed' });
      await Promise.race([
        shutdown,
        delay(1000, undefined, { signal: deadline.signal }).then(() => { throw new Error('shutdown_waited_for_read_before_cancellation'); }),
      ]);
      await pendingRead;
      assert.equal((await readdir(sessionDirectory)).filter(name => name.endsWith('.lock')).length, 0);
      await assert.rejects(client.request('status.get', { sessionId }), { code: 'host_closed' });
      const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
      assert.equal(events.find(event => event.kind === 'turn').status, 'cancelled');
    } finally {
      deadline.abort();
      await host.release();
      readGate.resolve();
      await Promise.allSettled([pendingRead, shutdown]);
    }
  }, { delayMs: 2500 });
});

for (const [hostFails, earlyOperation] of [[true, false], [false, false], [true, true]]) {
  test(`shutdown preserves ${hostFails ? 'the original Host error' : 'the operation error'} with ${earlyOperation ? 'an early' : 'a late'} operation failure`, async () => {
    await withTuiHost(async ({ config, projectDirectory, providerRequests, sessionDirectory }) => {
      const disposeFailure = new Error('plugin_dispose_failed');
      const operationFailure = new Error('operation_completion_failed');
      const readGate = Promise.withResolvers();
      const reading = Promise.withResolvers();
      const operationGate = Promise.withResolvers();
      const hostFinished = Promise.withResolvers();
      let originalHostError;
      const provider = createChatCompletionsProvider({ baseUrl: config.model.baseURL, model: config.model.model, apiKeyEnv: config.model.apiKeyEnv });
      const host = createHost({ config, provider, plugins: [{ name: 'release-check', setup: () => () => {
        if (hostFails) throw disposeFailure;
      } }] });
      const control = createControl({
        async handle(message, connection) {
          try {
            const result = await host.handle(message, connection);
            if (message.method === 'session.read') { reading.resolve(); await readGate.promise; }
            return result;
          } catch (error) {
            if (message.method === 'run.start') {
              await operationGate.promise;
              // Exercise an unexpected failure while classifying a real cancelled run.
              throw { get code() { throw operationFailure; } };
            }
            throw error;
          }
        },
        async release() {
          try { await host.release(); }
          catch (error) { originalHostError = error; throw error; }
          finally { hostFinished.resolve(); }
        },
      }, projectDirectory);
      let pendingRead;
      let outcome;
      let closed = false;
      try {
        const { sessionId } = await control.create(projectDirectory);
        control.start(sessionId, 'wait for cancellation');
        await waitFor(() => providerRequests.length > 0);
        pendingRead = control.read(sessionId, undefined, 10);
        await reading.promise;
        const shutdown = control.release();
        outcome = shutdown.then(() => { closed = true; return {}; }, error => { closed = true; return { error }; });
        assert.equal(control.release(), shutdown);
        await hostFinished.promise;
        if (earlyOperation) operationGate.resolve();
        await tick();
        assert.equal(closed, false, 'Host failure does not skip pending requests');
        readGate.resolve();
        await pendingRead;
        await tick();
        if (!earlyOperation) assert.equal(closed, false, 'operation completion is drained after requests');
        operationGate.resolve();
        const result = await outcome;
        assert.equal(result.error, hostFails ? originalHostError : operationFailure);
        if (hostFails) assert.ok(originalHostError.errors.includes(disposeFailure));
        assert.equal(control.release(), shutdown, 'repeated close retains the original result');
        assert.equal((await readdir(sessionDirectory)).filter(name => name.endsWith('.lock')).length, 1,
          'only the outer fixture session retains its lock');
      } finally {
        readGate.resolve();
        operationGate.resolve();
        await Promise.allSettled([pendingRead, outcome, host.release()]);
      }
    }, { delayMs: 2500 });
  });
}

test('shutdown refuses session construction after a concurrent project load finishes', async () => {
  await withTuiHost(async ({ config, directory }) => {
    const otherRoot = join(directory, 'other');
    await mkdir(otherRoot);
    const loading = Promise.withResolvers();
    const loaded = Promise.withResolvers();
    const provider = createChatCompletionsProvider({ baseUrl: 'http://127.0.0.1:1', model: 'unused', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' });
    const host = createHost({ config, provider,
      loadEnvironment: async () => {
        loading.resolve();
        await loaded.promise;
        return { config: createConfig({ user: { ...config, workspaceRoot: otherRoot, boundary: otherRoot } }), provider };
      },
    });
    const control = createControl(host, otherRoot);
    const creating = control.create(otherRoot);
    const outcome = creating.then(() => ({ created: true }), error => ({ code: error.code }));
    try {
      await loading.promise;
      const shutdown = control.release();
      loaded.resolve();
      await shutdown;
      assert.deepEqual(await outcome, { code: 'host_closed' });
      assert.equal((await readdir(config.host.sessionDirectory)).filter(name => name.endsWith('.lock')).length, 1,
        'only the fixture Host session retains its existing lock');
    } finally {
      loaded.resolve();
      await Promise.allSettled([creating, outcome]);
      await host.release();
    }
  });
});
