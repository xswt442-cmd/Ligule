import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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
