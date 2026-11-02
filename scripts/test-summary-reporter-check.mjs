import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = resolve(repository, 'testplace', 'tmp');
let reportRoot;
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, 'summary-reporter-'));
let artifact;

function isWithin(root, path) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function run(files) {
  const environment = { ...process.env, LIGULE_TEST_REPORT_DIR: reportRoot };
  const child = spawnSync(process.execPath, [
    '--test', '--test-reporter=./scripts/test-summary-reporter.mjs',
    ...files.map((file) => relative(repository, file)),
  ], {
    cwd: repository,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (child.error !== undefined) throw child.error;
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

try {
  const passingFile = join(directory, 'passing.test.mjs');
  const failingFile = join(directory, 'failing.test.mjs');
  reportRoot = resolve(directory, 'reports');
  const passingStderr = 'passing-file stderr retained in the failure artifact';
  const failingStdout = 'runId=reporter-run sessionId=reporter-session input=reporter-input';
  const failingStderr = 'failing-file stderr retained';
  await writeFile(passingFile, `import test from 'node:test';\ntest('passing fixture', () => { console.error(${JSON.stringify(passingStderr)}); });\n`);
  await writeFile(failingFile, `import test from 'node:test';\ntest('failing fixture', () => { console.log(${JSON.stringify(failingStdout)}); console.error(${JSON.stringify(failingStderr)}); throw new Error('reporter fixture failure'); });\n`);

  const passed = run([passingFile]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /PASS 1\/1 passed, 0 failed, 0 skipped/u);
  assert.doesNotMatch(passed.stdout, new RegExp(passingStderr));
  assert.equal(passed.stderr, '');

  const failed = run([passingFile, failingFile]);
  const artifactLine = failed.stdout.split(/\r?\n/u).find((line) => line.startsWith('Test failure details: '));
  if (artifactLine !== undefined) artifact = resolve(repository, artifactLine.slice('Test failure details: '.length));
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /FAIL 1\/2 passed, 1 failed, 0 skipped/u);
  assert.match(failed.stdout, /failing fixture/u);
  assert.match(failed.stdout, /reporter fixture failure/u);
  assert.match(failed.stdout, new RegExp(failingStdout));
  assert.match(failed.stdout, new RegExp(failingStderr));
  assert.match(failed.stdout, new RegExp(passingStderr));
  assert.match(failed.stdout, /Caused by:\nError: reporter fixture failure\n\s+at TestContext\.<anonymous>.*failing\.test\.mjs:/u);
  assert.equal(failed.stderr, '');

  assert.ok(artifactLine, 'failure output names its report artifact');
  assert.ok(isWithin(reportRoot, artifact), 'only the reporter-owned artifact path is read');
  const report = await readFile(artifact, 'utf8');
  for (const expected of [failingStdout, failingStderr, passingStderr, 'reporter fixture failure']) {
    assert.ok(report.includes(expected), `failure artifact includes ${expected}`);
  }
  process.stdout.write('test summary reporter contract passed\n');
} finally {
  if (artifact !== undefined && isWithin(reportRoot, artifact)) await rm(artifact, { force: true });
  await rm(directory, { recursive: true, force: true });
}
