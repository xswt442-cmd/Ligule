import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const codingTasks = join(repository, 'evals', 'agent', 'ligule-coding');
const temporaryRoot = join(repository, 'testplace', 'tmp');

function runVerifier(taskDirectory, workspace) {
  return spawnSync(process.execPath, [join(taskDirectory, 'tests', 'verify.mjs'), workspace], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function verifyFixture(taskId) {
  const taskDirectory = join(codingTasks, taskId);
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, `ligule-p1-${taskId}-`));
  const workspace = join(temporaryDirectory, 'workspace');
  try {
    await cp(join(taskDirectory, 'environment', 'app'), workspace, { recursive: true });
    assert.notEqual(runVerifier(taskDirectory, workspace).status, 0, 'the initial task must fail its verifier');

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
