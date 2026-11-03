// 会话列表从记录目录读取；恢复时使用记录中最后生效的模式清单并校验摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTuiHost } from './helpers/tui-host.ts';
import {
  branchSession, chooseResumeMode, createBlock, createCheckpointFile, createConfig, createConnection, createMemoryConnectionPair, createSessionLog,
  findUnresolvedCalls, listSessions, listWorkspaceSessions, loadCheckpointFile, loadMode, MESSAGES_CAPABILITIES, modeDirectories, parseSessionBytes,
  searchSessions, serveHost, sessionDirectory, writeCheckpointFile,
} from '../dist/index.js';
import { workspaceIdentity } from '../dist/kernel/workspace.js';
import { workspaceDataDirectory, splitUncIdentity } from '../dist/session/list.js';

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));

// 摘要由 `loadMode` 算出来，这里只取一份真实值用于比对。
async function digestOf(name) {
  return (await loadMode(name, { shipped: shippedModes, user: join('a', 'b'), project: join('c', 'd') })).digest;
}

async function withSessions(run) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const root = await mkdtemp(join(testplace, 'ligule-sessions-'));
  const absoluteRoot = resolve(root);
  assert.equal(absoluteRoot.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  const directory = join(root, '.ligule', 'sessions');
  await mkdir(directory, { recursive: true });
  try {
    return await run(root, directory);
  } finally {
    await rm(absoluteRoot, { recursive: true, force: true });
  }
}

// 默认会话目录由数据根决定；迁移旧目录的行为由 `adopt.test.js` 覆盖。

test('the listing reads each record once and reports what a resume would need', async () => {
  await withSessions(async (root, directory) => {
    const fresh = createSessionLog({ directory, id: 'fresh', meta: () => ({ projectRoot: root, workspace: workspaceIdentity(root), workspaceOrigin: 'default', mode: { name: 'full', layer: 'shipped' } }) });
    await fresh.append({ kind: 'mode', name: 'full', layer: 'shipped', path: 'modes/full.toml', tools: ['read'], digest: 'aaa111' });
    await fresh.append({ kind: 'user', text: 'go' });
    await fresh.append({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'exec', args: { command: 'make' } }] });
    await fresh.append({ kind: 'tool', tool: 'read', callId: 'other', args: {}, result: { content: 'x' } });

    // 加首行之前的现存记录：没有首行也列得出来，版本读作 0。
    await writeFile(join(directory, 'legacy.jsonl'), `${JSON.stringify({ seq: 0, kind: 'user', text: 'older' })}\n`);
    // 不是记录的文件不参与扫描。
    await writeFile(join(directory, 'notes.txt'), 'not a session');
    await utimes(join(directory, 'legacy.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));

    const listed = await listSessions(directory);
    assert.deepEqual(listed.map((item) => item.id), ['fresh', 'legacy'], '最近动过的那一份排在前面');

    const [firstItem, legacy] = listed;
    assert.deepEqual(firstItem, {
      id: 'fresh',
    formatVersion: 2,
      projectRoot: root,
      workspace: workspaceIdentity(root),
      workspaceOrigin: 'default',
      createdAt: firstItem.createdAt,
      updatedAt: firstItem.updatedAt,
      events: 4,
      lastSeq: 3,
      mode: { name: 'full', layer: 'shipped', digest: 'aaa111' },
      name: '',
      archived: false,
      // 那一次 `exec` 派发留在记录里没有结果：列表上就看得见这一份没收尾。
      unanswered: 1,
      truncatedBytes: 0,
    });
    assert.deepEqual({ ...legacy, updatedAt: 'x' }, {
      id: 'legacy',
      formatVersion: 0,
      projectRoot: root,
      // 没有首行的记录说不出这两件事：交回空串说的是「没说」，不是「说的是默认」。
      workspace: '',
      workspaceOrigin: '',
      createdAt: null,
      updatedAt: 'x',
      events: 1,
      lastSeq: 0,
      mode: null,
      name: '',
      archived: false,
      unanswered: 0,
      truncatedBytes: 0,
    });

    // 缺少首行的旧会话按文件所在项目归属，按该项目筛选时仍应列出。
    const filtered = await listSessions(directory, { projectRoot: root });
    assert.deepEqual(filtered.map((item) => item.id), ['fresh', 'legacy']);
    assert.equal(filtered[1].projectRoot, root, '归属那一格写的是扫的那一项目录，不虚构首行里的那一份');
    assert.deepEqual((await listSessions(join(root, 'nothing-here'))), [], '还没有任何记录不是错误');
  });
});

