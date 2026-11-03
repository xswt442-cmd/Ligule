import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

export type Sample = Record<string, number | string | boolean | null>;

export type ScenarioResult = {
  name: string;
  status: 'ok' | 'blocked' | 'error';
  reason?: string;
  samples: Sample[];
  notes?: Record<string, unknown>;
};

export type ScenarioOptions = {
  repeats: number;
  warmup: number;
  workRoot: string;
};

export type Scenario = {
  name: string;
  run(options: ScenarioOptions): Promise<ScenarioResult>;
};

export function statistic(values: readonly number[]): Record<string, number> {
  if (values.length === 0) return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

export function environmentInformation(repository: string): Record<string, unknown> {
  const git = spawnSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    gitSha: sha.status === 0 ? sha.stdout.trim() : null,
    dirty: git.status === 0 ? git.stdout.trim() !== '' : null,
  };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const NON_METRIC = new Set(['workload', 'events', 'outputBytes', 'bytes', 'tools', 'resultBytes']);

export function summaryOf(result: ScenarioResult): Record<string, Record<string, Record<string, number>>> {
  const workloads = new Map<string, Map<string, number[]>>();
  for (const sample of result.samples) {
    const workload = typeof sample.workload === 'string' ? sample.workload : 'default';
    const metrics = workloads.get(workload) ?? new Map<string, number[]>();
    for (const [key, value] of Object.entries(sample)) {
      if (NON_METRIC.has(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
      const values = metrics.get(key) ?? [];
      values.push(value);
      metrics.set(key, values);
    }
    workloads.set(workload, metrics);
  }
  return Object.fromEntries([...workloads.entries()].map(([workload, metrics]) => [
    workload,
    Object.fromEntries([...metrics.entries()].map(([key, values]) => [key, statistic(values)])),
  ]));
}

export function markdownReport(summary: {
  generatedAt: string;
  environment: Record<string, unknown>;
  scenarios: { name: string; status: string; reason?: string; metrics: Record<string, Record<string, Record<string, number>>> }[];
}): string {
  const lines = [
    '# Ligule harness performance',
    '',
    `Generated: ${summary.generatedAt}`,
    '',
    '## Environment',
    '',
    ...Object.entries(summary.environment).map(([key, value]) => `- ${key}: ${String(value)}`),
    '',
  ];
  for (const scenario of summary.scenarios) {
    lines.push(`## ${scenario.name}`, '');
    lines.push(`Status: ${scenario.status}${scenario.reason === undefined ? '' : ` (${scenario.reason})`}`, '');
    for (const [workload, metrics] of Object.entries(scenario.metrics)) {
      lines.push(`### ${workload}`, '');
      lines.push('| metric | min | p50 | p95 | max | mean |', '| --- | --- | --- | --- | --- | --- |');
      for (const [metric, values] of Object.entries(metrics)) {
        lines.push(`| ${metric} | ${values.min.toFixed(2)} | ${values.p50.toFixed(2)} | ${values.p95.toFixed(2)} | ${values.max.toFixed(2)} | ${values.mean.toFixed(2)} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
