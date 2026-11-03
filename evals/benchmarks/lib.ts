import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskCounts } from './manifest.ts';

export type ProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
  terminationPending: boolean;
  terminationError?: string;
  error?: string;
};

export function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function runProcess(
  command: string,
  args: readonly string[],
  { cwd, env, timeoutMs, maxBytes = 64 * 1024 * 1024 }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBytes?: number;
  },
): Promise<ProcessResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let terminationPending = false;
    let terminationError: string | undefined;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      return next.length > maxBytes ? next.slice(next.length - maxBytes) : next;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finish = (status: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      resolveRun({ status, signal, stdout, stderr, timedOut, interrupted, terminationPending, ...(terminationError === undefined ? {} : { terminationError }), ...(error === undefined ? {} : { error }) });
    };
    const killTree = (): void => {
      if (process.platform === 'win32') {
        if (child.pid !== undefined) {
          const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
          if (result.status !== 0) terminationError = `${result.stderr ?? ''}${result.error?.message ?? ''}`.trim().slice(0, 500) || 'taskkill_failed';
        }
      } else {
        try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); }
        catch (error) {
          terminationError = error instanceof Error ? error.message : String(error);
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }
      }
      setTimeout(() => {
        terminationPending = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null, 'SIGKILL');
      }, 10_000).unref();
    };
    const onInterrupt = (): void => {
      interrupted = true;
      clearTimeout(timer);
      killTree();
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      finish(null, null, error.message);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      finish(status, signal);
    });
  });
}

export function safeProviderUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function providerUrlProblem(value: string | undefined): string | undefined {
  if (value === undefined) return 'LIGULE_BENCH_BASE_URL is unset';
  let url: URL;
  try { url = new URL(value); } catch { return 'LIGULE_BENCH_BASE_URL is invalid'; }
  if (url.username !== '' || url.password !== '') return 'LIGULE_BENCH_BASE_URL must not contain URL credentials';
  for (const key of url.searchParams.keys()) {
    if (/(?:key|token|secret|auth|password)/iu.test(key)) return `LIGULE_BENCH_BASE_URL must not contain credential query parameter ${key}`;
  }
  return undefined;
}

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
    const runFile = resolve(directory, 'run.json');
    if (!existsSync(runFile)) throw new Error(`output_directory_not_benchmark_run:${directory}`);
    let record: { identity?: unknown; plan?: unknown; executionStatus?: unknown };
    try { record = JSON.parse(await readFile(runFile, 'utf8')) as typeof record; }
    catch { throw new Error(`output_directory_not_benchmark_run:${directory}:invalid_run_json`); }
    if (record.identity === undefined || (record.plan === undefined && record.executionStatus !== 'blocked')) {
      throw new Error(`output_directory_not_benchmark_run:${directory}`);
    }
    const stateFile = resolve(directory, 'run-state.json');
    if (existsSync(stateFile)) {
      let state: { status?: unknown; pid?: unknown };
      try { state = JSON.parse(await readFile(stateFile, 'utf8')) as typeof state; }
      catch { throw new Error(`run_state_invalid:${directory}`); }
      if (state.status === 'running' && isProcessAlive(state.pid)) {
        throw new Error(`active_benchmark_run:${directory}; stop it or use --collect-only`);
      }
    }
    const previous = `${directory}.previous-${stamp}`;
    await rename(directory, previous);
    process.stdout.write(`Preserved existing output at ${previous}\n`);
  }
  await mkdir(directory, { recursive: true });
  return directory;
}
