import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { policyModeFromPlan } from '../harbor/policy-mode.mjs';

export type PlanTask = { id: string; category: string; covers: string };

export type ManifestPlan = {
  dataset: { name: string; version: string };
  tasks: PlanTask[];
  attempts_per_task: number;
  concurrency: number;
  model: { model_calls: number; timeout_ms: number; request_timeout_ms: number };
  verifier: { reward_key: string; pass_threshold: number };
  policy_mode?: 'auto';
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
  started_at?: unknown;
};

export type TaskCounts = { pass: number; fail: number; infra_error: number; not_run: number; total: number };

export type ManifestResult = {
  path: string;
  attempts: number;
  notRun: number;
  startedWithoutResult: number;
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

function trialResultPath(root: string, path: string): boolean {
  const parts = posixRelative(root, path).split('/');
  return parts.length === 4 && parts[0] === 'harbor' && parts[2].includes('__');
}

export async function writeManifest({
  runDirectory,
  plan,
  identity,
  model,
  baseUrl,
  jobPath,
  jobName,
  startedAt,
  finishedAt,
}: {
  runDirectory: string;
  plan: ManifestPlan;
  identity: RunIdentity;
  model: string | undefined;
  baseUrl: string | undefined;
  jobPath: string;
  jobName: string;
  startedAt: string;
  finishedAt: string;
}): Promise<ManifestResult> {
  if (identity.gitSha === null) throw new Error('manifest_requires_git_sha');
  if (!/^[A-Za-z0-9._-]+$/u.test(jobName) || jobName === '.' || jobName === '..') throw new Error(`unsafe_job_name:${jobName}`);
  const jobDirectory = join(runDirectory, 'harbor', jobName);
  const jobExists = existsSync(jobDirectory);
  const trialFiles = jobExists ? await findFiles(jobDirectory, 'result.json') : [];
  const trialDirectories = jobExists
    ? (await readdir(jobDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.includes('__'))
      .map((entry) => entry.name)
    : [];
  const trials = new Map<string, { path: string; result: HarborTrial }[]>();
  for (const path of trialFiles) {
    if (!trialResultPath(runDirectory, path)) continue;
    let result: HarborTrial;
    try { result = JSON.parse(await readFile(path, 'utf8')) as HarborTrial; }
    catch (error) {
      throw new Error(`malformed_harbor_result:${posixRelative(runDirectory, path)}:${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof result.task_name !== 'string' || typeof result.trial_name !== 'string') {
      throw new Error(`malformed_harbor_result:${posixRelative(runDirectory, path)}`);
    }
    const list = trials.get(result.task_name) ?? [];
    list.push({ path, result });
    trials.set(result.task_name, list);
  }

  const attempts: Record<string, unknown>[] = [];
  for (const task of plan.tasks) {
    const taskTrials = (trials.get(task.id) ?? []).sort((left, right) =>
      String(left.result.started_at ?? left.result.trial_name).localeCompare(String(right.result.started_at ?? right.result.trial_name)));
    const taskTrialDirectories = trialDirectories.filter((name) => name.startsWith(`${task.id}__`)).sort();
    if (plan.attempts_per_task > 1 && taskTrials.length !== plan.attempts_per_task) {
      throw new Error(`repeated_attempt_result_missing:${task.id}:${taskTrials.length}/${plan.attempts_per_task}`);
    }
    for (let index = 0; index < plan.attempts_per_task; index += 1) {
      const trial = taskTrials[index];
      if (trial === undefined) {
        attempts.push({
          task_id: task.id, category: task.category, attempt: index + 1,
          trial_name: null, harbor_task_id: null, result_file: null,
          trajectory_file: null, artifact_files: [],
          not_run_reason: taskTrialDirectories[index] === undefined ? 'harbor_not_completed' : 'trial_started_result_missing',
        });
        continue;
      }
      const resultDirectory = join(trial.path, '..');
      const trajectory = join(resultDirectory, 'agent', 'trajectory.json');
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
    }
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
      policy_mode: policyModeFromPlan(plan.policy_mode),
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
  return {
    path,
    attempts: attempts.length,
    notRun: attempts.filter((attempt) => attempt.not_run_reason !== null).length,
    startedWithoutResult: attempts.filter((attempt) => attempt.not_run_reason === 'trial_started_result_missing').length,
  };
}

export function outputDirectoryFor(runDirectory: string): string {
  const base = join(runDirectory, '..', `${basename(runDirectory)}-report`);
  if (!existsSync(base)) return base;
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  return `${base}-${suffix}`;
}
