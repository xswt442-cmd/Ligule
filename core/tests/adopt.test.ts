// 验证会话迁移会将旧位置的记录复制到数据根，保留原件，并能安全重跑。
// 测试使用临时目录与独立 Node 进程核对锁和发布行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { adoptForSessionDirectory, adoptLegacySessions, listWorkspaceSessions, prefixDigest, sessionDirectories, sessionDirectory } from '../dist/index.js';
import type { AdoptionReport } from '../dist/session/adopt.js';

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;

function startNode(source: string, args: string[] = []) {
  return spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function waitForOutput(child: ReturnType<typeof startNode>): Promise<string> {
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk.toString();
    const line = output.indexOf('\n');
    if (line >= 0) return output.slice(0, line);
  }
  throw new Error(`child exited before reporting readiness: ${output}`);
}

test('workspace sessions use a readable path folder under the user data root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ligule-session-dir-'));
  const project = join(home, 'project');
  const previous = process.env.LIGULE_HOME;
  delete process.env.LIGULE_HOME;
  try {
    const config = { boundary: project, workspaceRoot: project, userHome: home };
    const directory = sessionDirectory(config);
    assert.equal(dirname(dirname(directory)), join(home, '.ligule', 'workspaces'));
    assert.equal(basename(directory), 'sessions');
    assert.match(basename(dirname(directory)), /-project--[a-f0-9]{16}$/);
    assert.equal(sessionDirectory({ ...config, workspaceRoot: join(project, '.') }), directory, '路径别名使用同一目录');
    assert.notEqual(sessionDirectory({ ...config, workspaceRoot: join(home, 'other') }), directory, '不同工作区分开存放');
    assert.equal(sessionDirectory({ ...config, host: { sessionDirectory: join(home, 'given') } }), join(home, 'given'));
    assert.deepEqual(sessionDirectories({ ...config, host: { sessionDirectory: join(home, 'given') } }), [join(home, 'given')]);
  } finally {
    if (previous !== undefined) process.env.LIGULE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('workspace session listing reads new and legacy locations without migrating files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-session-read-only-list-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const other = join(root, 'other');
  const previous = process.env.LIGULE_HOME;
  delete process.env.LIGULE_HOME;
  try {
    await Promise.all([mkdir(home), mkdir(project), mkdir(other)]);
    const shared = join(home, '.ligule', 'sessions');
    const local = join(project, '.ligule', 'sessions');
    await Promise.all([mkdir(shared, { recursive: true }), mkdir(local, { recursive: true })]);
    const sharedRecord = join(shared, 'shared-match.jsonl');
    const otherRecord = join(shared, 'other-project.jsonl');
    const unknownRecord = join(shared, 'unknown.jsonl');
    const localRecord = join(local, 'project-local.jsonl');
    await writeFile(sharedRecord, `${JSON.stringify({ kind: 'session', formatVersion: 2, sessionId: 'shared-match', projectRoot: project })}\n`);
    await writeFile(otherRecord, `${JSON.stringify({ kind: 'session', formatVersion: 2, sessionId: 'other-project', projectRoot: other })}\n`);
    await writeFile(unknownRecord, '{"seq":0,"kind":"user","text":"unknown"}\n');
    await writeFile(localRecord, '{"seq":0,"kind":"user","text":"local"}\n');
    const before = await readFile(sharedRecord);
    const config = { boundary: project, workspaceRoot: project, userHome: home };

    const listed = await listWorkspaceSessions(config);

    assert.deepEqual(new Set(listed.map((item) => item.id)), new Set(['shared-match', 'project-local']));
    assert.deepEqual(await readFile(sharedRecord), before, '读取不改共享旧记录');
    await assert.rejects(access(sessionDirectory(config)), (error) => codeOf(error) === 'ENOENT', '读取不创建新的会话目录');
  } finally {
    if (previous !== undefined) process.env.LIGULE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy session files are copied once into the data root and the originals stay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-'));
  try {
    const legacy = join(root, 'project', '.ligule', 'sessions');
    const target = join(root, 'home', '.ligule', 'sessions');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'aaa.jsonl'), '{"seq":0,"kind":"tool","result":{"spilled":"result-3-abcdef01.json"}}\n', 'utf8');
    await writeFile(join(legacy, 'aaa.checkpoint.json'), '{}\n', 'utf8');
    await writeFile(join(legacy, 'result-3-abcdef01.json'), 'x'.repeat(10), 'utf8');
    await writeFile(join(legacy, 'notes.txt'), 'x', 'utf8');

    const first = await adoptLegacySessions(legacy, target);
    assert.deepEqual(first.copied.sort(), ['aaa.checkpoint.json', 'aaa.jsonl', 'result-3-abcdef01.json']);
    assert.deepEqual(first.unknown, ['notes.txt'], '不认识的条目列出来、不复制');
    assert.equal(await readFile(join(legacy, 'aaa.jsonl'), 'utf8'), '{"seq":0,"kind":"tool","result":{"spilled":"result-3-abcdef01.json"}}\n', '原件保留');
    // 复制时保留源文件的修改时间，因为会话列表按该时间排序。
    // 文件系统时间可能存在毫秒以下的精度差异；列表只显示到毫秒，因此比较到毫秒即可。
    const [source, copied] = await Promise.all([stat(join(legacy, 'aaa.jsonl')), stat(join(target, 'aaa.jsonl'))]);
    assert.ok(Math.abs(copied.mtimeMs - source.mtimeMs) <= 1, `补齐不改那一份自己的时间：${copied.mtimeMs} 对 ${source.mtimeMs}`);

    const second = await adoptLegacySessions(legacy, target);
    assert.deepEqual(second.copied, [], '再跑只做比对');
    assert.deepEqual(second.already.sort(), ['aaa.checkpoint.json', 'aaa.jsonl', 'result-3-abcdef01.json']);

    // 目标目录中已有同 ID 但内容不同的记录时，应报错并保留目标文件。
    await writeFile(join(target, 'aaa.jsonl'), 'changed\n', 'utf8');
    const third = await adoptLegacySessions(legacy, target);
    assert.deepEqual(third.conflicts, ['aaa.jsonl']);
    assert.equal(await readFile(join(target, 'aaa.jsonl'), 'utf8'), 'changed\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adoption stays off when host.sessionDirectory points somewhere on purpose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-off-'));
  try {
    const legacy = join(root, 'project', '.ligule', 'sessions');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'aaa.jsonl'), '{"seq":0,"kind":"user","text":"old"}\n', 'utf8');
    const off = await adoptForSessionDirectory({ boundary: join(root, 'project'), host: { sessionDirectory: join(root, 'given') } }, join(root, 'given'));
    assert.equal(off, null, '覆盖指了位置的机器不碰旧位置');
    const on = await adoptForSessionDirectory({ boundary: join(root, 'project') }, join(root, 'elsewhere')) as AdoptionReport;
    assert.deepEqual(on.copied, ['aaa.jsonl']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an adoption whose source and destination are the same directory does not deadlock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-same-'));
  try {
    const directory = join(root, 'project', '.ligule', 'sessions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'same.jsonl'), '{"seq":0,"kind":"user","text":"same"}\n');
    const report = await adoptLegacySessions(directory, directory);
    assert.deepEqual(report.already, ['same.jsonl']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a busy source writer in another process leaves the destination record untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-busy-'));
  const legacy = join(root, 'project', '.ligule', 'sessions');
  const target = join(root, 'home', '.ligule', 'sessions');
  const sourcePath = join(legacy, 'busy.jsonl');
  const targetPath = join(target, 'busy.jsonl');
  let child: ReturnType<typeof startNode> | undefined;
  let childExit: ReturnType<typeof once> | undefined;
  try {
    await mkdir(legacy, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(sourcePath, '{"seq":0,"kind":"user","text":"old"}\n');
    await writeFile(targetPath, 'keep this exact target\n');
    child = startNode(`const { acquireSessionLock } = await import(${JSON.stringify(new URL('../dist/session/lock.js', import.meta.url).href)}); await acquireSessionLock(process.argv[1]); console.log('locked'); await new Promise((resolve) => process.stdin.once('data', resolve));`, [sourcePath]);
    childExit = once(child, 'exit');
    assert.equal(await waitForOutput(child), 'locked');

    const report = await adoptLegacySessions(legacy, target);
    assert.deepEqual(report.busy, ['busy.jsonl']);
    assert.equal(await readFile(targetPath, 'utf8'), 'keep this exact target\n');
  } finally {
    if (child !== undefined) {
      child.stdin.end('release');
      await childExit;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('a busy destination writer in another process leaves its bytes untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-target-busy-'));
  const legacy = join(root, 'project', '.ligule', 'sessions');
  const target = join(root, 'home', '.ligule', 'sessions');
  const sourcePath = join(legacy, 'busy.jsonl');
  const targetPath = join(target, 'busy.jsonl');
  let child: ReturnType<typeof startNode> | undefined;
  let childExit: ReturnType<typeof once> | undefined;
  try {
    await mkdir(legacy, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(sourcePath, '{"seq":0,"kind":"user","text":"source"}\n');
    await writeFile(targetPath, 'keep destination bytes\n');
    child = startNode(`const { acquireSessionLock } = await import(${JSON.stringify(new URL('../dist/session/lock.js', import.meta.url).href)}); await acquireSessionLock(process.argv[1]); console.log('locked'); await new Promise((resolve) => process.stdin.once('data', resolve));`, [targetPath]);
    childExit = once(child, 'exit');
    assert.equal(await waitForOutput(child), 'locked');

    const report = await adoptLegacySessions(legacy, target);
    assert.deepEqual(report.busy, ['busy.jsonl']);
    assert.equal(await readFile(targetPath, 'utf8'), 'keep destination bytes\n');
  } finally {
    if (child !== undefined) {
      child.stdin.end('release');
      await childExit;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('two processes publish one complete record without replacing the winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-race-'));
  const firstLegacy = join(root, 'first-project', '.ligule', 'sessions');
  const secondLegacy = join(root, 'second-project', '.ligule', 'sessions');
  const target = join(root, 'home', '.ligule', 'sessions');
  try {
    await mkdir(firstLegacy, { recursive: true });
    await mkdir(secondLegacy, { recursive: true });
    const firstSource = '{"seq":0,"kind":"user","text":"first"}\n';
    const secondSource = '{"seq":0,"kind":"user","text":"second"}\n';
    await writeFile(join(firstLegacy, 'race.jsonl'), firstSource);
    await writeFile(join(secondLegacy, 'race.jsonl'), secondSource);
    const childSource = `const { adoptLegacySessions } = await import(${JSON.stringify(new URL('../dist/session/adopt.js', import.meta.url).href)}); console.log(JSON.stringify(await adoptLegacySessions(process.argv[1], process.argv[2])));`;
    const children = [startNode(childSource, [firstLegacy, target]), startNode(childSource, [secondLegacy, target])];
    const childExits = children.map((child) => once(child, 'exit'));
    const outputs = await Promise.all(children.map(async (child, index) => {
      let stdout = '';
      for await (const chunk of child.stdout) stdout += chunk.toString();
      const [code] = await childExits[index];
      assert.equal(code, 0, '独立进程应成功结束');
      return JSON.parse(stdout.trim());
    }));
    assert.equal(outputs.flatMap((report) => report.copied).filter((name) => name === 'race.jsonl').length, 1);
    assert.equal(outputs.filter((report) => report.conflicts.includes('race.jsonl') || report.busy.includes('race.jsonl')).length, 1);
    const targetBytes = await readFile(join(target, 'race.jsonl'));
    assert.ok(targetBytes.toString('utf8').startsWith('{"kind":"session","formatVersion":0,"sessionId":"race"'));
    const body = targetBytes.subarray(targetBytes.indexOf(0x0a) + 1);
    assert.ok(body.equals(Buffer.from(firstSource)) || body.equals(Buffer.from(secondSource)), '目标只包含某一份完整来源记录');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a conflicting spill target prevents the main record from appearing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-spill-conflict-'));
  try {
    const project = join(root, 'project');
    const legacy = join(project, '.ligule', 'sessions');
    const target = join(root, 'target');
    const record = [
      JSON.stringify({ kind: 'session', formatVersion: 0, sessionId: 'spill', projectRoot: project }),
      JSON.stringify({ seq: 0, kind: 'tool', result: { content: 'omitted', spilled: 'result-1-abcdef12.json' } }),
      '',
    ].join('\n');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'spill.jsonl'), record);
    await writeFile(join(legacy, 'result-1-abcdef12.json'), 'source spill');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'result-1-abcdef12.json'), 'different spill');

    const report = await adoptLegacySessions(legacy, target);
    assert.ok(report.conflicts.includes('result-1-abcdef12.json'));
    assert.ok(report.conflicts.includes('spill.jsonl'));
    await assert.rejects(readFile(join(target, 'spill.jsonl')), (error) => codeOf(error) === 'ENOENT');
    assert.equal(await readFile(join(target, 'result-1-abcdef12.json'), 'utf8'), 'different spill');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing or unreadable referenced spill prevents the main record from appearing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-spill-invalid-'));
  try {
    const project = join(root, 'project');
    const missingLegacy = join(project, '.ligule', 'sessions');
    const missingTarget = join(root, 'missing-target');
    const spill = 'result-2-abcdef12.json';
    const record = [
      JSON.stringify({ kind: 'session', formatVersion: 0, sessionId: 'missing', projectRoot: project }),
      JSON.stringify({ seq: 0, kind: 'tool', result: { content: 'omitted', spilled: spill } }),
      '',
    ].join('\n');
    await mkdir(missingLegacy, { recursive: true });
    await writeFile(join(missingLegacy, 'missing.jsonl'), record);
    const missingReport = await adoptLegacySessions(missingLegacy, missingTarget);
    assert.deepEqual(missingReport.busy, ['missing.jsonl']);
    await assert.rejects(readFile(join(missingTarget, 'missing.jsonl')), (error) => codeOf(error) === 'ENOENT');

    const unreadableLegacy = join(root, 'unreadable-project', '.ligule', 'sessions');
    const unreadableTarget = join(root, 'unreadable-target');
    const unreadableProject = join(root, 'unreadable-project');
    await mkdir(unreadableLegacy, { recursive: true });
    await writeFile(join(unreadableLegacy, 'unreadable.jsonl'), [
      JSON.stringify({ kind: 'session', formatVersion: 0, sessionId: 'unreadable', projectRoot: unreadableProject }),
      JSON.stringify({ seq: 0, kind: 'tool', result: { content: 'omitted', spilled: spill } }),
      '',
    ].join('\n'));
    await mkdir(join(unreadableLegacy, spill));
    await assert.rejects(adoptLegacySessions(unreadableLegacy, unreadableTarget),
      (error) => codeOf(error) === 'session_adoption_read_failed');
    await assert.rejects(readFile(join(unreadableTarget, 'unreadable.jsonl')), (error) => codeOf(error) === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an independent reader sees every spill before the main record appears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-reader-'));
  const project = join(root, 'project');
  const legacy = join(project, '.ligule', 'sessions');
  const target = join(root, 'target');
  const targetRecord = join(target, 'reader.jsonl');
  const targetSpill = join(target, 'result-3-abcdef12.json');
  const observation = join(root, 'observation.txt');
  const spillBytes = Buffer.alloc(16 * 1024 * 1024, 0x61);
  let observer: ReturnType<typeof startNode> | undefined;
  let observerExit: ReturnType<typeof once> | undefined;
  try {
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'reader.jsonl'), [
      JSON.stringify({ kind: 'session', formatVersion: 0, sessionId: 'reader', projectRoot: project }),
      JSON.stringify({ seq: 0, kind: 'tool', result: { content: 'omitted', spilled: 'result-3-abcdef12.json' } }),
      '',
    ].join('\n'));
    await writeFile(join(legacy, 'result-3-abcdef12.json'), spillBytes);
    const observerScript = `import { createHash } from 'node:crypto'; import { existsSync, readFileSync, writeFileSync } from 'node:fs'; console.log('ready'); const deadline = Date.now() + 30000; while (!existsSync(process.argv[1]) && Date.now() < deadline) {} const ready = existsSync(process.argv[1]) && existsSync(process.argv[2]) && createHash('sha256').update(readFileSync(process.argv[2])).digest('hex') === process.argv[3]; writeFileSync(process.argv[4], ready ? 'ready' : 'incomplete');`;
    observer = startNode(observerScript, [targetRecord, targetSpill, (await import('node:crypto')).createHash('sha256').update(spillBytes).digest('hex'), observation]);
    observerExit = once(observer, 'exit');
    assert.equal(await waitForOutput(observer), 'ready');

    const report = await adoptLegacySessions(legacy, target);
    assert.ok(report.copied.includes('reader.jsonl'));
    const [code] = await observerExit;
    assert.equal(code, 0);
    assert.equal(await readFile(observation, 'utf8'), 'ready');
  } finally {
    if (observer !== undefined && observer.exitCode === null) {
      observer.kill();
      await observerExit;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('a valid source header keeps unknown metadata byte for byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-metadata-'));
  try {
    const project = join(root, 'project');
    const legacy = join(project, '.ligule', 'sessions');
    const target = join(root, 'target');
    const source = [
      JSON.stringify({ kind: 'session', formatVersion: 0, sessionId: 'metadata', projectRoot: project, createdAt: '2026-01-02T03:04:05Z', futureMetadata: { owner: 'source' } }),
      JSON.stringify({ seq: 0, kind: 'user', text: 'kept' }),
      '',
    ].join('\n');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'metadata.jsonl'), source);
    const report = await adoptLegacySessions(legacy, target);
    assert.deepEqual(report.copied, ['metadata.jsonl']);
    assert.equal(await readFile(join(target, 'metadata.jsonl'), 'utf8'), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('headerless project records gain only their recoverable source identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-v0-'));
  try {
    const project = join(root, 'old-project');
    const legacy = join(project, '.ligule', 'sessions');
    const target = join(root, 'shared', 'sessions');
    await mkdir(legacy, { recursive: true });
    const original = Buffer.from('{"seq":0,"kind":"user","text":"unchanged"}\n{"seq":1,"kind":"usage","ignorable":true,"input":4,"output":2,"estimated":true}\n{"seq":2,"kind":"user","text":"partial');
    await writeFile(join(legacy, 'old-id.jsonl'), original);
    const beforeEvents = (await import('../dist/session/record.js')).parseSessionBytes(original).events;
    const beforeDigest = prefixDigest(beforeEvents);

    const report = await adoptLegacySessions(legacy, target);
    assert.deepEqual(report.copied, ['old-id.jsonl']);
    const migrated = await readFile(join(target, 'old-id.jsonl'));
    const newline = migrated.indexOf(0x0a);
    const header = JSON.parse(migrated.subarray(0, newline).toString('utf8'));
    assert.deepEqual(header, {
      kind: 'session', formatVersion: 0, sessionId: 'old-id', projectRoot: project,
      workspace: (await import('../dist/kernel/workspace.js')).workspaceIdentity(project),
    });
    assert.ok(migrated.subarray(newline + 1).equals(original), '正文、事件序号、可忽略事件和半行逐字节不变');
    const afterEvents = (await import('../dist/session/record.js')).parseSessionBytes(migrated).events;
    assert.equal(prefixDigest(afterEvents), beforeDigest, '首行补齐不改变检查点哈希输入');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a headerless record in a shared directory stays unknown to adoption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-shared-'));
  try {
    const shared = join(root, 'shared', 'sessions');
    const target = join(root, 'target');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'unknown.jsonl'), '{"seq":0,"kind":"user","text":"unknown"}\n');
    const report = await adoptLegacySessions(shared, target);
    assert.deepEqual(report.unknown, ['unknown.jsonl']);
    assert.equal(await readFile(join(target, 'unknown.jsonl')).then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a headerless record in the user data sessions directory is not assigned to a home workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-user-data-'));
  const previous = process.env.LIGULE_HOME;
  try {
    const home = join(root, 'home');
    const data = join(root, 'data');
    const shared = join(data, 'sessions');
    const target = join(root, 'target');
    process.env.LIGULE_HOME = data;
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'unknown.jsonl'), '{"seq":0,"kind":"user","text":"unknown"}\n');
    const report = await adoptLegacySessions(shared, target, { projectRoot: home, userHome: home });
    assert.deepEqual(report.unknown, ['unknown.jsonl']);
    await assert.rejects(readFile(join(target, 'unknown.jsonl')), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows path casing cannot make the shared user data sessions directory look project-owned', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows path casing applies only on Windows');
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-user-data-case-'));
  const previous = process.env.LIGULE_HOME;
  try {
    const home = join(root, 'home');
    const data = join(root, 'Data');
    const shared = join(data, 'sessions');
    const target = join(root, 'target');
    process.env.LIGULE_HOME = data.toUpperCase();
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'unknown.jsonl'), '{"seq":0,"kind":"user","text":"unknown"}\n');
    const report = await adoptLegacySessions(shared, target, { projectRoot: home, userHome: home });
    assert.deepEqual(report.unknown, ['unknown.jsonl']);
    await assert.rejects(readFile(join(target, 'unknown.jsonl')), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('the workspace root wins over an explicit project root and boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-root-order-'));
  try {
    const workspace = join(root, 'workspace');
    const explicit = join(root, 'explicit');
    const boundary = join(root, 'boundary');
    const target = join(root, 'target');
    await mkdir(join(workspace, '.ligule', 'sessions'), { recursive: true });
    await mkdir(join(explicit, '.ligule', 'sessions'), { recursive: true });
    await mkdir(join(boundary, '.ligule', 'sessions'), { recursive: true });
    await writeFile(join(workspace, '.ligule', 'sessions', 'chosen.jsonl'), '{"seq":0,"kind":"user","text":"workspace"}\n');
    await writeFile(join(explicit, '.ligule', 'sessions', 'ignored.jsonl'), '{"seq":0,"kind":"user","text":"explicit"}\n');
    await writeFile(join(boundary, '.ligule', 'sessions', 'ignored.jsonl'), '{"seq":0,"kind":"user","text":"boundary"}\n');

    const report = await adoptForSessionDirectory({ boundary, workspaceRoot: workspace }, target, explicit) as AdoptionReport;
    assert.deepEqual(report.copied, ['chosen.jsonl']);
    assert.match(await readFile(join(target, 'chosen.jsonl'), 'utf8'), /workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid records are reported and non-missing read errors stay stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-errors-'));
  try {
    const legacy = join(root, 'project', '.ligule', 'sessions');
    const target = join(root, 'target');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'bad.jsonl'), '{"seq":0,"kind":"unknown"}\n');
    assert.deepEqual((await adoptLegacySessions(legacy, target)).unknown, ['bad.jsonl']);

    const blockedSource = join(root, 'not-a-directory');
    await writeFile(blockedSource, 'file');
    await assert.rejects(adoptLegacySessions(blockedSource, join(root, 'other-target')),
      (error) => codeOf(error) === 'session_adoption_read_failed', 'ENOTDIR 等非缺失错误必须保留为稳定读取错误');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a real Windows read denial is returned as a stable adoption error', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-denied-'));
  const legacy = join(root, 'project', '.ligule', 'sessions');
  const source = join(legacy, 'denied.jsonl');
  const systemDirectory = join(process.env.SystemRoot as string, 'System32');
  const aclTool = join(systemDirectory, 'icacls.exe');
  let userSid: string | undefined;
  let denied = false;
  try {
    await mkdir(legacy, { recursive: true });
    await writeFile(source, '{"seq":0,"kind":"user","text":"private"}\n');
    const identity = execFileSync(join(systemDirectory, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    userSid = identity.match(/S-\d-\d+(?:-\d+)+/)?.[0];
    assert.ok(userSid, '当前 Windows 用户应有可用 SID');
    execFileSync(aclTool, [source, '/deny', `*${userSid}:(R)`], { stdio: 'pipe' });
    denied = true;

    await assert.rejects(adoptLegacySessions(legacy, join(root, 'target')),
      (error) => codeOf(error) === 'session_adoption_read_failed', '拒绝读取不能伪装成缺失记录');
  } finally {
    if (denied && userSid !== undefined) execFileSync(aclTool, [source, '/remove:d', `*${userSid}`], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});
