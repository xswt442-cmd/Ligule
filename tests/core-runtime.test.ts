import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertCoreRuntimeMatches } from '../scripts/core-runtime.js';
import { assertSymlinksInside } from '../scripts/runtime-tree.js';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryParent = join(repositoryRoot, 'desktop', 'testplace', 'tmp');

type CoreFiles = Record<string, string>;
type CoreTrees = { source: string; deployed: string };

async function makeCore(root: string, files: CoreFiles) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
}

async function withCoreTrees(action: (trees: CoreTrees) => Promise<void>) {
  await mkdir(temporaryParent, { recursive: true });
  const temporary = await mkdtemp(join(temporaryParent, 'core-runtime-test-'));
  const source = join(temporary, 'source');
  const deployed = join(temporary, 'deployed');
  const files = {
    'dist/index.js': 'export const version = 1;\n',
    'dist/host/desktop-entry.js': 'export {};\n',
    'modes/minimal.toml': 'name = "minimal"\n',
    'README.md': '# Core\n',
    'LICENSE': 'license text\n',
  };
  try {
    await makeCore(source, files);
    await makeCore(deployed, files);
    await action({ source, deployed });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('accepts identical Core runtime files', async () => {
  await withCoreTrees(async ({ source, deployed }) => {
    await assert.doesNotReject(assertCoreRuntimeMatches(source, deployed));
  });
});

test('rejects modified, missing, and extra Core runtime files with rebuild guidance', async (t) => {
  await withCoreTrees(async ({ source, deployed }) => {
    await t.test('modified file', async () => {
      await writeFile(join(deployed, 'dist/index.js'), 'export const version = 2;\n', 'utf8');
      await assert.rejects(assertCoreRuntimeMatches(source, deployed), /Core runtime .*build:core.*prepare-runtime/u);
    });
    await writeFile(join(deployed, 'dist/index.js'), await readFile(join(source, 'dist/index.js')));
    await t.test('missing file', async () => {
      await rm(join(deployed, 'modes/minimal.toml'));
      await assert.rejects(assertCoreRuntimeMatches(source, deployed), /Core runtime .*build:core.*prepare-runtime/u);
    });
    await writeFile(join(deployed, 'modes/minimal.toml'), await readFile(join(source, 'modes/minimal.toml')));
    await t.test('extra file', async () => {
      await writeFile(join(deployed, 'dist/stale.js'), 'export {};\n', 'utf8');
      await assert.rejects(assertCoreRuntimeMatches(source, deployed), /Core runtime .*build:core.*prepare-runtime/u);
    });
  });
});

test('rejects required paths missing from both source and deployed Core', async (t) => {
  await withCoreTrees(async ({ source, deployed }) => {
    await t.test('both modes directories are absent', async () => {
      await rm(join(source, 'modes'), { recursive: true });
      await rm(join(deployed, 'modes'), { recursive: true });
      await assert.rejects(assertCoreRuntimeMatches(source, deployed), /built Core runtime is missing modes/u);
    });
    await makeCore(source, { 'modes/minimal.toml': 'name = "minimal"\n' });
    await makeCore(deployed, { 'modes/minimal.toml': 'name = "minimal"\n' });
    await t.test('both LICENSE files are absent', async () => {
      await rm(join(source, 'LICENSE'));
      await rm(join(deployed, 'LICENSE'));
      await assert.rejects(assertCoreRuntimeMatches(source, deployed), /built Core runtime is missing LICENSE/u);
    });
  });
});

test('accepts a deployed Core workspace link inside its package tree and compares its files', async () => {
  await withCoreTrees(async ({ source, deployed }) => {
    const packageRoot = join(dirname(deployed), 'package');
    const linkedCore = join(packageRoot, 'node_modules', '@ligule', 'core');
    const deployedTarget = join(packageRoot, 'node_modules', '.pnpm', 'core-runtime', 'node_modules', '@ligule', 'core');
    await mkdir(dirname(linkedCore), { recursive: true });
    await makeCore(deployedTarget, {
      'dist/index.js': await readFile(join(deployed, 'dist/index.js'), 'utf8'),
      'dist/host/desktop-entry.js': await readFile(join(deployed, 'dist/host/desktop-entry.js'), 'utf8'),
      'modes/minimal.toml': await readFile(join(deployed, 'modes/minimal.toml'), 'utf8'),
      'README.md': await readFile(join(deployed, 'README.md'), 'utf8'),
      'LICENSE': await readFile(join(deployed, 'LICENSE'), 'utf8'),
    });
    await symlink(deployedTarget, linkedCore, 'junction');
    await assertSymlinksInside(packageRoot);
    await assertCoreRuntimeMatches(source, linkedCore);
  });
});

test('rejects a Core workspace link escaping its staged package tree', async () => {
  await withCoreTrees(async ({ source, deployed }) => {
    const packageRoot = join(dirname(deployed), 'package');
    const linkedCore = join(packageRoot, 'node_modules', '@ligule', 'core');
    const outsideTarget = join(dirname(packageRoot), 'outside-core');
    await mkdir(dirname(linkedCore), { recursive: true });
    await makeCore(outsideTarget, {
      'dist/index.js': await readFile(join(deployed, 'dist/index.js'), 'utf8'),
      'dist/host/desktop-entry.js': await readFile(join(deployed, 'dist/host/desktop-entry.js'), 'utf8'),
      'modes/minimal.toml': await readFile(join(deployed, 'modes/minimal.toml'), 'utf8'),
      'README.md': await readFile(join(deployed, 'README.md'), 'utf8'),
      'LICENSE': await readFile(join(deployed, 'LICENSE'), 'utf8'),
    });
    await symlink(outsideTarget, linkedCore, 'junction');
    await assert.rejects(assertSymlinksInside(packageRoot), /runtime symlink escapes/u);
  });
});
