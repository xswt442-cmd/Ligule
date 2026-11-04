// 验证上下文压缩的触发条件、截断位置和校准行为。
// 端点是本地假的那一个：要验的是「什么时候压、压完投影是什么、压几次」，不是某一家端点的报错文案。
import test from 'node:test';
import { estimateRequest } from '../dist/session/compaction.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_LIMITS,
  KernelError,
  compactionLimitsOf,
  createCompaction,
  createConfig,
  createKernel,
  createLoop,
  createSessionLog,
  cutPoint,
  estimateTokens,
  loadCheckpointFile,
} from '../dist/index.js';
import { resolveModel } from '../dist/kernel/model-services.js';
import type { LoopCompactionRequest, ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import type { SessionEvent } from '../dist/session/format.js';
import type { SessionLog } from '../dist/session/session.js';

const SUMMARY = 'SUMMARY OF THE EARLIER TURNS';
const LONG = 'x'.repeat(2000);
const limits = { contextTokens: 4_000, compactThresholdRatio: 0.8, compactRetainRatio: 0.16, resultBytes: 16_000 };
const kernel = createKernel();
const prompt = { render: () => 'the system prefix' };

type LimitConfig = Parameters<typeof compactionLimitsOf>[0];
type Recorded = SessionEvent & {
  readonly text?: string;
  readonly reason?: string;
  readonly ignorable?: boolean;
  readonly blockId?: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly input?: number | null;
  readonly output?: number | null;
  readonly estimated?: number;
  readonly measurement?: string;
  readonly cache?: { readonly hitInputTokens?: number | null; readonly uncachedInputTokens?: number | null };
};
// 假提供方只读请求里的消息文本：脚本化回答只需要这一格。
type SeenRequest = { readonly messages: readonly { readonly text?: string }[] };

// 假提供方：按脚本回答。看见那句摘要指令就答摘要，否则按 script 依次交事件或抛错。
function fakeProvider(script: readonly (readonly ProviderEvent[] | Error)[], summaryText: string = SUMMARY) {
  const seen: SeenRequest[] = [];
  let index = 0;
  let summaries = 0;
  return {
    seen,
    summaries: () => summaries,
    model: 'fake',
    capabilities: {},
    async *stream(request: ModelRequest): AsyncGenerator<ProviderEvent> {
      const seenRequest = request as unknown as SeenRequest;
      seen.push(seenRequest);
      if (String(seenRequest.messages?.[0]?.text ?? '').startsWith('Write a summary')) {
        summaries += 1;
        yield { type: 'text', text: summaryText };
        return;
      }
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      for (const event of next) yield event;
    },
  };
}

async function withSession(run: (context: { readonly directory: string; readonly id: string; readonly session: SessionLog }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-compaction-'));
  const id = 'compacting-session';
  const session = createSessionLog({ directory, id });
  try {
    return await run({ directory, id, session });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 攒出足够长的一段历史，让投影的本地估算越得过那条线。
async function fill(session: SessionLog, rounds: number) {
  for (let round = 0; round < rounds; round += 1) {
    await session.append({ kind: 'user', text: `问题 ${round} ${LONG}` });
    await session.append({ kind: 'assistant', text: `答 ${round} ${LONG}`, toolCalls: [] });
  }
}

test('the cut point lands on a user or assistant event and keeps the tail under the budget', () => {
  const events = [
    { seq: 0, kind: 'user', text: LONG },
    { seq: 1, kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', args: {} }] },
    { seq: 2, kind: 'tool', tool: 'read', callId: 'c1', result: { failed: false, content: LONG } },
    { seq: 3, kind: 'user', text: LONG },
    { seq: 4, kind: 'assistant', text: LONG },
  ];
  // 预算只放得下最后一条时，切点往后落到 4 号那条 assistant：切在 2 号那条工具结果上会留下没人回答的调用。
  assert.equal(cutPoint(events, estimateTokens(events[4])), 4);
  assert.equal(cutPoint(events, 1), 4);
  // 预算装得下整段时不切。
  assert.equal(cutPoint(events, 10_000), null);
});

test('pressure over the line compacts once and the next request carries the summary', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 4);
    const logBefore = await readFile(join(directory, `${id}.jsonl`), 'utf8');
    const lines = logBefore.trim().split('\n').length;
    const logged: Record<string, unknown>[] = [];
    const logger = { log: (message: string, fields: Record<string, unknown> = {}) => logged.push({ message, ...fields }) };
    const provider = fakeProvider([[{ type: 'text', text: 'continued' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits, logger });

    const result = await createLoop({ kernel, provider, prompt, session, compaction }).run('再问一句', {});
    assert.equal(result.text, 'continued');

    const read = await loadCheckpointFile({ directory, id, events: await session.read() });
    assert.equal(read.reason, '', 'the blocks the compaction wrote match the log');
    assert.equal(read.blocks.length, 1);
    assert.equal(read.blocks[0].text, SUMMARY);
    assert.equal(read.blocks[0].blockId, 1);
    const last = (await session.read()).at(-1)!;
    assert.ok(read.blocks[0].fromSeq >= 0 && read.blocks[0].toSeq < last.seq);

    const sent = provider.seen.at(-1)!;
    assert.equal(sent.messages[0].text, SUMMARY, 'the covered range is replaced by the summary');
    assert.equal(sent.messages.at(-1)!.text, '再问一句', 'the input of this round is still there');

    const after = await readFile(join(directory, `${id}.jsonl`), 'utf8');
    // 本轮加用户、助手、轮次完成、压缩事实与一条“端点没报用量”的记录，块文件本身一条都不进日志。
    assert.equal(after.trim().split('\n').length, lines + 5, 'the round adds its own events plus one unknown usage record and no block content');
    const numbers = logged.find((entry) => entry.message === 'session compacted') as unknown as { tokensBefore: number; tokensAfter: number };
    assert.ok(numbers.tokensBefore > numbers.tokensAfter, 'a summary removes more than it adds');
  });
});

const overflow = new KernelError('provider_http_error', { detail: '400 the input is longer than the maximum context length' });

// 端点返回用量后才检查是否超出上下文预算；一轮最多压缩一次并重试一次。
test('an endpoint overflow answer gets one compaction and one retry', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const provider = fakeProvider([overflow, [{ type: 'text', text: 'after the retry' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const result = await createLoop({ kernel, provider, prompt, session, compaction }).run('继续', {});
    assert.equal(result.text, 'after the retry');
    assert.equal(provider.summaries(), 1, 'exactly one summary call');
    assert.equal((await loadCheckpointFile({ directory, id, events: await session.read() })).reason, '');
    // 那一次报超长之前没压过：压力那一条量的是本地估算，这一段还没越线。
    assert.equal(provider.seen.filter((request) => String(request.messages?.[0]?.text ?? '') === SUMMARY).length, 1);
  });
});

test('a second overflow answer does not buy a second compaction', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const provider = fakeProvider([overflow, overflow]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    await assert.rejects(
      createLoop({ kernel, provider, prompt, session, compaction }).run('继续', {}),
      (error: unknown) => (error as { code?: string }).code === 'provider_http_error',
    );
    assert.equal(provider.summaries(), 1, 'the one allowed compaction is spent');
  });
});

test('successive turns each have their own overflow recovery budget on one compaction instance', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const provider = fakeProvider([overflow, [{ type: 'text', text: 'first recovered' }], overflow, [{ type: 'text', text: 'second recovered' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const loop = createLoop({ kernel, provider, prompt, session, compaction });
    assert.equal((await loop.run('first')).text, 'first recovered');
    await fill(session, 2);
    assert.equal((await loop.run('second')).text, 'second recovered');
    assert.equal(provider.summaries(), 2);
  });
});

test('reported compaction size uses the exact shared model projection', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 4);
    const provider = fakeProvider([]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const result = await compaction.compactNow();
    assert.ok(result);
    assert.equal(result.tokensAfter, estimateTokens(await session.modelView()));
    assert.ok(result.tokensAfter < result.tokensBefore);
  });
});

