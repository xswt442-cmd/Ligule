import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadInstructions } from '../dist/index.js';

const rel = (from: string, to: string): string => relative(from, to).split('\\').join('/');

async function withTree<TResult>(run: (paths: { root: string; boundary: string }) => TResult | Promise<TResult>): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'instructions-'));
  const boundary = join(root, 'boundary');
  await mkdir(join(boundary, 'pkg', 'deep'), { recursive: true });
  await mkdir(join(boundary, 'vendor'), { recursive: true });
  await mkdir(join(root, 'outside'), { recursive: true });
  await writeFile(join(boundary, 'AGENTS.md'), 'project rules');
  await writeFile(join(boundary, 'CLAUDE.md'), 'a foreign file name');
  await writeFile(join(boundary, 'pkg', 'AGENTS.md'), 'package rules');
  await writeFile(join(boundary, 'pkg', 'deep', 'AGENTS.md'), 'deep rules');
  await writeFile(join(boundary, 'vendor', 'AGENTS.md'), 'vendored rules');
  await writeFile(join(root, 'managed.md'), 'managed rules');
  await writeFile(join(root, 'user.md'), 'user rules');
  try {
    return await run({ root, boundary });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const order = (text: string): string[] => [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

test('the four layers load from the lowest to the highest priority', async () => {
  await withTree(async ({ root, boundary }) => {
    const result = await loadInstructions({
      boundary,
      current: join(boundary, 'pkg', 'deep'),
      managed: join(root, 'managed.md'),
      user: join(root, 'user.md'),
    });
    assert.deepEqual(order(result.text), [
      rel(boundary, join(root, 'managed.md')),
      rel(boundary, join(root, 'user.md')),
      'AGENTS.md',
      'pkg/AGENTS.md',
      'pkg/deep/AGENTS.md',
    ]);
    assert.deepEqual(result.files.map((file) => file.layer), ['managed', 'user', 'project', 'directory', 'directory']);
    assert.ok(result.text.indexOf('deep rules') > result.text.indexOf('project rules'), 'the closer file loads later');
  });
});

test('only AGENTS.md is read, and the walk stops at the project root', async () => {
  await withTree(async ({ boundary }) => {
    const result = await loadInstructions({ boundary, current: join(boundary, 'pkg') });
    assert.ok(!result.text.includes('a foreign file name'));
    assert.deepEqual(order(result.text), ['AGENTS.md', 'pkg/AGENTS.md']);
  });
});

test('exclusions apply to the checked-in layers and never to managed or user', async () => {
  await withTree(async ({ root, boundary }) => {
    const result = await loadInstructions({
      boundary,
      current: join(boundary, 'vendor'),
      managed: join(root, 'managed.md'),
      exclude: ['**/vendor/**', '**/managed.md', join(boundary, 'AGENTS.md')],
    });
    assert.ok(!result.text.includes('vendored rules'));
    assert.ok(result.text.includes('managed rules'), 'the managed layer is never excluded');
    assert.ok(!result.text.includes('project rules'), 'the excluded project root file is dropped');
  });
});

test('the same file named twice loads once, keeping the higher-priority layer', async () => {
  await withTree(async ({ root, boundary }) => {
    const result = await loadInstructions({
      boundary,
      current: boundary,
      managed: join(root, 'managed.md'),
      user: join(root, 'managed.md'),
    });
    assert.deepEqual(order(result.text), [rel(boundary, join(root, 'managed.md')), 'AGENTS.md']);
    assert.deepEqual(result.files.map((file) => file.layer), ['user', 'project']);
  });
});

test('beyond the byte budget the lowest-priority layers are dropped with a visible note', async () => {
  await withTree(async ({ root, boundary }) => {
    const result = await loadInstructions({
      boundary,
      current: join(boundary, 'pkg', 'deep'),
      managed: join(root, 'managed.md'),
      user: join(root, 'user.md'),
      maxBytes: 150,
    });
    assert.ok(result.text.includes('deep rules'), 'the closest layer keeps its place');
    assert.ok(!result.text.includes('project rules'), 'the lower layers are dropped instead');
    assert.ok(!result.text.includes('managed rules'));
    assert.match(result.text, /\[Instruction budget 150 bytes: omitted /);
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 150);
  });
});

test('a file that only partly fits is truncated with its own marker', async () => {
  await withTree(async ({ boundary }) => {
    await writeFile(join(boundary, 'pkg', 'AGENTS.md'), 'package rules '.repeat(40));
    const result = await loadInstructions({ boundary, current: join(boundary, 'pkg'), maxBytes: 400 });
    assert.match(result.text, /package rules/);
    assert.match(result.text, /\[truncated from \d+ bytes]/);
    assert.match(result.text, /\[Instruction budget 400 bytes: .+truncated /);
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 400);
  });
});

// 切在一个多字节字符中间时那半个字符留不住：标记里的「到多少字节」要按实际留下的算，不是按预算算。
test('the truncation notice counts the bytes actually kept rather than the budget', async () => {
  await withTree(async ({ boundary }) => {
    await writeFile(join(boundary, 'pkg', 'AGENTS.md'), 'é'.repeat(400));
    const result = await loadInstructions({ boundary, current: join(boundary, 'pkg'), maxBytes: 200 });
    const notice = /truncated pkg\/AGENTS\.md from (\d+) to (\d+) bytes/.exec(result.text);
    assert.ok(notice !== null, `no per-file notice in: ${result.text}`);
    const kept = result.text.slice('## pkg/AGENTS.md\n\n'.length, result.text.indexOf('\n[truncated from'));
    assert.equal(Number(notice[2]), Buffer.byteLength(kept, 'utf8'), 'the counted figure is what is on the page');
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 200);
  });
});

// Windows 上只差大小写的两个写法指的是同一个目录。上溯的停止判据原先用字符串相等，相等判不出来时
// 一路走到文件系统根，把项目根之外的 AGENTS.md 读了进来。这条性质是 Windows 的，所以只在它上面跑：
// Linux 上大小写不同就是不同目录，入口那条判据本来就该拒。
test('a boundary spelled in another case still stops the walk at the project root', async (t) => {
  if (process.platform !== 'win32') return t.skip('case-insensitive paths are a Windows property');
  await withTree(async ({ root, boundary }) => {
    await writeFile(join(root, 'AGENTS.md'), 'rules from above the project root');
    const result = await loadInstructions({
      boundary: join(root, 'Boundary'),
      current: join(root, 'boundary', 'pkg'),
    });
    assert.doesNotMatch(result.text, /above the project root/, 'nothing outside the boundary is loaded');
    assert.deepEqual(order(result.text), ['AGENTS.md', 'pkg/AGENTS.md'], 'the walk stops at the boundary, two layers');
    assert.deepEqual(result.files.map((file) => file.layer), ['project', 'directory'], 'the boundary itself is the project layer');
  });
});

test('a starting point outside the project root and a missing root are both refused', async () => {
  await withTree(async ({ root, boundary }) => {
    await assert.rejects(
      () => loadInstructions({ boundary, current: join(root, 'outside') }),
      (error) => (error as { code?: string }).code === 'instructions_current_outside_boundary',
    );
    await assert.rejects(() => loadInstructions({}), (error) => (error as { code?: string }).code === 'instructions_boundary_required');
  });
});
