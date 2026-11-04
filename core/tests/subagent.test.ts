// 派生会话复用同一套策略判定，不会把 `subagent` 工具暴露给自身，并写入独立分支记录。
// 内核、判定链、会话记录与循环都是真的；提供方按脚本回答，因为它只负责把「下一步做什么」这件事说出来。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  KernelError, createConfig, createDecisionChain, createKernel, createLoop, createSessionLog, createSubagentPlugin,
  createPermissionContext, minimalPlugin, networkPlugin,
  createTaskBudget,
} from '../dist/index.js';
import type { ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import type { SubagentDeps } from '../dist/tools/subagent.js';

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

// 脚本化的帧：`message_start` 只是让提供方的回答形状贴近真实端点，其余字段由用例给出。
type FixtureEvent = {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly message?: unknown;
};
// 派生结果按测试读到的字段收窄；工具结果本身仍是内核返回的原值。
type SubagentOutcome = {
  readonly text: string;
  readonly sessionId: string;
  readonly iterations: number;
  readonly mode?: string;
  readonly modeDigest?: string;
  readonly generation?: { readonly outputTokens?: number; readonly thinkingEffort?: string };
  readonly limits?: { readonly iterations?: number; readonly modelCalls?: number; readonly maxParallelTools?: number };
  readonly result: {
    readonly runId: string;
    readonly sessionId: string;
    readonly state: string;
    readonly stopReason: string;
    readonly output: { readonly text?: string; readonly structured?: unknown };
    readonly artifacts: readonly { readonly kind: string; readonly sessionId: string }[];
    readonly validation: { readonly status: string; readonly schemaDigest?: string; readonly errors: readonly string[] };
    readonly diagnostic?: { readonly code?: string };
  };
};
// 分支记录按测试读到的字段收窄；读到的仍是会话文件里的原值。
type RecordedEvent = {
  readonly kind?: string;
  readonly sessionId?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly status?: string;
  readonly code?: string;
  readonly delegationSchemaDigest?: unknown;
  readonly childGeneration?: unknown;
  readonly childLimits?: unknown;
  readonly mode: {
    readonly source?: string;
    readonly tools?: readonly string[];
    readonly prompt?: readonly string[];
    readonly digest?: string;
    readonly path?: string;
  };
  readonly result: {
    readonly code?: string;
    readonly content: { readonly sessionId?: string; readonly result?: { readonly state?: string } };
  };
};

const text = (value: string): FixtureEvent[] => [
  { type: 'message_start', message: { usage: {} } },
  { type: 'text', text: value },
];
const call = (name: string, args: Record<string, unknown>): FixtureEvent[] => [{ type: 'message_start', message: { usage: {} } }, { type: 'tool-call', id: `call_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args }];

function scripted(turns: readonly FixtureEvent[][]) {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    name: 'scripted',
    model: 'test-model',
    capabilities: {},
    async *stream(request: ModelRequest): AsyncGenerator<ProviderEvent> {
      requests.push(request);
      const events = turns[index] ?? text('nothing left to say');
      index += 1;
      for (const event of events) yield event as unknown as ProviderEvent;
    },
  };
}

// 父记录与派生记录都要真目录（记录是真的会话文件），跑完一起收掉。
const created: string[] = [];
async function tempDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}
after(() => Promise.all(created.map((directory) => rm(directory, { recursive: true, force: true }))));

async function workspace() {
  const directory = await tempDirectory('ligule-subagent-');
  await writeFile(join(directory, 'note.txt'), 'the body');
  return directory;
}

const readEvents = async (file: string) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as RecordedEvent);

test('a parent and its child pause their shared execution budget while the child waits for approval', { timeout: 15_000 }, async (t) => {
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
  t.after(() => {
    if (originalNow === undefined) delete (performance as { now?: () => number }).now;
    else Object.defineProperty(performance, 'now', originalNow);
  });
  // 用假单调时钟跨过执行期限，不让测试自身的启动时间耗尽预算。
  let monotonicNow = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => monotonicNow });
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const budget = createTaskBudget({ maxModelCalls: 8, timeoutMs: 60_000, requestTimeoutMs: 10_000, interactionWaitTimeoutMs: 120_000 });
  let signalApproval: (value?: unknown) => void = () => {};
  let releaseApproval: (value: { readonly decision: 'allow' } | PromiseLike<{ readonly decision: 'allow' }>) => void = () => {};
  const approvalStarted = new Promise((resolve) => { signalApproval = resolve; });
  const approval = new Promise<{ readonly decision: 'allow' }>((resolve) => { releaseApproval = resolve; });
  const chain = createDecisionChain({
    mode: 'auto',
    rules: [{ tool: 'read', decision: 'ask' }],
    ask: async () => {
      const end = budget.startInteraction();
      signalApproval();
      try { return await approval; }
      finally { end(); }
    },
  });
  const provider = scripted([
    call('subagent', { task: 'read the note' }),
    call('read', { path: 'note.txt' }),
    text('the child finished'),
    text('the parent finished'),
  ]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-budget-'), id: 'parent' });
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  minimalPlugin.setup(kernel);
  createSubagentPlugin({ config, provider, chain, taskBudget: () => budget,
    prompt: { staticPrefix: '' }, directory: session.directory, sessionId: 'parent', plugins: [minimalPlugin] }).setup(kernel);
  let run: Promise<{ readonly text: string }> | undefined;
  let approvalTimer: NodeJS.Timeout | undefined;
  try {
    run = createLoop({ kernel, provider, session }).run('delegate the task', { task: budget, signal: budget.signal });
    void run.catch(() => undefined);
    const approvalStartTimedOut = new Promise((_, reject) => {
      approvalTimer = setTimeout(() => reject(new Error('child did not reach approval')), 5_000);
    });
    await Promise.race([
      approvalStarted,
      run.then(() => { throw new Error('parent run completed before the child approval'); }, (error) => { throw error; }),
      approvalStartTimedOut,
    ]);
    clearTimeout(approvalTimer);

    monotonicNow = 61_000;
    const paused = budget.snapshot();
    assert.equal(paused.executionPaused, true);
    assert.equal(paused.executionElapsedMs, 0);
    assert.equal(paused.interactionWaitMs, 61_000);
    assert.equal(budget.signal.aborted, false);

    releaseApproval({ decision: 'allow' });
    const result = await run;
    assert.equal(result.text, 'the parent finished');
    assert.equal(budget.signal.aborted, false);
    assert.equal(budget.snapshot().interactionWaitMs, 61_000);
  } finally {
    if (approvalTimer !== undefined) clearTimeout(approvalTimer);
    releaseApproval({ decision: 'allow' });
    await run?.catch(() => undefined);
    budget.dispose();
  }
});

test('the derived agent runs on the parent decision chain and cannot delegate again', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary, limits: { execBytes: 2000 } } });
  const chain = createDecisionChain({
    mode: 'auto',
    rules: [{ tool: 'exec', decision: 'deny', match: 'rm *', reason: 'deleting through exec is not allowed' }],
  });
  const provider = scripted([
    call('subagent', { task: 'delete the thing' }),      // 父：派一块活
    call('exec', { command: 'rm -rf /tmp/nowhere' }),    // 子：想删东西，被同一条链挡下
    text('I could not delete it'),                       // 子：说完这一轮，交回一段文本
    text('the child reported back'),                     // 父：说完这一轮，交回一段文本
  ]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'parent' });
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  minimalPlugin.setup(kernel);
  networkPlugin.setup(kernel);
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: 'shared static prefix' },
    directory: session.directory,
    sessionId: 'parent',
    plugins: [minimalPlugin, networkPlugin],
  }).setup(kernel);

  const result = await kernel.call('subagent', { task: 'delete the thing' }) as SubagentOutcome;
  assert.equal(result.text, 'I could not delete it');
  assert.equal(result.sessionId, 'parent.sub-1');
  assert.equal(result.result.runId.length > 0, true);
  assert.equal(result.result.sessionId, result.sessionId);
  assert.equal(result.result.state, 'completed');
  assert.equal(result.result.stopReason, 'assistant_completed');
  assert.equal(result.result.output.text, result.text);
  assert.deepEqual(result.result.artifacts, [{ kind: 'session', sessionId: result.sessionId }]);
  assert.equal(result.iterations >= 2, true);
  // 子会话使用父会话的审批档位，拒绝次数也计入父会话。
  assert.equal(chain.denials().total >= 1, true);
  assert.equal(JSON.stringify(provider.requests[1].tools).includes('"subagent"'), false, '派生体不能再派');
  assert.ok(JSON.stringify(provider.requests[1].tools).includes('"read"'));
  assert.equal(provider.requests[1].system.startsWith('shared static prefix'), true, '静态前缀沿用父的那一份（D9）');

  const files = await readdir(session.directory);
  assert.deepEqual(files.sort(), ['parent.jsonl', 'parent.sub-1.jsonl']);
  const side = await readEvents(join(session.directory, 'parent.sub-1.jsonl'));
  // 分支记录首行说明父会话和派生关系。
  assert.equal(side[0].kind, 'session');
  assert.equal(side[0].sessionId, 'parent.sub-1');
  const sideEvents = side.filter((event) => event.kind !== 'session');
  assert.equal(sideEvents[0].kind, 'user');
  assert.equal(sideEvents[0].text, 'delete the thing');
  const denied = sideEvents.find((event) => event.kind === 'tool' && event.tool === 'exec');
  assert.equal(denied!.result.code, 'policy_denied');
  const parent = await readEvents(join(session.directory, 'parent.jsonl'));
  const delegated = parent.find((event) => event.kind === 'tool' && event.tool === 'subagent');
  assert.equal(delegated!.result.content.sessionId, 'parent.sub-1');
});

test('a task is required, and a mode is only looked up when this run has mode directories', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'p2' });
  const kernel = createKernel({ config, policy: chain, session });
  createSubagentPlugin({
    config,
    provider: scripted([text('unused')]),
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'p2',
    plugins: [minimalPlugin],
  }).setup(kernel);
  await assert.rejects(
    () => kernel.call('subagent', { task: '   ' }),
    (error: unknown) => (error as { code?: string }).code === 'subagent_task_required',
  );
  await assert.rejects(
    () => kernel.call('subagent', { task: 'do it', mode: 'other' }),
    (error: unknown) => (error as { code?: string }).code === 'subagent_mode_paths_required',
  );
});

// 派生会话继承父会话的模式和审批档位，因此也看不到该模式隐藏的工具。
test("the derived agent runs under the mode the parent session picked", async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const provider = scripted([
    call('subagent', { task: 'read only' }),
    text('read it'),
    text('back to the parent'),
  ]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'p3' });
  const kernel = createKernel({ config, policy: chain, session });
  minimalPlugin.setup(kernel);
  networkPlugin.setup(kernel);
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'p3',
    plugins: [minimalPlugin, networkPlugin],
    promptFragments: () => [{ name: 'review-guidance', text: 'Check each claim against the files before reporting.' }],
    promptFragmentBytes: 4096,
    modeFile: () => ({ name: 'readonly', layer: 'user', path: 'readonly.toml', tools: ['read'], prompt: ['review-guidance'], digest: 'mode-digest' }),
  }).setup(kernel);
  const result = await kernel.call('subagent', { task: 'read only' }) as SubagentOutcome;
  assert.equal(result.mode, 'readonly');
  assert.deepEqual(provider.requests[1].tools.map((entry) => entry.name), ['read']);
  assert.match(provider.requests[1].system, /Check each claim against the files before reporting/u);
});

test('an explicit child mode cannot restore tools hidden from the parent', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const provider = scripted([
    call('create', { path: 'escalated.txt', content: 'must stay blocked' }),
    text('the parent tool limit held'),
  ]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'restricted-parent' });
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  minimalPlugin.setup(kernel);
  networkPlugin.setup(kernel);
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'restricted-parent',
    plugins: [minimalPlugin, networkPlugin],
  }).setup(kernel);
  kernel.restrict(['create', 'write', 'edit', 'delete']);

  const result = await kernel.call('subagent', {
    task: 'try to create a file',
    mode: { type: 'inline', tools: ['create', 'read'], prompt: [] },
  }) as SubagentOutcome;

  assert.equal(result.text, 'the parent tool limit held');
  assert.deepEqual(provider.requests[0].tools.map((entry) => entry.name), ['read']);
  await assert.rejects(readFile(join(boundary, 'escalated.txt')), { code: 'ENOENT' });
  const side = await readEvents(join(session.directory, 'restricted-parent.sub-1.jsonl'));
  const denied = side.find((event) => event.kind === 'tool' && event.tool === 'create');
  assert.equal(denied!.result.code, 'tool_denied');
});

test('an inline mode freezes the registered tools and prompt fragments in the child record', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const provider = scripted([text('the scoped child result')]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'inline-parent' });
  const kernel = createKernel({ config, policy: chain, session });
  minimalPlugin.setup(kernel);
  networkPlugin.setup(kernel);
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: 'shared static prefix' },
    directory: session.directory,
    sessionId: 'inline-parent',
    plugins: [minimalPlugin, networkPlugin],
    promptFragments: () => [
      { name: 'review-guidance', text: 'Check each claim against the files before reporting.' },
      { name: 'unused-guidance', text: 'This fragment should not appear in the child request.' },
    ],
  }).setup(kernel);

  const result = await kernel.call('subagent', {
    task: 'read only',
    mode: { type: 'inline', tools: ['read'], prompt: ['review-guidance'] },
  }) as SubagentOutcome;
  assert.equal(result.text, 'the scoped child result');
  assert.equal(result.mode, 'inline');
  assert.equal(typeof result.modeDigest, 'string');
  assert.deepEqual(provider.requests[0].tools.map((entry) => entry.name), ['read']);
  assert.match(provider.requests[0].system, /Check each claim against the files before reporting/u);
  assert.doesNotMatch(provider.requests[0].system, /This fragment should not appear/u);

  const side = await readEvents(join(session.directory, 'inline-parent.sub-1.jsonl'));
  assert.equal(side[0].mode.source, 'inline');
  assert.deepEqual(side[0].mode.tools, ['read']);
  assert.deepEqual(side[0].mode.prompt, ['review-guidance']);
  assert.equal(typeof side[0].mode.digest, 'string');
  assert.equal(side[0].mode.path, undefined, 'the inline snapshot does not persist a private source path');
  assert.equal(side[0].mode.digest, result.modeDigest);
  await assert.rejects(kernel.call('subagent', {
    task: 'try to add a tool',
    mode: { type: 'inline', tools: ['subagent'], prompt: [] },
  }), { code: 'mode_tool_unregistered' });
  await assert.rejects(kernel.call('subagent', {
    task: 'use an unknown fragment',
    mode: { type: 'inline', tools: ['read'], prompt: ['missing-guidance'] },
  }), { code: 'mode_prompt_unavailable' });
});

test('child generation and loop budgets can be lowered but never raised', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'bounded-child-parent' });
  const base = scripted([text('child finished within the requested limits')]);
  const thinkingCapability = { efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high' };
  let selectedGeneration: { readonly outputTokens?: number; readonly thinkingEffort?: string } | undefined;
  const provider: SubagentDeps['provider'] = {
    ...base,
    outputTokens: 4096,
    thinkingEffort: 'high',
    thinkingCapability,
    withGeneration(options) {
      selectedGeneration = options;
      return { ...base, ...options, thinkingCapability };
    },
  };
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'bounded-child-parent',
    plugins: [minimalPlugin],
    loopLimits: { iterations: 8, modelCalls: 6, maxParallelTools: 2 },
  }).setup(kernel);

  const result = await kernel.call('subagent', {
    task: 'finish with smaller budgets',
    outputTokens: 2048,
    thinkingEffort: 'low',
    loopIterations: 3,
    modelCalls: 2,
  }) as SubagentOutcome;
  assert.deepEqual(selectedGeneration, { outputTokens: 2048, thinkingEffort: 'low' });
  assert.deepEqual(result.generation, { outputTokens: 2048, thinkingEffort: 'low' });
  assert.deepEqual(result.limits, { iterations: 3, modelCalls: 2, maxParallelTools: 2 });
  const childEvents = await readEvents(join(session.directory, `${result.sessionId}.jsonl`));
  const context = childEvents.find((event) => event.kind === 'turnContext')!;
  assert.deepEqual(context.childGeneration, { outputTokens: 2048, thinkingEffort: 'low' });
  assert.deepEqual(context.childLimits, { iterations: 3, modelCalls: 2, maxParallelTools: 2 });

  await assert.rejects(kernel.call('subagent', {
    task: 'exceed output budget', outputTokens: 4097,
  }), { code: 'subagent_output_budget_escalation' });
  await assert.rejects(kernel.call('subagent', {
    task: 'increase thinking', thinkingEffort: 'max',
  }), { code: 'subagent_thinking_escalation' });
  await assert.rejects(kernel.call('subagent', {
    task: 'exceed loop budget', loopIterations: 9,
  }), { code: 'subagent_budget_escalation' });
  await assert.rejects(kernel.call('subagent', {
    task: 'exceed model-call budget', modelCalls: 7,
  }), { code: 'subagent_budget_escalation' });
});

test('one parent turn can run three independent subagents concurrently', { timeout: 10_000 }, async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'parallel-parent' });
  const childTasks = ['child one', 'child two', 'child three'];
  const requestedTasks = [...childTasks, 'child four'];
  let childStarts = 0;
  let activeChildren = 0;
  let maximumActiveChildren = 0;
  let releaseChildren: (value?: unknown) => void = () => {};
  const allChildrenStarted = new Promise((resolve) => { releaseChildren = resolve; });
  const provider = {
    name: 'parallel-check',
    model: 'parallel-check',
    capabilities: {},
    async *stream(request: ModelRequest): AsyncGenerator<ProviderEvent> {
      const last = request.messages.at(-1);
      if (last?.role === 'user' && last.text === 'delegate three') {
        for (const [index, task] of requestedTasks.entries()) {
          yield { type: 'tool-call', id: `parallel-${index}`, name: 'subagent', args: { task } };
        }
        return;
      }
      if (last?.role === 'user' && childTasks.includes(last.text)) {
        childStarts += 1;
        activeChildren += 1;
        maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
        if (childStarts === childTasks.length) releaseChildren();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            allChildrenStarted,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('subagents did not overlap')), 1_000); }),
          ]);
          yield { type: 'text', text: `finished ${last.text}` };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          activeChildren -= 1;
        }
        return;
      }
      yield { type: 'text', text: 'all three children finished' };
    },
  };
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: 'parallel parent' },
    directory: session.directory,
    sessionId: 'parallel-parent',
    plugins: [minimalPlugin, networkPlugin],
  }).setup(kernel);

  const result = await createLoop({ kernel, provider, session, limits: { iterations: 3, modelCalls: 3 } }).run('delegate three');
  assert.equal(result.text, 'all three children finished');
  assert.equal(childStarts, 3);
  assert.equal(maximumActiveChildren, 3);
  const parentEvents = await readEvents(join(session.directory, 'parallel-parent.jsonl'));
  const outcomes = parentEvents.filter((event) => event.kind === 'tool' && event.tool === 'subagent');
  assert.equal(outcomes.length, 4);
  assert.equal(outcomes.filter((event) => event.result.content?.result?.state === 'completed').length, 3);
  assert.equal(outcomes.filter((event) => event.result.code === 'subagent_concurrency_limit').length, 1);
});

test('configured child concurrency limits live work and releases capacity after completion', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary, loop: { maxConcurrentSubagents: 1 } } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-concurrency-'), id: 'parent' });
  let release: (value?: unknown) => void = () => {};
  let started: (value?: unknown) => void = () => {};
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { name: 'bounded', model: 'bounded', capabilities: {}, async *stream(): AsyncGenerator<ProviderEvent> {
    started();
    await gate;
    yield { type: 'text', text: 'done' };
  } };
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  const deps = { config, provider, chain, prompt: { staticPrefix: '' }, directory: session.directory,
    sessionId: 'parent', plugins: [minimalPlugin] };
  createSubagentPlugin(deps).setup(kernel);
  const first = kernel.call('subagent', { task: 'first' });
  await ready;
  try {
    await assert.rejects(kernel.call('subagent', { task: 'second' }), { code: 'subagent_concurrency_limit' });
  } finally { release(); }
  assert.equal((await first as SubagentOutcome).text, 'done');
  assert.equal((await kernel.call('subagent', { task: 'third' }) as SubagentOutcome).text, 'done');
  for (const invalid of [0, 9, 1.5, '2']) {
    assert.throws(() => createSubagentPlugin({ ...deps, config: createConfig({ user: { boundary, loop: { maxConcurrentSubagents: invalid } } }) }),
      { code: 'subagent_concurrency_invalid' });
  }
});

test('rebuilding the parent continues child session numbering without reusing old records', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const provider = scripted([text('first child'), text('second child')]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'restarted-parent' });
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  const deps = {
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'restarted-parent',
    plugins: [minimalPlugin],
  };
  let unregister = createSubagentPlugin(deps).setup(kernel);
  try {
    const first = await kernel.call('subagent', { task: 'first task' }) as SubagentOutcome;
    assert.equal(first.sessionId, 'restarted-parent.sub-1');
    unregister();

    unregister = createSubagentPlugin(deps).setup(kernel);
    const second = await kernel.call('subagent', { task: 'second task' }) as SubagentOutcome;
    assert.equal(second.sessionId, 'restarted-parent.sub-2');
    const files = (await readdir(session.directory)).sort();
    assert.ok(files.includes('restarted-parent.sub-1.jsonl'));
    assert.ok(files.includes('restarted-parent.sub-2.jsonl'));
  } finally {
    unregister();
    await session.close();
  }
});

test('a child submits a structured result only after it matches the declared schema', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const provider = scripted([
    call('ligule_delegation_result', { result: { answer: 3, count: 2 } }),
    call('ligule_delegation_result', { result: { answer: 'checked', count: 2 } }),
  ]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'structured-parent' });
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'structured-parent',
    plugins: [minimalPlugin],
  }).setup(kernel);

  const result = await kernel.call('subagent', {
    task: 'return a checked summary',
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
      required: ['answer', 'count'],
      additionalProperties: false,
    },
  }) as SubagentOutcome;
  assert.match(provider.requests[0].system, /Schema JSON data:.*"answer"/u);
  assert.ok(provider.requests[0].tools.some((tool) => tool.name === 'ligule_delegation_result'));
  assert.equal(result.result.state, 'completed');
  assert.equal(result.result.stopReason, 'tool_completed');
  assert.deepEqual(result.result.output.structured, { answer: 'checked', count: 2 });
  assert.equal(result.result.validation.status, 'valid');
  assert.equal(typeof result.result.validation.schemaDigest, 'string');
  const childEvents = await readEvents(join(session.directory, 'structured-parent.sub-1.jsonl'));
  assert.ok(childEvents.some((event) => event.kind === 'tool' && event.tool === 'ligule_delegation_result'
    && event.result.code === 'delegation_result_invalid'));
  assert.equal(childEvents.find((event) => event.kind === 'turnContext')!.delegationSchemaDigest, result.result.validation.schemaDigest);
  await assert.rejects(kernel.call('subagent', {
    task: 'use an unsupported schema',
    outputSchema: { type: 'object', properties: { answer: { type: 'string', pattern: '^ok$' } } },
  }), { code: 'delegation_schema_invalid' });
});

test('a child that never submits its requested structure reports validation failure', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'missing-result-parent' });
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  createSubagentPlugin({
    config,
    provider: scripted([text('I finished, but did not submit the schema result.')]),
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'missing-result-parent',
    plugins: [minimalPlugin],
  }).setup(kernel);

  const result = await kernel.call('subagent', {
    task: 'return a checked summary',
    outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
  }) as SubagentOutcome;
  assert.equal(result.result.state, 'failed');
  assert.equal(result.result.stopReason, 'validation_failed');
  assert.equal(result.result.validation.status, 'invalid');
  assert.equal(result.result.output.structured, undefined);
  assert.match(result.result.validation.errors[0], /delegation_result_missing/u);
});

test('a failed child returns its persisted Session link and a failed RunResult', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'failed-child-parent' });
  const provider = {
    name: 'failing-provider',
    model: 'failing-provider',
    capabilities: {},
    async *stream(): AsyncGenerator<never> { throw new KernelError('provider_transport_error'); },
  };
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'failed-child-parent',
    plugins: [minimalPlugin],
  }).setup(kernel);

  const result = await kernel.call('subagent', {
    task: 'inspect the workspace',
    outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  }) as SubagentOutcome;
  assert.equal(result.sessionId, 'failed-child-parent.sub-1');
  assert.equal(result.result.state, 'failed');
  assert.equal(result.result.stopReason, 'provider_error');
  assert.equal(result.result.diagnostic!.code, 'provider_transport_error');
  assert.equal(result.result.validation.status, 'invalid');
  assert.deepEqual(result.result.validation.errors, [
    'Run ended with provider_transport_error before a valid structured result was submitted.',
  ]);
  assert.deepEqual(result.result.artifacts, [{ kind: 'session', sessionId: result.sessionId }]);
  const childEvents = await readEvents(join(session.directory, `${result.sessionId}.jsonl`));
  assert.ok(childEvents.some((event) => event.kind === 'turn' && event.status === 'failed'
    && event.code === 'provider_transport_error'));
  const parentEvents = (await session.read()) as unknown as RecordedEvent[];
  const childReference = parentEvents.find((event) => event.kind === 'tool' && event.tool === 'subagent');
  assert.equal(childReference!.result.content.sessionId, result.sessionId);
  assert.equal(childReference!.result.content.result!.state, 'failed');
});

test('cancelling a parent run returns the cancelled child Session reference', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'cancelled-child-parent' });
  let announceStarted: (value?: unknown) => void = () => {};
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const provider = {
    name: 'cancellable-provider',
    model: 'cancellable-provider',
    capabilities: {},
    async *stream(_request: ModelRequest, { signal }: { readonly signal?: AbortSignal }): AsyncGenerator<ProviderEvent> {
      announceStarted();
      if (signal!.aborted) throw new KernelError('provider_cancelled');
      await new Promise((resolve) => signal!.addEventListener('abort', resolve, { once: true }));
      throw new KernelError('provider_cancelled');
    },
  };
  const kernel = createKernel({ config, permission: fullAccess, policy: chain, session });
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'cancelled-child-parent',
    plugins: [minimalPlugin],
  }).setup(kernel);

  const controller = new AbortController();
  const pending = kernel.call('subagent', { task: 'inspect until cancelled' }, { signal: controller.signal });
  await started;
  controller.abort();
  const result = await pending as SubagentOutcome;
  assert.equal(result.sessionId, 'cancelled-child-parent.sub-1');
  assert.equal(result.result.state, 'cancelled');
  assert.equal(result.result.stopReason, 'cancelled');
  const childEvents = await readEvents(join(session.directory, `${result.sessionId}.jsonl`));
  assert.ok(childEvents.some((event) => event.kind === 'turn' && event.status === 'cancelled'));
  const parentEvents = (await session.read()) as unknown as RecordedEvent[];
  const childReference = parentEvents.find((event) => event.kind === 'tool' && event.tool === 'subagent');
  assert.equal(childReference!.result.content.sessionId, result.sessionId);
  assert.equal(childReference!.result.content.result!.state, 'cancelled');
});
