import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskCounts } from './manifest.ts';

export function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name}_must_be_positive_integer`);
  return parsed;
}

export function benchmarkTimeoutMs(
  plan: { tasks: readonly unknown[]; concurrency: number; timeout_multipliers: { task: number; agent: number; agent_setup: number } },
  taskCount: number,
  override: number | undefined,
): number {
  if (override !== undefined) return override;
  const waves = Math.ceil(taskCount / Math.max(1, plan.concurrency));
  const perTaskSeconds = 900 * plan.timeout_multipliers.task
    + 900 * plan.timeout_multipliers.agent
    + 360 * plan.timeout_multipliers.agent_setup
    + 300;
  return Math.max(30 * 60 * 1000, Math.ceil(waves * perTaskSeconds * 1.5) * 1000);
}

export function timeoutBasis(plan: { concurrency: number; timeout_multipliers: { task: number; agent: number; agent_setup: number } }, taskCount: number): {
  waves: number; perTaskSeconds: number; multiplier: number;
} {
  const waves = Math.ceil(taskCount / Math.max(1, plan.concurrency));
  return {
    waves,
    perTaskSeconds: 900 * plan.timeout_multipliers.task
      + 900 * plan.timeout_multipliers.agent
      + 360 * plan.timeout_multipliers.agent_setup
      + 300,
    multiplier: 1.5,
  };
}

export function countsOf(summary: Record<string, unknown>): TaskCounts | undefined {
  const keys = ['pass', 'fail', 'infra_error', 'not_run', 'attempts'] as const;
  if (!keys.every((key) => typeof summary[key] === 'number')) return undefined;
  return {
    pass: summary.pass as number,
    fail: summary.fail as number,
    infra_error: summary.infra_error as number,
    not_run: summary.not_run as number,
    total: summary.attempts as number,
  };
}

export async function prepareRunDirectory(requested: string | undefined, force: boolean, defaultDirectory: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (requested === undefined) {
    await mkdir(defaultDirectory, { recursive: true });
    return defaultDirectory;
  }
  const directory = resolve(requested);
  if (existsSync(directory)) {
    if (!force) throw new Error(`output_directory_exists:${directory}; pass --force to preserve it as a previous run`);
    const previous = `${directory}.previous-${stamp}`;
    await rename(directory, previous);
    process.stdout.write(`Preserved existing output at ${previous}\n`);
  }
  await mkdir(directory, { recursive: true });
  return directory;
}
