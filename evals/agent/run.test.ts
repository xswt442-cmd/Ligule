import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkTimeoutMs, countsOf, createStateWriter, positiveInteger, prepareRunDirectory, readTarballProvenance, setupProxyUrlProblem, timeoutBasis } from './lib.ts';
import { writeManifest } from './manifest.ts';
import { policyModeFromPlan } from '../harbor/policy-mode.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const runner = join(repository, 'evals', 'agent', 'run.ts');

function run(args: readonly string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', runner, ...args], {
    cwd: repository, encoding: 'utf8', windowsHide: true, timeout: options.timeoutMs ?? 30_000,
    env: options.env ?? process.env,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const IDENTITY = {
  gitSha: '0123456789abcdef0123456789abcdef01234567',
  dirty: false,
  node: 'v24.22.1',
  platform: 'test 1.0',
  arch: 'x64',
};

test('a custom plan can select auto without changing the existing plan default', () => {
  assert.equal(policyModeFromPlan(undefined), 'never');
  assert.equal(policyModeFromPlan('auto'), 'auto');
  assert.throws(() => policyModeFromPlan('ask'), /benchmark_policy_mode_invalid/u);
});

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
    await writeFile(`${tarball}.source.json`, 'null\n', 'utf8');
    assert.equal((await readTarballProvenance(tarball, sha)).error, 'source_sidecar_invalid_json');
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

test('apt setup proxy accepts only unauthenticated HTTP(S) origins', () => {
  assert.equal(setupProxyUrlProblem(undefined), undefined);
  assert.equal(setupProxyUrlProblem('http://http.docker.internal:3128'), undefined);
  assert.equal(setupProxyUrlProblem('https://proxy.example:8443/'), undefined);
  assert.notEqual(setupProxyUrlProblem('socks5://proxy.example:1080'), undefined);
  assert.notEqual(setupProxyUrlProblem('http://user:password@proxy.example:3128'), undefined);
  assert.notEqual(setupProxyUrlProblem('http://proxy.example:3128/path'), undefined);
  assert.notEqual(setupProxyUrlProblem('http://proxy.example:3128/?token=secret'), undefined);
});

test('runner blocks and redacts invalid apt setup proxies before writing a Harbor job', async () => {
  const temporaryRoot = join(repository, 'testplace', 'tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'ligule-proxy-blocked-'));
  try {
    const output = join(root, 'run');
    const invalidProxy = 'http://proxy-user:private-value@proxy.example:3128';
    const env: NodeJS.ProcessEnv = { ...process.env, LIGULE_BENCH_SETUP_PROXY_URL: invalidProxy };
    delete env.LIGULE_API_KEY;
    delete env.LIGULE_BENCH_BASE_URL;
    delete env.LIGULE_BENCH_MODEL;
    delete env.LIGULE_BENCH_TARBALL;
    const result = run([
      '--plan', 'evals/agent/canary-plan.json',
      '--tasks', 'canary',
      '--dataset-dir', join(repository, 'evals', 'agent', 'canary', 'ligule-canary'),
      '--output', output,
    ], { env });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const record = JSON.parse(await readFile(join(output, 'run.json'), 'utf8')) as {
      executionStatus: string;
      checks: { setupProxyUrl?: { ok: boolean; detail: string } };
    };
    assert.equal(record.executionStatus, 'blocked');
    assert.equal(record.checks.setupProxyUrl?.ok, false);
    assert.equal(record.checks.setupProxyUrl?.detail, 'LIGULE_BENCH_SETUP_PROXY_URL must be an unauthenticated HTTP(S) origin');
    assert.equal(JSON.stringify(record).includes('private-value'), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes('private-value'), false);
    await assert.rejects(readFile(join(output, 'job.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('a tarball without a provenance sidecar blocks the run instead of borrowing the checkout identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-blocked-'));
  try {
    const tarball = join(root, 'ligule.tgz');
    await writeFile(tarball, 'fixture\n', 'utf8');
    const sha = createHash('sha256').update('fixture\n').digest('hex');
    const output = join(root, 'run');
    const env = { ...process.env };
    delete env.LIGULE_API_KEY;
    delete env.LIGULE_BENCH_TARBALL;
    const result = run(['--output', output, '--tarball', tarball], { env, timeoutMs: 120_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /- provenance: source_sidecar_missing/u);
    const record = JSON.parse(await readFile(join(output, 'run.json'), 'utf8')) as {
      executionStatus: string;
      testedIdentity: { gitSha: string | null; dirty: boolean | null };
      tarballSha256: string | null;
      blocked: { name: string; detail: string }[];
    };
    assert.equal(record.executionStatus, 'blocked');
    assert.equal(record.testedIdentity.gitSha, null);
    assert.equal(record.testedIdentity.dirty, null);
    assert.equal(record.tarballSha256, sha);
    assert.ok(record.blocked.some((entry) => entry.name === 'provenance' && entry.detail.includes(tarball)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a matched provenance sidecar becomes the tested identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-provenance-run-'));
  try {
    const tarball = join(root, 'ligule.tgz');
    await writeFile(tarball, 'fixture\n', 'utf8');
    const sha = createHash('sha256').update('fixture\n').digest('hex');
    await writeFile(`${tarball}.source.json`, `${JSON.stringify({
      schemaVersion: 1, package: 'ligule', version: '0.1.2', tarball: 'ligule.tgz',
      tarballSha256: sha, sourceGitSha: IDENTITY.gitSha, sourceDirty: true,
      buildNodeVersion: 'v24.22.1', buildTimestamp: '2026-01-01T00:00:00.000Z', builder: 'fixture',
    })}\n`, 'utf8');
    const output = join(root, 'run');
    const env = { ...process.env };
    delete env.LIGULE_API_KEY;
    const result = run(['--output', output, '--tarball', tarball], { env, timeoutMs: 120_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /- provenance: /u);
    const record = JSON.parse(await readFile(join(output, 'run.json'), 'utf8')) as {
      testedIdentity: { gitSha: string | null; dirty: boolean | null };
      sourceProvenance: { sourceGitSha?: string };
    };
    assert.equal(record.testedIdentity.gitSha, IDENTITY.gitSha);
    assert.equal(record.testedIdentity.dirty, true);
    assert.equal(record.sourceProvenance.sourceGitSha, IDENTITY.gitSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run state writes stay ordered when a late spawn update follows them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-state-'));
  try {
    const path = join(root, 'run-state.json');
    const write = createStateWriter(path);
    // 模拟 onSpawn 的异步写晚到：三次写同时排队，最终落盘的必须是最新状态。
    const pending = [write({ status: 'running', harborPid: null }), write({ status: 'collecting' }), write({ status: 'finished' })];
    await Promise.all(pending);
    const state = JSON.parse(await readFile(path, 'utf8')) as { status: string };
    assert.equal(state.status, 'finished');
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
    await write({ status: 'running' });
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as { status: string }).status, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed state write does not strand the queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-state-fail-'));
  try {
    const missingDirectory = join(root, 'absent', 'run-state.json');
    const write = createStateWriter(missingDirectory);
    await assert.rejects(() => write({ status: 'running' }));
    const path = join(root, 'run-state.json');
    const healthy = createStateWriter(path);
    await healthy({ status: 'finished' });
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as { status: string }).status, 'finished');
  } finally {
    await rm(root, { recursive: true, force: true });
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
    // 评测固定用 never 跑：容器里没人能回答审批，manifest 必须记下真实档位。
    assert.equal(manifest.experiment.policy_mode, 'never');
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

    await writeManifest({
      runDirectory, plan: { ...plan, policy_mode: 'auto' }, identity: IDENTITY, model: 'fixture-model', baseUrl: 'https://provider.invalid/v1',
      jobPath: job, jobName: 'job-1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T01:00:00.000Z',
    });
    const autoManifest = JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8')) as {
      experiment: Record<string, unknown>;
    };
    assert.equal(autoManifest.experiment.policy_mode, 'auto');
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
