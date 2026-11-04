import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from './lib.ts';

// 测试自己收掉后代：Windows 上 runner 拿不到 PGID，收不到父进程退出的那一组。
async function stopDescendant(pidFile: string): Promise<void> {
  const raw = await readFile(pidFile, 'utf8').catch(() => '');
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* the descendant is already gone */ }
}

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

test('a process that exits while a descendant holds the pipes still settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-process-drain-'));
  const pidFile = join(root, 'grandchild.pid');
  try {
    const child = join(root, 'child.cjs');
    const marker = join(root, 'heartbeat.txt');
    // 子进程立刻退出，但后代继承 stdio 并一直活着：结果必须按真实退出码收口，
    // 不能因为 close 迟迟不来就把整次评测挂住，也不能把后代留在后台继续跑。
    await writeFile(child, [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const marker = process.argv[2];",
      "const pidFile = process.argv[3];",
      "const grandchild = spawn(process.execPath, ['-e', \"const fs=require('node:fs');let n=0;setInterval(()=>fs.writeFileSync(process.argv[1],String(n++)),50)\", marker], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "fs.writeFileSync(pidFile, String(grandchild.pid));",
      'process.stdout.write("bye");',
      'setTimeout(() => process.exit(3), 150);',
      '',
    ].join('\n'), 'utf8');
    const started = Date.now();
    const result = await runProcess(process.execPath, [child, marker, pidFile], {
      cwd: root, env: process.env, timeoutMs: 60_000,
    });
    assert.equal(result.status, 3);
    assert.equal(result.timedOut, false);
    assert.equal(result.terminationPending, false);
    assert.equal(result.stdout, 'bye');
    assert.ok(Date.now() - started < 30_000, 'the runner waited for a leaked pipe instead of settling');
    // 后代若还活着会继续写 marker：收口之后数值必须停住。
    const first = await markerValue(marker);
    assert.notEqual(first, '');
    await delay(500);
    // POSIX 上 runner 按进程组收掉后代；Windows 只能收父进程，后代要由测试自己清掉，
    // 否则每跑一次测试就会留下一个 Node 进程。
    if (process.platform !== 'win32') {
      assert.equal(await markerValue(marker), first, 'a descendant kept running after the parent exited');
    }
  } finally {
    await stopDescendant(pidFile);
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing command reports its spawn error instead of a phantom termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-process-missing-'));
  try {
    const result = await runProcess('ligule-definitely-missing-command', [], {
      cwd: root, env: process.env, timeoutMs: 10_000,
    });
    assert.equal(result.status, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.terminationPending, false);
    assert.match(result.error ?? '', /ENOENT|not found/iu);
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
