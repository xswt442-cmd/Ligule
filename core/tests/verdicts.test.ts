// 判定结果只写入会话记录，不进入模型投影或检查点哈希；汇总直接从记录计算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBlock,
  createCheckpointFile,
  createSessionLog,
  formatVerdicts,
  prefixDigest,
  summarizeVerdicts,
  usableCheckpointFile,
} from '../dist/index.js';
import type { SessionEvent } from '../dist/session/format.js';

const tool = (
  seq: number,
  name: string,
  verdict: Record<string, unknown>,
  result: Record<string, unknown> = { kind: 'result', failed: false, content: 'ok' },
): SessionEvent => ({ seq, kind: 'tool', tool: name, callId: `c${seq}`, args: {}, verdict, result });

const events: SessionEvent[] = [
  tool(0, 'read', { capability: 'read', decision: 'allow', via: 'auto', level: 'auto' }),
  tool(1, 'read', { capability: 'read', decision: 'allow', via: 'auto', level: 'auto' }),
  tool(2, 'exec', { capability: 'exec', decision: 'allow', via: 'ask', level: 'auto', answer: 'allow' }, { kind: 'result', failed: false, content: 'done' }),
  tool(3, 'exec', { capability: 'exec', decision: 'deny', via: 'rule', level: 'auto', rule: 'rm *' }, { kind: 'refusal', failed: true, code: 'policy_denied', reason: 'no', content: '' }),
  tool(4, 'exec', { capability: 'exec', decision: 'deny', via: 'ask', level: 'auto', forced: true, answer: 'deny' }, { kind: 'refusal', failed: true, code: 'ask_declined', reason: 'no', content: '' }),
  tool(5, 'call', { capability: 'mcp:fs/read_file', decision: 'allow', via: 'rules', level: 'ask', rule: 'mcp:fs/*' }),
  { seq: 6, kind: 'tool', tool: 'write', callId: 'c6', args: {}, result: { kind: 'result', failed: false, content: 'ok' } },
];

test('the summary counts three buckets per capability name, not per registered tool', () => {
  const counts = summarizeVerdicts(events);
  assert.deepEqual(counts.map((item) => item.capability), ['exec', 'mcp:fs/read_file', 'read']);
  const exec = counts.find((item) => item.capability === 'exec')!;
  assert.deepEqual(
    { auto: exec.auto, asked: exec.asked, allowed: exec.allowed, denied: exec.denied },
    { auto: 0, asked: 1, allowed: 1, denied: 2 },
  );
  assert.deepEqual(exec.codes, { policy_denied: 1, ask_declined: 1 });
  assert.deepEqual(exec.rules, { 'rm *': 1 });
  // 连续拒绝达到阈值后转为逐次询问，并在记录中标明该决策来源。
  assert.deepEqual(exec.levels, { auto: 2, 'auto→ask': 1 });
  // 没有判定链的那一次调用不在这份汇总里：那一格没有，就不猜。
  assert.equal(counts.some((item) => item.capability === 'write'), false);
});

test('the printed lines are the same numbers as the structured ones', () => {
  const lines = formatVerdicts(summarizeVerdicts(events));
  assert.match(lines[0], /^exec  自动 0  问过 1  没让做 2  档位 auto×2 auto→ask×1  命中规则 "rm \*"×1  码 policy_denied×1 ask_declined×1$/);
  assert.match(lines[2], /^read  自动 2  问过 0  没让做 0  档位 auto×2$/);
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeVerdicts(events)))[1].capability, 'mcp:fs/read_file');
});

// 判定摘要仅供界面和排错使用，不改变模型输入或检查点哈希。
test('the verdict stays out of the model view and out of the checkpoint hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-verdicts-'));
  const id = 'verdicts-session';
  const withVerdicts = createSessionLog({ directory, id });
  const plain = createSessionLog({ directory, id: `${id}-plain` });
  try {
    for (const event of events.filter((event) => event.seq < 4)) {
      await withVerdicts.append(event);
      const { verdict, ...rest } = event;
      await plain.append(rest);
    }
    assert.deepEqual(await withVerdicts.modelView(), await plain.modelView(), 'the projection does not read the verdict field');

    const recorded = await withVerdicts.read();
    const block = createBlock({ events: recorded.slice(0, 3), text: '一段摘要', fromSeq: 0, toSeq: 2, blockId: 1 });
    const file = createCheckpointFile({ id, blocks: [block] });
    assert.deepEqual(usableCheckpointFile(file, id, await plain.read()), { blocks: [block], reason: '' });
    assert.equal(prefixDigest(recorded.slice(0, 3)), prefixDigest((await plain.read()).slice(0, 3)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 连续拒绝确实把 auto 收紧为 ask；none/never/ask 本来就不发生档位变化。
test('a forced ask reports only a real policy level change', () => {
  const levels = (level: string) => summarizeVerdicts([
    tool(0, 'exec', { capability: 'exec', decision: 'deny', via: 'ask', level, forced: true, answer: 'deny' }, { kind: 'refusal', failed: true, code: 'policy_denied', reason: 'no', content: '' }),
  ])[0].levels;
  assert.deepEqual(levels('none'), { none: 1 });
  assert.deepEqual(levels('never'), { never: 1 });
  assert.deepEqual(levels('ask'), { ask: 1 });
  assert.deepEqual(levels('auto'), { 'auto→ask': 1 });
});

test('a hard denial does not report a policy level change', () => {
  const result = summarizeVerdicts([
    tool(0, 'exec', { capability: 'exec', decision: 'deny', via: 'hard-deny', level: 'auto', forced: true }, { kind: 'refusal', failed: true, code: 'policy_hard_denied', reason: 'no', content: '' }),
  ]);
  assert.deepEqual(result[0].levels, { auto: 1 });
});