// 不是超长的失败不压：那一格错误说的不是窗口不够。
test('a provider failure that is not about length leaves the record alone', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const provider = fakeProvider([new KernelError('provider_http_error', { detail: '400 invalid api key' })]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    await assert.rejects(
      createLoop({ kernel, provider, prompt, session, compaction }).run('继续', {}),
      (error: unknown) => {
        const failure = error as { code?: string; detail: string };
        return failure.code === 'provider_http_error' && failure.detail.includes('invalid api key');
      },
    );
    assert.equal(provider.summaries(), 0, 'no summary was asked for');
    assert.equal((await loadCheckpointFile({ directory, id, events: await session.read() })).reason, 'checkpoint_absent');
  });
});

// 当端点报告的用量高于本地估算时，后续压缩应更早触发。
test('the local estimate is corrected by the usage the endpoint reports back', async () => {
  await withSession(async ({ directory, id, session }) => {
    const kernel = createKernel({ session: { directory, append: session.append.bind(session) } });
    kernel.register({ name: 'noop', description: 'Record a completed no-op', parameters: { type: 'object', properties: {} }, run: () => ({ ok: true }) });
    await session.append({ kind: 'user', text: '短'.repeat(200) });
    await session.append({ kind: 'assistant', text: '也短'.repeat(200) });
    const provider = fakeProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'noop', args: {} },
        { type: 'usage', input: 12_000, output: 20 },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [{ type: 'text', text: '第二轮' }, { type: 'finish', reason: 'stop' }],
    ]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const result = await createLoop({ kernel, provider, prompt, session, compaction }).run('第三句', {});
    assert.equal(result.text, '第二轮');
    // 按本地的字节数这一份远不到线，是修正系数让压力那一条在第二次请求之前响起来。
    assert.ok(estimateTokens(await session.read()) < limits.contextTokens * limits.compactThresholdRatio);
    assert.equal(provider.summaries(), 1, 'the corrected estimate triggers the pressure line');
    assert.equal((await session.modelView() as { text?: string }[])[0].text, SUMMARY);
  });
});

