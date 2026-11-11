import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatCompletionsProvider } from '../dist/model/chat-completions.js';
import { createMessagesProvider } from '../dist/model/messages.js';
import { createKernel, createLoop } from '../dist/index.js';
import { editTool } from '../dist/tools/write.js';
import type { ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import { listenFetchable } from './helpers/port.ts';

const KEY_NAME = 'LIGULE_NONSTREAM_TEST_KEY';
const RETRY = { maxAttempts: 1, baseDelayMs: 0, retry429: false, retry5xx: false, retryTransport: false };

type JsonApi = 'chat' | 'messages';

type JsonProvider = ReturnType<typeof createMessagesProvider> | ReturnType<typeof createChatCompletionsProvider>;

type ProviderFailure = { code?: string; detail?: string; cause?: unknown };

type UsageEvent = Extract<ProviderEvent, { type: 'usage' }>;

type CachedUsage = UsageEvent & { readonly cache: NonNullable<UsageEvent['cache']> };

type WireBody = Record<string, unknown>;

type ObservedRequest = { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders; body: WireBody };

type JsonBody = string | Record<string, unknown>;

type Responder = (
  request: ObservedRequest | undefined,
  count: number,
  response: ServerResponse,
) => JsonBody | undefined | Promise<JsonBody | undefined>;

async function withJsonEndpoint<TResult>(
  api: JsonApi,
  responseBody: JsonBody | Responder,
  run: (provider: JsonProvider, requests: ObservedRequest[]) => TResult | Promise<TResult>,
  contentType = 'application/json',
): Promise<TResult> {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text === '' ? undefined : JSON.parse(text);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    } as unknown as ObservedRequest);
    const responseValue = typeof responseBody === 'function' ? await responseBody(requests.at(-1), requests.length, response) : responseBody;
    if (responseValue === undefined) return;
    response.writeHead(200, { 'content-type': contentType });
    response.end(typeof responseValue === 'string' ? responseValue : JSON.stringify(responseValue));
  });
  const port = await listenFetchable(server);
  const previous = process.env[KEY_NAME];
  process.env[KEY_NAME] = 'synthetic-nonstream-key';
  try {
    const create = api === 'messages' ? createMessagesProvider : createChatCompletionsProvider;
    const provider = create({
      baseUrl: `http://127.0.0.1:${port}${api === 'chat' ? '/v1' : ''}`,
      model: 'json-test-model',
      apiKeyEnv: KEY_NAME,
      capabilities: { streaming: false },
      retry: RETRY,
    });
    return await run(provider, requests);
  } finally {
    if (previous === undefined) delete process.env[KEY_NAME];
    else process.env[KEY_NAME] = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('Chat Completions parses a real non-streaming JSON response and usage', async () => {
  await withJsonEndpoint('chat', {
    id: 'chatcmpl-local',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'local answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  }, async (provider, requests) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'local answer' },
      { type: 'usage', input: 12, output: 4 },
      { type: 'finish', reason: 'stop' },
    ]);
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].headers.accept, 'application/json');
  });
});

test('Messages parses a real non-streaming JSON response and cache usage', async () => {
  await withJsonEndpoint('messages', {
    id: 'msg_local',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'local answer' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 },
  }, async (provider, requests) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'local answer' },
      { type: 'usage', input: 17, output: 4, cache: {
        source: 'anthropic-messages', sourceFields: [
          { field: 'input_tokens', tokens: 12 }, { field: 'cache_read_input_tokens', tokens: 3 },
          { field: 'cache_creation_input_tokens', tokens: 2 },
        ], hitInputTokens: 3, missInputTokens: null, creationInputTokens: 2,
        uncachedInputTokens: 12, providerInputIncludesCache: false, consistent: null,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].headers.accept, 'application/json');
    assert.equal(requests[0].url, '/v1/messages');
  });
});

test('Messages sends the edit root anyOf schema unchanged', async () => {
  await withJsonEndpoint('messages', {
    id: 'msg-schema', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }, async (provider, requests) => {
    await collect(provider.stream({ system: '', messages: [], tools: [editTool] }));
    const tools = requests[0].body.tools as Array<Record<string, unknown>>;
    assert.equal(editTool.parameters.type, 'object');
    assert.ok(Array.isArray(editTool.parameters.anyOf));
    assert.deepEqual(tools, [{
      name: 'edit',
      description: editTool.description,
      input_schema: editTool.parameters,
    }]);
  });
});

