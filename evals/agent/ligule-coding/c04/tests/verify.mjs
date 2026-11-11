import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_PUBLIC_TEST_OUTPUT_BYTES = 8 * 1024;
const MAX_VERIFIER_DIAGNOSTIC_BYTES = 16 * 1024;
const TEST_ENVIRONMENT_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT'];

function testEnvironment() {
  return Object.fromEntries(TEST_ENVIRONMENT_KEYS.flatMap((name) =>
    typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []));
}

function publicTestOutput(result) {
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  const output = Buffer.concat([stdout, Buffer.from('\n'), stderr]);
  const truncated = result.error?.code === 'ENOBUFS' || output.length > MAX_PUBLIC_TEST_OUTPUT_BYTES;
  const text = output.subarray(0, MAX_PUBLIC_TEST_OUTPUT_BYTES).toString('utf8').trim();
  return `${text}${truncated ? `\n[public test output truncated at ${MAX_PUBLIC_TEST_OUTPUT_BYTES} bytes]` : ''}`;
}

function verifierFailureText(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  const output = Buffer.from(`${message}\n`, 'utf8');
  if (output.length <= MAX_VERIFIER_DIAGNOSTIC_BYTES) return output;
  const marker = Buffer.from(`\n[verifier diagnostic truncated at ${MAX_VERIFIER_DIAGNOSTIC_BYTES} bytes]\n`, 'utf8');
  const limit = MAX_VERIFIER_DIAGNOSTIC_BYTES - marker.length;
  let prefix = output.subarray(0, limit).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > limit) prefix = prefix.slice(0, -1);
  return Buffer.concat([Buffer.from(prefix, 'utf8'), marker]);
}

function runProgram(args) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: MAX_PUBLIC_TEST_OUTPUT_BYTES, env: testEnvironment(),
  });
}

function assertProgramSuccess(result, label, expectedStatus = 0) {
  if (result.error?.code === 'ENOBUFS') {
    throw new Error(`${label} output exceeded ${MAX_PUBLIC_TEST_OUTPUT_BYTES} bytes [verifier command output truncated at ${MAX_PUBLIC_TEST_OUTPUT_BYTES} bytes]`);
  }
  if (result.error !== undefined) throw new Error(`${label} could not start (spawn_error=${String(result.error.code ?? 'unknown')})`);
  assert.equal(result.status, expectedStatus, `${label} failed (exit=${String(result.status)})`);
}

export async function verify(workspace) {
  const tests = spawnSync(process.execPath, ['--test', 'test/summary.test.mjs'], {
    cwd: workspace,
    windowsHide: true,
    maxBuffer: MAX_PUBLIC_TEST_OUTPUT_BYTES,
    env: testEnvironment(),
  });
  const output = publicTestOutput(tests);
  const spawnFailure = tests.error === undefined ? '' : `, spawn_error=${String(tests.error.code ?? 'unknown')}`;
  const testMessage = tests.status === 0 && tests.error === undefined
    ? 'the project tests pass'
    : `project tests failed (exit=${String(tests.status)}${spawnFailure})${output === '' ? '' : `\n${output}`}`;
  assert.equal(tests.status, 0, testMessage);

  const cli = join(workspace, 'bin', 'summary.mjs');
  const data = join(workspace, 'events.json');
  const jsonFirst = runProgram([cli, '--json', data]);
  const jsonLast = runProgram([cli, data, '--json']);
  for (const result of [jsonFirst, jsonLast]) {
    assertProgramSuccess(result, 'JSON summary');
    assert.deepEqual(JSON.parse(result.stdout), { errors: 1, warnings: 2 });
  }
  const human = runProgram([cli, data]);
  assertProgramSuccess(human, 'human summary');
  assert.equal(human.stdout, 'Errors: 1, Warnings: 2\n');
  const invalid = runProgram([cli, '--unknown', data]);
  assertProgramSuccess(invalid, 'unknown option', 2);
  assert.notEqual(invalid.stderr.trim(), '');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = process.argv[2];
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c04_workspace_required');
    await verify(workspace);
  } catch (error) {
    process.stderr.write(verifierFailureText(error, 'c04_verifier_failed'));
    process.exitCode = 1;
  }
}
