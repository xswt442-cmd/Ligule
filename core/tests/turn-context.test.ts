// 每轮开始时的生效参数会写入记录，但不会进入模型投影或请求体。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection, createConfig, createMemoryConnectionPair, MESSAGES_CAPABILITIES, serveHost } from '../dist/index.js';
import type { HostOptions } from '../dist/host/host.js';
import type { HostProvider } from '../dist/host/provider.js';
import type { ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import type { SessionEvent } from '../dist/session/format.js';

test('one round freezes the parameters in effect at its start into one record event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-turn-context-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
    },
  });
  const requests: ModelRequest[] = [];
  let turns = 0;
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request: ModelRequest): AsyncGenerator<ProviderEvent> {
      requests.push(request);
      // 第一次让模型提一次工具调用，第二次才收尾：本轮内部两个 loop 也只该留下一条快照。
      turns += 1;
      if (turns === 1) {
        yield { type: 'tool-call', id: 'call_1', name: 'exec', args: { command: 'git status' } };
        return;
      }
      yield { type: 'text', text: '本轮结束' };
    },
  } as unknown as HostProvider;
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as HostOptions['policy'] });
  const connection = createConnection(pair.client);
  try {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: '第一轮' });
    await connection.request('run.start', { sessionId, input: '第二轮' });
    const { events } = await connection.request('session.read', { sessionId }) as { events: SessionEvent[] };
    const snapshots = events.filter((event) => event.kind === 'turnContext');
    const inputs = events.filter((event) => event.kind === 'user');
    assert.equal(snapshots.length, 2, '两个真实用户轮次各留一条，内部多一次 loop 也不多留');
    assert.deepEqual(snapshots.map((event) => event.userSeq), inputs.map((event) => event.seq), '每一条指着自己那一轮那条输入');
    assert.equal(snapshots[0].model, 'test-model');
    assert.equal(snapshots[0].api, 'messages');
    assert.equal(snapshots[0].policy, 'auto');
    assert.equal(snapshots[0].policySource, 'config', '没人改过档位时说的是配置那一份');
    assert.equal(snapshots[0].text, undefined, '快照不装正文');

    // 确认回传给界面的快照没有进入模型上下文。
    const last = requests.at(-1)!;
    assert.ok(!JSON.stringify(last.messages).includes('turnContext'), '请求体里读不到这一条');
    // 各配置层都未设置静态提示时，系统提示使用随包提供的默认内容。
    assert.match(JSON.stringify(last), /ligule/, '随包的基础提示进了请求');
    const reopened = await connection.request('status.get', { sessionId }) as { eventCount: number };
    assert.ok(reopened.eventCount >= events.length, '状态上的条数与记录同源');
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});

// 会话覆盖审批档位后，记录的轮次快照应保留当时实际使用的档位。
test('the snapshot names the tier the round actually ran on after a session override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-turn-tier-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'ask' },
      // 配置层中的静态提示会完整替换随包默认内容，不会追加在默认内容之后。
      prompt: { static: '只看这一句' },
    },
  });
  const seen: ModelRequest[] = [];
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request: ModelRequest): AsyncGenerator<ProviderEvent> {
      seen.push(request);
      yield { type: 'text', text: '一句话' };
    },
  } as unknown as HostProvider;
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as HostOptions['policy'] });
  const connection = createConnection(pair.client);
  try {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('policy.set', { sessionId, mode: 'auto' });
    await connection.request('run.start', { sessionId, input: '甲' });
    const { events } = await connection.request('session.read', { sessionId }) as { events: SessionEvent[] };
    const snapshot = events.find((event) => event.kind === 'turnContext')!;
    assert.equal(snapshot.policy, 'auto');
    assert.equal(snapshot.policySource, 'session');
    const body = JSON.stringify(seen.at(-1));
    assert.ok(body.includes('只看这一句') && !body.includes('编程助手'), '写了静态段的那一层整份换掉了随包那一份（D102）');
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});