// 复审的用量与主 Agent 记进同一份记录：压缩的校准与“最近一次模型用量”只认主 Agent 的账。
// 旧记录没有 `purpose`，按主 Agent 解释；只有复审用量时不产生校准。
test('reviewer usage never calibrates the main agent context', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    await session.append({ kind: 'usage', ignorable: true, measurement: 'request-v1', input: 12_000, output: 20, estimated: 1_000 });
    await session.append({ kind: 'usage', ignorable: true, purpose: 'reviewer', measurement: 'request-v1', input: 4_000, output: 10, estimated: 100 });
    // 新的实例模拟重启：校准与最近用量都只能从记录里读。
    const restarted = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const context = await restarted.context();
    assert.equal(context.factor, 12, '校准来自主 Agent 的那条用量');
    assert.equal(context.reported?.input, 12_000, '最近一次模型用量仍是主 Agent 的');
    assert.equal(context.reported?.output, 20);
  });
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    await session.append({ kind: 'usage', ignorable: true, purpose: 'reviewer', measurement: 'request-v1', input: 9_000, output: 10, estimated: 100 });
    const reviewerOnly = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const context = await reviewerOnly.context();
    assert.equal(context.factor, 1, '只有复审用量时不校准');
    assert.equal(context.reported, null, '主 Agent 还没有用量');
  });
});

