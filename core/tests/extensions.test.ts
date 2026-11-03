// 验证扩展的查找位置、可用接口，以及加载失败时的行为。
// 临时目录里的模块是真的 ESM 文件，用真的动态 import 跑；内核、判定链、提示词组装也都是真的。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConfig, createKernel, createPermissionContext, extensionSources, loadAssembly, loadExtensions, minimalPlugin,
} from '../dist/index.js';
import type { ToolDefinition } from '../dist/kernel/kernel.js';
import type { Connection } from '../dist/host/connection.js';
import type { Host } from '../dist/host/host.js';
import type { ModelRequest } from '../dist/kernel/loop.js';
import type { PolicyMode } from '../dist/kernel/policy.js';
import { testHostProvider } from './helpers/provider.ts';

type ExtensionFragment = { name: string; text: string; source: string };
type ExtensionLoadOptions = Parameters<typeof loadExtensions>[1] & { config?: Record<string, never> };

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

// 每一条测试都要一份真的临时目录（扩展文件是被真动态 import 的），跑完一起收掉。
const created: string[] = [];
async function directoryWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ligule-extensions-'));
  created.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}
after(() => Promise.all(created.map((root) => rm(root, { recursive: true, force: true }))));

test('sources come from the install directory, the user layer and the command line, not from the repository', async () => {
  const root = await directoryWith({ 'b.js': '', 'a.js': '', 'notes.txt': '' });
  const installedDirectory = join(root, '.ligule', 'extensions');
  const readDirectory = (path: string) => (path === installedDirectory
    ? Promise.resolve(['b.js', 'a.js', 'notes.txt'])
    : Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })));
  const listed = await extensionSources(
    {
      user: { extensions: ['tools/deep.js'] },
      flag: { extensions: [] },
      project: { extensions: ['evil.js'] },
      local: { extensions: ['also-evil.js'] },
    },
    { projectRoot: root, userHome: root, readDirectory },
  );
  assert.deepEqual(listed.paths, [join(installedDirectory, 'a.js'), join(installedDirectory, 'b.js'), join(root, 'tools', 'deep.js')].sort());
  assert.equal(listed.installedDirectory, installedDirectory);
  assert.deepEqual(listed.ignored.map((entry) => [entry.code, entry.path]), [['extension_source_ignored', 'project'], ['extension_source_ignored', 'local']]);
  assert.deepEqual(Object.values(listed.installNames).sort(), ['a', 'b']);
  assert.deepEqual(listed.disabled, []);
  // 安装目录不存在不是错误：一行都没装过是正常状态。
  const missing = await extensionSources({}, { projectRoot: root, userHome: join(root, 'nope'), readDirectory: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })) });
  assert.deepEqual(missing.paths, []);
});

test('directory packages load through index.js and the disable registry filters installed entries only', async () => {
  const root = await directoryWith({});
  const installedDirectory = join(root, '.ligule', 'extensions');
  const readDirectory = (path: string) => {
    if (path === installedDirectory) return Promise.resolve(['solo.js', 'pack', 'half-pack', 'state.json']);
    if (path === join(installedDirectory, 'pack')) return Promise.resolve(['index.js', 'notes.md']);
    if (path === join(installedDirectory, 'half-pack')) return Promise.resolve([' readme.md ']);
    return Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }));
  };
  const listed = await extensionSources({}, { projectRoot: root, userHome: root, readDirectory, disabled: ['pack'] });
  assert.deepEqual(listed.paths, [join(installedDirectory, 'solo.js')], '停用的目录包不加载，缺 index.js 的目录也不加载');
  assert.deepEqual(listed.disabled, [{ name: 'pack', path: join(installedDirectory, 'pack', 'index.js') }]);
  assert.deepEqual(listed.installNames[join(installedDirectory, 'pack', 'index.js')], 'pack');
  assert.ok(listed.ignored.some((entry) => entry.code === 'extension_package_index_missing' && entry.path.endsWith('half-pack')), '缺入口的目录包给出诊断');
  // 配置层显式声明的路径不受启停登记约束。
  const declared = await extensionSources(
    { user: { extensions: [join(installedDirectory, 'pack', 'index.js')] } },
    { projectRoot: root, userHome: root, readDirectory, disabled: ['pack'] },
  );
  assert.deepEqual(declared.paths, [join(installedDirectory, 'solo.js'), join(installedDirectory, 'pack', 'index.js')]);
});

