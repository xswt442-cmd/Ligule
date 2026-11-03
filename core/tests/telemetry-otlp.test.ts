import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createTelemetry } from '../dist/kernel/telemetry.js';
import type { TelemetryEvent } from '../dist/kernel/telemetry.js';

type RequestRecord = { path: string | undefined; headers: Record<string, string | string[] | undefined>; body: Buffer };
type RunLink = { parentExecutionId?: string; parentRunId?: string; parentCallId?: string };

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function runStarted(executionId: string, runId: string, sessionId: string, userSeq: number, parent: RunLink = {}): TelemetryEvent {
  return { type: 'run.started', executionId, runId, sessionId, userSeq, ...parent };
}

test('OTLP trace export uses a local HTTP protobuf endpoint and exports only bounded event attributes', async (t) => {
  const requests: RequestRecord[] = [];
  const receiver = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200, { connection: 'close' });
    response.end();
  });
  const port = await listen(receiver);
  t.after(() => close(receiver));

  const previous = {
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  };
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1/v1/traces';
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=environment-secret';
  t.after(() => {
    if (previous.endpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous.endpoint;
    if (previous.headers === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = previous.headers;
  });

  const telemetry = createTelemetry({ enabled: true, otlpEndpoint: `http://127.0.0.1:${port}/v1/traces` });
  telemetry.emit(runStarted('parent-execution', 'parent-run', 'parent-session', 7));
  telemetry.emit({ type: 'tool.started', executionId: 'parent-execution', runId: 'parent-run', sessionId: 'parent-session',
    userSeq: 7, callId: 'parent-call', tool: 'subagent' });
  telemetry.emit(runStarted('child-execution', 'child-run', 'child-session', 3,
    { parentExecutionId: 'parent-execution', parentRunId: 'parent-run', parentCallId: 'parent-call' }));
  telemetry.emit({ type: 'model.started', executionId: 'child-execution', runId: 'child-run', sessionId: 'child-session', userSeq: 3,
    requestId: 'provider-request', logicalRequestId: 'logical-request', attempt: 1, provider: 'deepseek', model: 'deepseek_chat' });
  telemetry.emit({ type: 'model.finished', executionId: 'child-execution', runId: 'child-run', sessionId: 'child-session', userSeq: 3,
    requestId: 'provider-request', logicalRequestId: 'logical-request', attempt: 1, provider: 'deepseek', model: 'deepseek_chat',
    durationMs: 12, status: 'completed', inputTokens: 9, outputTokens: 4, cacheSource: 'chat-completions',
    cacheSourceFields: 'prompt_tokens_details.cached_tokens,prompt_tokens', cacheHitInputTokens: 3, cacheMissInputTokens: 6,
    providerInputIncludesCache: true, cacheConsistent: true, finishReason: 'stop' });
  telemetry.emit({ type: 'tool.started', executionId: 'child-execution', runId: 'child-run', sessionId: 'child-session',
    userSeq: 3, callId: 'child-call', tool: 'create' });
  telemetry.emit({ type: 'tool.finished', executionId: 'child-execution', runId: 'child-run', sessionId: 'child-session',
    userSeq: 3, callId: 'child-call', tool: 'create', durationMs: 2, outcome: 'success' });
  telemetry.emit({ type: 'run.finished', executionId: 'child-execution', runId: 'child-run', sessionId: 'child-session', userSeq: 3,
    status: 'completed', durationMs: 20, modelCalls: 1, toolCalls: 1 });
  telemetry.emit({ type: 'tool.finished', executionId: 'parent-execution', runId: 'parent-run', sessionId: 'parent-session',
    userSeq: 7, callId: 'parent-call', tool: 'subagent', durationMs: 25, outcome: 'success' });
  telemetry.emit({ type: 'run.finished', executionId: 'parent-execution', runId: 'parent-run', sessionId: 'parent-session', userSeq: 7,
    status: 'completed', durationMs: 30, modelCalls: 1, toolCalls: 1 });
  telemetry.emit({ ...runStarted('sensitive-execution', 'sensitive-run', 'sensitive-session', 8),
    prompt: 'PRIVATE_PROMPT_CONTENT', reasoning: 'PRIVATE_REASONING_CONTENT', fileContent: 'PRIVATE_FILE_CONTENT' } as unknown as TelemetryEvent);
  telemetry.emit({ type: 'tool.started', executionId: 'parent-execution', runId: 'parent-run', sessionId: 'parent-session', userSeq: 7,
    callId: 'secret-call', tool: 'read', args: 'PRIVATE_TOOL_ARGS' } as unknown as TelemetryEvent);
  await telemetry.flush();
  await telemetry.shutdown();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/traces');
  assert.match(requests[0].headers['content-type'] as string, /application\/x-protobuf/u);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.ok(requests[0].body.byteLength > 0);
  const wireText = requests[0].body.toString('latin1');
  for (const expected of ['ligule.run', 'ligule.tool.subagent', 'ligule.tool.create', 'gen_ai.chat', 'gen_ai.usage.input_tokens',
    'ligule.usage.cache.source', 'ligule.usage.cache.hit_input_tokens', 'ligule.usage.provider_input_includes_cache',
    'ligule.session.id', 'ligule.run.id', 'ligule.user.seq', 'ligule.tool.call_id']) {
    assert.ok(wireText.includes(expected), `OTLP protobuf is missing ${expected}`);
  }
  assert.doesNotMatch(wireText, /environment-secret|PRIVATE_PROMPT_CONTENT|PRIVATE_REASONING_CONTENT|PRIVATE_TOOL_ARGS|PRIVATE_FILE_CONTENT/u);
});

