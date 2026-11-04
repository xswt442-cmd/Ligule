// 验证模式文件的查找顺序、字段格式和错误码，
// 以及装载之后真的收紧了交给模型的那一栏工具。临时目录是真的目录层级，工具是真的最小清单，
// 提供方只用来把请求体交回来看见 tools 那一栏，没有假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  applyMode, createConfig, createConnection, createKernel, createMemoryConnectionPair, createSkillPlugin, DEFAULT_MODE,
  loadAssembly, loadMode, MESSAGES_CAPABILITIES, minimalPlugin, modeDirectories, serveHost, createSessionLog,
} from '../dist/index.js';
import { createHost, type Host } from '../dist/host/host.js';
import { resolveModeSelection } from '../dist/kernel/modes.js';
import type { ModeDirectories } from '../dist/kernel/modes.js';
import type { ModelRequest } from '../dist/kernel/loop.js';
import type { SessionEvent } from '../dist/session/format.js';
import type { PolicyMode } from '../dist/kernel/policy.js';
import { testHostProvider } from './helpers/provider.ts';

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));
const MINIMAL = ['create', 'delete', 'edit', 'exec', 'find', 'read', 'search', 'write'];
const HOST_MINIMAL = [...MINIMAL, 'managed_process'];

type ModeLayout = {
  readonly directories: ModeDirectories;
  readonly projectRoot: string;
  readonly userHome: string;
};

// 三层目录各放在一个临时根下：userHome 与 projectRoot 指哪儿都由调用方给，不碰进程环境。
async function withLayout(run: (layout: ModeLayout) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-modes-'));
  const projectRoot = join(root, 'project');
  const userHome = join(root, 'home');
  await mkdir(join(userHome, '.ligule', 'modes'), { recursive: true });
  await mkdir(join(projectRoot, '.ligule', 'modes'), { recursive: true });
  try {
    return await run({ directories: modeDirectories(projectRoot, shippedModes, userHome), projectRoot, userHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeMode(directories: ModeDirectories, layer: keyof ModeDirectories, name: string, text: string) {
  const path = join(directories[layer], `${name}.toml`);
  await mkdir(directories[layer], { recursive: true });
  await writeFile(path, text);
  return path;
}

const complete = (tools: string) => `tools = ${tools}\nprompt = []\n`;

test('the same name in two layers resolves to the highest one, whole file and no merging', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'review', complete('["read", "find"]'));
    await writeMode(directories, 'project', 'review', complete('["read"]'));
    const mode = await loadMode('review', directories);
    assert.equal(mode.layer, 'project');
    assert.deepEqual(mode.tools, ['read']);
  });
});

test('a name only the shipped layer has still loads, and the default is the shipped minimal one', async () => {
  await withLayout(async ({ projectRoot, userHome }) => {
    const shipped = modeDirectories(projectRoot, shippedModes, userHome);
    const minimal = await loadMode(DEFAULT_MODE, shipped);
    assert.equal(minimal.layer, 'shipped');
    // 文件里写的顺序就是要交给模型的那一份顺序，装载不重排；这里比的是同一批成员。
    assert.deepEqual([...(minimal.tools as string[])].sort(), [...HOST_MINIMAL].sort());
    const full = await loadMode('full', shipped);
    assert.equal(full.tools, '*');
  });
});

test('a missing name says so and names the directories it looked in', async () => {
  await withLayout(async ({ directories }) => {
    const error = await loadMode('absent', directories).catch((failure) => failure);
    assert.equal(error.code, 'mode_unknown');
    assert.match(error.detail, /modes.absent\.toml/);
  });
});

test('a name that could escape the mode directories is refused before any read', async () => {
  await withLayout(async ({ directories }) => {
    for (const name of ['../secret', 'a/b', '', 'Upper', 'x'.repeat(200)]) {
      const error = await loadMode(name, directories).catch((failure) => failure);
      assert.equal(error.code, 'mode_name_invalid', name);
    }
  });
});

