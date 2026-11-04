import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionReviewer, reviewerSettings } from '../dist/host/reviewer.js';
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
    provider: providerOf([
      { type: 'text', text: '{"decision":"allow","reasonCode":"read_only_python","reason":"只读取文件。"}' },
      { type: 'usage', input: 150, output: 20 },
      { type: 'finish' },
    ]),
    factsOf: () => facts,
  });
  const outcome = await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto' });
  assert.equal(outcome.decision, 'allow');
  assert.equal(outcome.reasonCode, 'read_only_python');
  assert.equal(outcome.inputVersion, 1);
  assert.equal(outcome.fingerprint?.length, 64);
  const usage = reviewer.usage();
  assert.equal(usage.calls, 1);
  assert.equal(usage.outputTokens, 20);
  assert.ok((usage.inputTokens ?? 0) >= 150);
});

test('every unusable reply turns into ask-human instead of an approval', async () => {
  const invalid = createSessionReviewer({
    settings, provider: providerOf([{ type: 'text', text: 'sure, go ahead' }]), factsOf: () => facts,
  });
  const unusable = await invalid.review({ tool: 'exec', input: facts.args, policy: 'auto' });
  assert.equal(unusable.decision, 'ask-human');
  assert.equal(unusable.reasonCode, 'review_reply_truncated');
  assert.equal(invalid.usage().failures, 1);

  const toolCalling = createSessionReviewer({
    settings, provider: providerOf([{ type: 'tool-call', name: 'exec', input: { command: 'rm -rf /' } }]), factsOf: () => facts,
  });
  const escaped = await toolCalling.review({ tool: 'exec', input: facts.args, policy: 'auto' });
  assert.equal(escaped.decision, 'ask-human');
  assert.equal(escaped.reasonCode, 'review_reply_invalid');
});

test('a failing or hanging provider reports ask-human and keeps counting failures', async () => {
  const broken: ModelProvider = {
    stream: async function* () { throw new Error('connect ECONNREFUSED'); },
  } as unknown as ModelProvider;
  const failing = createSessionReviewer({ settings, provider: broken, factsOf: () => facts });
  const failed = await failing.review({ tool: 'exec', input: facts.args, policy: 'auto' });
  assert.equal(failed.decision, 'ask-human');
  assert.equal(failed.reasonCode, 'review_failed');

  const hanging: ModelProvider = {
    stream: async function* (_request, options) {
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
  const slow = createSessionReviewer({ settings: { ...settings, timeoutMs: 50 }, provider: hanging, factsOf: () => facts });
  const timedOut = await slow.review({ tool: 'exec', input: facts.args, policy: 'auto' });
  assert.equal(timedOut.decision, 'ask-human');
  assert.equal(timedOut.reasonCode, 'review_timeout');
});

test('the per-run budget and the input budget stop calls before they are made', async () => {
  const reviewer = createSessionReviewer({
    settings,
    provider: providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }]),
    factsOf: () => facts,
  });
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, policy: 'auto' })).decision, 'allow');
  assert.equal((await reviewer.review({ tool: 'exec', input: facts.args, policy: 'auto' })).decision, 'allow');
  const exhausted = await reviewer.review({ tool: 'exec', input: facts.args, policy: 'auto' });
  assert.equal(exhausted.decision, 'ask-human');
  assert.equal(exhausted.reasonCode, 'review_budget_exhausted');
  assert.equal(reviewer.usage().calls, 2);

  const overBudget = createSessionReviewer({
    settings: { ...settings, maxInputTokens: 20 },
    provider: providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }]),
    factsOf: () => facts,
  });
  const refused = await overBudget.review({ tool: 'exec', input: facts.args, policy: 'auto' });
  assert.equal(refused.decision, 'ask-human');
  assert.equal(refused.reasonCode, 'review_input_over_budget');
  assert.equal(overBudget.usage().calls, 0);
});

test('the reviewer reports its own usage once, whatever the endpoint says', async () => {
  const recorded: { purpose?: string; input?: number | null; output?: number | null }[] = [];
  const reviewer = createSessionReviewer({
    settings,
    provider: providerOf([
      { type: 'text', text: '{"decision":"allow","reasonCode":"read_only_python"}' },
      { type: 'usage', input: 80, output: 5 },
      { type: 'finish' },
    ]),
    factsOf: () => facts,
    onUsage: (event) => { recorded.push(event as { purpose?: string; input?: number | null; output?: number | null }); },
  });
  const outcome = await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto' });
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
    provider: providerOf([{ type: 'text', text: '{"decision":"allow","reasonCode":"ok"}' }, { type: 'finish' }]),
    factsOf: () => facts,
  });
  const first = await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto' });
  assert.equal(first.decision, 'allow');
  const afterFirst = reviewer.usage().inputTokens ?? 0;
  assert.ok(afterFirst > 0, '端点没报输入时退回估算，否则预算形同虚设');
  await reviewer.review({ tool: 'exec', input: facts.args, command: 'python3 script.py', policy: 'auto' });
  const afterSecond = reviewer.usage().inputTokens ?? 0;
  // 每次只加一份估算；若重复计入，第二次调用后会是四倍而不是两倍。
  assert.equal(afterSecond - afterFirst, afterFirst, '每次调用只记一份输入');
});

test('the reviewer stays disabled until the configuration asks for it', () => {
  assert.equal(reviewerSettings({}), undefined);
  assert.equal(reviewerSettings({ reviewer: { enabled: false, model: 'x' } }), undefined);
  const enabled = reviewerSettings({ reviewer: { enabled: true, model: 'reviewer-model', baseURL: 'http://127.0.0.1:1/v1', maxPerRun: 3 } });
  assert.equal(enabled?.model, 'reviewer-model');
  assert.equal(enabled?.maxPerRun, 3);
  // 未写的预算取默认值，写坏的值也退回默认值而不是变成 0 或负预算。
  assert.equal(enabled?.maxInputTokens, 2_000);
  assert.equal(enabled?.maxOutputTokens, 400);
  assert.equal(reviewerSettings({ reviewer: { enabled: true, maxPerRun: -1 } })?.maxPerRun, 8);
});
