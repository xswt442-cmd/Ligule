import test from 'node:test';
import assert from 'node:assert/strict';
import { searchResultsOf } from '../dist/capability/search-results.js';

const result = (overrides = {}) => ({
  title: 'A result',
  url: 'https://example.com/article',
  snippet: 'A short snippet.',
  summary: 'A short summary.',
  ...overrides,
});

test('validates the service shape and returns an ordinary empty result set', () => {
  assert.deepEqual(searchResultsOf({ results: [] }, 'weather tomorrow', 5, 24_000), {
    provider: 'deepseek', query: 'weather tomorrow', requested: 5, received: 0, returned: 0, results: [], truncated: false,
  });
  for (const value of [null, [], {}, { results: {} }]) {
    assert.throws(() => searchResultsOf(value, 'query', 5, 24_000), { code: 'search_response_invalid' });
  }
  assert.throws(() => searchResultsOf({ results: [] }, '  \n ', 5, 24_000), { code: 'search_query_invalid' });
  assert.throws(() => searchResultsOf({ results: [] }, 'query', 11, 24_000), { code: 'search_count_invalid' });
});

test('canonicalizes safe HTTP URLs, drops unsafe result URLs, and marks omitted data', () => {
  const output = searchResultsOf({ results: [
    result({ url: 'HTTPS://Example.COM:443/a/../b', date: '2026-10-26' }),
    result({ url: 'https://user:pass@example.com/private' }),
    result({ url: 'file:///etc/passwd' }),
    result({ url: `https://example.com/${'x'.repeat(2_100)}` }),
    result({ date: '2025-02-30' }),
  ] }, 'query', 10, 24_000);
  assert.equal(output.received, 5);
  assert.equal(output.returned, 2);
  assert.equal(output.results[0].url, 'https://example.com/b');
  assert.equal(output.results[0].date, '2026-10-26');
  assert.equal(output.results[1].date, undefined);
  assert.equal(output.truncated, true);
});

test('bounds text fields by UTF-8 bytes without splitting Unicode characters', () => {
  const output = searchResultsOf({ results: [result({
    title: '🛰️'.repeat(200), snippet: '界'.repeat(400), summary: 'é'.repeat(800),
  })] }, 'query', 1, 24_000);
  const item = output.results[0];
  assert.ok(Buffer.byteLength(item.title, 'utf8') <= 256);
  assert.ok(Buffer.byteLength(item.snippet, 'utf8') <= 512);
  assert.ok(Buffer.byteLength(item.summary, 'utf8') <= 1_024);
  assert.ok(!item.title.includes('\uFFFD') && !item.snippet.includes('\uFFFD') && !item.summary.includes('\uFFFD'));
  assert.equal(output.truncated, true);
});

test('limits result count and total serialized UTF-8 bytes while reporting truncation', () => {
  const rows = Array.from({ length: 10 }, (_item, index) => result({
    title: `结果 ${index} `.repeat(30),
    snippet: `摘要 ${index} `.repeat(60),
    summary: `内容 ${index} `.repeat(120),
  }));
  const output = searchResultsOf({ results: rows }, 'query', 10, 2_200);
  assert.ok(Buffer.byteLength(JSON.stringify(output), 'utf8') <= 2_200);
  assert.ok(output.returned < 10);
  assert.equal(output.received, 10);
  assert.equal(output.truncated, true);
  assert.throws(() => searchResultsOf({ results: [] }, 'query', 5, 1_023), { code: 'search_result_budget_exceeded' });
});

test('fails when even a single first result cannot fit the minimum output budget', () => {
  const item = result({ url: `https://example.com/${'u'.repeat(1_900)}` });
  assert.throws(() => searchResultsOf({ results: [item] }, 'q'.repeat(128), 1, 1_024), { code: 'search_result_budget_exceeded' });
});

test('malformed required fields fail instead of appearing to be no matches', () => {
  assert.throws(() => searchResultsOf({ results: [{ title: 'broken' }] }, 'query', 5, 24_000), { code: 'search_response_invalid' });
});
