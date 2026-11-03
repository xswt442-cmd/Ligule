import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkTimeoutMs, countsOf, positiveInteger, prepareRunDirectory, timeoutBasis } from './lib.ts';
import { outputDirectoryFor, writeManifest } from './manifest.ts';
import type { ManifestPlan, RunIdentity } from './manifest.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const HARBOR_VERSION = '0.25.0';

type Plan = ManifestPlan & {
  schema_version: string;
  dataset: { name: string; version: string; source: string };
  timeout_multipliers: { task: number; agent: number; agent_setup: number; environment_build: number };
  model: { api: string; model_calls: number; timeout_ms: number; request_timeout_ms: number };
  verifier: { reward_key: string; pass_threshold: number; authority: string };
};

type ExecutionStatus = 'completed' | 'failed' | 'timed_out';

function runIdentity(): RunIdentity {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  return {
    gitSha: sha.status === 0 ? sha.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim() !== '' : null,
    node: process.version,
    platform: `${platform()} ${release()}`,
    arch: arch(),
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function commandAvailable(command: string, args: readonly string[]): { ok: boolean; detail: string } {
  const result = spawnSync(command, [...args], { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error !== undefined) return { ok: false, detail: result.error.message };
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, detail: text.slice(0, 500) };
}

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

function resolvedDockerHost(): string | undefined {
  if (process.env.DOCKER_HOST !== undefined) return process.env.DOCKER_HOST;
  const context = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  const host = context.status === 0 ? context.stdout.trim() : '';
  return host === '' ? undefined : host;
}

function harborEnvironment(apiKey: string): NodeJS.ProcessEnv {
  const dockerHost = resolvedDockerHost();
  return {
    ...process.env,
    PYTHONPATH: repository,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...(dockerHost === undefined ? {} : { DOCKER_HOST: dockerHost }),
    LIGULE_API_KEY: apiKey,
  };
}

function trialContainerNames(taskIds: readonly string[]): string[] {
  const listed = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (listed.status !== 0) return [];
  return (listed.stdout ?? '').split(/\r?\n/u).filter((name) =>
    name.includes('__env-main-') && taskIds.some((id) => name.startsWith(`${id}__`)));
}

function removeContainers(names: readonly string[]): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    const result = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    if (result.status === 0) removed.push(name);
    else failed.push(`${name}: ${(result.stderr ?? '').trim().slice(0, 200)}`);
  }
  return { removed, failed };
}

async function runReport(runDirectory: string, apiKey: string): Promise<{
  directory: string;
  json: string;
  markdown: string | null;
  summary: Record<string, unknown>;
  stdout: string;
  stderr: string;
}> {
  const directory = outputDirectoryFor(runDirectory);
  const execution = spawnSync('uv', [
    'run', '--no-project', '--with', `harbor==${HARBOR_VERSION}`,
    'python', 'evals/report/report.py', runDirectory, '--output-dir', directory,
  ], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: harborEnvironment(apiKey),
  });
  if (execution.status !== 0) {
    throw new Error(`report_failed:${execution.status ?? execution.signal ?? 'unknown'}:${(execution.stderr ?? '').slice(-2_000)}`);
  }
  const json = join(directory, 'report.json');
  const files = await readdir(directory);
  const markdownName = files.find((name) => name.endsWith('.md')) ?? null;
  const report = JSON.parse(await readFile(json, 'utf8')) as { summary?: Record<string, unknown> };
  return {
    directory,
    json,
    markdown: markdownName === null ? null : join(directory, markdownName),
    summary: report.summary ?? {},
    stdout: execution.stdout ?? '',
    stderr: execution.stderr ?? '',
  };
}

