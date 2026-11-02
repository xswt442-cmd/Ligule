// 迁移旧记录时保留有效记录、附属文件和原件；重复执行只比较，不重复写入。
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, readFile, realpath, rm, stat, utimes } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { dataRoot } from '../kernel/config-file.js';
import { SPILL_NAME } from './spill.js';
import { KernelRuntimeError } from '../errors.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { acquireSessionLock } from './lock.js';
import { isRunResultRef } from './run.js';
import { parseSessionBytes, type ReadSessionRecord } from './record.js';
import type { SessionLock } from './lock.js';

const RECORD = /\.jsonl$/;

export interface AdoptionReport {
  copied: string[];
  already: string[];
  conflicts: string[];
  unknown: string[];
  busy: string[];
}

type PublishResult = 'copied' | 'already' | 'conflict' | 'missing' | 'busy';

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function pathIdentity(path: string): Promise<string> {
  let normalized = resolve(path);
  try {
    normalized = await realpath(normalized);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw failure('session_adoption_read_failed', path, cause);
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function failure(code: 'session_adoption_read_failed' | 'session_adoption_write_failed', path: string, cause: unknown): KernelRuntimeError {
  return new KernelRuntimeError(code, { cause, detail: path });
}

async function digestOf(path: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw failure('session_adoption_read_failed', path, cause);
  }
  return hash.digest('hex');
}

async function readExisting(path: string, expectedDigest: string): Promise<PublishResult | undefined> {
  const existing = await digestOf(path);
  if (existing === null) return undefined;
  return existing === expectedDigest ? 'already' : 'conflict';
}

async function publishBytes(
  bytes: Buffer,
  target: string,
  sourcePath: string,
  sourceBytes: Buffer,
  sourceLock: SessionLock,
  targetLock: SessionLock,
): Promise<PublishResult> {
  const expectedDigest = createHash('sha256').update(bytes).digest('hex');
  const existing = await readExisting(target, expectedDigest);
  if (existing !== undefined) return existing;

  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let result: PublishResult = 'copied';
  try {
    const info = await stat(sourcePath).catch((cause) => {
      if (isMissing(cause)) return undefined;
      throw failure('session_adoption_read_failed', sourcePath, cause);
    });
    if (info === undefined) return 'missing';
    const handle = await open(temporary, 'wx', info.mode & 0o777).catch((cause) => {
      throw failure('session_adoption_write_failed', temporary, cause);
    });
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (cause) {
      throw failure('session_adoption_write_failed', temporary, cause);
    } finally {
      await handle.close();
    }
    await utimes(temporary, info.atime, info.mtime).catch((cause) => {
      throw failure('session_adoption_write_failed', temporary, cause);
    });

    const current = await readFile(sourcePath).catch((cause) => {
      if (isMissing(cause)) return undefined;
      throw failure('session_adoption_read_failed', sourcePath, cause);
    });
    if (current === undefined) return 'missing';
    if (!current.equals(sourceBytes)) return 'busy';

    const stagedDigest = await digestOf(temporary);
    if (stagedDigest !== expectedDigest) throw failure('session_adoption_write_failed', temporary, new Error('staged file digest changed'));
    sourceLock.assertOwned();
    targetLock.assertOwned();
    try {
      await link(temporary, target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw failure('session_adoption_write_failed', target, cause);
      result = await readExisting(target, expectedDigest) ?? 'busy';
    }
    return result;
  } finally {
    await rm(temporary, { force: true }).catch((cause) => {
      throw failure('session_adoption_write_failed', temporary, cause);
    });
  }
}

async function publishFile(
  source: string,
  target: string,
  sourceLock: SessionLock,
  targetLock: SessionLock,
): Promise<PublishResult> {
  const sourceDigest = await digestOf(source);
  if (sourceDigest === null) return 'missing';
  const existing = await readExisting(target, sourceDigest);
  if (existing !== undefined) return existing;

  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const info = await lstat(source).catch((cause) => {
      if (isMissing(cause)) return undefined;
      throw failure('session_adoption_read_failed', source, cause);
    });
    if (info === undefined || !info.isFile()) return 'missing';
    await copyFile(source, temporary, constants.COPYFILE_EXCL).catch((cause) => {
      throw failure('session_adoption_write_failed', temporary, cause);
    });
    await utimes(temporary, info.atime, info.mtime).catch((cause) => {
      throw failure('session_adoption_write_failed', temporary, cause);
    });
    if (await digestOf(source) !== sourceDigest || await digestOf(temporary) !== sourceDigest) return 'busy';
    sourceLock.assertOwned();
    targetLock.assertOwned();
    try {
      await link(temporary, target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw failure('session_adoption_write_failed', target, cause);
      return await readExisting(target, sourceDigest) ?? 'busy';
    }
    return 'copied';
  } finally {
    await rm(temporary, { force: true }).catch((cause) => {
      throw failure('session_adoption_write_failed', temporary, cause);
    });
  }
}

function projectRootOfLegacyDirectory(directory: string): string | undefined {
  const resolved = resolve(directory);
  const metadataDirectory = basename(dirname(resolved));
  if (basename(resolved) !== 'sessions' || metadataDirectory !== '.ligule') return undefined;
  return dirname(dirname(resolved));
}

function referencedSpills(events: ReturnType<typeof parseSessionBytes>['events']): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    const spilled = (event.result as { spilled?: unknown } | undefined)?.spilled;
    if (typeof spilled === 'string' && SPILL_NAME.test(spilled)) names.add(spilled);
  }
  return names;
}

