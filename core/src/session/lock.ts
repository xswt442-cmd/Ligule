// 写入所有权由带心跳的独占锁保护；读取记录不取得锁。
import lockfile from 'proper-lockfile';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { KernelError, KernelRuntimeError } from '../errors.js';

export const SESSION_LOCK_STALE_MS = 10_000;

export async function sessionWriterActive(file: string): Promise<boolean> {
  const path = resolve(file);
  try {
    return await lockfile.check(path, {
      realpath: false,
      lockfilePath: path.replace(/\.jsonl$/, '.lock'),
      stale: SESSION_LOCK_STALE_MS,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new KernelRuntimeError('session_lock_check_failed', { cause, detail: path });
  }
}

export interface SessionLock {
  assertOwned(): void;
  release(): Promise<void>;
}

export async function acquireSessionLock(file: string): Promise<SessionLock> {
  const path = resolve(file);
  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    await mkdir(dirname(path), { recursive: true });
    release = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: path.replace(/\.jsonl$/, '.lock'),
      stale: SESSION_LOCK_STALE_MS,
      update: 2_000,
      retries: 0,
      onCompromised: (error) => { compromised = error; },
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new KernelError('session_locked', { detail: `${path} has an active writer; close it or wait for the crashed writer's lease to expire` });
    }
    throw new KernelRuntimeError('session_lock_failed', { cause, detail: path });
  }
  return {
    assertOwned() {
      if (compromised !== undefined) throw new KernelRuntimeError('session_lock_lost', { cause: compromised, detail: path });
    },
    async release() {
      if (compromised !== undefined) throw new KernelRuntimeError('session_lock_lost', { cause: compromised, detail: path });
      try {
        await release();
      } catch (cause) {
        throw new KernelRuntimeError('session_unlock_failed', { cause, detail: path });
      }
    },
  };
}