test('OTLP stays disabled by default and refuses remote or credential-bearing endpoints', async () => {
  for (const endpoint of [
    'https://collector.example/v1/traces',
    'http://user:password@localhost:4318/v1/traces',
    'http://localhost:4318/v1/traces?token=secret',
    'http://localhost:4318/v1/traces#fragment',
    'http://localhost:4318/',
  ]) {
    assert.throws(() => createTelemetry({ enabled: true, otlpEndpoint: endpoint }), { code: 'telemetry_otlp_endpoint_invalid' });
  }

  const telemetry = createTelemetry({ otlpEndpoint: 'http://127.0.0.1:4318/v1/traces' });
  assert.doesNotThrow(() => telemetry.emit(runStarted('execution', 'run', 'session', 1)));
  await assert.doesNotReject(telemetry.shutdown());
});

test('OTLP connection failures stay off the run path and Host shutdown remains bounded', async () => {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);

  const telemetry = createTelemetry({ enabled: true, otlpEndpoint: `http://127.0.0.1:${port}/v1/traces` });
  assert.doesNotThrow(() => telemetry.emit(runStarted('execution-failure', 'run-failure', 'session-failure', 2)));
  assert.doesNotThrow(() => telemetry.emit({ type: 'run.finished', executionId: 'execution-failure', runId: 'run-failure',
    sessionId: 'session-failure', userSeq: 2, status: 'failed', durationMs: 1, modelCalls: 0, toolCalls: 0, errorCode: 'provider_http_error' }));
  const started = Date.now();
  await assert.doesNotReject(telemetry.shutdown());
  assert.ok(Date.now() - started < 1_000);
});

test('OTLP slow receivers cannot keep shutdown or agent completion open', async (t) => {
  const receiver = createServer(async (request) => {
    for await (const _chunk of request) { /* Drain the request; the receiver deliberately withholds its response. */ }
  });
  const port = await listen(receiver);
  t.after(() => close(receiver));
  const telemetry = createTelemetry({ enabled: true, otlpEndpoint: `http://127.0.0.1:${port}/v1/traces` });
  telemetry.emit(runStarted('execution-slow', 'run-slow', 'session-slow', 3));
  telemetry.emit({ type: 'run.finished', executionId: 'execution-slow', runId: 'run-slow', sessionId: 'session-slow', userSeq: 3,
    status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  const started = Date.now();
  await assert.doesNotReject(telemetry.shutdown());
  assert.ok(Date.now() - started < 1_000);
});
