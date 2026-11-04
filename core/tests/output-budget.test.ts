import test from 'node:test';
import assert from 'node:assert/strict';
import { hostProviderFromConfig, providerFromConfig } from '../dist/host/provider.js';
import { createConfig } from '../dist/kernel/config.js';
import { editableField, encodeValue } from '../dist/kernel/config-edit.js';
import { createServer } from 'node:http';
import { listenFetchable } from './helpers/port.ts';

const official = { api: 'chat-completions', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: string }).code === code;
}

test('explicit output budget is effective for a verified model while the default stays 8192', () => {
  assert.equal(providerFromConfig({ model: official }).outputTokens, 8192);
  assert.equal(providerFromConfig({ model: { ...official, outputTokens: 16384 } }).outputTokens, 16384);
  assert.equal(providerFromConfig({ model: { ...official, outputTokens: 1024 } }).outputTokens, 1024);
});

test('the official DeepSeek root URL keeps its verified output limit', () => {
  const rootEndpoint = { ...official, baseURL: 'https://api.deepseek.com' };
  assert.equal(providerFromConfig({ model: rootEndpoint }).outputTokens, 8192);
  assert.equal(providerFromConfig({ model: { ...rootEndpoint, outputTokens: 32768 } }).outputTokens, 32768);
});

test('a later generation can only lower the output ceiling', () => {
  // 复审拿 400 的上限时必须真的生效：会话本身 8192 不能把它盖回去。
  const session = hostProviderFromConfig({ model: { ...official, outputTokens: 8192 } }, { outputTokensCeiling: 8192 });
  assert.equal(session.withGeneration({ outputTokensCeiling: 400 }).outputTokens, 400);
  assert.equal(session.withGeneration({ outputTokensCeiling: 1_024 }).outputTokens, 1_024);
  // 没有会话上限时，新上限就是唯一的上限。
  const plain = hostProviderFromConfig({ model: { ...official, outputTokens: 8192 } });
  assert.equal(plain.withGeneration({ outputTokensCeiling: 400 }).outputTokens, 400);
});

test('a later generation keeps the session settings it does not name', () => {
  // 复审只收紧输出上限；会话的思考档必须跟着走，不能被重建时的默认值抹掉。
  const session = hostProviderFromConfig(
    { model: { ...official, outputTokens: 8192 } },
    { outputTokensCeiling: 8192, thinkingEffort: 'low' },
  );
  const narrowed = session.withGeneration({ outputTokensCeiling: 400 });
  assert.equal(narrowed.outputTokens, 400);
  assert.equal(narrowed.thinkingEffort, 'low');
});

test('output budgets fail explicitly when unsupported or invalid', () => {
  assert.throws(() => providerFromConfig({ model: { ...official, baseURL: 'https://proxy.example/v1', outputTokens: 16384 } }),
    (error) => hasCode(error, 'provider_output_budget_unsupported'));
  for (const outputTokens of [-1, 0, 1.5, Infinity, NaN, '16384']) {
    assert.throws(() => providerFromConfig({ model: { ...official, outputTokens } }),
      (error) => hasCode(error, 'provider_output_budget_invalid'));
  }
});

test('legacy lowering and context bounds remain in force for explicit budgets', () => {
  assert.equal((providerFromConfig({ model: { ...official, capabilities: { maxOutputTokens: 16384 } } }).capabilities as { maxOutputTokens: number }).maxOutputTokens, 8192);
  assert.throws(() => providerFromConfig({ model: { ...official, outputTokens: 16384, capabilities: { maxOutputTokens: 4096 } } }),
    (error) => hasCode(error, 'provider_output_budget_unsupported'));
  assert.throws(() => providerFromConfig({ model: { ...official, outputTokens: 16384 }, limits: { contextTokens: 8192 } }),
    (error) => hasCode(error, 'provider_output_budget_unsupported'));
  for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => providerFromConfig({ model: { ...official, capabilities: { maxOutputTokens } } }),
      (error) => hasCode(error, 'provider_capability_invalid'));
  }
});

test('request budget follows normal config precedence and is an editable validated field', () => {
  const config = createConfig({ user: { model: { ...official, outputTokens: 16384 } }, local: { model: { outputTokens: 4096 } } });
  assert.equal(providerFromConfig(config).outputTokens, 4096);
  assert.deepEqual(encodeValue(editableField('model.outputTokens'), 16384), { literal: '16384', value: 16384 });
  assert.throws(() => encodeValue(editableField('model.outputTokens'), 0), (error) => hasCode(error, 'config_field_value'));
});

