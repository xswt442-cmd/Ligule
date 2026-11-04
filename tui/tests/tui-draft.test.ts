import test from 'node:test';
import assert from 'node:assert/strict';
import { editDraft, isTypingRun, moveDraftCaret } from '../dist/tui/draft.js';

test('draft navigation and deletion operate on whole graphemes', () => {
  const draft = 'a👩‍💻e\u0301中';
  assert.deepEqual(editDraft(draft, 1, '', { rightArrow: true }), { draft, caret: 6 });
  assert.deepEqual(editDraft(draft, 6, '', { backspace: true }), { draft: 'ae\u0301中', caret: 1 });
  assert.deepEqual(editDraft(draft, 1, '', { delete: true }), { draft: 'ae\u0301中', caret: 1 });
  assert.deepEqual(editDraft(draft, draft.length, '', { delete: true }), { draft, caret: draft.length });
  assert.deepEqual(editDraft(draft, 0, '', { backspace: true }), { draft, caret: 0 });
});

test('draft insertion at a middle caret and editing shortcuts preserve their contract', () => {
  assert.deepEqual(editDraft('甲乙', 1, '👩‍💻', {}), { draft: '甲👩‍💻乙', caret: 6 });
  const completedFlag = editDraft('🇸', 0, '🇺', {});
  assert.deepEqual(completedFlag, { draft: '🇺🇸', caret: 4 });
  assert.deepEqual(editDraft(completedFlag.draft, completedFlag.caret, '', { backspace: true }), { draft: '', caret: 0 });
  assert.deepEqual(editDraft('rm -rf  ', 8, 'w', { ctrl: true }), { draft: 'rm ', caret: 3 });
  assert.deepEqual(editDraft('e\u0301', 2, 'w', { ctrl: true }), { draft: '', caret: 0 });
  assert.deepEqual(editDraft('oops', 4, 'u', { ctrl: true }), { draft: '', caret: 0 });
  assert.deepEqual(editDraft('abc', 1, '', { home: true }), { draft: 'abc', caret: 0 });
  assert.deepEqual(editDraft('abc', 0, '', { end: true }), { draft: 'abc', caret: 3 });
});

test('typing runs group only one appended non-space grapheme at the end', () => {
  assert.equal(isTypingRun({ draft: '👍', caret: 2 }, { draft: '👍👩‍💻', caret: 7 }), true);
  assert.equal(isTypingRun({ draft: 'ab', caret: 2 }, { draft: 'ab ', caret: 3 }), false);
  assert.equal(isTypingRun({ draft: 'a', caret: 0 }, { draft: 'ab', caret: 2 }), false);
  assert.equal(isTypingRun({ draft: 'a', caret: 1 }, { draft: 'a中好', caret: 3 }), false);
});

test('vertical movement preserves visual columns across wide and combining graphemes', () => {
  const draft = 'a中e\u0301z\n👩‍💻xy\n宽';
  assert.equal(moveDraftCaret(draft, 4, 'down'), 13, 'visual column 4 lands after xy');
  assert.equal(moveDraftCaret(draft, 12, 'up'), 2, 'visual column 3 lands after the wide Chinese grapheme');
  assert.equal(moveDraftCaret(draft, 4, 'up'), 4, 'first line has no line above');
  assert.equal(moveDraftCaret(draft, draft.length, 'down'), draft.length, 'last line has no line below');
  assert.equal(moveDraftCaret('abc\nx', 3, 'down'), 5, 'short target line clamps at its end');
  assert.equal(moveDraftCaret('\nx', 0, 'down'), 1, 'empty first line moves to the next line start');
  assert.equal(moveDraftCaret('\nx', 1, 'up'), 0, 'moving up reaches an empty first line');
});
