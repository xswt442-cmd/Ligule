import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSessionLog, listSessions } from '../dist/index.js';
import { SESSION_LOCK_STALE_MS, sessionWriterActive } from '../dist/session/lock.js';

type WriterProcess = ChildProcessWithoutNullStreams & { exited: Promise<unknown> };

const writerPath = fileURLToPath(new URL('./fixtures/session-writer.mjs', import.meta.url));

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

async function withSessionDirectory(run: (directory: string) => void | Promise<void>): Promise<void> {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'session-lock-'));
  const absoluteDirectory = resolve(directory);
  assert.equal(absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  try {
    await run(directory);
  } finally {
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

function startWriter(operation: string, directory: string, id: string, text: string): WriterProcess {
  const child = spawn(process.execPath, [writerPath, operation, directory, id, text], { stdio: ['pipe', 'pipe', 'pipe'] }) as WriterProcess;
  child.exited = once(child, 'exit');
  return child;
}

async function readReport(child: WriterProcess): Promise<Record<string, unknown>> {
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk.toString();
    const newline = buffer.indexOf('\n');
    if (newline >= 0) return JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
  }
  throw new Error(`session_writer_report_missing: ${child.stderr.read()?.toString() ?? ''}`);
}

async function stopChild(child: WriterProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await child.exited;
}

test('session writers exclude each other while reads and listings continue, then resume sequence after close', async () => {
  await withSessionDirectory(async (directory) => {
    const writer = createSessionLog({ directory, id: 'shared', meta: { projectRoot: directory } });
    await writer.acquire();
    await writer.append({ kind: 'user', text: 'parent owns the lease' });
    assert.equal(await sessionWriterActive(writer.path), true);

    const child = startWriter('acquire', directory, 'shared', 'child contender');
    const report = await readReport(child);
    await child.exited;
    assert.equal(report.acquired, false);
    assert.equal(report.code, 'session_locked');

    assert.deepEqual((await writer.read()).map((event) => event.seq), [0]);
    assert.equal((await listSessions(directory)).find((session) => session.id === 'shared')!.events, 1);
    await writer.close();
    await writer.close();
    assert.equal(await sessionWriterActive(writer.path), false);
    await assert.rejects(writer.append({ kind: 'user', text: 'after close' }), (error) => hasCode(error, 'session_closed'));

    const next = createSessionLog({ directory, id: 'shared', meta: { projectRoot: directory } });
    await next.acquire();
    await next.append({ kind: 'user', text: 'next owner continues' });
    await next.close();
    assert.deepEqual((await next.read()).map((event) => event.seq), [0, 1]);
  });
});

test('a killed writer stays locked until the real stale lease expires', { timeout: SESSION_LOCK_STALE_MS + 20000 }, async () => {
  await withSessionDirectory(async (directory) => {
    let child: WriterProcess | undefined;
    try {
      child = startWriter('hold', directory, 'crashed', 'written before kill');
      const report = await readReport(child);
      assert.equal(report.acquired, true);
      await stopChild(child, 'SIGKILL');

      const immediate = createSessionLog({ directory, id: 'crashed' });
      await assert.rejects(immediate.acquire(), (error) => hasCode(error, 'session_locked'));
      await immediate.close();

      await delay(SESSION_LOCK_STALE_MS + 1200);
      const recovered = createSessionLog({ directory, id: 'crashed' });
      await recovered.acquire();
      await recovered.append({ kind: 'user', text: 'writer after stale lease' });
      await recovered.close();
      assert.deepEqual((await recovered.read()).map((event) => event.seq), [0, 1]);
    } finally {
      if (child !== undefined) await stopChild(child, 'SIGKILL');
    }
  });
});