test('the extension state registry round-trips and treats unreadable documents as empty', async () => {
  const root = await directoryWith({});
  const { extensionStatePath, readExtensionState, writeExtensionState } = await import('../dist/kernel/extension-state.js');
  const statePath = extensionStatePath(root);
  assert.deepEqual(await readExtensionState(root), { disabled: [] }, '没有登记文件时为空');
  await writeExtensionState(root, ['pack', 'pack', 'solo']);
  assert.deepEqual(await readExtensionState(root), { disabled: ['pack', 'solo'] }, '写入去重并排序');
  await writeFile(statePath, '{', 'utf8');
  const broken = await readExtensionState(root);
  assert.deepEqual(broken.disabled, [], '损坏按空登记处理');
  assert.ok(broken.invalid, '损坏原因可见');
  // 停用名单不可信：unavailable 让环境装载把全部已安装扩展退出活动路径，
  // extensions.set 中止写入而不是以空名单覆盖。
  assert.ok(broken.unavailable, '损坏时名单不可信');
  const installedDirectory = join(root, '.ligule', 'extensions');
  const readDirectory = (path: string) => (path === installedDirectory
    ? Promise.resolve(['pack.js'])
    : Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })));
  const blocked = await extensionSources({}, { projectRoot: root, userHome: root, readDirectory, disabled: null });
  assert.deepEqual(blocked.paths, [], '登记不可读时安装扩展不进活动路径');
  assert.deepEqual(blocked.disabled, [{ name: 'pack', path: join(installedDirectory, 'pack.js') }], '全部按停用展示');
  // 配置层显式声明的路径不受登记影响。
  const declared = await extensionSources(
    { user: { extensions: [join(installedDirectory, 'pack.js')] } },
    { projectRoot: root, userHome: root, readDirectory, disabled: null },
  );
  assert.deepEqual(declared.paths, [join(installedDirectory, 'pack.js')]);
});

