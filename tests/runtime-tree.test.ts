import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNoForeignNativeDirectories, pruneForeignNativeDirectories } from '../scripts/runtime-tree.js';

test('native staging rejects and removes MSBuild intermediates while retaining runtime files', async () => {
  const scratch = fileURLToPath(new URL('../testplace/tmp', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'runtime-tree-'));
  const release = join(root, 'tree-sitter', 'build', 'Release');
  const intermediate = join(release, 'obj', 'binding', 'binding.tlog');
  const runtime = join(release, 'binding.node');
  const unrelated = join(root, 'ordinary-package', 'obj', 'index.js');
  try {
    await mkdir(dirname(intermediate), { recursive: true });
    await mkdir(dirname(unrelated), { recursive: true });
    await writeFile(intermediate, 'compiler tracking metadata');
    await writeFile(runtime, 'runtime bytes must remain unchanged');
    await writeFile(unrelated, 'export const object = {};');
    await assert.rejects(assertNoForeignNativeDirectories(root, 'win32-x64'));
    await pruneForeignNativeDirectories(root, 'win32-x64');
    await assert.rejects(stat(join(release, 'obj')), { code: 'ENOENT' });
    assert.equal(await readFile(runtime, 'utf8'), 'runtime bytes must remain unchanged');
    assert.equal(await readFile(unrelated, 'utf8'), 'export const object = {};');
    await assertNoForeignNativeDirectories(root, 'win32-x64');
  } finally {
    assert.equal(dirname(root), scratch);
    await rm(root, { recursive: true, force: true });
  }
});
