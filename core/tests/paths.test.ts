import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWithin, resolveWithin, KernelError } from '../dist/index.js';

// 夹具建在 testplace/ 下：那个目录既不进版本控制也不进包。
// 边界取 workspace，outside 是边界之外的那一半，用来构造两类越界。
async function withFixture(run: (paths: { workspace: string; outside: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'boundary-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, 'note.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  try {
    return await run({ workspace, outside });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Windows 上目录用 junction，POSIX 上用符号链接目录；两者都会被 realpath 解开。
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: string }).code === code;
}

test('a path inside the boundary resolves to its real path', async () => {
  await withFixture(async ({ workspace }) => {
    assert.equal(await resolveWithin(workspace, 'note.txt'), await realpath(join(workspace, 'note.txt')));
    assert.equal(await resolveWithin(workspace, '.'), await realpath(workspace));
  });
});

test('a parent traversal out of the boundary is rejected', async () => {
  await withFixture(async ({ workspace, outside }) => {
    await assert.rejects(
      () => resolveWithin(workspace, '../outside/secret.txt'),
      (error) => error instanceof KernelError && error.code === 'path_escapes_boundary',
    );
    await assert.rejects(
      () => resolveWithin(workspace, 'sub/../../outside/secret.txt'),
      (error) => hasCode(error, 'path_escapes_boundary'),
    );
    await assert.rejects(
      () => resolveWithin(workspace, join(outside, 'secret.txt')),
      (error) => hasCode(error, 'path_escapes_boundary'),
    );
  });
});

test('relative paths use an unrestricted anchor while targets stay within the boundary', async () => {
  await withFixture(async ({ workspace, outside }) => {
    const child = join(workspace, 'child');
    await mkdir(child);
    await writeFile(join(child, 'note.txt'), 'child');
    assert.equal(await resolveWithin(workspace, 'note.txt', { cwd: child }), await realpath(join(child, 'note.txt')));
    assert.equal(await resolveWithin(workspace, join(workspace, 'note.txt'), { cwd: outside }), await realpath(join(workspace, 'note.txt')));
    await assert.rejects(
      () => resolveWithin(workspace, '../../outside/secret.txt', { cwd: child }),
      (error) => hasCode(error, 'path_escapes_boundary'),
    );
  });
});

test('a linked directory pointing outside the boundary is rejected for reads and for writes', async () => {
  await withFixture(async ({ workspace, outside }) => {
    await symlink(outside, join(workspace, 'escape'), linkType);
    await assert.rejects(
      () => resolveWithin(workspace, 'escape/secret.txt'),
      (error) => hasCode(error, 'path_escapes_through_link'),
    );
    await assert.rejects(
      () => resolveWithin(workspace, 'escape/new.txt', { forWrite: true }),
      (error) => hasCode(error, 'path_escapes_through_link'),
    );
  });
});

test('a file that does not exist yet resolves through its nearest existing ancestor', async () => {
  await withFixture(async ({ workspace }) => {
    assert.equal(
      await resolveWithin(workspace, 'sub/new.txt', { forWrite: true }),
      join(await realpath(workspace), 'sub', 'new.txt'),
    );
  });
});

test('a path that passes through a regular file is rejected', async () => {
  await withFixture(async ({ workspace }) => {
    await assert.rejects(
      () => resolveWithin(workspace, 'note.txt/child.txt', { forWrite: true }),
      (error) => hasCode(error, 'path_parent_not_directory'),
    );
  });
});

test('a hard-linked file may be read but not written through', async () => {
  await withFixture(async ({ workspace, outside }) => {
    const hard = join(workspace, 'hard.txt');
    await link(join(outside, 'secret.txt'), hard);
    assert.equal(await resolveWithin(workspace, 'hard.txt'), await realpath(hard));
    await assert.rejects(
      () => resolveWithin(workspace, 'hard.txt', { forWrite: true }),
      (error) => hasCode(error, 'path_hard_linked'),
    );
  });
});

test('a name starting with two dots inside the boundary is not mistaken for a traversal', () => {
  assert.ok(isWithin('/work', '/work/..backup/notes.txt'));
  assert.ok(!isWithin('/work', '/work/../other'));
  assert.ok(!isWithin('/work', '/other'));
});

test('a boundary that does not exist reports its own code', async () => {
  await withFixture(async ({ workspace }) => {
    await assert.rejects(
      () => resolveWithin(join(workspace, 'nope'), 'note.txt'),
      (error) => error instanceof KernelError && error.code === 'boundary_missing',
    );
  });
});
