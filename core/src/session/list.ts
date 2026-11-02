// 会话列表扫描记录目录；主目录使用可重建索引缓存解析结果，按文件大小与修改时间失效。
// 从每条记录读取格式版本、项目归属、更新时间、事件数、最后生效模式和未完成调用数量。
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { dataRoot } from '../data-root.js';
import { KernelError } from '../errors.js';
import type { ModeFile } from '../kernel/modes.js';
import { workspaceIdentity } from '../workspace-identity.js';
import { findUnresolvedCalls } from './repair.js';
import type { SessionEvent, SessionHeader } from './format.js';
import { foldLabel } from './format.js';
import { parseSessionBytes } from './record.js';
import { readListIndex, writeListIndex, type ListIndexEntry } from './list-index.js';

// 恢复时优先使用客户端明确指定的模式；否则使用记录中最后生效的模式并校验摘要。
// 同名模式的摘要变化时返回错误，要求用户明确选择，不静默切换工具范围。
export function chooseResumeMode({
  explicit,
  recorded,
  loaded,
  fallback,
}: {
  explicit?: string;
  recorded?: { name: string; digest?: string };
  loaded?: ModeFile;
  fallback: string;
}): string {
  if (explicit !== undefined) return explicit;
  if (recorded === undefined) return fallback;
  // 版本 0 记录的模式事件没有摘要，因此只比较模式名称。
  if (recorded.digest !== undefined && recorded.digest !== loaded?.digest) {
    throw new KernelError('resume_mode_changed', {
      detail: `${recorded.name} was ${recorded.digest} in that session and is ${loaded?.digest ?? 'unreadable'} on disk; name a mode explicitly to resume`,
    });
  }
  return recorded.name;
}

export interface SessionDirectoryConfig {
  boundary: string;
  workspaceRoot?: string;
  // 返回数据根路径，与用户配置层使用同一目录。
  userHome?: string;
  host?: { sessionDirectory?: unknown };
}

export interface SessionSummary {
  id: string;
  // 缺少首行的旧记录按版本 0 解析。
  formatVersion: number;
  projectRoot: string;
  // 旧记录没有工作区来源字段时返回空值，表示来源未知，不表示默认工作区。
  workspace: string;
  workspaceOrigin: string;
  createdAt: string | null;
  updatedAt: string;
  events: number;
  lastSeq: number;
  mode: { name: string; layer: string; digest: string } | null;
  // 返回用户设置的会话名称；未命名时为空字符串，由列表显示会话编号。
  name: string;
  // 归档状态只影响列表展示；会话记录仍可恢复或取消归档。
  archived: boolean;
  // 返回已派发但尚无结果的调用数；恢复会话时这些调用会被标记为结果未知。
  unanswered: number;
  truncatedBytes: number;
  error?: { code: string; detail: string };
}

export function sessionDirectory(config: SessionDirectoryConfig): string {
  const configured = config.host?.sessionDirectory;
  if (typeof configured === 'string' && configured !== '') return configured;
  return join(workspaceDataDirectory(config), 'sessions');
}

export function workspaceDataDirectory(config: SessionDirectoryConfig): string {
  const workspace = config.workspaceRoot ?? config.boundary;
  const identity = workspaceIdentity(workspace);
  const prettyPath = workspaceFolderLabel(identity);
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return join(dataRoot(config.userHome), 'workspaces', `${prettyPath}--${suffix}`);
}

function workspaceFolderLabel(identity: string): string {
  const windowsDrive = /^([a-z]):[\\/]/i.exec(identity);
  if (windowsDrive !== null) {
    const parts = identity.slice(windowsDrive[0].length).split(/[\\/]+/u).filter(Boolean);
    return `${windowsDrive[1].toLowerCase()}--${parts.map(safePathPart).join('-')}`.slice(0, 120);
  }
  const unc = splitUncIdentity(identity);
  if (unc !== undefined) {
    const parts = [unc.host, ...unc.rest.split(/[\\/]+/u)].filter(Boolean);
    return `unc--${parts.map(safePathPart).join('-')}`.slice(0, 120);
  }
  const parts = identity.split(/[\\/]+/u).filter(Boolean);
  return `root-${parts.map(safePathPart).join('-')}`.slice(0, 120);
}

