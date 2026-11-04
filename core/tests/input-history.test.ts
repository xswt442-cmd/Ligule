// 终端界面和宿主运行在不同进程中，但共用同一份输入历史文件。
// 那一次读—改—写要跨进程排队，所以除了并发排队，还量一把被人占着的锁。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import lockfile from 'proper-lockfile';
import { HISTORY_LIMIT, loadHistory, rememberHistory } from '../dist/kernel/input-history.js';

const testplace = resolve('testplace');
const writer = fileURLToPath(new URL('./fixtures/history-writer.mjs', import.meta.url));

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;
const detailOf = (error: unknown): string => (error as { detail?: string }).detail ?? '';

async function withHistoryDirectory<TResult>(run: (directory: string) => TResult | Promise<TResult>): Promise<TResult> {
  const directory = await mkdtemp(join(testplace, 'input-history-'));
  const absoluteDirectory = resolve(directory);
  assert.equal(absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  try {
    return await run(directory);
  } finally {
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

test('history saves serialize, merge concurrent snapshots, and use distinct temporary files', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    await Promise.all([
      rememberHistory(path, ['first']),
      rememberHistory(path, ['second']),
      rememberHistory(path, ['third']),
    ]);
    const entries = await loadHistory(path);
    assert.deepEqual(entries, ['third', 'second', 'first']);
    assert.deepEqual((await readdir(directory)).sort(), ['history.jsonl']);
  });
});

test('history reads reject malformed and non-string lines with a stable code', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    await writeFile(path, '"valid"\nnot-json\n');
    await assert.rejects(loadHistory(path), (error) => codeOf(error) === 'input_history_invalid' && detailOf(error).includes('line 2'));
    await writeFile(path, '42\n');
    await assert.rejects(loadHistory(path), (error) => codeOf(error) === 'input_history_invalid' && detailOf(error).includes('line 1'));
  });
});

test('failed history replacement removes its temporary file', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'occupied');
    await mkdir(path);
    await writeFile(join(path, 'keep'), 'content');
    await assert.rejects(rememberHistory(path, ['sentence']));
    assert.deepEqual((await readdir(directory)).sort(), ['occupied']);
    assert.equal(await readFile(join(path, 'keep'), 'utf8'), 'content');
  });
});

// 两端各开各的进程，写的是同一份文件：那一把锁要在真起进程的那一趟里才证明得了。
test('history saves from separate processes keep every sentence', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    const sentences = [1, 2, 3, 4].map((one) => `第 ${one} 具进程写的那一句`);
    const reports = await Promise.all(sentences.map(async (sentence) => {
      const child = spawn(process.execPath, [writer, path, sentence], { stdio: ['ignore', 'pipe', 'pipe'] });
      let line = '';
      for await (const chunk of child.stdout) {
        line += String(chunk);
        if (line.includes('\n')) break;
      }
      await once(child, 'exit');
      return JSON.parse(line);
    }));
    assert.deepEqual(reports, sentences.map(() => ({ written: true })), '四具都该写成功，而不是报那一份文件被人占着');
    const entries = await loadHistory(path);
    for (const sentence of sentences) assert.ok(entries.includes(sentence), `那一份文件里少了那一句：${sentence}`);
  });
});

// 界面手里那份快照会过期：另一端在这之后写过，基准就得是文件里此刻那一份，不是界面读到过的那一份。
test('a save merges into what the file holds now, not into the caller older snapshot', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    await rememberHistory(path, ['old']);
    // 桌面先写下它那一句，终端后写自己这一句：终端那句排最前，桌面那句仍排在更早那一句之前，不被终端的旧读法挤到后面。
    await rememberHistory(path, ['desktop']);
    const written = await rememberHistory(path, ['terminal']);
    assert.deepEqual(written, ['terminal', 'desktop', 'old'], '本次新增排最前，其余按文件里此刻的顺序');
    assert.deepEqual(await loadHistory(path), written, '交回的清单就是文件里那一份');
  });
});

// 满额时更明显：一份旧快照整体写回去会把文件里那 200 条新输入整份挤掉。
test('a full file loses its oldest sentences, not another surface newest ones', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    const onDisk = Array.from({ length: HISTORY_LIMIT }, (_, index) => `磁盘里的第 ${index + 1} 条`);
    await writeFile(path, onDisk.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    // 这一边只交出自己刚发出去的那一句：它先前读到过的那些本来就在文件里。
    const written = await rememberHistory(path, ['这一边新发的一句']);
    assert.equal(written.length, HISTORY_LIMIT);
    assert.deepEqual(written.slice(0, 2), ['这一边新发的一句', onDisk[0]]);
    assert.equal(written.includes(onDisk.at(-1)!), false, '满额时从最旧那一条开始丢');
    assert.equal(written.filter((entry) => entry.startsWith('磁盘里的')).length, HISTORY_LIMIT - 1, '磁盘里更新的那 199 条一条不少');
  });
});

// 另一具进程占着那份文件时不静默改写：等不到锁就说清是哪一份文件被占着（与那份登记同一条码法）。
test('a history save that cannot take the file reports which file is held', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    await writeFile(path, '"更早的一句"\n');
    const held = await lockfile.lock(path, { realpath: false, lockfilePath: `${path}.lock`, stale: 10_000, update: 2_000, retries: 0 });
    try {
      await assert.rejects(rememberHistory(path, ['后写的一句']), (error) => codeOf(error) === 'input_history_locked' && detailOf(error) === path);
    } finally {
      await held();
    }
    assert.deepEqual(await loadHistory(path), ['更早的一句']);
  });
});
