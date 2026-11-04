import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionReviewer, narrowReviewerSettings, reviewerRouteFields, reviewerSettings } from '../dist/host/reviewer.js';
import type { ModelProvider } from '../dist/kernel/loop.js';
import type { ReviewFacts } from '../dist/kernel/reviewer.js';

const facts: ReviewFacts = {
  tool: 'exec',
  args: { command: 'python3 script.py' },
  command: 'python3 script.py',
  policyMode: 'auto',
  permission: { profile: 'workspace-write', network: 'restricted' },
  boundary: 'E:\\work',
  workingDirectory: 'E:\\work',
  workspaceTrusted: true,
  userInstructions: ['只改 tests/ 下的文件。'],
  rules: [{ tool: 'exec', decision: 'deny', match: 'rm -rf *', source: 'user' }],
  reason: '命令使用脚本解释器',
};

function providerOf(...responses: readonly (readonly unknown[])[]): ModelProvider {
  let index = 0;
  return {
    stream: async function* () {
      const events = responses[Math.min(index, responses.length - 1)];
      index += 1;
      for (const event of events) yield event as never;
    },
  } as unknown as ModelProvider;
}

const settings = {
  maxInputTokens: 2_000, maxOutputTokens: 400, timeoutMs: 1_000, maxPerRun: 2, maxTotalTokens: 40_000,
} as const;

test('a usable reply becomes a recorded allow with its fingerprint', async () => {
  const reviewer = createSessionReviewer({
    settings,
    provider: () => providerOf([
      { type: 'text', text: '{"decision":"allow","reasonCode":"read_only_python","reason":"只读取文件。"}' },
      { type: 'usage', input: 150, output: 20 },
      { type: 'finish' },
    ]),
    factsOf: () => facts,
  });
  const outcome = await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto', reason: undefined });
  assert.equal(outcome.decision, 'allow');
  assert.equal(outcome.reasonCode, 'read_only_python');
  assert.equal(outcome.inputVersion, 2);
  assert.equal(outcome.fingerprint?.length, 64);
  const usage = reviewer.usage();
  assert.equal(usage.calls, 1);
  assert.equal(usage.outputTokens, 20);
  assert.ok((usage.inputTokens ?? 0) >= 150);
});

test('every unusable reply turns into ask-human instead of an approval', async () => {
  const invalid = createSessionReviewer({
    settings, provider: () => providerOf([{ type: 'text', text: 'sure, go ahead' }]), factsOf: () => facts,
  });
  const unusable = await invalid.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(unusable.decision, 'ask-human');
  // 纯正文不是“截断”，是格式不合规；只有括号没配平才算截断。
  assert.equal(unusable.reasonCode, 'review_reply_invalid');
  assert.equal(invalid.usage().failures, 1);

  const truncated = createSessionReviewer({
    settings, provider: () => providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"' }]), factsOf: () => facts,
  });
  const cut = await truncated.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(cut.decision, 'ask-human');
  assert.equal(cut.reasonCode, 'review_reply_truncated');

  const toolCalling = createSessionReviewer({
    settings, provider: () => providerOf([{ type: 'tool-call', name: 'exec', input: { command: 'rm -rf /' } }]), factsOf: () => facts,
  });
  const escaped = await toolCalling.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(escaped.decision, 'ask-human');
  assert.equal(escaped.reasonCode, 'review_reply_invalid');
});

test('a failing or hanging provider reports ask-human and keeps counting failures', async () => {
  const broken: ModelProvider = {
    stream: async function* () { throw new Error('connect ECONNREFUSED'); },
  } as unknown as ModelProvider;
  const failing = createSessionReviewer({ settings, provider: () => broken, factsOf: () => facts });
  const failed = await failing.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(failed.decision, 'ask-human');
  assert.equal(failed.reasonCode, 'review_failed');

  const hanging: ModelProvider = {
    stream: async function* (_request: unknown, options?: { signal?: AbortSignal }) {
      // 真实 Provider 会响应中止信号；假 Provider 也必须遵守，否则测不出超时分支。
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
      yield { type: 'text', text: '{"decision":"allow","reasonCode":"late"}' } as never;
    },
  } as unknown as ModelProvider;
  const slow = createSessionReviewer({ settings: { ...settings, timeoutMs: 50 }, provider: () => hanging, factsOf: () => facts });
  const timedOut = await slow.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(timedOut.decision, 'ask-human');
  assert.equal(timedOut.reasonCode, 'review_timeout');
});

