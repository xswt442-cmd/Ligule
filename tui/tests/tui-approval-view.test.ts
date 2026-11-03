import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { ApprovalPanel, buildApprovalLayout } from '../dist/tui/approval-view.js';
import type { ApprovalDisplay, ApprovalLayout } from '../dist/tui/approval-view.js';
import { displayWidth } from '../dist/tui/commands.js';
import { keyHint } from '../dist/tui/keymap.js';
import { completeFrame } from './helpers/frames.ts';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { isTTY: boolean; columns: number };

function approval(overrides: Partial<ApprovalDisplay> = {}): ApprovalDisplay {
  return {
    tool: 'fs.write',
    detail: 'C:/repo/notes.txt',
    change: 'Write 42 bytes to C:/repo/notes.txt',
    backend: '',
    reason: 'The agent needs to save the requested note.',
    content: 'pending file contents',
    rememberable: true,
    rememberScopes: ['user', 'session', 'project'],
    rememberHintKey: 'file',
    rememberTargetOptions: ['file', 'workspace'],
    rememberTarget: 'file',
    ...overrides,
  };
}

function terminal(columns = 80) {
  const stdout: FakeOutput = Object.assign(new PassThrough(), { columns, isTTY: true });
  let output = '';
  stdout.on('data', (chunk: Buffer | string) => { output += chunk.toString(); });
  const stdin: FakeInput = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  return {
    output: () => completeFrame(output),
    render: (layout: ApprovalLayout, cursor = 0) => render(createElement(ApprovalPanel, { layout, cursor }), {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false, interactive: true,
    }),
  };
}

function assertFrameBudget(frame: string, columns: number, rows: number) {
  const lines = frame.split('\n').filter(Boolean);
  assert.ok(lines.length <= rows, `expected at most ${rows} rows, got ${lines.length}:\n${frame}`);
  assert.ok(lines.every((line) => displayWidth(line) <= columns), lines.join('\n'));
}

// 记住规则是第二层，所以这组“每个决定都单独可见”的断言在展开态（第六个参数 true）下检查。
test('expanded remember level renders every decision separately and preserves supplied scope order at 32x14', () => {
  const layout = buildApprovalLayout(approval(), false, 32, 14, 'zh', true);
  assert.equal(layout.canApprove, true);
  assert.ok(layout.bodyHeight >= 1);
  assert.ok(layout.targetLines.join('').includes('C:/repo/notes.txt'));
  assert.ok(layout.scopeLines.join('').includes('仅此文件'));
  const scopeChoices = layout.actionLines.join('\n');
  assert.ok(scopeChoices.indexOf('2 记住所有项目') < scopeChoices.indexOf('3 记住本会话'));
  assert.ok(scopeChoices.indexOf('3 记住本会话') < scopeChoices.indexOf('4 记住本项目'));
  assert.ok(scopeChoices.includes('w 切换文件/工作区范围'));
  const actionText = layout.actionLines.join('\n');
  assert.ok(actionText.includes(`${keyHint('deny')} 拒绝`));
  assert.ok(actionText.includes(`${keyHint('expand-or-history')} 查看详情`));
  assert.ok(actionText.includes(`${keyHint('approval-cancel')} 取消本轮`));
  assert.ok(layout.actionLines.length < 8, 'short choices share rows at 32 columns');

  const tty = terminal(32);
  const instance = tty.render(layout);
  try {
    const frame = tty.output();
    assert.match(frame, /允许执行 fs\.write/);
    assert.match(frame, /w 切换文件\/工作区范围/);
    assert.match(frame, /拒绝/);
    assert.match(frame, /取消本轮/);
    assertFrameBudget(frame, 32, 14);
  } finally {
    instance.unmount();
  }
});

