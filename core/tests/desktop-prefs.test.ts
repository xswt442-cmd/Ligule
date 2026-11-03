import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DESKTOP_PREFS_LIMIT_BYTES, loadPrefs, parsePrefsJson, prefsPathOf, readPrefs, savePrefs } from '../dist/kernel/desktop-prefs.js';

const tempRoot = join(process.cwd(), 'testplace', 'tmp');

type PrefsWriteOutcome = { code: number | null; result: { code?: string }; stderr: string };
type HolderExit = { error: Error } | { code: number | null; signal: NodeJS.Signals | null };
type FileHolder = {
  child: ChildProcess;
  exit: HolderExit | null;
  stderr: string;
  exited?: Promise<HolderExit>;
  readyPath: string;
};
type SaveFailure = { code?: string; cause?: { code?: string; syscall?: string } };
type SaveOutcome = { value?: { saved?: unknown; error?: { code?: string } } };

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: string }).code === code;
}

async function makeDirectory() {
  const path = join(tempRoot, `desktop-prefs-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function childWrite(path: string, version: string, value: unknown): Promise<PrefsWriteOutcome> {
  const fixture = join(process.cwd(), 'tests', 'fixtures', 'prefs-writer.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, path, version, JSON.stringify(value)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        resolve({ code, result: JSON.parse(stdout), stderr });
      } catch (error) {
        reject(new Error(`prefs writer returned invalid output: ${stdout}${stderr}`, { cause: error }));
      }
    });
  });
}

async function assertNoWriteArtifacts(directory: string): Promise<void> {
  const entries = await readdir(directory);
  assert.equal(entries.some((name) => name.endsWith('.tmp')), false, '保存结束后不留临时文件');
  assert.equal(entries.some((name) => name.endsWith('.lock')), false, '保存结束后不留锁目录');
}

function startWindowsFileHolder({ path, root, holdMilliseconds, releasePath }: {
  path: string; root: string; holdMilliseconds: number; releasePath?: string;
}): FileHolder {
  const fixture = join(process.cwd(), 'tests', 'fixtures', 'prefs-holder.ps1');
  const readyPath = join(root, 'holder-ready');
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture,
    '-Path', path, '-ReadyPath', readyPath, '-HoldMilliseconds', String(holdMilliseconds),
  ];
  if (releasePath !== undefined) args.push('-ReleasePath', releasePath);

  const child = spawn('powershell.exe', args, { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
  const holder: FileHolder = { child, exit: null, stderr: '', readyPath };
  const exited = new Promise<HolderExit>((resolve) => {
    child.once('error', (error) => {
      const exit: HolderExit = { error };
      holder.exit = exit;
      resolve(exit);
    });
    child.once('exit', (code, signal) => {
      const exit: HolderExit = { code, signal };
      holder.exit = exit;
      resolve(exit);
    });
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { holder.stderr += chunk; });
  holder.exited = exited;
  return holder;
}

async function releaseWindowsFileHolder(holder: FileHolder, releasePath: string): Promise<HolderExit | undefined> {
  if (holder.exit !== null) return holder.exit;
  const killTimer = setTimeout(() => holder.child.kill(), 5_000);
  try {
    try {
      await writeFile(releasePath, 'release', 'utf8');
    } catch {
      holder.child.kill();
    }
    return await holder.exited;
  } finally {
    clearTimeout(killTimer);
  }
}

async function waitForHolderMarker(holder: FileHolder, markerPath: string): Promise<boolean> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(markerPath, 'utf8')) === 'ready') return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    if (holder.exit !== null) throw new Error(`Windows 文件占用进程提前退出：${holder.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = holder.exit === null ? 'still running' : JSON.stringify(holder.exit);
  if (holder.exit === null) {
    holder.child.kill();
    await holder.exited;
  }
  throw new Error(`Windows 文件占用进程没有创建标记（${status}）：${holder.stderr}`);
}

async function waitForPendingSave(root: string, holder: FileHolder, outcome: SaveOutcome): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await readdir(root)).some((name) => name.endsWith('.tmp'))) return;
    assert.equal(outcome.value, undefined, '外部改写前保存仍在等待替换');
    if (holder.exit !== null) throw new Error(`Windows 文件占用进程提前退出：${holder.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`保存没有创建临时文件：${holder.stderr}`);
}

test('desktop preferences: reads distinguish a missing file from a valid empty object', async () => {
  const root = await makeDirectory();
  const path = join(root, 'nested', 'desktop.json');
  try {
    assert.deepEqual(await readPrefs(path), { settings: {}, version: '' });
    const saved = await savePrefs(path, {});
    assert.deepEqual(saved.settings, {});
    assert.equal(saved.version, createHash('sha256').update(await readFile(path)).digest('hex'));
    assert.notEqual(saved.version, '');
    assert.deepEqual(await readPrefs(path), saved);
    assert.deepEqual(await loadPrefs(path), {});
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600, '新文件仅允许本人读写');
    assert.equal(prefsPathOf('/home/someone'), join('/home/someone', '.ligule', 'desktop.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: malformed and non-object files are refused without changing their bytes', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    for (const original of ['{ not json', '[1,2]', '"text"']) {
      await writeFile(path, original, 'utf8');
      await assert.rejects(loadPrefs(path), (error) => hasCode(error, 'desktop_prefs_invalid'));
      await assert.rejects(readPrefs(path), (error) => hasCode(error, 'desktop_prefs_invalid'));
      await assert.rejects(savePrefs(path, { replacement: true }), (error) => hasCode(error, 'desktop_prefs_invalid'));
      assert.equal(await readFile(path, 'utf8'), original, '拒绝坏文件时原字节不变');
      await assertNoWriteArtifacts(root);
    }
    assert.throws(() => parsePrefsJson('{ not json'), (error) => hasCode(error, 'desktop_prefs_invalid'));
    assert.throws(() => parsePrefsJson('[1]'), (error) => hasCode(error, 'desktop_prefs_invalid'));
    assert.throws(() => parsePrefsJson('x'.repeat(DESKTOP_PREFS_LIMIT_BYTES + 1)), (error) => hasCode(error, 'desktop_prefs_too_large'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: stale versions refuse a whole-file replacement', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    const initial = await savePrefs(path, { palette: 'forest' });
    const first = await savePrefs(path, { palette: 'sky' }, { version: initial.version });
    const bytes = await readFile(path);
    await assert.rejects(savePrefs(path, { palette: 'dusk' }, { version: initial.version }), (error) => hasCode(error, 'desktop_prefs_version_stale'));
    assert.deepEqual(await readFile(path), bytes, '过期版本拒写且原文件字节不变');
    assert.deepEqual(await loadPrefs(path), first.settings);
    await assertNoWriteArtifacts(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: two processes using one base version produce one save and one stale result', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    const base = await savePrefs(path, { stable: 'keep' });
    const outcomes = await Promise.all([
      childWrite(path, base.version, { stable: 'keep', writer: 'one' }),
      childWrite(path, base.version, { stable: 'keep', writer: 'two' }),
    ]);
    assert.equal(outcomes.filter((item) => item.code === 0).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter((item) => item.result?.code === 'desktop_prefs_version_stale').length, 1, JSON.stringify(outcomes));
    const landed = await loadPrefs(path);
    assert.equal(landed.stable, 'keep');
    assert.ok(landed.writer === 'one' || landed.writer === 'two');
    await assertNoWriteArtifacts(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: byte limits and existing permissions are enforced', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    const overLimit = { text: 'x'.repeat(DESKTOP_PREFS_LIMIT_BYTES) };
    await assert.rejects(savePrefs(path, overLimit), (error) => hasCode(error, 'desktop_prefs_too_large'));
    assert.equal((await readdir(root)).includes('desktop.json'), false, '超限新值不创建目标文件');
    await assertNoWriteArtifacts(root);
    await writeFile(path, ' '.repeat(DESKTOP_PREFS_LIMIT_BYTES + 1), 'utf8');
    await assert.rejects(loadPrefs(path), (error) => hasCode(error, 'desktop_prefs_too_large'));
    await assert.rejects(savePrefs(path, { next: true }), (error) => hasCode(error, 'desktop_prefs_too_large'));
    assert.equal((await readFile(path, 'utf8')).length, DESKTOP_PREFS_LIMIT_BYTES + 1, '超限原件字节不变');
    await rm(path);

    await writeFile(path, '{"old":true}\n', 'utf8');
    if (process.platform !== 'win32') await chmod(path, 0o640);
    await savePrefs(path, { next: true });
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o640, '替换后保留原权限位');
    await assertNoWriteArtifacts(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const windowsTest: (name: string, run: () => Promise<void>) => void = process.platform === 'win32'
  ? (name, run) => test(name, run)
  : (name, run) => test.skip(name, { skip: 'Windows 文件共享语义专属' }, run);

windowsTest('desktop preferences: a brief Windows file handle allows the save to finish', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  const initial = await savePrefs(path, { owner: 'initial' });
  const holder = startWindowsFileHolder({ path, root, holdMilliseconds: 500 });
  try {
    await waitForHolderMarker(holder, holder.readyPath);
    assert.equal(holder.exit, null, '文件占用进程在保存开始时仍持有文件');
    const saved = await savePrefs(path, { owner: 'saved after short hold' }, { version: initial.version });
    assert.equal(saved.settings.owner, 'saved after short hold');
    assert.notEqual(saved.version, initial.version);
    const exit = await holder.exited;
    assert.deepEqual(exit, { code: 0, signal: null }, holder.stderr);
    assert.deepEqual(await readPrefs(path), saved);
    await assertNoWriteArtifacts(root);
  } finally {
    if (holder.exit === null) {
      holder.child.kill();
      await holder.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('desktop preferences: a sustained Windows file handle preserves the original and permits retry', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  const releasePath = join(root, 'holder-release');
  const initialValue = { owner: 'initial' };
  const initial = await savePrefs(path, initialValue);
  const initialBytes = await readFile(path);
  const holder = startWindowsFileHolder({ path, root, holdMilliseconds: 0, releasePath });
  try {
    await waitForHolderMarker(holder, holder.readyPath);
    let saveError: SaveFailure | undefined;
    try {
      await savePrefs(path, { owner: 'replacement' }, { version: initial.version });
    } catch (error) {
      saveError = error as SaveFailure;
    }
    assert.equal(saveError?.code, 'desktop_prefs_replace_failed');
    assert.ok(['EACCES', 'EBUSY', 'EPERM'].includes(saveError?.cause?.code as string), JSON.stringify(saveError?.cause));
    assert.equal(saveError?.cause?.syscall, 'rename');
    assert.equal(holder.exit, null, '失败返回时文件占用进程仍持有文件');
    assert.deepEqual(await readFile(path), initialBytes, '替换失败时原字节保持不变');
    assert.deepEqual(await readPrefs(path), initial);
    await assertNoWriteArtifacts(root);

    const exit = await releaseWindowsFileHolder(holder, releasePath);
    assert.deepEqual(exit, { code: 0, signal: null }, holder.stderr);
    const current = await readPrefs(path);
    const retry = await savePrefs(path, { owner: 'saved after releasing holder' }, { version: current.version });
    assert.equal(retry.settings.owner, 'saved after releasing holder');
    assert.deepEqual(await readPrefs(path), retry);
    await assertNoWriteArtifacts(root);
  } finally {
    await releaseWindowsFileHolder(holder, releasePath);
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('desktop preferences: an external Windows write during a held save makes the base version stale', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  const initialValue = { owner: 'alpha', sentinel: 'keep' };
  const externalValue = { owner: 'bravo', sentinel: 'keep' };
  const initial = await savePrefs(path, initialValue);
  const holder = startWindowsFileHolder({
    path,
    root,
    holdMilliseconds: 2_500,
  });
  try {
    await waitForHolderMarker(holder, holder.readyPath);
    const outcome: SaveOutcome = {};
    const pendingSave = savePrefs(path, { owner: 'must not replace external write', sentinel: 'keep' }, { version: initial.version }).then(
      (saved) => { outcome.value = { saved }; },
      (error) => { outcome.value = { error }; },
    );
    await waitForPendingSave(root, holder, outcome);
    assert.equal(holder.exit, null, '外部写入发生时文件占用进程仍持有文件');
    const externalBytes = Buffer.from(`${JSON.stringify(externalValue)}\n`);
    // 同步改写已打开文件，保持长度；保存进程的下次版本检查会读到完整的外部内容。
    writeFileSync(path, externalBytes, { flag: 'r+' });
    await pendingSave;
    assert.equal(outcome.value?.error?.code, 'desktop_prefs_version_stale');
    assert.deepEqual(await readFile(path), externalBytes, '过期写入保留外部文档字节');
    assert.deepEqual(await readPrefs(path), { settings: externalValue, version: createHash('sha256').update(externalBytes).digest('hex') });
    const exit = await holder.exited;
    assert.deepEqual(exit, { code: 0, signal: null }, holder.stderr);
    await assertNoWriteArtifacts(root);
  } finally {
    if (holder.exit === null) {
      holder.child.kill();
      await holder.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
