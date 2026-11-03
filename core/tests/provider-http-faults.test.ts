import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createMessagesProvider, DEFAULT_RETRY } from '../dist/index.js';
import type { RetryPolicy } from '../dist/model/http.js';
import type { ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import { listenFetchable } from './helpers/port.ts';

const API_KEY_ENV = 'LIGULE_HTTP_FAULT_TEST_KEY';
const FAST_RETRY = { ...DEFAULT_RETRY, baseDelayMs: 1 };

type ProviderFailure = { code?: string; detail: string; diagnostics?: unknown };

type ObservedRequest = {
  method: string | undefined;
  url: string | undefined;
  responseClosed: Promise<unknown>;
  responseFinished: boolean;
};

function provider(baseUrl: string, retry: RetryPolicy = FAST_RETRY) {
  return createMessagesProvider({ baseUrl, model: 'http-fault-test', apiKeyEnv: API_KEY_ENV, retry });
}

function diagnostic(error: unknown, expected: unknown) {
  const failure = error as ProviderFailure;
  assert.deepEqual(failure.diagnostics, expected);
  assert.equal(JSON.stringify(failure.diagnostics).includes('synthetic-http-fault-key'), false);
}

function categoryForStatus(status: number) {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'http';
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function withEndpoint(
  respond: (attempt: number, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string, requests: ObservedRequest[]) => void | Promise<void>,
): Promise<void> {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the real request body */ }
    const record = {
      method: request.method,
      url: request.url,
      responseClosed: new Promise((resolve) => response.once('close', resolve)),
      responseFinished: false,
    };
    response.once('finish', () => { record.responseFinished = true; });
    requests.push(record);
    await respond(requests.length, response);
  });
  const baseUrl = `http://127.0.0.1:${await listenFetchable(server)}`;
  process.env[API_KEY_ENV] = 'synthetic-http-fault-key';
  try {
    await run(baseUrl, requests);
  } finally {
    delete process.env[API_KEY_ENV];
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function okEmpty(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
}

test('real HTTP 429 and 500/503 responses retry only until success or configured exhaustion', async () => {
  for (const status of [429, 500, 503]) {
    await withEndpoint((attempt, response) => {
      if (attempt < 3) {
        response.writeHead(status, { 'content-type': 'text/plain' });
        response.end('controlled local upstream failure');
      } else okEmpty(response);
    }, async (baseUrl, requests) => {
      assert.deepEqual(await collect(provider(baseUrl).stream({} as unknown as ModelRequest)), [{ type: 'finish', reason: 'stop' }]);
      assert.equal(requests.length, 3, `${status} then success has three actual requests`);
    });

    await withEndpoint((_attempt, response) => {
      response.writeHead(status);
      response.end('controlled local upstream failure');
    }, async (baseUrl, requests) => {
      await assert.rejects(
        () => collect(provider(baseUrl, { ...FAST_RETRY, maxAttempts: 2 }).stream({} as unknown as ModelRequest)),
        (error) => {
          const failure = error as ProviderFailure;
          assert.equal(failure.code, 'provider_http_error');
          assert.equal(failure.detail.startsWith(`HTTP ${status}`), true);
          diagnostic(error, {
            category: categoryForStatus(status), status, attempts: 2,
            responseReceived: true, streamReceived: false, recoverable: true,
          });
          return true;
        },
      );
      assert.equal(requests.length, 2, `${status} exhaustion respects maxAttempts`);
    });
  }
});

test('permanent 400, 401, and 403 responses fail without another HTTP request', async () => {
  for (const status of [400, 401, 403]) {
    await withEndpoint((_attempt, response) => {
      response.writeHead(status);
      response.end('permanent local rejection');
    }, async (baseUrl, requests) => {
      await assert.rejects(
        () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
        (error) => {
          const failure = error as ProviderFailure;
          assert.equal(failure.code, 'provider_http_error');
          assert.equal(failure.detail.startsWith(`HTTP ${status}`), true);
          diagnostic(error, {
            category: categoryForStatus(status), status, attempts: 1,
            responseReceived: true, streamReceived: status === 400, recoverable: false,
          });
          return true;
        },
      );
      assert.equal(requests.length, 1, `${status} is not retried`);
    });
  }
});

test('disabled 429, 5xx, and transport retry categories fail after one real request', async () => {
  for (const [status, retry] of [
    [429, { ...FAST_RETRY, retry429: false }],
    [503, { ...FAST_RETRY, retry5xx: false }],
  ] as const) {
    await withEndpoint((_attempt, response) => {
      response.writeHead(status);
      response.end('retry category disabled');
    }, async (baseUrl, requests) => {
      await assert.rejects(
        () => collect(provider(baseUrl, retry).stream({} as unknown as ModelRequest)),
        (error) => {
          const failure = error as ProviderFailure;
          assert.equal(failure.code, 'provider_http_error');
          assert.equal(failure.detail.startsWith(`HTTP ${status}`), true);
          diagnostic(error, {
            category: categoryForStatus(status), status, attempts: 1,
            responseReceived: true, streamReceived: false, recoverable: false,
          });
          return true;
        },
      );
      assert.equal(requests.length, 1, `${status} retry disabled means one request`);
    });
  }

  await withEndpoint((_attempt, response) => {
    (response.socket as Socket).destroy();
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl, { ...FAST_RETRY, retryTransport: false }).stream({} as unknown as ModelRequest)),
      (error) => {
        const failure = error as ProviderFailure;
        assert.equal(failure.code, 'provider_transport_failed');
        diagnostic(error, {
          category: 'transport', attempts: 1,
          responseReceived: false, streamReceived: false, recoverable: false,
        });
        return true;
      },
    );
    assert.equal(requests.length, 1, 'transport retry disabled means one request');
  });
});

