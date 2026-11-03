// 验证提问工具只会装载到支持交互的客户端，并等待客户端给出真实答复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection, createConfig, createMemoryConnectionPair, MESSAGES_CAPABILITIES, serveHost } from '../dist/index.js';
import type { Connection } from '../dist/host/connection.js';
import type { ModelRequest } from '../dist/kernel/loop.js';
import type { PolicyMode } from '../dist/kernel/policy.js';
import { testHostProvider } from './helpers/provider.ts';

const QUESTIONS = JSON.stringify([
  { question: '这一份记录要按哪种方式整理？', header: '整理', options: [{ label: '就地补', description: '只动那几条缺的' }, { label: '整份重写' }] },
  { question: '目标目录在哪里？' },
]);

type SeenRequest = {
  method?: string;
  params: {
    sessionId?: string;
    questions: { id: string; options: unknown[] }[];
  };
};

type ToolEvent = {
  kind?: string;
  tool?: string;
  verdict: { via?: string };
  result: { failed?: boolean; code?: string; content: { text: string; answers: unknown[] } };
};

// 提供方先发起提问，再在下一轮结束运行；客户端答复由测试选项控制。
async function withAskingHost<TResult>(
  run: (connection: Connection, context: { requests: ModelRequest[]; seen: SeenRequest[]; directory: string }) => TResult | Promise<TResult>,
  { interactive = true, modeName, answer, policy = { mode: 'auto' } }: {
    interactive?: boolean;
    modeName?: string;
    answer?: (message: SeenRequest) => unknown;
    policy?: { mode: string };
  },
): Promise<TResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-ask-'));
  const config = createConfig({ user: { boundary: directory, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' }, policy } });
  const requests: ModelRequest[] = [];
  let turns = 0;
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request: ModelRequest) {
      requests.push(request);
      turns += 1;
      if (turns === 1) {
        yield { type: 'tool-call', id: 'call_ask', name: 'ask_user_question', args: { questions: QUESTIONS } };
        return;
      }
      yield { type: 'text', text: `第 ${turns} 次` };
    },
  });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as { mode?: PolicyMode }, ...(modeName === undefined ? {} : { modeName }), ...(interactive ? { interactive: true } : {}) });
  const connection = createConnection(pair.client);
  const seen: SeenRequest[] = [];
  connection.onRequest((message) => {
    const seenMessage = message as SeenRequest;
    seen.push(seenMessage);
    return answer === undefined ? undefined : answer(seenMessage);
  });
  try {
    return await run(connection, { requests, seen, directory });
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
}

test('an interactive client gets the asking tool in the default mode and the round waits for its answer', async () => {
  await withAskingHost(async (connection, { requests, seen }) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: '第一轮' });
    // 提问工具不受模式清单筛选，仍会出现在模型可用工具中。
    assert.ok(requests[0].tools.some((tool) => tool.name === 'ask_user_question'), '默认最小模式下模型就该看得见这一件');
    const asked = seen.filter((message) => message.method === 'question.request');
    assert.equal(asked.length, 1, '一次调用发一份请求，答复里带着题目自己来');
    assert.equal(asked[0].params.sessionId, sessionId, '请求说自己属于哪一份会话');
    assert.deepEqual(asked[0].params.questions.map((question) => question.id), ['q1', 'q2'], '编号由装载这一侧按顺序给');
    assert.equal(asked[0].params.questions[0].options.length, 2);
    const { events } = await connection.request('session.read', { sessionId }) as { events: ToolEvent[] };
    const result = events.find((event) => event.kind === 'tool' && event.tool === 'ask_user_question')!;
    assert.equal(result.result.failed, false, '拿到答复的这一次是正常结果');
    assert.match(result.result.content.text, /整份重写/, '答的内容原样进结果');
    assert.match(result.result.content.text, /目标目录在哪里/, '没答的那一道也在正文里说没答');
    assert.equal(result.result.content.answers.length, 1, '结构化那一格只带真答了的那一道');
    // 后续请求包含用户答复，证明本轮在收到答复后继续运行。
    assert.ok(JSON.stringify(requests[1].messages).includes('整份重写'), '答复进了模型的上下文');
  }, { interactive: true, answer: () => ({ answers: [{ id: 'q1', selected: ['整份重写'] }] }) });
});

// 逐次审批只针对工具操作；向用户提问本身不需要再经过审批。
test('the asking tool answers one question request and no approval request even on the ask tier', async () => {
  await withAskingHost(async (connection, { seen }) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: '第一轮' });
    assert.deepEqual([...new Set(seen.map((message) => message.method))], ['question.request'], '这一条链上只来过提问');
    const { events } = await connection.request('session.read', { sessionId }) as { events: ToolEvent[] };
    assert.equal(events.find((event) => event.kind === 'tool')!.verdict.via, 'unasked', '记录里说清这一步为什么没走档位');
  }, { interactive: true, policy: { mode: 'ask' }, answer: () => ({ answers: [{ id: 'q1', custom: '就地补那几条' }] }) });
});

test('the plain command line does not carry a tool nobody can answer', async () => {
  await withAskingHost(async (connection, { requests, seen }) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: '第一轮' });
    assert.ok(!requests[0].tools.some((tool) => tool.name === 'ask_user_question'), '这一路不登记那件工具');
    assert.equal(seen.filter((message) => message.method === 'question.request').length, 0, '没有请求发出去');
    const { events } = await connection.request('session.read', { sessionId }) as { events: ToolEvent[] };
    const result = events.find((event) => event.kind === 'tool');
    assert.equal(result?.result.failed, true, '模型那一次调用按一次失败收掉');
    assert.equal(result?.result.code, 'tool_not_found');
  }, { interactive: false });
});

test('cancelling the round settles the waiting question with its own code', async () => {
  await withAskingHost(async (connection, { seen }) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    const running = connection.request('run.start', { sessionId, input: '第一轮' });
    // 等待问题送达客户端后再取消，模拟用户主动取消提问。
    for (let tries = 0; tries < 400 && seen.length === 0; tries += 1) await new Promise((done) => setTimeout(done, 10));
    await connection.request('run.cancel', { sessionId });
    // 整轮以 `loop_cancelled` 结束，同时工具结果保留提问调用自身的结果码。
    await running.catch((error) => assert.equal((error as { code?: string }).code, 'loop_cancelled'));
    const { events } = await connection.request('session.read', { sessionId }) as { events: ToolEvent[] };
    const result = events.find((event) => event.kind === 'tool' && event.tool === 'ask_user_question');
    assert.equal(result?.result.failed, true, '取消之后这一次调用不是成功结果');
    assert.equal(result?.result.code, 'ask_user_cancelled', '取消说的是取消这件事，不冒充别的失败');
  }, { interactive: true });
});