test('Chat Completions preserves DeepSeek cache accounting and flags inconsistent reported totals', async () => {
  await withJsonEndpoint('chat', {
    choices: [{ index: 0, message: { role: 'assistant', content: 'cached answer' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 20, completion_tokens: 4,
      prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 10,
      prompt_tokens_details: { cached_tokens: 6 },
    },
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'cached answer' },
      { type: 'usage', input: 20, output: 4, cache: {
        source: 'chat-completions', sourceFields: [
          { field: 'prompt_tokens', tokens: 20 }, { field: 'prompt_cache_hit_tokens', tokens: 5 },
          { field: 'prompt_cache_miss_tokens', tokens: 10 }, { field: 'prompt_tokens_details.cached_tokens', tokens: 6 },
        ], hitInputTokens: 5, missInputTokens: 10,
        creationInputTokens: null, uncachedInputTokens: null, providerInputIncludesCache: true, consistent: false,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  await withJsonEndpoint('chat', {
    choices: [{ index: 0, message: { role: 'assistant', content: 'partial accounting' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } },
  }, async (provider) => {
    const usage = (await collect(provider.stream({ system: '', tools: [], messages: [] }))).find((event) => event.type === 'usage') as CachedUsage;
    assert.equal(usage.cache.consistent, false, 'a cache subset cannot exceed the reported total even when misses are unknown');
  });
});

test('missing totals remain unknown while reported cache details and outputs survive', async () => {
  await withJsonEndpoint('chat', {
    choices: [{ index: 0, message: { role: 'assistant', content: 'partial usage' }, finish_reason: 'stop' }],
    usage: { completion_tokens: 4, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 },
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'partial usage' },
      { type: 'usage', input: null, output: 4, cache: {
        source: 'chat-completions', sourceFields: [
          { field: 'prompt_cache_hit_tokens', tokens: 3 }, { field: 'prompt_cache_miss_tokens', tokens: 7 },
        ], hitInputTokens: 3, missInputTokens: 7,
        creationInputTokens: null, uncachedInputTokens: null, providerInputIncludesCache: true, consistent: null,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial usage' }], stop_reason: 'end_turn',
    usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 4 },
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'partial usage' },
      { type: 'usage', input: null, output: 4, cache: {
        source: 'anthropic-messages', sourceFields: [
          { field: 'input_tokens', tokens: 12 }, { field: 'cache_read_input_tokens', tokens: 3 },
        ], hitInputTokens: 3, missInputTokens: null, creationInputTokens: null,
        uncachedInputTokens: 12, providerInputIncludesCache: false, consistent: null,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant', content: [{ type: 'text', text: 'uncached only' }], stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 4 },
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'uncached only' },
      { type: 'usage', input: null, output: 4, cache: {
        source: 'anthropic-messages', sourceFields: [{ field: 'input_tokens', tokens: 12 }],
        hitInputTokens: null, missInputTokens: null, creationInputTokens: null,
        uncachedInputTokens: 12, providerInputIncludesCache: false, consistent: null,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant', content: [{ type: 'text', text: 'zero usage' }], stop_reason: 'end_turn',
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  }, async (provider) => {
    const usage = (await collect(provider.stream({ system: '', tools: [], messages: [] }))).find((event) => event.type === 'usage') as UsageEvent;
    assert.equal(usage.input, 0, 'explicit zero component values produce a measured zero total');
    assert.equal(usage.output, 0);
  });

  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant', content: [{ type: 'text', text: 'overflow' }], stop_reason: 'end_turn',
    usage: { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 0 },
  }, async (provider) => {
    const usage = (await collect(provider.stream({ system: '', tools: [], messages: [] }))).find((event) => event.type === 'usage') as CachedUsage;
    assert.equal(usage.input, null, 'an unsafe sum must not be reported as an exact token count');
    assert.equal(usage.cache.uncachedInputTokens, Number.MAX_SAFE_INTEGER);
  });
});

test('both providers emit complete tool-only turns from non-streaming JSON', async () => {
  const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
  await withJsonEndpoint('chat', {
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_json', type: 'function', function: { name: 'read', arguments: '{"path":"note.txt"}' } }] },
      finish_reason: 'tool_calls',
    }],
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [tool], messages: [] })), [
      { type: 'tool-call', id: 'call_json', name: 'read', args: { path: 'note.txt' } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_json', name: 'read', input: { path: 'note.txt' } }],
    stop_reason: 'tool_use', usage: { input_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({ system: '', tools: [tool], messages: [] })), [
      { type: 'tool-call', id: 'toolu_json', name: 'read', args: { path: 'note.txt' } },
      { type: 'usage', input: 8, output: 2, cache: {
        source: 'anthropic-messages', sourceFields: [
          { field: 'input_tokens', tokens: 8 }, { field: 'cache_read_input_tokens', tokens: 0 },
          { field: 'cache_creation_input_tokens', tokens: 0 },
        ], hitInputTokens: 0, missInputTokens: null, creationInputTokens: 0,
        uncachedInputTokens: 8, providerInputIncludesCache: false, consistent: null,
      } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });
});

test('output exhaustion preserves partial text and does not parse incomplete tool arguments', async () => {
  await withJsonEndpoint('chat', {
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'partial', tool_calls: [{ id: 'call_partial', type: 'function', function: { name: 'read', arguments: '{"path":' } }] },
      finish_reason: 'length',
    }],
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({} as unknown as ModelRequest)), [
      { type: 'text', text: 'partial' },
      { type: 'finish', reason: 'length' },
    ]);
    await assert.rejects(createLoop({ kernel: createKernel(), provider }).run('question'), (error) => (error as ProviderFailure).code === 'provider_output_exhausted');
  });

  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'partial' }, { type: 'tool_use', id: 'toolu_partial', name: 'read', input: {} }],
    stop_reason: 'max_tokens', usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 },
  }, async (provider) => {
    assert.deepEqual(await collect(provider.stream({} as unknown as ModelRequest)), [
      { type: 'text', text: 'partial' },
      { type: 'usage', input: 2, output: 3, cache: {
        source: 'anthropic-messages', sourceFields: [
          { field: 'input_tokens', tokens: 2 }, { field: 'cache_read_input_tokens', tokens: 0 },
          { field: 'cache_creation_input_tokens', tokens: 0 },
        ], hitInputTokens: 0, missInputTokens: null, creationInputTokens: 0,
        uncachedInputTokens: 2, providerInputIncludesCache: false, consistent: null,
      } },
      { type: 'finish', reason: 'max_tokens' },
    ]);
    await assert.rejects(createLoop({ kernel: createKernel(), provider }).run('question'), (error) => (error as ProviderFailure).code === 'provider_output_exhausted');
  });
});