test('headerless records inherit only a physical legacy project, never a requested project', async () => {
  await withSessions(async (root) => {
    const project = join(root, 'old-project');
    const legacyDirectory = join(project, '.ligule', 'sessions');
    const sharedDirectory = join(root, 'shared', 'sessions');
    await mkdir(legacyDirectory, { recursive: true });
    await mkdir(sharedDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, 'physical.jsonl'), '{"seq":0,"kind":"user","text":"old"}\n');
    await writeFile(join(sharedDirectory, 'unknown.jsonl'), '{"seq":0,"kind":"user","text":"unknown"}\n');

    const physical = await listSessions(legacyDirectory, { projectRoot: project });
    assert.equal(physical.length, 1);
    assert.equal(physical[0].projectRoot, project, '只有物理旧项目目录能说明旧记录来源');
    assert.deepEqual(await listSessions(sharedDirectory, { projectRoot: project }), [], '请求筛选条件不能替无头记录补造归属');
    const global = await listSessions(sharedDirectory);
    assert.equal(global.length, 1, '共享目录里的未知来源记录仍在全局列表可见');
    assert.equal(global[0].projectRoot, '');
    assert.equal(global[0].createdAt, null);
  });
});

// 名字与归档标记是记录里的那几条 `label`：后写的盖掉前写的那一件，一条只说另一件时这一件沿用。
// 标签与归档信息只用于会话记录和界面显示，不进入模型上下文。
test('a label folds into the listing and stays out of what the model is shown', async () => {
  await withSessions(async (root, directory) => {
    const log = createSessionLog({ directory, id: 'named', meta: () => ({ projectRoot: root }) });
    await log.append({ kind: 'user', text: 'go' });
    await log.append({ kind: 'label', ignorable: true, name: '读数那一轮' });
    await log.append({ kind: 'label', ignorable: true, archived: true });
    assert.deepEqual((await listSessions(directory)).map((item) => [item.id, item.name, item.archived]), [['named', '读数那一轮', true]], '列表读的是那两条折出来的当前值');
    assert.deepEqual((await log.modelView()).map((row) => row.text), ['go'], '模型那一份里没有这一条事实');
  });
});