async function main(): Promise<void> {
  const plan = JSON.parse(await readFile(join(repository, 'evals', 'benchmarks', 'plan.json'), 'utf8')) as Plan;
  const requestedTasks = option('tasks')?.split(',').map((task) => task.trim()).filter(Boolean);
  const tasks = requestedTasks === undefined ? plan.tasks : plan.tasks.filter((task) => requestedTasks.includes(task.id));
  const unknownTasks = requestedTasks?.filter((id) => !plan.tasks.some((task) => task.id === id)) ?? [];
  if (unknownTasks.length > 0) throw new Error(`unknown benchmark tasks: ${unknownTasks.join(', ')}`);
  if (tasks.length === 0) throw new Error('no benchmark tasks selected');
  const timeoutOverride = positiveInteger(option('timeout-ms') ?? process.env.LIGULE_BENCH_TOTAL_TIMEOUT_MS, 'total_timeout_ms');
  const timeoutMs = benchmarkTimeoutMs(plan, tasks.length, timeoutOverride);
  const force = process.argv.includes('--force');
  const collectOnly = process.argv.includes('--collect-only');
  const tarball = option('tarball') ?? process.env.LIGULE_BENCH_TARBALL;
  const datasetRoot = resolve(option('dataset-dir') ?? process.env.LIGULE_BENCH_DATASET_DIR
    ?? join(repository, 'testplace', 'benchmarks', 'datasets', `${plan.dataset.name}@${plan.dataset.version}`));
  const apiKey = process.env.LIGULE_API_KEY;
  const baseUrl = process.env.LIGULE_BENCH_BASE_URL;
  const model = process.env.LIGULE_BENCH_MODEL;
  const api = process.env.LIGULE_BENCH_API ?? plan.model.api;
  if (collectOnly) {
    const requested = option('output');
    if (requested === undefined) throw new Error('collect_only_requires_output_directory');
    const runDirectory = resolve(requested);
    const jobPath = join(runDirectory, 'job.json');
    if (!existsSync(jobPath)) throw new Error(`collect_only_missing_job_json:${jobPath}`);
    const identity = runIdentity();
    const prior = existsSync(join(runDirectory, 'run.json'))
      ? JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8')) as { model?: { baseUrl?: string | null; model?: string | null } }
      : {};
    const collectedModel = model ?? prior.model?.model ?? undefined;
    const collectedBaseUrl = baseUrl ?? prior.model?.baseUrl ?? undefined;
    const manifest = await writeManifest({
      runDirectory, plan: { ...plan, tasks }, identity, model: collectedModel, baseUrl: collectedBaseUrl, jobPath,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });
    let report;
    try { report = await runReport(runDirectory, apiKey ?? 'unused-for-collection'); }
    catch (error) {
      await writeFile(join(runDirectory, 'collection.json'), `${JSON.stringify({
        collectedAt: new Date().toISOString(), manifest: manifest.path, counts: manifest.counts,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)}\n`, 'utf8');
      throw error;
    }
    const counts = countsOf(report.summary) ?? manifest.counts;
    await writeFile(join(runDirectory, 'collection.json'), `${JSON.stringify({
      collectedAt: new Date().toISOString(), manifest: manifest.path, counts,
      report: { directory: report.directory, json: report.json, markdown: report.markdown, summary: report.summary },
    }, null, 2)}\n`, 'utf8');
    process.stdout.write(`Collected existing Harbor output: pass ${counts.pass}, fail ${counts.fail}, infra_error ${counts.infra_error}, not_run ${counts.not_run}, total ${counts.total}\nArtifacts: ${runDirectory}\n`);
    return;
  }
  const nodeRuntime = process.env.LIGULE_BENCH_NODE_RUNTIME;
  const nodeRuntimeSha256 = process.env.LIGULE_BENCH_NODE_RUNTIME_SHA256;
  const defaultRunDirectory = join(repository, 'testplace', 'benchmarks', `agent-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const runDirectory = await prepareRunDirectory(option('output'), force, defaultRunDirectory);

  const checks: Record<string, { ok: boolean; detail: string }> = {
    docker: commandAvailable('docker', ['version', '--format', '{{.Server.Version}}']),
    uv: commandAvailable('uv', ['--version']),
    tarball: { ok: tarball !== undefined && existsSync(tarball), detail: tarball === undefined ? 'LIGULE_BENCH_TARBALL is unset' : resolve(tarball) },
    providerKey: { ok: typeof apiKey === 'string' && apiKey !== '', detail: apiKey === undefined || apiKey === '' ? 'LIGULE_API_KEY is unset' : 'set (value not recorded)' },
    providerBaseUrl: { ok: typeof baseUrl === 'string' && baseUrl !== '', detail: baseUrl ?? 'LIGULE_BENCH_BASE_URL is unset' },
    providerModel: { ok: typeof model === 'string' && model !== '', detail: model ?? 'LIGULE_BENCH_MODEL is unset' },
    nodeRuntime: {
      ok: (nodeRuntime === undefined && nodeRuntimeSha256 === undefined)
        || (nodeRuntime !== undefined && nodeRuntimeSha256 !== undefined && /^[0-9a-f]{64}$/u.test(nodeRuntimeSha256) && existsSync(nodeRuntime)),
      detail: nodeRuntime === undefined && nodeRuntimeSha256 === undefined
        ? 'not supplied; task images must provide Node 24+'
        : nodeRuntime === undefined || nodeRuntimeSha256 === undefined
          ? 'LIGULE_BENCH_NODE_RUNTIME and LIGULE_BENCH_NODE_RUNTIME_SHA256 must be supplied together'
          : `${resolve(nodeRuntime)} sha256=${nodeRuntimeSha256}`,
    },
  };
  if (nodeRuntime !== undefined && nodeRuntimeSha256 !== undefined && existsSync(nodeRuntime)) {
    const actual = await sha256(nodeRuntime);
    if (actual !== nodeRuntimeSha256) checks.nodeRuntime = { ok: false, detail: `runtime digest ${actual} does not match ${nodeRuntimeSha256}` };
  }
  const datasetDirectory = join(datasetRoot, plan.dataset.name);
  const taskRoot = existsSync(join(datasetDirectory, tasks[0]?.id ?? '', 'task.toml')) ? datasetDirectory : datasetRoot;
  const missingTasks = tasks.filter((task) => !existsSync(join(taskRoot, task.id, 'task.toml'))).map((task) => task.id);
  checks.dataset = {
    ok: missingTasks.length === 0,
    detail: missingTasks.length === 0 ? taskRoot : `missing ${missingTasks.join(', ')} under ${taskRoot}; run: uv run --no-project --with harbor==${HARBOR_VERSION} harbor datasets download ${plan.dataset.name}@${plan.dataset.version} -o ${datasetRoot}`,
  };

  const identity = runIdentity();
  const blocked = Object.entries(checks).filter(([, check]) => !check.ok);
  const baseRecord = {
    generatedAt: new Date().toISOString(),
    identity,
    plan,
    datasetRoot,
    checks,
    tarball: tarball === undefined ? null : resolve(tarball),
    tarballSha256: tarball === undefined || !existsSync(tarball) ? null : await sha256(tarball),
    model: { api, baseUrl: baseUrl ?? null, model: model ?? null },
  };
  if (blocked.length > 0) {
    const record = { ...baseRecord, executionStatus: 'blocked', blocked: blocked.map(([name, check]) => ({ name, detail: check.detail })) };
    await writeFile(join(runDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    process.stdout.write(`Agent benchmark BLOCKED\n${blocked.map(([name, check]) => `- ${name}: ${check.detail}`).join('\n')}\nArtifacts: ${runDirectory}\n`);
    process.exitCode = 2;
    return;
  }
  if (identity.gitSha === null) throw new Error('benchmark_requires_git_sha');

  const harborDirectory = join(runDirectory, 'harbor');
  await mkdir(harborDirectory, { recursive: true });
  const job = {
    job_name: `ligule-terminal-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    n_attempts: plan.attempts_per_task,
    n_concurrent_trials: plan.concurrency,
    skip_credential_checks: true,
    timeout_multiplier: plan.timeout_multipliers.task,
    agent_timeout_multiplier: plan.timeout_multipliers.agent,
    agent_setup_timeout_multiplier: plan.timeout_multipliers.agent_setup,
    environment_build_timeout_multiplier: plan.timeout_multipliers.environment_build,
    agents: [{
      import_path: 'evals.harbor.ligule_agent:LiguleAgent',
      model_name: model,
      skip_model_parsing: true,
      kwargs: {
        ligule_tarball: resolve(tarball as string),
        ligule_api: api,
        ligule_base_url: baseUrl,
        ligule_api_key_env: 'LIGULE_API_KEY',
        ligule_model: model,
        ligule_model_calls: plan.model.model_calls,
        ligule_timeout_ms: plan.model.timeout_ms,
        ligule_request_timeout_ms: plan.model.request_timeout_ms,
        ...(nodeRuntime === undefined ? {} : {
          ligule_node_runtime_tarball: resolve(nodeRuntime),
          ligule_node_runtime_sha256: nodeRuntimeSha256,
        }),
        ...(process.env.LIGULE_BENCH_BUILD_TOOLS === '1' ? { ligule_install_build_tools: true } : {}),
        ...(process.env.LIGULE_BENCH_APT_MIRROR === undefined ? {} : { ligule_setup_apt_mirror: process.env.LIGULE_BENCH_APT_MIRROR }),
      },
      env: { LIGULE_API_KEY: '${LIGULE_API_KEY}' },
    }],
    environment: {
      type: 'docker',
      delete: true,
      cpu_enforcement_policy: 'limit',
      memory_enforcement_policy: 'limit',
      override_cpus: 2,
      override_memory_mb: 4096,
      override_storage_mb: 20480,
    },
  };
  const jobPath = join(runDirectory, 'job.json');
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');

  const args = [
    'run', '--no-project', '--with', `harbor==${HARBOR_VERSION}`, 'harbor', 'run',
    '--config', jobPath,
    '--path', taskRoot,
    ...tasks.flatMap((task) => ['--include-task-name', task.id]),
    '--jobs-dir', harborDirectory,
    ...(baseUrl === undefined ? [] : ['--allow-agent-host', new URL(baseUrl).hostname]),
    '--n-attempts', String(plan.attempts_per_task),
    '--n-concurrent', String(plan.concurrency),
    '--max-retries', '0',
    '--yes',
  ];
  const started = new Date().toISOString();
  await writeFile(join(runDirectory, 'run-state.json'), `${JSON.stringify({
    status: 'running',
    started,
    timeoutMs,
    timeoutBasis: timeoutBasis(plan, tasks.length),
    tasks: tasks.map((task) => task.id),
    concurrency: plan.concurrency,
    command: ['uv', ...args],
  }, null, 2)}\n`, 'utf8');

  const execution = spawnSync('uv', args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: harborEnvironment(apiKey as string),
  });
  const finished = new Date().toISOString();
  const timedOut = (execution.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const executionStatus: ExecutionStatus = timedOut ? 'timed_out' : execution.status === 0 ? 'completed' : 'failed';
  const stdoutPath = join(runDirectory, 'harbor.stdout.log');
  const stderrPath = join(runDirectory, 'harbor.stderr.log');
  await writeFile(stdoutPath, execution.stdout ?? '', 'utf8');
  await writeFile(stderrPath, `${execution.stderr ?? ''}${execution.error === undefined ? '' : `\n${execution.error.message}`}\n`, 'utf8');
  await writeFile(join(runDirectory, 'run-state.json'), `${JSON.stringify({
    status: executionStatus,
    timedOut,
    started,
    finished,
    timeoutMs,
    exitCode: execution.status,
    signal: execution.signal,
    error: execution.error?.message ?? null,
  }, null, 2)}\n`, 'utf8');

  const leftovers = executionStatus === 'completed' ? [] : trialContainerNames(tasks.map((task) => task.id));
  const cleanup = leftovers.length === 0 ? { removed: [], failed: [] } : removeContainers(leftovers);

  let manifest;
  let manifestError: string | undefined;
  try {
    manifest = await writeManifest({
      runDirectory, plan: { ...plan, tasks }, identity, model, baseUrl, jobPath, startedAt: started, finishedAt: finished,
    });
  } catch (error) {
    manifestError = error instanceof Error ? error.message : String(error);
  }

  let report;
  let reportError: string | undefined;
  if (manifest !== undefined) {
    try { report = await runReport(runDirectory, apiKey as string); }
    catch (error) { reportError = error instanceof Error ? error.message : String(error); }
  }
  const taskCounts = report === undefined ? manifest?.counts : countsOf(report.summary) ?? manifest?.counts;
  const record = {
    ...baseRecord,
    executionStatus,
    timedOut,
    started,
    finished,
    timeoutMs,
    timeoutBasis: timeoutBasis(plan, tasks.length),
    exitCode: execution.status,
    signal: execution.signal,
    error: execution.error?.message ?? null,
    jobPath,
    harborDirectory,
    stdout: stdoutPath,
    stderr: stderrPath,
    tasks,
    manifest: manifest === undefined ? { error: manifestError } : { path: manifest.path, counts: manifest.counts, results: manifest.results },
    report: report === undefined ? { error: reportError } : {
      directory: report.directory,
      json: report.json,
      markdown: report.markdown,
      summary: report.summary,
    },
    taskCounts: taskCounts ?? null,
    cleanup,
  };
  await writeFile(join(runDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const summaryText = taskCounts === undefined
    ? 'task summary unavailable'
    : `pass ${taskCounts.pass}, fail ${taskCounts.fail}, infra_error ${taskCounts.infra_error}, not_run ${taskCounts.not_run}, total ${taskCounts.total}`;
  process.stdout.write(`Agent benchmark execution ${executionStatus}: ${summaryText}\nArtifacts: ${runDirectory}\n`);
  if (reportError !== undefined) process.stdout.write(`Report generation failed: ${reportError}\n`);
  if (manifestError !== undefined) process.stdout.write(`Manifest generation failed: ${manifestError}\n`);
  if (executionStatus !== 'completed' || reportError !== undefined || manifestError !== undefined) process.exitCode = 1;
}

await main();