import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfig, createKernel, createLoop, createSessionLog, createTaskBudget, DEFAULT_LOOP_LIMITS, KernelError, KernelRuntimeError } from '../dist/index.js';
import type { LoopProgressEvent, ModelProvider, ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import type { ToolDefinition } from '../dist/kernel/kernel.js';
import type { ProviderDiagnostic } from '../dist/kernel/error.js';

// 脚本事件不必字段齐全：缺少 id/args 的调用也是循环要接住的输入。
type ScriptedEvent = { readonly type: string; readonly [key: string]: unknown };

// 脚本化提供方只用于驱动循环；本文件不测试具体模型端点。
function scriptedProvider(turns: ScriptedEvent[][], fallback: readonly ScriptedEvent[] = [{ type: 'text', text: 'done' }]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      yield* (turns.shift() ?? fallback) as unknown as ProviderEvent[];
    },
  };
}

function tool(name: string, run: ToolDefinition['run'], execution?: ToolDefinition['execution']): ToolDefinition {
  return { name, description: `the ${name} tool`, access: 'read', parameters: { type: 'object', properties: {} }, execution, run };
}

function kernelWith(tools: ToolDefinition[]) {
  const kernel = createKernel();
  for (const entry of tools) kernel.register(entry);
  return kernel;
}

test('a turn without tool calls ends the run and the provider is asked once', async () => {
  const provider = scriptedProvider([[{ type: 'text', text: 'the answer' }]]);
  const result = await createLoop({ kernel: kernelWith([]), provider }).run('question');
  assert.deepEqual(result, { text: 'the answer', iterations: 1, modelCalls: 1 });
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(provider.requests[0].messages, [{ role: 'user', text: 'question' }]);
});

test('parallel tool limits reject unsafe concurrency', () => {
  for (const maxParallelTools of [0, 33]) {
    assert.throws(
      () => createLoop({ kernel: kernelWith([]), provider: scriptedProvider([]), limits: { ...DEFAULT_LOOP_LIMITS, maxParallelTools } }),
      (error) => (error as { code?: string }).code === 'loop_parallel_limit_invalid',
    );
  }
});

test('loop progress reports real request and tool phases in execution order', async () => {
  const progress: LoopProgressEvent[] = [];
  const provider = scriptedProvider([
    [{ type: 'text', text: 'checking' }, { type: 'tool-call', id: 'call_1', name: 'peek', args: {} }],
    [{ type: 'text', text: 'answer' }],
  ]);
  const kernel = kernelWith([tool('peek', async () => ({ text: 'one line' }))]);
  await createLoop({ kernel, provider, onProgress: (event) => progress.push(event) }).run('go');
  assert.deepEqual(progress.filter((event) => event.kind === 'phase').map((event) => event.phase), [
    'preparing', 'model_request', 'tool_execution', 'preparing', 'model_request', 'settling',
  ]);
  assert.ok(progress.some((event) => event.kind === 'activity' && event.activity === 'model_output'));
  assert.ok(progress.some((event) => event.kind === 'activity' && event.activity === 'tool'));
  assert.equal(progress.at(-1)!.modelCalls, 2);
  assert.equal(progress.at(-1)!.toolCalls, 1);
});