test('approval ranges state file, exact command, MCP identity, and all tool arguments', () => {
  const file = buildApprovalLayout(approval({ rememberTarget: 'workspace' }), false, 80, 24, 'zh', true);
  assert.ok(file.scopeLines.join('').includes('此工作区内同类文件操作'));
  assert.ok(file.actionLines.join('\n').includes('w 切换文件/工作区范围'));

  const command = buildApprovalLayout(approval({ rememberHintKey: 'command', rememberTargetOptions: ['command'] }), false, 80, 24, 'en', true);
  assert.ok(command.scopeLines.join('').includes('exact command and argument boundary'));
  assert.ok(!command.actionLines.some((line) => line.startsWith('w ')));

  const digest = '0123456789abcdef'.repeat(4);
  const mcp = buildApprovalLayout(approval({
    tool: 'mcp.search', detail: 'mcp:docs/search', rememberHintKey: 'mcp',
    rememberTargetOptions: [], identityDigest: digest,
  }), false, 80, 24, 'en', true);
  assert.ok(mcp.scopeLines.join('').includes('same MCP tool, arguments, and server configuration digest 0123456789ab'));
  assert.ok(!mcp.actionLines.some((line) => line.startsWith('w ')));

  const tool = buildApprovalLayout(approval({ rememberHintKey: 'tool', rememberTargetOptions: ['tool'] }), false, 80, 24, 'en', true);
  assert.ok(tool.scopeLines.join('').includes('all arguments for this tool capability'));

  const wide = terminal(80);
  const wideLayout = buildApprovalLayout(approval(), false, 80, 24, 'en');
  const wideInstance = wide.render(wideLayout);
  try {
    assertFrameBudget(wide.output(), 80, 24);
  } finally {
    wideInstance.unmount();
  }
});

test('approval refuses blind decisions when fixed content cannot fit and keeps deny/cancel', () => {
  const layout = buildApprovalLayout(approval(), false, 32, 4, 'en');
  assert.equal(layout.canApprove, false);
  assert.equal(layout.bodyHeight, 0);
  assert.deepEqual(layout.titleLines, []);
  assert.ok(layout.warningLines.join('').includes('Enlarge window to review'));
  assert.deepEqual(layout.actionLines, [`${keyHint('deny')} Deny`, `${keyHint('approval-cancel')} Cancel this turn`]);
  const tty = terminal(32);
  const instance = tty.render(layout);
  try {
    const frame = tty.output();
    assert.match(frame.replace(/│\s*/gu, '').replace(/\n/gu, ' '), /Enlarge window to review/);
    assert.match(frame, /Deny/);
    assert.match(frame, /Cancel this turn/);
    assertFrameBudget(frame, 32, 4);
  } finally {
    instance.unmount();
  }
});

test('missing targets are explicit and complete operation arguments remain reviewable', () => {
  const searchable = buildApprovalLayout(approval({
    tool: 'custom.search', detail: '', change: '', content: '{"query":"release notes"}',
    rememberable: false, rememberScopes: [], rememberHintKey: '', rememberTargetOptions: [],
  }), false, 80, 14, 'en');
  assert.equal(searchable.canApprove, true);
  assert.ok(searchable.targetLines.join('').includes('Target not provided'));
  assert.ok(searchable.targetLines.join('').includes('custom.search'));
  assert.ok(searchable.bodyLines.join('\n').includes('"query":"release notes"'));
  assert.ok(searchable.bodyHeight >= 1);

  const targetlessWrite = buildApprovalLayout(approval({
    tool: 'write', detail: '', change: '', content: 'new file contents',
  }), false, 80, 24, 'en');
  assert.equal(targetlessWrite.canApprove, true, 'the Host owns target validation; the view exposes missing target information');
  assert.ok(targetlessWrite.targetLines.join('').includes('Target not provided'));
  assert.ok(targetlessWrite.bodyLines.join('\n').includes('new file contents'));
});

test('approval is blocked when body text cannot keep both a row and its pager', () => {
  const layout = buildApprovalLayout(approval({
    rememberable: false, rememberScopes: [], rememberHintKey: '', rememberTargetOptions: [],
    change: 'A short operation summary', reason: 'A short reason', content: '',
  }), false, 80, 4, 'en');
  assert.equal(layout.bodyLines.length > 0, true);
  assert.equal(layout.bodyHeight, 0);
  assert.equal(layout.canApprove, false);
  assert.ok(layout.warningLines.length > 0);
});

test('long targets and memory boundaries stay fully visible before approval is enabled', () => {
  const longTarget = buildApprovalLayout(approval({ detail: `C:/repo/${'nested/'.repeat(50)}notes.txt` }), false, 32, 14, 'en');
  assert.equal(longTarget.canApprove, false);
  assert.deepEqual(longTarget.titleLines, []);

  const longScope = buildApprovalLayout(approval({
    detail: 'mcp:docs/search', rememberHintKey: 'mcp', identityDigest: 'ab'.repeat(32),
    rememberTargetOptions: [],
  }), false, 32, 4, 'en');
  assert.equal(longScope.canApprove, false);
  assert.deepEqual(longScope.scopeLines, []);
  assert.deepEqual(longScope.actionLines, [`${keyHint('deny')} Deny`, `${keyHint('approval-cancel')} Cancel this turn`]);
});

