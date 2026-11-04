import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionChain } from '../dist/index.js';
import { policyArgsHash } from '../dist/kernel/policy.js';
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

test('a denial threshold tightening during a review discards the verdict', async () => {
  const asked: PolicyQuestion[] = [];
  let chain: ReturnType<typeof createDecisionChain> | undefined;
  const built = createDecisionChain({
    mode: 'auto',
    thresholds: { consecutive: 1, total: 1 },
    ask: async (question) => { asked.push(question); return false; },
    review: async () => {
      // 复审等待期间另一个调用被硬拒绝：连续拒绝阈值把语义收紧成 ask，
      // 但 mode 仍然是 auto，只有把 forcedToAsk 也算进签名才能发现这次收紧。
      await chain?.evaluate({ tool: 'exec', input: { command: 'rm -rf /tmp/ligule-x' }, command: 'rm -rf /tmp/ligule-x', access: 'exec' } as never);
      return { decision: 'allow', reasonCode: 'read_only_python', fingerprint: 'f', inputVersion: 2 };
    },
  });
  chain = built;
  const verdict = await built.evaluate(interpreterCall);
  assert.equal(verdict.review, undefined, '收紧之后的复审结论必须作废');
  assert.equal(verdict.via, 'ask', '作废后回到人工审批，而不是拿旧结论放行');
  // 并发的那次调用自己也可能问过一次人，这里只要求这次调用确实回到了人工。
  assert.ok(asked.length >= 1);
});

test('a deny rule added while the review throws still denies the pending call', async () => {
  let chain: ReturnType<typeof createDecisionChain> | undefined;
  const built = createDecisionChain({
    mode: 'auto',
    ask: async () => true,
    review: async () => {
      // 复审自己失败了，但等待期间新写的拒绝规则必须当场生效，不能被异常绕过。
      chain?.setRules([{ tool: 'exec', decision: 'deny', match: 'python3 *', reason: '解释器被临时禁止' }]);
      throw new Error('provider 429');
    },
  });
  chain = built;
  const verdict = await built.evaluate(interpreterCall);
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.via, 'rule');
  assert.equal(verdict.code, 'policy_denied');
});

test('a deny rule scoped to these exact arguments still applies after a review', async () => {
  const scoped = policyArgsHash({ command: 'python3 script.py' });
  let chain: ReturnType<typeof createDecisionChain> | undefined;
  const built = createDecisionChain({
    mode: 'auto',
    ask: async () => true,
    review: async () => {
      // 只针对这一组参数的拒绝同样有效：重验不能只看不带范围的规则。
      chain?.setRules([{ tool: 'exec', decision: 'deny', argsHash: scoped, reason: '这一组参数被拒绝' }]);
      return { decision: 'allow', reasonCode: 'read_only_python', fingerprint: 'f', inputVersion: 2 };
    },
  });
  chain = built;
  const verdict = await built.evaluate(interpreterCall);
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.via, 'rule');
});

test('a deny rule for another tool never rejects the pending call', async () => {
  const asked: PolicyQuestion[] = [];
  let chain: ReturnType<typeof createDecisionChain> | undefined;
  const built = createDecisionChain({
    mode: 'auto',
    ask: async (question) => { asked.push(question); return true; },
    review: async () => {
      // 等待期间新增的是 write 的 deny，与这次 exec 调用无关。
      chain?.setRules([{ tool: 'write', decision: 'deny', reason: 'file writes are off' }]);
      return { decision: 'allow', reasonCode: 'read_only_python', fingerprint: 'f', inputVersion: 2 };
    },
  });
  chain = built;
  const verdict = await built.evaluate(interpreterCall);
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.via, 'ask', '无关的 deny 不能当成命中，只能回到人工审批');
  assert.notEqual(verdict.code, 'policy_denied');
  assert.equal(asked.length, 1);
});
