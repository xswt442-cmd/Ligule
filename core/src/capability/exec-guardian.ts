// 实际命令只在守护进程加入 Job 后创建，父进程死亡由 IPC 断开通知。
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { KernelError } from '../errors.js';
import {
  createAppContainerProfile,
  runAppContainerCommand,
  type AppContainerProfile,
} from './windows-appcontainer-process.js';
import { createOwnedProcessJob, type OwnedProcessJob } from './win32-job.js';
import {
  createAppContainerDirectoryReadGrant, grantAppContainerDirectoryRead, grantRestrictedDirectoryWrite,
  revokeAppContainerDirectoryRead, revokeRestrictedDirectoryWrite,
} from './windows-appcontainer-acl.js';
import type { AppContainerDirectoryReadGrant } from './windows-appcontainer-acl.js';
import { randomWorkspaceRestrictedSid, runRestrictedWindowsCommand } from './windows-restricted-process.js';
import type { WindowsCommandLaunch } from './windows-command.js';

interface GuardianStartup {
  readonly executable: string;
  readonly args: readonly string[];
  readonly launch: WindowsCommandLaunch | undefined;
}

const GUARDIAN_LAUNCH_ARGUMENT = '--ligule-guardian-launch-v1';

let job: OwnedProcessJob | undefined;
let disconnected = !process.connected;
let cancelled = false;
let finishing = false;
let linuxCleanup: Promise<void> | undefined;

function cleanupOutcomeCode(primaryError: unknown): 'exec_sandbox_cleanup_failed' | 'exec_termination_cleanup_failed' {
  const code = typeof primaryError === 'object' && primaryError !== null && 'code' in primaryError
    ? primaryError.code : undefined;
  return primaryError === undefined || code === 'exec_cancelled' || code === 'exec_spawn_failed'
    || code === 'exec_process_interrupted' || code === 'exec_sandbox_setup_failed'
    || code === 'exec_sandbox_cleanup_failed' || code === 'exec_temp_cleanup_failed'
    || code === 'exec_script_snapshot_cleanup_failed'
    ? 'exec_sandbox_cleanup_failed'
    : 'exec_termination_cleanup_failed';
}

function commandFailure(error: unknown, commandStarted: boolean): KernelError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const known = typeof code === 'string' && [
    'exec_cancelled', 'exec_spawn_failed', 'exec_process_interrupted', 'exec_sandbox_setup_failed',
    'exec_sandbox_cleanup_failed', 'exec_temp_cleanup_failed', 'exec_script_snapshot_cleanup_failed',
    'exec_terminate_failed', 'exec_termination_cleanup_failed', 'exec_guardian_failed', 'exec_guardian_protocol',
  ].includes(code);
  if (known && error instanceof KernelError) return error;
  const normalizedCode = known ? code as string : commandStarted ? 'exec_guardian_failed' : 'exec_sandbox_setup_failed';
  return new KernelError(normalizedCode, {
    cause: error,
    detail: error instanceof Error ? error.message : undefined,
  });
}

function parseGuardianStartup(argv: readonly string[]): GuardianStartup {
  if (argv[0] !== GUARDIAN_LAUNCH_ARGUMENT) {
    const [executable, ...args] = argv;
    if (executable === undefined || executable === '') throw new Error('exec_guardian_executable_required');
    return { executable, args, launch: undefined };
  }
  const serializedLaunch = argv[1];
  if (serializedLaunch === undefined || argv[2] !== '--') throw new Error('exec_guardian_startup_protocol');
  let launchValue: unknown;
  try {
    launchValue = JSON.parse(serializedLaunch) as unknown;
  } catch (cause) {
    throw new Error('exec_guardian_startup_protocol', { cause });
  }
  let launch: WindowsCommandLaunch | undefined;
  if (launchValue !== null) {
    if (typeof launchValue !== 'object' || launchValue === null || !('kind' in launchValue)) {
      throw new Error('exec_guardian_startup_protocol');
    }
    if (launchValue.kind === 'appcontainer'
      && 'workspaceRoot' in launchValue && typeof launchValue.workspaceRoot === 'string'
      && launchValue.workspaceRoot.trim() !== '' && !launchValue.workspaceRoot.includes('\0')) {
      launch = { kind: 'appcontainer', workspaceRoot: launchValue.workspaceRoot };
    } else if (launchValue.kind === 'restricted-token'
      && 'workspaceRoot' in launchValue && typeof launchValue.workspaceRoot === 'string'
      && launchValue.workspaceRoot.trim() !== '' && !launchValue.workspaceRoot.includes('\0')
      && 'tempDirectory' in launchValue && typeof launchValue.tempDirectory === 'string'
      && launchValue.tempDirectory.trim() !== '' && !launchValue.tempDirectory.includes('\0')
      && 'aclLockRoot' in launchValue && typeof launchValue.aclLockRoot === 'string'
      && launchValue.aclLockRoot.trim() !== '' && !launchValue.aclLockRoot.includes('\0') && isAbsolute(launchValue.aclLockRoot)) {
      launch = {
        kind: 'restricted-token', workspaceRoot: launchValue.workspaceRoot,
        tempDirectory: launchValue.tempDirectory, aclLockRoot: launchValue.aclLockRoot,
      };
    } else {
      throw new Error('exec_guardian_startup_protocol');
    }
  }
  const executable = argv[3];
  if (executable === undefined || executable === '' || executable.includes('\0')) throw new Error('exec_guardian_executable_required');
  return { executable, args: argv.slice(4), launch };
}

