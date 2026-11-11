import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../dist/kernel/config.js';
import { createKernel } from '../dist/kernel/kernel.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { writeTool } from '../dist/tools/write.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = join(repository, 'testplace', 'tmp');
const workspaceWrite = createPermissionContext('workspace-write', 'disabled', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});

test('Kernel denies writes through parent and link paths and preserves the outside target', async () => {
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'kernel-write-boundary-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const target = join(outside, 'secret.txt');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(target, 'keep outside');
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(writeTool);
    await assert.rejects(
      () => kernel.call('write', { path: '../outside/secret.txt', content: 'overwrite' }),
      { code: 'path_escapes_boundary' },
    );
    await assert.rejects(
      () => kernel.call('write', { path: 'escape/secret.txt', content: 'overwrite' }),
      { code: 'path_escapes_through_link' },
    );
    assert.equal(await readFile(target, 'utf8'), 'keep outside');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