test('a search says which record a hit is in and which event it is', async () => {
  await withSessions(async (root, directory) => {
    const newer = createSessionLog({ directory, id: 'newer', meta: () => ({ projectRoot: root }) });
    await newer.append({ kind: 'label', ignorable: true, name: 'alpha 那一份' });
    await newer.append({ kind: 'tool', tool: 'exec', callId: 'c1', args: { command: 'run' }, result: { content: 'done alpha', spilled: 'result-1-abcdef12.json' } });
    // 一份长会话里一个常见词能中几十条：每份最多交三条。
    const many = createSessionLog({ directory, id: 'many', meta: () => ({ projectRoot: root }) });
    for (const line of ['alpha 一', 'alpha 二', 'alpha 三', 'alpha 四', 'alpha 五']) await many.append({ kind: 'user', text: line });
    const older = createSessionLog({ directory, id: 'older', meta: () => ({ projectRoot: root }) });
    await older.append({ kind: 'user', text: '第一段\n   alpha   第二段' });
    // 分支会话不参与主会话搜索；应通过主会话的记录读取分支内容。
    await writeFile(join(directory, 'newer.sub-1.jsonl'), `${JSON.stringify({ seq: 0, kind: 'user', text: 'alpha 写在支线里' })}\n`);
    // 读不出来的那一份不参与查：列表那一行已经带着稳定码说清它读不懂，这里不报第二次，也不猜它写过什么。
    await writeFile(join(directory, 'broken.jsonl'), `${JSON.stringify({ seq: 0, kind: 'nonsense' })}\n`);
    await utimes(join(directory, 'many.jsonl'), new Date('2026-01-02'), new Date('2026-01-02'));
    await utimes(join(directory, 'older.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));

    assert.deepEqual((await searchSessions(directory, { query: 'ALPHA' })).map((hit) => [hit.sessionId, hit.seq, hit.kind]), [
      ['newer', 0, 'label'], ['newer', 1, 'tool'], ['many', 0, 'user'], ['many', 1, 'user'], ['many', 2, 'user'], ['older', 0, 'user'],
    ], '最近动过的那一份先出现，一份最多三条，读不出来的那一份不交命中');

    const hits = await searchSessions(directory, { query: 'alpha' });
    assert.equal(hits[0].name, 'alpha 那一份', '命中的那一行带着这一份会话的名字');
    assert.equal(hits[1].text, 'done alpha');
    assert.equal(hits[1].spilled, 'result-1-abcdef12.json', '整段溢出在文件里时那一行说得出文件名');
    assert.equal(hits[5].text, '第一段 alpha 第二段', '正文里的换行与缩进先收拢，摘录不带半截行');
    assert.deepEqual((await searchSessions(directory, { query: '五' })).map((hit) => [hit.sessionId, hit.seq]), [['many', 4]],
      '上限管的是一份交几条，不是只读前几条');
    assert.equal((await searchSessions(directory, { query: 'alpha', limit: 2 })).length, 2);
    assert.deepEqual(await searchSessions(directory, { query: 'alpha', projectRoot: 'nowhere' }), []);
    assert.deepEqual(await searchSessions(directory, { query: '没有这段文字' }), []);
  });
});

test('a search scoped to one record also reads the results it spilled', async () => {
  await withSessions(async (root, directory) => {
    const log = createSessionLog({ directory, id: 'deep', meta: () => ({ projectRoot: root }) });
    await log.append({ kind: 'label', ignorable: true, name: '溢出那一份' });
    await log.append({ kind: 'tool', tool: 'read', callId: 'c1', args: { path: 'notes/big.md' },
      result: { content: '开头 [omitted: full output is 40000 bytes, kept in result-17-abcdef12.json] 结尾', spilled: 'result-17-abcdef12.json' } });
    // 记录里留着的那一头一尾对不上，中间那一段在溢出的那个文件里。
    await writeFile(join(directory, 'result-17-abcdef12.json'), `${'前段。'.repeat(20)}那一段藏在中间${'后段。'.repeat(20)}\n`, 'utf8');

    assert.deepEqual(await searchSessions(directory, { query: '藏在中间' }), [], '跨会话那一种读的是记录本身，不翻溢出文件（U38）');

    const scoped = await searchSessions(directory, { query: '藏在中间', sessionId: 'deep' });
    assert.deepEqual(scoped.map((hit) => [hit.seq, hit.kind, hit.spilled]), [[1, 'tool', 'result-17-abcdef12.json']], '整段里那一处也认得出是哪一次结果');
    assert.match(scoped[0].text, /藏在中间/);
    assert.equal(scoped[0].name, '溢出那一份', '一份记录的名字读的是列表那一套折法');
    assert.deepEqual((await searchSessions(directory, { query: 'big.md', sessionId: 'deep' })).map((hit) => hit.seq), [1], '记录里对得上的那一段先交，一条事件只交一处');
    await assert.rejects(
      () => searchSessions(directory, { query: '任何文字', sessionId: 'nobody' }),
      (error) => error.code === 'session_not_found',
      '指名的一份不在记录目录里就说清',
    );
  });
});

test('a branch copies a prefix of the record and leaves the parent alone', async () => {
  await withSessions(async (root, directory) => {
    const parent = createSessionLog({ directory, id: 'parent', meta: () => ({ projectRoot: root }) });
    await parent.append({ kind: 'mode', name: 'full', layer: 'shipped', path: 'modes/full.toml', tools: ['read'], digest: 'aaa111' });
    await parent.append({ kind: 'user', text: '第一轮' });
    await parent.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: 1, iterations: 1, modelCalls: 1 });
    await parent.append({ kind: 'user', text: '第二轮还没结束' });
    await parent.append({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'write', args: { path: 'a' } }] });

    const whole = await branchSession(directory, 'parent', { projectRoot: root });
    const file = join(directory, `${whole.sessionId}.jsonl`);
    const copied = parseSessionBytes(await readFile(file));
    assert.deepEqual(copied.events.map((event) => [event.seq, event.kind]), [[0, 'mode'], [1, 'user'], [2, 'turn'], [3, 'user'], [4, 'assistant']],
      '整份复制带到此刻记录落到哪儿为止，序号接着父那一份连续');
    const header = JSON.parse((await readFile(file, 'utf8')).split('\n')[0]);
    assert.deepEqual([header.kind, header.branchOf, header.branchAt], ['session', 'parent', 4], '首行说得出这是谁的分支、停在哪儿');
    assert.equal(header.sessionId, whole.sessionId, '新的一份是自己的编号');
    assert.deepEqual(copied.header.mode, { name: 'full', layer: 'shipped' }, '继承那一份最后生效的模式清单');
    assert.deepEqual(findUnresolvedCalls(copied.events).map((call) => call.callId), ['c1'],
      '没配上的那一次派发原样复制过来，补它的是打开这一份的那一条路，不在父侧动盘（D72）');

    const early = await branchSession(directory, 'parent', { at: 2, projectRoot: root });
    assert.equal(early.events, 3, '选一个完整轮次就复制到那一条标记为止');
    await assert.rejects(branchSession(directory, 'parent', { at: 3, projectRoot: root }),
      (error) => error.code === 'session_branch_point_unavailable', '那一条不是轮次标记就不猜一个分支点出来');

    await parent.append({ kind: 'user', text: '父后来又说了一句' });
    assert.equal(parseSessionBytes(await readFile(file)).events.length, 5, '复制过的那一份不跟着父长');

    // 没有首行的现存记录：第一条事件不是元信息，不能丢。
    await writeFile(join(directory, 'legacy.jsonl'), `${JSON.stringify({ seq: 0, kind: 'user', text: 'older' })}\n`, 'utf8');
    const legacy = await branchSession(directory, 'legacy', { projectRoot: root });
    assert.equal(parseSessionBytes(await readFile(join(directory, `${legacy.sessionId}.jsonl`))).events.length, 1);
    await assert.rejects(branchSession(directory, 'nobody', { projectRoot: root }), (error) => error.code === 'session_not_found');
  });
});

