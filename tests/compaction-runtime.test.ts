import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';
import { createCompaction, estimateRequest } from '../core/dist/session/compaction.js';
import { createSessionLog } from '../core/dist/session/session.js';
import { providerFromConfig } from '../core/dist/host/host.js';
import type { ModelTool } from '../core/dist/kernel/loop.js';

type UsageEvent = { kind: string; input: number; estimated: number; measurement: string };

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
