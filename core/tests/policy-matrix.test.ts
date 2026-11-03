import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createDecisionChain } from '../dist/index.js';
import type { PolicyCall, PolicyMode, PolicyQuestion, PolicyRule } from '../dist/kernel/policy.js';

// 本文件把 P9.5 的四档契约写成可执行的决策矩阵。每一行是一个真实工具调用形态，
// 每一列是一个档位下预期的结论：是否执行、走哪条路径、是否问了人。
// 契约定义见 testplace/v0.1.2/dev-doc/v0.1.2-p9.5.md 的 W1 矩阵。
const MODES: readonly PolicyMode[] = ['always', 'ask', 'auto', 'never'];
const root = process.cwd();

interface Expectation {
  readonly decision: 'allow' | 'deny';
  readonly via: string;
  readonly asked: boolean;
}

interface Row {
  readonly name: string;
  readonly call: PolicyCall;
  readonly rules?: PolicyRule[];
  readonly thresholds?: { consecutive: number; total: number };
  readonly guard?: (call: { tool: string; input: unknown; command?: string }) => string | undefined;
  // 部分行需要先制造历史（例如触发拒绝阈值）再判定本行调用。
  readonly before?: (chain: { evaluate(input: PolicyCall): Promise<unknown> }) => Promise<void>;
  // 行内未列出的档位沿用 `defaults`，避免把 44 个格子全部手写。
  readonly defaults: Record<PolicyMode, Expectation>;
  readonly overrides?: Partial<Record<PolicyMode, Expectation>>;
}

function expectations(row: Row): Record<PolicyMode, Expectation> {
  return { ...row.defaults, ...row.overrides };
}

async function judge(row: Row, mode: PolicyMode) {
  const calls: PolicyQuestion[] = [];
  const chain = createDecisionChain({
    mode,
    rules: row.rules ?? [],
    ...(row.thresholds === undefined ? {} : { thresholds: row.thresholds }),
    ask: async (question) => { calls.push(question); return true; },
  });
  if (row.guard !== undefined) chain.guard(row.guard);
  if (row.before !== undefined) await row.before(chain);
  const verdict = await chain.evaluate(row.call);
  return { verdict, asked: calls.length };
}

function matrix(rows: Row[]): void {
  for (const row of rows) {
    for (const mode of MODES) {
      const expected = expectations(row)[mode];
      // 断言失败时把档位和行名带进消息，便于定位矩阵中的具体格子。
      const label = `${mode} / ${row.name}`;
      test(label, async () => {
        const { verdict, asked } = await judge(row, mode);
        assert.equal(verdict.decision, expected.decision, `${label}: decision`);
        assert.equal(verdict.via, expected.via, `${label}: via`);
        assert.equal(asked > 0, expected.asked, `${label}: whether the user was asked`);
      });
    }
  }
}

const ask = (via = 'ask'): Expectation => ({ decision: 'allow', via, asked: true });
const auto = (via = 'auto'): Expectation => ({ decision: 'allow', via, asked: false });
const never: Expectation = { decision: 'allow', via: 'never', asked: false };

