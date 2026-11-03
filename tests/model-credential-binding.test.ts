import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { loadHostEnvironment } from '../core/dist/host/environment.js';
import { serveHost } from '../core/dist/host/host.js';
import { createConnection } from '../core/dist/host/connection.js';
import { createMemoryConnectionPair } from '../core/dist/host/memory.js';
import { DEFAULT_PERMISSION_CONTEXT } from '../core/dist/kernel/permission.js';
import { createConfigStore } from '../core/dist/kernel/config-store.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const { stringify } = createRequire(join(repository, 'core', 'package.json'))('smol-toml');

test('CLI run keeps credential binding when a project replaces the user endpoint', { timeout: 20_000 }, async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'cli-model-binding-'));
  const projectRoot = join(root, 'project');
  const dataRoot = join(root, 'data');
  await Promise.all([mkdir(join(projectRoot, '.ligule'), { recursive: true }), mkdir(dataRoot)]);
  const seen = [0, 0];
  const endpoints = seen.map((_, index) => createServer((request, response) => {
    seen[index] += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'endpoint reply' }, finish_reason: 'stop' }] }));
  }));
  try {
    for (const endpoint of endpoints) await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', () => resolve()));
    const urls = endpoints.map(endpoint => `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`);
    const reference = `LIGULE_CLI_BINDING_${randomUUID().replaceAll('-', '')}`;
    await writeFile(join(dataRoot, 'config.toml'), stringify({ model: { api: 'chat-completions', baseURL: urls[0], model: 'fixture', apiKeyEnv: reference,
      capabilities: { streaming: false } }, policy: { mode: 'auto' } }));
    await writeFile(join(projectRoot, '.ligule', 'config.toml'), stringify({ model: { baseURL: urls[1] } }));
    const child = spawn(process.execPath, [join(repository, 'tui', 'dist', 'cli.js'), 'run', '--mode', 'full', '--lang', 'en', 'Only reply briefly.'], {
      cwd: projectRoot, env: { ...process.env, LIGULE_HOME: dataRoot, [reference]: randomUUID() }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.notEqual(exit, 0);
    assert.match(stderr, /provider_credential_unbound/u);
    assert.deepEqual(seen, [0, 0], 'neither endpoint receives the borrowed credential or conversation');
  } finally {
    for (const endpoint of endpoints) { endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});

test('real model requests bind credentials to user or flag endpoints across project configuration layers', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'model-binding-'));
  const reference = `LIGULE_TEST_BINDING_${randomUUID().replaceAll('-', '')}`;
  const otherReference = `${reference}_OTHER`;
  const sentinel = 'isolated-model-binding-test';
  process.env[reference] = sentinel;
  process.env[otherReference] = 'isolated-other-reference';
  const previousHome = process.env.LIGULE_HOME;
  const seen: boolean[][] = [[], []];
  let beforeFirstReply: (() => Promise<void>) | undefined;
  let childRequest: boolean | undefined;
  const servers = seen.map((requests) => createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const delegate = childRequest;
    childRequest = undefined;
    if (delegate !== undefined) assert(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'subagent'));
    if (body.messages.some((message: { role: string; content?: unknown }) => message.role === 'user' && message.content === 'binding child')) {
      assert.equal(body.max_tokens, 16);
      assert.equal(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'subagent'), false);
    }
    requests.push(request.headers.authorization === `Bearer ${sentinel}` || request.headers['x-api-key'] === sentinel);
    const hook = beforeFirstReply;
    beforeFirstReply = undefined;
    if (hook !== undefined) await hook();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(delegate !== undefined
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'binding-child', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ task: 'binding child', outputTokens: 16 }) } }] }, finish_reason: 'tool_calls' }] }
      : hook !== undefined
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'binding-read', type: 'function', function: { name: 'read', arguments: '{"path":"note.txt"}' } }] }, finish_reason: 'tool_calls' }] }
      : request.url!.endsWith('/messages')
      ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'bound response' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { role: 'assistant', content: 'bound response' }, finish_reason: 'stop' }] }));
  }));
  try {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))));
    const [firstURL, secondURL] = servers.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const user = { api: 'chat-completions', baseURL: firstURL, model: 'review', apiKeyEnv: reference, capabilities: { streaming: false } };
    const service = { id: 'binding', name: 'Binding', api: 'chat-completions', baseURL: firstURL, apiKeyEnv: reference, models: ['review'] };
    const services = { services: [service], selection: { provider: 'binding', model: 'review' }, capabilities: { streaming: false } };
    const cases: {
      name: string;
      user: Record<string, unknown>;
      project: Record<string, unknown>;
      local?: boolean;
      flags?: string[];
      allowed?: number;
      changeDuringTurn?: boolean;
      subagent?: boolean;
    }[] = [
      { name: 'shared-endpoint', user, project: { baseURL: secondURL } },
      { name: 'local-endpoint', user, project: { baseURL: secondURL }, local: true },
      { name: 'credential-reference', user, project: { apiKeyEnv: otherReference } },
      { name: 'service-endpoint', user: services, project: { services: [{ ...service, baseURL: secondURL }] } },
      { name: 'messages-endpoint', user: { ...user, api: 'messages' }, project: { baseURL: secondURL } },
      { name: 'project-model', user, project: { model: 'project-model' }, allowed: 0 },
      { name: 'project-service', user: services, project: { services: [{ ...service, name: 'Project label' }] }, allowed: 0 },
      { name: 'messages-model', user: { ...user, api: 'messages' }, project: { model: 'project-model' }, allowed: 0 },
      { name: 'explicit-flag', user, project: { baseURL: secondURL }, flags: [`model.baseURL=${JSON.stringify(secondURL)}`], allowed: 1 },
      { name: 'turn-boundary', user, project: { model: 'project-model' }, allowed: 0, changeDuringTurn: true },
      { name: 'bounded-subagent', user, project: { model: 'project-model' }, allowed: 0, subagent: true },
    ];
    for (const scenario of cases) {
      seen.forEach((requests) => { requests.length = 0; });
      const project = join(root, scenario.name, 'project');
      const data = join(root, scenario.name, 'data');
      await mkdir(join(project, '.ligule'), { recursive: true });
      await mkdir(data);
      process.env.LIGULE_HOME = data;
      await writeFile(join(data, 'config.toml'), stringify({ model: scenario.user, policy: { mode: 'auto' }, ...(scenario.subagent ? { mode: 'full' } : {}) }));
      await writeFile(join(project, '.ligule', scenario.local ? 'config.local.toml' : 'config.toml'), stringify({ model: scenario.project }));
      await writeFile(join(project, 'note.txt'), 'binding test content');
      const { layers, ...environment } = await loadHostEnvironment(project, join(repository, 'core', 'modes'), scenario.flags);
      const pair = createMemoryConnectionPair();
      const host = serveHost({ ...environment, ...pair.host, configLayers: layers, permission: DEFAULT_PERMISSION_CONTEXT, permissionControl: true,
        configStoreFor: (projectRoot, ownLayers) => createConfigStore({ projectRoot, layers: ownLayers }),
      });
      const client = createConnection(pair.client);
      let approvals = 0;
      client.onRequest(() => { approvals += 1; return { decision: 'deny' }; });
      try {
        const { sessionId } = await client.request('session.create', {}) as { sessionId: string };
        assert.equal((await client.request('status.get', { sessionId }) as { permission: { workspaceTrusted: boolean } }).permission.workspaceTrusted, false);
        if (scenario.changeDuringTurn) {
          beforeFirstReply = async () => {
            const shown = await client.request('config.get', {}) as { layers: { layer: string; version: number }[] };
            await client.request('config.set', { field: 'model.baseURL', value: secondURL, layer: 'user', version: shown.layers.find((layer) => layer.layer === 'user')!.version });
          };
        }
        if (scenario.subagent) childRequest = true;
        const run = client.request('run.start', { sessionId, input: 'Reply briefly.' });
        if (scenario.allowed === undefined) {
          await assert.rejects(run, { code: 'provider_credential_unbound' }, scenario.name);
          assert.deepEqual(seen, [[], []], scenario.name);
        } else {
          assert.equal((await run as { text: string }).text, 'bound response', scenario.name);
          assert.deepEqual(seen[scenario.allowed], scenario.subagent ? [true, true, true] : scenario.changeDuringTurn ? [true, true] : [true], scenario.name);
          assert.deepEqual(seen[1 - scenario.allowed], [], scenario.name);
          if (scenario.changeDuringTurn) {
            assert.equal((await client.request('run.start', { sessionId, input: 'Use the updated service.' }) as { text: string }).text, 'bound response');
            assert.deepEqual(seen[1], [true], 'the next turn adopts the newly bound user endpoint');
          }
        }
        assert.equal(approvals, 0);
      } finally {
        await host.release();
        pair.client.input.destroy();
        pair.client.output.destroy();
      }
    }
  } finally {
    await Promise.all(servers.map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }));
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    delete process.env[reference];
    delete process.env[otherReference];
    await rm(root, { recursive: true, force: true });
  }
});