function referencedRunResults(events: ReturnType<typeof parseSessionBytes>['events']): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    if (event.kind === 'turn' && typeof event.runId === 'string' && isRunResultRef(event.resultRef, event.runId)) {
      names.add(event.resultRef.name);
    }
  }
  return names;
}

function recordBytes(name: string, source: Buffer, record: ReadSessionRecord, legacyProjectRoot: string | undefined): Buffer | undefined {
  if (record.header !== undefined) return source;
  if (legacyProjectRoot === undefined) return undefined;
  const id = name.slice(0, -'.jsonl'.length);
  const header = {
    kind: 'session',
    formatVersion: 0,
    sessionId: id,
    projectRoot: legacyProjectRoot,
    workspace: workspaceIdentity(legacyProjectRoot),
  };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), source]);
}

async function copyRecord(
  name: string,
  legacy: string,
  target: string,
  names: Set<string>,
  legacyProjectRoot: string | undefined,
  expectedProjectRoot: string | undefined,
  report: AdoptionReport,
): Promise<void> {
  const sourcePath = join(legacy, name);
  const targetPath = join(target, name);
  const samePath = resolve(sourcePath) === resolve(targetPath);
  let sourceLock: SessionLock | undefined;
  let targetLock: SessionLock | undefined;
  try {
    if (!samePath) {
      try {
        sourceLock = await acquireSessionLock(sourcePath);
      } catch (cause) {
        if ((cause as { code?: string }).code === 'session_locked') {
          report.busy.push(name);
          return;
        }
        throw failure('session_adoption_read_failed', sourcePath, cause);
      }
      try {
        targetLock = await acquireSessionLock(targetPath);
      } catch (cause) {
        if ((cause as { code?: string }).code === 'session_locked') {
          report.busy.push(name);
          return;
        }
        throw failure('session_adoption_write_failed', targetPath, cause);
      }
    }

    if (samePath) {
      report.already.push(name);
      return;
    }
    if (sourceLock === undefined || targetLock === undefined) {
      throw failure('session_adoption_write_failed', targetPath, new Error('session locks are required before publishing'));
    }
    const info = await lstat(sourcePath).catch((cause) => {
      if (isMissing(cause)) return undefined;
      throw failure('session_adoption_read_failed', sourcePath, cause);
    });
    if (info === undefined) return;
    if (!info.isFile()) {
      report.unknown.push(name);
      return;
    }
    const source = await readFile(sourcePath).catch((cause) => {
      if (isMissing(cause)) return undefined;
      throw failure('session_adoption_read_failed', sourcePath, cause);
    });
    if (source === undefined) return;
    let parsed: ReadSessionRecord;
    try {
      parsed = parseSessionBytes(source);
    } catch {
      report.unknown.push(name);
      return;
    }
    if (expectedProjectRoot !== undefined) {
      const recordedRoot = typeof parsed.header?.projectRoot === 'string' && parsed.header.projectRoot !== ''
        ? parsed.header.projectRoot
        : legacyProjectRoot;
      if (recordedRoot === undefined || workspaceIdentity(recordedRoot) !== workspaceIdentity(expectedProjectRoot)) {
        report.unknown.push(name);
        return;
      }
    }
    const record = recordBytes(name, source, parsed, legacyProjectRoot);
    if (record === undefined) {
      report.unknown.push(name);
      return;
    }
    const expectedDigest = createHash('sha256').update(record).digest('hex');
    const existing = await readExisting(targetPath, expectedDigest);
    if (existing === 'conflict') {
      report.conflicts.push(name);
      return;
    }

    const checkpointName = `${name.slice(0, -'.jsonl'.length)}.checkpoint.json`;
    const current = await readFile(sourcePath).catch((cause) => {
      if (isMissing(cause)) return undefined;
      throw failure('session_adoption_read_failed', sourcePath, cause);
    });
    if (current === undefined) return;
    if (!current.equals(source)) {
      report.busy.push(name);
      return;
    }
    const sidecars = [
      ...(names.has(checkpointName) ? [checkpointName] : []),
      ...referencedSpills(parsed.events),
      ...referencedRunResults(parsed.events),
    ];
    let sidecarConflict = false;
    for (const sidecar of new Set(sidecars)) {
      const sidecarResult = await publishFile(join(legacy, sidecar), join(target, sidecar), sourceLock, targetLock);
      if (sidecarResult === 'conflict') {
        report.conflicts.push(sidecar);
        sidecarConflict = true;
      } else if (sidecarResult === 'copied') report.copied.push(sidecar);
      else if (sidecarResult === 'already') report.already.push(sidecar);
      else if (sidecarResult === 'busy' || sidecarResult === 'missing') {
        report.busy.push(name);
        return;
      }
    }
    if (sidecarConflict) {
      report.conflicts.push(name);
      return;
    }

    const result = await publishBytes(record, targetPath, sourcePath, source, sourceLock, targetLock);
    if (result === 'copied') report.copied.push(name);
    else if (result === 'already') report.already.push(name);
    else if (result === 'conflict') report.conflicts.push(name);
    else if (result === 'busy' || result === 'missing') report.busy.push(name);
  } finally {
    await targetLock?.release();
    await sourceLock?.release();
  }
}

