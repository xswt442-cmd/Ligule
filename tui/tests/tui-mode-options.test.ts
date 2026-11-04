import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { modeOptions } from '../dist/tui/mode-options.js';

const testRoot = resolve('testplace/tmp');

async function withSandbox(run: (root: string) => Promise<unknown>): Promise<unknown> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'tui-mode-options-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addFile(directory: string, filename: string, contents = 'invalid TOML is still listed') {
  const path = join(directory, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

test('lists sorted valid mode files and lets higher layers replace same-name entries', async () => {
  await withSandbox(async (root) => {
    const paths = { shipped: join(root, 'shipped'), user: join(root, 'user'), project: join(root, 'project') };
    await addFile(paths.shipped, 'shared.toml');
    await addFile(paths.shipped, 'zeta.toml');
    await addFile(paths.user, 'shared.toml');
    await addFile(paths.user, 'middle.toml');
    await addFile(paths.project, 'shared.toml');
    await addFile(paths.project, 'alpha.toml');
    await addFile(paths.project, 'UPPER.toml');
    await addFile(paths.project, 'notes.txt');
    await addFile(paths.project, 'nested.toml/ignored.txt');

    assert.deepEqual(await modeOptions(paths), [
      { name: 'alpha', layer: 'project' },
      { name: 'middle', layer: 'user' },
      { name: 'shared', layer: 'project' },
      { name: 'zeta', layer: 'shipped' },
    ]);
  });
});

test('missing mode directories are empty', async () => {
  await withSandbox(async (root) => {
    assert.deepEqual(await modeOptions({
      shipped: join(root, 'missing-shipped'),
      user: join(root, 'missing-user'),
      project: join(root, 'missing-project'),
    }), []);
  });
});

test('a mode directory path that is a file fails with mode_list_failed', async () => {
  await withSandbox(async (root) => {
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'file');
    await assert.rejects(modeOptions({ shipped: file, user: join(root, 'user'), project: join(root, 'project') }),
      (error) => (error as { code?: string }).code === 'mode_list_failed');
  });
});
