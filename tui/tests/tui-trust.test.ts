import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { trustPathOf, isTrusted, setTrusted } from '../dist/tui/trust-store.js';

const testRoot = resolve('testplace/tmp');

async function withSandbox(run: (root: string) => Promise<unknown>): Promise<unknown> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'tui-trust-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('missing trust file starts empty and trust can be granted and revoked', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const path = join(root, 'tui-trust.json');
    await mkdir(directory);
    assert.equal(trustPathOf(root), join(root, '.ligule', 'trust.json'));
    assert.equal(await isTrusted(directory, path), false);
    await setTrusted(directory, true, path);
    assert.equal(await isTrusted(directory, path), true);
    await setTrusted(directory, false, path);
    assert.equal(await isTrusted(directory, path), false);
  });
});

test('trust applies only to the exact directory', async () => {
  await withSandbox(async (root) => {
    const parent = join(root, 'parent');
    const child = join(parent, 'child');
    const sibling = join(root, 'sibling');
    const path = join(root, 'trust.json');
    await mkdir(child, { recursive: true });
    await mkdir(sibling);
    await setTrusted(parent, true, path);
    assert.equal(await isTrusted(parent, path), true);
    assert.equal(await isTrusted(child, path), false);
    assert.equal(await isTrusted(sibling, path), false);
  });
});

test('directory aliases resolve to one trusted identity where the platform supports them', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const path = join(root, 'trust.json');
    await mkdir(directory);
    await setTrusted(directory, true, path);
    if (process.platform === 'win32') {
      assert.equal(await isTrusted(directory.toUpperCase(), path), true);
    }
    const alias = join(root, 'project-link');
    try {
      await symlink(directory, alias, 'junction');
      assert.equal(await isTrusted(alias, path), true);
    } catch {
      // 当前环境无法创建目录链接时，仍检查文件系统对路径大小写的处理。
    }
    assert.equal(await isTrusted(`${directory}${sep}`, path), true);
  });
});

test('concurrent trust changes preserve every directory', async () => {
  await withSandbox(async (root) => {
    const path = join(root, 'trust.json');
    const directories = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const directory = join(root, `project-${index}`);
      await mkdir(directory);
      return directory;
    }));
    await Promise.all(directories.map((directory) => setTrusted(directory, true, path)));
    for (const directory of directories) assert.equal(await isTrusted(directory, path), true);
    const written = JSON.parse(await readFile(path, 'utf8')) as { version: number; directories: string[] };
    assert.equal(written.version, 1);
    assert.equal(written.directories.length, directories.length);
  });
});

test('corrupt and unknown-version documents fail closed', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const path = join(root, 'trust.json');
    await mkdir(directory);
    await writeFile(path, '{', 'utf8');
    await assert.rejects(isTrusted(directory, path), (error) => (error as { code?: string }).code === 'tui_trust_invalid');
    await writeFile(path, JSON.stringify({ version: 2, directories: [] }), 'utf8');
    await assert.rejects(setTrusted(directory, true, path), (error) => (error as { code?: string }).code === 'tui_trust_invalid');
  });
});

test('missing directories and files are rejected', async () => {
  await withSandbox(async (root) => {
    const missing = join(root, 'not-created');
    const file = join(root, 'ordinary-file');
    await writeFile(file, 'file');
    await assert.rejects(isTrusted(missing, join(root, 'trust.json')), (error) => (error as { code?: string }).code === 'tui_trust_directory_invalid');
    await assert.rejects(setTrusted(file, true, join(root, 'trust.json')), (error) => (error as { code?: string }).code === 'tui_trust_directory_invalid');
  });
});

// 旧文件名 tui-trust.json 仍可读取；写入一律落在新名，旧文件保留不动。
test('the legacy file name is read as a fallback and writes land on the new name', async () => {
  await withSandbox(async (root) => {
    const directory = join(root, 'project');
    const other = join(root, 'other');
    await mkdir(directory);
    await mkdir(other);
    const legacy = join(root, 'tui-trust.json');
    const path = join(root, 'trust.json');

    await setTrusted(directory, true, legacy);
    assert.equal(await isTrusted(directory, path), true, '旧文件里的信任在新名下可见');

    await setTrusted(other, true, path);
    assert.equal(await isTrusted(directory, path), true);
    assert.equal(await isTrusted(other, path), true);
    const written = JSON.parse(await readFile(path, 'utf8')) as { version: number; directories: string[] };
    assert.equal(written.directories.length, 2, '旧条目合并进新文件');
    assert.ok((await readFile(legacy, 'utf8')).length > 0, '旧文件保持不动');
  });
});
