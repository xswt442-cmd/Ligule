import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionLog } from '../dist/session/session.js';
import { REVIEW_INSTRUCTION_CHARS, REVIEW_INSTRUCTION_LIMIT, recentReviewInstructions } from '../dist/host/review-instructions.js';

async function withSession(run: (log: ReturnType<typeof createSessionLog>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-review-instructions-'));
  try { await run(createSessionLog({ directory, id: 'instructions' })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('the reviewer sees every recent user constraint, not only the last one', async () => {
  await withSession(async (log) => {
    await log.append({ kind: 'user', text: '以后不要联网，只在这个目录里操作。' });
    await log.append({ kind: 'assistant', text: '好的。' });
    await log.append({ kind: 'user', text: '看看当前目录。' });
    const instructions = await recentReviewInstructions(log);
    // 早期约束必须还在：只传最后一条会让“不要联网”这类限制在复审时消失。
    assert.deepEqual(instructions, ['以后不要联网，只在这个目录里操作。', '看看当前目录。']);
  });
});

test('the review keeps the newest constraints and drops the oldest', async () => {
  await withSession(async (log) => {
    for (let index = 1; index <= REVIEW_INSTRUCTION_LIMIT + 2; index += 1) {
      await log.append({ kind: 'user', text: `第 ${index} 条指令` });
    }
    const instructions = await recentReviewInstructions(log);
    assert.equal(instructions?.length, REVIEW_INSTRUCTION_LIMIT);
    assert.equal(instructions?.[0], '第 3 条指令');
    assert.equal(instructions?.at(-1), `第 ${REVIEW_INSTRUCTION_LIMIT + 2} 条指令`);
  });
});

test('a single pasted instruction is truncated instead of eating the budget', async () => {
  await withSession(async (log) => {
    await log.append({ kind: 'user', text: 'x'.repeat(REVIEW_INSTRUCTION_CHARS + 500) });
    await log.append({ kind: 'user', text: '   ' });
    const instructions = await recentReviewInstructions(log);
    assert.equal(instructions?.length, 1, '空指令不算一条约束');
    assert.equal(instructions?.[0]?.length, REVIEW_INSTRUCTION_CHARS);
  });
});
