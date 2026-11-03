// 验证工作区别名归一、持久登记唯一性，以及无效登记的错误处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as callbackExecFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFile = promisify(callbackExecFile);
import { listWorkspaceSessions, MESSAGES_CAPABILITIES, createConfig, createConnection, createMemoryConnectionPair, createSessionLog, serveHost, sessionDirectory } from '../dist/index.js';
import { listSessions } from '../dist/session/list.js';
import type { Connection } from '../dist/host/connection.js';
import type { Host, HostOptions } from '../dist/host/host.js';
import type { HostProvider } from '../dist/host/provider.js';
import type { SessionEvent } from '../dist/session/format.js';
import { parseRegistry, readRegistry, registerWorkspace, setDefaultWorkspace, unregisterWorkspace, workspaceIdentity } from '../dist/kernel/workspace.js';
import type { WorkspaceRegistry } from '../dist/kernel/workspace.js';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** 临时根里真建一个目录：身份读的是磁盘上那一份，夹具就得是真的。 */
async function withWorkspace(run: (directory: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-ws-'));
  const directory = join(root, 'Workspace One');
  await mkdir(directory);
  try {
    return await run(directory, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('同一个目录的多种写法归成同一个身份', async () => {
  await withWorkspace(async (directory) => {
    const identity = workspaceIdentity(directory);
    assert.equal(workspaceIdentity(`${directory}${sep}`), identity, '尾部分隔符不算另一个目录');
    assert.equal(workspaceIdentity(join(directory, '..', 'Workspace One')), identity, '折上去再折回来还是同一个目录');
    assert.equal(workspaceIdentity(join(directory, '.')), identity, '中间那一段 . 不算另一个目录');
    if (process.platform === 'win32') {
      assert.equal(workspaceIdentity(directory.toUpperCase()), identity, '盘符与路径的大小写不影响身份');
      assert.equal(workspaceIdentity(directory.split(sep).join('/')), identity, '正斜杠与反斜杠是同一个目录的两种写法');
    } else {
      const link = `${directory}-link`;
      try {
        await symlink(directory, link);
        assert.equal(workspaceIdentity(link), identity, '链接指向的那一个目录就是它自己');
      } catch {
        // 这台机器上没给建符号链接的权限：这一格跳过，其余三条已经覆盖归一。
      }
    }
  });
});

test('空的那一格拒掉，不在那儿的目录交回一个绝对身份', () => {
  assert.throws(() => workspaceIdentity('   '), (error) => hasCode(error, 'workspace_directory_required'));
  const far = join(process.cwd(), 'not-there-yet');
  const expected = process.platform === 'win32' ? resolve(far).toLowerCase() : resolve(far);
  assert.equal(workspaceIdentity(far), expected, '目录不在不等于回退到程序目录或启动目录');
});

test('同一具工作区登记两次只有一条，第一次看见的时间留着', async () => {
  await withWorkspace(async (directory, root) => {
    const path = join(root, 'workspaces.json');
    const first = await registerWorkspace(directory, { path, now: '2026-10-01T00:00:00.000Z' });
    assert.equal(first.workspaces.length, 1);
    assert.equal(first.workspaces[0].name, 'Workspace One', '没指名就用目录那一段做显示名');
    const second = await registerWorkspace(join(directory, '.'), { path, name: '改过的名字', now: '2026-10-02T00:00:00.000Z' });
    assert.equal(second.workspaces.length, 1, '别名不再登记第二条');
    assert.equal(second.workspaces[0].firstSeen, '2026-10-01T00:00:00.000Z');
    assert.equal(second.workspaces[0].lastSeen, '2026-10-02T00:00:00.000Z');
    assert.equal(second.workspaces[0].name, '改过的名字');
    const onDisk = await readRegistry(path);
    assert.deepEqual(onDisk.workspaces, second.workspaces);
    assert.equal(onDisk.default, null, '默认选择由界面那一侧写，登记这一处不动它');
  });
});

// 设置默认工作区前先写入登记，确保默认选择始终指向有效记录。
test('默认选择指过去时先登记那一条，退掉时登记一条都不少', async () => {
  await withWorkspace(async (directory, root) => {
    const path = join(root, 'workspaces.json');
    const chosen = await setDefaultWorkspace(directory, { path, name: '默认那一具', now: '2026-10-03T00:00:00.000Z' });
    assert.equal(chosen.workspaces.length, 1, '没登记过的工作区指为默认时先添一条');
    assert.equal(chosen.default, workspaceIdentity(directory));
    assert.equal(chosen.workspaces[0].name, '默认那一具');
    const cleared = await setDefaultWorkspace(null, { path });
    assert.equal(cleared.default, null);
    assert.equal(cleared.workspaces.length, 1, '退掉默认不删登记');
    assert.throws(() => setDefaultWorkspace('   ', { path }), (error) => hasCode(error, 'workspace_directory_required'));
  });
});

test('取消登记只移除工作区行，默认登记必须先清除', async () => {
  await withWorkspace(async (directory, root) => {
    const path = join(root, 'workspaces.json');
    const other = join(root, 'Other');
    await mkdir(other);
    await registerWorkspace(directory, { path });
    await registerWorkspace(other, { path });
    await setDefaultWorkspace(directory, { path });

    await assert.rejects(() => unregisterWorkspace(directory, { path }),
      (error) => hasCode(error, 'workspace_default_cannot_remove'));
    await setDefaultWorkspace(null, { path });
    const updated = await unregisterWorkspace(directory, { path });
    assert.deepEqual(updated.workspaces.map((entry) => entry.directory), [other]);
    assert.equal(updated.default, null);
    assert.equal((await readRegistry(path)).workspaces.length, 1);
    await assert.rejects(() => unregisterWorkspace(directory, { path }),
      (error) => hasCode(error, 'workspace_not_registered'));
  });
});

test('那份登记读不懂就当场拒，不当成空的', () => {
  assert.throws(() => parseRegistry('{'), (error) => hasCode(error, 'workspace_registry_invalid'));
  assert.throws(() => parseRegistry(JSON.stringify({ version: 2, default: null, workspaces: [] })), (error) => hasCode(error, 'workspace_registry_version'));
  assert.throws(() => parseRegistry(JSON.stringify({ version: 1, default: 'nope', workspaces: [] })), (error) => hasCode(error, 'workspace_registry_invalid'), '默认选择指向一个没登记的身份');
  assert.throws(() => parseRegistry(JSON.stringify({ version: 1, default: null, workspaces: [{ identity: 'a' }] })), (error) => hasCode(error, 'workspace_registry_invalid'), '一条记录少了字段就是少了');
  const readable = parseRegistry(JSON.stringify({ version: 1, default: 'a', workspaces: [{ identity: 'a', directory: 'A', name: 'a', firstSeen: 'x', lastSeen: 'y' }] }));
  assert.equal(readable.default, 'a');
});

// 两具宿主同时各记一条：那一把锁保证两条都在，替身名也不留在盘上。
test('两具进程同时登记时两条都留下，替身与锁都不留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-reg-race-'));
  const path = join(root, 'workspaces.json');
  const fixture = fileURLToPath(new URL('../../tests/fixtures/register-workspace.mjs', import.meta.url));
  try {
    await Promise.all(['alpha', 'beta', 'alpha', 'beta'].map(async (one) => {
      const directory = join(root, one);
      await mkdir(directory, { recursive: true });
      try {
        await execFile(process.execPath, [fixture, path, directory], { encoding: 'utf8' });
      } catch (error) {
        const failure = error as { stdout?: string; message: string };
        assert.fail(`那一具进程没登记上：${failure.stdout ?? failure.message}`);
      }
    }));
    const registry = await readRegistry(path);
    assert.deepEqual(registry.workspaces.map((one) => basename(one.directory)).sort(), ['alpha', 'beta'], '两具进程各一条，谁也没盖掉谁');
    const left = (await readdir(root)).filter((one) => one !== 'alpha' && one !== 'beta');
    assert.deepEqual(left, ['workspaces.json'], `替身或锁留在了那一份目录里：${left.join(', ')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type HostFixture = {
  connection: Connection;
  project: string;
  home: string;
  recordDirectory: string;
  headerOf: (sessionId: string) => Promise<Record<string, unknown>>;
};

/** 一具宿主连同它的数据根与项目目录：临时建、用完删，三遍检查共用同一套装配。 */
async function withHost(
  run: (state: HostFixture) => Promise<void>,
  provider = { capabilities: MESSAGES_CAPABILITIES, model: 'test-model', async *stream() { yield { type: 'text', text: 'ok' }; } } as unknown as HostProvider,
) {
  const home = await mkdtemp(join(tmpdir(), 'ligule-ws-home-'));
  const project = await mkdtemp(join(tmpdir(), 'ligule-ws-proj-'));
  const previous = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  const pair = createMemoryConnectionPair();
  let host: Host | undefined;
  try {
    const config = createConfig({ user: { boundary: project, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } });
    host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as HostOptions['policy'] });
    const recordDirectory = sessionDirectory({ boundary: project, workspaceRoot: project });
    return await run({
      connection: createConnection(pair.client),
      project,
      home,
      // 直接读取会话首行中的工作区信息，不依赖工作区列表。
      recordDirectory,
      headerOf: async (sessionId: string) => JSON.parse((await readFile(join(recordDirectory, `${sessionId}.jsonl`), 'utf8')).split('\n')[0]),
    });
  } finally {
    pair.client.output.end();
    if (host !== undefined) await host.release();
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

// 宿主那一条路：真的建了一份会话，那一具工作区就进了登记，位置在应用数据根里，记录首行也带上身份与来源。
test('建会话的那一侧把这一具工作区登记进应用数据根，并把身份与来源写进首行', async () => {
  await withHost(async ({ connection, project, home, headerOf }) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: '第一轮' });
    const registry = await readRegistry();
    assert.equal(registry.workspaces.length, 1);
    assert.equal(registry.workspaces[0].identity, workspaceIdentity(project));
    assert.equal(registry.workspaces[0].name, basename(project), '登记里的显示名是那一段目录名');
    const header = await headerOf(sessionId);
    assert.equal(header.workspace, workspaceIdentity(project), '首行记下这一份会话落在哪一具工作区');
    assert.equal(header.workspaceOrigin, 'default', '客户端没指名项目根，来源就是它当前那一具');
    const [listed] = await listWorkspaceSessions({ boundary: project, workspaceRoot: project }, { projectRoot: project });
    assert.equal(listed.workspace, header.workspace, '列表把这两格一起交出去，界面分组读它而不是读路径相等');
    assert.equal(listed.workspaceOrigin, 'default');
  });
});

test('legacy sessions appear in read-only listings and move into the workspace folder only when opened', async () => {
  await withHost(async ({ connection, project, home, recordDirectory }) => {
    const legacyDirectory = join(home, 'sessions');
    const sessionId = 'legacy-session';
    const foreignSessionId = 'foreign-session';
    const foreignProject = join(home, 'another-project');
    await mkdir(legacyDirectory, { recursive: true });
    const legacy = createSessionLog({
      directory: legacyDirectory,
      id: sessionId,
      meta: () => ({ projectRoot: project, workspace: workspaceIdentity(project) }),
    });
    await legacy.append({ kind: 'user', text: 'keep this history' });
    const projectLegacyDirectory = join(project, '.ligule', 'sessions');
    const localLegacy = createSessionLog({
      directory: projectLegacyDirectory,
      id: sessionId,
      meta: () => ({ projectRoot: project, workspace: workspaceIdentity(project) }),
    });
    await localLegacy.append({ kind: 'user', text: 'older project-local copy' });
    const foreign = createSessionLog({
      directory: legacyDirectory,
      id: foreignSessionId,
      meta: () => ({ projectRoot: foreignProject, workspace: workspaceIdentity(foreignProject) }),
    });
    await foreign.append({ kind: 'user', text: 'belongs to another workspace' });
    const legacyPath = join(legacyDirectory, `${sessionId}.jsonl`);
    const original = await readFile(legacyPath);

    const listed = await connection.request('sessions.list', { projectRoot: project }) as { sessions: { id: string }[] };
    assert.ok(listed.sessions.some((item) => item.id === sessionId));
    assert.equal(listed.sessions.some((item) => item.id === foreignSessionId), false, '共享旧目录按首行工作区筛选');
    const hits = await connection.request('sessions.search', { projectRoot: project, query: 'keep this history' }) as { hits: { sessionId: string }[] };
    assert.equal(hits.hits[0].sessionId, sessionId, '搜索也只读扫描旧目录');
    await assert.rejects(readFile(join(recordDirectory, `${sessionId}.jsonl`)), (error) => hasCode(error, 'ENOENT'), '只读列表不迁移旧记录');

    await connection.request('session.open', { sessionId, projectRoot: project });
    const resumed = await connection.request('session.read', { sessionId }) as { events: SessionEvent[] };
    assert.ok(resumed.events.some((event) => event.kind === 'user' && event.text === 'keep this history'), 'the former shared data-root copy takes precedence over its older project-local source');
    await connection.request('session.close', { sessionId });
    assert.deepEqual(await readFile(legacyPath), original, '旧位置保留原件');
    assert.ok((await readFile(join(recordDirectory, `${sessionId}.jsonl`))).length >= original.length, '明确打开时复制到工作区目录');
    await assert.rejects(readFile(join(recordDirectory, `${foreignSessionId}.jsonl`)), (error) => hasCode(error, 'ENOENT'), '打开一个工作区时不复制其他工作区记录');
  });
});

// 工作区来源由客户端明确提供；即使目录恰好是默认工作区，也不能仅凭路径推断来源。
test('客户端说了来源就按它写，说不认识的值就把这一次请求拒掉', async () => {
  await withHost(async ({ connection, project, headerOf }) => {
    const named = await connection.request('session.create', { projectRoot: project, workspaceOrigin: 'explicit' }) as { sessionId: string };
    await connection.request('run.start', { sessionId: named.sessionId, input: '第一轮' });
    assert.equal((await headerOf(named.sessionId)).workspaceOrigin, 'explicit', '指名的那一份项目根算使用者选的');
    await assert.rejects(() => connection.request('session.create', { workspaceOrigin: 'guessed' }),
      (error) => hasCode(error, 'workspace_origin_unknown'), '写进记录的值只能是那两种之一');
  });
});

// 那份登记的读与写在协议那一头：界面读得到全部登记与默认选择，写只有默认选择一件。
test('协议交回那份登记，默认选择指得着一条登记，空的那一格是退掉', async () => {
  await withHost(async ({ connection, project }) => {
    await connection.request('session.create', {});
    const listed = await connection.request('workspaces.list', {}) as WorkspaceRegistry;
    assert.equal(listed.workspaces.length, 1);
    assert.equal(listed.default, null, '还没人选过默认那一具时这一格是空的');
    const other = await mkdtemp(join(tmpdir(), 'ligule-ws-other-'));
    try {
      const chosen = await connection.request('workspace.default.set', { directory: other, name: '另一具' }) as WorkspaceRegistry;
      assert.equal(chosen.workspaces.length, 2, '指为默认之前先登记');
      assert.equal(chosen.default, workspaceIdentity(other));
      assert.equal((await readRegistry()).workspaces.find((one) => one.identity === chosen.default)!.name, '另一具');
      const cleared = await connection.request('workspace.default.set', { directory: '  ' }) as WorkspaceRegistry;
      assert.equal(cleared.default, null, '空的那一格退掉默认，登记一条都不少');
      assert.equal(cleared.workspaces.length, 2);
      await assert.rejects(() => connection.request('workspace.default.set', { directory: join(project, 'not-a-workspace') }),
        (error) => hasCode(error, 'host_project_root_missing'), '指了一条不在那儿的路要说清是这一件');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

test('Host removes workspace registration without changing project or session files', async () => {
  await withHost(async ({ connection, project, recordDirectory }) => {
    await writeFile(join(project, 'keep.txt'), 'project files stay');
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: '登记工作区' });
    const before = await readRegistry();
    assert.equal(before.workspaces.length, 1);

    await connection.request('workspace.default.set', { directory: project });
    await assert.rejects(() => connection.request('workspace.remove', { directory: project }),
      (error) => hasCode(error, 'workspace_default_cannot_remove'));
    await connection.request('workspace.default.set', { directory: '' });
    const removed = await connection.request('workspace.remove', { directory: project }) as WorkspaceRegistry;
    assert.equal(removed.workspaces.length, 0);
    assert.equal(await readFile(join(recordDirectory, `${sessionId}.jsonl`), 'utf8').then(() => true), true);
    assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'project files stay');
    const restored = await connection.request('workspace.default.set', { directory: project }) as WorkspaceRegistry;
    assert.equal(restored.workspaces[0].identity, workspaceIdentity(project));
    assert.ok(((await connection.request('sessions.list', { projectRoot: project })) as { sessions: { id: string }[] }).sessions.some((item) => item.id === sessionId));
    await connection.request('workspace.default.set', { directory: '' });
    await rm(project, { recursive: true, force: true });
    const removedAfterMove = await connection.request('workspace.remove', { directory: project }) as WorkspaceRegistry;
    assert.equal(removedAfterMove.workspaces.length, 0, 'moved project can be removed by its old registered path');
    await assert.rejects(() => connection.request('workspace.remove', { directory: join(project, 'missing') }),
      (error) => hasCode(error, 'workspace_not_registered'));
  });
});

test('工作区仍有运行中的会话时 Host 拒绝删除登记', async () => {
  let enteredStream!: (value?: unknown) => void;
  const entered = new Promise((resolve) => { enteredStream = resolve; });
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(_request: unknown, { signal }: { signal: AbortSignal }) {
      enteredStream();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'text', text: 'stopped' };
    },
  } as unknown as HostProvider;
  await withHost(async ({ connection, project }) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    const starting = connection.request('run.start', { sessionId, input: '保持运行' });
    await entered;
    await assert.rejects(() => connection.request('workspace.remove', { directory: project }),
      (error) => hasCode(error, 'workspace_in_use'));
    await connection.request('run.cancel', { sessionId });
    await starting.catch(() => undefined);
  }, provider);
});
