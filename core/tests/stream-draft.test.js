import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel, createLoop, createSessionLog } from '../dist/index.js';
import { createControl } from '../dist/host/control.js';
import { withTuiHost } from './helpers/tui-host.ts';

async function workspace(run) {
  const parent = resolve('testplace');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'stream-draft-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('hard termination preserves bounded provisional output separately from model messages', async () => {
  await workspace(async directory => {
    const fixture = fileURLToPath(new URL('./fixtures/streaming-writer.mjs', import.meta.url));
    const child = spawn(process.execPath, [fixture, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'exit');
    try {
      const marker = await Promise.race([
        once(child.stdout, 'data').then(([data]) => data),
        closed.then(() => { throw new Error('stream fixture exited before producing output'); }),
      ]);
      assert.match(marker.toString(), /STREAM_VISIBLE/);
      child.kill('SIGKILL');
      await closed;
      const reader = createSessionLog({ directory, id: 'interrupted-stream' });
      const events = await reader.read();
      const provisional = await reader.readProvisionalOutput?.(events) ?? null;
      assert.ok(provisional, 'text shown before termination must have a recoverable provisional snapshot');
      assert.equal(provisional.provisional, true);
      assert.equal(provisional.reasoning, 'Unconfirmed reasoning.');
      assert.ok(provisional.text.endsWith('界🙂'));
      assert.ok(provisional.text.length <= 8192);
      assert.equal(provisional.truncated, true);
      assert.ok((await readFile(join(directory, 'interrupted-stream.stream.json'))).length < 128 * 1024);
      assert.equal(events.some(event => event.kind === 'assistant'), false);
      assert.deepEqual((await reader.modelView()).map(message => message.role), ['user']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
});

test('a completed response clears its provisional snapshot and records one canonical answer', async () => {
  await workspace(async directory => {
    const session = createSessionLog({ directory, id: 'completed-stream' });
    const provider = { async *stream() { yield { type: 'text', text: 'The complete answer.' }; } };
    await createLoop({ kernel: createKernel({ session }), provider, session }).run('Answer.');
    const events = await session.read();
    assert.equal(await session.readProvisionalOutput?.(events) ?? null, null);
    assert.equal(events.filter(event => event.kind === 'assistant').length, 1);
    assert.equal((await session.modelView()).at(-1).text, 'The complete answer.');
    await assert.rejects(readFile(join(directory, 'completed-stream.stream.json')), { code: 'ENOENT' });
  });
});

test('Host and external record reads expose provisional text and isolate damaged snapshots', async () => {
  await withTuiHost(async ({ host, client, projectDirectory, sessionDirectory, sessionId }) => {
    const session = createSessionLog({ directory: sessionDirectory, id: sessionId });
    const writer = session.beginOutput(undefined, error => { throw error; });
    const control = createControl(host, projectDirectory);
    try {
      await writer.append({ type: 'text', text: 'Unconfirmed output for inspection.' });
      await control.open(projectDirectory, sessionId);
      const result = await control.read(sessionId, undefined, 20);
      assert.equal(result.provisionalOutput.provisional, true);
      assert.equal(result.provisionalOutput.text, 'Unconfirmed output for inspection.');
      assert.equal(result.provisionalOutputError, null);
      assert.equal((await session.modelView()).some(message => message.text?.includes('Unconfirmed output')), false);
      await writer.discard();
      await writeFile(join(sessionDirectory, `${sessionId}.stream.json`), '{incomplete');
      const damaged = await client.request('session.read', { sessionId });
      assert.equal(damaged.provisionalOutput, null);
      assert.equal(damaged.provisionalOutputError, 'session_stream_invalid');
      assert.ok(Array.isArray(damaged.events));
    } finally {
      await writer.discard();
      await control.release();
    }
  });
});

test('a snapshot left after a committed response is not shown as unfinished output', async () => {
  await workspace(async directory => {
    const session = createSessionLog({ directory, id: 'committed' });
    const writer = session.beginOutput(undefined, error => { throw error; });
    await writer.append({ type: 'text', text: 'The answer.' });
    await session.append({ kind: 'assistant', text: 'The answer.', responseId: writer.responseId, toolCalls: [] });
    assert.equal(await session.readProvisionalOutput(await session.read()), null);
    await writer.discard();
  });
});

test('a real snapshot write failure aborts the turn and reports a persistence error', async () => {
  await workspace(async directory => {
    const session = createSessionLog({ directory, id: 'blocked' });
    await mkdir(join(directory, 'blocked.stream.json'));
    const provider = { async *stream() { yield { type: 'text', text: 'A response whose journal cannot be written.' }; } };
    await assert.rejects(createLoop({ kernel: createKernel({ session }), provider, session }).run('Answer.'), { code: 'session_stream_write_failed' });
    const events = await session.read();
    assert.equal(events.findLast(event => event.kind === 'turn').code, 'session_stream_write_failed');
    assert.equal(events.findLast(event => event.kind === 'turn').status, 'failed');
  });
});

test('the next writer preserves unknown stale atomic snapshot files', async () => {
  await workspace(async directory => {
    const stale = join(directory, 'pruned.stream.json.00000000-0000-0000-0000-000000000000.tmp');
    const unrelated = join(directory, 'other.stream.json.00000000-0000-0000-0000-000000000000.tmp');
    await writeFile(stale, 'interrupted write');
    await writeFile(unrelated, 'another session');
    const session = createSessionLog({ directory, id: 'pruned' });
    const writer = session.beginOutput(undefined, error => { throw error; });
    await writer.append({ type: 'text', text: 'A new pending response.' });
    assert.equal(await readFile(stale, 'utf8'), 'interrupted write');
    assert.equal(await readFile(unrelated, 'utf8'), 'another session');
    assert.ok(await readFile(join(directory, 'pruned.stream.json'), 'utf8'));
    await writer.discard();
  });
});