function cleanupOwnedDescendants(): Promise<void> {
  if (process.platform !== 'linux') return Promise.resolve();
  linuxCleanup ??= terminateLinuxDescendants();
  return linuxCleanup;
}

function stop(): void {
  disconnected = true;
  if (job !== undefined) {
    job.close();
    return;
  }
  void cleanupOwnedDescendants()
    .then(() => finish({ kind: 'error', code: 'exec_cancelled', detail: 'the owned command tree was terminated' }))
    .catch((error) => finish({ kind: 'error', code: 'exec_terminate_failed', detail: (error as Error).message }));
}

process.once('disconnect', stop);
if (process.platform === 'linux') process.once('SIGTERM', stop);
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'cancel') {
    cancelled = true;
    stop();
  }
});

async function runAppContainer(startup: GuardianStartup): Promise<void> {
  const launch = startup.launch;
  if (launch === undefined || launch.kind !== 'appcontainer') throw new Error('AppContainer launch description is required');
  let profile: AppContainerProfile | undefined;
  let workspaceReadGrant: AppContainerDirectoryReadGrant | undefined;
  let outcome: object;
  let primaryError: unknown;
  let commandStarted = false;
  try {
    profile = await createAppContainerProfile();
    workspaceReadGrant = await createAppContainerDirectoryReadGrant(launch.workspaceRoot);
    await grantAppContainerDirectoryRead(workspaceReadGrant, profile.sid);
    if (disconnected || !process.connected) throw new KernelError('exec_cancelled', { detail: 'the owned command tree was terminated' });
    process.send?.({ kind: 'ready', processId: process.pid });
    commandStarted = true;
    const exitCode = await runAppContainerCommand({
      executable: startup.executable,
      argv: startup.args,
      cwd: process.cwd(),
      environment: process.env,
      identity: profile,
      assignToJob: job === undefined ? undefined : (processHandle) => job!.assign(processHandle),
    });
    if (cancelled || disconnected) {
      outcome = { kind: 'error', code: 'exec_cancelled', detail: 'the owned command tree was terminated' };
    } else {
      outcome = { kind: 'exit', exitCode };
    }
  } catch (error) {
    const failure = commandFailure(error, commandStarted);
    primaryError = failure;
    outcome = {
      kind: 'error',
      code: failure.code,
      detail: failure.detail ?? failure.message,
    };
  } finally {
    const cleanupErrors: string[] = [];
    if (profile !== undefined && workspaceReadGrant !== undefined) {
      try { await revokeAppContainerDirectoryRead(workspaceReadGrant, profile.sid); }
      catch (error) { cleanupErrors.push(`workspace ACL: ${(error as Error).message}`); }
    }
    if (profile !== undefined) {
      try { await profile.dispose(); }
      catch (error) { cleanupErrors.push(`profile: ${(error as Error).message}`); }
    }
    if (cleanupErrors.length > 0) {
      outcome = {
        kind: 'error',
        code: cleanupOutcomeCode(primaryError),
        detail: [primaryError instanceof Error ? primaryError.message : undefined, ...cleanupErrors].filter(Boolean).join('; '),
      };
    }
  }
  finish(outcome);
}

