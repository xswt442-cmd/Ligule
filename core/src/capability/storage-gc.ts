// Workspace storage GC is opt-in: only Ligule-owned, versioned directories can be reclaimed.
// Unknown legacy directories, Session records, result sidecars and user files are never candidates.
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rmdir, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { KernelError } from '../errors.js';

export type StorageGcKind = 'browser' | 'cache' | 'tmp';
export interface StorageGcCandidate {
  readonly id: string;
  readonly kind: StorageGcKind;
  readonly name: string;
  readonly sessionId: string;
  readonly fingerprint: string;
  readonly bytes: number;
}
interface Marker { readonly version: 1; readonly workspace: string; readonly kind: StorageGcKind;
  readonly id: string; readonly sessionId: string; readonly createdAt: string }
interface Node { path: string; relative: string; directory: boolean; stamp: string; identity: string; depth: number }
const MARKER = '.ligule-owner.json';
const LEASE = '.ligule-lease.lock';
const PARENT_LOCK = '.ligule-parent.lock';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;
const NAME = /^[A-Za-z0-9._-]{1,256}$/u;

function digest(input: string): string { return createHash('sha256').update(input).digest('hex'); }
function stamp(info: Stats): string {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(':');
}
function checkedName(value: string): void {
  if (!NAME.test(value) || value === '.' || value === '..' || value.startsWith('.ligule-')) throw new KernelError('storage_owner_invalid');
}
export function storageGcParent(root: string, kind: StorageGcKind): string {
  return kind === 'browser' ? join(root, 'browser', 'sessions')
    : kind === 'cache' ? join(root, 'cache', 'owned') : join(root, 'tmp');
}
async function regular(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new KernelError('storage_owner_invalid');
  }
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) {
      throw new KernelError('storage_owner_invalid');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new KernelError('storage_owner_invalid');
    }
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}
async function markerOf(directory: string, workspace: string, kind: StorageGcKind, id: string): Promise<Marker> {
  const value: unknown = JSON.parse((await regular(join(directory, MARKER), 4096)).toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('storage_owner_invalid');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 6 || item.version !== 1 || item.workspace !== workspace
    || item.kind !== kind || item.id !== id || typeof item.sessionId !== 'string'
    || !NAME.test(item.sessionId) || typeof item.createdAt !== 'string'
    || !Number.isFinite(Date.parse(item.createdAt))) throw new KernelError('storage_owner_invalid');
  return item as unknown as Marker;
}
async function directoryInfo(path: string): Promise<Stats> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('storage_path_invalid');
  return info;
}
async function safeTree(directory: string): Promise<{ nodes: Node[]; fingerprint: string; bytes: number; latest: number }> {
  const root = await directoryInfo(directory);
  const nodes: Node[] = [];
  const pending = [{ path: directory, depth: 0 }];
  let bytes = 0;
  let latest = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const items: string[] = [];
    const listing = await opendir(current.path);
    for await (const entry of listing) {
      if (items.length > MAX_ENTRIES - nodes.length) throw new KernelError('storage_cleanup_scan_incomplete');
      items.push(entry.name);
    }
    items.sort();
    for (const name of items) {
      if (current.depth === 0 && name === LEASE) {
        const lease = await lstat(join(current.path, name));
        if (!lease.isDirectory() || lease.isSymbolicLink()) throw new KernelError('storage_path_invalid');
        continue;
      }
      if (nodes.length >= MAX_ENTRIES || current.depth >= 16) throw new KernelError('storage_cleanup_scan_incomplete');
      const path = join(current.path, name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())
        || (info.isFile() && info.nlink !== 1)) throw new KernelError('storage_path_invalid');
      const rel = relative(directory, path);
      if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) throw new KernelError('storage_path_invalid');
      nodes.push({ path, relative: rel, directory: info.isDirectory(), stamp: stamp(info),
        identity: info.dev + ':' + info.ino, depth: current.depth + 1 });
      if (info.isFile()) { bytes += info.size; latest = Math.max(latest, info.mtimeMs); }
      else pending.push({ path, depth: current.depth + 1 });
    }
  }
  nodes.sort((a, b) => a.relative.localeCompare(b.relative));
  return { nodes, bytes, latest, fingerprint: digest(JSON.stringify([root.dev, root.ino, root.mode,
    nodes.map(node => [node.relative, node.directory, node.stamp])])) };
}
async function leaseActive(directory: string): Promise<boolean> {
  try {
    const info = await lstat(join(directory, LEASE));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('storage_path_invalid');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  return await lockfile.check(join(directory, MARKER), { realpath: false,
    lockfilePath: join(directory, LEASE), stale: 120_000 });
}
async function withParentLock<T>(parent: string, work: () => Promise<T>): Promise<T> {
  await directoryInfo(parent);
  try {
    const info = await lstat(join(parent, PARENT_LOCK));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('storage_path_invalid');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  const release = await lockfile.lock(parent, { realpath: false, lockfilePath: join(parent, PARENT_LOCK),
    stale: 120_000, retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } });
  try { return await work(); }
  finally { await release(); }
}
// Browser sessions use this lease for their entire lifetime. Future cache/tmp producers must do likewise.
export async function claimStorageOwner(root: string, workspace: string, kind: StorageGcKind,
  id: string, sourceSessionId?: string): Promise<() => Promise<void>> {
  if (kind !== 'browser' && sourceSessionId === undefined) throw new KernelError('storage_owner_invalid');
  const sessionId = sourceSessionId ?? id;
  checkedName(id);
  checkedName(sessionId);
  const parent = storageGcParent(root, kind);
  // The caller must already have established the workspace data root; reject links at every owned level.
  let cursor = root;
  await directoryInfo(cursor);
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { await mkdir(cursor, { mode: 0o700 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    await directoryInfo(cursor);
  }
  return await withParentLock(parent, async () => {
    const directory = join(parent, id);
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    await directoryInfo(directory);
    const marker = join(directory, MARKER);
    // Never adopt an existing unmarked directory, even if it happens to use a managed-looking ID.
    if (created) {
      const file = await open(marker, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, workspace, kind, id,
        sessionId, createdAt: new Date().toISOString() } satisfies Marker)); await file.sync(); }
      finally { await file.close(); }
    }
    let claimed: Marker;
    try { claimed = await markerOf(directory, workspace, kind, id); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('storage_owner_invalid');
      throw cause;
    }
    if (claimed.sessionId !== sessionId) throw new KernelError('storage_owner_invalid');
    return await lockfile.lock(marker, { realpath: false, lockfilePath: join(directory, LEASE),
      stale: 120_000, retries: 0 });
  });
}
export async function closeStorageOwner(root: string, kind: StorageGcKind, id: string,
  release: () => Promise<void>, remove: () => Promise<void>): Promise<void> {
  checkedName(id);
  const parent = storageGcParent(root, kind);
  await withParentLock(parent, async () => {
    await release();
    await remove();
  });
}
export async function previewStorageGarbage(root: string, workspace: string,
  liveSessions: ReadonlySet<string>): Promise<{ candidates: StorageGcCandidate[]; scannedEntries: number }> {
  const candidates: StorageGcCandidate[] = [];
  let scannedEntries = 0;
  for (const kind of ['browser', 'cache', 'tmp'] as const) {
    const parent = storageGcParent(root, kind);
    let names: string[];
    try {
      await directoryInfo(parent);
      names = [];
      const listing = await opendir(parent);
      for await (const entry of listing) {
        if (names.length >= 1000) throw new KernelError('storage_cleanup_scan_incomplete');
        names.push(entry.name);
      }
      names.sort();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw cause;
    }
    for (const id of names) {
      if (++scannedEntries > 3000) throw new KernelError('storage_cleanup_scan_incomplete');
      if (!NAME.test(id) || id === '.' || id === '..') continue;
      const directory = join(parent, id);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue; // Unknown legacy files and links stay untouched.
      let marker: Marker;
      try { marker = await markerOf(directory, workspace, kind, id); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue; // Unknown legacy data is protected.
        throw cause;
      }
      if (liveSessions.has(marker.sessionId) || await leaseActive(directory)) continue;
      const snapshot = await safeTree(directory);
      if (Date.now() - Math.max(snapshot.latest, Date.parse(marker.createdAt)) < RETENTION_MS) continue;
      candidates.push({ id: kind + ':' + id, kind, name: id, sessionId: marker.sessionId,
        fingerprint: snapshot.fingerprint, bytes: snapshot.bytes });
      if (candidates.length >= 100) break;
    }
  }
  return { candidates, scannedEntries };
}
export async function applyStorageGarbage(root: string, workspace: string,
  liveSessions: ReadonlySet<string>, candidates: readonly StorageGcCandidate[],
  verifySessionHistory: () => Promise<void> = async () => {}): Promise<{
    removed: number; bytesFreed: number; ids: string[]; skipped: { id: string; reason: string }[];
  }> {
  let removed = 0;
  let bytesFreed = 0;
  const ids: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const candidate of candidates) {
    const parent = storageGcParent(root, candidate.kind);
    const directory = join(parent, candidate.name);
    if (liveSessions.has(candidate.sessionId)) {
      skipped.push({ id: candidate.id, reason: 'source_session_exists' }); continue;
    }
    try {
      await withParentLock(parent, async () => {
        await directoryInfo(directory);
        const marker = await markerOf(directory, workspace, candidate.kind, candidate.name);
        if (marker.sessionId !== candidate.sessionId) throw new KernelError('storage_candidate_changed');
        if (await leaseActive(directory)) throw new KernelError('storage_active_lease');
        const release = await lockfile.lock(join(directory, MARKER), { realpath: false,
          lockfilePath: join(directory, LEASE), stale: 120_000, retries: 0 });
        try {
          await verifySessionHistory();
          const current = await safeTree(directory);
          if (current.fingerprint !== candidate.fingerprint
            || Date.now() - Math.max(current.latest, Date.parse(marker.createdAt)) < RETENTION_MS) {
            throw new KernelError('storage_candidate_changed');
          }
          // Remove only the checked tree, verifying each original identity immediately before unlink.
          for (const node of current.nodes.filter(item => !item.directory).sort((a, b) => b.depth - a.depth)) {
            const info = await lstat(node.path);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || stamp(info) !== node.stamp) {
              throw new KernelError('storage_candidate_changed');
            }
            await unlink(node.path);
          }
          for (const node of current.nodes.filter(item => item.directory).sort((a, b) => b.depth - a.depth)) {
            const info = await directoryInfo(node.path);
            if (info.dev + ':' + info.ino !== node.identity) throw new KernelError('storage_candidate_changed');
            await rmdir(node.path);
          }
        } finally { await release(); }
        await rmdir(directory);
      });
      removed += 1;
      bytesFreed += candidate.bytes;
      ids.push(candidate.id);
    } catch (cause) {
      if (cause instanceof KernelError && ['storage_active_lease', 'storage_candidate_changed'].includes(cause.code)) {
        skipped.push({ id: candidate.id, reason: cause.code }); continue;
      }
      throw cause;
    }
  }
  return { removed, bytesFreed, ids, skipped };
}