// 模式配置中的两个字段都必须提供，避免字段遗漏后模式看似生效却未按预期工作。
test('both fields are required and nothing else is accepted', async () => {
  await withLayout(async ({ directories }) => {
    const cases = [
      ['tools = ["read"]\n', 'mode_field_missing'],
      ['prompt = []\n', 'mode_field_missing'],
      [`${complete('["read"]')}extra = 1\n`, 'mode_field_unknown'],
      // 模式不能配置技能或扩展来源；遇到未支持的字段时应明确报错。
      [`${complete('["read"]')}sources = ["./plugin.ts"]\n`, 'mode_field_unknown'],
      ['tools = "read"\nprompt = []\n', 'mode_field_invalid'],
      [complete('["read", "read"]'), 'mode_field_duplicate'],
      ['tools = { oops = 1 }\nprompt = []\n', 'mode_field_invalid'],
      ['not toml at all = =\n', 'mode_file_invalid'],
    ];
    for (const [index, [text, code]] of cases.entries()) {
      await writeMode(directories, 'user', `shape${index}`, text);
      const error = await loadMode(`shape${index}`, directories).catch((failure) => failure);
      assert.equal(error.code, code, `${code} expected for:\n${text}`);
    }
  });
});

test('the project layer wins whole, and its file still cannot name what the loader has no field for', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'mine', complete('["read", "find"]'));
    await writeMode(directories, 'project', 'mine', complete('["read"]'));
    const mode = await loadMode('mine', directories);
    assert.equal(mode.layer, 'project');
    // 整份覆盖：全局那份写了两个工具，项目那份写一个，生效的就只有一个，不做按键合并。
    assert.deepEqual(mode.tools, ['read']);
  });
});

test('delegation mode selections normalize legacy names, inherited names, and inline definitions', async () => {
  await withLayout(async ({ directories }) => {
    const path = await writeMode(directories, 'project', 'review', complete('["read"]'));
    const named = await loadMode('review', directories);
    const inherited = (await resolveModeSelection(undefined, directories, named))!;
    assert.equal(inherited.source, 'named');
    assert.equal(inherited.name, 'review');
    assert.equal(inherited.application, named);

    const legacy = (await resolveModeSelection('review', directories))!;
    const explicit = (await resolveModeSelection({ type: 'named', name: 'review' }, directories))!;
    assert.equal(legacy.fileDigest, named.digest);
    assert.deepEqual(explicit, legacy);
    assert.equal((explicit.application as { path?: string }).path, path);

    const inline = await resolveModeSelection({ type: 'inline', tools: ['read'], prompt: [] }, directories);
    assert.deepEqual(inline, {
      application: { name: 'inline', tools: ['read'], prompt: [] },
      source: 'inline', name: 'inline', layer: 'inline',
    });
    await assert.rejects(
      resolveModeSelection({ type: 'inline', tools: ['read', 'read'], prompt: [] }, directories),
      { code: 'mode_field_duplicate' },
    );
  });
});

// `prompt` 字段选择扩展注册的提示片段；模式加载时只解析片段名称。
test('the prompt field keeps the names it was written with, selection happens at load', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'review', 'tools = ["read"]\nprompt = ["notes"]\n');
    const mode = await loadMode('review', directories);
    assert.deepEqual(mode.prompt, ['notes']);
    // 哪一个名字在本次登记的片段里没有，要等扩展装完才知道，那一问由 Host 报 `mode_prompt_unavailable`。
    await writeMode(directories, 'user', 'wide', 'tools = ["read"]\nprompt = "*"\n');
    assert.equal((await loadMode('wide', directories)).prompt, '*');
  });
});

function kernelWithMinimal() {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  loadAssembly(kernel, [minimalPlugin]);
  return kernel;
}

// 固定的 `skill` 工具不受模式清单控制，始终可用。
function kernelWithDisclosure() {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  loadAssembly(kernel, [minimalPlugin, createSkillPlugin({ skills: [], diagnostics: [] })]);
  return kernel;
}

test('a mode cannot name the disclosure entry, and hiding the rest still leaves it visible', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'withskill', complete('["read", "skill"]'));
    let error!: { code: string; detail: string };
    try {
      applyMode(kernelWithDisclosure(), await loadMode('withskill', directories));
    } catch (failure) {
      error = failure as { code: string; detail: string };
    }
    // 写它的名字是清单写错了：静默收下会让人以为那一件被关掉了。
    assert.equal(error.code, 'mode_tool_not_selectable');
    assert.match(error.detail, /skill/);

    await writeMode(directories, 'user', 'justread', complete('["read"]'));
    const narrowed = kernelWithDisclosure();
    applyMode(narrowed, await loadMode('justread', directories));
    assert.deepEqual(narrowed.manifest().map((entry) => entry.name), ['read', 'skill']);
    assert.equal(narrowed.list().length, 9);
  });
});

