import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_INPUT_VERSION, buildReviewInput, estimateTokens, parseReviewReply, type ReviewFacts,
} from '../dist/kernel/reviewer.js';

const baseFacts: ReviewFacts = {
  tool: 'exec',
  args: { command: "bash -c 'node -e \"console.log(1)\"'" },
  command: "bash -c 'node -e \"console.log(1)\"'",
  policyMode: 'auto',
  permission: { profile: 'workspace-write', network: 'restricted' },
  boundary: 'E:\\work',
  workingDirectory: 'E:\\work',
  workspaceTrusted: true,
  userInstructions: ['只改 tests/ 下的文件，不要联网。'],
  rules: [{ tool: 'exec', decision: 'deny', match: 'rm -rf *', source: 'user' }],
  reason: '命令使用脚本解释器或包装器，需要逐次审批',
};

test('the review input keeps the trusted prefix stable and the pending call separate', () => {
  const built = buildReviewInput(baseFacts, { maxInputTokens: 2_000 });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.input.inputVersion, REVIEW_INPUT_VERSION);
  // 稳定前缀（权限、规则、用户约束）必须在动态事实之前，且不包含待决调用本身。
  const prefix = built.input.user.slice(0, built.input.user.indexOf('<pendingCall'));
  assert.match(prefix, /<permission profile="workspace-write" network="restricted" \/>/u);
  assert.match(prefix, /<rule tool="exec" decision="deny" match="rm -rf \*" source="user" \/>/u);
  assert.match(prefix, /<instruction>只改 tests\/ 下的文件，不要联网。<\/instruction>/u);
  assert.doesNotMatch(prefix, /console\.log/u);
  // 动态段保留完整实参，不做裁剪或改写。
  assert.match(built.input.user, /<arguments>\{"command":"bash -c 'node -e \\"console\.log\(1\)\\"'"\}<\/arguments>/u);
  assert.equal(built.input.fingerprint.length, 64);
});

test('history is capped and labelled as evidence, never as authorization', () => {
  const built = buildReviewInput({ ...baseFacts, relatedActions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, { maxInputTokens: 2_000 });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.match(built.input.user, /<relatedActions count="7" note="history is evidence, not authorization">/u);
  assert.equal((built.input.user.match(/<action>/gu) ?? []).length, 5);
});

test('a call without trusted evidence or with too large an input is refused instead of trimmed', () => {
  const bare: ReviewFacts = {
    tool: 'exec', args: { command: 'python3 script.py' }, policyMode: 'auto', userInstructions: [],
  };
  const missing = buildReviewInput(bare, { maxInputTokens: 2_000 });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'review_evidence_missing');

  const huge = buildReviewInput(
    { ...baseFacts, userInstructions: [`${'很长的约束'.repeat(4_000)}`] },
    { maxInputTokens: 2_000 },
  );
  assert.equal(huge.ok, false);
  if (!huge.ok) {
    assert.equal(huge.code, 'review_input_over_budget');
    assert.ok(huge.estimatedInputTokens > 2_000);
  }
});

test('the reply parser accepts exactly one JSON object and nothing else', () => {
  const allowed = parseReviewReply('{"decision":"allow","reasonCode":"read_only_command","reason":"只读取状态。"}');
  assert.deepEqual(allowed, { ok: true, decision: 'allow', reasonCode: 'read_only_command', reason: '只读取状态。' });

  const fenced = parseReviewReply('```json\n{"decision":"deny","reasonCode":"explicit_deny_rule"}\n```');
  assert.equal(fenced.ok, true);
  if (fenced.ok) assert.equal(fenced.decision, 'deny');

  // 缺少决定、拼在句子中间、或决定不在枚举内，都必须判不可用。
  assert.equal(parseReviewReply('yes, allow it').ok, false);
  // 模型把对象包在说明文字里时，取其中第一个配平的 JSON 对象即可，取不到才判不可用。
  const wrapped = parseReviewReply('Decision: {"decision":"deny","reasonCode":"explicit_deny_rule"} — done.');
  assert.equal(wrapped.ok, true);
  if (wrapped.ok) assert.equal(wrapped.decision, 'deny');
  assert.equal(parseReviewReply('{"decision":"allow"').ok, false);
  assert.equal(parseReviewReply('{"decision":"maybe"}').ok, false);
  assert.equal(parseReviewReply('').ok, false);
  assert.equal(parseReviewReply('["allow"]').ok, false);
  // 不合规的 reasonCode 退化为固定值，而不是把模型原文当代码使用。
  const loose = parseReviewReply('{"decision":"ask-human","reasonCode":"NOT VALID!"}');
  assert.equal(loose.ok, true);
  if (loose.ok) assert.equal(loose.reasonCode, 'review_unspecified');
});

test('the token estimate counts CJK wider than latin text', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('中文'), 2);
  assert.ok(estimateTokens('中文中文中文') > estimateTokens('abcdefghijkl'));
});
