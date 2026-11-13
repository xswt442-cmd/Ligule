import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName, normalizePhone, priorityLabel } from '../src/contact.mjs';

test('displayName prefers a trimmed nickname', () => {
  assert.equal(displayName({ nickname: '  Ada  ', firstName: 'Ada', lastName: 'Lovelace' }), 'Ada');
});

test('displayName falls back to trimmed first and last names', () => {
  assert.equal(displayName({ firstName: ' Ada ', lastName: ' Lovelace ' }), 'Ada Lovelace');
  assert.equal(displayName({ firstName: ' ', lastName: '' }), '');
});

test('normalizePhone removes punctuation and normalizes supported numbers', () => {
  assert.equal(normalizePhone('(415) 555-0123'), '+14155550123');
  assert.equal(normalizePhone('415.555.0123'), '+14155550123');
  assert.equal(normalizePhone('+44 (20) 7946-0958'), '+442079460958');
  assert.equal(normalizePhone('12345'), null);
});

test('normalizePhone rejects letters and unsupported punctuation', () => {
  assert.equal(normalizePhone('call (415) 555-0123'), null);
  assert.equal(normalizePhone('415/555-0123'), null);
});

test('priorityLabel keeps its existing formatting', () => {
  assert.equal(priorityLabel(' Needs Review '), 'NEEDS REVIEW');
});