test('applying a mode narrows what the model is offered, and "*" offers everything registered', async () => {
  await withLayout(async ({ directories, projectRoot, userHome }) => {
    await writeMode(directories, 'user', 'readonly', complete('["read", "find", "search"]'));
    const selected = applyMode(kernelWithMinimal(), await loadMode('readonly', directories)).tools;
    assert.deepEqual(selected, ['read', 'find', 'search']);

    const kernel = kernelWithMinimal();
    applyMode(kernel, await loadMode('readonly', directories));
    assert.deepEqual(kernel.manifest().map((entry) => entry.name), ['find', 'read', 'search']);
    // 隐藏工具仍保留在注册表中，但不会提供给模型或接受直接调用。
    assert.equal(kernel.list().length, MINIMAL.length);
    const shipped = modeDirectories(projectRoot, shippedModes, userHome);
    assert.deepEqual(applyMode(kernelWithMinimal(), await loadMode('full', shipped)).tools, MINIMAL);
  });
});

test('a mode naming a tool this run never registered fails instead of quietly offering fewer', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'typo', complete('["read", "browser"]'));
    const mode = await loadMode('typo', directories);
    let error!: { code: string; detail: string };
    try {
      applyMode(kernelWithMinimal(), mode);
    } catch (failure) {
      error = failure as { code: string; detail: string };
    }
    assert.equal(error.code, 'mode_tool_unregistered');
    assert.match(error.detail, /browser/);
    // 报错时把本次真的登记了哪几件一起说出来，写清单的人不用再去翻代码。
    assert.match(error.detail, /registered: create, delete/);
  });
});

// 装载真的走到交给模型的那一份请求里：Host 在一侧收紧，提供方请求体的 tools 就是那一栏。
test('a session built by the Host asks the provider with only the mode-selected tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-modes-host-'));
  const projectRoot = join(root, 'project');
  const userHome = join(root, 'home');
  await mkdir(join(userHome, '.ligule', 'modes'), { recursive: true });
  await writeFile(join(root, 'note.txt'), 'hello');
  const directories = modeDirectories(projectRoot, shippedModes, userHome);
  await writeMode(directories, 'user', 'readonly', complete('["read"]'));
  const config = createConfig({
    user: {
      boundary: root,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'ask' },
    },
  });
  const requests: ModelRequest[] = [];
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request: ModelRequest) {
      requests.push(request);
      yield { type: 'text', text: 'ok' };
    },
  });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as { mode?: PolicyMode }, modeName: 'readonly', modePaths: directories,
    skillRegistry: { skills: [], diagnostics: [] } });
  const connection = createConnection(pair.client);
  try {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: 'say ok' });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tools.map((entry) => entry.name), ['compact', 'read']);
  } finally {
    pair.client.output.end();
    host.release();
    await rm(root, { recursive: true, force: true });
  }
});