test('branching copies only complete lines when the parent has an incomplete crash tail', async () => {
  await withSessions(async (root, directory) => {
    const parent = createSessionLog({ directory, id: 'parent', meta: () => ({ projectRoot: root }) });
    await parent.append({ kind: 'user', text: 'request' });
    await parent.append({ kind: 'assistant', text: 'response', toolCalls: [] });
    await parent.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: 0 });
    await parent.close();
    const path = join(directory, 'parent.jsonl');
    await appendFile(path, '{"kind":"user","text":"unfinished');
    const original = await readFile(path);
    const complete = parseSessionBytes(original);
    assert.ok(complete.truncatedBytes > 0);
    for (const at of [undefined, 2]) {
      const branch = await branchSession(directory, 'parent', { at, projectRoot: root });
      const copied = parseSessionBytes(await readFile(join(directory, `${branch.sessionId}.jsonl`)));
      assert.equal(branch.at, 2);
      assert.deepEqual(copied.events, complete.events);
      assert.equal(copied.truncatedBytes, 0);
      assert.deepEqual(await readFile(path), original);
    }
  });
});

// 分支携带完全落在复制前缀内的压缩块；跨越分支点的块不携带，父侧的块文件保持不变。
test('a branch carries the compaction blocks that fit inside the copied prefix', async () => {
  await withSessions(async (root, directory) => {
    const parent = createSessionLog({ directory, id: 'parent', meta: () => ({ projectRoot: root }) });
    await parent.append({ kind: 'user', text: '第一轮' });
    await parent.append({ kind: 'assistant', text: '答了', toolCalls: [] });
    await parent.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: 0, iterations: 1, modelCalls: 1 });
    await parent.append({ kind: 'user', text: '第二轮' });
    const events = await parent.read();
    const block = createBlock({ events: events.filter((event) => event.seq <= 1), text: '第一块的摘要', fromSeq: 0, toSeq: 1, blockId: 1 });
    await writeCheckpointFile(directory, 'parent', createCheckpointFile({ id: 'parent', blocks: [block] }));

    const whole = await branchSession(directory, 'parent', { projectRoot: root });
    const branchLog = createSessionLog({ directory, id: whole.sessionId });
    const carried = await loadCheckpointFile({ directory, id: whole.sessionId, events: await branchLog.read() });
    assert.equal(carried.reason, '', '父侧的块按分支事件校验通过');
    assert.deepEqual(carried.blocks, [block]);
    assert.equal((await branchLog.modelView())[0].text, '第一块的摘要', '分支投影里摘要仍然代表被压过的那一段');
    assert.equal((await loadCheckpointFile({ directory, id: 'parent', events })).blocks.length, 1, '父侧的块文件没有动');

    // 块覆盖到分支点之后：整块不携带，分支从全量事件投影。
    const wide = createBlock({ events: events.filter((event) => event.seq <= 3), text: '跨过分支点的摘要', fromSeq: 0, toSeq: 3, blockId: 1 });
    await writeCheckpointFile(directory, 'parent', createCheckpointFile({ id: 'parent', blocks: [wide] }));
    const early = await branchSession(directory, 'parent', { at: 2, projectRoot: root });
    const earlyLog = createSessionLog({ directory, id: early.sessionId });
    const dropped = await loadCheckpointFile({ directory, id: early.sessionId, events: await earlyLog.read() });
    assert.equal(dropped.reason, 'checkpoint_absent', '没有携带任何块');
    assert.deepEqual((await earlyLog.modelView()).map((row) => row.text), ['第一轮', '答了'], 'turn 标记不进投影，被跨过的块也不代表任何事件');
  });
});

