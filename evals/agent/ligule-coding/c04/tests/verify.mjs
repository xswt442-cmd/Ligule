import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_CAPTURED_STREAM_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_STREAM_BYTES = 8 * 1024;
const MAX_VERIFIER_DIAGNOSTIC_BYTES = 16 * 1024;
const TEST_ENVIRONMENT_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT'];
const PUBLIC_TEST_NAMES = new Set([
  'the default summary stays human-readable',
  'the JSON flag works before and after the input path',
]);

function testEnvironment() {
  return Object.fromEntries(TEST_ENVIRONMENT_KEYS.flatMap((name) =>
    typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []));
}

function outputCapture() {
  const halfLimit = MAX_DIAGNOSTIC_STREAM_BYTES / 2;
  let totalBytes = 0;
  let first = Buffer.alloc(0);
  let last = Buffer.alloc(0);
  let outputTooLarge = false;
  const chunks = [];
  return {
    append(chunk) {
      totalBytes += chunk.length;
      if (!outputTooLarge) {
        if (totalBytes <= MAX_CAPTURED_STREAM_BYTES) chunks.push(chunk);
        else {
          outputTooLarge = true;
          chunks.length = 0;
        }
      }
      let offset = 0;
      if (first.length < halfLimit) {
        const length = Math.min(halfLimit - first.length, chunk.length);
        first = Buffer.concat([first, chunk.subarray(0, length)]);
        offset = length;
      }
      if (offset < chunk.length) {
        last = Buffer.concat([last, chunk.subarray(offset)]);
        if (last.length > halfLimit) last = last.subarray(last.length - halfLimit);
      }
    },
    text() {
      return outputTooLarge ? '' : Buffer.concat(chunks).toString('utf8');
    },
    diagnostic(name) {
      const visible = Buffer.concat([first, last]).toString('utf8');
      return totalBytes <= MAX_DIAGNOSTIC_STREAM_BYTES
        ? visible
        : `${visible}\n[${name} output truncated at ${MAX_DIAGNOSTIC_STREAM_BYTES} bytes; total=${totalBytes} bytes]`;
    },
    get bytes() { return totalBytes; },
    get outputTooLarge() { return outputTooLarge; },
  };
}

function runChild(args, cwd) {
  const stdout = outputCapture();
  const stderr = outputCapture();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: testEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error;
    child.once('error', (value) => { error = value; });
    child.stdout.on('data', (chunk) => stdout.append(chunk));
    child.stderr.on('data', (chunk) => stderr.append(chunk));
    child.once('close', (status, signal) => resolve({
      status, signal, error,
      outputTooLarge: stdout.outputTooLarge || stderr.outputTooLarge,
      stdout: stdout.text(), stderr: stderr.text(),
      stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes,
      stdoutDiagnostic: stdout.diagnostic('stdout'), stderrDiagnostic: stderr.diagnostic('stderr'),
    }));
  });
}

function childFailure(result, label, expectedStatus = 0) {
  const spawnError = result.error === undefined ? '' : `, spawn_error=${String(result.error.code ?? 'unknown')}`;
  const signal = result.signal === null ? '' : `, signal=${String(result.signal)}`;
  const outputLimit = result.outputTooLarge ? `, output_limit=${MAX_CAPTURED_STREAM_BYTES}` : '';
  return `${label} failed (exit=${String(result.status)}, expected=${expectedStatus}${signal}${spawnError}${outputLimit}; stdout_bytes=${result.stdoutBytes}; stderr_bytes=${result.stderrBytes}; child output omitted; diagnostic_limit=${MAX_DIAGNOSTIC_STREAM_BYTES})`;
}

function assertProcessSucceeded(result, label, expectedStatus = 0) {
  if (result.status === expectedStatus && result.error === undefined && !result.outputTooLarge) return;
  throw new Error(childFailure(result, label, expectedStatus));
}

function assertPublicTestsSucceeded(result) {
  if (result.status === 0 && result.error === undefined && !result.outputTooLarge) return;
  const names = new Set();
  for (const line of `${result.stdoutDiagnostic}\n${result.stderrDiagnostic}`.split(/\r?\n/u)) {
    const match = /^not ok \d+ - (.*)$/u.exec(line);
    if (match !== null && PUBLIC_TEST_NAMES.has(match[1])) names.add(match[1]);
  }
  const summary = names.size > 0
    ? `; failed public tests=${[...names].join('; ')}`
    : '; failed public test suite=test/summary.test.mjs; no known title captured';
  throw new Error(`${childFailure(result, 'project tests')}${summary}`);
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON (stdout_bytes=${result.stdoutBytes}; diagnostic_limit=${MAX_DIAGNOSTIC_STREAM_BYTES}; output omitted)`);
  }
}

function expectedSummary(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 2 && value.errors === 1 && value.warnings === 2;
}

// 验收必须自己造输入：缺参数、坏 JSON、未知级别都要由 verifier 独立触发，
// 否则只做了 `--json` 的方案也能拿满分。
async function assertRejected(cli, args, workspace, label) {
  const result = await runChild([cli, ...args], workspace);
  assertProcessSucceeded(result, label, 2);
  assert.equal(result.stdout === '', true, `${label} wrote stdout`);
  assert.equal(result.stderr.trim() !== '', true, `${label} did not write stderr`);
}

async function withFixtureFile(path, content, run) {
  await writeFile(path, content, 'utf8');
  try {
    await run();
  } finally {
    await rm(path, { force: true });
  }
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

export async function verify(workspace) {
  const tests = await runChild(['--test', '--test-reporter=tap', 'test/summary.test.mjs'], workspace);
  assertPublicTestsSucceeded(tests);

  const cli = join(workspace, 'bin', 'summary.mjs');
  const data = join(workspace, 'events.json');
  const jsonFirst = await runChild([cli, '--json', data], workspace);
  assertProcessSucceeded(jsonFirst, 'JSON summary');
  assert.equal(expectedSummary(parseJsonOutput(jsonFirst, 'JSON summary')), true, 'JSON summary did not match expected fields');

  const jsonLast = await runChild([cli, data, '--json'], workspace);
  assertProcessSucceeded(jsonLast, 'JSON summary');
  assert.equal(expectedSummary(parseJsonOutput(jsonLast, 'JSON summary')), true, 'JSON summary did not match expected fields');

  const human = await runChild([cli, data], workspace);
  assertProcessSucceeded(human, 'human summary');
  assert.equal(human.stdout === 'Errors: 1, Warnings: 2\n', true, 'human summary did not match expected text');

  await assertRejected(cli, [], workspace, 'missing input');
  await assertRejected(cli, ['--unknown', data], workspace, 'unknown option');
  await withFixtureFile(join(workspace, 'verify-malformed-events.json'), '[\n  { "id": "v-1", "level": "error" }\n', async () => {
    await assertRejected(cli, [join(workspace, 'verify-malformed-events.json')], workspace, 'malformed JSON input');
  });
  await withFixtureFile(join(workspace, 'verify-unknown-level.json'), '[{ "id": "v-2", "level": "fatal" }]\n', async () => {
    await assertRejected(cli, [join(workspace, 'verify-unknown-level.json')], workspace, 'unknown event level');
  });
  await withFixtureFile(join(workspace, 'verify-not-an-array.json'), '{ "id": "v-3", "level": "error" }\n', async () => {
    await assertRejected(cli, [join(workspace, 'verify-not-an-array.json')], workspace, 'non-array input');
  });
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
