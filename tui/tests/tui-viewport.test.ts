import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownLines } from '../dist/tui/markdown.js';
import { displayWidth } from '../dist/tui/commands.js';
import { editDraft } from '../dist/tui/app.js';
import { selectedText, transcriptLines, viewportPosition, wrapLine } from '../dist/tui/viewport.js';

test('markdown preserves literal code and reads both kinds of fences', () => {
  assert.equal(markdownLines('`**literal**`')[0].text, '**literal**');
  const source = '# 中文注释\nconst text = "阶段";   ';
  const lines = markdownLines(`~~~js\n${source}\n~~~`);
  assert.equal(lines.map((line) => line.text).join('\n'), source);
  assert.ok(lines[1].spans!.some((span) => span.scope === 'keyword'));
  assert.ok(lines[1].spans!.some((span) => span.scope === 'string'));
  assert.equal(markdownLines('3. 第三项')[0].text, '3. 第三项');
});

test('tables wrap to terminal columns without losing Chinese or emoji text', () => {
  const source = '| 名称 | 内容 |\n| --- | --- |\n| 阶段 | 👩‍💻中文文字 |';
  const lines = markdownLines(source, 22);
  assert.ok(lines.every((line) => displayWidth(line.text) <= 22));
  const all = lines.map((line) => line.text).join('').replace(/[│┼─\s]/g, '');
  for (const text of ['名称', '内容', '阶段', '👩‍💻中文文字']) assert.ok(all.includes(text));
});

test('pagination keeps a selected line visible and copies a contiguous selection', () => {
  const lines = wrapLine('第一行\n👩‍💻abcdef\n最后一行', 6);
  assert.ok(lines.every((line) => displayWidth(line) <= 6));
  assert.deepEqual(viewportPosition(20, 8, 3), { cursor: 7, offset: 5 });
  assert.deepEqual(viewportPosition(1, 8, 3, 5), { cursor: 1, offset: 1 });
  assert.equal(selectedText(lines, 2, 1), lines.slice(1, 3).join('\n'));
  const history = transcriptLines([{ kind: 'result', tool: 'read', seq: 9, text: 'abcdefghi' }], 6);
  assert.ok(history.join('').includes('abcdefghi'));
  assert.ok(history.every((line) => displayWidth(line) <= 6));
});

test('draft cursor and deletion preserve a whole grapheme', () => {
  const text = 'a👩‍💻中';
  const left = editDraft(text, text.length - 1, '', { leftArrow: true });
  assert.equal(left.caret, 1);
  const deleted = editDraft(text, text.length - 1, '', { backspace: true });
  assert.deepEqual(deleted, { draft: 'a中', caret: 1 });
  assert.equal(displayWidth('a👩‍💻中e\u0301'), 6);
});