// 压缩块只保存摘要和事件范围；被压缩的事件仍保留在会话日志中。
test('the block file carries no disclosure state and the log keeps every event', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 4);
    await session.append({ kind: 'mode', name: 'full', layer: 'shipped', tools: ['read'], digest: 'aaaaaaaaaaaa', path: '/x/full.toml' });
    const provider = fakeProvider([[{ type: 'text', text: 'ok' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    await createLoop({ kernel, provider, prompt, session, compaction }).run('一句', {});

    const raw = JSON.parse(await readFile(join(directory, `${id}.checkpoint.json`), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['blocks', 'formatVersion', 'inputVersion', 'sessionId']);
    assert.deepEqual(Object.keys(raw.blocks[0]).sort(), ['blockId', 'digest', 'fromSeq', 'text', 'toSeq']);
    const events = await session.read();
    assert.equal(events.filter((event) => event.kind === 'mode').length, 1, 'a mode event is not anything the summary swallows');
    assert.ok(events.length > (await loadCheckpointFile({ directory, id, events })).blocks[0].toSeq, 'no event left the log');
  });
});

// 连续压缩追加新块；已有块保持不变，新块请求把上一块摘要作为输入。
test('the next compaction appends a block after the kept boundary and feeds the previous summary in', async () => {
  await withSession(async ({ directory, id, session }) => {
    const provider = fakeProvider([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }], [{ type: 'text', text: 'three' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const loop = createLoop({ kernel, provider, prompt, session, compaction });
    assert.equal((await loadCheckpointFile({ directory, id, events: await session.read() })).reason, 'checkpoint_absent');

    await fill(session, 4);
    await loop.run('A', {});
    const first = await loadCheckpointFile({ directory, id, events: await session.read() });
    assert.equal(first.reason, '');
    assert.equal(first.blocks.length, 1);

    await fill(session, 4);
    await loop.run('B', {});
    const second = await loadCheckpointFile({ directory, id, events: await session.read() });
    assert.equal(second.reason, '');
    assert.equal(second.blocks.length, 2);
    assert.deepEqual(second.blocks[0], first.blocks[0], 'the first block is untouched');
    assert.equal(second.blocks[1].fromSeq, first.blocks[0].toSeq + 1, 'the new block starts after the kept boundary');
    assert.equal(second.blocks[1].blockId, 2);
    assert.ok(second.blocks[1].toSeq > first.blocks[0].toSeq, 'the second compaction covers further into the log');
    const excerpt = provider.seen.filter((request) => String(request.messages?.[0]?.text ?? '').startsWith('Write a summary')).at(-1)!;
    const instruction = String(excerpt.messages[0].text);
    assert.match(instruction, /Earlier summary:\nSUMMARY/, 'the previous summary is part of the input');
    assert.match(instruction, /the language the conversation is written in/, '摘要正文跟着这份转录的语言写');
    assert.match(instruction, /exactly as it appeared/, '路径、命令与标识符留原文');
  });
});

// 摘要文本也受上下文预算限制；超出时写入溢出文件，并在检查点中保留引用。
test('an oversized summary spills to a file with a retrievable reference', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 4);
    const provider = fakeProvider([[{ type: 'text', text: 'ok' }]], 'y'.repeat(40_000));
    const compaction = createCompaction({ provider, session, directory, id, limits: { ...limits, resultBytes: 2_000 } });
    await createLoop({ kernel, provider, prompt, session, compaction }).run('一句', {});
    const text = (await loadCheckpointFile({ directory, id, events: await session.read() })).blocks[0].text;
    const reference = /full output is 40000 bytes, kept in (\S+)\]/.exec(text);
    assert.ok(reference, `the checkpoint keeps a reference: ${text.slice(-80)}`);
    assert.ok((await readFile(join(directory, reference[1]), 'utf8')).startsWith('yyyy'));
  });
});

// 未配置上下文窗口时不启用压缩；压缩阈值和保留比例可以使用默认值，
// 窗口大小是模型事实——猜大了会让摘要请求自己超窗，所以没配置的人正常聊天照跑而不自动压。
test('compaction stays off until the model window is configured', () => {
  assert.equal(compactionLimitsOf(createConfig({ user: { limits: {} } }) as unknown as LimitConfig), undefined);
  assert.equal((DEFAULT_LIMITS as { readonly contextTokens?: number }).contextTokens, undefined, 'the window has no shipped default to fall back on');
  assert.equal(compactionLimitsOf(createConfig({ user: { limits: { contextTokens: 128_000 } } }) as unknown as LimitConfig)!.compactRetainRatio, 0.16);
  for (const written of [
    { contextTokens: 0 },
    { contextTokens: '128000' },
    { contextTokens: 128_000, compactThresholdRatio: 0 },
    { contextTokens: 128_000, compactRetainRatio: 0.9 },
    { contextTokens: 128_000, compactThresholdRatio: 2 },
  ]) {
    assert.throws(
      () => compactionLimitsOf(createConfig({ user: { limits: written } }) as unknown as LimitConfig),
      (error: unknown) => (error as { code?: string }).code === 'host_compaction_limits_invalid',
      `${JSON.stringify(written)} is refused rather than silently disabling the line`,
    );
  }
});

