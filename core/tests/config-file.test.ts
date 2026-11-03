import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfig, flagLayer, loadConfigLayers } from '../dist/index.js';

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;
const detailOf = (error: unknown): string => (error as { detail?: string }).detail ?? '';

// 用户主目录和项目根都使用临时目录，避免读取真实的用户配置或依赖环境变量。
async function withLayers<TResult>(run: (paths: { home: string; project: string }) => TResult | Promise<TResult>): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'config-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(join(home, '.ligule'), { recursive: true });
  await mkdir(join(project, '.ligule'), { recursive: true });
  try {
    return await run({ home, project });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 两项测试都通过真实文件加载和配置合并；项目配置也可能包含合法的 TOML 日期时间值。
test('a project file holding a __proto__ table is refused when the layers fold', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(project, '.ligule', 'config.toml'), '["__proto__"]\npolluted = 1\n');
    const layers = await loadConfigLayers({ projectRoot: project, userHome: home });
    assert.throws(() => createConfig(layers), (error) => codeOf(error) === 'config_key_unsafe');
    assert.equal(({} as { polluted?: unknown }).polluted, undefined, 'nothing reached Object.prototype');
  });
});

test('a datetime in the higher layer file replaces the lower one', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(home, '.ligule', 'config.toml'), 'when = 1979-05-27T07:32:00Z\n');
    await writeFile(join(project, '.ligule', 'config.toml'), 'when = 2026-10-01T00:00:00Z\n');
    const snapshot = createConfig(await loadConfigLayers({ projectRoot: project, userHome: home })) as { when: Date };
    assert.equal(snapshot.when.toISOString(), '2026-10-01T00:00:00.000Z');
  });
});

test('the three files fold user < project < local, tables per key and arrays whole', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(home, '.ligule', 'config.toml'), 'boundary = "/from-user"\n\n[limits]\nreadBytes = 10\nresultCount = 5\nkeep = [1, 2]\n');
    await writeFile(join(project, '.ligule', 'config.toml'), '[limits]\nreadBytes = 20\nkeep = [3]\n');
    await writeFile(join(project, '.ligule', 'config.local.toml'), '[limits]\nresultCount = 7\n');
    const snapshot = createConfig(await loadConfigLayers({ projectRoot: project, userHome: home }));
    assert.equal(snapshot.boundary, '/from-user');
    assert.deepEqual(snapshot.limits, { readBytes: 20, resultCount: 7, keep: [3] });
    assert.ok(Object.isFrozen(snapshot.limits));
  });
});

test('a missing file is not an error and three missing files fold into an empty snapshot', async () => {
  await withLayers(async ({ home, project }) => {
    assert.deepEqual(createConfig(await loadConfigLayers({ projectRoot: project, userHome: home })), {});
  });
});

test('a layer that does not parse fails at once and names the layer and the file', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(project, '.ligule', 'config.toml'), '= 1\n');
    await assert.rejects(
      () => loadConfigLayers({ projectRoot: project, userHome: home }),
      (error) => codeOf(error) === 'config_file_invalid'
        && detailOf(error).startsWith('project: ')
        && detailOf(error).endsWith(join('.ligule', 'config.toml')),
    );
  });
});

test('a dotted flag becomes a typed value and several flags merge per key', () => {
  assert.deepEqual(flagLayer(['limits.readBytes = 100', 'boundary = "/from-flag"', 'limits.scanFiles = 5']), {
    boundary: '/from-flag',
    limits: { readBytes: 100, scanFiles: 5 },
  });
  assert.throws(() => flagLayer(['limits.readBytes']), (error) => codeOf(error) === 'config_flag_invalid');
});

test('the flag layer wins over all three files', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(project, '.ligule', 'config.local.toml'), '[limits]\nreadBytes = 20\n');
    const snapshot = createConfig(await loadConfigLayers({
      projectRoot: project,
      userHome: home,
      flags: ['limits.readBytes = 99'],
    })) as { limits: { readBytes: number } };
    assert.equal(snapshot.limits.readBytes, 99);
  });
});