test('the narrow interface is the four things the contract names, and registrations reach the kernel', async () => {
  const root = await directoryWith({
    'one.js': `export default function one(host) {
  host.registerTool({ name: 'extra', description: 'from the extension', access: 'read', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'ran' }) });
  host.registerPrompt({ name: 'notes', text: 'what the extension wants said' });
  globalThis.__seen = Object.keys(host).sort().join(',');
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments: ExtensionFragment[] = [];
  const options: ExtensionLoadOptions = {
    config: {},
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: (fragment) => {
      fragments.push(fragment);
      return () => fragments.splice(fragments.indexOf(fragment), 1);
    },
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  };
  const loaded = await loadExtensions([join(root, 'one.js')], options);
  assert.deepEqual(loaded.loaded.map((entry) => entry.name), ['one']);
  assert.equal((globalThis as { __seen?: string }).__seen, 'onEvent,registerPrompt,registerTool,request');
  assert.deepEqual(kernel.list(), ['extra']);
  assert.equal(fragments[0].text, 'what the extension wants said');
  loaded.dispose();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(fragments, []);
});

test('a broken extension takes back its own registrations and leaves the others alone', async () => {
  const root = await directoryWith({
    'good.js': 'export default function good(host) { host.registerTool({ name: "keep", description: "stays", access: "read", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ok" }) }); }',
    'no-default.js': 'export const notAFactory = 1;',
    'throws.js': 'export default function throws(host) { host.registerTool({ name: "half", description: "must not stay", access: "read", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ok" }) }); throw new Error("boom in setup"); }',
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const options: ExtensionLoadOptions = {
    config: {},
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  };
  const loaded = await loadExtensions(
    [join(root, 'good.js'), join(root, 'no-default.js'), join(root, 'throws.js')],
    options,
  );
  assert.deepEqual(loaded.diagnostics.map((entry) => entry.code), ['extension_shape_invalid', 'extension_load_failed']);
  assert.match(loaded.diagnostics[1].detail, /boom in setup/);
  // 坏掉那件自己登记的半截被撤走，前一件好的留下：一次装载失败不留半装的表，也不带走别人。
  assert.deepEqual(kernel.list(), ['keep']);
});

test('extension disposal attempts all owned cleanups in reverse order and only once', async () => {
  const root = await directoryWith({
    'cleanup.js': `export default function cleanup(host) {
  host.registerTool({ name: 'cleanup-tool', description: 'tool', access: 'read', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'ok' }) });
  host.registerPrompt({ name: 'cleanup-prompt', text: 'prompt' });
  host.onEvent(() => {});
  return () => { throw new Error('extension disposer failed'); };
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments = new Map<string, ExtensionFragment>();
  const listeners = new Set<(event: unknown) => void>();
  const loaded = await loadExtensions([join(root, 'cleanup.js')], {
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: (fragment) => { fragments.set(fragment.name, fragment); return () => fragments.delete(fragment.name); },
    addEventListener: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    request: (name, args) => kernel.call(name, args),
  });
  assert.throws(() => loaded.dispose(), (error) => error instanceof Error && error.message === 'extension disposer failed');
  assert.deepEqual(kernel.list(), []);
  assert.equal(fragments.size, 0);
  assert.equal(listeners.size, 0);
  loaded.dispose();
  assert.deepEqual(kernel.list(), []);
});

test('extension setup failure keeps its error visible when owned cleanup also fails', async () => {
  const root = await directoryWith({
    'broken-cleanup.js': `export default function brokenCleanup(host) {
  host.registerTool({ name: 'partial-tool', description: 'tool', access: 'read', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'ok' }) });
  host.registerPrompt({ name: 'partial-prompt', text: 'prompt' });
  throw new Error('original setup failure');
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments = new Map<string, ExtensionFragment>();
  const loaded = await loadExtensions([join(root, 'broken-cleanup.js')], {
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: (fragment) => { fragments.set(fragment.name, fragment); return () => { fragments.delete(fragment.name); throw new Error('fragment cleanup failed'); }; },
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  });
  assert.equal(loaded.diagnostics.length, 1);
  assert.match(loaded.diagnostics[0].detail, /original setup failure/);
  assert.match(loaded.diagnostics[0].detail, /fragment cleanup failed/);
  assert.deepEqual(kernel.list(), []);
  assert.equal(fragments.size, 0);
});

test('what an extension asks for still passes the decision chain and the record', async () => {
  const root = await directoryWith({
    'calls.js': `export default function calls(host) {
  globalThis.__request = () => host.request('read', { path: '../outside.txt' });
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  loadAssembly(kernel, [minimalPlugin]);
  const options: ExtensionLoadOptions = {
    config: {},
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  };
  const loaded = await loadExtensions([join(root, 'calls.js')], options);
  loaded.dispose();
  await assert.rejects(
    () => (globalThis as unknown as { __request: () => Promise<unknown> }).__request(),
    (error) => error instanceof Error && (error as { code?: string }).code === 'path_escapes_boundary',
    'the boundary is not something an extension can step around by asking',
  );
});

// 判据那一条：一份扩展装上一件工具与一段提示词片段，选它的模式看得见这两样；名字写错在装载那一刻就报。
const { createConnection, createMemoryConnectionPair, MESSAGES_CAPABILITIES, modeDirectories, serveHost } = await import('../dist/index.js');

async function withSession<TResult>(
  modePrompt: readonly string[],
  run: (connection: Connection, requests: ModelRequest[], host: Host) => TResult | Promise<TResult>,
): Promise<TResult> {
  const root = await directoryWith({
    'one.js': 'export default function one(host) { host.registerTool({ name: "extra", description: "from the extension", access: "read", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ran" }) }); host.registerPrompt({ name: "notes", text: "what the extension wants said" }); }',
  });
  const userHome = join(root, 'home');
  const directories = modeDirectories(root, shippedModes, userHome);
  await mkdir(directories.user, { recursive: true });
  await writeFile(join(directories.user, 'picked.toml'), `tools = "*"\nprompt = ${JSON.stringify(modePrompt)}\n`);
  const config = createConfig({ user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'm' }, policy: { mode: 'ask' } } });
  const requests: ModelRequest[] = [];
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'm',
    async *stream(request: ModelRequest) {
      requests.push(request);
      yield { type: 'text', text: 'ok' };
    },
  });
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    config,
    provider,
    policy: config.policy as { mode?: PolicyMode },
    permission: fullAccess,
    modeName: 'picked',
    modePaths: directories,
    extensions: { paths: [join(root, 'one.js')], ignored: [] },
  });
  const connection = createConnection(pair.client);
  try {
    return await run(connection, requests, host);
  } finally {
    pair.client.output.end();
    await host.release();
  }
}

test('a mode that picks an extension fragment hands the tool and the text to the model', async () => {
  await withSession(['notes'], async (connection, requests) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: 'say ok' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].tools.map((entry) => entry.name).includes('extra'), 'the extension tool reaches the manifest');
    assert.match(JSON.stringify(requests[0].system ?? requests[0]), /what the extension wants said/);
  });
});

test('a mode naming a fragment nobody registered fails at the request, not silently', async () => {
  const failure = await withSession(['absent'], (connection) =>
    connection.request('session.create', {}).catch((error: unknown) => error)) as { code: string; detail: string };
  assert.equal(failure.code, 'mode_prompt_unavailable');
  assert.match(failure.detail, /absent/);
});