test('service model context changes the compaction window with the selected model', () => {
  const services = [{
    id: 'local', name: 'Local', api: 'chat-completions', baseURL: 'https://example.test/v1', apiKeyEnv: 'KEY', models: ['small', 'large'],
    modelSettings: [{ id: 'small', contextTokens: 24000 }, { id: 'large', contextTokens: 96000 }],
  }];
  const config = createConfig({ user: { model: { services }, limits: {} } });
  const small = resolveModel(config.model as Record<string, unknown>, { provider: 'local', model: 'small' });
  const large = resolveModel(config.model as Record<string, unknown>, { provider: 'local', model: 'large' });
  assert.equal(compactionLimitsOf(config as unknown as LimitConfig, small.serviceContextTokens)!.contextTokens, 24000);
  assert.equal(compactionLimitsOf(config as unknown as LimitConfig, large.serviceContextTokens)!.contextTokens, 96000);
});

// 输出与输入共用窗口：声明输出预算时提前触发，预留封顶为窗口的四分之一；
// 预留会把阈值压到保留预算之下时退回比例阈值，不因预留而停用压缩。
test('a declared output budget lowers the pressure threshold within a quarter of the window', async () => {
  await withSession(async ({ directory, id, session }) => {
    const contextOf = async (outputTokens?: number) => (await createCompaction({
      provider: fakeProvider([]), session, directory, id, limits: { ...limits, ...(outputTokens === undefined ? {} : { outputTokens }) },
    })).context();
    const bare = await contextOf(undefined);
    assert.deepEqual([bare.window, bare.threshold, bare.retained, bare.reserved], [4000, 3200, 640, 0], '没有声明就不预留');
    assert.equal((await contextOf(1000)).threshold, 3000, '0.8 本来是 3200，给输出留 1000 后是 3000');
    assert.equal((await contextOf(4000)).reserved, 1000, '声明超过窗口四分之一时，预留停在四分之一');
    const narrow = { contextTokens: 1000, compactThresholdRatio: 0.8, compactRetainRatio: 0.76, resultBytes: 16_000, outputTokens: 1000 };
    const corner = await createCompaction({ provider: fakeProvider([]), session, directory, id: `${id}-corner`, limits: narrow });
    assert.equal((await corner.context()).threshold, 800, '预留后低于保留预算，退回比例阈值');
  });
});

// 每次压缩都把块身份、范围与原因写进记录：界面与导出据此说明何时为什么压过。
test('each compaction appends its reason to the session record', async () => {
  await withSession(async ({ directory, id, session }) => {
    const provider = fakeProvider([[{ type: 'text', text: 'one' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const loop = createLoop({ kernel, provider, prompt, session, compaction });

    await fill(session, 4);
    await loop.run('A', {});
    let written = (await session.read()).filter((event) => event.kind === 'compaction') as Recorded[];
    assert.deepEqual(written.map((event) => [event.reason, event.blockId, event.ignorable]), [['auto', 1, true]]);
    assert.ok(written[0].tokensBefore > written[0].tokensAfter);

    await fill(session, 4);
    const done = await compaction.compactNow();
    assert.ok(done !== null);
    written = (await session.read()).filter((event) => event.kind === 'compaction') as Recorded[];
    assert.deepEqual(written.map((event) => [event.reason, event.blockId]), [['auto', 1], ['manual', 2]]);
  });
});

// 软阈值区间内先以请求尾部临时消息提醒模型自行压缩：不写记录、不重复打扰、压力回落后重新允许。
test('the soft band appends one ephemeral reminder instead of compacting', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    await session.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: 0, iterations: 1, modelCalls: 1 });
    const compaction = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const context = await compaction.context();
    const soft = context.soft;
    // 构造估算恰好落在软档内的请求：估算 ≈ JSON 字节 / 4。
    const inBand = [{ role: 'user', text: 'x'.repeat(Math.floor(soft * 4) - 40) }];
    const before = (await session.read()).length;

    const reminded = await compaction.prepare({ system: '', tools: [], messages: inBand });
    assert.equal(reminded.length, inBand.length + 1, '软档内追加一条提醒');
    const note = reminded.at(-1) as { readonly role?: string; readonly text: string };
    assert.equal(note.role, 'user');
    assert.match(note.text, /Context usage reminder/);
    assert.match(note.text, /compact tool/);
    assert.equal((await session.read()).length, before, '提醒不写入记录');

    const quiet = await compaction.prepare({ system: '', tools: [], messages: inBand });
    assert.equal(quiet.length, inBand.length, '同一压力进程内不重复提醒');

    const below = await compaction.prepare({ system: '', tools: [], messages: [{ role: 'user', text: 'hi' }] });
    assert.equal(below.length, 1, '压力回落后不带提醒');
    const again = await compaction.prepare({ system: '', tools: [], messages: inBand });
    assert.equal(again.length, inBand.length + 1, '回落之后重新允许提醒一次');
  });
});

