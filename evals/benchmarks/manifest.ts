import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

export type PlanTask = { id: string; category: string; covers: string };

export type ManifestPlan = {
  dataset: { name: string; version: string };
  tasks: PlanTask[];
  attempts_per_task: number;
  concurrency: number;
  model: { model_calls: number; timeout_ms: number; request_timeout_ms: number };
  verifier: { reward_key: string; pass_threshold: number };
};

export type RunIdentity = {
  gitSha: string | null;
  dirty: boolean | null;
  node: string;
  platform: string;
  arch: string;
};

type HarborTrial = {
  task_name?: unknown;
  trial_name?: unknown;
  task_id?: unknown;
  exception_info?: unknown;
  verifier_result?: { rewards?: Record<string, unknown> } | null;
  started_at?: unknown;
  finished_at?: unknown;
};

export type TaskCounts = { pass: number; fail: number; infra_error: number; not_run: number; total: number };

export type ManifestResult = {
  path: string;
  counts: TaskCounts;
  results: { taskId: string; status: string; reward: number | null }[];
};

async function findFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) found.push(join(entry.parentPath, entry.name));
  }
  return found.sort();
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function numericReward(result: HarborTrial, key: string): number | null {
  const value = result.verifier_result?.rewards?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function classify(result: HarborTrial, key: string, threshold: number): { status: string; reward: number | null } {
  const reward = numericReward(result, key);
  if (result.exception_info !== null && result.exception_info !== undefined) return { status: 'infra_error', reward };
  if (reward === null) return { status: 'infra_error', reward: null };
  return { status: reward >= threshold ? 'pass' : 'fail', reward };
}

export async function writeManifest({
  runDirectory,
  plan,
  identity,
  model,
  baseUrl,
  jobPath,
  startedAt,
  finishedAt,
}: {
  runDirectory: string;
  plan: ManifestPlan;
  identity: RunIdentity;
  model: string | undefined;
  baseUrl: string | undefined;
  jobPath: string;
  startedAt: string;
  finishedAt: string;
}): Promise<ManifestResult> {
  if (identity.gitSha === null) throw new Error('manifest_requires_git_sha');
  const harborDirectory = join(runDirectory, 'harbor');
  const trialFiles = existsSync(harborDirectory) ? await findFiles(harborDirectory, 'result.json') : [];
  const trials = new Map<string, { path: string; result: HarborTrial }[]>();
  for (const path of trialFiles) {
    let result: HarborTrial;
    try { result = JSON.parse(await readFile(path, 'utf8')) as HarborTrial; }
    catch { continue; }
    if (typeof result.task_name !== 'string' || typeof result.trial_name !== 'string') continue;
    const list = trials.get(result.task_name) ?? [];
    list.push({ path, result });
    trials.set(result.task_name, list);
  }

  const attempts: Record<string, unknown>[] = [];
  const classifications: ManifestResult['results'] = [];
  for (const task of plan.tasks) {
    const taskTrials = (trials.get(task.id) ?? []).sort((left, right) => String(left.result.trial_name).localeCompare(String(right.result.trial_name)));
    if (taskTrials.length === 0) {
      attempts.push({
        task_id: task.id, category: task.category, attempt: 1,
        trial_name: null, harbor_task_id: null, result_file: null,
        trajectory_file: null, artifact_files: [], not_run_reason: 'harbor_not_completed',
      });
      classifications.push({ taskId: task.id, status: 'not_run', reward: null });
      continue;
    }
    taskTrials.slice(0, plan.attempts_per_task).forEach((trial, index) => {
      const resultDirectory = join(trial.path, '..');
      const trajectory = join(resultDirectory, 'agent', 'trajectory.json');
      const classified = classify(trial.result, plan.verifier.reward_key, plan.verifier.pass_threshold);
      attempts.push({
        task_id: task.id,
        category: task.category,
        attempt: index + 1,
        trial_name: trial.result.trial_name,
        harbor_task_id: trial.result.task_id,
        result_file: posixRelative(runDirectory, trial.path),
        trajectory_file: existsSync(trajectory) ? posixRelative(runDirectory, trajectory) : null,
        artifact_files: [],
        not_run_reason: null,
      });
      classifications.push({ taskId: task.id, status: classified.status, reward: classified.reward });
    });
  }

  const configBytes = await readFile(jobPath);
  const manifest = {
    schema_version: 'ligule.eval-manifest.v1',
    experiment: {
      id: `ligule-${plan.dataset.name}-${startedAt.replace(/[:.]/g, '-')}`,
      git_sha: identity.gitSha,
      working_tree_dirty: identity.dirty === true,
      runner_name: 'harbor',
      runner_version: '0.25.0',
      dataset_id: plan.dataset.name,
      dataset_revision: plan.dataset.version,
      docker_image_digest: null,
      model_id: model ?? null,
      provider: baseUrl === undefined ? null : new URL(baseUrl).hostname,
      config_sha256: createHash('sha256').update(configBytes).digest('hex'),
      tool_mode: 'default',
      policy_mode: 'auto',
      permissions: { profile: 'full-access', network: 'unrestricted', container: 'harbor-task' },
      limits: {
        attempts_per_task: plan.attempts_per_task,
        concurrency: plan.concurrency,
        model_calls: plan.model.model_calls,
        timeout_ms: plan.model.timeout_ms,
        request_timeout_ms: plan.model.request_timeout_ms,
      },
      node_version: identity.node,
      os: identity.platform,
      started_at: startedAt,
      finished_at: finishedAt,
      expected_evaluation: `${plan.tasks.length} tasks x ${plan.attempts_per_task} attempts`,
    },
    verifier: {
      result_schema: 'harbor.models.trial.result.TrialResult@0.25.0',
      reward_key: plan.verifier.reward_key,
      pass_threshold: plan.verifier.pass_threshold,
    },
    attempts,
  };
  const path = join(runDirectory, 'manifest.json');
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const counts: TaskCounts = { pass: 0, fail: 0, infra_error: 0, not_run: 0, total: attempts.length };
  for (const entry of classifications) {
    if (entry.status === 'pass') counts.pass += 1;
    else if (entry.status === 'fail') counts.fail += 1;
    else if (entry.status === 'not_run') counts.not_run += 1;
    else counts.infra_error += 1;
  }
  return { path, counts, results: classifications };
}

export function outputDirectoryFor(runDirectory: string): string {
  const base = join(runDirectory, '..', `${basename(runDirectory)}-report`);
  if (!existsSync(base)) return base;
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  return `${base}-${suffix}`;
}
