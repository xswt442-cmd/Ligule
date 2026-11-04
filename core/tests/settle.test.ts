import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { SETTLE_GRACE_MS, settleWithin } from '../dist/kernel/settle.js';

test('settle waits for a run that ends on its own', async () => {
  let finished = false;
  const outcome = await settleWithin(delay(20).then(() => { finished = true; }), 5_000);
  assert.equal(outcome, true);
  assert.equal(finished, true);
});

test('settle treats a failed run as settled, so shutdown keeps releasing', async () => {
  const outcome = await settleWithin(Promise.reject(new Error('tool failed')), 5_000);
  assert.equal(outcome, true);
});

test('settle reports a timeout and keeps the process free to continue', async () => {
  let notified = false;
  const started = Date.now();
  const outcome = await settleWithin(delay(5_000), 60, () => { notified = true; });
  assert.equal(outcome, false);
  assert.equal(notified, true);
  assert.ok(Date.now() - started >= 40);
});

test('settle keeps its shutdown deadline alive when the awaited work has no event-loop handles', () => {
  const moduleUrl = new URL('../dist/kernel/settle.js', import.meta.url).href;
  const source = `import { settleWithin } from ${JSON.stringify(moduleUrl)}; await settleWithin(new Promise(() => {}), 30); process.exitCode = 42;`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 42, 'the shutdown timeout must keep the process alive until it settles');
});

test('settle resolves immediately when there is no run to wait for', async () => {
  assert.equal(await settleWithin(undefined), true);
  assert.equal(SETTLE_GRACE_MS, 10_000);
});