test('connection refusal and socket close before response headers use bounded transport retries', async () => {
  const server = createServer();
  const port = await listenFetchable(server);
  await new Promise((resolve) => server.close(resolve));
  const refusedUrl = `http://127.0.0.1:${port}`;
  process.env[API_KEY_ENV] = 'synthetic-http-fault-key';
  try {
    await assert.rejects(
      () => collect(provider(refusedUrl, { ...FAST_RETRY, maxAttempts: 2 }).stream({} as unknown as ModelRequest)),
      (error) => {
        const failure = error as ProviderFailure;
        assert.equal(failure.code, 'provider_transport_failed');
        diagnostic(error, {
          category: 'transport', attempts: 2,
          responseReceived: false, streamReceived: false, recoverable: true,
        });
        return true;
      },
    );
  } finally {
    delete process.env[API_KEY_ENV];
  }

  await withEndpoint((_attempt, response) => {
    (response.socket as Socket).destroy();
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl, { ...FAST_RETRY, maxAttempts: 2 }).stream({} as unknown as ModelRequest)),
      (error) => {
        const failure = error as ProviderFailure;
        assert.equal(failure.code, 'provider_transport_failed');
        diagnostic(error, {
          category: 'transport', attempts: 2,
          responseReceived: false, streamReceived: false, recoverable: true,
        });
        return true;
      },
    );
    assert.equal(requests.length, 2, 'pre-header socket closes are retried only to the configured bound');
  });

  await withEndpoint((attempt, response) => {
    if (attempt === 1) {
      response.writeHead(503);
      response.end();
    } else (response.socket as Socket).destroy();
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl, { ...FAST_RETRY, maxAttempts: 2 }).stream({} as unknown as ModelRequest)),
      (error) => {
        const failure = error as ProviderFailure;
        assert.equal(failure.code, 'provider_transport_failed');
        diagnostic(error, {
          category: 'transport', attempts: 2,
          responseReceived: true, streamReceived: false, recoverable: true,
        });
        return true;
      },
    );
    assert.equal(requests.length, 2, 'diagnostics retain an earlier HTTP response when the final retry has no headers');
  });
});

test('abort before response headers is reported as cancellation rather than transport failure', async () => {
  await withEndpoint(() => {}, async (baseUrl, requests) => {
    const controller = new AbortController();
    const pending = collect(provider(baseUrl).stream({} as unknown as ModelRequest, { signal: controller.signal }));
    while (requests.length === 0) await delay(1);
    controller.abort();
    await assert.rejects(pending, (error) => {
      const failure = error as ProviderFailure;
      assert.equal(failure.code, 'provider_cancelled');
      diagnostic(error, {
        category: 'cancelled', attempts: 1,
        responseReceived: false, streamReceived: false, recoverable: false,
      });
      return true;
    });
    assert.equal(requests.length, 1);
  });
});

