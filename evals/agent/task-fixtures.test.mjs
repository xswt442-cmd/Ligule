import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const codingTasks = join(repository, 'evals', 'agent', 'ligule-coding');
const temporaryRoot = join(repository, 'testplace', 'tmp');

function runVerifier(taskDirectory, workspace, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [join(taskDirectory, 'tests', 'verify.mjs'), workspace], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
}

async function verifyFixture(taskId) {
  const taskDirectory = join(codingTasks, taskId);
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, `ligule-p1-${taskId}-`));
  const workspace = join(temporaryDirectory, 'workspace');
  try {
    await cp(join(taskDirectory, 'environment', 'app'), workspace, { recursive: true });
    const initial = runVerifier(taskDirectory, workspace);
    assert.notEqual(initial.status, 0, 'the initial task must fail its verifier');
    const failureNames = {
      c01: /displayName prefers a trimmed nickname/u,
      c02: /PATCH trims and updates an existing item/u,
      c03: /slugify keeps issue numbers and normalizes punctuation/u,
      c04: /the JSON flag works before and after the input path/u,
    };
    assert.match(initial.stderr, failureNames[taskId], `the ${taskId.toUpperCase()} verifier must retain a failed public test name`);

    await cp(join(taskDirectory, 'solution', 'app'), workspace, { recursive: true, force: true });
    assert.equal(runVerifier(taskDirectory, workspace).status, 0, 'the reference behavior must pass independently');

    await cp(join(taskDirectory, 'environment', 'app'), workspace, { recursive: true, force: true });
    assert.notEqual(runVerifier(taskDirectory, workspace).status, 0, 'a regression must fail verification');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('the C01 fixture distinguishes the unsolved, solved, and regressed states', async () => {
  await verifyFixture('c01');
});

test('the C02 fixture distinguishes the unsolved, solved, and regressed states', async () => {
  await verifyFixture('c02');
});

test('the C03 fixture distinguishes the unsolved, solved, and regressed states', async () => {
  await verifyFixture('c03');
});

test('the C04 fixture distinguishes the unsolved, solved, and regressed states', async () => {
  await verifyFixture('c04');
});

test('coding verifiers cap public-test diagnostics and exclude unrelated environment variables', async () => {
  const sentinel = 'test-only-verifier-environment-sentinel';
  const testFiles = {
    c01: 'contact.test.mjs',
    c02: 'server.test.mjs',
    c03: 'slug.test.mjs',
    c04: 'summary.test.mjs',
  };
  for (const [taskId, testFile] of Object.entries(testFiles)) {
    const taskDirectory = join(codingTasks, taskId);
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, `ligule-p1-${taskId}-diagnostics-`));
    const workspace = join(temporaryDirectory, 'workspace');
    try {
      await mkdir(join(workspace, 'test'), { recursive: true });
      await writeFile(join(workspace, 'test', testFile), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('public diagnostic output fixture', () => {",
        "  if (process.env.LIGULE_VERIFIER_TEST_SECRET) process.stderr.write(process.env.LIGULE_VERIFIER_TEST_SECRET);",
        "  process.stdout.write('x'.repeat(131072));",
        "  assert.fail('public_diagnostic_fixture_failure');",
        '});',
        '',
      ].join('\n'));
      const result = runVerifier(taskDirectory, workspace, { LIGULE_VERIFIER_TEST_SECRET: sentinel });
      assert.notEqual(result.status, 0, `${taskId} diagnostic fixture must fail`);
      assert.equal(result.stderr.includes(sentinel), false, `${taskId} must not inherit unrelated environment variables`);
      assert.equal(/public test output truncated at 8192 bytes/u.test(result.stderr), true,
        `${taskId} must report the output limit (bytes=${Buffer.byteLength(result.stderr)}, exit=${String(result.status)})`);
      assert.ok(Buffer.byteLength(result.stderr) <= 16_384, `${taskId} diagnostic must remain bounded`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('coding verifier error details have a byte limit and explicit truncation marker', async () => {
  const taskDirectory = join(codingTasks, 'c02');
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'ligule-p1-c02-verifier-error-'));
  const workspace = join(temporaryDirectory, 'workspace');
  try {
    await mkdir(join(workspace, 'test'), { recursive: true });
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'test', 'server.test.mjs'), 'export {};\n');
    await writeFile(join(workspace, 'src', 'server.mjs'), "throw new Error('x'.repeat(32768));\n");
    const result = runVerifier(taskDirectory, workspace);
    assert.notEqual(result.status, 0, 'the verifier must keep the task failure');
    assert.equal(/verifier diagnostic truncated at 16384 bytes/u.test(result.stderr), true);
    assert.ok(Buffer.byteLength(result.stderr) <= 16_384, 'the verifier stderr must respect its byte limit');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('the C04 verifier caps task-command output and names truncation', async () => {
  const taskDirectory = join(codingTasks, 'c04');
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'ligule-p1-c04-command-output-'));
  const workspace = join(temporaryDirectory, 'workspace');
  try {
    await mkdir(join(workspace, 'test'), { recursive: true });
    await mkdir(join(workspace, 'bin'), { recursive: true });
    await writeFile(join(workspace, 'test', 'summary.test.mjs'), 'export {};\n');
    await writeFile(join(workspace, 'events.json'), '{}\n');
    await writeFile(join(workspace, 'bin', 'summary.mjs'), "process.stdout.write('x'.repeat(131072));\n");
    const result = runVerifier(taskDirectory, workspace);
    assert.notEqual(result.status, 0, 'the verifier must keep the command output failure');
    assert.equal(/verifier command output truncated at 8192 bytes/u.test(result.stderr), true);
    assert.ok(Buffer.byteLength(result.stderr) <= 16_384, 'the task command diagnostic must respect its byte limit');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('coding and canary plans use auto while repeated runs stay limited to C01', async () => {
  const once = JSON.parse(await readFile(join(codingTasks, '..', 'coding-plan.json'), 'utf8'));
  const repeated = JSON.parse(await readFile(join(codingTasks, '..', 'coding-c01-repeat-plan.json'), 'utf8'));
  const canary = JSON.parse(await readFile(join(codingTasks, '..', 'canary-plan.json'), 'utf8'));
  assert.equal(once.policy_mode, 'auto');
  assert.equal(once.attempts_per_task, 1);
  assert.deepEqual(once.tasks.map((task) => task.id), ['c01', 'c02', 'c03', 'c04']);
  assert.equal(repeated.policy_mode, 'auto');
  assert.equal(repeated.attempts_per_task, 3);
  assert.deepEqual(repeated.tasks.map((task) => task.id), ['c01']);
  assert.equal(canary.policy_mode, 'auto');
  assert.deepEqual(canary.tasks.map((task) => task.id), ['canary']);
});

test('all coding verifier images pin Node 24 for separate execution', async () => {
  const digest = '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9';
  const archive = `ADD --checksum=sha256:${digest} https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz /tmp/node-v24.22.2-linux-x64.tar.gz`;
  for (const taskId of ['c01', 'c02', 'c03', 'c04']) {
    const dockerfile = await readFile(join(codingTasks, taskId, 'environment', 'Dockerfile'), 'utf8');
    assert.ok(dockerfile.includes(archive), `${taskId} must pin the official Node archive digest`);
    assert.ok(dockerfile.includes('ENV PATH="/opt/node-v24.22.2/bin:${PATH}"'), `${taskId} must expose Node to its separate verifier`);
  }
});
