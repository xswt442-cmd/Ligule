import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';
import { createCompaction, estimateRequest } from '../core/dist/session/compaction.js';
import { createSessionLog } from '../core/dist/session/session.js';
import { providerFromConfig } from '../core/dist/host/host.js';
import type { ModelTool } from '../core/dist/kernel/loop.js';

type UsageEvent = { kind: string; input: number; estimated: number; measurement: string };
type CompactionEvent = {
  kind: string;
  seq?: number;
  userSeq?: number;
  text?: string;
  status?: string;
  runId?: string;
  run?: { runId?: string };
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  purpose?: string;
  source?: string;
  tool?: string;
  result?: unknown;
};

test('two real Host protocol turns auto-compact and continue through a file read', async () => {
  const firstInput = `${'H04 completed context record '.repeat(500)}\nPRESERVED-CONTEXT-ANCHOR`;
  const secondInput = JSON.stringify({ tool: 'read', args: { path: 'marker.txt' } });
  const marker = 'H04 real read after compaction';
  const approvals: { tool?: string; args?: { path?: string } }[] = [];
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const status = await client.request('status.get', { sessionId }) as {
      permission: { workspaceTrusted: boolean; profile: string };
    };
    assert.equal(status.permission.workspaceTrusted, true, 'the isolated project receives an explicit workspace-trust decision');
    assert.equal(status.permission.profile, 'read-only', 'workspace trust does not raise the Session Permission profile');
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      const params = message.params && typeof message.params === 'object' ? message.params as {
        tool?: string;
        args?: { path?: string };
      } : {};
      approvals.push(params);
      return params.tool === 'read' && params.args?.path === 'marker.txt'
        ? { decision: 'allow' }
        : { decision: 'deny' };
    });
    await client.request('run.start', { sessionId, input: firstInput });
    const afterFirst = (await client.request('session.read', { sessionId }) as { events: CompactionEvent[] }).events;
    const firstUser = afterFirst.find((event) => event.kind === 'user' && event.text === firstInput);
    assert.ok(firstUser, 'A is persisted as a real user event');
    const firstTurn = afterFirst.find((event) => event.kind === 'turn' && event.userSeq === firstUser.seq);
    assert.equal(firstTurn?.status, 'completed', 'A is a real completed Host turn before B is sent');

    await client.request('run.start', { sessionId, input: secondInput });
    const events = (await client.request('session.read', { sessionId }) as { events: CompactionEvent[] }).events;
    const secondUser = events.find((event) => event.kind === 'user' && event.text === secondInput);
    assert.ok(secondUser, 'B is persisted in the same Session');
    const secondTurn = events.find((event) => event.kind === 'turn' && event.userSeq === secondUser.seq);
    const compaction = events.find((event) => event.kind === 'compaction' && event.reason === 'auto');
    const read = events.find((event) => event.kind === 'tool' && event.tool === 'read'
      && Number(event.seq) > Number(compaction?.seq));
    const summaryUsage = events.find((event) => event.kind === 'usage' && event.source === 'summary');
    const firstRunId = firstUser.run?.runId;
    const secondRunId = secondUser.run?.runId;

    assert.ok(typeof firstRunId === 'string' && typeof secondRunId === 'string' && firstRunId !== secondRunId,
      'each completed turn records a distinct run in the same session');
    assert.ok(compaction, 'B causes automatic compaction in the real Host path');
    assert.ok(Number(compaction.tokensBefore) > Number(compaction.tokensAfter), 'the persisted summary shrinks the measured projection');
    assert.ok(summaryUsage && summaryUsage.purpose === 'agent', 'the summary Provider request is recorded in the Agent Usage ledger');
    const summaryRequest = providerRequests.find((request) => request.messages.some((message) =>
      typeof message.content === 'string' && message.content.includes('Write a summary')));
    assert.ok(summaryRequest?.messages.some((message) =>
      typeof message.content === 'string' && message.content.includes('PRESERVED-CONTEXT-ANCHOR')),
    'the actual summary request receives the distinctive tail of A');
    assert.ok(providerRequests.length >= 4, 'summary, B tool call, and tool continuation reach the local Provider');
    assert.deepEqual(approvals.map((approval) => [approval.tool, approval.args?.path]), [['read', 'marker.txt']],
      'the client explicitly approves only the expected read request');
    assert.ok(read && JSON.stringify(read.result).includes(marker), 'a real read tool runs after compaction and returns its fixture');
    assert.equal(secondTurn?.status, 'completed', 'B completes after the compacted tool continuation');
    assert.ok(Number(compaction.seq) < Number(read.seq) && Number(read.seq) < Number(secondTurn?.seq),
      'the Session records compaction, the read result, then B completion');
  }, {
    config: { loop: { iterations: 4, modelCalls: 8, totalModelCalls: 8 }, limits: {
      contextTokens: 8_192, compactThresholdRatio: 0.8, compactRetainRatio: 0.16, resultBytes: 16_000,
    } },
    setup: ({ projectDirectory }) => writeFile(join(projectDirectory, 'marker.txt'), marker, 'utf8'),
    permissionControl: true,
    testDirectory: resolve('../testplace/tmp'),
  });
});