// 端点报告的用量写入会话记录，界面和恢复流程都从记录中读取。
test('the usage an endpoint reports lands in the record and never in the projection', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const compaction = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const messages = await session.modelView();
    await compaction.observe({ messages } as unknown as LoopCompactionRequest, [{ type: 'usage', input: 1200, output: 80 }]);
    const usage = (await session.read()).at(-1) as Recorded;
    assert.equal(usage.kind, 'usage');
    assert.equal(usage.ignorable, true, '读不懂它的旧程序略过这一条，而不是拒绝打开这份记录');
    assert.deepEqual([usage.input, usage.output], [1200, 80]);
    assert.equal(usage.estimated, estimateRequest({ messages }), '估算保留完整请求的结构');
    assert.equal(usage.measurement, 'request-v1');
    // 投影里没有它的位置：它不是模型说过的话，也不是工具结果。
    assert.deepEqual((await session.modelView()).map((entry) => (entry as { role?: string }).role), ['user', 'assistant', 'user', 'assistant']);
    // 一条都没报回时仍留一条未知记录：次数要算得清，数值保持 null，绝不当成 0。
    const before = (await session.read()).length;
    await compaction.observe({ messages } as unknown as LoopCompactionRequest, [{ type: 'text', text: 'no usage here' }]);
    const after = await session.read();
    assert.equal(after.length, before + 1, 'a request without reported usage still leaves one record');
    const unknown = after.at(-1) as Recorded;
    assert.equal(unknown.kind, 'usage');
    assert.equal(unknown.purpose, 'agent');
    assert.deepEqual([unknown.input, unknown.output], [null, null], 'missing numbers stay unknown instead of becoming zero');
  });
});

// 重开会话后应从最后一条用量记录恢复估算系数。
test('a fresh compaction over a record that carries usage starts calibrated', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const local = estimateRequest({ messages: await session.modelView() });
    await session.append({ kind: 'usage', ignorable: true, input: local * 3, output: 10, estimated: local, measurement: 'request-v1' });
    const compaction = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const context = await compaction.context();
    assert.equal(context.factor, 3);
    assert.equal(context.estimated, local * 3);
    assert.deepEqual([context.window, context.threshold, context.retained], [4000, 3200, 640]);
    assert.deepEqual([context.reported!.input, context.reported!.output], [local * 3, 10]);
  });
});

test('cache usage without a reported input total is retained without calibrating to zero', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const local = estimateRequest({ messages: await session.modelView() });
    const compaction = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const before = await compaction.context();
    await compaction.observe({ messages: await session.modelView() } as unknown as LoopCompactionRequest, [{ type: 'usage', input: null, output: 9, cache: {
      source: 'anthropic-messages', sourceFields: [
        { field: 'cache_read_input_tokens', tokens: 18 }, { field: 'cache_creation_input_tokens', tokens: 7 },
      ], hitInputTokens: 18, missInputTokens: null, creationInputTokens: 7,
      uncachedInputTokens: null, providerInputIncludesCache: false, consistent: null,
    } }]);

    const usage = (await session.read()).at(-1) as Recorded;
    assert.equal(usage.kind, 'usage');
    assert.equal(usage.input, null);
    assert.equal(usage.output, 9);
    assert.equal(usage.estimated, local);
    assert.equal(usage.cache!.hitInputTokens, 18);
    const after = await compaction.context();
    assert.equal(after.factor, before.factor, 'unknown totals must not change the estimator calibration');
    assert.deepEqual(after.reported, { seq: usage.seq, input: null, output: 9, cache: usage.cache });
  });
});