async function runRestrictedToken(startup: GuardianStartup): Promise<void> {
  const launch = startup.launch;
  if (launch === undefined || launch.kind !== 'restricted-token') throw new Error('restricted-token launch description is required');
  const writeSid = randomWorkspaceRestrictedSid();
  let workspaceGrant = false;
  let tempGrant = false;
  let outcome: object;
  let primaryError: unknown;
  let commandStarted = false;
  try {
    workspaceGrant = true;
    await grantRestrictedDirectoryWrite(launch.workspaceRoot, writeSid, launch.aclLockRoot);
    tempGrant = true;
    await grantRestrictedDirectoryWrite(launch.tempDirectory, writeSid, launch.aclLockRoot);
    if (disconnected || !process.connected) throw new KernelError('exec_cancelled', { detail: 'the owned command tree was terminated' });
    process.send?.({ kind: 'ready', processId: process.pid });
    commandStarted = true;
    const exitCode = await runRestrictedWindowsCommand({
      executable: startup.executable,
      argv: startup.args,
      cwd: process.cwd(),
      writeSid,
      job: job!,
    });
    outcome = cancelled || disconnected
      ? { kind: 'error', code: 'exec_cancelled', detail: 'the owned command tree was terminated' }
      : { kind: 'exit', exitCode };
  } catch (error) {
    const failure = commandFailure(error, commandStarted);
    primaryError = failure;
    outcome = {
      kind: 'error',
      code: failure.code,
      detail: failure.detail ?? failure.message,
    };
  } finally {
    const cleanupErrors: string[] = [];
    if (tempGrant) {
      try { await revokeRestrictedDirectoryWrite(launch.tempDirectory, writeSid, launch.aclLockRoot); }
      catch (error) { cleanupErrors.push(`temp ACL: ${(error as Error).message}`); }
    }
    if (workspaceGrant) {
      try { await revokeRestrictedDirectoryWrite(launch.workspaceRoot, writeSid, launch.aclLockRoot); }
      catch (error) { cleanupErrors.push(`workspace ACL: ${(error as Error).message}`); }
    }
    if (cleanupErrors.length > 0) {
      outcome = {
        kind: 'error',
        code: cleanupOutcomeCode(primaryError),
        detail: [primaryError instanceof Error ? primaryError.message : undefined, ...cleanupErrors].filter(Boolean).join('; '),
      };
    }
  }
  finish(outcome);
}

function linuxDescendants(): Array<{ pid: number; state: string }> {
  const parents = new Map<number, Array<{ pid: number; state: string }>>();
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = readFileSync(`/proc/${entry.name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const state = fields[0];
      const ppid = Number(fields[1]);
      if (state === undefined || !Number.isInteger(ppid)) continue;
      const children = parents.get(ppid) ?? [];
      children.push({ pid, state });
      parents.set(ppid, children);
    } catch {
      // A process may exit while /proc is being enumerated.
    }
  }
  const result: Array<{ pid: number; state: string }> = [];
  const pending = [process.pid];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) continue;
    for (const child of parents.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      pending.push(child.pid);
    }
  }
  return result;
}

async function terminateLinuxDescendants(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const descendants = linuxDescendants();
    for (const descendant of descendants) {
      if (descendant.state === 'Z') continue;
      try {
        process.kill(descendant.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (descendants.every(({ state }) => state === 'Z')) return;
    if (Date.now() >= deadline) throw new Error('the owned Linux process tree remained alive after termination');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function enableLinuxSubreaper(): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    const koffi = (await import('koffi')).default;
    const libc = koffi.load('libc.so.6');
    const prctl = libc.func('prctl', 'int', ['int', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t']) as (
      option: number, arg2: number, arg3: number, arg4: number, arg5: number,
    ) => number;
    if (prctl(36, 1, 0, 0, 0) !== 0) throw new Error('prctl(PR_SET_CHILD_SUBREAPER) failed');
  } catch (cause) {
    throw new KernelError('permission_process_isolation_unavailable', {
      cause,
      detail: 'Linux child subreaper support could not be enabled for this command',
    });
  }
}

function finish(message: object): void {
  if (finishing) return;
  finishing = true;
  if (!process.connected || process.send === undefined) {
    stop();
    process.exit(1);
  }
  process.send(message, () => {
    if (job !== undefined) job.close();
    process.exit(1);
  });
}

try {
  if (process.send === undefined) throw new Error('exec_guardian_ipc_required');
  const startup = parseGuardianStartup(process.argv.slice(2));
  if (process.platform === 'win32') job = await createOwnedProcessJob({ assignCurrentProcess: startup.launch === undefined });
  else if (process.platform === 'linux') await enableLinuxSubreaper();
  else throw new Error('exec_process_ownership_unavailable');
  if (disconnected || !process.connected) {
    stop();
    if (job !== undefined) process.exit(1);
    await cleanupOwnedDescendants();
    process.exit(1);
  }
  if (startup.launch !== undefined) {
    if (process.platform !== 'win32') throw new Error('exec_process_ownership_unavailable');
    if (startup.launch.kind === 'appcontainer') await runAppContainer(startup);
    else await runRestrictedToken(startup);
  } else {
    process.send({ kind: 'ready', processId: process.pid });
    const child = spawn(startup.executable, startup.args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', (error) => finish({ kind: 'error', code: 'exec_spawn_failed', detail: error.message }));
    child.once('close', (exitCode, signal) => {
      void cleanupOwnedDescendants().then(() => {
        if (exitCode === null) finish({ kind: 'error', code: 'exec_process_interrupted', detail: `the command ended with signal ${signal}` });
        else finish({ kind: 'exit', exitCode });
      }).catch((error) => finish({ kind: 'error', code: 'exec_terminate_failed', detail: (error as Error).message }));
    });
  }
} catch (error) {
  const failure = error as Error & { code?: string; detail?: string };
  finish({ kind: 'error', code: failure.code ?? 'exec_job_failed', detail: failure.detail ?? failure.message });
}
