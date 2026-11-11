import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskCounts } from './manifest.ts';

export type ProcessResult = {
  pid?: number;
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

// 运行状态的写入必须串行且原子：启动阶段的 `onSpawn` 是异步写，晚于 `collecting`/`finished`
// 落盘就会把状态倒回 `running`，让恢复逻辑以为原进程还活着。临时文件 + rename 避免半截 JSON。
export function createStateWriter(path: string): (value: unknown) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (value: unknown) => {
    const next = queue.then(async () => {
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
    });
    queue = next.catch(() => undefined);
    return next;
  };
}

export async function activeBenchmarkOwner(directory: string): Promise<string | undefined> {
  for (const name of ['run-state.json', 'collect-state.json']) {
    const path = resolve(directory, name);
    if (!existsSync(path)) continue;
    let state: { status?: unknown; pid?: unknown; harborPid?: unknown };
    try { state = JSON.parse(await readFile(path, 'utf8')) as typeof state; }
    catch { throw new Error(`run_state_invalid:${path}`); }
    if (state.status === 'running' || state.status === 'collecting') {
      if (isProcessAlive(state.pid)) return `${name}:${state.status}:pid=${String(state.pid)}`;
      if (isProcessAlive(state.harborPid) || isProcessGroupAlive(state.harborPid)) {
        return `${name}:${state.status}:harborPid=${String(state.harborPid)}`;
      }
    }
  }
  return undefined;
}

