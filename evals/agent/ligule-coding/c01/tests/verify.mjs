import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_VERIFIER_DIAGNOSTIC_BYTES = 16 * 1024;
const TEST_ENVIRONMENT_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT'];
const PUBLIC_TEST_NAMES = new Set([
  'displayName prefers a trimmed nickname',
  'displayName falls back to trimmed first and last names',
  'normalizePhone removes punctuation and normalizes supported numbers',
  'priorityLabel keeps its existing formatting',
]);

function testEnvironment() {
  return Object.fromEntries(TEST_ENVIRONMENT_KEYS.flatMap((name) =>
    typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []));
}

function publicTestResult(args, workspace) {
  const result = spawnSync(process.execPath, args, {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    env: testEnvironment(),
  });
  return {
    ...result,
    stdoutBytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr ?? '', 'utf8'),
  };
}

function assertPublicTestsSucceeded(result) {
  if (result.status === 0 && result.error === undefined) return;
  const names = new Set();
  for (const line of `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/u)) {
    const match = /^not ok \d+ - (.*)$/u.exec(line);
    if (match !== null && PUBLIC_TEST_NAMES.has(match[1])) names.add(match[1]);
  }
  const spawnError = result.error === undefined ? '' : `, spawn_error=${String(result.error.code ?? 'unknown')}`;
  const outputLimit = result.error?.code === 'ENOBUFS' ? `, output_limit=${MAX_CHILD_OUTPUT_BYTES}` : '';
  const summary = names.size > 0
    ? `; failed public tests=${[...names].join('; ')}`
    : '; no known public test title captured';
  throw new Error(`public tests failed (exit=${String(result.status)}${spawnError}${outputLimit}; stdout_bytes=${result.stdoutBytes}; stderr_bytes=${result.stderrBytes}; raw output omitted; diagnostic_limit=${MAX_DIAGNOSTIC_BYTES})${summary}`);
}

function runBehavior(workspace) {
  const script = fileURLToPath(new URL('./behavior.mjs', import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, workspace], {
      cwd: workspace,
      env: testEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error;
    child.once('error', (value) => { error = value; });
    child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.once('close', (status, signal) => resolve({ status, signal, error, stdoutBytes, stderrBytes }));
  });
}

function assertBehaviorSucceeded(result) {
  if (result.status === 0 && result.error === undefined) return;
  const spawnError = result.error === undefined ? '' : `, spawn_error=${String(result.error.code ?? 'unknown')}`;
  const signal = result.signal === null ? '' : `, signal=${String(result.signal)}`;
  throw new Error(`independent behavior checks failed (exit=${String(result.status)}${signal}${spawnError}; stdout_bytes=${result.stdoutBytes}; stderr_bytes=${result.stderrBytes}; raw output omitted; diagnostic_limit=${MAX_DIAGNOSTIC_BYTES})`);
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
  const tests = publicTestResult(['--test', '--test-reporter=tap', 'test/contact.test.mjs'], workspace);
  assertPublicTestsSucceeded(tests);
  assertBehaviorSucceeded(await runBehavior(workspace));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = process.argv[2];
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c01_workspace_required');
    await verify(workspace);
  } catch (error) {
    process.stderr.write(verifierFailureText(error, 'c01_verifier_failed'));
    process.exitCode = 1;
  }
}
