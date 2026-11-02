import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, rename, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import sharp from 'sharp';
import { KernelError } from '../errors.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { dataRoot } from '../kernel/config-file.js';
import { sessionDirectories, workspaceDataDirectory, type SessionDirectoryConfig } from '../session/list.js';
import { parseSessionBytes } from '../session/record.js';
import { resolveWithin } from './paths.js';
import { boundaryOf, workingDirectoryOf } from './limits.js';
import { IMAGE_ID, IMAGE_LIMITS, isImageReference, type ImageReference } from '../session/media.js';
export { IMAGE_LIMITS, isImageReference, type ImageReference } from '../session/media.js';

export interface SessionMediaScan {
  readonly workspace: string;
  readonly directories: readonly { path: string; exists: boolean; files: readonly string[] }[];
  readonly entries: readonly { path: string; name: string; directoryIndex: number }[];
  readonly stamps: { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }[];
  readonly referenced: Set<string>;
  readonly sessions: Set<string>;
  position: number;
}

const FORMATS = new Set(['png', 'jpeg', 'webp', 'gif']);

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function cleanupIdentity(metadata: Stats, image: Stats, metadataDigest: string): string {
  return digest(Buffer.from(JSON.stringify([
    metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs,
    image.dev, image.ino, image.size, image.mtimeMs, image.ctimeMs, metadataDigest,
  ])));
}

async function readRegular(path: string, maxBytes: number, { allowHardLinks = false, signal }: { allowHardLinks?: boolean; signal?: AbortSignal } = {}): Promise<Buffer> {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (!allowHardLinks && before.nlink !== 1)) throw new KernelError('image_storage_link');
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > maxBytes) throw new KernelError('image_storage_invalid');
    // Read at most the approved size even if another process grows the file.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const result = await file.read(bytes, length, Math.min(bytes.length - length, 64 * 1024), null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new KernelError('image_bytes_exceeded');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function readImageFile(config: Parameters<typeof boundaryOf>[0], path: string, signal?: AbortSignal): Promise<Buffer> {
  const target = await resolveWithin(boundaryOf(config), path, { cwd: workingDirectoryOf(config) });
  return await readRegular(target, IMAGE_LIMITS.inputBytes, { allowHardLinks: true, signal });
}

async function exclusiveWrite(path: string, bytes: Buffer | string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
}