/**
 * 把 `\\host\share\x` 拆成 host 与其余部分；不是 UNC 路径时返回 undefined。
 *
 * 逐字符扫描而不是用 `/^\\\\([^\\]+)[\\/]+(.+)$/u`：后者两个量词共享分隔符，
 * 每个字符位置的失败路径都要重扫分隔符串，输入由路径决定会退化成多项式时间
 * （CodeQL js/polynomial-redos）。这里按正则的贪婪顺序取最靠右的可行切分：
 * `(.+)` 贪婪使剩余部分尽量短，因此 host 取最长的可行前缀；复杂度与路径长度线性相关。
 */
export function splitUncIdentity(identity: string): { host: string; rest: string } | undefined {
  if (!identity.startsWith('\\\\')) return undefined;
  const body = identity.slice(2);
  const length = body.length;
  const isSeparator = (char: string): boolean => char === '/' || char === '\\';
  // 组 1 不含反斜杠：第一次出现的位置固定后，每个候选只用比较下标，不必重扫前缀。
  const firstBackslash = body.indexOf('\\');
  // 组 3 用 `.` 且 `$`：JS 里不带 m 的 `$` 只匹配输入末尾，所以其余部分不能含换行。
  const newlinesAfter = new Int32Array(length + 1);
  for (let index = length - 1; index >= 0; index -= 1) {
    newlinesAfter[index] = newlinesAfter[index + 1] + (body[index] === '\n' ? 1 : 0);
  }
  for (let restStart = length - 1; restStart >= 1; restStart -= 1) {
    const hostEnd = restStart - 1;
    if (!isSeparator(body[hostEnd]) || hostEnd === 0) continue;
    if (firstBackslash !== -1 && hostEnd > firstBackslash) continue;
    if (newlinesAfter[restStart] > 0) continue;
    const rest = body.slice(restStart);
    if (rest === '') continue;
    return { host: body.slice(0, hostEnd), rest };
  }
  return undefined;
}

function safePathPart(part: string): string {
  return part.replace(/[^\p{L}\p{N}_-]/gu, '-');
}

/** Existing paths are read for discovery; writes happen only when a user opens a legacy session. */
export function sessionDirectories(config: SessionDirectoryConfig): string[] {
  const configured = config.host?.sessionDirectory;
  const primary = sessionDirectory(config);
  if (typeof configured === 'string' && configured !== '') return [primary];
  const workspace = config.workspaceRoot ?? config.boundary;
  const candidates = [
    join(dataRoot(config.userHome), 'sessions'),
    join(workspace, '.ligule', 'sessions'),
  ];
  const seen = new Set([pathIdentity(primary)]);
  return [primary, ...candidates.filter((candidate) => {
    const identity = pathIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  })];
}

function pathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function projectRootOfLegacyDirectory(directory: string): string | undefined {
  const resolved = resolve(directory);
  if (resolved === resolve(join(dataRoot(), 'sessions'))) return undefined;
  if (basename(resolved) !== 'sessions' || basename(dirname(resolved)) !== '.ligule') return undefined;
  return dirname(dirname(resolved));
}