test('a resume takes the mode the session last ran under, and a changed list is a refusal', async () => {
  const full = { name: 'full', layer: 'shipped', path: 'modes/full.toml', tools: '*', prompt: '*', digest: await digestOf('full') };

  assert.equal(chooseResumeMode({ explicit: 'minimal', recorded: { name: 'full', digest: 'stale' }, loaded: full, fallback: 'minimal' }), 'minimal',
    '--mode 写了就照它，比对不做');
  assert.equal(chooseResumeMode({ recorded: { name: 'full', digest: full.digest }, loaded: full, fallback: 'minimal' }), 'full',
    '同名同摘要：沿用那一份');
  assert.equal(chooseResumeMode({ fallback: 'minimal' }), 'minimal', '记录里从没生效过模式，就按配置与缺省来');
  // 老记录里的模式事件没有摘要这一格：无从比对，名字对得上就用。
  assert.equal(chooseResumeMode({ recorded: { name: 'full' }, loaded: full, fallback: 'minimal' }), 'full');
  assert.throws(
    () => chooseResumeMode({ recorded: { name: 'full', digest: 'old123' }, loaded: full, fallback: 'minimal' }),
    (error) => error.code === 'resume_mode_changed'
      && new RegExp(`was old123 in that session and is ${full.digest} on disk`).test(error.detail)
      && /name a mode explicitly to resume/.test(error.detail),
    '名字对得上而内容变了要报出来，不静默换成磁盘上那一份',
  );
});

const provider = {
  capabilities: MESSAGES_CAPABILITIES,
  model: 'test-model',
  async *stream() {
    yield { type: 'text', text: 'ok' };
  },
};

// 会话列表与恢复都由 Host 提供，客户端无需读取记录目录或计算模式清单。
async function withHost(root, run) {
  const config = createConfig({
    user: {
      boundary: root,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
    },
  });
  const pair = createMemoryConnectionPair();
  // 装配那一份带着 full：打开记录时换成哪一份，是宿主按那一份记录定的，不是这里给的这一个名字。
  const host = serveHost({
    input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy,
    modeName: 'full', modePaths: modeDirectories(root, shippedModes, join(root, 'home')),
  });
  const connection = createConnection(pair.client);
  try {
    return await run(connection, host);
  } finally {
    pair.client.output.end();
    await host.release();
  }
}

