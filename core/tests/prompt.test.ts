import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptAssembly, PROMPT_BOUNDARY } from '../dist/index.js';

test('the whole static section can be replaced and the default text is then absent', () => {
  const assembly = createPromptAssembly({ static: 'the default instructions', replace: 'project instructions' });
  assert.equal(assembly.staticPrefix, 'project instructions');
  const rendered = assembly.render();
  assert.ok(rendered.startsWith('project instructions'));
  assert.ok(!rendered.includes('the default instructions'));
});

test('the appended section lands after the assembled text', () => {
  const assembly = createPromptAssembly({ static: 'head', append: 'tail' });
  assembly.fragment({ name: 'rules', anchor: 10, text: 'a rule', maxBytes: 100 });
  const rendered = assembly.render();
  assert.equal(rendered, `head\n\n${PROMPT_BOUNDARY}\n\na rule\n\ntail`);
});

test('fragments follow their anchors and the boundary is always present', () => {
  const assembly = createPromptAssembly({ static: 'head' });
  assembly.fragment({ name: 'later', anchor: 20, text: 'second', maxBytes: 100 });
  const first = assembly.fragment({ name: 'earlier', anchor: 10, text: 'first', maxBytes: 100 });
  assert.equal(assembly.render(), `head\n\n${PROMPT_BOUNDARY}\n\nfirst\n\nsecond`);
  first();
  assert.equal(assembly.render(), `head\n\n${PROMPT_BOUNDARY}\n\nsecond`);
  assert.equal(createPromptAssembly({}).render(), PROMPT_BOUNDARY);
});

test('a fragment beyond its byte limit is cut with a visible marker and the total stays inside the limit', () => {
  const assembly = createPromptAssembly({});
  assembly.fragment({ name: 'instructions', anchor: 1, text: 'x'.repeat(100), maxBytes: 80 });
  const rendered = assembly.render();
  const fragment = rendered.slice(rendered.indexOf(PROMPT_BOUNDARY) + PROMPT_BOUNDARY.length + 2);
  assert.ok(Buffer.byteLength(fragment, 'utf8') <= 80);
  assert.match(fragment, /^x+/);
  assert.match(fragment, /\[prompt fragment "instructions" truncated to fit 80 bytes]$/);
});

test('a fragment exactly at its limit is left alone and a byte cut never leaves half a character', () => {
  const exact = createPromptAssembly({});
  exact.fragment({ name: 'a', anchor: 1, text: 'abcd', maxBytes: 4 });
  assert.equal(exact.render(), `${PROMPT_BOUNDARY}\n\nabcd`);

  const wide = createPromptAssembly({});
  wide.fragment({ name: 'b', anchor: 1, text: '汉字'.repeat(30), maxBytes: 60 });
  const rendered = wide.render();
  const fragment = rendered.slice(rendered.indexOf(PROMPT_BOUNDARY) + PROMPT_BOUNDARY.length + 2);
  assert.ok(Buffer.byteLength(fragment, 'utf8') <= 60);
  assert.ok(!fragment.includes('\uFFFD'), '按字节切之后不能留下半个字符');
  assert.ok(fragment.startsWith('汉字'));
});

test('the static prefix is the same bytes on every render', () => {
  const assembly = createPromptAssembly({ static: 'head' });
  assembly.fragment({ name: 'volatile', anchor: 5, text: 'changes between turns', maxBytes: 200 });
  const before = assembly.staticPrefix;
  assembly.fragment({ name: 'another', anchor: 6, text: 'more', maxBytes: 200 });
  assert.equal(assembly.staticPrefix, before);
  assert.ok(assembly.render().startsWith(`${before}\n\n${PROMPT_BOUNDARY}`));
});
