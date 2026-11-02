// 工作区使用持久身份登记表进行管理。
// 身份基于目录，不基于路径文本；大小写、分隔符、盘符、尾斜杠和链接等别名会归一为同一身份。
// 登记表保存在应用数据根目录中，界面仅作为读取方，不能因隐藏工作区而删除登记。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { dataRoot } from './config-file.js';
import { KernelError, KernelRuntimeError } from './error.js';
import { canonicalWorkspaceOf } from '../workspace-identity.js';
export { trimTrailingSeparators, workspaceIdentity } from '../workspace-identity.js';

export const REGISTRY_VERSION = 1;

// 登记表读—改—写通常会立即完成；超时表示持锁进程可能已经退出。
export const REGISTRY_LOCK_STALE_MS = 5_000;

export type WorkspaceEntry = {
  identity: string;
  directory: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
};

export type WorkspaceRegistry = {
  version: number;
  default: string | null;
  workspaces: WorkspaceEntry[];
};

/** 返回用于比较目录身份的规范路径；不在此处检查目录是否存在或可读。 */
/**
 * 去掉结尾的路径分隔符。
 *
 * 逐字符扫描而不是用正则：`/\/+$/` 这类模式在每个起点重扫同一串分隔符，
 * 由输入控制的路径会退化成多项式时间（CodeQL js/polynomial-redos）。
 */
export function registryPathOf(home = homedir()): string {
  return join(dataRoot(home), 'workspaces.json');
}

export function emptyRegistry(): WorkspaceRegistry {
  return { version: REGISTRY_VERSION, default: null, workspaces: [] };
}

function checkedEntry(value: unknown): WorkspaceEntry {
  const entry = value as Partial<WorkspaceEntry>;
  const fields = ['identity', 'directory', 'name', 'firstSeen', 'lastSeen'] as const;
  const missing = fields.filter((one) => typeof entry?.[one] !== 'string' || entry[one] === '');
  if (missing.length > 0) throw new KernelError('workspace_registry_invalid', { detail: `entry is missing ${missing.join(', ')}` });
  return {
    identity: entry.identity as string,
    directory: entry.directory as string,
    name: entry.name as string,
    firstSeen: entry.firstSeen as string,
    lastSeen: entry.lastSeen as string,
  };
}

/** 读取工作区登记；文件不存在时返回空表，内容损坏或格式无效时返回错误。 */
export function parseRegistry(text: string): WorkspaceRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KernelError('workspace_registry_invalid', { detail: 'the file is not JSON' });
  }
  const registry = parsed as Partial<WorkspaceRegistry>;
  if (registry === null || typeof registry !== 'object' || !Array.isArray(registry.workspaces)) {
    throw new KernelError('workspace_registry_invalid', { detail: 'the file is not that table' });
  }
  if (registry.version !== REGISTRY_VERSION) {
    throw new KernelError('workspace_registry_version', { detail: `file says ${String(registry.version)}, this build reads ${REGISTRY_VERSION}` });
  }
  const workspaces = registry.workspaces.map(checkedEntry);
  const wanted = new Set(workspaces.map((one) => one.identity));
  const chosen = registry.default === null || registry.default === undefined ? null : registry.default;
  if (chosen !== null && !wanted.has(chosen)) {
    throw new KernelError('workspace_registry_invalid', { detail: `the default ${chosen} is not registered` });
  }
  return { version: REGISTRY_VERSION, default: chosen, workspaces };
}

export async function readRegistry(path = registryPathOf()): Promise<WorkspaceRegistry> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return emptyRegistry();
    throw error;
  }
  return parseRegistry(text);
}

// 登记更新采用读—改—写，避免并发 Host 覆盖彼此的变更。
// 使用 `proper-lockfile` 协调进程间访问，并在进程内串行执行更新。
let writing: Promise<unknown> = Promise.resolve();

/** 获取登记表文件锁；成功时返回释放函数，失败时报告被锁定的路径。 */
async function acquireRegistryLock(path: string): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      stale: REGISTRY_LOCK_STALE_MS,
      retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
      onCompromised: () => {},
    });
  } catch (cause) {
    throw new KernelRuntimeError('workspace_registry_locked', { cause, detail: path });
  }
}

/** 记录工作区身份；首次出现时新增条目，之后更新最近使用时间和显示名称。 */
function upsertEntry(registry: WorkspaceRegistry, canonical: { identity: string; directory: string }, name: string | undefined, now: string): void {
  const known = registry.workspaces.find((one) => one.identity === canonical.identity);
  if (known === undefined) {
    registry.workspaces.push({
      identity: canonical.identity,
      directory: canonical.directory,
      name: name === undefined || name.trim() === '' ? basename(canonical.directory) : name.trim(),
      firstSeen: now,
      lastSeen: now,
    });
    return;
  }
  known.lastSeen = now;
  known.directory = canonical.directory;
  if (name !== undefined && name.trim() !== '') known.name = name.trim();
}

/**
 * 更新登记表时先获取文件锁，再创建唯一的临时文件并原子替换原文件。
 * 进程内的更新排队执行；每次都从锁内读取的最新内容开始修改。
 */
function mutateRegistry(path: string, mutate: (registry: WorkspaceRegistry) => void): Promise<WorkspaceRegistry> {
  const next = writing.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const release = await acquireRegistryLock(path);
    try {
      const registry = await readRegistry(path);
      mutate(registry);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return registry;
    } finally {
      await release();
    }
  });
  writing = next.then(() => undefined, () => undefined);
  return next;
}

/** 登记最近使用的工作区；同一身份只保留一条记录。 */
export function registerWorkspace(directory: string, { path = registryPathOf(), name = undefined as string | undefined, now = new Date().toISOString() } = {}): Promise<WorkspaceRegistry> {
  const canonical = canonicalWorkspaceOf(directory);
  return mutateRegistry(path, (registry) => {
    upsertEntry(registry, canonical, name, now);
  });
}

/**
 * 设置默认工作区时先确保该工作区已登记，再保存其身份。
 * 传入 null 会清除默认选择。
 */
export function setDefaultWorkspace(directory: string | null, { path = registryPathOf(), name = undefined as string | undefined, now = new Date().toISOString() } = {}): Promise<WorkspaceRegistry> {
  if (directory === null) {
    return mutateRegistry(path, (registry) => {
      registry.default = null;
    });
  }
  const canonical = canonicalWorkspaceOf(directory);
  return mutateRegistry(path, (registry) => {
    upsertEntry(registry, canonical, name, now);
    registry.default = canonical.identity;
  });
}

/** 移除一条工作区登记；项目目录、项目文件与会话记录保持不变。 */
export function unregisterWorkspace(directory: string, { path = registryPathOf() } = {}): Promise<WorkspaceRegistry> {
  const canonical = canonicalWorkspaceOf(directory);
  return mutateRegistry(path, (registry) => {
    if (registry.default === canonical.identity) {
      throw new KernelError('workspace_default_cannot_remove', { detail: canonical.directory });
    }
    const index = registry.workspaces.findIndex((entry) => entry.identity === canonical.identity);
    if (index < 0) throw new KernelError('workspace_not_registered', { detail: canonical.directory });
    registry.workspaces.splice(index, 1);
  });
}
