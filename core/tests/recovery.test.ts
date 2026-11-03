// 恢复时将崩溃前未完成的工具调用补成规范结果；只读检查不写入，恢复操作可重复执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRepairEvents, createConnection, createConfig, createKernel, createMemoryConnectionPair, createPermissionContext, createSessionLog, createTool,
  findUnresolvedCalls, providerFromConfig, repairUnresolvedCalls, serveHost, sessionDirectory,
} from '../dist/index.js';
import type { HostOptions } from '../dist/host/host.js';
import type { ModelMessage } from '../dist/kernel/loop.js';
import type { SessionEvent } from '../dist/session/format.js';
import { prefixDigest } from '../dist/session/checkpoint.js';
import { branchSession } from '../dist/session/branch.js';
import { assertAllAnswered } from '../dist/model/http.js';
await mkdir(join(process.cwd(), 'testplace', 'tmp'), { recursive: true });

type RepairFields = {
  kind?: string;
  callId?: string;
  result: { code?: string; content: string; failed?: boolean };
  recovery: { assistantSeq: number; safeToRedo: boolean };
};

type SessionReadEvent = {
  seq: number;
  kind?: string;
  status?: string;
  code?: string;
  userSeq?: number;
  callId?: string;
  result?: { code?: string };
  recovery: { safeToRedo: boolean };
};

type DirectoryConfig = { boundary: string; workspaceRoot?: string; userHome?: string };

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

const READ_ONLY = new Set(['read']);
const dispatched = (seq: number, id: string, name: string, args: Record<string, unknown>) => ({ seq, kind: 'assistant', text: '', toolCalls: [{ id, name, args }] });

test('a reused call ID cannot use an earlier turn result to hide a pending call', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'tmp', 'reused-call-'));
  const session = createSessionLog({ directory: join(root, 'sessions'), id: 'reused' });
  try {
    await session.acquire();
    const first = await session.append({ kind: 'user', text: 'first' });
    const firstArgs = { path: 'first.txt', content: 'first' };
    await session.append(dispatched(1, 'call_1', 'create', firstArgs));
    const permission = createPermissionContext('workspace-write', 'disabled', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), permission, session });
    kernel.register(createTool);
    await kernel.call('create', firstArgs, { callId: 'call_1' });
    await session.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: first.seq });
    await session.append({ kind: 'user', text: 'second' });
    const secondArgs = { path: 'second.txt', content: 'second' };
    const pending = await session.append(dispatched(5, 'call_1', 'create', secondArgs));
    const awaitedView = await session.modelView();
    assert.throws(() => assertAllAnswered(awaitedView as ModelMessage[]), { code: 'provider_unanswered_call' });
    assert.deepEqual(findUnresolvedCalls(await session.read()), [{ tool: 'create', callId: 'call_1', args: secondArgs, assistantSeq: pending.seq }]);
    const repaired = await repairUnresolvedCalls(session, { readOnly: new Set<string>() }) as (SessionEvent & RepairFields)[];
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0].result.code, 'tool_outcome_unknown');
    assert.equal(repaired[0].recovery.assistantSeq, pending.seq);
    const repairedView = await session.modelView();
    assert.doesNotThrow(() => assertAllAnswered(repairedView as ModelMessage[]));
    assert.deepEqual(await repairUnresolvedCalls(session, { readOnly: new Set<string>() }), []);
    assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first');
    await assert.rejects(readFile(join(root, 'second.txt')), { code: 'ENOENT' });
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an assistant turn whose call never got a result is the only thing left open', () => {
  const events = [
    { seq: 0, kind: 'user', text: 'go' },
    dispatched(1, 'a', 'exec', { command: 'make' }),
    { seq: 2, kind: 'tool', tool: 'exec', callId: 'a', result: { content: 'ok' } },
    dispatched(3, 'b', 'read', { path: 'x' }),
    { seq: 4, kind: 'tool', tool: 'mcp.call', callId: 'c', result: { content: 'other call' } },
  ];
  assert.deepEqual(findUnresolvedCalls(events), [{ tool: 'read', callId: 'b', args: { path: 'x' }, assistantSeq: 3 }],
    '有结果的那一次不算开放，别的调用 id 的结果也不算对上');
  const [repaired] = buildRepairEvents(findUnresolvedCalls(events), { readOnly: READ_ONLY }) as RepairFields[];
  assert.equal(repaired.kind, 'tool');
  assert.equal(repaired.callId, 'b');
  assert.equal(repaired.result.failed, true);
  assert.equal(repaired.result.code, 'tool_outcome_unknown');
  assert.deepEqual(repaired.recovery, { assistantSeq: 3, safeToRedo: true });
  // 措辞按这一件工具改不改本机之外的东西分开：只读的说「需要就重跑」，可能改了外部状态的说「先看现状，别盲目重试」。
  assert.match(repaired.result.content, /does not change anything on this machine/);
  const [mayHaveLanded] = buildRepairEvents([{ tool: 'exec', callId: 'b', args: {}, assistantSeq: 3 }], { readOnly: READ_ONLY }) as RepairFields[];
  assert.match(mayHaveLanded.result.content, /may or may not have happened/);
  assert.match(mayHaveLanded.result.content, /read the current state first/);
});