// 模式变更在当前轮次结束后生效；生效前再次选择当前模式会撤销待处理的变更。
test('a switch asked for during a round takes effect only once that round ends', async () => {
  await withLayout(async ({ directories, projectRoot, userHome }) => {
    await writeMode(directories, 'user', 'readonly', complete('["read"]'));
    await writeMode(directories, 'user', 'wide', complete('["read", "find"]'));
    const config = createConfig({
      user: {
        boundary: projectRoot,
        model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
        policy: { mode: 'ask' },
      },
    });
    let release!: () => void;
    const requests: ModelRequest[] = [];
    const provider = testHostProvider({
      capabilities: MESSAGES_CAPABILITIES,
      model: 'test-model',
      async *stream(request: ModelRequest) {
        requests.push(request);
        // 只卡第一次模型调用，让测试能站在「本轮还在跑」这一侧提请求；第二次照常走完。
        if (requests.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        yield { type: 'text', text: 'ok' };
      },
    });
    const pair = createMemoryConnectionPair();
    const host = serveHost({
      input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as { mode?: PolicyMode },
      modeName: 'readonly', modePaths: directories, skillRegistry: { skills: [], diagnostics: [] },
    });
    const connection = createConnection(pair.client);
    const waiting = connection.request('session.create', {});
    try {
      const { sessionId } = await waiting as { sessionId: string };
      const running = connection.request('run.start', { sessionId, input: 'first' });
      // 等的是条件而不是「running 那一格刚落」：本轮真正卡在第一次模型请求上，那一次没到就没有 `release` 可按。
      for (let tried = 0; ((await connection.request('status.get', { sessionId })) as { running?: boolean }).running !== true || requests.length === 0; tried += 1) {
        assert.ok(tried < 100, 'the round never started');
        await setTimeout(5);
      }

      const asked = await connection.request('mode.set', { sessionId, name: 'wide' }) as { pending?: string | null; tools?: string[] };
      assert.equal(asked.pending, 'wide');
      assert.deepEqual(asked.tools, ['compact', 'read'], '本轮交给模型的那一栏没在半路变');

      // 再选一次当前那一份：这是撤回，不是第二次切换。
      const withdrawn = await connection.request('mode.set', { sessionId, name: 'readonly' }) as { pending?: string | null; mode?: string };
      assert.equal(withdrawn.pending, null);
      assert.equal(withdrawn.mode, 'readonly');

      await connection.request('mode.set', { sessionId, name: 'wide' });
      release();
      assert.equal((await running as { text: string }).text, 'ok');

      const after = await connection.request('status.get', { sessionId }) as { mode?: string; pendingMode?: string | null; tools?: string[] };
      assert.equal(after.mode, 'wide');
      assert.equal(after.pendingMode, null);
      assert.deepEqual(after.tools, ['compact', 'find', 'read']);
      // 下一轮真的用上新清单（收紧撤掉后 find 又回来了）。
      await connection.request('run.start', { sessionId, input: 'second' });
      assert.deepEqual(requests[1].tools.map((entry) => entry.name), ['compact', 'find', 'read']);
      const { events } = await connection.request('session.read', { sessionId }) as { events: SessionEvent[] };
      assert.deepEqual(events.filter((event) => event.kind === 'mode').map((event) => event.name), ['readonly', 'wide']);
      assert.deepEqual(events.filter((event) => event.kind === 'mode').at(-1)!.tools, ['compact', 'find', 'read'],
        'a successful wider mode records the final tools instead of the temporary intersection');
    } finally {
      release?.();
      pair.client.output.end();
      host.release();
    }
  });
});

test('session close cannot retire a session while execute is settling a pending mode', async () => {
  await withLayout(async ({ directories, projectRoot }) => {
    await writeMode(directories, 'user', 'readonly', complete('["read"]'));
    await writeMode(directories, 'user', 'wide', complete('["read", "find"]'));
    const sessionDirectory = join(projectRoot, '.ligule', 'sessions');
    const sessionId = 'settling-mode-session';
    const seeded = createSessionLog({ directory: sessionDirectory, id: sessionId, meta: { projectRoot } });
    try {
      for (let round = 0; round < 3; round += 1) {
        await seeded.append({ kind: 'user', text: `question ${round} ${'x'.repeat(4_000)}` });
        await seeded.append({ kind: 'assistant', text: `answer ${round} ${'y'.repeat(4_000)}`, toolCalls: [] });
      }
    } finally {
      await seeded.close();
    }
    const config = createConfig({
      user: {
        boundary: projectRoot,
        host: { sessionDirectory },
        model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
        limits: { contextTokens: 5_000, compactThresholdRatio: 0.8, compactRetainRatio: 0.05, resultBytes: 16_000 },
        policy: { mode: 'ask' },
      },
    });
    let releaseSummary!: () => void;
    let summaryStarted!: () => void;
    const started = new Promise<void>((resolve) => { summaryStarted = resolve; });
    const summaryResponse = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const provider = testHostProvider({
      capabilities: MESSAGES_CAPABILITIES,
      model: 'test-model',
      async *stream(request: ModelRequest) {
        if (String((request.messages?.[0] as { text?: string } | undefined)?.text ?? '').startsWith('Write a summary')) {
          summaryStarted();
          await summaryResponse;
          yield { type: 'text', text: 'A concise summary of the completed turns.' };
        } else {
          yield { type: 'text', text: 'ok' };
        }
      },
    });
    let host!: Host;
    let closeAttempt!: Promise<{ value?: unknown; error?: { code?: string } }>;
    let releaseHost!: Promise<void>;
    let settlingObserved = false;
    const connection = {
      request: async () => { throw new Error('unexpected_host_request'); },
      notify(message: Record<string, unknown>) {
        if (message.notify !== 'progress' || message.sessionId !== sessionId || (message.progress as { phase?: string } | undefined)?.phase !== 'settling') return;
        settlingObserved = true;
        closeAttempt = host.handle({ method: 'session.close', params: { sessionId } }, connection).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        // host.handle 的 activeDelegation await 已排入 close continuation；先让它登记 retire，再启动 shutdown。
        queueMicrotask(() => { releaseHost = host.release(); });
      },
    };
    host = createHost({
      config,
      provider,
      policy: config.policy as { mode?: PolicyMode },
      modeName: 'readonly',
      modePaths: directories,
      skillRegistry: { skills: [], diagnostics: [] },
    });

    try {
      await host.handle({ method: 'session.open', params: { sessionId, projectRoot } }, connection);
      const running = host.handle({ method: 'session.compact', params: { sessionId } }, connection);
      await started;
      const mode = await host.handle({ method: 'mode.set', params: { sessionId, name: 'wide' } }, connection) as { pending?: string | null };
      assert.equal(mode.pending, 'wide');

      releaseSummary();
      await running;
      assert.equal(settlingObserved, true);
      assert.equal((await closeAttempt).error?.code, 'run_already_running');
      await releaseHost;

      const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(events.filter((event) => event.kind === 'mode').map((event) => event.name), ['readonly', 'wide']);
    } finally {
      releaseSummary();
      await host.release();
    }
  });
});

test('a rejected mode switch preserves the current tools through the next round and recovery', async () => {
  await withLayout(async ({ directories, projectRoot }) => {
    await writeMode(directories, 'user', 'readonly', complete('["read"]'));
    await writeMode(directories, 'user', 'invalid', complete('["read", "not-registered"]'));
    await writeMode(directories, 'user', 'missing-prompt', 'tools = ["find"]\nprompt = ["absent"]\n');
    const config = createConfig({
      user: {
        boundary: projectRoot,
        model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
        policy: { mode: 'ask' },
      },
    });
    const requests: ModelRequest[] = [];
    const provider = testHostProvider({
      capabilities: MESSAGES_CAPABILITIES,
      model: 'test-model',
      async *stream(request: ModelRequest) {
        requests.push(request);
        yield { type: 'text', text: 'ok' };
      },
    });
    const pair = createMemoryConnectionPair();
    const host = serveHost({
      input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as { mode?: PolicyMode },
      modeName: 'readonly', modePaths: directories, skillRegistry: { skills: [], diagnostics: [] },
    });
    const connection = createConnection(pair.client);
    try {
      const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
      assert.deepEqual((await connection.request('status.get', { sessionId }) as { tools?: string[] }).tools, ['compact', 'read']);

      await assert.rejects(
        connection.request('mode.set', { sessionId, name: 'invalid' }),
        (error) => (error as { code?: string }).code === 'mode_tool_unregistered',
      );
      await assert.rejects(
        connection.request('mode.set', { sessionId, name: 'missing-prompt' }),
        (error) => (error as { code?: string }).code === 'mode_prompt_unavailable',
      );
      const afterFailures = await connection.request('status.get', { sessionId }) as { mode?: string; tools?: string[] };
      assert.equal(afterFailures.mode, 'readonly');
      assert.deepEqual(afterFailures.tools, ['compact', 'read']);

      await connection.request('session.close', { sessionId });
      await connection.request('session.open', { sessionId });
      const recovered = await connection.request('status.get', { sessionId }) as { mode?: string; tools?: string[] };
      assert.equal(recovered.mode, 'readonly');
      assert.deepEqual(recovered.tools, ['compact', 'read']);

      await connection.request('run.start', { sessionId, input: 'continue under the current mode' });
      assert.deepEqual(requests[0].tools.map((tool) => tool.name), ['compact', 'read']);
    } finally {
      pair.client.output.end();
      await host.release();
    }
  });
});
