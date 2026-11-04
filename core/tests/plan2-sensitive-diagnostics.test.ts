import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createChatCompletionsProvider, DEFAULT_RETRY } from '../dist/index.js';
import { listenFetchable } from './helpers/port.ts';

const ARGUMENT_SENTINEL = 'synthetic-tool-argument-sentinel-not-a-credential';
const API_KEY_ENV = `LIGULE_PLAN2_DIAGNOSTIC_${randomUUID().replaceAll('-', '')}`;
const RETRY = { ...DEFAULT_RETRY, maxAttempts: 1, baseDelayMs: 1 };

async function withEndpoint(run: (baseUrl: string) => Promise<void>) {
  const server = createServer((_request, response) => {
    const argumentsText = JSON.stringify({ path: 'note.txt', marker: ARGUMENT_SENTINEL })
      .replace(ARGUMENT_SENTINEL, `${ARGUMENT_SENTINEL}" broken`);
    const payload = {
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-synthetic',
            type: 'function',
            function: { name: 'read', arguments: argumentsText },
          }],
        },
      }],
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
  });
  const baseUrl = `http://127.0.0.1:${await listenFetchable(server)}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function collect(stream: AsyncIterable<unknown>) {
  for await (const _event of stream) {
    // The malformed tool call is reported after the provider has assembled the response.
  }
}

test('malformed tool arguments do not enter provider diagnostics', async () => {
  process.env[API_KEY_ENV] = 'synthetic-api-key-not-a-credential';
  try {
    await withEndpoint(async (baseUrl) => {
      const provider = createChatCompletionsProvider({
        baseUrl,
        model: 'synthetic-model',
        apiKeyEnv: API_KEY_ENV,
        retry: RETRY,
      });

      await assert.rejects(
        collect(provider.stream({ system: '', tools: [], messages: [] })),
        (error: unknown) => {
          const failure = error as { code?: string; message?: string; detail?: unknown; cause?: { message?: string }; stack?: string };
          assert.equal(failure.code, 'provider_tool_args_invalid');
          const diagnostic = [failure.message, failure.detail, failure.cause?.message, failure.stack].join('\n');
          assert.equal(
            diagnostic.includes(ARGUMENT_SENTINEL),
            false,
            'provider diagnostics must not include the synthetic raw tool argument',
          );
          return true;
        },
      );
    });
  } finally {
    delete process.env[API_KEY_ENV];
  }
});
