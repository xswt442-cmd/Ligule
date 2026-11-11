import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabel, slugify } from '../src/slug.mjs';

test('slugify keeps issue numbers and normalizes punctuation', () => {
  assert.equal(slugify('Issue #42: API Fix'), 'issue-42-api-fix');
  assert.equal(slugify('  Résumé / Q&A 03  '), 'resume-q-a-03');
  assert.equal(slugify('No Changes'), 'no-changes');
});

test('normalizeLabel keeps its existing whitespace behavior', () => {
  assert.equal(normalizeLabel('  Needs   Review  '), 'Needs Review');
});
