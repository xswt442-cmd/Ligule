import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

    if (taskId === 'c02') {
      const c02EnvironmentTests = await readFile(join(taskDirectory, 'environment', 'app', 'test', 'server.test.mjs'), 'utf8');
      const c02SolutionTests = await readFile(join(taskDirectory, 'solution', 'app', 'test', 'server.test.mjs'), 'utf8');
      const c02Behavior = await readFile(join(taskDirectory, 'tests', 'behavior.mjs'), 'utf8');
      const patchBody = "JSON.stringify({ name: '  Black Tea  ' })";
      assert.equal(c02EnvironmentTests.split(patchBody).length - 1, 2,
        'C02 stale 405 and target PATCH tests must use the same request body');
      assert.equal(c02SolutionTests.includes(patchBody), true, 'C02 reference test must use the target PATCH request body');
      assert.equal(c02Behavior.includes(patchBody), true, 'C02 independent behavior check must use the target PATCH request body');
      assert.match(initial.stderr, /PATCH rejects invalid JSON without changing the item/u);
      assert.match(initial.stderr, /PATCH rejects names over 80 characters without changing the item/u);
      await copyFile(join(taskDirectory, 'solution', 'app', 'src', 'server.mjs'), join(workspace, 'src', 'server.mjs'));
      const routeOnly = runVerifier(taskDirectory, workspace);
      assert.notEqual(routeOnly.status, 0, 'the C02 route implementation must also update the stale public test');
      assert.match(routeOnly.stderr, /PATCH remains unsupported under the current route contract/u);
    }

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
      assert.equal(result.stderr.includes('x'.repeat(100)), false, `${taskId} must not echo raw public-test output`);
      assert.equal(/diagnostic_limit=8192/u.test(result.stderr), true,
        `${taskId} must report its diagnostic limit (bytes=${Buffer.byteLength(result.stderr)}, exit=${String(result.status)})`);
      assert.ok(Buffer.byteLength(result.stderr) <= 16_384, `${taskId} diagnostic must remain bounded`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('coding verifier error details omit behavior output and stay byte-bounded', async () => {
  const taskDirectory = join(codingTasks, 'c02');
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'ligule-p1-c02-verifier-error-'));
  const workspace = join(temporaryDirectory, 'workspace');
  try {
    await mkdir(join(workspace, 'test'), { recursive: true });
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'test', 'server.test.mjs'), 'export {};\n');
    await writeFile(join(workspace, 'src', 'server.mjs'), "process.stdout.write('o'.repeat(131072)); process.stderr.write('e'.repeat(131072)); throw new Error('fixture_failure');\n");
    const result = runVerifier(taskDirectory, workspace);
    assert.notEqual(result.status, 0, 'the verifier must keep the task failure');
    assert.equal(result.stderr.includes('fixture_failure'), false, 'behavior error text must not cross the process boundary');
    assert.equal(result.stderr.includes('o'.repeat(100)), false, 'behavior output must not cross the process boundary');
    assert.equal(result.stderr.includes('e'.repeat(100)), false, 'behavior stderr must not cross the process boundary');
    assert.equal(result.stderr.includes('raw output omitted'), true,
      `stderr_bytes=${Buffer.byteLength(result.stderr)}, behavior_label=${result.stderr.includes('independent behavior checks')}, output_limit_label=${result.stderr.includes('diagnostic_limit=8192')}`);
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
    assert.equal(result.stderr.includes('x'.repeat(100)), false, 'task command output must not be copied into verifier errors');
    const diagnostic = {
      invalidJson: result.stderr.includes('returned invalid JSON'),
      byteCount: /stdout_bytes=(\d+)/u.exec(result.stderr)?.[1] ?? 'missing',
      limit: result.stderr.includes('diagnostic_limit=8192'),
      omitted: result.stderr.includes('output omitted'),
    };
    assert.equal(diagnostic.invalidJson, true, JSON.stringify(diagnostic));
    assert.equal(diagnostic.byteCount, '131072', JSON.stringify(diagnostic));
    assert.equal(diagnostic.limit, true, JSON.stringify(diagnostic));
    assert.equal(diagnostic.omitted, true, JSON.stringify(diagnostic));
    assert.ok(Buffer.byteLength(result.stderr) <= 16_384, 'the task command diagnostic must respect its byte limit');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('coding behavior checks do not inherit verifier environment variables', async () => {
  const sentinel = 'behavior-verifier-environment-sentinel';
  const sourceFiles = { c01: 'contact.mjs', c02: 'server.mjs', c03: 'slug.mjs' };
  for (const [taskId, sourceFile] of Object.entries(sourceFiles)) {
    const taskDirectory = join(codingTasks, taskId);
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, `ligule-p1-${taskId}-behavior-env-`));
    const workspace = join(temporaryDirectory, 'workspace');
    try {
      await cp(join(taskDirectory, 'environment', 'app'), workspace, { recursive: true });
      const sourcePath = join(workspace, 'src', sourceFile);
      await copyFile(join(taskDirectory, 'solution', 'app', 'src', sourceFile), sourcePath);
      if (taskId === 'c02') {
        await copyFile(join(taskDirectory, 'solution', 'app', 'test', 'server.test.mjs'), join(workspace, 'test', 'server.test.mjs'));
      }
      const source = await readFile(sourcePath, 'utf8');
      await writeFile(sourcePath, `if (process.env.LIGULE_VERIFIER_TEST_SECRET) process.stderr.write(process.env.LIGULE_VERIFIER_TEST_SECRET);\n${source}`);
      const result = runVerifier(taskDirectory, workspace, { LIGULE_VERIFIER_TEST_SECRET: sentinel });
      assert.equal(result.status, 0, `${taskId} reference behavior must keep passing`);
      assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false, `${taskId} behavior code must not see verifier environment variables`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('coding behavior output is drained, bounded, and marked without a reward bypass', async () => {
  const sourceFiles = { c01: 'contact.mjs', c02: 'server.mjs', c03: 'slug.mjs' };
  for (const [taskId, sourceFile] of Object.entries(sourceFiles)) {
    const taskDirectory = join(codingTasks, taskId);
    const testFile = { c01: 'contact.test.mjs', c02: 'server.test.mjs', c03: 'slug.test.mjs' }[taskId];
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, `ligule-p1-${taskId}-behavior-output-`));
    const workspace = join(temporaryDirectory, 'workspace');
    try {
      await mkdir(join(workspace, 'test'), { recursive: true });
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'test', testFile), 'export {};\n');
      await writeFile(join(workspace, 'src', sourceFile), "process.stdout.write('x'.repeat(131072)); throw new Error('behavior_output_fixture_failure');\n");
      const result = runVerifier(taskDirectory, workspace);
      const output = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0, `${taskId} behavior failure must remain a verifier failure`);
      assert.equal(output.includes('x'.repeat(100)), false, `${taskId} behavior output must not be copied into verifier errors`);
      const diagnostic = {
        behaviorLabel: output.includes('independent behavior checks'),
        stdoutBytes: /stdout_bytes=(\d+)/u.exec(output)?.[1] ?? 'missing',
        childOutputOmitted: output.includes('child output omitted'),
        limit: output.includes('diagnostic_limit=8192'),
      };
      assert.equal(diagnostic.behaviorLabel, true, `${taskId}: ${JSON.stringify(diagnostic)}`);
      assert.equal(diagnostic.stdoutBytes, '131072', `${taskId}: ${JSON.stringify(diagnostic)}`);
      assert.equal(output.includes('raw output omitted'), true, `${taskId}: ${JSON.stringify(diagnostic)}`);
      assert.equal(diagnostic.limit, true, `${taskId}: ${JSON.stringify(diagnostic)}`);
      assert.ok(Buffer.byteLength(output) <= 16_384, `${taskId} final verifier output must remain bounded`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('the C04 verifier preserves passing CLI results with verbose stderr', async () => {
  const taskDirectory = join(codingTasks, 'c04');
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'ligule-p1-c04-verbose-stderr-'));
  const workspace = join(temporaryDirectory, 'workspace');
  try {
    await mkdir(join(workspace, 'test'), { recursive: true });
    await mkdir(join(workspace, 'bin'), { recursive: true });
    await writeFile(join(workspace, 'test', 'summary.test.mjs'), 'export {};\n');
    await writeFile(join(workspace, 'events.json'), '[{"id":"e-1","level":"error"},{"id":"e-2","level":"warning"}]\n');
    await writeFile(join(workspace, 'bin', 'summary.mjs'), [
      "import { readFileSync } from 'node:fs';",
      "const args = process.argv.slice(2).filter((argument) => argument !== '--json');",
      "const json = process.argv.includes('--json');",
      "const invalid = args.includes('--unknown') || args.length !== 1;",
      "const fail = () => { process.stderr.write('x'.repeat(131072)); process.exitCode = 2; };",
      "if (invalid) fail();",
      "else {",
      "  try {",
      "    const events = JSON.parse(readFileSync(args[0], 'utf8'));",
      "    if (!Array.isArray(events) || events.some((event) => !['error', 'warning'].includes(event?.level))) throw new Error('bad');",
      "    if (json) { process.stderr.write('x'.repeat(131072)); process.stdout.write('{\"errors\":1,\"warnings\":2}\\n'); }",
      "    else process.stdout.write('Errors: 1, Warnings: 2\\n');",
      "  } catch { fail(); }",
      "}",
      '',
    ].join('\n'));
    const result = runVerifier(taskDirectory, workspace);
    assert.equal(result.status, 0, 'large task stderr alone must not turn a valid CLI result into a failure');
    assert.equal(`${result.stdout}${result.stderr}`.includes('x'.repeat(100)), false, 'verbose task stderr must not be forwarded');
    assert.equal(Buffer.byteLength(`${result.stdout}${result.stderr}`) <= 16_384, true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('coding verifiers keep passing public tests successful when output is verbose', async () => {
  const testFiles = {
    c01: 'contact.test.mjs',
    c02: 'server.test.mjs',
    c03: 'slug.test.mjs',
    c04: 'summary.test.mjs',
  };
  for (const [taskId, testFile] of Object.entries(testFiles)) {
    const taskDirectory = join(codingTasks, taskId);
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, `ligule-p1-${taskId}-verbose-pass-`));
    const workspace = join(temporaryDirectory, 'workspace');
    try {
      await cp(join(taskDirectory, 'solution', 'app'), workspace, { recursive: true });
      await mkdir(join(workspace, 'test'), { recursive: true });
      if (taskId === 'c04') await copyFile(join(taskDirectory, 'environment', 'app', 'events.json'), join(workspace, 'events.json'));
      await writeFile(join(workspace, 'test', testFile), [
        "import test from 'node:test';",
        "test('verbose public test still passes', () => { process.stdout.write('x'.repeat(131072)); });",
        '',
      ].join('\n'));
      const result = runVerifier(taskDirectory, workspace);
      assert.equal(result.status, 0, `${taskId} must preserve the public test result`);
      assert.equal(`${result.stdout}${result.stderr}`.includes('x'.repeat(100)), false, `${taskId} passing test output must not be forwarded`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('verifiers preserve the historical one-MiB child output failure limit', async () => {
  const taskDirectory = join(codingTasks, 'c01');
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'ligule-p1-c01-child-output-limit-'));
  const workspace = join(temporaryDirectory, 'workspace');
  try {
    await cp(join(taskDirectory, 'solution', 'app'), workspace, { recursive: true });
    await mkdir(join(workspace, 'test'), { recursive: true });
    await writeFile(join(workspace, 'test', 'contact.test.mjs'), [
      "import test from 'node:test';",
      "test('over-limit public test output', () => { process.stdout.write('x'.repeat(2097152)); });",
      '',
    ].join('\n'));
    const result = runVerifier(taskDirectory, workspace);
    assert.notEqual(result.status, 0, 'output above the existing child-process limit must remain a failure');
    assert.equal(/output_limit=1048576/u.test(result.stderr), true);
    assert.ok(Buffer.byteLength(result.stderr) <= 16_384);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('coding and canary plans use auto while repeated runs stay limited to C01', async () => {
  const once = JSON.parse(await readFile(join(codingTasks, '..', 'coding-plan.json'), 'utf8'));
  const repeated = JSON.parse(await readFile(join(codingTasks, '..', 'coding-c01-repeat-plan.json'), 'utf8'));
  const canary = JSON.parse(await readFile(join(codingTasks, '..', 'canary-plan.json'), 'utf8'));
  assert.equal(once.dataset.version, '0.1.3-p1.2');
  assert.equal(repeated.dataset.version, '0.1.3-p1.2');
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
