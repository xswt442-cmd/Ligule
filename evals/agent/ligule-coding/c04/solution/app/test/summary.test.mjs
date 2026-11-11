import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('bin/summary.mjs');
const events = resolve('events.json');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
}

test('the default summary stays human-readable', () => {
  const result = run([events]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Errors: 1, Warnings: 2\n');
});

test('the JSON flag works before and after the input path', () => {
  for (const args of [['--json', events], [events, '--json']]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { errors: 1, warnings: 2 });
  }
});

test('invalid input is rejected with a message on stderr', () => {
  const directory = mkdtempSync(join(tmpdir(), 'summary-cli-'));
  try {
    const malformed = join(directory, 'malformed.json');
    writeFileSync(malformed, '[\n  { "id": "x", "level": "error" }\n');
    const unknownLevel = join(directory, 'unknown-level.json');
    writeFileSync(unknownLevel, '[{ "id": "x", "level": "fatal" }]\n');
    const notAnArray = join(directory, 'not-an-array.json');
    writeFileSync(notAnArray, '{ "id": "x", "level": "error" }\n');
    const cases = [
      ['missing input', []],
      ['malformed JSON', [malformed]],
      ['unknown event level', [unknownLevel]],
      ['non-array input', [notAnArray]],
      ['unknown option', ['--unknown', events]],
    ];
    for (const [label, args] of cases) {
      const result = run(args);
      assert.equal(result.status, 2, `${label} must exit with status 2`);
      assert.notEqual(result.stderr.trim(), '', `${label} must explain itself on stderr`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
