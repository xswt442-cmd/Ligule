import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverModels, discoveredModelIds } from '../dist/model/discovery.js';
import { listenFetchable } from './helpers/port.ts';

test('model discovery keeps unique valid IDs from an OpenAI-compatible catalog', () => {
  assert.deepEqual(discoveredModelIds({ data: [
    { id: 'model-a' }, { id: 'model-a' }, { id: ' model-b ' }, { id: '' }, { id: 'bad\nvalue' }, { name: 'no id' },
  ] }), ['model-a', 'model-b']);
});

test('model discovery closes oversized HTTP bodies without masking the size error', async () => {
  const reference = 'LIGULE_DISCOVERY_STREAM_LIMIT_TEST';
  const previousKey = process.env[reference];
  const originalFetch = globalThis.fetch;
  process.env[reference] = 'fake-test-key';
  try {
    let headerCancelled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      headers: new Headers({ 'content-length': '2000000' }),
      body: { cancel: async () => { headerCancelled = true; } },
    })) as unknown as typeof fetch;
    await assert.rejects(discoverModels({
      api: 'chat-completions', baseURL: 'https://example.test/v1', reference,
    }), { code: 'model_discovery_response_too_large' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(headerCancelled, true, 'oversized response body should be cancelled before streaming');

    let released = false;
    let cancelled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(1024 * 1024 + 1) }),
          cancel: async () => { cancelled = true; throw new Error('upstream abort failed'); },
          releaseLock: () => { released = true; },
        }),
      },
    })) as unknown as typeof fetch;
    await assert.rejects(discoverModels({
      api: 'chat-completions', baseURL: 'https://example.test/v1', reference,
    }), { code: 'model_discovery_response_too_large' });
    assert.equal(cancelled, true);
    assert.equal(released, true, 'reader lock must be released on oversized stream');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env[reference];
    else process.env[reference] = previousKey;
  }
});


test('model discovery forbids credential transmission over remote HTTP but permits loopback and ephemeral keys', async () => {
  const reference = 'LIGULE_DISCOVERY_TLS_TEST';
  const previous = process.env[reference];
  const originalFetch = globalThis.fetch;
  process.env[reference] = 'stored-value';
  const calls: { url: string | URL | Request; authorization: string }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: (options as { headers: Record<string, string> }).headers.authorization });
    return new Response(JSON.stringify({ data: [{ id: 'ephemeral-model' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await assert.rejects(discoverModels({ api: 'chat-completions', baseURL: 'http://remote.example/v1', reference }), { code: 'model_discovery_insecure_transport' });
    assert.equal(calls.length, 0, 'remote HTTP must fail before any network request');
    assert.deepEqual(await discoverModels({ api: 'chat-completions', baseURL: 'http://127.0.0.1:3000/v1', reference, temporaryKey: 'unsaved-preview' }), ['ephemeral-model']);
    assert.equal(calls[0].authorization, 'Bearer unsaved-preview', 'temporary key must be scoped to the preview request');
    assert.deepEqual(await discoverModels({ api: 'chat-completions', baseURL: 'https://remote.example/v1', reference }), ['ephemeral-model']);
    assert.equal(calls[1].authorization, 'Bearer stored-value', 'normal HTTPS discovery still resolves the configured reference');
    await assert.rejects(discoverModels({ api: 'chat-completions', baseURL: 'https://remote.example/v1', reference, temporaryKey: '' }), { code: 'credential_value_invalid' });
    assert.equal(calls.length, 2, 'invalid temporary keys must not reach fetch');
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env[reference];
    else process.env[reference] = previous;
  }
});

test('model discovery rejects malformed catalogs without truncating valid IDs', () => {
  assert.throws(() => discoveredModelIds({ models: [] }), { code: 'model_discovery_response_invalid' });
  const models = Array.from({ length: 140 }, (_, index) => ({ id: `model-${index}` }));
  assert.deepEqual(discoveredModelIds({ data: models }), models.map(({ id }) => id));
});

test('HTTP model discovery preserves all candidates before the user selects a saved catalog', async () => {
  const models = Array.from({ length: 140 }, (_, index) => ({ id: `candidate-${index}` }));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: models }));
  });
  await listenFetchable(server);
  try {
    const found = await discoverModels({
      api: 'chat-completions', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      reference: 'LIGULE_DISCOVERY_CANDIDATES', temporaryKey: 'local-discovery-nonsecret',
    });
    assert.deepEqual(found, models.map(({ id }) => id));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