test('the host hands out the listing and resumes under the mode that record last ran', async () => {
  await withSessions(async (root, directory) => {
    const modePaths = modeDirectories(root, shippedModes, join(root, 'home'));
    const minimal = await loadMode('minimal', modePaths);
    const ran = createSessionLog({ directory, id: 'ran', meta: { projectRoot: root } });
    await ran.append({ kind: 'mode', name: 'minimal', layer: 'shipped', path: minimal.path, tools: minimal.tools, digest: minimal.digest });
    await ran.append({ kind: 'user', text: 'go' });
    // 那一份 TOML 在跑过之后被人改过一个字：记录里的摘要与磁盘上的对不上。
    const moved = createSessionLog({ directory, id: 'moved', meta: { projectRoot: root } });
    await moved.append({ kind: 'mode', name: 'minimal', layer: 'shipped', path: minimal.path, tools: minimal.tools, digest: 'stale111' });
    await moved.append({ kind: 'user', text: 'go' });

    await withHost(root, async (connection) => {
      const listed = await connection.request('sessions.list', {});
      assert.deepEqual(listed.sessions.map((item) => item.id).sort(), ['moved', 'ran'], '两份都在，界面不用自己扫那一份目录');
      assert.equal(listed.sessions.every((item) => item.mode?.name === 'minimal'), true, '列表里带着各自最后生效的那一份模式清单');
      assert.equal((await connection.request('sessions.list', { projectRoot: root })).sessions.length, 2, '按项目根过滤留下这个根下的那两份');
      assert.deepEqual((await connection.request('sessions.list', { projectRoot: 'nowhere' })).sessions, []);
      assert.equal((await connection.request('sessions.list', { limit: 1 })).sessions.length, 1);
      await assert.rejects(connection.request('sessions.list', { limit: 0 }), (error) => error.code === 'protocol_args_invalid',
        '条数写 0 是自己跟自己矛盾，不接');

      // 即使 Host 当前使用 `full`，恢复时仍应采用记录中最后生效的 `minimal` 模式。
      await connection.request('session.open', { sessionId: 'ran' });
      assert.equal((await connection.request('status.get', { sessionId: 'ran' })).mode, 'minimal');
      // 摘要变了要在这里报出来，让客户端指名一份再来——不静默换成磁盘上现在那一份，也不静默退回缺省。
      await assert.rejects(connection.request('session.open', { sessionId: 'moved' }),
        (error) => error.code === 'resume_mode_changed' && /name a mode explicitly to resume/.test(error.detail));
    });

    // 客户端指名了一份就照那一份，记录里那条不再比对。
    await withHost(root, async (connection) => {
      await connection.request('session.open', { sessionId: 'ran', mode: 'full' });
      assert.equal((await connection.request('status.get', { sessionId: 'ran' })).mode, 'full');
    });
  });
});

test('the listing reports a crash tail without changing it or blocking another session', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    const other = (await client.request('session.create', {})).sessionId;
    await client.request('run.start', { sessionId, input: 'first session' });
    await client.request('run.start', { sessionId: other, input: 'other session' });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    await appendFile(path, '{"kind":"user"');
    const before = await readFile(path);

    const listed = await client.request('sessions.list', {});
    assert.deepEqual(new Set(listed.sessions.map((item) => item.id)), new Set([sessionId, other]));
    assert.equal(listed.sessions.find((item) => item.id === sessionId).truncatedBytes, Buffer.byteLength('{"kind":"user"'));
    assert.deepEqual(await readFile(path), before);
  });
});

test('one Host preserves A, B, then A session state', async () => {
  await withTuiHost(async ({ client, sessionId: sessionA }) => {
    await client.request('mode.set', { sessionId: sessionA, name: 'full' });
    assert.equal((await client.request('status.get', { sessionId: sessionA })).mode, 'full');
    const sessionB = (await client.request('session.create', {})).sessionId;
    await client.request('run.start', { sessionId: sessionA, input: 'A first' });
    const beforeSwitch = await client.request('status.get', { sessionId: sessionA });
    await client.request('run.start', { sessionId: sessionB, input: 'B only' });
    await client.request('mode.set', { sessionId: sessionB, name: 'full' });
    await client.request('session.open', { sessionId: sessionA, mode: 'minimal' });
    const afterSwitch = await client.request('status.get', { sessionId: sessionA });
    assert.equal(afterSwitch.eventCount, beforeSwitch.eventCount + 1, '显式选定模式只给这份会话增加一条 mode 事件');
    assert.equal(afterSwitch.mode, 'minimal');
    await client.request('run.start', { sessionId: sessionA, input: 'A again' });
    const { events } = await client.request('session.read', { sessionId: sessionA });
    assert.deepEqual(events.filter((event) => event.kind === 'user').map((event) => event.text), ['A first', 'A again']);
  });
});

// 列表索引是可重建缓存：命中时复用解析结果，文件变化或索引损坏时逐条重建，旧目录不写索引。
test('the listing index caches parsed summaries and rebuilds on change', async () => {
  await withSessions(async (root, directory) => {
    const first = createSessionLog({ directory, id: 'indexed-a', meta: () => ({ projectRoot: root }) });
    await first.append({ kind: 'user', text: '第一句' });
    await first.append({ kind: 'assistant', text: '答', toolCalls: [] });

    const plain = await listSessions(directory);
    const indexed = await listSessions(directory, { index: true });
    assert.deepEqual(indexed, plain, '带索引的列表与直读结果一致');
    assert.ok(await readFile(join(directory, 'index.json'), 'utf8'), '索引文件落在记录目录里');

    // 再次列表命中缓存；记录追加后按大小失效并重建。
    await first.append({ kind: 'user', text: '第二句' });
    const refreshed = await listSessions(directory, { index: true });
    assert.equal(refreshed.find((item) => item.id === 'indexed-a').events, 3, '追加后的事件数如实反映');

    // 索引损坏不挡列表：整体丢弃重建。
    await writeFile(join(directory, 'index.json'), '{', 'utf8');
    const rebuilt = await listSessions(directory, { index: true });
    assert.equal(rebuilt.find((item) => item.id === 'indexed-a').events, 3);

    // 记录删除后条目随之消失。
    await rm(join(directory, 'indexed-a.jsonl'));
    const afterDelete = await listSessions(directory, { index: true });
    assert.equal(afterDelete.length, plain.length - 1, '删除的记录不再出现');
  });
});