test('expanded approval body is complete and cursor paging exposes later content', () => {
  const content = Array.from({ length: 30 }, (_, index) => `pending line ${String(index + 1).padStart(2, '0')}`).join('\n');
  const layout = buildApprovalLayout(approval({ content }), true, 80, 14, 'en');
  assert.equal(layout.canApprove, true);
  assert.ok(layout.bodyHeight > 0);
  assert.ok(layout.bodyLines.some((line) => line.includes('pending line 30')));

  const first = terminal();
  const firstContentLine = layout.bodyLines.findIndex((line) => line.includes('pending line 01'));
  const firstInstance = first.render(layout, firstContentLine);
  try {
    const frame = first.output();
    assert.match(frame, /pending line 01/);
    assert.doesNotMatch(frame, /pending line 30/);
    assertFrameBudget(frame, 80, 14);
  } finally {
    firstInstance.unmount();
  }

  const last = terminal();
  const lastInstance = last.render(layout, layout.bodyLines.length - 1);
  try {
    const frame = last.output();
    assert.match(frame, /pending line 30/);
    assert.match(frame, /Changes \d+\/\d+ lines/);
    assertFrameBudget(frame, 80, 14);
  } finally {
    lastInstance.unmount();
  }
});

test('remember rules stay behind one shortcut and leave the main decisions in one row', () => {
  const collapsed = buildApprovalLayout(approval(), false, 80, 24, 'zh');
  assert.equal(collapsed.canApprove, true);
  assert.deepEqual(collapsed.scopeLines, [], 'the remember range only appears after the user opens it');
  const collapsedActions = collapsed.actionLines.join('\n');
  assert.ok(!collapsedActions.includes('记住本会话'), 'rule choices are not offered before the user asks for them');
  assert.ok(!collapsedActions.includes('w 切换'), 'the scope toggle belongs to the second level');
  assert.ok(collapsedActions.includes(`${keyHint('approval-remember')} 记住规则…`), 'the shortcut itself stays visible');
  assert.ok(collapsedActions.includes('1 允许一次'));
  assert.ok(collapsedActions.includes(`${keyHint('deny')} 拒绝`));
  assert.ok(collapsedActions.includes(`${keyHint('expand-or-history')} 查看详情`));
  assert.ok(collapsedActions.includes(`${keyHint('approval-cancel')} 取消本轮`));
  assert.ok(collapsed.actionLines.length <= 2, `primary decisions share at most two rows: ${collapsedActions}`);

  const open = buildApprovalLayout(approval(), false, 80, 24, 'zh', true);
  assert.ok(open.scopeLines.join('').includes('仅此文件'));
  assert.ok(open.actionLines.join('\n').includes(`${keyHint('approval-remember')} 收起记住选项`));
  assert.ok(open.bodyHeight < collapsed.bodyHeight, 'folding the rules away gives the rows back to the pending change');

  for (const rows of [24, 12]) {
    const layout = buildApprovalLayout(approval(), false, 80, rows, 'zh');
    assert.equal(layout.canApprove, true, `collapsed approval stays operable at 80x${rows}`);
    const tty = terminal(80);
    const instance = tty.render(layout);
    try {
      const frame = tty.output();
      assert.match(frame, /记住规则/);
      assert.match(frame, /1 允许一次/);
      assert.match(frame, /拒绝/);
      assert.match(frame, /取消本轮/);
      assertFrameBudget(frame, 80, rows);
    } finally {
      instance.unmount();
    }
  }

  const narrowOpen = buildApprovalLayout(approval(), false, 80, 12, 'zh', true);
  assert.equal(narrowOpen.canApprove, true, 'opening the remember level at 80x12 still allows a decision');
  assert.ok(narrowOpen.actionLines.join('\n').includes('w 切换文件/工作区范围'));
});

test('an opened remember level that no longer fits keeps deny/cancel and the way back', () => {
  const layout = buildApprovalLayout(approval(), false, 80, 6, 'zh', true);
  assert.equal(layout.canApprove, false);
  assert.ok(layout.warningLines.join('').includes('请放大窗口'));
  assert.deepEqual(layout.actionLines, [
    `${keyHint('deny')} 拒绝`,
    `${keyHint('approval-cancel')} 取消本轮`,
    `${keyHint('approval-remember')} 收起记住选项`,
  ]);
  // 收起之后主操作重新可用，用户不会被第二层卡死。
  const collapsed = buildApprovalLayout(approval(), false, 80, 12, 'zh');
  assert.equal(collapsed.canApprove, true);
});
