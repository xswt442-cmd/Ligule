import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createChatCompletionsProvider } from '../dist/model/chat-completions.js';
import { createMessagesProvider } from '../dist/model/messages.js';
import type { ProviderEvent } from '../dist/kernel/loop.js';
import { listenFetchable } from './helpers/port.ts';

type ProviderFrame = { type: string; [key: string]: unknown };

async function responseEvents(api: 'chat' | 'messages', frames: readonly unknown[]): Promise<ProviderEvent[]> {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { /* consume the actual request */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''));
  });
  const port = await listenFetchable(server);
  const keyName = 'LIGULE_TERMINATION_TEST_KEY';
  const previous = process.env[keyName];
  process.env[keyName] = 'synthetic-termination-key';
  try {
    const create = api === 'messages' ? createMessagesProvider : createChatCompletionsProvider;
    const provider = create({ baseUrl: `http://127.0.0.1:${port}`, model: 'test-model', apiKeyEnv: keyName });
    const result: ProviderEvent[] = [];
    for await (const event of provider.stream({ system: '', tools: [], messages: [] })) result.push(event);
    return result;
  } finally {
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function messages(tool: Record<string, unknown>, reason = 'tool_use'): ProviderFrame[] {
  return [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', ...tool } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason } },
    { type: 'message_stop' },
  ];
}

test('Messages accepts complete input on content_block_start without losing arguments', async () => {
  const events = await responseEvents('messages', messages({ id: 'call_1', name: 'read', input: { path: 'note.txt' } }));
  assert.deepEqual(events.find((event): event is Extract<ProviderEvent, { type: 'tool-call' }> => event.type === 'tool-call')?.args, { path: 'note.txt' });
});

test('missing and empty Messages call identity has a stable safe diagnosis', async () => {
  for (const tool of [{ name: 'read' }, { id: 'call_1' }, { id: '', name: 'read' }]) {
    await assert.rejects(responseEvents('messages', messages(tool)), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'provider_tool_call_invalid');
  }
});

test('Chat rejects an empty or duplicated tool-call identity before dispatch', async () => {
  for (const ids of [[''], ['duplicate', 'duplicate']]) {
    const tool_calls = ids.map((id, index) => ({ index, id, function: { name: 'read', arguments: '{}' } }));
    await assert.rejects(responseEvents('chat', [
      { choices: [{ delta: { tool_calls }, finish_reason: 'tool_calls' }] }, '[DONE]',
    ]), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'provider_tool_call_invalid');
  }
});

test('Messages max_tokens takes precedence over a truncated JSON argument', async () => {
  const frames = messages({ id: 'call_1', name: 'read' }, 'max_tokens');
  frames.splice(2, 0, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } });
  const events = await responseEvents('messages', frames);
  assert.deepEqual(events, [{ type: 'finish', reason: 'max_tokens' }]);
});

test('Provider data after a terminal marker cannot introduce additional output', async () => {
  await assert.rejects(responseEvents('chat', [
    { choices: [{ delta: { content: 'first' }, finish_reason: 'stop' }] }, '[DONE]',
    { choices: [{ delta: { content: 'extra' }, finish_reason: 'stop' }] },
  ]), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'provider_stream_invalid');
  await assert.rejects(responseEvents('messages', [
    { type: 'message_start', message: { usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'extra' } },
    { type: 'content_block_stop', index: 0 },
  ]), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'provider_stream_invalid');
});
