import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { setImmediate } from 'node:timers';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  capabilitiesOf, createConfig, createKernel, createLoop, createMessagesProvider, createChatCompletionsProvider, createSessionLog,
  DEFAULT_RETRY, MESSAGES_CAPABILITIES, readTool,
} from '../dist/index.js';
import type { ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import { fetchablePort, listenFetchable } from './helpers/port.ts';

const API_KEY_ENV = 'LIGULE_TEST_API_KEY';
const FAST_RETRY = { ...DEFAULT_RETRY, baseDelayMs: 1 };

type ProviderOptions = NonNullable<Parameters<typeof createMessagesProvider>[0]>;

type ProviderFailure = { code?: string; detail?: string; cause?: unknown };

type WireBody = Record<string, unknown>;

type ObservedRequest = { url: string | undefined; headers: IncomingHttpHeaders; body: WireBody };

type SseEvent = {
  type: string;
  content_block?: { type?: string; [key: string]: unknown };
  delta?: { stop_reason?: string; [key: string]: unknown };
  [key: string]: unknown;
};

function sseBody(events: readonly SseEvent[]): string {
  const shaped = events.map((event) => ({ ...event }));
  const stopIndex = shaped.findIndex((event) => event.type === 'message_stop');
  if (stopIndex >= 0) {
    const reason = shaped.some((event) => event.content_block?.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const delta = shaped.find((event) => event.type === 'message_delta');
    if (delta) delta.delta = { ...delta.delta, stop_reason: delta.delta?.stop_reason ?? reason };
    else shaped.splice(stopIndex, 0, { type: 'message_delta', delta: { stop_reason: reason } });
  }
  return shaped.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const EMPTY_TURN = [{ type: 'message_start', message: { usage: {} } }, { type: 'message_stop' }];

// 一次真实的 HTTP 往返：本地起一个服务按 SSE 写出去，客户端走的是它平时走的那条解析路径。
async function withEndpoint<TResult>(
  respond: (attempt: number, response: ServerResponse, request: ObservedRequest) => void | Promise<void>,
  run: (baseUrl: string, requests: ObservedRequest[]) => TResult | Promise<TResult>,
): Promise<TResult> {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text === '' ? undefined : JSON.parse(text);
    const observed = { url: request.url, headers: request.headers, body } as unknown as ObservedRequest;
    requests.push(observed);
    await respond(requests.length, response, observed);
  });
  const baseUrl = `http://127.0.0.1:${await listenFetchable(server)}`;
  process.env[API_KEY_ENV] = 'test-key';
  try {
    return await run(baseUrl, requests);
  } finally {
    delete process.env[API_KEY_ENV];
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function provider(baseUrl: string, extra: ProviderOptions = {}) {
  return createMessagesProvider({ baseUrl, model: 'test-model', apiKeyEnv: API_KEY_ENV, retry: FAST_RETRY, ...extra });
}

function chatProvider(baseUrl: string, extra: ProviderOptions = {}) {
  return createChatCompletionsProvider({ baseUrl: `${baseUrl}/v1`, model: 'test-model', apiKeyEnv: API_KEY_ENV, retry: FAST_RETRY, ...extra });
}

function chatSse(frames: readonly unknown[], done = true): string {
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}${done ? 'data: [DONE]\n\n' : ''}`;
}

test('a tool call is assembled while the stream is still arriving', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'let me ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path": "no' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'te.txt"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = sseBody(turn);
    // 按 7 个字节一段写出去，切点落在 JSON 中间：拼装必须在接收期间做，不能等整帧到齐。
    for (let index = 0; index < body.length; index += 7) {
      response.write(body.slice(index, index + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  }, async (baseUrl, requests) => {
    const events = await collect(provider(baseUrl).stream({
      system: 'be brief',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'user', text: 'question' }],
    }));
    assert.deepEqual(events, [
      { type: 'text', text: 'let me ' },
      { type: 'text', text: 'look' },
      { type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/messages');
    assert.equal(requests[0].headers['x-api-key'], 'test-key');
    assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(requests[0].body, {
      model: 'test-model',
      max_tokens: MESSAGES_CAPABILITIES.maxOutputTokens,
      stream: true,
      system: 'be brief',
      messages: [{ role: 'user', content: 'question' }],
      tools: [{
        name: 'read',
        description: 'read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    });
  });
});

// 推理内容作为 `reasoning` 事件与答案分开传递，签名信息不会向外暴露。
test('a reasoning block becomes reasoning events while the answer stays separate', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the file is one line' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'reading it' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })), [
      { type: 'reasoning', text: 'the file is one line' },
      { type: 'text', text: 'reading it' },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

// 签名只会跟在推理块上；落在别的内容块上说明这一份流不是我们以为的那个形状。
test('a signature delta on another kind of block is reported as a broken stream', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    await assert.rejects(
      collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })),
      (error) => {
        const failure = error as ProviderFailure;
        return failure.code === 'provider_stream_invalid' && /signature/.test(String(failure.detail));
      },
    );
  });
});

// 「见过并且不要」与「没见过」是两件事：类型认不出来的仍然当场报出去，不悄悄收下。
test('a content block type nobody named is still refused', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'audio', audio: {} } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    await assert.rejects(
      collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })),
      (error) => {
        const failure = error as ProviderFailure;
        return failure.code === 'provider_content_unsupported' && failure.detail === 'unsupported content block type';
      },
    );
  });
});

test('a rebuilt session reaches the wire as assistant turns and merged tool results', async () => {
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(EMPTY_TURN));
  }, async (baseUrl, requests) => {
    // 服务地址已经带 /v1 时不重复补一段。
    await collect(provider(`${baseUrl}/v1`, { capabilities: { maxOutputTokens: 100 } }).stream({
      system: '',
      tools: [],
      messages: [
        { role: 'user', text: 'question' },
        { role: 'assistant', text: 'reading', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
        { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'body' }, failed: false },
        { role: 'tool', id: 'call_2', tool: 'read', content: '', failed: true, code: 'path_not_found' },
      ],
    }));
    assert.equal(requests[0].url, '/v1/messages');
    assert.equal(requests[0].body.max_tokens, 100, '配置只能把上限调低，调低之后请求体跟着变');
    assert.deepEqual(requests[0].body.messages, [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'note.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"text":"body"}', is_error: false },
          { type: 'tool_result', tool_use_id: 'call_2', content: '', is_error: true },
        ],
      },
    ]);
  });
});

test('configuration can lower a declared capability but never raise it', () => {
  assert.deepEqual(capabilitiesOf({ parallelToolCalls: true, maxOutputTokens: 999_999 }), {
    streaming: true,
    parallelToolCalls: false,
    maxOutputTokens: MESSAGES_CAPABILITIES.maxOutputTokens,
  });
  assert.equal(capabilitiesOf({ streaming: false }).streaming, false);
  assert.deepEqual(capabilitiesOf(), MESSAGES_CAPABILITIES);
  assert.throws(() => capabilitiesOf({ thinking: true }), (error) => (error as ProviderFailure).code === 'provider_capability_unknown');
  assert.throws(() => capabilitiesOf({ maxOutputTokens: '8192' }), (error) => (error as ProviderFailure).code === 'provider_capability_invalid');
});

test('a retryable status is retried up to the boundary and a non-retryable one is not retried', async () => {
  await withEndpoint(async (attempt, response) => {
    if (attempt < 3) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('upstream is busy');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(EMPTY_TURN));
  }, async (baseUrl, requests) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({} as unknown as ModelRequest)), [{ type: 'finish', reason: 'stop' }]);
    assert.equal(requests.length, 3);
  });

  await withEndpoint(async (attempt, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('upstream is busy');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl, { retry: { ...FAST_RETRY, maxAttempts: 2 } }).stream({} as unknown as ModelRequest)),
      (error) => {
        const failure = error as ProviderFailure;
        return failure.code === 'provider_http_error' && failure.detail === 'HTTP 503';
      },
    );
    assert.equal(requests.length, 2, '尝试次数不超过定下的边界');
  });

  await withEndpoint(async (attempt, response) => {
    response.writeHead(400, { 'content-type': 'text/plain' });
    response.end('bad request');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => (error as ProviderFailure).code === 'provider_http_error',
    );
    assert.equal(requests.length, 1, 'a 400 is never retried');
  });
});

test('a tool call whose arguments are not valid JSON reports a stable code', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => {
        const failure = error as ProviderFailure;
        return failure.code === 'provider_tool_args_invalid' && failure.detail !== '{"path":' && failure.cause === undefined;
      },
    );
  });
});

test('Messages completion reason is explicit and output exhaustion is distinct', async () => {
  const makeTurn = (reason: string) => [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(makeTurn('end_turn')));
  }, async (baseUrl) => {
    assert.deepEqual((await collect(provider(baseUrl).stream({} as unknown as ModelRequest))).at(-1), { type: 'finish', reason: 'stop' });
  });
  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(makeTurn('max_tokens')));
  }, async (baseUrl) => {
    assert.deepEqual((await collect(provider(baseUrl).stream({} as unknown as ModelRequest))).at(-1), { type: 'finish', reason: 'max_tokens' });
  });
});

test('Chat Completions exposes protocol completion and lets length override partial tool JSON', async () => {
  const normal = [
    { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chatSse(normal));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(chatProvider(baseUrl).stream({} as unknown as ModelRequest)), [
      { type: 'text', text: 'answer' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  const exhausted = [
    { choices: [{ index: 0, delta: { content: 'partial', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  ];
  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chatSse(exhausted));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(chatProvider(baseUrl).stream({} as unknown as ModelRequest)), [
      { type: 'text', text: 'partial' },
      { type: 'finish', reason: 'length' },
    ]);
  });
});

test('Chat Completions requires its DONE terminator', async () => {
  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chatSse([{ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }] }], false));
  }, async (baseUrl) => {
    await assert.rejects(
      () => collect(chatProvider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => (error as ProviderFailure).code === 'provider_stream_incomplete',
    );
  });
});

test('an unsupported block type and a stream that starts late both report a stable code', async () => {
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'image' } },
    ]));
  }, async (baseUrl) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => (error as ProviderFailure).code === 'provider_content_unsupported',
    );
  });

  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([{ type: 'content_block_start', index: 0, content_block: { type: 'text' } }]));
  }, async (baseUrl) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => (error as ProviderFailure).code === 'provider_stream_invalid',
    );
  });
});

test('a stream that ends inside a frame is reported instead of dropped', async () => {
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // 最后一帧没有空行收尾：里面是一次没交出去的工具调用。
    response.write(sseBody([{ type: 'message_start', message: { usage: {} } }]));
    response.end('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"read"}}\n');
  }, async (baseUrl) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => (error as ProviderFailure).code === 'provider_stream_incomplete',
    );
  });
});

test('an empty environment reference reports missing when its native store is available', async () => {
  const reference = `LIGULE_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  const previous = process.env[reference];
  delete process.env[reference];
  try {
    const events = collect(createMessagesProvider({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKeyEnv: reference }).stream({} as unknown as ModelRequest));
    await assert.rejects(() => events, (error) => {
      const failure = error as ProviderFailure;
      if (failure.code === 'provider_credential_missing') return failure.detail === reference;
      return process.env.LIGULE_CREDENTIAL_NATIVE_REQUIRED !== '1'
        && failure.code === 'credential_store_unavailable';
    });
  } finally {
    if (previous === undefined) delete process.env[reference];
    else process.env[reference] = previous;
  }
});

test('a projection with a call nobody answered is refused before the request goes out', async () => {
  process.env[API_KEY_ENV] = 'test-key';
  try {
    const events = collect(createMessagesProvider({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKeyEnv: API_KEY_ENV }).stream({
      messages: [{ role: 'assistant', text: '', toolCalls: [{ id: 'call_7', name: 'read', args: {} }] }],
    } as unknown as ModelRequest));
    await assert.rejects(
      () => events,
      (error) => {
        const failure = error as ProviderFailure;
        return failure.code === 'provider_unanswered_call' && failure.detail === 'read (call_7)';
      },
    );
  } finally {
    delete process.env[API_KEY_ENV];
  }
});

test('a service address that is not an HTTP(S) root, and a missing model, are refused at construction', () => {
  assert.throws(() => createMessagesProvider({ model: 'm' }), (error) => (error as ProviderFailure).code === 'provider_base_url_required');
  for (const baseUrl of [
    'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/?a=1', 'https://example.com/#frag', 'not a url',
  ]) {
    assert.throws(
      () => createMessagesProvider({ baseUrl, model: 'm' }),
      (error) => (error as ProviderFailure).code === 'provider_base_url_invalid',
      baseUrl,
    );
  }
  assert.throws(
    () => createMessagesProvider({ baseUrl: 'https://example.com' }),
    (error) => (error as ProviderFailure).code === 'provider_model_required',
  );
});

test('switching models is an explicit step that leaves the original provider alone', () => {
  const first = createMessagesProvider({ baseUrl: 'https://example.com', model: 'big', apiKeyEnv: API_KEY_ENV });
  const second = first.withModel('small');
  assert.equal(first.model, 'big');
  assert.equal(second.model, 'small');
  assert.deepEqual(second.capabilities, first.capabilities);
});

test('one real round trip: the second request body is what the record rebuilds into', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'provider-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'the body');
    const session = createSessionLog({ directory: root, id: 'round' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), session });
    kernel.register(readTool);
    const toolTurn = [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "note.txt"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];
    const textTurn = [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the file says so' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];
    // 答哪一轮看这一份请求里有没有工具结果，不看第几次连接：一次传输层的重试会让同一轮被问两次，
    // 按次数答的话测试断的是重试的次序，不是它本来要断的那件事。
    await withEndpoint(async (attempt, response, request) => {
      const answered = JSON.stringify(request.body?.messages ?? []).includes('tool_result');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sseBody(answered ? textTurn : toolTurn));
    }, async (baseUrl, requests) => {
      const result = await createLoop({ kernel, provider: provider(baseUrl), session }).run('read the note');
      assert.equal(result.text, 'the file says so');
      // 带着工具结果的那一份请求只该有一份：重试把同一轮发两遍时，这里会数到两份。
      const asked = requests.filter((entry) => JSON.stringify(entry.body.messages).includes('tool_result'));
      assert.equal(asked.length, 1, 'the tool round is sent once');
      assert.deepEqual(asked[0].body.messages, [
        { role: 'user', content: 'read the note' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'note.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"text":"the body"}', is_error: false }] },
      ]);
      // 请求体由会话记录投影生成；最后一条助手消息会在请求结束后写入记录。
      assert.deepEqual(await session.modelView(), [
        { role: 'user', text: 'read the note' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
        { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'the body' }, failed: false, code: undefined },
        { role: 'assistant', text: 'the file says so', toolCalls: [] },
      ]);
      assert.deepEqual(asked[0].body.tools, [{
        name: 'read',
        description: readTool.description,
        input_schema: readTool.parameters,
      }]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 端点报告的用量会作为 `usage` 事件传递，供上下文预算估算校准使用。
// 这一种形状把它拆在两处，输入的在 message_start（含缓存里读回来的那一段），输出的在 message_delta。
test('the usage the endpoint reports comes back as one event at the end', async () => {
  const turn = [
    { type: 'message_start', message: { usage: { input_tokens: 1200, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'hi' },
      { type: 'usage', input: 1500, output: 7, cache: {
        source: 'anthropic-messages', sourceFields: [
          { field: 'input_tokens', tokens: 1200 }, { field: 'cache_read_input_tokens', tokens: 300 },
          { field: 'cache_creation_input_tokens', tokens: 0 },
        ], hitInputTokens: 300, missInputTokens: null, creationInputTokens: 0,
        uncachedInputTokens: 1200, providerInputIncludesCache: false, consistent: null,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

test('streaming Chat Completions preserves cache field sources and missing totals', async () => {
  const frames = [
    { choices: [{ index: 0, delta: { content: 'cached' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } },
  ];
  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chatSse(frames));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(chatProvider(baseUrl).stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'cached' },
      { type: 'usage', input: 10, output: 2, cache: {
        source: 'chat-completions', sourceFields: [
          { field: 'prompt_tokens', tokens: 10 }, { field: 'prompt_cache_hit_tokens', tokens: 4 },
          { field: 'prompt_cache_miss_tokens', tokens: 6 },
        ], hitInputTokens: 4, missInputTokens: 6,
        creationInputTokens: null, uncachedInputTokens: null, providerInputIncludesCache: true, consistent: true,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chatSse([
      { choices: [{ index: 0, delta: { content: 'unknown total' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { completion_tokens: 2, prompt_cache_hit_tokens: 4 } },
    ]));
  }, async (baseUrl) => {
    const events = await collect(chatProvider(baseUrl).stream({ system: '', tools: [], messages: [] }));
    assert.deepEqual(events.find((event) => event.type === 'usage'), {
      type: 'usage', input: null, output: 2, cache: {
        source: 'chat-completions', sourceFields: [{ field: 'prompt_cache_hit_tokens', tokens: 4 }],
        hitInputTokens: 4, missInputTokens: null,
        creationInputTokens: null, uncachedInputTokens: null, providerInputIncludesCache: true, consistent: null,
      },
    });
  });

  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chatSse([
      { choices: [{ index: 0, delta: { content: 'generic cached' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
    ]));
  }, async (baseUrl) => {
    const events = await collect(chatProvider(baseUrl).stream({ system: '', tools: [], messages: [] }));
    assert.deepEqual(events.find((event) => event.type === 'usage'), {
      type: 'usage', input: 10, output: 2, cache: {
        source: 'chat-completions', sourceFields: [
          { field: 'prompt_tokens', tokens: 10 }, { field: 'prompt_tokens_details.cached_tokens', tokens: 4 },
        ], hitInputTokens: 4, missInputTokens: null, creationInputTokens: null,
        uncachedInputTokens: null, providerInputIncludesCache: true, consistent: null,
      },
    });
  });
});

test('streaming Messages keeps a missing input total unknown', async () => {
  const turn = [
    { type: 'message_start', message: { usage: { cache_read_input_tokens: 2 } } },
    { type: 'message_delta', usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })), [
      { type: 'usage', input: null, output: 3, cache: {
        source: 'anthropic-messages', sourceFields: [{ field: 'cache_read_input_tokens', tokens: 2 }],
        hitInputTokens: 2, missInputTokens: null,
        creationInputTokens: null, uncachedInputTokens: null, providerInputIncludesCache: false, consistent: null,
      } },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

// 端口辅助函数使用真实 HTTP 服务验证，返回的端口必须能被 fetch 访问。
test('the endpoint helper hands back a port that fetch really reaches', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  try {
    const port = await listenFetchable(server);
    const answer = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), 'ok');
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

// 验证 Node 当前不允许监听的端口和可监听端口，并确认 1024 以下端口不会被选择。
test('the refused-port table answers for the real predicate', () => {
  for (const port of [1719, 5060, 6000, 6665, 10080]) assert.equal(fetchablePort(port), false, `${port} 是 fetch 拒用的那一个`);
  assert.equal(fetchablePort(45123), true);
  assert.equal(fetchablePort(1023), false, '1024 以下这一份一个也不放');
});