test('the per-run budget and the input budget stop calls before they are made', async () => {
  const reviewer = createSessionReviewer({
    settings,
    provider: () => providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }]),
    factsOf: () => facts,
  });
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined })).decision, 'allow');
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined })).decision, 'allow');
  const exhausted = await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(exhausted.decision, 'ask-human');
  assert.equal(exhausted.reasonCode, 'review_budget_exhausted');
  assert.equal(reviewer.usage().calls, 2);

  const overBudget = createSessionReviewer({
    settings: { ...settings, maxInputTokens: 20 },
    provider: () => providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }]),
    factsOf: () => facts,
  });
  const refused = await overBudget.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(refused.decision, 'ask-human');
  assert.equal(refused.reasonCode, 'review_input_over_budget');
  assert.equal(overBudget.usage().calls, 0);
});

test('the reviewer reports its own usage once, whatever the endpoint says', async () => {
  const recorded: { purpose?: string; input?: number | null; output?: number | null }[] = [];
  const reviewer = createSessionReviewer({
    settings,
    provider: () => providerOf([
      { type: 'text', text: '{"decision":"allow","reasonCode":"read_only_python"}' },
      { type: 'usage', input: 80, output: 5 },
      { type: 'finish' },
    ]),
    factsOf: () => facts,
    onUsage: (event) => { recorded.push(event as { purpose?: string; input?: number | null; output?: number | null }); },
  });
  const outcome = await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto', reason: undefined });
  assert.equal(outcome.decision, 'allow');
  // 复审的 token 要单独成账，主 Agent 与会话汇总才能按用途分开。
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.purpose, 'reviewer');
  assert.equal(recorded[0]?.input, 80);
  // 估算只用于准入检查：端点报回 80 就只能记 80，重复叠加会让预算提前耗尽、用量报大。
  assert.equal(reviewer.usage().inputTokens, 80);
});

test('a reply without usage still counts the estimate exactly once', async () => {
  const reviewer = createSessionReviewer({
    settings: { ...settings, maxTotalTokens: 40_000 },
    provider: () => providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }, { type: 'finish' }]),
    factsOf: () => facts,
  });
  const first = await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto', reason: undefined });
  assert.equal(first.decision, 'allow');
  const afterFirst = reviewer.usage().inputTokens ?? 0;
  assert.ok(afterFirst > 0, '端点没报输入时退回估算，否则预算形同虚设');
  await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto', reason: undefined });
  const afterSecond = reviewer.usage().inputTokens ?? 0;
  // 每次只加一份估算；若重复计入，第二次调用后会是四倍而不是两倍。
  assert.equal(afterSecond - afterFirst, afterFirst, '每次调用只记一份输入');
});

test('the per-run limit is reset by beginRun, not exhausted by the whole session', async () => {
  const reviewer = createSessionReviewer({
    settings: { ...settings, maxPerRun: 1 },
    provider: () => providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }]),
    factsOf: () => facts,
  });
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined })).decision, 'allow');
  // 同一轮内第二次必须被拦下。
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined })).reasonCode, 'review_budget_exhausted');
  // 新一轮开始后额度恢复：长会话里复审不能因为前几轮用过就永久失效。
  reviewer.beginRun();
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined })).decision, 'allow');
  assert.equal(reviewer.usage().calls, 2);
});

test('output tokens count against the total budget, not just the input', async () => {
  const reviewer = createSessionReviewer({
    // 输出 5000 + 预留 400 已经超过 5000 的总预算，但只看输入（100）时会误判为还有额度。
    settings: { ...settings, maxTotalTokens: 5_000, maxPerRun: 5 },
    provider: () => providerOf([
      { type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' },
      { type: 'usage', input: 100, output: 5_000 },
      { type: 'finish' },
    ]),
    factsOf: () => facts,
  });
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined })).decision, 'allow');
  const again = await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(again.decision, 'ask-human');
  assert.equal(again.reasonCode, 'review_budget_exhausted');
});

test('a request whose endpoint reports nothing still shows up with unknown counts', async () => {
  const recorded: { purpose?: string; input?: number | null; output?: number | null }[] = [];
  const reviewer = createSessionReviewer({
    settings,
    provider: () => providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }, { type: 'finish' }]),
    factsOf: () => facts,
    onUsage: (event) => { recorded.push(event as { purpose?: string; input?: number | null; output?: number | null }); },
  });
  await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  // 端点完全不报用量时也要留一条 reviewer 请求：否则 /usage 会说“复审一次都没调过”。
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.purpose, 'reviewer');
  assert.equal(recorded[0]?.input, null);
  assert.equal(recorded[0]?.output, null);
});

