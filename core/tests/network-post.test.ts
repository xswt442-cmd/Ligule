import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { postJsonTarget, resolveTarget } from '../dist/capability/network.js';
import type { NetworkTarget } from '../dist/capability/network.js';

async function listen(server: Server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function post(target: NetworkTarget, options: Partial<Parameters<typeof postJsonTarget>[1]> = {}) {
  return postJsonTarget(target, {
    body: { query: 'safe query', limit: 3 }, bearer: 'token-123', maxBytes: 1024,
    timeoutMs: 1_000, ...options,
  });
}

test('JSON POST uses approved loopback addresses while preserving Host and Bearer, and returns error statuses', async () => {
  const seen: { method: string | undefined; host: string | undefined; authorization: string | undefined;
    contentType: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ method: request.method, host: request.headers.host, authorization: request.headers.authorization,
      contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(request.url === '/forbidden' ? 403 : 200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(request.url === '/forbidden' ? '{"error":"denied"}'
      : request.url === '/echo' ? '{"debug":"token-123"}' : '{"items":[1]}');
  });
  const origin = await listen(server);
  try {
    const port = new URL(origin).port;
    const target = await resolveTarget(`http://localhost:${port}/search`);
    const result = await post(target, { body: { query: 'safe query', limit: 3 } });
    assert.deepEqual(result, { status: 200, text: '{"items":[1]}', bytes: 13, contentType: 'application/json; charset=utf-8' });
    const deniedTarget = await resolveTarget(`http://localhost:${port}/forbidden`);
    const denied = await post(deniedTarget);
    assert.equal(denied.status, 403);
    assert.equal(denied.text, '{"error":"denied"}');
    const echoed = await post(await resolveTarget(`http://localhost:${port}/echo`));
    assert.equal(echoed.text, '{"debug":"[redacted]"}', 'the bearer is not returned when an endpoint echoes it');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].host, `localhost:${port}`);
    assert.equal(seen[0].authorization, 'Bearer token-123');
    assert.equal(seen[0].contentType, 'application/json');
    assert.equal(seen[0].body, '{"query":"safe query","limit":3}');
  } finally {
    await close(server);
  }
});

test('POST redirects fail without sending a second request', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(307, { location: '/next' });
    response.end('redirect body');
  });
  const origin = await listen(server);
  try {
    const error = await post(await resolveTarget(`${origin}/start`)).catch((failure) => failure) as { code: string };
    assert.equal(error.code, 'post_redirect_denied');
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test('request JSON is capped at 64 KiB and a response over its cap closes the socket', async () => {
  let reachedServer = false;
  let tailSent = false;
  let closed: Promise<unknown> | undefined;
  const server = createServer((request, response) => {
    reachedServer = true;
    if (request.url !== '/large') return response.end();
    closed = new Promise((resolve) => response.once('close', resolve));
    response.write(Buffer.alloc(200, 0x61));
    setTimeout(() => {
      tailSent = true;
      response.end('tail');
    }, 150);
  });
  const origin = await listen(server);
  try {
    const target = await resolveTarget(origin);
    const requestError = await post(target, { body: { value: 'x'.repeat(64 * 1024) } }).catch((error) => error) as { code: string };
    assert.equal(requestError.code, 'post_body_too_large');
    assert.equal(reachedServer, false, 'oversized JSON is refused before connecting');

    const responseError = await post(await resolveTarget(`${origin}/large`), { maxBytes: 100 }).catch((error) => error) as { code: string };
    assert.equal(responseError.code, 'post_response_too_large');
    await closed;
    assert.equal(tailSent, false, 'the response stream was destroyed before the server sent its tail');
  } finally {
    await close(server);
  }
});

test('response hard cap stays at 2 MiB even when the caller limit is larger', async () => {
  const server = createServer((_request, response) => response.end(Buffer.alloc(2 * 1024 * 1024 + 1)));
  const origin = await listen(server);
  try {
    const error = await post(await resolveTarget(origin), { maxBytes: 3 * 1024 * 1024 }).catch((failure) => failure) as { code: string };
    assert.equal(error.code, 'post_response_too_large');
  } finally {
    await close(server);
  }
});

test('the total request timeout and caller cancellation have stable errors', async () => {
  let received: (() => void) | undefined;
  const server = createServer((request) => {
    if (request.url === '/cancel') received?.();
  });
  const origin = await listen(server);
  try {
    const target = await resolveTarget(`${origin}/timeout`);
    const timeout = await post(target, { timeoutMs: 50 }).catch((error) => error) as { code: string };
    assert.equal(timeout.code, 'post_timeout');

    let ready!: () => void;
    const accepted = new Promise<void>((resolve) => { ready = resolve; });
    received = ready;
    const controller = new AbortController();
    const pending = post(await resolveTarget(`${origin}/cancel`), { signal: controller.signal });
    await Promise.race([accepted, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('cancel request was not received')), 2000);
      timer.unref();
    })]);
    controller.abort();
    const cancelled = await pending.catch((error) => error) as { code: string };
    assert.equal(cancelled.code, 'post_cancelled');
  } finally {
    await close(server);
  }
});

test('unsupported, denied, empty-IP and public cleartext targets fail closed', async () => {
  const unsupported = await resolveTarget('file:///etc/passwd');
  const denied = await resolveTarget('http://169.254.169.254/latest');
  const publicHttp = await resolveTarget('http://93.184.216.34/search');
  for (const [target, code] of [
    [unsupported, 'post_target_invalid'],
    [denied, 'post_target_denied'],
    [{ ...await resolveTarget('http://127.0.0.1:1/'), addresses: [] }, 'post_target_denied'],
    [publicHttp, 'post_insecure_auth_denied'],
  ] as [NetworkTarget, string][]) {
    const error = await post(target).catch((failure) => failure) as { code: string };
    assert.equal(error.code, code);
  }
});

test('Bearer values containing whitespace or controls are rejected without being echoed', async () => {
  const target = await resolveTarget('http://127.0.0.1:1/');
  for (const bearer of ['   ', 'bad token', 'secret\r\nInjected: yes', 'token"quote', '中文', 'x'.repeat(8193)]) {
    const error = await post(target, { bearer }).catch((failure) => failure) as { code: string; message: string; detail: unknown };
    assert.equal(error.code, 'post_bearer_invalid');
    assert.equal(JSON.stringify({ message: error.message, detail: error.detail }).includes(bearer), false);
  }
});
