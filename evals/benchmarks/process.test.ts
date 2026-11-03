import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from './lib.ts';

async function markerValue(path: string): Promise<string> {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch { return ''; }
}

test('process runner captures normal exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-process-normal-'));
  try {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      cwd: root, env: process.env, timeoutMs: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'ok');
    assert.equal(result.timedOut, false);
    assert.equal(result.interrupted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeout kills descendants and reports a completed termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-process-tree-'));
  try {
    const marker = join(root, 'heartbeat.txt');
    const parent = join(root, 'parent.cjs');
    await writeFile(parent, [
      "const { spawn } = require('node:child_process');",
      "const marker = process.argv[2];",
      "spawn(process.execPath, ['-e', \"const fs=require('node:fs');let n=0;setInterval(()=>fs.writeFileSync(process.argv[1],String(n++)),50)\", marker], { stdio: 'ignore' });",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'), 'utf8');
    const result = await runProcess(process.execPath, [parent, marker], {
      cwd: root, env: process.env, timeoutMs: 700,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationPending, false);
    const first = await markerValue(marker);
    assert.notEqual(first, '');
    await delay(500);
    assert.equal(await markerValue(marker), first, 'a descendant kept writing after the timeout');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
