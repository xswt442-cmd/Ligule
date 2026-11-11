import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verify(workspace) {
  const tests = spawnSync(process.execPath, ['--test', 'test/summary.test.mjs'], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(tests.error, undefined, 'the project test process starts');
  const output = [tests.stdout, tests.stderr].filter(Boolean).join('\n').trim();
  const testMessage = tests.status === 0
    ? 'the project tests pass'
    : `project tests failed (exit=${String(tests.status)})${output === '' ? '' : `\n${output}`}`;
  assert.equal(tests.status, 0, testMessage);

  const cli = join(workspace, 'bin', 'summary.mjs');
  const data = join(workspace, 'events.json');
  const jsonFirst = spawnSync(process.execPath, [cli, '--json', data], { encoding: 'utf8', windowsHide: true });
  const jsonLast = spawnSync(process.execPath, [cli, data, '--json'], { encoding: 'utf8', windowsHide: true });
  for (const result of [jsonFirst, jsonLast]) {
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { errors: 1, warnings: 2 });
  }
  const human = spawnSync(process.execPath, [cli, data], { encoding: 'utf8', windowsHide: true });
  assert.equal(human.status, 0);
  assert.equal(human.stdout, 'Errors: 1, Warnings: 2\n');
  const invalid = spawnSync(process.execPath, [cli, '--unknown', data], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 2);
  assert.notEqual(invalid.stderr.trim(), '');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = process.argv[2];
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c04_workspace_required');
    await verify(workspace);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'c04_verifier_failed'}\n`);
    process.exitCode = 1;
  }
}