test('an AbortSignal timeout is reported as a transport timeout, not user cancellation', async () => {
  await withEndpoint(() => {}, async (baseUrl, requests) => {
    // Let the loopback request reach the local server before timing out under test load.
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest, { signal: AbortSignal.timeout(250) })),
      (error) => {
        const failure = error as ProviderFailure;
        assert.equal(failure.code, 'provider_timeout');
        diagnostic(error, {
          category: 'transport', attempts: 1,
          responseReceived: false, streamReceived: false, recoverable: false,
        });
        return true;
      },
    );
    assert.equal(requests.length, 1);
  });
});

test('once SSE has delivered content, a socket interruption never replays the HTTP request', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
    response.flushHeaders();
    setTimeout(() => (response.socket as Socket).destroy(), 20);
  }, async (baseUrl, requests) => {
    const seen: ProviderEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of provider(baseUrl).stream({} as unknown as ModelRequest)) seen.push(event);
    }, (error) => {
      const failure = error as ProviderFailure;
      assert.equal(failure.code, 'provider_stream_interrupted');
      diagnostic(error, {
        category: 'stream', status: 200, attempts: 1,
        responseReceived: true, streamReceived: true, recoverable: false,
      });
      return true;
    });
    assert.deepEqual(seen, [{ type: 'text', text: 'partial' }]);
    assert.equal(requests.length, 1, 'an interrupted stream is not automatically replayed');
  });
});

test('an SSE partial frame at EOF fails and does not trigger a new request', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start"');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => (error as ProviderFailure).code === 'provider_stream_incomplete',
    );
    assert.equal(requests.length, 1);
  });
});

test('a clean HTTP EOF without the provider stop event is not a successful turn', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\n');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => (error as ProviderFailure).code === 'provider_stream_incomplete',
    );
    assert.equal(requests.length, 1, 'a malformed successful-status stream is not retried');
  });
});

test('an HTTP success without a response body is classified as an invalid response', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(204);
    response.end();
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({} as unknown as ModelRequest)),
      (error) => {
        const failure = error as ProviderFailure;
        assert.equal(failure.code, 'provider_stream_missing');
        diagnostic(error, {
          category: 'invalid_response', status: 204, attempts: 1,
          responseReceived: true, streamReceived: false, recoverable: false,
        });
        return true;
      },
    );
    assert.equal(requests.length, 1);
  });
});

test('abort during retry backoff returns promptly without an extra request', async (t) => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(503);
    response.write('retry later');
  }, async (baseUrl, requests) => {
    const controller = new AbortController();
    const started = performance.now();
    const pending = collect(provider(baseUrl, { ...FAST_RETRY, baseDelayMs: 10_000 }).stream({} as unknown as ModelRequest, { signal: controller.signal }));
    while (requests.length === 0) await delay(1);
    await requests[0].responseClosed;
    assert.equal(requests[0].responseFinished, false, 'the client canceled the HTTP response body');
    controller.abort();
    await assert.rejects(pending, (error) => {
      const failure = error as ProviderFailure;
      assert.equal(failure.code, 'provider_cancelled');
      diagnostic(error, {
        category: 'cancelled', status: 503, attempts: 1,
        responseReceived: true, streamReceived: false, recoverable: false,
      });
      return true;
    });
    const elapsedMs = performance.now() - started;
    assert.equal(requests.length, 1, 'backoff cancellation prevents the next attempt');
    assert.ok(elapsedMs < 1_000, `cancelled backoff took ${elapsedMs.toFixed(1)}ms`);
    t.diagnostic(`actualRequests=${requests.length}; cancellationElapsedMs=${elapsedMs.toFixed(1)}; errorCode=provider_cancelled`);
  });
});

test('abort during an active SSE read closes the HTTP response without another request', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"started"}}\n\n');
    response.flushHeaders();
  }, async (baseUrl, requests) => {
    const controller = new AbortController();
    const iterator = provider(baseUrl).stream({} as unknown as ModelRequest, { signal: controller.signal });
    assert.deepEqual(await iterator.next(), { done: false, value: { type: 'text', text: 'started' } });
    controller.abort();
    await assert.rejects(() => iterator.next(), (error) => {
      const failure = error as ProviderFailure;
      assert.equal(failure.code, 'provider_cancelled');
      diagnostic(error, {
        category: 'cancelled', status: 200, attempts: 1,
        responseReceived: true, streamReceived: true, recoverable: false,
      });
      return true;
    });
    assert.equal(requests.length, 1, 'an active SSE cancellation never opens a second request');
    await Promise.race([
      requests[0].responseClosed,
      delay(1_000).then(() => { throw new Error('the cancelled HTTP response remained open'); }),
    ]);
  });
});