test('usage calibrates the complete request and remains reproducible after reopen', async () => {
  await withTuiHost(async ({ client, sessionId, providerRequests, sessionDirectory, config }) => {
    await client.request('run.start', { sessionId, input: '短输入' });
    const short = (await client.request('status.get', { sessionId }) as { usage: { factor: number } }).usage;
    assert.ok(short.factor < 10, '固定系统与工具前缀计入本地估算');
    const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
    await client.request('run.start', { sessionId, input: guide });
    const read = await client.request('session.read', { sessionId }) as { events: UsageEvent[] };
    const usage = read.events.filter((event) => event.kind === 'usage').at(-1) as UsageEvent;
    const request = providerRequests.at(-1)!;
    const prefix = {
      system: (request.messages.find((message) => message.role === 'system')?.content ?? '') as string,
      tools: (await client.request('status.get', { sessionId }) as { tools: readonly ModelTool[] }).tools,
    };
    assert.equal(usage.measurement, 'request-v1');
    const snapshot = createCompaction({
      provider: providerFromConfig(config), session: createSessionLog({ directory: sessionDirectory, id: sessionId }),
      directory: sessionDirectory, id: sessionId, limits: { contextTokens: 200000, compactThresholdRatio: 0.8, compactRetainRatio: 0.16, resultBytes: 16000 },
      requestPrefix: () => prefix,
    });
    assert.equal((await snapshot.context()).factor, Math.round(usage.input / usage.estimated * 100) / 100);
    assert.ok(estimateRequest({ ...prefix, messages: [] }) > 0);
  });
});

test('manual compaction blocks a concurrent round and forwards cancellation to the real request', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory, providerRequests }) => {
    const text = '上下文压缩验证'.repeat(2000);
    await client.request('run.start', { sessionId, input: text });
    await client.request('run.start', { sessionId, input: text });
    const before = providerRequests.length;
    const compacted = client.request('session.compact', { sessionId });
    const rejected = assert.rejects(compacted, (error) => (error as { code: string }).code === 'loop_cancelled');
    for (let count = 0; count < 100 && providerRequests.length === before; count += 1) await delay(20);
    assert.ok(providerRequests.length > before, '摘要请求实际发到了HTTP服务');
    await assert.rejects(client.request('run.start', { sessionId, input: '并发输入' }), (error) => (error as { code: string }).code === 'run_already_running');
    await client.request('run.cancel', { sessionId });
    await rejected;
    assert.equal((await client.request('status.get', { sessionId }) as { running: boolean }).running, false);
    await assert.rejects(readFile(join(sessionDirectory, `${sessionId}.checkpoint.json`)), (error) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  }, { delayMs: 250 });
});

test('an endpoint usage report is recorded when no context window is configured', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await client.request('run.start', { sessionId, input: '未配置窗口的用量记录' });
    const read = await client.request('session.read', { sessionId }) as { events: UsageEvent[] };
    assert.ok(read.events.some((event) => event.kind === 'usage' && event.input > 0 && event.measurement === 'request-v1'));
    assert.equal((await client.request('status.get', { sessionId }) as { usage: null }).usage, null);
  }, { config: { limits: {} } });
});