test('a latest unknown usage retains the most recent usable calibration after reopening', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const local = estimateRequest({ messages: await session.modelView() });
    await session.append({ kind: 'usage', ignorable: true, input: local * 4, output: 8, estimated: local, measurement: 'request-v1' });
    await session.append({ kind: 'usage', ignorable: true, input: null, output: 9, estimated: local + 1, measurement: 'request-v1',
      cache: { source: 'anthropic-messages', sourceFields: [{ field: 'input_tokens', tokens: local + 1 }],
        hitInputTokens: null, missInputTokens: null, creationInputTokens: null, uncachedInputTokens: local + 1,
        providerInputIncludesCache: false, consistent: null } });

    const restarted = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const context = await restarted.context();
    assert.equal(context.factor, 4);
    assert.equal(context.reported!.input, null, 'the latest raw input remains unknown as a total');
    assert.equal(context.reported!.cache!.uncachedInputTokens, local + 1);
  });
});

// 手动和自动压缩使用相同的摘要流程；无法压缩时返回明确结果。
test('a manual compaction writes the same checkpoint and says when there is nothing to cut', async () => {
  await withSession(async ({ directory, id, session }) => {
    const compaction = createCompaction({ provider: fakeProvider([], 'MANUAL SUMMARY'), session, directory, id, limits });
    assert.equal(await compaction.compactNow(), null, '一段可切的边界都还没有时不写检查点');
    await fill(session, 3);
    const done = await compaction.compactNow();
    assert.ok(done !== null && done.toSeq >= done.fromSeq && done.tokensAfter < done.tokensBefore);
    const read = await loadCheckpointFile({ directory, id, events: await session.read() });
    assert.equal(read.reason, '', '手动写出去的那一份与日志对得上');
    assert.equal(read.blocks[0].text, 'MANUAL SUMMARY');
    assert.equal((await session.modelView() as { text?: string }[])[0].text, 'MANUAL SUMMARY', '压完的投影第一段就是那份摘要');
  });
});

// 摘要比将被压缩的历史更长时不应压缩，否则模型读到的内容反而更多，
// 而它顶掉的那一段再也不会被读到——压不动就说清压不动。
test('a summary that would not shrink the projection is refused', async () => {
  await withSession(async ({ directory, id, session }) => {
    for (let round = 0; round < 4; round += 1) {
      await session.append({ kind: 'user', text: `第 ${round} 问` });
      await session.append({ kind: 'assistant', text: `第 ${round} 答`, toolCalls: [] });
    }
    const logged: Record<string, unknown>[] = [];
    const compaction = createCompaction({
      provider: fakeProvider([], 'A '.repeat(400)),
      session,
      directory,
      id,
      limits: { contextTokens: 1000, compactThresholdRatio: 0.8, compactRetainRatio: 0.05, resultBytes: 16_000 },
      logger: { log: (message: string, fields: Record<string, unknown> = {}) => logged.push({ message, ...fields }) },
    });
    assert.equal(await compaction.compactNow(), null);
    assert.ok(logged.some((entry) => String(entry.message).includes('would not shrink')), '要说清为什么没压');
    await assert.rejects(() => readFile(join(directory, `${id}.checkpoint.json`), 'utf8'), '没写出检查点');
  });
});

// 不参与模型投影的轮次标记和用量事件不计入保留量，也不会移动截断位置。
test('the cut point ignores events that never reach the model', () => {
  const long = (count: number) => 'x'.repeat(count);
  const mixed = [
    { seq: 0, kind: 'user', text: long(1200) },
    { seq: 1, kind: 'turn', ignorable: true, status: 'completed' },
    { seq: 2, kind: 'assistant', text: long(1200) },
    { seq: 3, kind: 'usage', ignorable: true, input: 10, output: 5, estimated: 12 },
    { seq: 4, kind: 'assistant', text: long(1200) },
    { seq: 5, kind: 'mode', name: 'full' },
    { seq: 6, kind: 'assistant', text: long(1200) },
  ];
  const projected = mixed.filter((event) => ['user', 'assistant', 'tool'].includes(event.kind));
  const cut = cutPoint(mixed, 700);
  assert.equal(cut, cutPoint(projected, 700), '同一份历史，插不插那些事件都切在同一处');
  assert.ok(cut !== null && cut > 0, '这份样例要真切出一刀来，等号才不是两个 null 相等');
});
