import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileWriteQueue, fileWriteTargetKey } from '../dist/kernel/file-write-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('write target identity normalizes dot segments and follows platform case rules', () => {
  assert.equal(fileWriteTargetKey('workspace/sub/../note.txt'), fileWriteTargetKey('workspace/note.txt'));
  if (process.platform === 'win32') {
    assert.equal(fileWriteTargetKey('workspace/note.txt'), fileWriteTargetKey('workspace/NOTE.txt'));
  } else {
    assert.notEqual(fileWriteTargetKey('workspace/note.txt'), fileWriteTargetKey('workspace/NOTE.txt'));
  }
});

test('same normalized target runs one filesystem operation at a time and continues after failure', async () => {
  const queue = createFileWriteQueue();
  const started = deferred();
  const release = deferred();
  const order: string[] = [];
  const first = queue.run('workspace/./note.txt', async () => {
    order.push('first-start');
    started.resolve();
    await release.promise;
    order.push('first-end');
    throw new Error('injected I/O failure');
  });
  const second = queue.run('workspace/note.txt', async () => {
    order.push('second-start');
    order.push('second-end');
  });

  await started.promise;
  await Promise.resolve();
  assert.deepEqual(order, ['first-start']);
  release.resolve();
  await assert.rejects(first, /injected I\/O failure/u);
  await second;
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('different target paths can run at the same time', async () => {
  const queue = createFileWriteQueue();
  const started = deferred();
  let arrivals = 0;
  const operation = () => queue.run(`workspace/${arrivals++}.txt`, async () => {
    if (arrivals === 2) started.resolve();
    await started.promise;
  });

  await Promise.all([operation(), operation()]);
  assert.equal(arrivals, 2);
});

test('cancellation while waiting releases the path slot after its predecessor and does not run the write', async () => {
  const queue = createFileWriteQueue();
  const started = deferred();
  const release = deferred();
  const controller = new AbortController();
  let secondRan = false;
  const first = queue.run('/workspace/note.txt', async () => {
    started.resolve();
    await release.promise;
  });
  const second = queue.run('/workspace/note.txt', async () => { secondRan = true; }, controller.signal);

  await started.promise;
  controller.abort(new Error('cancel queued write'));
  await assert.rejects(second, { code: 'loop_cancelled' });
  assert.equal(secondRan, false);
  release.resolve();
  await first;
  await queue.run('/workspace/note.txt', async () => { secondRan = true; });
  assert.equal(secondRan, true);
});

test('cancellation after a filesystem operation starts does not release its path slot early', async () => {
  const queue = createFileWriteQueue();
  const started = deferred();
  const release = deferred();
  const controller = new AbortController();
  let secondRan = false;
  const first = queue.run('/workspace/note.txt', async () => {
    started.resolve();
    await release.promise;
  }, controller.signal);
  const second = queue.run('/workspace/note.txt', async () => { secondRan = true; });

  await started.promise;
  controller.abort(new Error('cancel after the write started'));
  await Promise.resolve();
  assert.equal(secondRan, false);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(secondRan, true);
});