test('the reviewer stays disabled until the configuration asks for it', () => {
  assert.equal(reviewerSettings({}), undefined);
  assert.equal(reviewerSettings({ reviewer: { enabled: false } }), undefined);
  // 只有布尔真值才算启用：字符串 "true" 不会悄悄打开付费请求。
  assert.equal(reviewerSettings({ reviewer: { enabled: 'true' } }), undefined);
  const enabled = reviewerSettings({ reviewer: { enabled: true, maxPerRun: 3 } });
  assert.equal(enabled?.maxPerRun, 3);
  // 未写的预算取默认值，写坏的值也退回默认值而不是变成 0 或负预算。
  assert.equal(enabled?.maxInputTokens, 2_000);
  assert.equal(enabled?.maxOutputTokens, 400);
  assert.equal(reviewerSettings({ reviewer: { enabled: true, maxPerRun: -1 } })?.maxPerRun, 8);
  // 复审不再有独立路由：残留字段被列出来，由 Host 明确拒绝。
  assert.deepEqual(reviewerRouteFields({ reviewer: { enabled: true, model: 'm', baseURL: 'http://x' } }), ['model', 'baseURL']);
  assert.deepEqual(reviewerRouteFields({ reviewer: { enabled: true } }), []);
  assert.deepEqual(reviewerRouteFields({}), []);
  // 项目层只能收紧预算，不能放大。
  assert.deepEqual(
    narrowReviewerSettings(
      { maxInputTokens: 4_000, maxOutputTokens: 800, timeoutMs: 20_000, maxPerRun: 8, maxTotalTokens: 80_000 },
      { maxInputTokens: 2_000, maxOutputTokens: 400, timeoutMs: 10_000, maxPerRun: 4, maxTotalTokens: 40_000 },
    ),
    { maxInputTokens: 2_000, maxOutputTokens: 400, timeoutMs: 10_000, maxPerRun: 4, maxTotalTokens: 40_000 },
  );
});

test('every review asks the host for the current session route', async () => {
  let routeCalls = 0;
  const seen: string[] = [];
  const reviewer = createSessionReviewer({
    settings,
    provider: () => {
      routeCalls += 1;
      // 依次返回两条不同的“服务”：复审必须每次现取，不能缓存创建会话时的那一条。
      const name = `provider-${routeCalls}`;
      seen.push(name);
      return {
        name,
        stream: async function* () {
          yield { type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' } as never;
          yield { type: 'finish' } as never;
        },
      } as unknown as ModelProvider;
    },
    factsOf: () => facts,
  });
  await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(routeCalls, 2, '复审不能缓存创建会话时的 Provider');
  assert.deepEqual(seen, ['provider-1', 'provider-2'], '每一轮的复审都走该轮 Run 的 Session 模型路由');
});

test('a pending review holds its budget so a parallel one cannot overspend', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocking = {
    stream: async function* () {
      await gate;
      yield { type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' } as never;
      yield { type: 'usage', input: 1, output: 1 } as never;
      yield { type: 'finish' } as never;
    },
  } as unknown as ModelProvider;
  const reviewer = createSessionReviewer({
    settings: { ...settings, maxPerRun: 5, maxTotalTokens: 1_200 },
    provider: () => blocking,
    factsOf: () => facts,
  });
  const first = reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  await Promise.resolve();
  const second = await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
  assert.equal(second.decision, 'ask-human', '并发复审不能同时看到同一份余额');
  assert.equal(second.reasonCode, 'review_budget_exhausted');
  release?.();
  assert.equal((await first).decision, 'allow');
});

test('a route that fails before the request never spends budget', async () => {
  const reviewer = createSessionReviewer({
    settings,
    // 路由取不到说明请求没发出去：既不能占额度，也不能记成一次复审。
    provider: () => { throw new Error('no session route'); },
    factsOf: () => facts,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await reviewer.review({ tool: 'exec', input: facts.args, command: undefined, policy: 'auto', reason: undefined });
    assert.equal(outcome.decision, 'ask-human');
    assert.equal(outcome.reasonCode, 'review_unavailable');
  }
  assert.equal(reviewer.usage().calls, 0, '没有发出的请求不算一次复审');
  assert.equal(reviewer.usage().inputTokens, 0, '没有发出的请求不能占用输入预算');
  assert.equal(reviewer.usage().failures, 3);
});