export async function adoptLegacySessions(
  legacy: string,
  target: string,
  { projectRoot = undefined as string | undefined, sessionId = undefined as string | undefined, userHome = undefined as string | undefined } = {},
): Promise<AdoptionReport> {
  const report: AdoptionReport = { copied: [], already: [], conflicts: [], unknown: [], busy: [] };
  let entries: string[];
  try {
    entries = await readdir(legacy);
  } catch (cause) {
    if (isMissing(cause)) return report;
    throw failure('session_adoption_read_failed', legacy, cause);
  }
  const names = new Set(entries);
  const userSessions = join(dataRoot(userHome), 'sessions');
  const legacyProjectRoot = await pathIdentity(legacy) === await pathIdentity(userSessions)
    ? undefined
    : projectRootOfLegacyDirectory(legacy);
  const records = entries.filter((name) => RECORD.test(name)
    && (sessionId === undefined || name === `${sessionId}.jsonl`)).sort();
  if (records.length === 0) return report;
  await mkdir(target, { recursive: true }).catch((cause) => {
    throw failure('session_adoption_write_failed', target, cause);
  });
  for (const name of records) await copyRecord(name, legacy, target, names, legacyProjectRoot, projectRoot, report);
  if (sessionId !== undefined) return report;
  for (const name of entries) {
    if (name.endsWith('.lock') || RECORD.test(name)) continue;
    if (!report.copied.includes(name) && !report.already.includes(name) && !report.conflicts.includes(name)) report.unknown.push(name);
  }
  return report;
}

/** 缺省解析出来的记录目录才做整理；项目根优先来自 Host 的实际工作区身份。 */
export async function adoptForSessionDirectory(
  config: { boundary: string; workspaceRoot?: string; userHome?: string; host?: { sessionDirectory?: unknown } },
  directory: string,
  projectRoot?: string,
  sessionId?: string,
): Promise<AdoptionReport | null> {
  const configured = config.host?.sessionDirectory;
  if (typeof configured === 'string' && configured !== '') return null;
  const legacyProjectRoot = config.workspaceRoot ?? projectRoot ?? config.boundary;
  const sources = [
    join(dataRoot(config.userHome), 'sessions'),
    join(legacyProjectRoot, '.ligule', 'sessions'),
  ].filter((source, index, all) => resolve(source) !== resolve(directory)
    && all.findIndex((candidate) => resolve(candidate) === resolve(source)) === index);
  const combined: AdoptionReport = { copied: [], already: [], conflicts: [], unknown: [], busy: [] };
  for (const source of sources) {
    const report = await adoptLegacySessions(source, directory, { projectRoot: legacyProjectRoot, sessionId, userHome: config.userHome });
    combined.copied.push(...report.copied);
    combined.already.push(...report.already);
    combined.conflicts.push(...report.conflicts);
    combined.unknown.push(...report.unknown);
    combined.busy.push(...report.busy);
    const selected = sessionId === undefined ? undefined : `${sessionId}.jsonl`;
    if (selected !== undefined && [report.copied, report.already, report.conflicts, report.busy].some((items) => items.includes(selected))) break;
  }
  return combined;
}