test('non-streaming malformed JSON and invalid tool arguments use safe stable errors', async () => {
  await withJsonEndpoint('chat', {
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'read', arguments: '{"secret":"private' } }] },
      finish_reason: 'tool_calls',
    }],
  }, async (provider) => {
    await assert.rejects(collect(provider.stream({} as unknown as ModelRequest)), (error) => {
      const failure = error as ProviderFailure;
      return failure.code === 'provider_tool_args_invalid' && failure.cause === undefined && !String(failure.detail).includes('private');
    });
  });

  await withJsonEndpoint('chat', '{"choices":', async (provider) => {
    await assert.rejects(collect(provider.stream({} as unknown as ModelRequest)), (error) => {
      const failure = error as ProviderFailure;
      return failure.code === 'provider_stream_invalid' && failure.cause === undefined && !String(failure.detail).includes('choices');
    });
  }, 'application/json');
  await withJsonEndpoint('messages', '{"stop_reason":"truncated-secret', async (provider) => {
    await assert.rejects(collect(provider.stream({} as unknown as ModelRequest)), (error) => {
      const failure = error as ProviderFailure;
      return failure.code === 'provider_stream_invalid' && failure.cause === undefined && !String(failure.detail).includes('truncated-secret');
    });
  }, 'application/json');
});

test('non-streaming JSON response body interruption has a safe transport classification', async () => {
  for (const api of ['chat', 'messages'] as const) {
    await withJsonEndpoint(api, (_request, _count, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '512' });
      response.write('{"partial":"private response text');
      response.flushHeaders();
      setTimeout(() => (response.socket as Socket).destroy(), 20);
      return undefined;
    }, async (provider) => {
      await assert.rejects(collect(provider.stream({} as unknown as ModelRequest)), (error) => {
        const failure = error as ProviderFailure;
        return failure.code === 'provider_stream_interrupted' && failure.cause === undefined
          && !String(failure.detail).includes('private response text') && !String((error as Error).message).includes('private response text');
      });
    });
  }
});

test('abort while reading a non-streaming JSON body maps to provider_cancelled', async () => {
  for (const api of ['chat', 'messages'] as const) {
    await withJsonEndpoint(api, (_request, _count, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"partial":');
      response.flushHeaders();
      return undefined;
    }, async (provider, requests) => {
      const controller = new AbortController();
      const iterator = provider.stream({} as unknown as ModelRequest, { signal: controller.signal });
      const pending = iterator.next();
      while (requests.length === 0) await delay(1);
      await delay(20);
      controller.abort();
      await assert.rejects(pending, (error) => {
        const failure = error as ProviderFailure;
        return failure.code === 'provider_cancelled' && failure.cause === undefined;
      });
      await iterator.return(undefined);
    });
  }
});

test('empty completed JSON responses fail in the Loop instead of completing the turn', async () => {
  await withJsonEndpoint('chat', {
    choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
  }, async (provider) => {
    await assert.rejects(createLoop({ kernel: createKernel(), provider }).run('question'), (error) => (error as ProviderFailure).code === 'provider_empty_response');
  });
  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: {},
  }, async (provider) => {
    await assert.rejects(createLoop({ kernel: createKernel(), provider }).run('question'), (error) => (error as ProviderFailure).code === 'provider_empty_response');
  });
  await withJsonEndpoint('chat', {
    choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: 'thinking only' }, finish_reason: 'stop' }],
  }, async (provider) => {
    await assert.rejects(createLoop({ kernel: createKernel(), provider }).run('question'), (error) => (error as ProviderFailure).code === 'provider_empty_response');
  });
  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking only' }], stop_reason: 'end_turn', usage: {},
  }, async (provider) => {
    await assert.rejects(createLoop({ kernel: createKernel(), provider }).run('question'), (error) => (error as ProviderFailure).code === 'provider_empty_response');
  });
});

