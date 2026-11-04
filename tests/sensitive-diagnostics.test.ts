import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcp } from './helpers/mcp-control.mjs';
import { setTrusted } from '../core/dist/kernel/workspace-trust.js';
import { listenFetchable } from '../core/tests/helpers/port.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryBase = join(repoRoot, 'testplace', 'tmp', 'plan2-sensitive');
const cliPath = join(repoRoot, 'tui', 'dist', 'cli.js');
const sdkRoot = join(repoRoot, 'core', 'node_modules', '@modelcontextprotocol', 'sdk');
const apiKeyName = 'LIGULE_PLAN2_SYNTHETIC_API_KEY';
const apiKeySentinel = 'PLAN2_SYNTHETIC_MCP_CREDENTIAL_NEVER_USE';
const diagnosticSentinel = 'PLAN2_SYNTHETIC_UPSTREAM_DIAGNOSTIC_SENTINEL';
const userPrompt = 'Please provide a concise status note for this project.';

function sse(events: unknown[]) {
  return events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}

function badArguments() {
  return `{"path":"innocent.txt","marker":"${diagnosticSentinel}" BROKEN}`;
}

function chatToolFailure() {
  return [
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'synthetic-call-chat',
            type: 'function',
            function: { name: 'read', arguments: badArguments() },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    '[DONE]',
  ];
}