export async function listSessions(
  directory: string,
  { projectRoot = undefined as string | undefined, limit = undefined as number | undefined, index = false } = {},
): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  // 索引只属于当前目录，且只是缓存：未命中或失效的条目按原路径完整解析。
  const cache = index ? await readListIndex(directory) : { entries: new Map<string, ListIndexEntry>() };
  const fresh = new Map<string, ListIndexEntry>();
  let dirty = false;
  const summaries: SessionSummary[] = [];
  // 按目录身份筛选，而不是比较路径文本；记录和命令行可能使用不同大小写、分隔符或链接写法。
  // 文本不同时才解析路径身份，避免不必要的文件系统调用。
  const asked = projectRoot === undefined ? undefined : resolve(projectRoot);
  const askedIdentity = asked === undefined ? undefined : workspaceIdentity(asked);
  const physicalProjectRoot = projectRootOfLegacyDirectory(directory);
  const physicalIdentity = physicalProjectRoot === undefined ? undefined : workspaceIdentity(physicalProjectRoot);
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    const path = join(directory, name);
    const info = await stat(path);
    const cached = cache.entries.get(id);
    if (cached !== undefined && cached.bytes === info.size && cached.mtimeMs === info.mtimeMs) {
      fresh.set(id, cached);
      const cachedRoot = cached.headerRoot;
      if (asked !== undefined && cachedRoot !== null
        && resolve(cachedRoot) !== asked && workspaceIdentity(cachedRoot) !== askedIdentity) continue;
      if (asked !== undefined && cachedRoot === null
        && (physicalProjectRoot === undefined || physicalIdentity !== askedIdentity)) continue;
      summaries.push({ ...cached.summary, updatedAt: info.mtime.toISOString() });
      continue;
    }
    const bytes = await readFile(path);
    // 首行元数据提供项目归属；损坏或不支持的记录仍以错误条目显示在列表中。
    let header: SessionHeader | undefined;
    try {
      const end = bytes.indexOf(0x0a);
      const first: unknown = JSON.parse(bytes.subarray(0, end < 0 ? 0 : end).toString('utf8'));
      if (first !== null && typeof first === 'object' && (first as { kind?: unknown }).kind === 'session') header = first as SessionHeader;
    } catch {
      // 完整记录校验负责报告正文或首行错误；不推测损坏记录的项目归属。
    }
    // 指定项目根后只保留归属该项目的记录；无法读取首行的情况由后续错误处理负责。
    // 被筛选跳过的记录保留旧缓存条目，索引不因筛选视图而反复重写。
    const headerRoot = typeof header?.projectRoot === 'string' && header.projectRoot !== '' ? header.projectRoot : undefined;
    if (asked !== undefined && headerRoot !== undefined
      && resolve(headerRoot) !== asked && workspaceIdentity(headerRoot) !== askedIdentity) {
      const previous = cache.entries.get(id);
      if (previous !== undefined) fresh.set(id, previous);
      continue;
    }
    if (asked !== undefined && headerRoot === undefined
      && (physicalProjectRoot === undefined || physicalIdentity !== askedIdentity)) {
      const previous = cache.entries.get(id);
      if (previous !== undefined) fresh.set(id, previous);
      continue;
    }
    // 没有首行的记录只按实际记录目录归属；数据根中归属未知的记录仅出现在未筛选列表。
    const ownRoot = headerRoot ?? physicalProjectRoot ?? '';
    dirty = true;
    let events: SessionEvent[] = [];
    let truncatedBytes = 0;
    let invalid: SessionSummary['error'];
    let lastSeq = -1;
    try {
      const record = parseSessionBytes(bytes);
      events = record.events;
      truncatedBytes = record.truncatedBytes;
      lastSeq = record.lastSeq;
      header = record.header;
    } catch (error) {
      const failure = error as { code?: string; detail?: string; message?: string };
      invalid = { code: failure.code ?? 'session_read_failed', detail: failure.detail ?? failure.message ?? path };
    }
    const lastMode = events.filter((event) => event.kind === 'mode').at(-1);
    const label = foldLabel(events);
    const summary: SessionSummary = {
      id,
      formatVersion: header?.formatVersion ?? 0,
      projectRoot: ownRoot,
      // 同时返回工作区身份和来源，供界面分组；不根据当前默认目录推测历史归属。
      workspace: header?.workspace ?? '',
      workspaceOrigin: header?.workspaceOrigin ?? '',
      createdAt: header?.createdAt ?? null,
      updatedAt: info.mtime.toISOString(),
      events: events.length,
      lastSeq,
      mode: lastMode === undefined || typeof lastMode.name !== 'string'
        ? null
        : { name: lastMode.name, layer: String(lastMode.layer ?? ''), digest: String(lastMode.digest ?? '') },
      name: label.name,
      archived: label.archived,
      unanswered: findUnresolvedCalls(events).length,
      truncatedBytes,
      ...(invalid === undefined ? {} : { error: invalid }),
    };
    summaries.push(summary);
    fresh.set(id, { bytes: info.size, mtimeMs: info.mtimeMs, headerRoot: headerRoot ?? null, summary });
  }
  summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (index && (dirty || cache.entries.size !== fresh.size)) {
    await writeListIndex(directory, fresh);
  }
  return limit === undefined ? summaries : summaries.slice(0, limit);
}

/** Lists one workspace across its current and legacy locations without copying or repairing records. */
export async function listWorkspaceSessions(
  config: SessionDirectoryConfig,
  { projectRoot = config.workspaceRoot ?? config.boundary, limit = undefined as number | undefined } = {},
): Promise<SessionSummary[]> {
  const directories = sessionDirectories(config);
  // 索引只写入当前工作区的记录目录；旧目录保持只读发现。
  const groups = await Promise.all(directories.map((directory, position) => listSessions(directory, { projectRoot, index: position === 0 })));
  const records = new Map<string, SessionSummary>();
  for (const group of groups) {
    for (const item of group) if (!records.has(item.id)) records.set(item.id, item);
  }
  const sorted = [...records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return limit === undefined ? sorted : sorted.slice(0, limit);
}
