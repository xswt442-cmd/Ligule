import { createServer } from 'node:http';
import type { Server } from 'node:http';

export const MOCK_CREDENTIAL = 'ligule-benchmark-fixture-key';

export type MockMessagesProvider = {
  baseUrl: string;
  firstRequestAt: () => number | undefined;
  requestCount: () => number;
  reset: () => void;
  close: () => Promise<void>;
};

export async function startMockMessagesProvider(): Promise<MockMessagesProvider> {
  let firstRequestAt: number | undefined;
  let requestCount = 0;
  const server: Server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages' || request.headers['x-api-key'] !== MOCK_CREDENTIAL) {
      response.writeHead(404).end();
      return;
    }
    for await (const _chunk of request) void _chunk;
    requestCount += 1;
    firstRequestAt ??= performance.now();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'benchmark-message', type: 'message', role: 'assistant', model: 'benchmark-model',
      content: [{ type: 'text', text: 'benchmark complete' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('benchmark_provider_address_missing');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    firstRequestAt: () => firstRequestAt,
    requestCount: () => requestCount,
    reset() {
      firstRequestAt = undefined;
      requestCount = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