export function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isProcessGroupAlive(pid: unknown): boolean {
  if (process.platform === 'win32' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Windows 上父进程退出后 PID 会被系统回收，进程组也不存在，只能靠 WMI 里仍然保留的
 * `ParentProcessId` 找回后代。只收掉创建时间晚于本次启动的那些，避免误杀复用同一 PID 的无关进程。
 */
function stopWindowsDescendants(pid: number, spawnedAt: number): void {
  const script = [
    `$root = ${pid}`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${spawnedAt})`,
    '$all = @()',
    '$frontier = @($root)',
    'for ($i = 0; $i -lt 5; $i++) {',
    '  $next = @()',
    '  foreach ($parent in $frontier) {',
    '    foreach ($child in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue)) {',
    '      if ($child.CreationDate -ge $since) { $next += $child.ProcessId; $all += $child.ProcessId }',
    '    }',
    '  }',
    '  $frontier = $next',
    '}',
    'foreach ($target in $all) { Stop-Process -Id $target -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 20_000, windowsHide: true });
  } catch { /* 清理是尽力而为：失败不应改变 Run 的结论 */ }
}

export async function runProcess(
  command: string,
  args: readonly string[],
  { cwd, env, timeoutMs, maxBytes = 64 * 1024 * 1024, onSpawn }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBytes?: number;
    onSpawn?: (pid: number | undefined) => void;
  },
): Promise<ProcessResult> {
  return new Promise((resolveRun) => {
    // 记录启动时刻：Windows 上清理后代时用它把“本次的子进程”和复用同一 PID 的无关进程区分开。
    const spawnedAt = Date.now();
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    onSpawn?.(child.pid);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let terminationPending = false;
    let terminationError: string | undefined;
    let settled = false;
    let exitStatus: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exited = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let descendantTimer: NodeJS.Timeout | undefined;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      return next.length > maxBytes ? next.slice(next.length - maxBytes) : next;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finish = (status: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      if (descendantTimer !== undefined) clearTimeout(descendantTimer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      resolveRun({ pid: child.pid, status, signal, stdout, stderr, timedOut, interrupted, terminationPending, ...(terminationError === undefined ? {} : { terminationError }), ...(error === undefined ? {} : { error }) });
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
        // 只有进程本身还活着才算“终止仍未完成”；已经退出但管道被后代持有的，按真实退出码收口。
        terminationPending = !exited;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(exited ? exitStatus : null, exited ? exitSignal : 'SIGKILL', exited
          ? undefined
          : 'termination_pending: the process was still running 10000ms after the kill request');
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
    child.once('exit', (status, signal) => {
      exited = true;
      exitStatus = status;
      exitSignal = signal;
      // 进程已经退出，别再让它去 taskkill 一个可能被系统复用的 PID。
      clearTimeout(timer);
      // 父进程退出不代表后代退出：它们仍持有管道，可能继续消耗模型额度。
      // POSIX 上父进程是进程组组长，按组收掉；Windows 没有进程组，按 WMI 里的父子关系收掉。
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          // 正常退出的进程没有后代占管道，close 会很快触发；只有它还迟迟不来才值得启动一次
          // PowerShell 去查父子关系，避免每次评测都多付一份进程启动开销。
          descendantTimer = setTimeout(() => {
            if (!settled && child.pid !== undefined) stopWindowsDescendants(child.pid, spawnedAt);
          }, 250);
          descendantTimer.unref();
        } else if (isProcessGroupAlive(child.pid)) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
        }
      }
      // 进程已退出但管道可能仍被后代持有，close 因而永不触发：留一点排空时间后强制收口。
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(status, signal);
      }, 2_000);
      drainTimer.unref();
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      finish(status, signal);
    });
  });
}

export type TarballProvenance = {
  sourceGitSha: string;
  sourceDirty: boolean;
  tarballSha256: string;
  buildNodeVersion: string;
  buildTimestamp: string;
};

export async function readTarballProvenance(tarball: string, actualSha256: string): Promise<{
  provenance?: TarballProvenance;
  error?: string;
}> {
  const path = `${tarball}.source.json`;
  if (!existsSync(path)) return { error: 'source_sidecar_missing' };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'source_sidecar_invalid_json' };
    raw = parsed as Record<string, unknown>;
  } catch { return { error: 'source_sidecar_invalid_json' }; }
  if (raw.schemaVersion !== 1) return { error: 'source_sidecar_unsupported' };
  if (typeof raw.tarballSha256 !== 'string' || raw.tarballSha256 !== actualSha256) return { error: 'source_sidecar_digest_mismatch' };
  if (typeof raw.sourceGitSha !== 'string' || !/^[0-9a-f]{40}$/u.test(raw.sourceGitSha)) return { error: 'source_sidecar_git_sha_invalid' };
  if (typeof raw.sourceDirty !== 'boolean') return { error: 'source_sidecar_dirty_invalid' };
  if (typeof raw.buildNodeVersion !== 'string' || typeof raw.buildTimestamp !== 'string') return { error: 'source_sidecar_build_metadata_invalid' };
  return {
    provenance: {
      sourceGitSha: raw.sourceGitSha,
      sourceDirty: raw.sourceDirty,
      tarballSha256: raw.tarballSha256,
      buildNodeVersion: raw.buildNodeVersion,
      buildTimestamp: raw.buildTimestamp,
    },
  };
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

export function setupProxyUrlProblem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return 'LIGULE_BENCH_SETUP_PROXY_URL is invalid'; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.hostname === '' || url.username !== '' || url.password !== ''
    || (url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return 'LIGULE_BENCH_SETUP_PROXY_URL must be an unauthenticated HTTP(S) origin';
  }
  return undefined;
}

export function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name}_must_be_positive_integer`);
  return parsed;
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

export function benchmarkTimeoutMs(
  plan: { tasks: readonly unknown[]; concurrency: number; timeout_multipliers: { task: number; agent: number; agent_setup: number } },
  taskCount: number,
  override: number | undefined,
): number {
  if (override !== undefined) return override;
  // 与报告里的基数同源：改系数只需要改一处。
  const basis = timeoutBasis(plan, taskCount);
  return Math.max(30 * 60 * 1000, Math.ceil(basis.waves * basis.perTaskSeconds * basis.multiplier) * 1000);
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
    const owner = await activeBenchmarkOwner(directory);
    if (owner !== undefined) throw new Error(`active_benchmark_run:${directory}:${owner}`);
    const previous = `${directory}.previous-${stamp}`;
    await rename(directory, previous);
    process.stdout.write(`Preserved existing output at ${previous}\n`);
  }
  await mkdir(directory, { recursive: true });
  return directory;
}
