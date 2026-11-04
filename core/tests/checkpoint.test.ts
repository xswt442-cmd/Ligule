// 压缩块是可重建的派生文件：范围和哈希匹配时用于投影，任一校验失败就回读原始日志。
// 块文件不会修改事件日志，因此测试比较读取到的投影内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHECKPOINT_FORMAT_VERSION,
  CHECKPOINT_INPUT_VERSION,
  checkpointPath,
  createBlock,
  createCheckpointFile,
  createSessionLog,
  loadCheckpointFile,
  prefixDigest,
  usableCheckpointFile,
  writeCheckpointFile,
} from '../dist/index.js';
import type { CheckpointFile } from '../dist/session/checkpoint.js';
import type { SessionEvent } from '../dist/session/format.js';

type CheckpointFixtureEvent = {
  kind: string;
  text?: string;
  toolCalls?: { id: string; name: string; args: { path: string } }[];
  tool?: string;
  callId?: string;
  args?: { path: string };
  result?: { kind: string; failed: boolean; content: { text: string } };
};

const EVENTS: CheckpointFixtureEvent[] = [
  { kind: 'user', text: '第一个问题' },
  { kind: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
  { kind: 'tool', tool: 'read', callId: 'call_1', args: { path: 'note.txt' }, result: { kind: 'result', failed: false, content: { text: 'the body' } } },
  { kind: 'user', text: '第二个问题' },
  { kind: 'assistant', text: '答完了' },
];

async function withRecord<TResult>(run: (context: {
  directory: string;
  id: string;
  session: ReturnType<typeof createSessionLog>;
  path: string;
}) => TResult | Promise<TResult>): Promise<TResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-checkpoint-'));
  const id = 'session-under-test';
  const session = createSessionLog({ directory, id });
  for (const event of EVENTS) await session.append(event);
  try {
    return await run({ directory, id, session, path: join(directory, `${id}.jsonl`) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const blockOver = (events: SessionEvent[], text: string, blockId: number, fromSeq: number, toSeq: number) => createBlock({
  events: events.filter((event) => event.seq >= fromSeq && event.seq <= toSeq),
  text,
  fromSeq,
  toSeq,
  blockId,
});

const write = (directory: string, id: string, file: CheckpointFile) => writeCheckpointFile(directory, id, file);

test('a block whose range and hash match takes that range out of the model view', async () => {
  await withRecord(async ({ directory, id, session, path }) => {
    const events = await session.read();
    const before = await readFile(path, 'utf8');
    await write(directory, id, createCheckpointFile({ id, blocks: [blockOver(events, '前几轮的话', 1, 0, 2)] }));

    const view = await session.modelView() as { role?: string; text?: string }[];
    assert.deepEqual(view[0], { role: 'user', text: '前几轮的话' }, 'the summary speaks for the covered range');
    assert.deepEqual(view.slice(1).map((row) => row.role), ['user', 'assistant'], 'events after the range stay as they are');
    assert.equal(await readFile(path, 'utf8'), before, 'the event log is not touched by the block file');
    assert.equal((await loadCheckpointFile({ directory, id, events })).reason, '');
  });
});

// 多个块各自代表一段历史；块之间的空档保持原始事件，两段摘要按顺序进入投影。
test('each block projects its own summary and the gap between blocks stays raw', async () => {
  await withRecord(async ({ directory, id, session }) => {
    const events = await session.read();
    const blocks = [blockOver(events, '第一段的摘要', 1, 0, 1), blockOver(events, '第二段的摘要', 2, 3, 3)];
    await write(directory, id, createCheckpointFile({ id, blocks }));

    const view = await session.modelView() as { role?: string; text?: string }[];
    assert.deepEqual(view.map((row) => row.role), ['user', 'tool', 'user', 'assistant']);
    assert.deepEqual(view[0], { role: 'user', text: '第一段的摘要' });
    assert.deepEqual(view[1], { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'the body' }, failed: false, code: undefined });
    assert.deepEqual(view[2], { role: 'user', text: '第二段的摘要' });
    assert.equal(view[3].text, '答完了');
    assert.equal((await loadCheckpointFile({ directory, id, events })).blocks.length, 2);
  });
});

// 版本 1 的旧检查点只有一个摘要；读取时折算为一个块，升级后不必重写旧文件。
test('a version 1 file still works as a single block', async () => {
  await withRecord(async ({ directory, id, session }) => {
    const events = await session.read();
    const legacy = {
      formatVersion: 1,
      inputVersion: CHECKPOINT_INPUT_VERSION,
      sessionId: id,
      fromSeq: 0,
      toSeq: 2,
      digest: prefixDigest(events.slice(0, 3)),
      text: '旧版那一份摘要',
    };
    await writeFile(checkpointPath(directory, id), JSON.stringify(legacy), 'utf8');

    const read = await loadCheckpointFile({ directory, id, events });
    assert.equal(read.reason, '');
    assert.deepEqual(read.blocks, [{ blockId: 1, fromSeq: 0, toSeq: 2, digest: legacy.digest, text: '旧版那一份摘要' }]);
    assert.equal((await session.modelView() as { text?: string }[])[0].text, '旧版那一份摘要');
  });
});

// 每种校验失败都应说明原因，并使用原始日志生成投影。
test('a block file that does not line up is void and the raw log projects as if it were never there', async () => {
  const file = (id: string, blocks: CheckpointFile['blocks']) => ({ formatVersion: CHECKPOINT_FORMAT_VERSION, inputVersion: CHECKPOINT_INPUT_VERSION, sessionId: id, blocks });
  const cases: [string, (base: ReturnType<typeof file>) => ReturnType<typeof file>][] = [
    ['checkpoint_blocks_empty', (base) => ({ ...base, blocks: [] })],
    ['checkpoint_range_shape', (base) => ({ ...base, blocks: [{ ...base.blocks[0], fromSeq: 3, toSeq: 1 }] })],
    ['checkpoint_range_missing', (base) => ({ ...base, blocks: [{ ...base.blocks[0], toSeq: 40 }] })],
    ['checkpoint_text_missing', (base) => ({ ...base, blocks: [{ ...base.blocks[0], text: '' }] })],
    ['checkpoint_digest_mismatch', (base) => ({ ...base, blocks: [{ ...base.blocks[0], digest: '0'.repeat(64) }] })],
    ['checkpoint_block_overlap', (base) => ({ ...base, blocks: [base.blocks[0], { ...base.blocks[0], blockId: 2, fromSeq: 1, toSeq: 3 }] })],
    ['checkpoint_block_ids', (base) => ({ ...base, blocks: [base.blocks[0], { ...base.blocks[0], blockId: 1, fromSeq: 3, toSeq: 3 }] })],
    ['checkpoint_format_version', (base) => ({ ...base, formatVersion: CHECKPOINT_FORMAT_VERSION + 1 })],
    ['checkpoint_input_version', (base) => ({ ...base, inputVersion: CHECKPOINT_INPUT_VERSION + 1 })],
    ['checkpoint_session_mismatch', (base) => ({ ...base, sessionId: 'another-session' })],
  ];
  await withRecord(async ({ directory, id, session, path }) => {
    const events = await session.read();
    const plain = await session.modelView();
    const base = file(id, [blockOver(events, '前几轮的话', 1, 0, 2)]);

    assert.equal((await loadCheckpointFile({ directory, id, events })).reason, 'checkpoint_absent');
    await writeFile(checkpointPath(directory, id), '{', 'utf8');
    assert.equal((await loadCheckpointFile({ directory, id, events })).reason, 'checkpoint_invalid_json');
    assert.deepEqual(await session.modelView(), plain, 'an unreadable file falls back to the raw log');

    for (const [reason, mutate] of cases) {
      await writeFile(checkpointPath(directory, id), JSON.stringify(mutate(base)), 'utf8');
      const read = await loadCheckpointFile({ directory, id, events });
      assert.equal(read.reason, reason, `${reason} is the named condition`);
      assert.equal(read.blocks.length, 0);
      assert.deepEqual(await session.modelView(), plain, `${reason} falls back to the raw log`);
    }

    // 修改范围内的事件后，哈希校验应失败，并继续从原始日志生成投影。
    await writeFile(checkpointPath(directory, id), JSON.stringify(base), 'utf8');
    const bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes.replace('第一个问题', '第一个问题改过'));
    const edited = await session.read();
    assert.equal((await loadCheckpointFile({ directory, id, events: edited })).reason, 'checkpoint_digest_mismatch');
    assert.ok(!(await session.modelView() as { text?: string }[]).some((row) => row.text === '前几轮的话'), 'the void blocks are not projected');
  });
});

// 块文件整体原子替换：再次写入不留下临时文件，也不保留旧内容。
test('rewriting the block file replaces it without leftovers', async () => {
  await withRecord(async ({ directory, id, session }) => {
    const events = await session.read();
    await write(directory, id, createCheckpointFile({ id, blocks: [blockOver(events, '第一段', 1, 0, 2)] }));
    await write(directory, id, createCheckpointFile({ id, blocks: [blockOver(events, '第一段', 1, 0, 2), blockOver(events, '第二段', 2, 3, 3)] }));

    const read = await loadCheckpointFile({ directory, id, events });
    assert.equal(read.blocks.length, 2);
    assert.deepEqual(await readdir(directory), [`${id}.checkpoint.json`, `${id}.jsonl`].sort(), 'no temporary file survives');
  });
});

// 哈希只覆盖重建投影所需的数据，不包含调用 ID、溢出文件名等传输字段。
test('the hash input leaves out transport identity and fields this build does not know', () => {
  const decorated = (token: string) => EVENTS.slice(0, 3).map((event, index) => ({
    ...event,
    hostNote: token,
    ...(index === 2 ? { result: { ...event.result, spilled: `result-${token}-abcdef01.json` } } : {}),
    ...(event.toolCalls === undefined ? {} : { toolCalls: event.toolCalls.map((call) => ({ ...call, id: `call-${token}` })) }),
  }));
  assert.equal(prefixDigest(decorated('one') as unknown as SessionEvent[]), prefixDigest(decorated('two') as unknown as SessionEvent[]), 'a different call id is the same history');

  // 添加未知外层字段后，块仍然有效，因为哈希只覆盖固定字段。
  const events = [
    { seq: 0, kind: 'user', text: 'one' },
    { seq: 1, kind: 'assistant', text: 'two', toolCalls: [] },
    { seq: 2, kind: 'user', text: 'three' },
  ];
  const block = createBlock({ events: events.slice(0, 2), text: '一份摘要', fromSeq: 0, toSeq: 1, blockId: 1 });
  const file = createCheckpointFile({ id: 'hash-input', blocks: [block] });
  const widened = events.map((event) => ({ ...event, thinkingTokens: 12, durationMs: 40 }));
  assert.deepEqual(usableCheckpointFile(file, 'hash-input', widened), { blocks: [block], reason: '' });
  assert.notEqual(prefixDigest(widened), prefixDigest(widened.map((event) => ({ ...event, text: `${event.text}.` }))), 'a real content change still moves the hash');
});

// `usage` 不参与哈希，也不会让投影事件的序号出现空缺：
// 写入用量事件后，原本有效的块仍应通过校验。
test('a usage event inside the covered range leaves the block alone', () => {
  const id = 'usage-in-range';
  const events = [
    { seq: 0, kind: 'user', text: 'one' },
    { seq: 1, kind: 'assistant', text: 'two', toolCalls: [] },
    { seq: 2, kind: 'usage', input: 400, output: 5, estimated: 120 },
    { seq: 3, kind: 'user', text: 'three' },
  ];
  const block = createBlock({ events: events.slice(0, 3), text: '一份摘要', fromSeq: 0, toSeq: 2, blockId: 1 });
  assert.equal(prefixDigest(events), prefixDigest(events.filter((event) => event.kind !== 'usage')), '用量那一格不参与输入');
  assert.deepEqual(usableCheckpointFile(createCheckpointFile({ id, blocks: [block] }), id, events), { blocks: [block], reason: '' }, '序号还是连着的，块照用');
  // 若把用量事件从序号范围中跳过，事件范围就会不连续，因此它必须计入已写入事件类型。
  assert.equal(usableCheckpointFile(createCheckpointFile({ id, blocks: [block] }), id, events.filter((event) => event.kind !== 'usage')).reason, 'checkpoint_range_missing');
});
