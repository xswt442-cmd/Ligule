import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const runner = join(repository, 'evals', 'perf', 'run.ts');

function run(args: readonly string[], cwd = repository): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

test('performance runner rejects zero samples', () => {
  const result = run(['--repeats', '0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid --repeats/u);
});

test('performance runner rejects unknown scenarios instead of silently doing nothing', () => {
  const result = run(['--scenario', 'does-not-exist']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown benchmark scenario: does-not-exist/u);
});

test('performance runner refuses to overwrite an explicit output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-perf-output-'));
  try {
    const output = join(root, 'existing');
    await mkdir(output);
    await writeFile(join(output, 'marker.txt'), 'keep me\n', 'utf8');
    const result = run(['--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /output_directory_exists/u);
    assert.equal(await readFile(join(output, 'marker.txt'), 'utf8'), 'keep me\n');
    const forced = run(['--output', output, '--force']);
    assert.notEqual(forced.status, 0);
    assert.match(forced.stderr, /output_directory_not_benchmark_run/u);
    assert.equal(await readFile(join(output, 'marker.txt'), 'utf8'), 'keep me\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