test('empty output and reasoning-only output fail with one persistent terminal', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    for (const [id, events] of [
      ['empty', [{ type: 'finish', reason: 'stop' }]],
      ['reasoning', [{ type: 'reasoning', text: 'thinking' }, { type: 'finish', reason: 'stop' }]],
    ] as [string, ScriptedEvent[]][]) {
      const session = createSessionLog({ directory: root, id });
      const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
      await assert.rejects(
        () => createLoop({ kernel, provider: scriptedProvider([events]), session }).run('go'),
        (error) => (error as { code?: string }).code === 'provider_empty_response',
      );
      const records = await session.read();
      assert.deepEqual(records.filter((event) => event.kind === 'turn').map((event) => [event.status, event.code]), [
        ['failed', 'provider_empty_response'],
      ]);
      assert.equal(records.filter((event) => event.kind === 'turn').length, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a provider failure keeps its safe diagnostics in the persistent turn event', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'provider-diagnostic' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const diagnostics: ProviderDiagnostic = {
      category: 'server', status: 503, attempts: 3,
      responseReceived: true, streamReceived: false, recoverable: true,
    };
    const provider = {
      async *stream() { throw new KernelError('provider_http_error', { diagnostics }); },
    };
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go'),
      (error) => (error as KernelError).code === 'provider_http_error' && assert.deepEqual((error as KernelError).diagnostics, diagnostics) === undefined,
    );
    const turn = (await session.read()).find((event) => event.kind === 'turn')!;
    assert.deepEqual(turn.diagnostics, diagnostics);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('providers that require protocol completion do not treat iterable EOF as success', async () => {
  const session = createSessionLog({ directory: await mkdtemp(join(process.cwd(), 'testplace', 'loop-')), id: 'missing-finish' });
  try {
    const kernel = createKernel({ config: createConfig({ user: { boundary: session.directory } }), session });
    const provider: ModelProvider = { requiresCompletion: true, async *stream() { yield { type: 'text', text: 'partial' }; } };
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go'),
      (error) => (error as { code?: string }).code === 'provider_stream_incomplete',
    );
    const events = await session.read();
    assert.ok(events.some((event) => event.kind === 'assistant' && event.text === 'partial'));
    assert.equal(events.filter((event) => event.kind === 'turn').length, 1);
    assert.equal(events.at(-1)!.code, 'provider_stream_incomplete');
  } finally {
    await rm(session.directory, { recursive: true, force: true });
  }
});

