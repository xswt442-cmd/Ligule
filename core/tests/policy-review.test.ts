import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionChain } from '../dist/index.js';
import type { PolicyQuestion, PolicyReviewRecord, PolicyReviewRequest } from '../dist/kernel/policy.js';

// `auto` 下只有“确定性策略认不出命令形状”这一种不确定可以交给复审。
// 这一组用例把可交与不可交的边界钉死，避免复审变成通用放行开关。
const interpreterCall = { tool: 'exec', input: { command: 'python3 script.py' }, access: 'exec' } as const;

function reviewer(answer: PolicyReviewRecord | Error): { review: (request: PolicyReviewRequest) => Promise<PolicyReviewRecord>; requests: PolicyReviewRequest[] } {
  const requests: PolicyReviewRequest[] = [];
  return {
    requests,
    review: async (request) => {
      requests.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test('auto hands an unrecognised command shape to the reviewer and uses its allow', async () => {
  const asked: PolicyQuestion[] = [];
  const { review, requests } = reviewer({ decision: 'allow', reasonCode: 'read_only_python' });
  const chain = createDecisionChain({ mode: 'auto', review, ask: async (question) => { asked.push(question); return false; } });
  const verdict = await chain.evaluate(interpreterCall);
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.via, 'auto-reviewer');
  assert.equal(verdict.review?.decision, 'allow');
  assert.equal(asked.length, 0, '复审允许时不应再问人');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].policy, 'auto');
  assert.equal(requests[0].command, 'python3 script.py');
});

test('a reviewer deny stays a deny and never becomes an approval', async () => {
  const { review } = reviewer({ decision: 'deny', reasonCode: 'writes_outside_tests' });
  const chain = createDecisionChain({ mode: 'auto', review, ask: async () => true });
  const verdict = await chain.evaluate(interpreterCall);
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.via, 'auto-reviewer');
  assert.equal(verdict.code, 'writes_outside_tests');
});

test('ask-human, a throwing reviewer and an unavailable channel all fall back to asking', async () => {
  const human = reviewer({ decision: 'ask-human', reasonCode: 'ambiguous' });
  const asked: PolicyQuestion[] = [];
  const chain = createDecisionChain({
    mode: 'auto', review: human.review, ask: async (question) => { asked.push(question); return true; },
  });
  const verdict = await chain.evaluate(interpreterCall);
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.via, 'ask');
  assert.equal(asked.length, 1);

  const failing = reviewer(new Error('provider 429'));
  const withError = createDecisionChain({ mode: 'auto', review: failing.review, ask: async () => true });
  assert.equal((await withError.evaluate(interpreterCall)).via, 'ask');

  // 复审不可用且没有问人的通道时，必须显式报 unavailable，不能静默放行。
  const noChannel = createDecisionChain({ mode: 'auto', review: reviewer(new Error('429')).review });
  const unavailable = await noChannel.evaluate(interpreterCall);
  assert.equal(unavailable.decision, 'deny');
  assert.equal(unavailable.code, 'ask_unavailable');
});

test('only auto consults the reviewer', async () => {
  for (const mode of ['ask', 'never', 'always'] as const) {
    const { review, requests } = reviewer({ decision: 'allow', reasonCode: 'read_only' });
    const chain = createDecisionChain({ mode, review, ask: async () => false });
    await chain.evaluate(interpreterCall);
    assert.equal(requests.length, 0, `${mode} 不应调用复审`);
  }
});

test('a rule-based ask and a private network target are human checkpoints, not reviewer input', async () => {
  const ruleAsk = reviewer({ decision: 'allow', reasonCode: 'read_only' });
  const chain = createDecisionChain({
    mode: 'auto',
    rules: [{ tool: 'exec', decision: 'ask', match: 'python3 *' }],
    review: ruleAsk.review,
    ask: async () => false,
  });
  assert.equal((await chain.evaluate(interpreterCall)).via, 'ask');
  assert.equal(ruleAsk.requests.length, 0, '规则要求审批时不能交给模型改判');

  const network = reviewer({ decision: 'allow', reasonCode: 'read_only' });
  const scoped = createDecisionChain({ mode: 'auto', review: network.review, ask: async () => false });
  await scoped.evaluate({ tool: 'exec', input: { command: 'curl http://127.0.0.1:8080/' }, access: 'external' });
  assert.equal(network.requests.length, 0, '私有网络目标必须由人确认');
});

test('a verdict that arrives after the rules changed is discarded', async () => {
  const asked: PolicyQuestion[] = [];
  let chain: ReturnType<typeof createDecisionChain> | undefined;
  const built = createDecisionChain({
    mode: 'auto',
    ask: async (question) => { asked.push(question); return false; },
    review: async () => {
      // 复审是异步的：结论回来之前规则被收紧，这个 allow 就不能再用。
      chain?.setRules([{ tool: 'exec', decision: 'deny', match: 'python3 *' }]);
      return { decision: 'allow', reasonCode: 'read_only_python', fingerprint: 'f', inputVersion: 2 };
    },
  });
  chain = built;
  const verdict = await built.evaluate(interpreterCall);
  assert.notEqual(verdict.decision, 'allow', '规则收紧后旧结论必须作废');
  // 作废不是忽略：等待期间新增的 deny 必须当场生效，而不是退回可被批准的路径。
  assert.equal(verdict.decision, 'deny', 'waiting for the reviewer must not skip a new deny rule');
  assert.equal(verdict.rule, 'python3 *');
  assert.equal(asked.length, 0, 'a matching deny does not need to ask the human');
  assert.equal(verdict.review, undefined);
});

test('a verdict with an unrelated rule change still falls back to the human', async () => {
  const asked: PolicyQuestion[] = [];
  let chain: ReturnType<typeof createDecisionChain> | undefined;
  const built = createDecisionChain({
    mode: 'auto',
    ask: async (question) => { asked.push(question); return false; },
    review: async () => {
      // 收紧的规则与这一次调用无关：结论作废，但不必由它来拒绝。
      chain?.setRules([{ tool: 'exec', decision: 'deny', match: 'rm -rf *' }]);
      return { decision: 'allow', reasonCode: 'read_only_python', fingerprint: 'f', inputVersion: 2 };
    },
  });
  chain = built;
  const verdict = await built.evaluate(interpreterCall);
  assert.equal(verdict.decision, 'deny');
  assert.equal(asked.length, 1, 'an unrelated change drops the review and asks the human');
  assert.equal(verdict.review, undefined);
});
