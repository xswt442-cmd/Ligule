// 扩展启停登记：可信界面经 extensions.set 写入数据根的登记文件，
// 名称必须对应安装目录中的扩展；登记在下次 Host 启动时生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';
import { createPermissionContext } from '../core/dist/kernel/permission.js';

type Catalog = { extensions: { name: string; enabled: boolean; source: string }[] };
type ExtensionState = { name: string; enabled: boolean; applies: string };
type DiagnosticsCatalog = { extensionDiagnostics: { code: string; source: string }[] };

test('extensions.set records the disable registry from a trusted interface', async () => {
  // 注入的扩展源模拟安装目录发现结果；登记文件写在当前隔离数据根下。
  const home = await mkdtemp(join(tmpdir(), 'ligule-extension-state-'));
  const soloPath = resolve(join(home, '.ligule', 'extensions', 'solo.js'));
  await mkdir(join(home, '.ligule', 'extensions'), { recursive: true });
  await writeFile(soloPath, 'export default () => () => {};\n', 'utf8');
  try {
    await withTuiHost(async ({ client, projectDirectory }) => {
      const catalog = await client.request('settings.catalog', { projectRoot: projectDirectory }) as Catalog;
      const entry = catalog.extensions.find((item) => item.name === 'solo');
      assert.ok(entry, '注入的扩展出现在清单里');
      assert.equal(entry.enabled, true);
      assert.equal(entry.source, 'user-configured');

      const done = await client.request('extensions.set', { projectRoot: projectDirectory, name: 'solo', enabled: false }) as ExtensionState;
      assert.deepEqual([done.name, done.enabled, done.applies], ['solo', false, 'next-start']);
      const statePath = join(homedir(), '.ligule', 'extensions-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.deepEqual(state, { version: 1, disabled: ['solo'] });

      const restored = await client.request('extensions.set', { projectRoot: projectDirectory, name: 'solo', enabled: true }) as ExtensionState;
      assert.equal(restored.enabled, true);
      const after = JSON.parse(await readFile(statePath, 'utf8'));
      assert.deepEqual(after.disabled, [], '重新启用后登记清空');

      await assert.rejects(
        client.request('extensions.set', { projectRoot: projectDirectory, name: 'ghost', enabled: false }),
        (error) => (error as { code: string }).code === 'extensions_set_unknown', '未知名称点名拒绝',
      );
    }, {
      permissionControl: true,
      extensions: { paths: [soloPath], ignored: [], installNames: { [soloPath]: 'solo' } },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the real environment loader disables installed extensions when the registry is unreadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-extension-state-unreadable-'));
  const dataRoot = join(root, 'data');
  const projectRoot = join(root, 'project');
  const installedDirectory = join(dataRoot, 'extensions');
  const installedPath = join(installedDirectory, 'local.js');
  const previousDataRoot = process.env.LIGULE_HOME;
  await Promise.all([
    mkdir(installedDirectory, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(join(dataRoot, 'extensions-state.json'), { recursive: true }),
  ]);
  await writeFile(installedPath, 'export default () => {}\n', 'utf8');
  process.env.LIGULE_HOME = dataRoot;
  try {
    const { loadProjectConfig } = await import('../core/dist/host/environment.js');
    const loaded = await loadProjectConfig(projectRoot);
    assert.deepEqual(loaded.extensions.paths, [], 'installed code stays inactive while its disable registry cannot be trusted');
    assert.deepEqual(loaded.extensions.disabled, [{ name: 'local', path: installedPath }]);
    assert.ok(loaded.extensions.ignored.some((item) => item.code === 'extension_state_unavailable'));
  } finally {
    if (previousDataRoot === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousDataRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('settings.catalog shows active-session extension load failures without local absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-extension-diagnostic-'));
  const brokenPath = resolve(join(root, 'broken.js'));
  await writeFile(brokenPath, 'throw new Error("fixture import failure");\n', 'utf8');
  try {
    await withTuiHost(async ({ client, projectDirectory, sessionId }) => {
      const catalog = await client.request('settings.catalog', { projectRoot: projectDirectory, sessionId }) as DiagnosticsCatalog;
      assert.deepEqual(catalog.extensionDiagnostics, [{ code: 'extension_load_failed', source: 'broken.js' }]);
      assert.equal(JSON.stringify(catalog).includes(root), false, 'settings diagnostics do not expose absolute local paths');
    }, {
      permissionControl: true,
      permission: createPermissionContext('full-access', 'unrestricted', {
        filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
      }),
      extensions: { paths: [brokenPath], ignored: [] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
