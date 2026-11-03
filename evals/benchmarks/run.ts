import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));

type PlanTask = { id: string; category: string; covers: string };
type Plan = {
  schema_version: string;
  dataset: { name: string; version: string; source: string };
  tasks: PlanTask[];
  attempts_per_task: number;
  concurrency: number;
  model: { api: string; model_calls: number; timeout_ms: number; request_timeout_ms: number };
  verifier: { reward_key: string; pass_threshold: number; authority: string };
};

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

async function main(): Promise<void> {
  const plan = JSON.parse(await readFile(join(repository, 'evals', 'benchmarks', 'plan.json'), 'utf8')) as Plan;
  const requestedTasks = option('tasks')?.split(',').map((task) => task.trim()).filter(Boolean);
  const tasks = requestedTasks === undefined ? plan.tasks : plan.tasks.filter((task) => requestedTasks.includes(task.id));
  const unknownTasks = requestedTasks?.filter((id) => !plan.tasks.some((task) => task.id === id)) ?? [];
  if (unknownTasks.length > 0) throw new Error(`unknown benchmark tasks: ${unknownTasks.join(', ')}`);
  if (tasks.length === 0) throw new Error('no benchmark tasks selected');
  const tarball = option('tarball') ?? process.env.LIGULE_BENCH_TARBALL;
  const datasetRoot = resolve(option('dataset-dir') ?? process.env.LIGULE_BENCH_DATASET_DIR
    ?? join(repository, 'testplace', 'benchmarks', 'datasets', `${plan.dataset.name}@${plan.dataset.version}`));
  const apiKey = process.env.LIGULE_API_KEY;
  const baseUrl = process.env.LIGULE_BENCH_BASE_URL;
  const model = process.env.LIGULE_BENCH_MODEL;
  const api = process.env.LIGULE_BENCH_API ?? plan.model.api;
  const nodeRuntime = process.env.LIGULE_BENCH_NODE_RUNTIME;
  const nodeRuntimeSha256 = process.env.LIGULE_BENCH_NODE_RUNTIME_SHA256;
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
    detail: missingTasks.length === 0 ? taskRoot : `missing ${missingTasks.join(', ')} under ${taskRoot}; run: uv run --no-project --with harbor==0.25.0 harbor datasets download ${plan.dataset.name}@${plan.dataset.version} -o ${datasetRoot}`,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = resolve(option('output') ?? join(repository, 'testplace', 'benchmarks', `agent-${stamp}`));
  await mkdir(runDirectory, { recursive: true });
  const blocked = Object.entries(checks).filter(([, check]) => !check.ok);
  const baseRecord = {
    generatedAt: new Date().toISOString(),
    plan,
    datasetRoot,
    checks,
    tarball: tarball === undefined ? null : resolve(tarball),
    tarballSha256: tarball === undefined || !existsSync(tarball) ? null : await sha256(tarball),
    model: { api, baseUrl: baseUrl ?? null, model: model ?? null },
  };
  if (blocked.length > 0) {
    const record = { ...baseRecord, status: 'BLOCKED', blocked: blocked.map(([name, check]) => ({ name, detail: check.detail })) };
    await writeFile(join(runDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    process.stdout.write(`Agent benchmark BLOCKED\n${blocked.map(([name, check]) => `- ${name}: ${check.detail}`).join('\n')}\nArtifacts: ${runDirectory}\n`);
    process.exitCode = 2;
    return;
  }

  const harborDirectory = join(runDirectory, 'harbor');
  await mkdir(harborDirectory, { recursive: true });
  const job = {
    job_name: `ligule-terminal-bench-${stamp}`,
    n_attempts: plan.attempts_per_task,
    n_concurrent_trials: plan.concurrency,
    skip_credential_checks: true,
    timeout_multiplier: 1.0,
    agent_timeout_multiplier: 1.0,
    agent_setup_timeout_multiplier: 1.0,
    environment_build_timeout_multiplier: 1.0,
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
    'run', '--no-project', '--with', 'harbor==0.25.0', 'harbor', 'run',
    '--config', jobPath,
    '--path', taskRoot,
    ...tasks.flatMap((task) => ['--include-task-name', task.id]),
    '--jobs-dir', harborDirectory,
    '--n-attempts', String(plan.attempts_per_task),
    '--n-concurrent', String(plan.concurrency),
    '--max-retries', '0',
    '--yes',
  ];
  const started = new Date().toISOString();
  const execution = spawnSync('uv', args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONPATH: repository,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      NO_COLOR: '1',
      TERM: 'dumb',
      ...(resolvedDockerHost() === undefined ? {} : { DOCKER_HOST: resolvedDockerHost() as string }),
      LIGULE_API_KEY: apiKey,
    },
  });
  const finished = new Date().toISOString();
  const stdoutPath = join(runDirectory, 'harbor.stdout.log');
  const stderrPath = join(runDirectory, 'harbor.stderr.log');
  await writeFile(stdoutPath, execution.stdout ?? '', 'utf8');
  await writeFile(stderrPath, execution.stderr ?? '', 'utf8');
  const record = {
    ...baseRecord,
    status: execution.status === 0 ? 'COMPLETED' : 'FAILED',
    started,
    finished,
    exitCode: execution.status,
    signal: execution.signal,
    jobPath,
    harborDirectory,
    stdout: stdoutPath,
    stderr: stderrPath,
    tasks,
  };
  await writeFile(join(runDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`Agent benchmark ${record.status}: exit ${execution.status}\nArtifacts: ${runDirectory}\n`);
  if (execution.status !== 0) process.exitCode = 1;
}

await main();