test('all tool arguments are preflighted before any tool in the response can run', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'batch-preflight' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const ran: string[] = [];
    kernel.register(tool('side_effect', async () => { ran.push('side_effect'); return { text: 'changed' }; }));
    kernel.register({
      ...tool('needs_value', async () => { ran.push('needs_value'); return { text: 'unexpected' }; }),
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    });
    const provider = scriptedProvider([
      [
        { type: 'tool-call', id: 'one', name: 'side_effect', args: {} },
        { type: 'tool-call', id: 'two', name: 'needs_value', args: {} },
      ],
      [{ type: 'text', text: 'the rejected call was corrected' }],
    ]);
    const result = await createLoop({ kernel, provider, session }).run('go');
    assert.equal(result.text, 'the rejected call was corrected');
    assert.deepEqual(ran, []);
    const records = await session.read();
    assert.equal(records.filter((event) => event.kind === 'tool').length, 2);
    assert.deepEqual(records.filter((event) => event.kind === 'tool').map((event) => (event.result as { code?: string }).code), ['tool_skipped', 'tool_args_invalid']);
    assert.equal(records.filter((event) => event.kind === 'turn').length, 1);
    assert.equal(records.at(-1)!.status, 'completed');
    assert.equal(provider.requests.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('output exhaustion preserves partial text and answers any incomplete calls without executing them', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'output-exhausted' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const ran: string[] = [];
    kernel.register(tool('side_effect', async () => { ran.push('side_effect'); return { text: 'changed' }; }));
    const provider = scriptedProvider([[
      { type: 'text', text: 'partial answer' },
      { type: 'tool-call', id: 'call_1', name: 'side_effect', args: {} },
      { type: 'finish', reason: 'length' },
    ]]);
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go'),
      (error) => (error as { code?: string }).code === 'provider_output_exhausted',
    );
    assert.deepEqual(ran, []);
    const events = await session.read();
    assert.ok(events.some((event) => event.kind === 'assistant' && event.text === 'partial answer'));
    assert.equal(events.filter((event) => event.kind === 'tool').length, 1);
    assert.equal(events.filter((event) => event.kind === 'turn').length, 1);
    assert.equal(events.at(-1)!.code, 'provider_output_exhausted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a provider failure after partial output preserves trace and does not dispatch collected calls', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'partial-stream-failure' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const ran: string[] = [];
    kernel.register(tool('side_effect', async () => { ran.push('side_effect'); return { text: 'changed' }; }));
    const provider = {
      async *stream(): AsyncGenerator<ProviderEvent> {
        yield { type: 'text', text: 'partial answer' };
        yield { type: 'tool-call', id: 'call_1', name: 'side_effect', args: {} };
        throw new KernelError('provider_tool_args_invalid', { detail: 'tool arguments are not valid JSON' });
      },
    };
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go'),
      (error) => (error as { code?: string }).code === 'provider_tool_args_invalid',
    );
    assert.deepEqual(ran, []);
    const events = await session.read();
    assert.ok(events.some((event) => event.kind === 'assistant' && event.text === 'partial answer'));
    assert.equal(events.filter((event) => event.kind === 'tool').length, 1);
    assert.equal(events.filter((event) => event.kind === 'turn').length, 1);
    assert.equal(events.at(-1)!.code, 'provider_tool_args_invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the iteration limit and the model call budget each stop the run with their own code', async () => {
  const always = [[{ type: 'tool-call', name: 'noop' }]];
  const provider = scriptedProvider([...always, ...always, ...always, ...always]);
  const kernel = kernelWith([tool('noop', async () => ({ text: 'ok' }))]);
  await assert.rejects(
    () => createLoop({ kernel, provider, limits: { iterations: 3, modelCalls: 99 } }).run('go'),
    (error) => error instanceof KernelError && error.code === 'loop_iteration_limit',
  );
  assert.equal(provider.requests.length, 3);

  const tight = scriptedProvider([], [{ type: 'tool-call', name: 'noop' }]);
  await assert.rejects(
    () => createLoop({ kernel, provider: tight, limits: { iterations: 99, modelCalls: 1 } }).run('go'),
    (error) => (error as { code?: string }).code === 'loop_model_budget_exhausted',
  );
  assert.equal(tight.requests.length, 1);
});

test('adjacent parallel calls overlap and a serial call forms a boundary', async () => {
  const log: string[] = [];
  const slow = (name: string) => tool(name, async () => {
    log.push(`${name}-start`);
    await sleep(10);
    log.push(`${name}-end`);
    return { text: name };
  }, 'parallel');
  const kernel = kernelWith([slow('a'), slow('b'), tool('c', async () => {
    log.push('c-start');
    await sleep(10);
    log.push('c-end');
    return { text: 'c' };
  })]);
  const provider = scriptedProvider([
    [
      { type: 'tool-call', name: 'a' },
      { type: 'tool-call', name: 'b' },
      { type: 'tool-call', name: 'c' },
      { type: 'tool-call', name: 'a' },
    ],
    [{ type: 'text', text: 'finished' }],
  ]);
  assert.deepEqual((await createLoop({ kernel, provider }).run('go')).text, 'finished');
  assert.ok(log.indexOf('b-start') < log.indexOf('a-end'), 'a and b must be in flight at the same time');
  assert.ok(log.indexOf('c-start') > log.indexOf('b-end'), 'the serial call waits for the parallel group');
  assert.equal(log.indexOf('a-start'), 0);
  assert.deepEqual(log.slice(-2), ['a-start', 'a-end'], 'the call after a serial one starts its own group');
});

test('a parallel interaction pauses only its tool while another active tool keeps the deadline running', async () => {
  const budget = createTaskBudget({ maxModelCalls: 2, timeoutMs: 500, requestTimeoutMs: 200, interactionWaitTimeoutMs: 2_000 });
  let markActiveStarted!: () => void;
  const activeStarted = new Promise<void>((resolve) => { markActiveStarted = resolve; });
  let executionPausedWhileOtherToolRan!: boolean;
  const awaitingApproval = tool('await_approval', async () => {
    const finishInteraction = budget.startInteraction();
    try {
      await activeStarted;
      executionPausedWhileOtherToolRan = budget.snapshot().executionPaused;
      await sleep(800);
      return { text: 'approved' };
    } finally { finishInteraction(); }
  }, 'parallel');
  const backgroundWork = tool('background_work', async () => {
    markActiveStarted();
    await sleep(800);
    return { text: 'finished' };
  }, 'parallel');
  const provider = scriptedProvider([[
    { type: 'tool-call', id: 'await-approval', name: 'await_approval', args: {} },
    { type: 'tool-call', id: 'background-work', name: 'background_work', args: {} },
  ]]);

  try {
    await assert.rejects(
      createLoop({ kernel: kernelWith([awaitingApproval, backgroundWork]), provider }).run('go', { task: budget }),
      { code: 'task_deadline_exceeded' },
    );
    assert.equal(executionPausedWhileOtherToolRan, false);
  } finally { budget.dispose(); }
});

test('a tool the host marked as completing the run stops it without another model call', async () => {
  const provider = scriptedProvider([[{ type: 'tool-call', name: 'finish' }]]);
  const kernel = kernelWith([tool('finish', async () => ({ text: 'done' }))]);
  const result = await createLoop({ kernel, provider, completesRun: ['finish'] }).run('go');
  assert.deepEqual(result, { text: '', completedBy: 'finish', iterations: 1, modelCalls: 1 });
  assert.equal(provider.requests.length, 1);
});

test('a parallel completion tool is a barrier and every call receives exactly one result', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-barrier-'));
  try {
    const session = createSessionLog({ directory: root, id: 'barrier' });
    const kernel = createKernel({ session });
    kernel.register(tool('finish', async () => ({ text: 'done' }), 'parallel'));
    kernel.register(tool('write_marker', async () => { await appendFile(join(root, 'effects.txt'), 'executed\n'); return { text: 'written' }; }, 'parallel'));
    const calls = ['finish', 'write_marker', 'write_marker'].map((name, index) => ({ type: 'tool-call', id: `barrier-${index}`, name, args: {} }));
    await createLoop({ kernel, provider: scriptedProvider([calls]), session, completesRun: ['finish'] }).run('complete');
    await assert.rejects(readFile(join(root, 'effects.txt')), { code: 'ENOENT' });
    const results = (await session.read()).filter(event => event.kind === 'tool');
    for (const call of calls) assert.equal(results.filter(event => event.callId === call.id).length, 1);
    assert.deepEqual(results.map(event => (event.result as { code?: string }).code), [undefined, 'tool_skipped', 'tool_skipped']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parallel tools use a bounded rolling pool and cancellation does not start queued calls', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-pool-'));
  try {
    for (const cancel of [false, true]) {
      const session = createSessionLog({ directory: root, id: cancel ? 'cancel' : 'all' });
      const kernel = createKernel({ session });
      const controller = new AbortController();
      let active = 0;
      let peak = 0;
      let started = 0;
      let finished = 0;
      kernel.register(tool('work', async () => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        try {
          if (cancel) controller.abort();
          await sleep(10);
          await appendFile(join(root, cancel ? 'cancelled.txt' : 'all.txt'), 'completed\n');
          return { text: 'done' };
        } finally { active -= 1; finished += 1; }
      }, 'parallel'));
      const calls = Array.from({ length: 7 }, (_, index) => ({ type: 'tool-call', id: `pool-${index}`, name: 'work', args: {} }));
      const operation = createLoop({ kernel, session, provider: scriptedProvider([calls]), limits: { iterations: 2, modelCalls: 2, maxParallelTools: 2 } }).run('work', { signal: controller.signal });
      if (cancel) await assert.rejects(operation, { code: 'loop_cancelled' });
      else await operation;
      assert.ok(peak <= 2);
      assert.equal(active, 0);
      assert.equal(finished, started);
      if (cancel) assert.ok(started > 0 && started <= 2);
      else assert.equal(started, 7);
      const results = (await session.read()).filter(event => event.kind === 'tool');
      for (const call of calls) assert.equal(results.filter(event => event.callId === call.id).length, 1);
      assert.equal(results.filter(event => (event.result as { code?: string }).code === 'tool_skipped').length, cancel ? 7 - started : 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a cancelled run persists its terminal and answers every dispatched call', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({
      config: createConfig({ user: { boundary: root } }),
      session,
    });
    const controller = new AbortController();
    kernel.register(tool('long', async (args, context) => {
      setTimeout(() => controller.abort(), 5);
      await sleep(20);
      if (context.signal!.aborted) throw new KernelError('exec_cancelled');
      return { text: 'never' };
    }));
    const provider = scriptedProvider([
      [{ type: 'tool-call', name: 'long' }],
      [{ type: 'text', text: 'not reached' }],
    ]);
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go', { signal: controller.signal }),
      (error) => (error as { code?: string }).code === 'loop_cancelled',
    );
    const turns = (await session.read()).filter((event) => event.kind === 'turn');
    assert.equal(turns.length, 1, '取消只写一条终态');
    assert.equal(turns[0].status, 'cancelled');
    assert.equal(turns[0].code, 'loop_cancelled');
    assert.equal(turns[0].userSeq, (await session.read()).find((event) => event.kind === 'user')!.seq);
    const events = await session.read();
    assert.deepEqual(events.map((event) => event.kind), ['user', 'assistant', 'tool', 'turn']);
    assert.deepEqual(events[2].result, { kind: 'failure', failed: true, code: 'exec_cancelled', content: '' });
    assert.equal(events[3].status, 'cancelled');
    assert.equal(provider.requests.length, 1, 'the cancelled run does not ask the model again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 取消落在两组之间：后面那一组的调用已经在助手那一条里许出去了。不能执行——用户按的就是停；
// 也不能没人回答——请求体里每个调用都要有一条结果顶着，少一条之后每一轮都拼不出合法请求。
test('a cancellation between two groups answers the call that never ran', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'between' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const controller = new AbortController();
    const ran: string[] = [];
    kernel.register(tool('stop_now', async () => {
      ran.push('stop_now');
      controller.abort();
      return { text: 'ok' };
    }));
    kernel.register(tool('later', async () => {
      ran.push('later');
      return { text: 'never' };
    }));
    const provider = scriptedProvider([[
      { type: 'tool-call', id: 'call_1', name: 'stop_now', args: {} },
      { type: 'tool-call', id: 'call_2', name: 'later', args: {} },
    ]]);
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go', { signal: controller.signal }),
      (error) => (error as { code?: string }).code === 'loop_cancelled',
    );
    assert.deepEqual(ran, ['stop_now'], 'a call queued behind a cancelled run does not execute');
    assert.deepEqual(await session.modelView(), [
      { role: 'user', text: 'go' },
      {
        role: 'assistant', text: '', toolCalls: [
          { id: 'call_1', name: 'stop_now', args: {} },
          { id: 'call_2', name: 'later', args: {} },
        ],
      },
      { role: 'tool', id: 'call_1', tool: 'stop_now', content: { text: 'ok' }, failed: false, code: undefined },
      {
        role: 'tool', id: 'call_2', tool: 'later', content: 'the run was cancelled before this call ran',
        failed: true, code: 'tool_skipped',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 算完成本轮的那一件工具之后还有别的调用：那些也许出去了，同样只留一条不执行的结果。
test('the tool that ends the round answers the calls behind it', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'completes' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const ran: string[] = [];
    kernel.register(tool('finish', async () => ({ text: 'done' })));
    kernel.register(tool('behind', async () => {
      ran.push('behind');
      return { text: 'never' };
    }));
    const provider = scriptedProvider([[
      { type: 'tool-call', id: 'call_1', name: 'finish', args: {} },
      { type: 'tool-call', id: 'call_2', name: 'behind', args: {} },
    ]]);
    const result = await createLoop({ kernel, provider, session, completesRun: ['finish'] }).run('go');
    assert.equal(result.completedBy, 'finish');
    assert.deepEqual(ran, [], 'the round ends without running what came after it');
    const view = await session.modelView();
    assert.deepEqual(view.at(-1), {
      role: 'tool', id: 'call_2', tool: 'behind', content: 'finish ended this round before this call ran',
      failed: true, code: 'tool_skipped',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tool that throws an unwrapped error does not stop the run', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'half-baked' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('broken', async () => {
      throw new TypeError('cannot read properties of undefined');
    }));
    const provider = scriptedProvider([
      [{ type: 'tool-call', id: 'call_1', name: 'broken' }],
      [{ type: 'text', text: 'recovered' }],
    ]);
    assert.deepEqual((await createLoop({ kernel, provider, session }).run('go')).text, 'recovered');
    // 模型下一轮看得见这次失败，包括它自己那句消息，否则它只会把同一个调用再发一遍。
    assert.deepEqual(provider.requests[1].messages, [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'broken', args: {} }] },
      {
        role: 'tool',
        id: 'call_1',
        tool: 'broken',
        content: 'cannot read properties of undefined',
        failed: true,
        code: 'tool_failed',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failure inside the kernel stops the run instead of asking the model again', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'failed' });
    const provider = scriptedProvider([
      [{ type: 'tool-call', name: 'broken' }],
      [{ type: 'text', text: 'not reached' }],
    ]);
    // 内核自身的真实异常会停住循环，记录仍保留对应用户输入的失败终态。
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('broken', async () => {
      throw new KernelRuntimeError('session_write_failed');
    }));
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go'),
      (error) => error instanceof KernelRuntimeError && error.code === 'session_write_failed',
    );
    assert.equal(provider.requests.length, 1);
    const turns = (await session.read()).filter((event) => event.kind === 'turn');
    assert.equal(turns.length, 1, '失败只写一条终态');
    assert.equal(turns[0].status, 'failed');
    assert.equal(turns[0].code, 'session_write_failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('what the model is shown next is rebuilt from the session log', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('read', async () => ({ text: 'file body' })));
    const provider = scriptedProvider([
      [{ type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } }],
      [{ type: 'text', text: 'thanks' }],
    ]);
    await createLoop({ kernel, provider, session }).run('go');
    assert.deepEqual(provider.requests[1].messages, [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
      { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'file body' }, failed: false, code: undefined },
    ]);
    assert.deepEqual(provider.requests[1].tools.map((entry) => entry.name), ['read']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 推理内容写入会话记录并在界面和恢复时保留，但不会进入下一轮请求。
test('reasoning is recorded and kept out of what the model is asked next', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('peek', async () => ({ text: 'one line' })));
    const provider = scriptedProvider([
      [{ type: 'reasoning', text: 'the file is short' }, { type: 'tool-call', id: 'c1', name: 'peek', args: {} }],
      [{ type: 'text', text: 'it says one line' }],
    ]);
    await createLoop({ kernel, provider, session }).run('read it');

    const events = await session.read();
    assert.deepEqual(events.map((event) => event.kind), ['user', 'reasoning', 'assistant', 'tool', 'assistant', 'turn']);
    assert.equal(events[1].text, 'the file is short');
    assert.deepEqual(provider.requests[1].messages.map((entry) => entry.role), ['user', 'assistant', 'tool']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 每条用户输入都会记录完成、取消或失败状态；这些终态事件不进入模型投影或检查点哈希。
test('completed and budget-exhausted rounds each leave one terminal event', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'turns' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('peek', async () => ({ text: 'one line' })));
    const provider = scriptedProvider([
      [{ type: 'tool-call', id: 'c1', name: 'peek', args: {} }],
      [{ type: 'text', text: 'done' }],
    ]);
    const done = await createLoop({ kernel, provider, session }).run('first');

    const events = await session.read();
    const marker = events.at(-1)!;
    assert.equal(marker.kind, 'turn');
    assert.equal(marker.status, 'completed');
    assert.equal(marker.ignorable, true, '旧版本读不懂时可以跳过它，但它仍然占一个序号');
    assert.equal(marker.userSeq, events.find((event) => event.kind === 'user')!.seq, '身份证就是这一轮的那条用户输入');
    assert.equal(marker.iterations, done.iterations);
    assert.equal(marker.modelCalls, done.modelCalls);
    assert.equal(marker.completedBy, undefined);
    // 投影里没有它的位置：这一轮交回去的那四段与加这条标记之前一样多。
    assert.deepEqual((await session.modelView()).map((entry) => (entry as { role: string }).role), ['user', 'assistant', 'tool', 'assistant']);

    // 由一件算完成本轮的工具收尾的那一种，标记里说出是哪一件。
    const byTool = scriptedProvider([[{ type: 'tool-call', id: 'c2', name: 'peek', args: {} }]]);
    await createLoop({ kernel, provider: byTool, session, completesRun: ['peek'] }).run('second');
    assert.equal((await session.read()).at(-1)!.completedBy, 'peek');

    // 模型调用预算耗尽是一条失败终态，不可作为分支点。
    const stuck = createSessionLog({ directory: root, id: 'stuck' });
    const stuckKernel = createKernel({ config: createConfig({ user: { boundary: root } }), session: stuck });
    stuckKernel.register(tool('peek', async () => ({ text: 'one line' })));
    await assert.rejects(
      createLoop({
        kernel: stuckKernel,
        provider: scriptedProvider([[{ type: 'tool-call', id: 'c9', name: 'peek', args: {} }]]),
        session: stuck,
        limits: { iterations: 32, modelCalls: 1 },
      }).run('go'),
      (error) => (error as { code?: string }).code === 'loop_model_budget_exhausted',
    );
    const failed = (await stuck.read()).filter((event) => event.kind === 'turn');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 'failed');
    assert.equal(failed[0].code, 'loop_model_budget_exhausted');
    assert.equal(failed[0].userSeq, (await stuck.read()).find((event) => event.kind === 'user')!.seq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