test('model switches recompute verified bounds without changing the original provider', () => {
  const provider = providerFromConfig({ model: { ...official, outputTokens: 16384 } });
  assert.equal(provider.withModel('deepseek-v4-pro').outputTokens, 16384);
  assert.throws(() => provider.withModel('unverified-model'), (error) => hasCode(error, 'provider_output_budget_unsupported'));
  assert.equal(provider.outputTokens, 16384);
  const services = ([
    { id: 'official', name: 'Official', ...official, apiKeyEnv: 'BUDGET_TEST_KEY', models: ['deepseek-flash'] },
    { id: 'other', name: 'Other', api: 'messages', baseURL: 'https://other.example/v1', apiKeyEnv: 'BUDGET_TEST_KEY', models: ['other-model'] },
  ] as { id: string; name: string; api: string; baseURL: string; model?: string; apiKeyEnv: string; models: string[] }[]).map(({ model, ...service }) => service);
  assert.equal(providerFromConfig({ model: { services, selection: { provider: 'official', model: 'deepseek-flash' }, outputTokens: 16384 } }).outputTokens, 16384);
  assert.throws(() => providerFromConfig({ model: { services, selection: { provider: 'other', model: 'other-model' }, outputTokens: 16384 } }),
    (error) => hasCode(error, 'provider_output_budget_unsupported'));
});

test('both provider protocols put the configured request budget on the real wire', async () => {
  const requests: { max_tokens?: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(request.url?.endsWith('/messages')
      ? 'data: {"type":"message_start","message":{"usage":{}}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n'
      : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listenFetchable(server);
  const previous = process.env.BUDGET_TEST_KEY;
  process.env.BUDGET_TEST_KEY = 'synthetic-budget-key';
  try {
    for (const api of ['messages', 'chat-completions']) {
      const provider = providerFromConfig({ model: { api, baseURL: `http://127.0.0.1:${port}/v1`, model: 'local-model', apiKeyEnv: 'BUDGET_TEST_KEY', outputTokens: 2048 } });
      for await (const event of provider.stream({ system: '', tools: [], messages: [] })) assert.ok(event.type);
    }
    assert.deepEqual(requests.map((request) => request.max_tokens), [2048, 2048]);
  } finally {
    if (previous === undefined) delete process.env.BUDGET_TEST_KEY; else process.env.BUDGET_TEST_KEY = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('service model budgets are sent for the selected model on the real wire', async () => {
  const requests: { model?: unknown; max_tokens?: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listenFetchable(server);
  const previous = process.env.BUDGET_TEST_KEY;
  process.env.BUDGET_TEST_KEY = 'synthetic-budget-key';
  const service = {
    id: 'custom', name: 'Custom', api: 'chat-completions', baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'BUDGET_TEST_KEY',
    models: ['small', 'large'],
    modelSettings: [
      { id: 'small', contextTokens: 24000, outputTokens: 4096 },
      { id: 'large', contextTokens: 96000, outputTokens: 32768 },
    ],
  };
  try {
    for (const model of service.models) {
      const provider = providerFromConfig({ model: { services: [service], selection: { provider: 'custom', model } } });
      for await (const event of provider.stream({ system: '', tools: [], messages: [] })) assert.ok(event.type);
    }
    assert.deepEqual(requests.map((request) => [request.model, request.max_tokens]), [['small', 4096], ['large', 32768]]);
    assert.equal(providerFromConfig({ model: { services: [{ ...service, modelSettings: [{ id: 'small', contextTokens: 12000 }] }], selection: { provider: 'custom', model: 'small' } } }).outputTokens, 8192,
      'a context-only declaration is checked against the default output budget');
    assert.throws(() => providerFromConfig({ model: { services: [{ ...service, modelSettings: [{ id: 'small', contextTokens: 4096 }] }], selection: { provider: 'custom', model: 'small' } } }),
      (error) => hasCode(error, 'provider_output_budget_unsupported'));
    assert.throws(() => providerFromConfig({ model: { api: 'chat-completions', baseURL: 'https://proxy.example/v1', model: 'local-model', outputTokens: 32768, serviceOutputLimit: true } }),
      (error) => hasCode(error, 'provider_output_budget_unsupported'), 'user configuration cannot forge the internal service declaration');
    const configured = providerFromConfig({ model: { services: [service], selection: { provider: 'custom', model: 'large' } } });
    assert.equal(configured.withModel('small').outputTokens, 4096, 'switching within a service resolves that model\'s own budget');
    assert.throws(() => configured.withModel('another-model'), (error) => hasCode(error, 'model_not_available'));
    const officialService = {
      id: 'official', name: 'Official', api: 'chat-completions', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'BUDGET_TEST_KEY',
      models: ['deepseek-flash'], modelSettings: [{ id: 'deepseek-flash', outputTokens: 500000 }],
    };
    assert.throws(() => providerFromConfig({ model: { services: [officialService], selection: { provider: 'official', model: 'deepseek-flash' } } }),
      (error) => hasCode(error, 'provider_output_budget_unsupported'));
  } finally {
    if (previous === undefined) delete process.env.BUDGET_TEST_KEY; else process.env.BUDGET_TEST_KEY = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