/** References remain local; providers resolve validated bytes only when constructing an HTTP request. */
export function createMediaStore(config: SessionDirectoryConfig, sessionId: string, inheritedReferences: readonly ImageReference[] = []) {
  if (sessionId.trim() === '' || sessionId.length > 256) throw new KernelError('image_session_required');
  const workspace = workspaceIdentity(config.workspaceRoot ?? config.boundary);
  const directory = join(workspaceDataDirectory(config), 'screenshots');
  const inherited = new Map(inheritedReferences.map(reference => {
    if (!isImageReference(reference) || reference.workspace !== workspace) throw new KernelError('image_owner_mismatch');
    return [reference.id, reference] as const;
  }));

  async function boundedSessionNames(path: string, maximum: number): Promise<string[]> {
    const names: string[] = [];
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (!entry.name.endsWith('.jsonl')) continue;
      if (names.length >= maximum) throw new KernelError('image_cleanup_scan_incomplete');
      names.push(entry.name);
    }
    return names.sort();
  }

  async function beginSessionScan(): Promise<SessionMediaScan> {
    const directories: SessionMediaScan['directories'][number][] = [];
    const entries: SessionMediaScan['entries'][number][] = [];
    for (const [index, path] of sessionDirectories(config).entries()) {
      let files: string[];
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('image_storage_link');
        files = await boundedSessionNames(path, 20_000 - entries.length);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        directories.push({ path, exists: false, files: [] });
        continue;
      }
      if (files.length > 20_000 || entries.length + files.length > 20_000) {
        throw new KernelError('image_cleanup_scan_incomplete');
      }
      directories.push({ path, exists: true, files });
      for (const name of files) entries.push({ path: join(path, name), directoryIndex: index, name });
    }
    return { workspace, directories, entries, position: 0, stamps: [], referenced: new Set(), sessions: new Set() };
  }

  async function advanceSessionScan(scan: SessionMediaScan): Promise<{
    complete: boolean; scannedSessions: number; readBytes: number; totalSessions: number;
  }> {
    if (scan.workspace !== workspace || scan.position > scan.entries.length
      || scan.stamps.length !== scan.position) throw new KernelError('image_cleanup_cursor_invalid');
    let scannedSessions = 0;
    let readBytes = 0;
    while (scan.position < scan.entries.length && scannedSessions < 100) {
      const entry = scan.entries[scan.position];
      const info = await lstat(entry.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new KernelError('image_storage_link');
      if (info.size > 16 * 1024 * 1024) throw new KernelError('image_cleanup_scan_incomplete');
      if (readBytes + info.size > 16 * 1024 * 1024 && scannedSessions > 0) break;
      const file = await open(entry.path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      let bytes: Buffer;
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino
          || opened.size !== info.size) throw new KernelError('image_cleanup_scan_incomplete');
        const chunks: Buffer[] = [];
        let length = 0;
        while (length <= info.size) {
          const amount = Math.min(64 * 1024, info.size + 1 - length);
          const chunk = Buffer.allocUnsafe(amount);
          const { bytesRead } = await file.read(chunk, 0, amount, null);
          if (bytesRead === 0) break;
          length += bytesRead;
          if (length > info.size) throw new KernelError('image_cleanup_scan_incomplete');
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const after = await file.stat();
        const current = await lstat(entry.path);
        if (length !== info.size || after.dev !== info.dev || after.ino !== info.ino
          || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
          || current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1
          || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) {
          throw new KernelError('image_cleanup_scan_incomplete');
        }
        bytes = Buffer.concat(chunks, length);
      } finally { await file.close(); }
      const lineEnd = bytes.indexOf(0x0a);
      const firstLine = bytes.subarray(0, lineEnd < 0 ? bytes.length : lineEnd).toString('utf8');
      let header: { workspace?: unknown; projectRoot?: unknown } | undefined;
      try {
        const parsed: unknown = JSON.parse(firstLine);
        if (typeof parsed === 'object' && parsed !== null) header = parsed as typeof header;
      } catch { /* Canonical parser below handles this workspace's corrupt records. */ }
      const attributed = header?.workspace
        ?? (typeof header?.projectRoot === 'string' && header.projectRoot !== '' ? workspaceIdentity(header.projectRoot) : undefined);
      if (!((attributed !== undefined && attributed !== workspace)
        || (entry.directoryIndex !== 0 && attributed !== workspace))) {
        const record = parseSessionBytes(bytes);
        const verified = record.header?.workspace
          ?? (record.header?.projectRoot ? workspaceIdentity(record.header.projectRoot) : undefined);
        if (verified === workspace || entry.directoryIndex === 0) {
          scan.sessions.add(entry.name.slice(0, -6));
          for (const event of record.events) {
            const result = event.kind === 'tool' && typeof event.result === 'object' && event.result !== null
              ? event.result as { images?: unknown } : undefined;
            if (!Array.isArray(result?.images)) continue;
            for (const reference of result.images) {
              if (!isImageReference(reference) || reference.workspace !== workspace) throw new KernelError('image_reference_invalid');
              scan.referenced.add(reference.id);
            }
          }
        }
      }
      scan.stamps.push({ path: entry.path, dev: info.dev, ino: info.ino, size: info.size,
        mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
      scan.position += 1;
      scannedSessions += 1;
      readBytes += bytes.length;
    }
    return { complete: scan.position === scan.entries.length, scannedSessions, readBytes,
      totalSessions: scan.entries.length };
  }

  // A completed multi-page scan is only a candidate snapshot. Recheck every record identity and
  // the complete directory membership before using its references as deletion authority.
  async function verifySessionScan(scan: SessionMediaScan): Promise<void> {
    if (scan.workspace !== workspace || scan.position !== scan.entries.length
      || scan.stamps.length !== scan.entries.length) throw new KernelError('image_cleanup_scan_incomplete');
    for (const directory of scan.directories) {
      let names: string[];
      try {
        const info = await lstat(directory.path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('image_storage_link');
        names = await boundedSessionNames(directory.path, directory.files.length + 1);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || directory.exists) {
          throw new KernelError('image_cleanup_scan_incomplete', { cause });
        }
        names = [];
      }
      if (names.length !== directory.files.length || names.some((name, i) => name !== directory.files[i])) {
        throw new KernelError('image_cleanup_scan_incomplete');
      }
    }
    for (const stamp of scan.stamps) {
      const info = await lstat(stamp.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || info.dev !== stamp.dev || info.ino !== stamp.ino || info.size !== stamp.size
        || info.mtimeMs !== stamp.mtimeMs || info.ctimeMs !== stamp.ctimeMs) {
        throw new KernelError('image_cleanup_scan_incomplete');
      }
    }
  }

  async function readSessionMedia(): Promise<{ referenced: Set<string>; sessions: Set<string> }> {
    const scan = await beginSessionScan();
    const page = await advanceSessionScan(scan);
    if (!page.complete) throw new KernelError('image_cleanup_scan_incomplete');
    await verifySessionScan(scan);
    return { referenced: scan.referenced, sessions: scan.sessions };
  }

  async function cleanup({ dryRun = true, limit = 100, allowedIds, expectedFingerprints, withFingerprints = false, sessionScan }: {
    dryRun?: boolean; limit?: number; allowedIds?: readonly string[];
    expectedFingerprints?: Readonly<Record<string, string>>; withFingerprints?: boolean; sessionScan?: SessionMediaScan;
  } = {})
    : Promise<{ scanned: number; referenced: number; candidates: number; removed: number; bytesFreed: number;
      ids: string[]; truncated: boolean; fingerprints?: Record<string, string>;
      skipped?: { id: string; reason: string }[] }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new KernelError('image_cleanup_limit_invalid');
    if (allowedIds !== undefined && (!Array.isArray(allowedIds) || allowedIds.length > 1000
      || allowedIds.some(id => typeof id !== 'string' || !IMAGE_ID.test(id)))) throw new KernelError('image_cleanup_ids_invalid');
    await checkDirectory(false);
    const mediaState = sessionScan === undefined ? await readSessionMedia() : (await verifySessionScan(sessionScan), sessionScan);
    const references = mediaState.referenced;
    let compromised: Error | undefined;
    const unlock = await lockfile.lock(directory, { realpath: false, lockfilePath: join(directory, '.write.lock'),
      retries: { retries: 20, minTimeout: 20, maxTimeout: 100 }, onCompromised: error => { compromised = error; } });
    try {
      await checkDirectory(false);
      const candidates: { id: string; sessionId: string; image: string; metadata: string; bytes: number;
        fingerprint: string }[] = [];
      const skipped = allowedIds === undefined ? undefined : new Map(allowedIds.map(id => [id, 'missing']));
      let scanned = 0;
      const sourceSessions = mediaState.sessions;
      const now = Date.now();
      const mediaDirectory = await opendir(directory);
      for await (const entry of mediaDirectory) {
        const name = entry.name;
        if (!name.endsWith('.json') || !IMAGE_ID.test(name.slice(0, -5))) continue;
        const id = name.slice(0, -5);
        scanned += 1;
        if (scanned > 1000) throw new KernelError('image_cleanup_scan_incomplete');
        if (allowedIds !== undefined && !allowedIds.includes(id)) continue;
        if (references.has(id)) { skipped?.set(id, 'referenced'); continue; }
        const metadata = join(directory, name);
        const image = join(directory, `${id}.png`);
        let metadataInfo: Stats;
        let imageInfo: Stats;
        try { [metadataInfo, imageInfo] = await Promise.all([lstat(metadata), lstat(image)]); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && skipped !== undefined) continue;
          throw cause;
        }
        for (const info of [metadataInfo, imageInfo]) {
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new KernelError('image_storage_link');
        }
        const metadataBytes = await readRegular(metadata, 8192);
        const stored = JSON.parse(metadataBytes.toString('utf8')) as ImageReference;
        if (!isImageReference(stored) || stored.id !== id || stored.workspace !== workspace) throw new KernelError('image_reference_invalid');
        if (sourceSessions.has(stored.sessionId)) { skipped?.set(id, 'source_session_exists'); continue; }
        if (now - Math.max(metadataInfo.mtimeMs, imageInfo.mtimeMs) <= IMAGE_LIMITS.retentionMs) {
          skipped?.set(id, 'not_expired'); continue;
        }
        const metadataDigest = digest(metadataBytes);
        const fingerprint = cleanupIdentity(metadataInfo, imageInfo, metadataDigest);
        if (expectedFingerprints !== undefined && expectedFingerprints[id] !== fingerprint) {
          skipped?.set(id, 'changed'); continue;
        }
        candidates.push({ id, sessionId: stored.sessionId, image, metadata,
          bytes: metadataInfo.size + imageInfo.size, fingerprint });
      }
      if (compromised !== undefined) throw compromised;
      const ids = candidates.slice(0, limit).map(candidate => candidate.id);
      const fingerprints = withFingerprints ? Object.fromEntries(candidates.slice(0, limit).map(candidate => [candidate.id, candidate.fingerprint])) : undefined;
      if (!dryRun) {
        // Re-scan canonical logs immediately under the media lock; source session existence protects append/branch races.
        const latest = sessionScan === undefined ? await readSessionMedia() : (await verifySessionScan(sessionScan), sessionScan);
        let removed = 0;
        let bytesFreed = 0;
        const removedIds: string[] = [];
        for (const candidate of candidates.slice(0, limit)) {
          if (latest.referenced.has(candidate.id) || latest.sessions.has(candidate.sessionId)) {
            skipped?.set(candidate.id, latest.referenced.has(candidate.id) ? 'referenced' : 'source_session_exists');
            continue;
          }
          let currentImage: Stats;
          let currentMetadata: Stats;
          try { [currentImage, currentMetadata] = await Promise.all([lstat(candidate.image), lstat(candidate.metadata)]); }
          catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && skipped !== undefined) continue;
            throw cause;
          }
          if (!currentImage.isFile() || !currentMetadata.isFile() || currentImage.isSymbolicLink() || currentMetadata.isSymbolicLink()
            || currentImage.nlink !== 1 || currentMetadata.nlink !== 1) throw new KernelError('image_storage_link');
          if (currentImage.size + currentMetadata.size !== candidate.bytes
            || cleanupIdentity(currentMetadata, currentImage, digest(await readRegular(candidate.metadata, 8192))) !== candidate.fingerprint) {
            skipped?.set(candidate.id, 'changed'); continue;
          }
          for (const path of [candidate.image, candidate.metadata]) {
            try { await unlink(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          removed += 1;
          bytesFreed += candidate.bytes;
          removedIds.push(candidate.id);
          skipped?.delete(candidate.id);
        }
        return { scanned, referenced: references.size, candidates: candidates.length, ids: removedIds, removed, bytesFreed,
          truncated: candidates.length > limit, ...(fingerprints === undefined ? {} : { fingerprints }),
          ...(skipped === undefined ? {} : { skipped: [...skipped].map(([id, reason]) => ({ id, reason })) }) };
      }
      return { scanned, referenced: references.size, candidates: candidates.length, ids, removed: 0, bytesFreed: 0,
        truncated: candidates.length > limit, ...(fingerprints === undefined ? {} : { fingerprints }) };
    } finally { await unlock(); }
  }
  function owns(reference: ImageReference): boolean {
    if (reference.workspace !== workspace) return false;
    if (reference.sessionId === sessionId) return true;
    const allowed = inherited.get(reference.id);
    return allowed !== undefined && (Object.keys(allowed) as (keyof ImageReference)[]).every(key => allowed[key] === reference[key]);
  }

  async function checkDirectory(create: boolean): Promise<void> {
    const root = dataRoot(config.userHome);
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const parts = relative(root, directory).split(sep);
    let path = root;
    for (const part of ['', ...parts]) {
      if (part !== '') path = join(path, part);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('image_storage_link');
    }
  }

  async function readMetadata(id: string): Promise<ImageReference> {
    if (!IMAGE_ID.test(id)) throw new KernelError('image_reference_invalid');
    const bytes = await readRegular(join(directory, `${id}.json`), 8192);
    let reference: unknown;
    try { reference = JSON.parse(bytes.toString('utf8')); }
    catch (cause) { throw new KernelError('image_reference_invalid', { cause }); }
    if (!isImageReference(reference) || reference.id !== id) throw new KernelError('image_reference_invalid');
    if (!owns(reference)) throw new KernelError('image_owner_mismatch');
    return reference;
  }

  async function read(reference: ImageReference, signal?: AbortSignal): Promise<Buffer> {
    try {
      signal?.throwIfAborted();
      if (!isImageReference(reference)) throw new KernelError('image_reference_invalid');
      if (!owns(reference)) throw new KernelError('image_owner_mismatch');
      await checkDirectory(false);
      const saved = await readMetadata(reference.id);
      for (const key of Object.keys(saved) as (keyof ImageReference)[]) {
        if (saved[key] !== reference[key]) throw new KernelError('image_reference_mismatch');
      }
      const bytes = await readRegular(join(directory, `${reference.id}.png`), IMAGE_LIMITS.outputBytes, { signal });
      if (bytes.length !== saved.bytes || digest(bytes) !== saved.sha256) throw new KernelError('image_digest_mismatch');
      signal?.throwIfAborted();
      return bytes;
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof KernelError) throw cause;
      throw new KernelError((cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'image_missing' : 'image_storage_read_failed', { cause });
    }
  }

  return {
    directory,
    beginSessionScan,
    advanceSessionScan,
    verifySessionScan,
    cleanup,
    read,
    async reference(id: string): Promise<ImageReference> {
      try {
        await checkDirectory(false);
        const result = await readMetadata(id);
        await read(result);
        return result;
      } catch (cause) {
        if (cause instanceof KernelError) throw cause;
        throw new KernelError((cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'image_missing' : 'image_storage_read_failed', { cause });
      }
    },
    async put(input: Buffer, source: ImageReference['source'], signal?: AbortSignal): Promise<ImageReference> {
      signal?.throwIfAborted();
      if (workspace.length > 2048) throw new KernelError('image_workspace_invalid');
      if (!['file', 'desktop', 'browser', 'document'].includes(source)) throw new KernelError('image_source_invalid');
      if (input.length === 0 || input.length > IMAGE_LIMITS.inputBytes) throw new KernelError('image_bytes_exceeded');
      const decoder = sharp(input, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: 'warning', page: 0, pages: 1 });
      // destroy(error) emits on the stream as well as rejecting an active Sharp promise.
      decoder.on('error', () => {});
      const cancel = () => { decoder.destroy(new Error('image_decode_cancelled')); };
      signal?.addEventListener('abort', cancel, { once: true });
      let bytes: Buffer;
      let width: number;
      let height: number;
      try {
        const metadata = await decoder.metadata();
        if (!FORMATS.has(metadata.format ?? '')) throw new KernelError('image_format_unsupported');
        if ((metadata.width ?? 0) * (metadata.height ?? 0) > IMAGE_LIMITS.pixels) throw new KernelError('image_pixels_exceeded');
        const output = await decoder.rotate().resize({ width: IMAGE_LIMITS.dimension, height: IMAGE_LIMITS.dimension, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
        bytes = output.data;
        width = output.info.width;
        height = output.info.height;
      } catch (cause) {
        signal?.throwIfAborted();
        if (cause instanceof KernelError) throw cause;
        throw new KernelError('image_decode_failed', { cause });
      } finally { signal?.removeEventListener('abort', cancel); decoder.destroy(); }
      signal?.throwIfAborted();
      if (bytes.length > IMAGE_LIMITS.outputBytes) throw new KernelError('image_bytes_exceeded');
      await checkDirectory(true);
      let compromised: Error | undefined;
      const unlock = await lockfile.lock(directory, { realpath: false, lockfilePath: join(directory, '.write.lock'),
        retries: { retries: 20, minTimeout: 20, maxTimeout: 100 }, onCompromised: error => { compromised = error; } });
      try {
        await checkDirectory(false);
        let stored = 0;
        for (const name of await readdir(directory)) {
          if (!/^[0-9a-f-]{36}\.(?:png|json)(?:\.part)?$/u.test(name) || !IMAGE_ID.test(name.slice(0, 36))) continue;
          const path = join(directory, name);
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new KernelError('image_storage_link');
          stored += info.size;
        }
        if (stored + bytes.length + 8192 > IMAGE_LIMITS.storageBytes) throw new KernelError('image_storage_full');
        signal?.throwIfAborted();
        if (compromised !== undefined) throw compromised;
        const id = randomUUID();
        const reference: ImageReference = { kind: 'image', version: 1, id, workspace, sessionId, source,
          mimeType: 'image/png', bytes: bytes.length, width, height, sha256: digest(bytes), createdAt: new Date().toISOString() };
        const imageTemp = join(directory, `${id}.png.part`);
        const metadataTemp = join(directory, `${id}.json.part`);
        let published = false;
        try {
          await exclusiveWrite(imageTemp, bytes);
          await rename(imageTemp, join(directory, `${id}.png`));
          await exclusiveWrite(metadataTemp, JSON.stringify(reference));
          signal?.throwIfAborted();
          if (compromised !== undefined) throw compromised;
          await checkDirectory(false);
          await rename(metadataTemp, join(directory, `${id}.json`));
          published = true;
          return reference;
        } finally {
          for (const path of [imageTemp, metadataTemp, ...(published ? [] : [join(directory, `${id}.png`)])]) {
            try { await unlink(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
      } finally { await unlock(); }
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;

/** A transient display derivative; canonical records contain only the original reference. */
export async function imagePreview(media: MediaStore, reference: ImageReference) {
  const bytes = await media.read(reference);
  const output = await sharp(bytes, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: 'warning' })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70 }).toBuffer({ resolveWithObject: true });
  if (output.data.length > 256 * 1024) throw new KernelError('image_preview_bytes_exceeded');
  return { imageId: reference.id, mimeType: 'image/webp' as const, base64: output.data.toString('base64'),
    width: output.info.width, height: output.info.height };
}