matrix([
  {
    name: 'an ordinary file read',
    call: { tool: 'read', input: { path: 'notes.md' }, access: 'read' },
    defaults: { always: ask(), ask: ask(), auto: auto(), never },
  },
  {
    name: 'a file create covered by a remembered allow',
    call: { tool: 'create', input: { path: 'app.ts', content: 'ok' }, access: 'write', fileBoundary: root, workingDirectory: root },
    rules: [{ tool: 'create', decision: 'allow', target: 'file', path: join(root, 'app.ts') }],
    // `always` 不因已记住的批准免问；`ask` 用规则回答；`auto` 走确定性放行；`never` 不看规则表。
    defaults: { always: ask(), ask: { decision: 'allow', via: 'rules', asked: false }, auto: auto(), never },
  },
  {
    name: 'a git command through exec',
    call: { tool: 'exec', input: { command: 'git status' }, access: 'exec' },
    defaults: { always: ask(), ask: ask(), auto: auto(), never },
  },
  {
    name: 'a git command covered by a command allow rule',
    call: { tool: 'exec', input: { command: 'git status' }, access: 'exec' },
    rules: [{ tool: 'exec', decision: 'allow', match: 'git *' }],
    defaults: { always: ask(), ask: { decision: 'allow', via: 'rules', asked: false }, auto: auto(), never },
  },
  {
    name: 'an interpreter command that cannot be bound safely',
    call: { tool: 'exec', input: { command: 'python3 script.py' }, access: 'exec' },
    // 解释器不接受自动放行：`auto` 转为审批，`never` 只跳过审批层本身。
    defaults: { always: ask(), ask: ask(), auto: ask(), never },
  },
  {
    name: 'a deny rule that contradicts an allow rule',
    call: { tool: 'exec', input: { command: 'git push --force' }, access: 'exec' },
    rules: [
      { tool: 'exec', decision: 'allow', match: 'git push*' },
      { tool: 'exec', decision: 'deny', match: 'git push --force*', reason: 'force pushing rewrites shared history' },
    ],
    // `never` 是唯一不读规则表的档位，但它是显式选择跳过 Policy 层的结果。
    defaults: { always: { decision: 'deny', via: 'rule', asked: false }, ask: { decision: 'deny', via: 'rule', asked: false }, auto: { decision: 'deny', via: 'rule', asked: false }, never },
  },
  {
    name: 'an ask rule that forces approval',
    call: { tool: 'exec', input: { command: 'curl https://example.com' }, access: 'exec' },
    rules: [{ tool: 'exec', decision: 'ask', match: 'curl*', reason: 'network calls need a look' }],
    defaults: { always: ask(), ask: ask(), auto: ask(), never },
  },
  {
    name: 'a hard-denied deletion',
    call: { tool: 'exec', input: { command: 'rm -rf ~/*' }, access: 'exec' },
    // 硬拒绝在各档位都一样：它属于执行前置条件，不随审批层一起消失。
    defaults: {
      always: { decision: 'deny', via: 'hard-deny', asked: false },
      ask: { decision: 'deny', via: 'hard-deny', asked: false },
      auto: { decision: 'deny', via: 'hard-deny', asked: false },
      never: { decision: 'deny', via: 'hard-deny', asked: false },
    },
  },
  {
    name: 'a guard that refuses the call',
    call: { tool: 'write', input: { path: 'secrets.env' }, access: 'write' },
    guard: ({ input }) => typeof input === 'object' && input !== null && String((input as { path?: unknown }).path).endsWith('.env') ? 'environment files stay off limits' : undefined,
    defaults: {
      always: { decision: 'deny', via: 'guard', asked: false },
      ask: { decision: 'deny', via: 'guard', asked: false },
      auto: { decision: 'deny', via: 'guard', asked: false },
      never: { decision: 'deny', via: 'guard', asked: false },
    },
  },
  {
    name: 'a script whose bytes changed after binding',
    call: { tool: 'exec', input: { command: 'node tool.js' }, access: 'exec', scriptBindingError: { code: 'script_binding_changed', detail: 'the bound script changed on disk' } },
    defaults: {
      always: { decision: 'deny', via: 'script-binding', asked: false },
      ask: { decision: 'deny', via: 'script-binding', asked: false },
      auto: { decision: 'deny', via: 'script-binding', asked: false },
      never: { decision: 'deny', via: 'script-binding', asked: false },
    },
  },
  {
    name: 'a link-local network target',
    call: {
      tool: 'fetch', input: { url: 'http://169.254.169.254/latest/meta-data' }, access: 'network',
      target: { url: 'http://169.254.169.254/latest/meta-data', scheme: 'http:', host: '169.254.169.254', port: '80', path: '/latest/meta-data', addresses: ['169.254.169.254'], class: 'link-local', failure: undefined },
    },
    // 云元数据端点在任何档位都不取回，`never` 也不会把它放行。
    defaults: {
      always: { decision: 'deny', via: 'target', asked: false },
      ask: { decision: 'deny', via: 'target', asked: false },
      auto: { decision: 'deny', via: 'target', asked: false },
      never: { decision: 'deny', via: 'target', asked: false },
    },
  },
  {
    name: 'a private network target',
    call: {
      tool: 'fetch', input: { url: 'http://192.168.1.10/' }, access: 'network',
      target: { url: 'http://192.168.1.10/', scheme: 'http:', host: '192.168.1.10', port: '80', path: '/', addresses: ['192.168.1.10'], class: 'private', failure: undefined },
    },
    // 环回和私有地址至少要有人看过一次；`never` 是显式跳过，因此照常发出。
    defaults: { always: ask(), ask: ask(), auto: ask(), never },
  },
  {
    name: 'a call that requires manual approval by classification',
    call: { tool: 'custom', input: {}, access: 'external', requiresManualApproval: true },
    defaults: { always: ask(), ask: ask(), auto: ask(), never },
  },
  {
    name: 'the question tool itself',
    call: { tool: 'ask_user_question', input: {}, access: 'interaction' },
    // 提问通道不属于审批层，四档都不能关掉它。
    defaults: {
      always: { decision: 'allow', via: 'unasked', asked: false },
      ask: { decision: 'allow', via: 'unasked', asked: false },
      auto: { decision: 'allow', via: 'unasked', asked: false },
      never: { decision: 'allow', via: 'unasked', asked: false },
    },
  },
  {
    name: 'a call tightened by the denial threshold',
    call: { tool: 'read', input: { path: 'again.md' }, access: 'read' },
    rules: [{ tool: 'exec', decision: 'deny', match: 'rm *' }],
    // 先制造一次拒绝，让 forcedToAsk 生效；随后普通调用在 ask 档被拉回审批。
    thresholds: { consecutive: 1, total: 1 },
    before: async (chain) => { await chain.evaluate({ tool: 'exec', input: { command: 'rm -rf /tmp/blocked' }, access: 'exec' }); },
    defaults: { always: ask(), ask: ask(), auto: ask(), never },
  },
]);