test('reopening a record repairs it once, and reading it changes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-recovery-'));
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = join(root, 'data');
  const directory = join(process.env.LIGULE_HOME!, 'sessions');
  try {
    const log = createSessionLog({ directory, id: 'crashed', meta: { projectRoot: root } });
    const user = await log.append({ kind: 'user', text: 'build it' });
    await log.append({ kind: 'turnContext', ignorable: true, userSeq: user.seq, model: 'm' });
    await log.append(dispatched(2, 'call_x', 'exec', { command: 'make' }));

    // `session.read` 只报告未完成的调用，不修改会话文件。
    const before = await readFile(join(directory, 'crashed.jsonl'), 'utf8');
    assert.equal((await createSessionLog({ directory, id: 'crashed' }).read()).length, 3);
    assert.equal(await readFile(join(directory, 'crashed.jsonl'), 'utf8'), before, '读一遍没有改动这份记录');

    const config = createConfig({
      user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'm' }, policy: { mode: 'ask' } },
    });
    const pair = createMemoryConnectionPair();
    const host = serveHost({ ...pair.host, config, provider: providerFromConfig(config), policy: config.policy as HostOptions['policy'] });
    const client = createConnection(pair.client);
    const { events } = (await client.request('session.open', { sessionId: 'crashed' }).then(() => client.request('session.read', { sessionId: 'crashed' }))) as { events: SessionReadEvent[] };
    await (host as { close?: () => Promise<void> }).close?.();

    const repaired = events.find((event) => event.result?.code === 'tool_outcome_unknown');
    assert.ok(repaired, '可写的恢复路径把那次派发补成了一条结果');
    assert.equal(repaired.callId, 'call_x');
    assert.equal(repaired.recovery.safeToRedo, false, 'exec 没声明只读，所以那句话是「先看现状」');
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2, 3, 4], '工具结果与轮次终态依次接在记录末尾');
    const turns = events.filter((event) => event.kind === 'turn');
    assert.deepEqual(turns.map(({ status, code, userSeq }) => ({ status, code, userSeq })), [
      { status: 'interrupted', code: 'host_restarted', userSeq: user.seq },
    ]);
    const relocated = await readFile(join(sessionDirectory(config as DirectoryConfig), 'crashed.jsonl'), 'utf8');
    assert.equal(relocated.trim().split('\n').length, 6, '新工作区副本包含首行、原有事件、工具结果与中断终态');
    assert.equal(await readFile(join(directory, 'crashed.jsonl'), 'utf8'), before, '旧共享记录作为迁移来源保持不变');
  } finally {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('a second repair pass adds nothing because the calls are answered now', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-repair-'));
  try {
    const session = createSessionLog({ directory: root, id: 'twice' });
    const user = await session.append({ kind: 'user', text: 'go' });
    await session.append({ kind: 'turnContext', ignorable: true, userSeq: user.seq, model: 'm' });
    await session.append(dispatched(2, 'x', 'exec', { command: 'make' }));
    assert.equal((await repairUnresolvedCalls(session, { readOnly: new Set<string>() })).length, 1);
    assert.equal((await repairUnresolvedCalls(createSessionLog({ directory: root, id: 'twice' }), { readOnly: new Set<string>() })).length, 0,
      '再扫一次：那些调用已经有结果了，一条都不补');
    const lines = (await readFile(join(root, 'twice.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { kind?: string; status?: string });
    assert.deepEqual(lines.map((line) => line.kind), ['session', 'user', 'turnContext', 'assistant', 'tool', 'turn']);
    assert.equal(lines.at(-1)!.status, 'interrupted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('turn recovery uses input evidence, keeps legacy completed turns, and does not invent input', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'tmp', 'ligule-turn-recovery-'));
  try {
    const pending = createSessionLog({ directory: root, id: 'pending' });
    const user = await pending.append({ kind: 'user', text: 'not yet answered' });
    const digest = prefixDigest(await pending.read());
    const appended = await repairUnresolvedCalls(pending, { readOnly: READ_ONLY });
    assert.deepEqual(appended, []);
    const interrupted = (await pending.read()).filter((event) => event.kind === 'turn');
    assert.equal(interrupted.length, 1);
    assert.equal(prefixDigest(await pending.read()), digest, '终态不改变检查点哈希输入');
    await assert.rejects(branchSession(root, 'pending', { at: interrupted[0].seq }), error => hasCode(error, 'session_branch_point_unavailable'));
    assert.deepEqual(
      { status: interrupted[0].status, code: interrupted[0].code, userSeq: interrupted[0].userSeq },
      { status: 'interrupted', code: 'host_restarted', userSeq: user.seq },
    );
    await assert.doesNotReject(() => repairUnresolvedCalls(pending, { readOnly: READ_ONLY }));
    assert.equal((await pending.read()).filter((event) => event.kind === 'turn').length, 1, '重复恢复不重复写终态');

    const legacy = createSessionLog({ directory: root, id: 'legacy' });
    const legacyUser = await legacy.append({ kind: 'user', text: 'already answered' });
    await legacy.append({ kind: 'turnContext', ignorable: true, userSeq: legacyUser.seq, model: 'm' });
    await legacy.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: legacyUser.seq });
    await repairUnresolvedCalls(legacy, { readOnly: READ_ONLY });
    assert.equal((await legacy.read()).filter((event) => event.kind === 'turn').length, 1, '旧 completed 事件无需新 code 字段');

    const preMarker = createSessionLog({ directory: root, id: 'pre-marker' });
    await preMarker.append({ kind: 'user', text: 'old completed input' });
    await preMarker.append({ kind: 'assistant', text: 'old completed answer', toolCalls: [] });
    await repairUnresolvedCalls(preMarker, { readOnly: READ_ONLY });
    assert.equal((await preMarker.read()).some((event) => event.kind === 'turn'), false, '旧记录中已有助手答复的输入不猜成中断');

    const empty = createSessionLog({ directory: root, id: 'not-started' });
    await repairUnresolvedCalls(empty, { readOnly: READ_ONLY });
    assert.equal((await empty.read()).some((event) => event.kind === 'turn'), false, '没有用户输入时不补中断轮次');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
