// 上下文压缩工具：模型查看压力与块、读回原文，并自选范围撰写摘要。
// 压缩只改投影：原始事件、块文件与压缩事件全部留在记录里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCompactTool,
  createCompaction,
  createConfig,
  createKernel,
  createSessionLog,
  loadCheckpointFile,
} from '../dist/index.js';

function hasCode(error: unknown, code: string): error is { code: string; detail: string } {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

const limits = { contextTokens: 100_000, compactThresholdRatio: 0.8, compactRetainRatio: 0.16, resultBytes: 16_000 };
const fakeProvider = {
  model: 'fake',
  capabilities: {},
  async *stream() {
    yield { type: 'text' as const, text: 'unused' };
  },
};

// 一段带完整轮次的历史：0 用户提问，1 助手发起两次调用，2-3 结果，4 助手收尾，5 轮次完成，6 当前轮输入。
type SeededContext = {
  directory: string;
  id: string;
  session: ReturnType<typeof createSessionLog>;
  compaction: ReturnType<typeof createCompaction>;
  tool: ReturnType<typeof createCompactTool>;
};

async function seededSession<TResult>(run: (context: SeededContext) => TResult | Promise<TResult>): Promise<TResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-compact-tool-'));
  const id = 'compact-tool-session';
  const session = createSessionLog({ directory, id });
  await session.append({ kind: 'user', text: '第一轮的问题，路径 E:\\repo\\note.txt' });
  await session.append({ kind: 'assistant', text: '查两处', toolCalls: [
    { id: 'c1', name: 'read', args: { path: 'a' } },
    { id: 'c2', name: 'read', args: { path: 'b' } },
  ] });
  await session.append({ kind: 'tool', tool: 'read', callId: 'c1', args: { path: 'a' }, result: { kind: 'result', failed: false, content: '甲的结果' } });
  await session.append({ kind: 'tool', tool: 'read', callId: 'c2', args: { path: 'b' }, result: { kind: 'result', failed: false, content: '乙的结果' } });
  await session.append({ kind: 'assistant', text: '第一轮答完', toolCalls: [] });
  await session.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: 0, iterations: 1, modelCalls: 1 });
  await session.append({ kind: 'user', text: '当前轮的问题' });
  const compaction = createCompaction({ provider: fakeProvider, session, directory, id, limits });
  const tool = createCompactTool({ compaction: () => compaction, session, directory, id });
  try {
    return await run({ directory, id, session, compaction, tool });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('status shows usage and the compressible range, and says when compaction is off', async () => {
  await seededSession(async ({ tool }) => {
    const off = createCompactTool({ compaction: () => null, session: { read: async () => [] }, directory: '.', id: 'x' });
    assert.match((await off.run({ action: 'status' }, { config: {} })).text, /no context window/);

    const status = (await tool.run({ action: 'status' }, { config: {} })).text;
    assert.match(status, /window 100000 tokens, threshold 80000/);
    assert.match(status, /compaction blocks: 0/);
    assert.match(status, /compressible range: events 0\.\.4/);
  });
});

test('compress takes the range and the summary the model wrote and replaces the projection', async () => {
  await seededSession(async ({ directory, id, session, tool }) => {
    const done = (await tool.run({ action: 'compress', toSeq: 4, summary: '第一轮问过 note.txt，读过 a 与 b，结论保留' }, { config: {} })).text;
    assert.match(done, /block 1 now covers events 0\.\.4/);

    const read = await loadCheckpointFile({ directory, id, events: await session.read() });
    assert.equal(read.blocks.length, 1);
    assert.equal(read.blocks[0].toSeq, 4);
    assert.equal((await session.modelView() as { text?: string }[])[0].text, '第一轮问过 note.txt，读过 a 与 b，结论保留', '投影里摘要顶替了被压区间');
    const written = (await session.read()).filter((event) => event.kind === 'compaction');
    assert.deepEqual(written.map((event) => [event.reason, event.blockId]), [['model', 1]], '压缩事件记录模型来源');

    const again = tool.run({ action: 'compress', fromSeq: 0, toSeq: 4, summary: '再来一次' }, { config: {} });
    await assert.rejects(
      again,
      (error) => hasCode(error, 'compact_range_invalid') && /already covered/.test(error.detail),
      '与已有块重叠的范围要被拒绝',
    );
  });
});

test('ranges that would break the record are refused with actionable errors', async () => {
  await seededSession(async ({ tool }) => {
    await assert.rejects(tool.run({ action: 'compress', toSeq: 6, summary: 's' }, { config: {} }),
      (error) => hasCode(error, 'compact_range_invalid') && /up to event 5/.test(error.detail), '不能压进当前轮');
    await assert.rejects(tool.run({ action: 'compress', toSeq: 5, summary: 's' }, { config: {} }),
      (error) => hasCode(error, 'compact_range_invalid') && /user or assistant/.test(error.detail), '结束边界要落在消息上');
    await assert.rejects(tool.run({ action: 'compress', toSeq: 1, summary: 's' }, { config: {} }),
      (error) => hasCode(error, 'compact_range_invalid') && /pair/.test(error.detail), '不能把调用和结果拆开');
    await assert.rejects(tool.run({ action: 'compress', toSeq: 3, summary: 's' }, { config: {} }),
      (error) => hasCode(error, 'compact_range_invalid') && /user or assistant/.test(error.detail), '停在工具结果上同样不行');
    await assert.rejects(tool.run({ action: 'compress', toSeq: 4, summary: '   ' }, { config: {} }),
      (error) => hasCode(error, 'compact_summary_required'), '摘要为空要说清');
    await assert.rejects(tool.run({ action: 'warp' }, { config: {} }),
      (error) => hasCode(error, 'compact_action_invalid'), '未知动作点名拒绝');
  });
});

test('a summary that would not shrink the projection is refused without writing', async () => {
  await seededSession(async ({ directory, id, session, tool }) => {
    const long = '很长的摘要'.repeat(4_000);
    const done = await tool.run({ action: 'compress', toSeq: 4, summary: long }, { config: {} });
    assert.match(done.text, /would not shrink/);
    assert.equal((await loadCheckpointFile({ directory, id, events: await session.read() })).reason, 'checkpoint_absent', '没有写块');
    assert.equal((await session.read()).some((event) => event.kind === 'compaction'), false, '也没有写事件');
  });
});

test('blocks lists summaries with their reasons and read returns the original transcript', async () => {
  await seededSession(async ({ tool }) => {
    await tool.run({ action: 'compress', toSeq: 4, summary: '第一轮的结论' }, { config: {} });
    const blocks = (await tool.run({ action: 'blocks' }, { config: {} })).text;
    assert.match(blocks, /block 1: events 0\.\.4, ~\d+ tokens, model/);
    assert.match(blocks, /第一轮的结论/);

    const read = (await tool.run({ action: 'read', blockId: 1 }, { config: {} })).text;
    assert.match(read, /user: 第一轮的问题/);
    assert.match(read, /tool read: 甲的结果/);
    assert.match(read, /assistant: 第一轮答完/);
    await assert.rejects(tool.run({ action: 'read', blockId: 9 }, { config: {} }),
      (error) => hasCode(error, 'compact_block_unknown'), '块号不存在给指引');
    await assert.rejects(tool.run({ action: 'read' }, { config: {} }),
      (error) => hasCode(error, 'compact_block_required'), '缺块号直接说');
  });
});

test('spill returns referenced overflow files and refuses any other name', async () => {
  await seededSession(async ({ tool }) => {
    await assert.rejects(tool.run({ action: 'spill', name: '../config.toml' }, { config: {} }),
      (error) => hasCode(error, 'compact_spill_name_invalid'), '目录外路径一律拒绝');
    await assert.rejects(tool.run({ action: 'spill', name: 'summary-0-5.txt' }, { config: {} }),
      (error) => hasCode(error, 'compact_spill_missing'), '命名合规但不存在也说清');
  });
});

test('a spilled tool result identifies compact and can be read in pages', async () => {
  await seededSession(async ({ directory, session, tool }) => {
    const kernel = createKernel({ config: createConfig({ user: { boundary: directory, limits: { resultBytes: 400 } } }), session });
    kernel.register(tool);
    const original = '中文 "+\\ page content '.repeat(150);
    kernel.register({ name: 'chatty', description: 'Produces a large result', access: 'read',
      parameters: { type: 'object', properties: {} }, run: async () => original });
    await kernel.call('chatty', {});
    const event = (await session.read()).findLast(item => item.kind === 'tool' && item.tool === 'chatty') as unknown as { result: { content: string; spilled: string } };
    assert.match(event.result.content, /read via compact: action=spill/);
    assert.match(event.result.content, new RegExp(event.result.spilled));
    let offsetBytes = 0;
    let recovered = '';
    for (;;) {
      const page = (await kernel.call('compact', { action: 'spill', name: event.result.spilled, offsetBytes }) as { text: string }).text;
      const recorded = (await session.read()).findLast(item => item.kind === 'tool' && item.tool === 'compact') as unknown as { result: { spilled?: string; content: unknown } };
      assert.equal(recorded.result.spilled, undefined, 'a page must not spill again');
      assert.deepEqual(recorded.result.content, { text: page });
      const marker = /\n\[truncated:.*continue with offsetBytes=(\d+)\]$/u.exec(page);
      recovered += marker ? page.slice(0, marker.index) : page;
      if (!marker) break;
      offsetBytes = Number(marker[1]);
    }
    assert.equal(recovered, original);
    assert.equal((await tool.run({ action: 'spill', name: event.result.spilled, offsetBytes: 100_000 }, { config: {} })).text, '');
    await assert.rejects(tool.run({ action: 'spill', name: event.result.spilled, offsetBytes: 1 }, { config: {} }),
      (error) => hasCode(error, 'compact_offset_invalid'));
  });
});

test('a summary over the byte cap spills to a file the spill action can return', async () => {
  await seededSession(async ({ directory, id, session, compaction, tool }) => {
    // 追加一段足够长的完整历史，让截断后的摘要仍小于被压区间，压缩才能通过净收缩闸。
    const long = 'y'.repeat(2000);
    for (let round = 0; round < 6; round += 1) {
      await session.append({ kind: 'user', text: `问题 ${round} ${long}` });
      await session.append({ kind: 'assistant', text: `答 ${round} ${long}`, toolCalls: [] });
    }
    await session.append({ kind: 'turn', ignorable: true, status: 'completed', userSeq: 0, iterations: 1, modelCalls: 1 });
    await session.append({ kind: 'user', text: '继续' });

    const summary = '超长摘要正文'.repeat(3_000);
    const local = createCompactTool({ compaction: () => compaction, session, directory, id });
    const done = await local.run({ action: 'compress', summary }, { config: { limits: { resultBytes: 2_000 } } });
    assert.match(done.text, /block 1 now covers/);
    // 摘要溢出文件名带内容短哈希；跨会话共用目录时同范围的不同摘要不再互相覆盖。
    // 哈希段是内容摘要，伪造的哈希名指向不存在的文件并被点名拒绝。
    await assert.rejects(
      local.run({ action: 'spill', name: 'summary-0-6-abcdef01.txt' }, { config: { limits: { resultBytes: 2_000 } } }),
      (error) => hasCode(error, 'compact_spill_missing'), '不存在的哈希名被拒绝',
    );
    await assert.rejects(
      local.run({ action: 'spill', name: 'summary-0-6-zzz.txt' }, { config: { limits: { resultBytes: 2_000 } } }),
      (error) => hasCode(error, 'compact_spill_name_invalid'), '非哈希段的名字不通过白名单',
    );
    // 从块文件直接取引用，验证完整链路：块 -> 引用 -> 溢出内容。
    const raw = JSON.parse(await readFile(join(directory, `${id}.checkpoint.json`), 'utf8')) as { blocks: { text: string }[] };
    const reference = /kept in (summary-\d+-\d+-[a-f0-9]{8}\.txt)\]/u.exec(raw.blocks[0].text);
    assert.ok(reference, `块摘要引用溢出文件: ${raw.blocks[0].text.slice(-120)}`);
    const back = (await local.run({ action: 'spill', name: reference[1] }, { config: { limits: { resultBytes: 2_000 } } })).text;
    assert.match(back, /超长摘要正文/);
  });
});
