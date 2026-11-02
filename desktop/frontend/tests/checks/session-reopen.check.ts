// 重开会话的重试策略只有在注入时钟和 sleep 后才能稳定断言，这里用假时钟覆盖四条路径。
import assert from 'node:assert/strict';
import test from 'node:test';
import { reopenSessionWriter } from '../../src/session-reopen.ts';
import { requestIsCurrent } from '../../src/request-identity.ts';

const code = (error: unknown): string => (error as { code?: string }).code ?? String(error);
const locked = (failure: string): boolean => failure === 'session_locked';

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
  };
}

test('reopening returns as soon as the writer lock is gone', async () => {
  const { now, sleep } = clock();
  let attempts = 0;
  const outcome = await reopenSessionWriter({
    open: async () => { attempts += 1; },
    code,
    isLocked: locked,
    now,
    sleep,
    budgetMs: 15_000,
  });
  assert.deepEqual(outcome, { kind: 'opened' });
  assert.equal(attempts, 1);
});

test('reopening retries while the crashed writer lease is still active', async () => {
  const { now, sleep } = clock();
  let attempts = 0;
  const outcome = await reopenSessionWriter({
    open: async () => {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error('busy'), { code: 'session_locked' });
    },
    code,
    isLocked: locked,
    now,
    sleep,
    budgetMs: 15_000,
  });
  assert.deepEqual(outcome, { kind: 'opened' });
  assert.equal(attempts, 4);
});

test('reopening reports the leftover lock instead of opening read-only silently', async () => {
  const { now, sleep } = clock();
  let attempts = 0;
  const outcome = await reopenSessionWriter({
    open: async () => { attempts += 1; throw Object.assign(new Error('busy'), { code: 'session_locked' }); },
    code,
    isLocked: locked,
    now,
    sleep,
    budgetMs: 15_000,
  });
  assert.equal(outcome.kind, 'locked');
  assert.equal(outcome.kind === 'locked' ? outcome.waitedMs : -1, 15_000);
  assert.equal(attempts, 31);
});

test('reopening stops on an error that is not a lock', async () => {
  const { now, sleep } = clock();
  let attempts = 0;
  const outcome = await reopenSessionWriter({
    open: async () => { attempts += 1; throw Object.assign(new Error('gone'), { code: 'session_missing' }); },
    code,
    isLocked: locked,
    now,
    sleep,
    budgetMs: 15_000,
  });
  assert.deepEqual(outcome, { kind: 'failed', code: 'session_missing' });
  assert.equal(attempts, 1);
});

test('reopening stops retrying after the user switches sessions', async () => {
  let current = true;
  let attempts = 0;
  const outcome = await reopenSessionWriter({
    open: async () => { attempts += 1; throw Object.assign(new Error('busy'), { code: 'session_locked' }); },
    code,
    isLocked: locked,
    now: () => 0,
    sleep: async () => { current = false; },
    isCurrent: () => current,
    budgetMs: 15_000,
  });
  assert.deepEqual(outcome, { kind: 'cancelled' });
  assert.equal(attempts, 1, 'a stale reconnect must not open the old session again');
});

test('reopening does not continue with a stale session after an open resolves', async () => {
  let resolveOpen!: () => void;
  const opened = new Promise<void>((resolve) => { resolveOpen = resolve; });
  let current = true;
  const pending = reopenSessionWriter({
    open: async () => opened,
    code,
    isLocked: locked,
    now: () => 0,
    sleep: async () => undefined,
    isCurrent: () => current,
    budgetMs: 15_000,
  });
  current = false;
  resolveOpen();
  assert.deepEqual(await pending, { kind: 'cancelled' });
});

test('a new open generation invalidates a delayed request even after returning to its Session', () => {
  const original = { scope: 'session-a', generation: 7 };
  assert.equal(requestIsCurrent(original, 'session-a', 7), true);
  assert.equal(requestIsCurrent(original, 'session-b', 8), false);
  assert.equal(requestIsCurrent(original, 'session-a', 9), false, 'A→B→A is a new request generation');
});