test('JSON tool calls with schema-invalid inputs are rejected by Kernel before execution', async () => {
  for (const api of ['chat', 'messages'] as const) {
    let effects = 0;
    const kernel = createKernel();
    kernel.register({
      name: 'schema_tool',
      description: 'Requires a path',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run() { effects += 1; return { text: 'unexpected side effect' }; },
    });
    const first = api === 'chat'
      ? { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_schema_valid', type: 'function', function: { name: 'schema_tool', arguments: '{"path":"safe"}' } },
        { id: 'call_schema_invalid', type: 'function', function: { name: 'schema_tool', arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }] }
      : { type: 'message', role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_schema_valid', name: 'schema_tool', input: { path: 'safe' } },
        { type: 'tool_use', id: 'toolu_schema_invalid', name: 'schema_tool', input: 'not an object' },
      ], stop_reason: 'tool_use' };
    const second = api === 'chat'
      ? { choices: [{ index: 0, message: { role: 'assistant', content: 'The invalid call was safely rejected.' }, finish_reason: 'stop' }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'The invalid call was safely rejected.' }], stop_reason: 'end_turn' };
    await withJsonEndpoint(api, (_request, count) => count === 1 ? first : second, async (provider, requests) => {
      const result = await createLoop({ kernel, provider }).run('try the schema tool');
      assert.equal(result.text, 'The invalid call was safely rejected.');
      assert.equal(requests.length, 2);
      assert.equal(effects, 0);
    });
  }
});

test('a later duplicate identity or invalid JSON argument dispatches no earlier valid tool', async () => {
  const batches: { api: JsonApi; code: string; body: Record<string, unknown> }[] = [
    {
      api: 'chat',
      code: 'provider_tool_call_invalid',
      body: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
        { id: 'duplicate', type: 'function', function: { name: 'schema_tool', arguments: '{"path":"safe"}' } },
        { id: 'duplicate', type: 'function', function: { name: 'schema_tool', arguments: '{"path":"safe"}' } },
      ] }, finish_reason: 'tool_calls' }] },
    },
    {
      api: 'chat',
      code: 'provider_tool_args_invalid',
      body: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_valid', type: 'function', function: { name: 'schema_tool', arguments: '{"path":"safe"}' } },
        { id: 'call_invalid', type: 'function', function: { name: 'schema_tool', arguments: '{"path":' } },
      ] }, finish_reason: 'tool_calls' }] },
    },
    {
      api: 'messages',
      code: 'provider_tool_call_invalid',
      body: { type: 'message', role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_duplicate', name: 'schema_tool', input: { path: 'safe' } },
        { type: 'tool_use', id: 'toolu_duplicate', name: 'schema_tool', input: { path: 'safe' } },
      ], stop_reason: 'tool_use' },
    },
  ];
  for (const { api, code, body } of batches) {
    let effects = 0;
    const kernel = createKernel();
    kernel.register({
      name: 'schema_tool', description: 'Requires a path',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run() { effects += 1; return { text: 'side effect' }; },
    });
    await withJsonEndpoint(api, body, async (provider, requests) => {
      await assert.rejects(createLoop({ kernel, provider }).run('call tools'), (error) => (error as ProviderFailure).code === code);
      assert.equal(requests.length, 1);
      assert.equal(effects, 0);
    });
  }
});

test('non-streaming responses require a finish reason and valid tool identity', async () => {
  await withJsonEndpoint('chat', {
    choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: null }],
  }, async (provider) => {
    const events: ProviderEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of provider.stream({} as unknown as ModelRequest)) events.push(event);
    }, (error) => (error as ProviderFailure).code === 'provider_stream_incomplete');
    assert.deepEqual(events, [{ type: 'text', text: 'partial' }]);
  });
  await withJsonEndpoint('chat', {
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
  }, async (provider) => {
    await assert.rejects(collect(provider.stream({} as unknown as ModelRequest)), (error) => (error as ProviderFailure).code === 'provider_tool_call_invalid');
  });
  await withJsonEndpoint('messages', {
    type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'read', input: {} }], stop_reason: 'tool_use',
  }, async (provider) => {
    await assert.rejects(collect(provider.stream({} as unknown as ModelRequest)), (error) => (error as ProviderFailure).code === 'provider_tool_call_invalid');
  });
});
