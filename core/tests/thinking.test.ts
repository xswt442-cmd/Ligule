import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { providerFromConfig } from '../dist/host/provider.js';
import { thinkingCapabilityOf } from '../dist/model/thinking.js';
import type { ModelMessage } from '../dist/kernel/loop.js';
import { listenFetchable } from './helpers/port.ts';

const official = { api: 'chat-completions', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKeyEnv: 'LIGULE_THINKING_TEST_KEY' };

type ThinkingRequest = {
  max_tokens: number;
  thinking: unknown;
  reasoning_effort: string;
  messages: { role: string; reasoning_content?: string }[];
};

test('thinking controls are advertised only for verified DeepSeek endpoint and models', () => {
  assert.deepEqual(thinkingCapabilityOf(official.api, official.baseURL, official.model)!.efforts, ['none', 'low', 'high', 'max']);
  assert.deepEqual(thinkingCapabilityOf(official.api, 'https://api.deepseek.com', official.model)?.efforts, ['none', 'low', 'high', 'max']);
  assert.equal(thinkingCapabilityOf(official.api, 'https://gateway.example/v1', official.model), undefined);
  assert.equal(thinkingCapabilityOf(official.api, 'http://api.deepseek.com/v1', official.model), undefined);
  assert.equal(thinkingCapabilityOf(official.api, 'https://api.deepseek.com/v1?token=hidden', official.model), undefined);
  assert.equal(thinkingCapabilityOf(official.api, 'https://user@api.deepseek.com/v1', official.model), undefined);
  assert.equal(thinkingCapabilityOf(official.api, official.baseURL, 'deepseek-chat'), undefined);
  assert.equal(thinkingCapabilityOf('messages', official.baseURL, official.model), undefined);
  assert.throws(() => providerFromConfig({ model: { ...official, baseURL: 'https://gateway.example/v1' } }, { thinkingEffort: 'high' }),
    (error) => (error as { code?: string }).code === 'provider_thinking_unsupported');
});

test('verified thinking effort, output budget, and assistant reasoning reach the HTTP request body', async () => {
  const requests: ThinkingRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const port = await listenFetchable(server);
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.LIGULE_THINKING_TEST_KEY;
  process.env.LIGULE_THINKING_TEST_KEY = 'synthetic-thinking-test-key';
  globalThis.fetch = (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/v1/chat/completions', 'capability resolution keeps the official endpoint');
    return originalFetch(`http://127.0.0.1:${port}/v1/chat/completions`, init);
  };
  try {
    const provider = providerFromConfig({ model: { ...official, serviceContextTokens: 32_768 } }, { thinkingEffort: 'high', outputTokens: 16_384 });
    assert.equal(provider.maxOutputTokens, 393_216, 'the verified model output ceiling is separate from the current request budget and context window');
    const messages: ModelMessage[] = [
      { role: 'assistant', text: '', reasoning: 'continue this verified reasoning', toolCalls: [{ id: 'call-1', name: 'read', args: { path: 'README.md' } }] },
      { role: 'tool', id: 'call-1', tool: 'read', content: 'file read' },
    ];
    for await (const event of provider.stream({ system: '', tools: [], messages })) assert.ok(event.type);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens, 16_384);
    assert.deepEqual(requests[0].thinking, { type: 'enabled' });
    assert.equal(requests[0].reasoning_effort, 'high');
    assert.equal(requests[0].messages.find((message) => message.role === 'assistant')!.reasoning_content, 'continue this verified reasoning');
    const disabled = provider.withGeneration({ thinkingEffort: 'none', outputTokens: 1024 });
    for await (const event of disabled.stream({ system: '', tools: [], messages: [] })) assert.ok(event.type);
    assert.equal(requests[1].max_tokens, 1024);
    assert.deepEqual(requests[1].thinking, { type: 'disabled' });
    assert.equal(requests[1].reasoning_effort, 'none');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.LIGULE_THINKING_TEST_KEY;
    else process.env.LIGULE_THINKING_TEST_KEY = previousKey;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