function messagesToolFailure() {
  return [
    { type: 'message_start', message: { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'synthetic-model', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'synthetic-call-messages', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: badArguments() } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
}

async function startEndpoint(kind: string) {
  const server = createServer((request, response) => {
    request.resume();
    if (kind === 'http-unauthorized') {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end(`Authorization: Bearer ${apiKeySentinel}; upstream body: ${diagnosticSentinel}`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (kind === 'chat-tool-args') {
      response.end(sse(chatToolFailure()));
    } else if (kind === 'messages-tool-args') {
      response.end(sse(messagesToolFailure()));
    } else if (kind === 'malformed-sse') {
      response.end(`data: ${diagnosticSentinel}\n\n`);
    } else {
      response.destroy();
    }
  });
  const port = await listenFetchable(server);
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function collectJsonlFiles(root: string) {
  const result: string[] = [];
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path);
    }
  }
  await visit(root);
  return result;
}

type ToolPayload = {
  code?: string;
  sessionId?: string;
  operationId?: string;
  state?: string;
  records?: { json: string }[];
  hasMore?: boolean;
  nextBefore?: number;
};
type ToolResult = {
  isError?: boolean;
  structuredContent?: ToolPayload & { result?: { structuredContent?: ToolPayload } };
  content?: { type?: string; text?: string }[];
};

function resultData(result: ToolResult | undefined): ToolPayload {
  const structured = result?.structuredContent;
  if (structured !== undefined) return (structured.result?.structuredContent ?? structured) as ToolPayload;
  const text = result?.content?.find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('mcp_result_shape_invalid');
  try {
    return JSON.parse(text) as ToolPayload;
  } catch {
    throw new Error('mcp_result_json_invalid');
  }
}

async function runFailureCase({ name, api, endpoint, expectedCode }: { name: string; api: string; endpoint: { baseUrl: string }; expectedCode: string }) {
  await mkdir(temporaryBase, { recursive: true });
  const caseRoot = await mkdtemp(join(temporaryBase, `${name}-`));
  const projectRoot = join(caseRoot, 'project');
  const home = join(caseRoot, 'home');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(projectRoot, 'README.md'), 'Synthetic local Provider security diagnostic fixture.\n', { flag: 'wx' });
  const apiName = api === 'chat-completions' ? 'chat-completions' : 'messages';
  const config = [
    'boundary = "."',
    '',
    '[model]',
    `api = ${JSON.stringify(apiName)}`,
    `baseURL = ${JSON.stringify(api === 'chat-completions' ? `${endpoint.baseUrl}/v1` : endpoint.baseUrl)}`,
    'model = "synthetic-local-model"',
    `apiKeyEnv = ${JSON.stringify(apiKeyName)}`,
    '',
    '[model.retry]',
    'maxAttempts = 1',
    'baseDelayMs = 1',
    'retry429 = false',
    'retry5xx = false',
    'retryTransport = false',
    '',
    '[policy]',
    'mode = "ask"',
    '',
  ].join('\n');
  await writeFile(join(home, 'config.toml'), config, { flag: 'wx' });
  await setTrusted(projectRoot, true, join(home, 'tui-trust.json'));

  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    connection = await connectMcp({
      cliPath,
      projectRoot,
      dataRoot: home,
      apiKeyName,
      apiKey: apiKeySentinel,
      sdkRoot,
    });

    const mcpResponses: ToolResult[] = [];
    const call = async (name: string, argumentsValue: Record<string, unknown>) => {
      const result = await connection!.client.callTool({ name, arguments: argumentsValue }) as ToolResult;
      mcpResponses.push(result);
      return resultData(result);
    };

    const created = await call('ligule_session_create', { projectRoot });
    const sessionId = created.sessionId;
    assert.equal(typeof sessionId, 'string', 'session_create should return a Session ID');

    const started = await call('ligule_run_start', { sessionId, input: userPrompt });
    const operationId = started.operationId;
    assert.equal(typeof operationId, 'string', 'run_start should return an operation ID');

    let status = started;
    for (let attempt = 0; status.state === 'running' && attempt < 120; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      status = await call('ligule_run_status', { operationId });
    }
    if (status.state === 'running') {
      await call('ligule_run_cancel', { operationId });
      assert.fail('synthetic local Provider run did not settle');
    }
    assert.equal(status.state, 'failed', 'malicious local Provider response must fail the run');
    assert.equal(status.code, expectedCode, 'run_status must expose the stable Provider error code');

    let before;
    let page;
    const sessionResponses: string[] = [];
    const records: { json: string }[] = [];
    do {
      const argumentsValue = { sessionId, limit: 50, ...(before === undefined ? {} : { before }) };
      const result = await connection.client.callTool({ name: 'ligule_session_read', arguments: argumentsValue });
      mcpResponses.push(result);
      sessionResponses.push(JSON.stringify(result));
      page = resultData(result);
      records.push(...(page.records ?? []));
      before = page.hasMore ? page.nextBefore : undefined;
    } while (before !== undefined);

    const parsedRecords = records.flatMap((record) => {
      try { return [JSON.parse(record.json)]; } catch { return []; }
    });
    const turns = parsedRecords.filter((record) => record.kind === 'turn');
    assert.equal(turns.length, 1, 'Session JSONL must contain exactly one terminal turn');
    assert.equal(turns[0].status, 'failed');
    assert.equal(turns[0].code, expectedCode);

    const serializedMcp = JSON.stringify(mcpResponses);
    assert.equal(serializedMcp.includes(apiKeySentinel), false, 'MCP responses must not include the synthetic API key');
    assert.equal(serializedMcp.includes(diagnosticSentinel), false, 'MCP responses must not include malicious upstream data');
    assert.equal(sessionResponses.join('\n').includes(apiKeySentinel), false, 'session_read must not include the synthetic API key');
    assert.equal(sessionResponses.join('\n').includes(diagnosticSentinel), false, 'session_read must not include the malicious diagnostic sentinel');

    const jsonlFiles = await collectJsonlFiles(home);
    assert.ok(jsonlFiles.length > 0, 'the actual isolated Session JSONL must exist');
    const rawJsonl = await Promise.all(jsonlFiles.map((path) => readFile(path, 'utf8')));
    assert.equal(rawJsonl.join('\n').includes(apiKeySentinel), false, 'persisted Session JSONL must not contain the synthetic API key');
    assert.equal(rawJsonl.join('\n').includes(diagnosticSentinel), false, 'persisted Session JSONL must not contain raw upstream diagnostics or tool arguments');
    const persistedRecords = rawJsonl.flatMap((text) => text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }));
    const persistedTurns = persistedRecords.filter((record) => record.kind === 'turn');
    assert.equal(persistedTurns.length, 1, 'persisted Session JSONL must contain exactly one terminal turn');
    assert.equal(persistedTurns[0].status, 'failed');
    assert.equal(persistedTurns[0].code, expectedCode);
  } finally {
    try { if (connection) await connection.close(); } finally { await rm(caseRoot, { recursive: true, force: true }); }
  }
}

const failureCases = [
  { name: 'chat-tool-args', api: 'chat-completions', endpoint: 'chat-tool-args', expectedCode: 'provider_tool_args_invalid' },
  { name: 'messages-tool-args', api: 'messages', endpoint: 'messages-tool-args', expectedCode: 'provider_tool_args_invalid' },
  { name: 'http-unauthorized', api: 'chat-completions', endpoint: 'http-unauthorized', expectedCode: 'provider_http_error' },
  { name: 'malformed-sse', api: 'chat-completions', endpoint: 'malformed-sse', expectedCode: 'provider_stream_invalid' },
];

for (const fixture of failureCases) {
  test(`actual Host, Session, and MCP redact ${fixture.name} diagnostics`, async () => {
    const endpoint = await startEndpoint(fixture.endpoint);
    try {
      await runFailureCase({ ...fixture, endpoint });
    } finally {
      endpoint.server.closeAllConnections();
      await new Promise((resolvePromise) => endpoint.server.close(resolvePromise));
    }
  });
}
