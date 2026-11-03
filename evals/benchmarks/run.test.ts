import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkTimeoutMs, countsOf, positiveInteger, prepareRunDirectory, readTarballProvenance, timeoutBasis } from './lib.ts';
import { writeManifest } from './manifest.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const runner = join(repository, 'evals', 'benchmarks', 'run.ts');

function run(args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, ...args], {
    cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stderr: result.stderr ?? '' };
}

const IDENTITY = {
  gitSha: '0123456789abcdef0123456789abcdef01234567',
  dirty: false,
  node: 'v24.22.1',
  platform: 'test 1.0',
  arch: 'x64',
};

test('agent runner rejects unknown tasks and invalid outer timeouts before starting Harbor', () => {
  const unknown = run(['--tasks', 'not-a-task']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown benchmark tasks/u);
  const invalid = run(['--timeout-ms', '0']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /total_timeout_ms_must_be_positive_integer/u);
});

test('tarball provenance requires the sidecar digest and source SHA to match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-provenance-'));
  try {
    const tarball = join(root, 'ligule.tgz');
    await writeFile(tarball, 'fixture\n', 'utf8');
    const sha = createHash('sha256').update('fixture\n').digest('hex');
    const provenance = {
      schemaVersion: 1, package: 'ligule', version: '0.1.2', tarball: 'ligule.tgz',
      tarballSha256: sha, sourceGitSha: IDENTITY.gitSha, sourceDirty: false,
      buildNodeVersion: 'v24.22.1', buildTimestamp: '2026-01-01T00:00:00.000Z', builder: 'fixture',
    };
    assert.equal((await readTarballProvenance(tarball, sha)).error, 'source_sidecar_missing');
    await writeFile(`${tarball}.source.json`, `${JSON.stringify(provenance)}\n`, 'utf8');
    assert.equal((await readTarballProvenance(tarball, sha)).provenance?.sourceGitSha, IDENTITY.gitSha);
    assert.equal((await readTarballProvenance(tarball, '0'.repeat(64))).error, 'source_sidecar_digest_mismatch');
    await writeFile(`${tarball}.source.json`, `${JSON.stringify({ ...provenance, sourceGitSha: 'short' })}\n`, 'utf8');
    assert.equal((await readTarballProvenance(tarball, sha)).error, 'source_sidecar_git_sha_invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('benchmark options reject zero repeats and invalid integers', () => {
  assert.throws(() => positiveInteger('0', 'total_timeout_ms'), /positive_integer/u);
  assert.throws(() => positiveInteger('-1', 'total_timeout_ms'), /positive_integer/u);
  assert.throws(() => positiveInteger('1.5', 'total_timeout_ms'), /positive_integer/u);
  assert.equal(positiveInteger('7', 'total_timeout_ms'), 7);
  assert.equal(positiveInteger(undefined, 'total_timeout_ms'), undefined);
});

test('the outer timeout scales with tasks and concurrency and accepts an explicit override', () => {
  const plan = { tasks: [], concurrency: 2, timeout_multipliers: { task: 1, agent: 4, agent_setup: 4 } };
  const small = benchmarkTimeoutMs(plan, 2, undefined);
  const large = benchmarkTimeoutMs(plan, 8, undefined);
  assert.ok(large > small);
  assert.equal(benchmarkTimeoutMs(plan, 8, 123_456), 123_456);
  assert.deepEqual(timeoutBasis(plan, 8), { waves: 4, perTaskSeconds: 900 + 3600 + 1440 + 300, multiplier: 1.5 });
});

