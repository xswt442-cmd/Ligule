import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTuiHost } from './helpers/tui-host.js';

// requestKey 的幂等语义：一个逻辑写操作绑定 (Scope, Session, 操作摘要)，重复、并发、重启、
// 取消后重试要么返回同一次 Run，要么明确冲突；任何情况下都不得再执行一次副作用。
async function acceptances(sessionDirectory, sessionId) {
  const text = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    .filter((event) => event.kind === 'user' && event.run !== undefined);
}

// 取消是异步落盘的：等到 turn 事件以 cancelled 收尾，重放才有确定的语义可断言。
async function settleCancellation(sessionDirectory, sessionId, within = 15_000) {
  const deadline = Date.now() + within;
  for (;;) {
    const text = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8');
    const settled = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
      .some((event) => event.kind === 'turn' && event.status === 'cancelled');
    if (settled) return;
    if (Date.now() >= deadline) throw new Error('the cancelled turn did not settle');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function within(promise, milliseconds, detail) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${detail} timed out after ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('a replayed request key returns the original run after a Host restart', async () => {
  await withTuiHost(async (context) => {
    const first = await context.client.request('run.submit', { sessionId: context.sessionId, input: 'replay me', requestKey: 'replay-key' });
    await context.client.request('run.wait', { sessionId: context.sessionId, origin: 'controller', runId: first.runId });
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
    const before = context.providerRequests.length;

    await context.restart();
    await context.client.request('session.open', { sessionId: context.sessionId });
    const replayed = await context.client.request('run.submit', { sessionId: context.sessionId, input: 'replay me', requestKey: 'replay-key' });
    assert.equal(replayed.runId, first.runId);
    assert.equal(replayed.reused, true);
    assert.equal(replayed.state, 'completed');
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
    assert.equal(context.providerRequests.length, before);
  });
});

test('a replayed request key with different input is a conflict rather than a second run', async () => {
  await withTuiHost(async (context) => {
    const first = await context.client.request('run.submit', { sessionId: context.sessionId, input: 'first input', requestKey: 'conflict-key' });
    await context.client.request('run.wait', { sessionId: context.sessionId, origin: 'controller', runId: first.runId });

    await context.restart();
    await context.client.request('session.open', { sessionId: context.sessionId });
    await assert.rejects(
      context.client.request('run.submit', { sessionId: context.sessionId, input: 'second input', requestKey: 'conflict-key' }),
      { code: 'run_request_conflict' },
    );
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
  });
});

test('concurrent duplicates of one request key share a single run', async () => {
  await withTuiHost(async (context) => {
    const params = { sessionId: context.sessionId, input: 'one logical task', requestKey: 'concurrent-key' };
    const [first, second] = await Promise.all([
      context.client.request('run.submit', params),
      context.client.request('run.submit', params),
    ]);
    assert.equal(first.runId, second.runId);
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
    assert.equal([first, second].filter((item) => item.reused === true).length, 1, 'one call performed the work and the other reused it');
    // 两条回执来自同一条持久 Acceptance：来源字段必须一致，不能只有 reused 那条带上。
    assert.equal(second.via, first.via);
    assert.equal(second.resolvedBy, first.resolvedBy);
    assert.equal(typeof first.via, 'string');
    assert.equal(typeof first.resolvedBy, 'string');
  });
});

test('a cancelled run is replayed as cancelled instead of executing twice', async () => {
  await withTuiHost(async (context) => {
    const started = await context.client.request('run.submit', { sessionId: context.sessionId, input: 'long task', requestKey: 'cancel-key' });
    await context.client.request('run.cancel', { sessionId: context.sessionId });
    await settleCancellation(context.sessionDirectory, context.sessionId);
    const before = context.providerRequests.length;

    const replayed = await context.client.request('run.submit', { sessionId: context.sessionId, input: 'long task', requestKey: 'cancel-key' });
    assert.equal(replayed.runId, started.runId);
    assert.equal(replayed.reused, true);
    assert.equal(replayed.state, 'cancelled');
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
    assert.equal(context.providerRequests.length, before, 'the cancelled turn must not be started again');
  }, { delayMs: 3_000 });
});

test('a replayed request key on the direct UI path returns the same execution', async () => {
  await withTuiHost(async (context) => {
    const params = { sessionId: context.sessionId, input: 'direct task', requestKey: 'direct-key' };
    const first = await context.client.request('run.start', params);
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);

    await context.restart();
    await context.client.request('session.open', { sessionId: context.sessionId });
    const replayed = await context.client.request('run.start', params);
    assert.equal(replayed.runId, first.runId);
    assert.equal(replayed.text, first.text);
    assert.equal(replayed.completedBy, first.completedBy);
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
  });
});

test('concurrent direct UI starts reuse one keyed run and reject a conflicting submission', async () => {
  let releaseModel;
  let modelStarted;
  const started = new Promise((resolve) => { modelStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseModel = resolve; });
  let firstRequest = true;
  try {
    await withTuiHost(async (context) => {
      const params = { sessionId: context.sessionId, input: 'one direct logical task', requestKey: 'direct-concurrent-key' };
      const first = context.client.request('run.start', params);
      await started;
      const duplicate = context.client.request('run.start', params);
      await assert.rejects(
        context.client.request('run.start', { ...params, requestKey: 'other-direct-key' }),
        { code: 'run_already_running' },
      );
      releaseModel();
      const [original, reused] = await Promise.all([first, duplicate]);

      assert.equal(reused.runId, original.runId);
      assert.equal(context.providerRequests.length, 1);
      assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
    }, {
      beforeResponse: async () => {
        if (!firstRequest) return;
        firstRequest = false;
        modelStarted();
        await blocked;
      },
    });
  } finally {
    releaseModel?.();
  }
});

test('run.submit releases the configuration queue when template expansion fails before Acceptance', async () => {
  await withTuiHost(async (context) => {
    await assert.rejects(
      within(context.client.request('run.submit', { sessionId: context.sessionId, input: '/missing-template' }), 5_000, 'template failure'),
      { code: 'template_unknown' },
    );
    assert.equal((await context.client.request('status.get', { sessionId: context.sessionId })).running, false);

    const next = await within(context.client.request('run.submit', { sessionId: context.sessionId, input: 'a valid next run' }), 5_000, 'next run acceptance');
    assert.ok(next.state === 'accepted' || next.state === 'running');
    await context.client.request('run.wait', { sessionId: context.sessionId, runId: next.runId });
    assert.equal((await acceptances(context.sessionDirectory, context.sessionId)).length, 1);
  });
});

test('receipt views report liveness from the live host, never from the record alone', async () => {
  await withTuiHost(async (context) => {
    const started = await context.client.request('run.submit', { sessionId: context.sessionId, input: 'slow task', requestKey: 'slow-key' });
    const live = await context.client.request('run.receipt', {
      projectRoot: context.projectDirectory, sessionId: context.sessionId, runId: started.runId,
    });
    assert.equal(live.state, 'running');
    assert.equal(live.liveness, 'alive');
    const page = await context.client.request('run.receipts', { projectRoot: context.projectDirectory, sessionId: context.sessionId });
    assert.equal(page.receipts[0].state, 'running');
    assert.equal(page.receipts[0].liveness, 'alive');

    await context.client.request('run.wait', { sessionId: context.sessionId, runId: started.runId });
    const settled = await context.client.request('run.receipt', {
      projectRoot: context.projectDirectory, sessionId: context.sessionId, runId: started.runId,
    });
    // 终态与活跃性来自同一次派生：记录说完了，Host 也不再声称它还活着。
    assert.equal(settled.state, 'completed');
    assert.equal(settled.liveness, 'unknown');
  }, { delayMs: 2_000 });
});

test('one request key visible in two scopes is reported as ambiguous, not reused', async () => {
  await withTuiHost(async (context) => {
    const human = await context.client.request('run.submit', { sessionId: context.sessionId, origin: 'human', input: 'human task', requestKey: 'shared-key' });
    await context.client.request('run.wait', { sessionId: context.sessionId, origin: 'human', runId: human.runId });
    const controller = await context.client.request('run.submit', { sessionId: context.sessionId, origin: 'controller', input: 'controller task', requestKey: 'shared-key' });
    await context.client.request('run.wait', { sessionId: context.sessionId, origin: 'controller', runId: controller.runId });
    assert.notEqual(controller.runId, human.runId);

    await assert.rejects(context.client.request('run.receipt', {
      projectRoot: context.projectDirectory, sessionId: context.sessionId, requestKey: 'shared-key',
    }), { code: 'run_request_key_ambiguous' });
    assert.equal((await context.client.request('run.receipt', {
      projectRoot: context.projectDirectory, sessionId: context.sessionId, runId: human.runId,
    })).runId, human.runId);
    assert.equal((await context.client.request('run.receipt', {
      projectRoot: context.projectDirectory, sessionId: context.sessionId, runId: controller.runId,
    })).runId, controller.runId);
  }, { permissionControl: true });
});
