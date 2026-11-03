import assert from 'node:assert/strict';
import test from 'node:test';
import { draftViewport } from '../dist/tui/input-view.js';
import { displayWidth } from '../dist/tui/commands.js';

test('long pasted drafts keep a bounded viewport around the current caret', () => {
  const draft = Array.from({ length: 40 }, (_, index) => `第${index}行`).join('\n');
  const view = draftViewport(draft, draft.length, 20, 3);
  assert.equal(view.lines.length, 3);
  assert.equal(view.total, 40);
  assert.equal(view.offset, 37);
  assert.equal(view.lines.at(-1)!.text, '第39行');
  assert.equal(draftViewport(draft, 0, 20, 3).offset, 0);
});

test('wrapped input preserves complete graphemes and source offsets', () => {
  const draft = 'ab👩‍💻中e\u0301\n末行';
  const view = draftViewport(draft, 2, 3, 10);
  assert.ok(view.lines.every(line => displayWidth(line.text) <= 3));
  assert.ok(view.lines.some(line => line.text.includes('👩‍💻')));
  for (const line of view.lines) assert.equal(draft.slice(line.start, line.end), line.text);
  assert.equal(view.lines[view.cursor].start, 2, 'caret at a wrap boundary belongs to the next display line');
});

test('a newline caret stays at the end of its logical line', () => {
  const view = draftViewport('abc\ndef', 3, 3, 2);
  assert.equal(view.cursor, 0);
  assert.equal(view.lines[0].end, 3);
  assert.equal(draftViewport('abc\n', 4, 3, 2).cursor, 1);
});
