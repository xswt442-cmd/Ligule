import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import lockfile from 'proper-lockfile';
import { dataRoot } from './config-file.js';
import { KernelError, KernelRuntimeError } from './error.js';
import { workspaceIdentity } from '../workspace-identity.js';

type TrustDocument = { version: 1; directories: string[] };

const LOCK_STALE_MS = 10_000;
const pendingWrites = new Map<string, Promise<void>>();

type TrustLock = { assertOwned(): void; release(): Promise<void> };

export function trustPathOf(home = homedir()): string {
  return join(dataRoot(home), 'trust.json');
}

// 早期版本的文件名。读取作为后备，写入一律使用新名；旧文件保留不迁移、不删除，
// 新文件一旦写入即优先生效，旧文件自然失效。
function legacyPathOf(path: string): string | undefined {
  return basename(path) === 'trust.json' ? join(dirname(path), 'tui-trust.json') : undefined;
}

function invalidDocument(cause?: unknown): KernelError {
  return new KernelError('tui_trust_invalid', { cause, detail: 'the TUI trust document is invalid' });
}

function parseDocument(text: string): TrustDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw invalidDocument(cause);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidDocument();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || !Object.hasOwn(record, 'version')
    || !Object.hasOwn(record, 'directories')
    || record.version !== 1
    || !Array.isArray(record.directories)
    || !record.directories.every((directory) => typeof directory === 'string' && directory !== '' && isAbsolute(directory))) {
    throw invalidDocument();
  }
  const directories = record.directories as string[];
  if (new Set(directories).size !== directories.length) throw invalidDocument();
  return { version: 1, directories };
}

async function readDocument(path: string, legacyPath?: string): Promise<TrustDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (legacyPath === undefined) return { version: 1, directories: [] };
    try {
      text = await readFile(legacyPath, 'utf8');
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, directories: [] };
      throw legacyError;
    }
  }
  return parseDocument(text);
}

async function verifiedIdentity(directory: string): Promise<string> {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new KernelError('tui_trust_directory_invalid', { detail: 'the directory must exist and be a directory' });
  }
  try {
    const canonical = await realpath(resolve(directory));
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return workspaceIdentity(canonical);
  } catch (cause) {
    throw new KernelError('tui_trust_directory_invalid', { cause, detail: 'the directory must exist and be a directory' });
  }
}

export async function isTrusted(directory: string, path = trustPathOf()): Promise<boolean> {
  const identity = await verifiedIdentity(directory);
  const document = await readDocument(resolve(path), legacyPathOf(path));
  return document.directories.includes(identity);
}

async function acquireLock(path: string): Promise<TrustLock> {
  let compromised: Error | undefined;
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      stale: LOCK_STALE_MS,
      update: 2_000,
      retries: { retries: 12, minTimeout: 20, maxTimeout: 100 },
      onCompromised: (error) => { compromised = error; },
    });
  } catch (cause) {
    throw new KernelRuntimeError('tui_trust_locked', { cause, detail: 'the TUI trust document could not be locked' });
  }
  return {
    assertOwned() {
      if (compromised !== undefined) {
        throw new KernelRuntimeError('tui_trust_lock_lost', { cause: compromised, detail: 'the TUI trust document lock was lost' });
      }
    },
    async release() {
      try {
        await unlock!();
      } catch (cause) {
        throw new KernelRuntimeError('tui_trust_unlock_failed', { cause, detail: 'the TUI trust document lock could not be released' });
      }
      if (compromised !== undefined) {
        throw new KernelRuntimeError('tui_trust_lock_lost', { cause: compromised, detail: 'the TUI trust document lock was lost' });
      }
    },
  };
}

async function writeTrust(path: string, identity: string, trusted: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(path);
  let temporary: string | undefined;
  try {
    // 读取旧名后备，写入新名：首次写入即把旧文件的内容合并进新文件。
    const document = await readDocument(path, legacyPathOf(path));
    const directories = new Set(document.directories);
    if (trusted) directories.add(identity);
    else directories.delete(identity);
    temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, directories: [...directories] }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    lock.assertOwned();
    await rename(temporary, path);
    temporary = undefined;
  } finally {
    try {
      if (temporary !== undefined) await rm(temporary, { force: true });
    } finally {
      await lock.release();
    }
  }
}

export async function setTrusted(directory: string, trusted: boolean, path = trustPathOf()): Promise<void> {
  if (typeof trusted !== 'boolean') throw new KernelError('tui_trust_value_invalid');
  const identity = await verifiedIdentity(directory);
  const target = resolve(path);
  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeTrust(target, identity, trusted));
  pendingWrites.set(target, current);
  try {
    await current;
  } finally {
    if (pendingWrites.get(target) === current) pendingWrites.delete(target);
  }
}