test('a denial threshold does not survive a never override', async () => {
  const chain = createDecisionChain({ mode: 'ask', thresholds: { consecutive: 1, total: 1 }, rules: [{ tool: 'exec', decision: 'deny', match: 'rm *' }], ask: async () => true });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm -rf /tmp/x' } })).via, 'rule');
  assert.equal(chain.denials().consecutive, 1);
  // 切到 never 后不再计入审批收紧：它本来就跳过整个审批层。
  chain.setMode('never');
  const verdict = await chain.evaluate({ tool: 'read', input: { path: 'x.md' }, access: 'read' });
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.via, 'never');
});

test('an unavailable approval channel is reported as such, never as an approval', async () => {
  const chain = createDecisionChain({ mode: 'ask' });
  const verdict = await chain.evaluate({ tool: 'read', input: { path: 'x.md' }, access: 'read' });
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.via, 'ask');
  assert.equal(verdict.code, 'ask_unavailable');
});

test('never runs the calls its approval layer used to hold back, and says so', async () => {
  // `never` 的契约是跳过整个审批层：即便自动分析认为需要逐次批准，也不产生审批请求。
  const neverChain = createDecisionChain({ mode: 'never' });
  const deletions: PolicyQuestion[] = [];
  const scoped = await neverChain.evaluate({ tool: 'exec', input: { command: 'rm -rf ./dist' }, access: 'exec' });
  assert.equal(scoped.decision, 'allow');
  assert.equal(scoped.via, 'never');
  const interpreter = await neverChain.evaluate({ tool: 'exec', input: { command: 'python3 script.py' }, access: 'exec' });
  assert.equal(interpreter.via, 'never');
  assert.equal(deletions.length, 0);

  // 同样的调用在 `auto` 下转为审批，说明跳过审批是 `never` 独有的，而不是分析器放行了它们。
  const asked: PolicyQuestion[] = [];
  const autoChain = createDecisionChain({ mode: 'auto', ask: async (question) => { asked.push(question); return false; } });
  assert.equal((await autoChain.evaluate({ tool: 'exec', input: { command: 'rm -rf ./dist' }, access: 'exec' })).code, 'ask_declined');
  assert.equal((await autoChain.evaluate({ tool: 'exec', input: { command: 'python3 script.py' }, access: 'exec' })).code, 'ask_declined');
  assert.equal(asked.length, 2);
});