// UNC 工作区目录名决定旧记录能否被发现：沿用替换前正则的切分口径，防止标签悄悄变化。
test('UNC workspace directories keep the established label shape', { skip: process.platform !== 'win32' }, () => {
  const backslash = String.fromCharCode(92);
  const labels = [
    [`${backslash}${backslash}server${backslash}share`, 'unc--server-share'],
    [`${backslash}${backslash}server/share`, 'unc--server-share'],
    [`${backslash}${backslash}server${backslash}share${backslash}dir`, 'unc--server-share-dir'],
    [`${backslash}${backslash}server${backslash}share${backslash}dir${backslash}`, 'unc--server-share-dir'],
    [`${backslash}${backslash}a/b `, 'unc--a-b-'],
    // 其余部分不允许出现换行（旧 `$` 只匹配输入末尾），退回普通标签。
    [`${backslash}${backslash}a/b\n`, 'root-a-b-'],
  ];
  for (const [identity, label] of labels) {
    const leaf = basename(workspaceDataDirectory({ userHome: join('C:', 'home'), workspaceRoot: identity }));
    // 叶子目录是 `<label>--<16 位摘要>`。
    assert.equal(leaf.slice(0, leaf.length - 18), label, identity);
  }
});

// 单独的切分函数保留旧正则的回溯结果：host 是最长的无反斜杠前缀。
test('UNC identities split exactly like the replaced pattern', () => {
  const backslash = String.fromCharCode(92);
  const splits = [
    [`${backslash}${backslash}a//b`, { host: 'a/', rest: 'b' }],
    [`${backslash}${backslash}a${backslash}b`, { host: 'a', rest: 'b' }],
    [`${backslash}${backslash}a/b `, { host: 'a', rest: 'b ' }],
    [`${backslash}${backslash}a${backslash}${backslash}b`, { host: 'a', rest: `${backslash}b` }],
    [`${backslash}${backslash}/a/B///${backslash}`, { host: '/a/B//', rest: backslash }],
  ];
  for (const [identity, expected] of splits) assert.deepEqual(splitUncIdentity(identity), expected, identity);
  // 没有分隔符、没有 host、其余部分带换行都不是可切分的 UNC 身份。
  for (const identity of [`${backslash}${backslash}a`, `${backslash}${backslash}a${backslash}`, `${backslash}${backslash}a/b\n`, `a${backslash}b`, `/${backslash}${backslash}a`]) {
    assert.equal(splitUncIdentity(identity), undefined, identity);
  }
});

// 跨目录列表只在当前工作区目录写索引；旧目录保持只读发现。
test('workspace listing writes the index only into the primary directory', async () => {
  await withSessions(async (root, directory) => {
    // withSessions 的记录目录本身就是旧式布局；主目录按当前规则另建。
    const primary = sessionDirectory({ boundary: root });
    await mkdir(primary, { recursive: true });
    const session = createSessionLog({ directory, id: 'legacy-one', meta: () => ({ projectRoot: root }) });
    await session.append({ kind: 'user', text: '旧记录' });
    const current = createSessionLog({ directory: primary, id: 'current-one', meta: () => ({ projectRoot: root }) });
    await current.append({ kind: 'user', text: '新记录' });

    const listed = await listWorkspaceSessions({ boundary: root }, { projectRoot: root });
    assert.deepEqual(listed.map((item) => item.id).sort(), ['current-one', 'legacy-one']);
    assert.ok(await readFile(join(primary, 'index.json'), 'utf8'), '当前目录有索引');
    await assert.rejects(readFile(join(directory, 'index.json')), /ENOENT/, '旧目录不写索引');
  });
});
