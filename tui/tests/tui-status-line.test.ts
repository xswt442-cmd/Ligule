import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRunBudgetSegment, buildStatusLine, contextSegment } from '../dist/tui/status-line.js';
import { displayWidth } from '../dist/tui/commands.js';

const task = {
  modelCalls: 2,
  maxModelCalls: 8,
  timeoutMs: 600_000,
  interactionWaitMs: 30_000,
  interactionWaitTimeoutMs: 120_000,
  executionElapsedMs: 90_000,
  executionPaused: false,
};

test('budget segment stays empty while idle and summarises a running task', () => {
  assert.equal(activeRunBudgetSegment(null), '');
  assert.equal(activeRunBudgetSegment({ running: false }), '');
  const running = activeRunBudgetSegment({ running: true, progress: { phase: 'tool_execution', lastProgressAt: 0, modelCalls: 2, task } });
  assert.match(running, /Run 模型调用 2\/8/u);
  assert.match(running, /执行剩余 8分30秒/u);
  assert.match(running, /累计交互等待 30秒\/2分/u);
  assert.doesNotMatch(running, /暂停/u);
});

test('budget segment explains missing or malformed budgets instead of throwing', () => {
  assert.match(activeRunBudgetSegment({ running: true, progress: { phase: 'preparing', lastProgressAt: 0, modelCalls: 3 } }), /Run 预算准备中/u);
  assert.match(activeRunBudgetSegment({ running: true, task: { ...task, maxModelCalls: 0 } }), /Run 预算信息暂不可用/u);
  assert.match(activeRunBudgetSegment({ running: true, task: { ...task, executionPaused: true, timeoutMs: 1000, executionElapsedMs: 500 } }), /执行期限已暂停/u);
});

test('context segment only renders usage and flags over-limit', () => {
  assert.equal(contextSegment(null), '');
  assert.equal(contextSegment({ estimated: 10, window: 100, threshold: 50 }), 'ctx:~10/100');
  assert.equal(contextSegment({ estimated: 60, window: 100, threshold: 50 }), 'ctx:~60/100 超限');
});

test('status line prefers the session name, then shortens for narrow terminals', () => {
  const wide = buildStatusLine({
    sessionId: 'abcdef1234567890',
    name: '发布清单',
    boundary: 'E:\\codes\\project',
    status: { running: false },
    running: false,
    seconds: 0,
    expanded: false,
    columns: 200,
    now: 1000,
  });
  assert.equal(wide, '会话 发布清单 · project');

  const unnamed = buildStatusLine({
    sessionId: 'abcdef1234567890',
    boundary: 'E:\\codes\\project',
    status: { running: false },
    running: false,
    seconds: 0,
    expanded: false,
    columns: 200,
    now: 1000,
  });
  assert.equal(unnamed, '会话 abcdef12 · project');

  const narrow = buildStatusLine({
    sessionId: 'abcdef1234567890',
    name: '发布清单',
    boundary: 'E:\\codes\\very-long-project-name',
    status: { running: true, progress: { phase: 'awaiting_approval', lastProgressAt: 0, modelCalls: 1 } },
    running: true,
    seconds: 5,
    expanded: false,
    columns: 40,
    now: 7000,
  });
  assert.match(narrow, /等待审批/u);
  assert.match(narrow, /打断/u);
  assert.ok(narrow.length > 0);
});

test('a narrow running status keeps its interrupt hint within the terminal width', () => {
  for (const columns of [8, 10, 12, 16, 20, 24]) {
    const line = buildStatusLine({
      sessionId: 'abcdef1234567890',
      name: 'a very long session name',
      status: { running: true, progress: { phase: 'awaiting_approval', lastProgressAt: 0, modelCalls: 1 } },
      running: true,
      seconds: 123,
      expanded: false,
      columns,
      locale: 'en',
      now: 20_000,
    });
    assert.ok(displayWidth(line) <= columns, `${columns}: ${displayWidth(line)} columns: ${line}`);
    assert.match(line, /Esc/u, `${columns}: ${line}`);
  }
});
