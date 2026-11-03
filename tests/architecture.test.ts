import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  createConfig, createDecisionChain, createKernel, createLoop, createSessionLog, findTool,
  loadAssembly, minimalPlugin, probeBackend, readTool,
} from '../core/dist/index.js';
import type { Kernel, ToolDefinition } from '../core/dist/kernel/kernel.js';
import type { Plugin } from '../core/dist/kernel/assembly.js';
import type { ModelProvider, ModelRequest, ProviderEvent } from '../core/dist/kernel/loop.js';

const sourceDirectories = [
  fileURLToPath(new URL('../core/src/', import.meta.url)),
  fileURLToPath(new URL('../tui/src/', import.meta.url)),
];

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

test('runtime source files use TypeScript only', () => {
  const javascript = sourceDirectories.flatMap((directory) => filesBelow(directory)
    .filter((path) => ['.js', '.mjs', '.cjs'].some((extension) => path.endsWith(extension)))
    .map((path) => path.slice(directory.length)));
  assert.deepEqual(javascript, []);
});

function tool(name: string, run: ToolDefinition['run'], execution?: ToolDefinition['execution']): ToolDefinition {
  return { name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} }, execution, run };
}

test('清单第 1 条：全新构造的内核工具表为空，最小清单装载之后才有能力', () => {
  const kernel = createKernel();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(kernel.manifest(), []);
  loadAssembly(kernel, [minimalPlugin]);
  assert.equal(kernel.list().length, 8);
});

test('清单第 2 条：装配清单能读出本次运行装了哪些插件', () => {
  const assembly = loadAssembly(createKernel(), [minimalPlugin, { name: 'extra', setup: () => () => {} }]);
  assert.deepEqual(assembly.list(), ['ligule-minimal', 'extra']);
});

test('清单第 3 条：两个插件声明同名工具时整份装载失败并回滚', () => {
  const kernel = createKernel();
  const asFirst: Plugin<Kernel> = { name: 'a', setup: (host) => host.register(tool('dup', async () => ({}))) };
  const asSecond: Plugin<Kernel> = { name: 'b', setup: (host) => host.register(tool('dup', async () => ({}))) };
  assert.throws(() => loadAssembly(kernel, [asFirst, asSecond]), (error) => (error as { code: string }).code === 'tool_already_registered');
  assert.deepEqual(kernel.list(), []);
});

test('清单第 4 条：后一个守卫无法放宽前一个守卫的拒绝', async () => {
  const chain = createDecisionChain({ mode: 'auto', ask: async () => true });
  chain.guard(() => 'denied by the first guard');
  chain.guard(() => 'denied by the second guard');
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'ls' } }), {
    decision: 'deny',
    code: 'guard_denied',
    reason: 'denied by the first guard',
    capability: 'exec',
    via: 'guard',
    level: 'auto',
  });
});

test('清单第 5 条：上级引用越界与链接指向边界之外，两种都拒绝', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'arch-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'ok.txt'), 'inside');
    const context = { config: createConfig({ user: { boundary: workspace } }) } as Parameters<typeof readTool.run>[1];
    await assert.rejects(
      () => readTool.run({ path: '../ok-outside.txt' }, context),
      (error) => (error as { code: string }).code === 'path_escapes_boundary',
    );
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'outside', 'secret.txt'), 'outside');
    await symlink(join(root, 'outside'), join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => readTool.run({ path: 'link/secret.txt' }, context),
      (error) => (error as { code: string }).code === 'path_escapes_through_link',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清单第 6 条的工具部分：卸载插件后不留下工具', () => {
  const kernel = createKernel();
  const assembly = loadAssembly(kernel, [minimalPlugin]);
  assert.equal(kernel.list().length, 8);
  assembly.dispose();
  assert.deepEqual(kernel.manifest(), []);
  assert.deepEqual(kernel.list(), []);
});

test('清单第 7 条：上一轮模型看到的工具清单与注入内容能从会话记录重建', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'arch-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'the body');
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), session });
    const assembly = loadAssembly(kernel, [{ name: 'read-only', setup: (host) => {
      const disposers = [readTool, findTool].map((entry) => host.register(entry));
      return () => disposers.forEach((dispose) => dispose());
    } }]);
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        yield* requests.length === 1
          ? [{ type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } }]
          : [{ type: 'text', text: 'read it' }];
      },
    };
    assert.deepEqual((await createLoop({ kernel, provider, session }).run('read the note')).text, 'read it');
    assert.deepEqual(requests[0].tools.map((entry) => entry.name), ['find', 'read']);
    assert.deepEqual(requests[1].messages, [
      { role: 'user', text: 'read the note' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
      { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'the body' }, failed: false, code: undefined },
    ]);
    assembly.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清单第 8 条：能力探测不出结果时报明确错误码，不静默降级', async () => {
  assert.deepEqual(await probeBackend({ name: 'no-probe' }), { name: 'no-probe', enforced: 'none', code: 'capability_probe_missing' });
  assert.deepEqual(await probeBackend({ name: 'broken', probe: () => { throw new Error('missing tool'); } }), {
    name: 'broken',
    enforced: 'none',
    code: 'capability_probe_failed',
  });
});

test('清单第 9 条：内核一侧不引入传输、界面与适配器，同进程直接调用跑通一轮', async () => {
  // 扫描整个目录，确保之后加入的文件也遵守相同边界。
  // Kernel、Session 和 Model 负责业务逻辑；传输与界面适配由 Host 及产品模块处理。
  // Host 可以调用 Kernel，但 Kernel 不得反向依赖 Host。
  const pureDirectories = ['kernel', 'session'];
  const forbidden = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:worker_threads', 'cli.js', 'host/', 'ui', 'dom'];
  for (const directory of pureDirectories) {
    for (const file of readdirSync(join(sourceDirectories[0], directory))) {
      const specifiers = [...readFileSync(join(sourceDirectories[0], directory, file), 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of specifiers) {
        assert.ok(!forbidden.some((entry) => specifier.includes(entry)), `${directory}/${file} imports ${specifier}`);
      }
    }
  }
  const kernel = createKernel();
  kernel.register(tool('ping', async () => ({ text: 'pong' })));
  let asked = 0;
  const provider: ModelProvider = {
    async *stream() {
      asked += 1;
      yield* (asked === 1 ? [{ type: 'tool-call', name: 'ping' }] : [{ type: 'text', text: 'done' }]) as unknown as ProviderEvent[];
    },
  };
  assert.deepEqual(await createLoop({ kernel, provider }).run('go'), { text: 'done', iterations: 2, modelCalls: 2 });
});

test('清单第 11 条：参数模式形状不合法时注册当场失败', () => {
  const kernel = createKernel();
  assert.throws(
    () => kernel.register({ name: 'bad', description: 'd', parameters: { type: 'string' }, run: async () => ({}) }),
    (error) => (error as { code: string }).code === 'tool_parameters_type_not_object',
  );
});
