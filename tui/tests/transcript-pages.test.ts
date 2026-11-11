import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTranscriptPages } from '../src/tui/transcript-pages.ts';

interface Row { readonly seq: number }

function records(from: number, to: number): Row[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => ({ seq: from + index }));
}

test('a page that already covers the previous sequence is not paged further', async () => {
  const requested: (number | undefined)[] = [];
  const result = await collectTranscriptPages<Row>(async (before) => {
    requested.push(before);
    return records(100, 200);
  }, 100, 50);
  assert.deepEqual(requested, [undefined]);
  assert.equal(result.complete, true);
  assert.equal(result.pages.length, 1);
});

test('a gap wider than one page is read backwards until it reaches the previous sequence', async () => {
  const requested: (number | undefined)[] = [];
  const result = await collectTranscriptPages<Row>(async (before) => {
    requested.push(before);
    if (before === undefined) return records(820, 1_000);
    if (before === 820) return records(400, 819);
    return records(1, 399);
  }, 90, 50);
  assert.deepEqual(requested, [undefined, 820, 400]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.pages.map((page) => page.length), [181, 420, 399]);
  const chronological = [...result.pages].reverse().flat().map((row) => row.seq);
  assert.deepEqual(chronological, records(1, 1_000).map((row) => row.seq));
});

test('the page limit stops the read and reports that history may stay incomplete', async () => {
  const requested: (number | undefined)[] = [];
  const result = await collectTranscriptPages<Row>(async (before) => {
    requested.push(before);
    const newest = before === undefined ? 5_000 : before - 1;
    return records(newest - 399, newest);
  }, 10, 3);
  assert.deepEqual(requested, [undefined, 4_601, 4_201]);
  assert.equal(result.complete, false);
  assert.equal(result.pages.length, 3);
});

test('an empty page completes the read', async () => {
  const result = await collectTranscriptPages<Row>(async () => [], -1, 50);
  assert.equal(result.complete, true);
  assert.deepEqual(result.pages, [[]]);
});

test('a stopped read keeps the pages it already has and reports incompleteness', async () => {
  let calls = 0;
  const result = await collectTranscriptPages<Row>(async () => {
    calls += 1;
    return records(900 + calls, 1_000 + calls);
  }, 10, 50, () => calls >= 1);
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.pages, [records(901, 1_001)]);
});
