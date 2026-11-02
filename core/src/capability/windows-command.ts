// 守护进程先取得平台进程树归属，再创建命令；命令退出时一并清理仍存活的后代。
import { fork, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelError } from '../errors.js';

export interface OwnedWindowsCommand {
  readonly child: ChildProcess;
  readonly completion: Promise<number>;
  cancel(): void;
}

export type WindowsCommandLaunch =
  | { readonly kind: 'appcontainer'; readonly workspaceRoot: string }
  | { readonly kind: 'restricted-token'; readonly workspaceRoot: string; readonly tempDirectory: string; readonly aclLockRoot: string };

const GUARDIAN_LAUNCH_ARGUMENT = '--ligule-guardian-launch-v1';

export function spawnWindowsCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  launch?: WindowsCommandLaunch,
): OwnedWindowsCommand {
  if (launch !== undefined) {
    if (launch.kind === 'appcontainer'
      && (launch.workspaceRoot.trim() === '' || launch.workspaceRoot.includes('\0'))) {
      throw new TypeError('the AppContainer launch description requires a workspace directory');
    }
    if (launch.kind === 'restricted-token'
      && ([launch.workspaceRoot, launch.tempDirectory, launch.aclLockRoot].some((path) => path.trim() === '' || path.includes('\0')
        || !isAbsolute(path)))) {
      throw new TypeError('the restricted-token launch description requires absolute workspace, temp, and ACL lock directories');
    }
  }
  const guardianArguments = [GUARDIAN_LAUNCH_ARGUMENT, JSON.stringify(launch ?? null), '--', executable, ...args];
  const child = fork(fileURLToPath(new URL('./exec-guardian.js', import.meta.url)), guardianArguments, {
    cwd,
    windowsHide: true,
    execArgv: [],
    ...(environment === undefined ? {} : { env: environment }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let cancelled = false;
  let exitCode: number | undefined;
  let failure: Error | undefined;
  // The IPC disconnect event and output stream closures can arrive without ChildProcess.close.
  let processFinished = false;
  let ipcDisconnected = !child.connected;
  let stdoutClosed = child.stdout === null;
  let stderrClosed = child.stderr === null;
  let settled = false;
  const completion = new Promise<number>((resolve, reject) => {
    const settle = (): void => {
      if (settled || !processFinished || !ipcDisconnected || !stdoutClosed || !stderrClosed) return;
      settled = true;
      if (failure !== undefined) reject(failure);
      else if (cancelled) reject(new KernelError('exec_cancelled', { detail: 'the owned command tree was terminated' }));
      else if (exitCode !== undefined) resolve(exitCode);
      else reject(new KernelError('exec_guardian_failed', { detail: 'the guardian exited without reporting the command outcome' }));
    };

    child.on('message', (value: unknown) => {
      if (typeof value !== 'object' || value === null) {
        failure = new KernelError('exec_guardian_protocol');
        child.kill();
        return;
      }
      const message = value as { kind?: unknown; exitCode?: unknown; code?: unknown; detail?: unknown; processId?: unknown };
      if (message.kind === 'ready' && message.processId === child.pid) return;
      if (message.kind === 'exit' && typeof message.exitCode === 'number' && Number.isInteger(message.exitCode)) {
        exitCode = message.exitCode;
        return;
      }
      if (message.kind === 'error' && typeof message.code === 'string') {
        failure = new KernelError(message.code, { detail: typeof message.detail === 'string' ? message.detail : undefined });
        return;
      }
      failure = new KernelError('exec_guardian_protocol');
      child.kill();
    });
    child.once('error', (cause) => {
      failure = new KernelError('exec_spawn_failed', { cause, detail: cause.message });
    });
    child.once('disconnect', () => {
      ipcDisconnected = true;
      settle();
    });
    child.once('exit', () => {
      processFinished = true;
      settle();
    });
    child.once('close', () => {
      processFinished = true;
      settle();
    });
    child.stdout?.once('close', () => {
      stdoutClosed = true;
      settle();
    });
    child.stderr?.once('close', () => {
      stderrClosed = true;
      settle();
    });
  });
  return {
    child,
    completion,
    cancel() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      cancelled = true;
      if (process.platform === 'linux') {
        if (child.connected) {
          child.send({ kind: 'cancel' }, (cause) => {
            if (cause === null || !child.connected) return;
            try {
              child.disconnect();
            } catch (disconnectCause) {
              try {
                if (!child.kill('SIGTERM')) throw disconnectCause;
              } catch (signalCause) {
                failure = new KernelError('exec_terminate_failed', {
                  cause: signalCause,
                  detail: 'the process guardian IPC and signal cleanup channels failed',
                });
              }
            }
          });
        }
        return;
      }
      if (launch !== undefined && child.connected) {
        const fallback = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }, 15_000);
        fallback.unref();
        child.once('close', () => clearTimeout(fallback));
        try {
          child.send({ kind: 'cancel' }, (cause) => {
            if (cause !== null && child.exitCode === null && child.signalCode === null) child.kill();
          });
        } catch {
          child.kill();
        }
        return;
      }
      // Node 持有守护进程的句柄；终止它会关闭 Job 的最后一个句柄。
      if (!child.kill()) failure = new KernelError('exec_terminate_failed', { detail: 'the guardian could not be terminated' });
    },
  };
}
