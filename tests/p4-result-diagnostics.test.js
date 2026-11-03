import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';

test('persisted and reused failed runs retain the actual provider diagnostic', async () => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests++;
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Temporarily unavailable' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    await withTuiHost(async ({ client, projectDirectory, sessionId }) => {
      await client.request('session.configure', { sessionId, provider: 'legacy', model: 'local-test-model' });
      const input = { sessionId, input: 'Read this response', requestKey: 'failed-provider' };
      let original;
      try { await client.request('run.start', input); }
      catch (error) { original = error; }
      assert.equal(original?.diagnostics?.status, 503);
      const receipt = await client.request('run.receipt', { projectRoot: projectDirectory, sessionId, requestKey: input.requestKey });
      const page = await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: receipt.runId });
      const saved = JSON.parse(page.json);
      assert.deepEqual(saved.diagnostic.provider, original.diagnostics);
      await assert.rejects(client.request('run.start', input), error => {
        assert.equal(error.code, original.code);
        assert.deepEqual(error.diagnostics, original.diagnostics);
        return true;
      });
      assert.equal(requests, 1, 'same-key retry must only read the original failure');
    }, { permissionControl: true, config: { model: { api: 'chat-completions', model: 'local-test-model',
      apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY', baseURL, retry: { maxAttempts: 1 } } } });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('reusing a structured completion preserves its original completion identity', async () => {
  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    const args = { sessionId, requestKey: 'structured-completion',
      input: JSON.stringify({ tool: 'ligule_delegation_result', args: { result: { value: 42 } } }),
      delegation: { outputSchema: { type: 'object', properties: { value: { type: 'integer' } },
        required: ['value'], additionalProperties: false } } };
    const original = await client.request('run.start', args);
    const reused = await client.request('run.start', args);
    assert.equal(original.completedBy, 'ligule_delegation_result');
    assert.equal(reused.completedBy, original.completedBy);
    assert.equal(reused.runId, original.runId);
    assert.deepEqual(reused.structured, original.structured);
    assert.deepEqual(reused.validation, original.validation);
    assert.equal(providerRequests.length, 1);
  }, { config: { policy: { mode: 'auto' } }, permissionControl: true });
});