test('run directories refuse silent overwrite and preserve previous evidence with --force', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-agent-output-'));
  try {
    const existing = join(root, 'run');
    await mkdir(existing);
    await writeFile(join(existing, 'marker.txt'), 'old evidence\n', 'utf8');
    await assert.rejects(() => prepareRunDirectory(existing, false, join(root, 'unused')), /output_directory_exists/u);
    assert.equal(await readFile(join(existing, 'marker.txt'), 'utf8'), 'old evidence\n');
    await assert.rejects(() => prepareRunDirectory(existing, true, join(root, 'unused')), /output_directory_not_benchmark_run/u);
    await writeFile(join(existing, 'run.json'), `${JSON.stringify({ identity: IDENTITY, plan: {}, executionStatus: 'completed' })}\n`, 'utf8');
    const fresh = await prepareRunDirectory(existing, true, join(root, 'unused'));
    assert.equal(fresh, existing);
    await assert.rejects(() => readFile(join(existing, 'marker.txt'), 'utf8'), { code: 'ENOENT' });
    const siblings = await (await import('node:fs/promises')).readdir(root);
    const previous = siblings.find((name) => name.startsWith('run.previous-'));
    assert.ok(previous);
    assert.equal(await readFile(join(root, previous, 'marker.txt'), 'utf8'), 'old evidence\n');
    const active = join(root, 'active');
    await mkdir(active);
    await writeFile(join(active, 'run.json'), `${JSON.stringify({ identity: IDENTITY, plan: {}, executionStatus: 'running' })}\n`, 'utf8');
    await writeFile(join(active, 'run-state.json'), `${JSON.stringify({ status: 'collecting', pid: process.pid })}\n`, 'utf8');
    await assert.rejects(() => prepareRunDirectory(active, true, join(root, 'unused')), /active_benchmark_run/u);
    const orphanedRunner = join(root, 'orphaned-runner');
    await mkdir(orphanedRunner);
    await writeFile(join(orphanedRunner, 'run.json'), `${JSON.stringify({ identity: IDENTITY, plan: {}, executionStatus: 'running' })}\n`, 'utf8');
    await writeFile(join(orphanedRunner, 'run-state.json'), `${JSON.stringify({
      status: 'collecting', pid: 999_999_999, harborPid: process.pid,
    })}\n`, 'utf8');
    await assert.rejects(() => prepareRunDirectory(orphanedRunner, true, join(root, 'unused')), /active_benchmark_run/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task summary counts require all report denominators', () => {
  assert.deepEqual(countsOf({ pass: 1, fail: 2, infra_error: 3, not_run: 4, attempts: 10 }), {
    pass: 1, fail: 2, infra_error: 3, not_run: 4, total: 10,
  });
  assert.equal(countsOf({ pass: 1 }), undefined);
});

test('the manifest rejects malformed trial results instead of hiding them as not-run', async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'ligule-manifest-broken-'));
  try {
    const job = join(runDirectory, 'job.json');
    await writeFile(job, '{}\n', 'utf8');
    const trial = join(runDirectory, 'harbor', 'job-1', 'broken__1');
    await mkdir(trial, { recursive: true });
    await writeFile(join(trial, 'result.json'), '{"task_name": "broken"\n', 'utf8');
    const plan = {
      dataset: { name: 'terminal-bench', version: '2.0' },
      tasks: [{ id: 'broken', category: 'fixture', covers: 'broken' }],
      attempts_per_task: 1,
      concurrency: 1,
      model: { model_calls: 1, timeout_ms: 1, request_timeout_ms: 1 },
      verifier: { reward_key: 'reward', pass_threshold: 1 },
    };
    await assert.rejects(() => writeManifest({
      runDirectory, plan, identity: IDENTITY, model: 'fixture-model', baseUrl: 'https://provider.invalid/v1',
      jobPath: job, jobName: 'job-1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
    }), /malformed_harbor_result/u);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test('repeated attempts refuse ambiguous missing results instead of misassigning them', async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'ligule-manifest-attempts-'));
  try {
    const job = join(runDirectory, 'job.json');
    await writeFile(job, '{}\n', 'utf8');
    const first = join(runDirectory, 'harbor', 'job-1', 'repeat__1');
    const second = join(runDirectory, 'harbor', 'job-1', 'repeat__2');
    await mkdir(first, { recursive: true });
    await mkdir(join(second, 'agent'), { recursive: true });
    await writeFile(join(first, 'result.json'), `${JSON.stringify({
      task_name: 'repeat', trial_name: 'repeat__1', task_id: { path: 'task' },
    })}\n`, 'utf8');
    const plan = {
      dataset: { name: 'terminal-bench', version: '2.0' },
      tasks: [{ id: 'repeat', category: 'fixture', covers: 'repeat' }],
      attempts_per_task: 2,
      concurrency: 1,
      model: { model_calls: 1, timeout_ms: 1, request_timeout_ms: 1 },
      verifier: { reward_key: 'reward', pass_threshold: 1 },
    };
    await assert.rejects(() => writeManifest({
      runDirectory, plan, identity: IDENTITY, model: 'fixture-model', baseUrl: 'https://provider.invalid/v1',
      jobPath: job, jobName: 'job-1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
    }), /repeated_attempt_result_missing/u);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test('the manifest records attempts without inventing task outcomes', async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'ligule-manifest-'));
  try {
    const job = join(runDirectory, 'job.json');
    await writeFile(job, '{"job_name":"fixture"}\n', 'utf8');
    const jobRoot = join(runDirectory, 'harbor', 'job-1');
    const writeResult = async (task: string, trial: string, body: Record<string, unknown>): Promise<string> => {
      const directory = join(jobRoot, trial);
      await mkdir(join(directory, 'agent'), { recursive: true });
      await writeFile(join(directory, 'result.json'), `${JSON.stringify(body)}\n`, 'utf8');
      await writeFile(join(directory, 'agent', 'trajectory.json'), '{}\n', 'utf8');
      return directory;
    };
    const base = { task_id: { path: 'task' }, exception_info: null };
    await writeResult('pass-task', 'pass-task__1', { ...base, task_name: 'pass-task', trial_name: 'pass-task__1', verifier_result: { rewards: { reward: 1 } } });
    await writeResult('fail-task', 'fail-task__1', { ...base, task_name: 'fail-task', trial_name: 'fail-task__1', verifier_result: { rewards: { reward: 0 } } });
    await writeResult('infra-task', 'infra-task__1', {
      ...base, task_name: 'infra-task', trial_name: 'infra-task__1',
      exception_info: { exception_type: 'AgentTimeoutError' }, verifier_result: null,
    });
    const plan = {
      dataset: { name: 'terminal-bench', version: '2.0' },
      tasks: [
        { id: 'pass-task', category: 'fixture', covers: 'pass' },
        { id: 'fail-task', category: 'fixture', covers: 'fail' },
        { id: 'infra-task', category: 'fixture', covers: 'infra' },
        { id: 'not-run-task', category: 'fixture', covers: 'missing' },
      ],
      attempts_per_task: 1,
      concurrency: 2,
      model: { model_calls: 40, timeout_ms: 3_600_000, request_timeout_ms: 300_000 },
      verifier: { reward_key: 'reward', pass_threshold: 1 },
    };
    const result = await writeManifest({
      runDirectory, plan, identity: IDENTITY, model: 'fixture-model', baseUrl: 'https://provider.invalid/v1',
      jobPath: job, jobName: 'job-1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T01:00:00.000Z',
    });
    assert.deepEqual({ attempts: result.attempts, notRun: result.notRun }, { attempts: 4, notRun: 1 });
    const manifest = JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8')) as {
      experiment: Record<string, unknown>;
      attempts: Record<string, unknown>[];
    };
    assert.equal(manifest.experiment.git_sha, IDENTITY.gitSha);
    assert.equal(manifest.experiment.policy_mode, 'auto');
    assert.equal(manifest.attempts.length, 4);
    const passAttempt = manifest.attempts.find((attempt) => attempt.task_id === 'pass-task');
    assert.equal(passAttempt?.result_file, 'harbor/job-1/pass-task__1/result.json');
    assert.equal(passAttempt?.trajectory_file, 'harbor/job-1/pass-task__1/agent/trajectory.json');
    const missing = manifest.attempts.find((attempt) => attempt.task_id === 'not-run-task');
    assert.equal(missing?.result_file, null);
    assert.equal(missing?.trial_name, null);
    assert.equal(missing?.not_run_reason, 'harbor_not_completed');
    assert.equal('counts' in result, false);
    assert.equal(JSON.stringify(manifest).includes('\\'), false);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
