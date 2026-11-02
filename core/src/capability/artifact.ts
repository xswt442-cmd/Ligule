import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { KernelError } from '../errors.js';
import { resolveWithin, isWithin } from './paths.js';
import type { FileArtifact } from '../session/artifact.js';

const FILE_LIMIT = 20 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const DESCRIPTION_LIMIT = 400;
const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.avif': 'image/avif', '.css': 'text/css', '.csv': 'text/csv', '.gif': 'image/gif', '.html': 'text/html',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown',
  '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.webp': 'image/webp',
  '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.zip': 'application/zip',
});

export interface PresentFile { readonly path: string; readonly description?: string }

function portablePath(path: string): string { return path.split(sep).join('/'); }

export async function readFileArtifact(
  { path, description }: PresentFile, sessionId: string, workspaceRoot: string, boundary: string,
  signal?: AbortSignal, remainingBytes = TOTAL_LIMIT, previewLimit = 0,
): Promise<{ artifact: FileArtifact; size: number; preview?: Buffer }> {
  signal?.throwIfAborted();
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048 || isAbsolute(path) || path.split(/[\\/]/u).some((part) => part === '..' || part === '')) {
    throw new KernelError('artifact_path_invalid');
  }
  if (description !== undefined && (typeof description !== 'string' || [...description].length > DESCRIPTION_LIMIT)) throw new KernelError('artifact_description_invalid');
  const absoluteWorkspace = resolve(workspaceRoot);
  const lexicalTarget = resolve(absoluteWorkspace, path);
  const lexicalRelative = relative(absoluteWorkspace, lexicalTarget);
  let cursor = absoluteWorkspace;
  for (const part of lexicalRelative.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new KernelError('artifact_file_invalid');
    } catch (cause) {
      if (cause instanceof KernelError) throw cause;
      if (typeof cause !== 'object' || cause === null || !('code' in cause) || cause.code !== 'ENOENT') throw cause;
    }
  }
  const workspaceTarget = await resolveWithin(absoluteWorkspace, path, { cwd: absoluteWorkspace });
  const realBoundary = await realpath(boundary);
  if (!isWithin(realBoundary, workspaceTarget)) throw new KernelError('path_escapes_boundary');
  const relativePath = relative(absoluteWorkspace, workspaceTarget);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new KernelError('path_escapes_workspace');
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0));
  let handle;
  try { handle = await open(workspaceTarget, flags); }
  catch (cause) { throw new KernelError('artifact_file_unavailable', { cause }); }
  try {
    const info = await handle.stat();
    const linkInfo = await lstat(workspaceTarget);
    const currentReal = await realpath(workspaceTarget);
    if (linkInfo.isSymbolicLink() || !info.isFile() || !linkInfo.isFile() || !isWithin(realBoundary, currentReal) || currentReal !== workspaceTarget
      || info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) {
      throw new KernelError('artifact_file_invalid');
    }
    if (info.size > FILE_LIMIT) throw new KernelError('artifact_file_too_large');
    if (info.size > remainingBytes) throw new KernelError('artifact_total_too_large');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const previewChunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      signal?.throwIfAborted();
      const ceiling = Math.min(FILE_LIMIT, remainingBytes);
      const length = Math.min(chunk.length, ceiling + 1 - size);
      if (length <= 0) throw new KernelError(ceiling === FILE_LIMIT ? 'artifact_file_too_large' : 'artifact_total_too_large');
      const { bytesRead } = await handle.read(chunk, 0, length, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > FILE_LIMIT) throw new KernelError('artifact_file_too_large');
      if (size > remainingBytes) throw new KernelError('artifact_total_too_large');
      hash.update(chunk.subarray(0, bytesRead));
      const available = Math.min(bytesRead, Math.max(0, previewLimit - (size - bytesRead)));
      if (available > 0) previewChunks.push(Buffer.from(chunk.subarray(0, available)));
    }
    const [after, pathAfter, realAfter] = await Promise.all([handle.stat(), lstat(workspaceTarget), realpath(workspaceTarget)]);
    signal?.throwIfAborted();
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || after.dev !== info.dev || after.ino !== info.ino || pathAfter.dev !== info.dev || pathAfter.ino !== info.ino
      || realAfter !== workspaceTarget || !isWithin(realBoundary, realAfter)
      || after.size !== info.size || size !== info.size
      || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new KernelError('artifact_file_changed');
    }
    const artifact: FileArtifact = {
      kind: 'file', sessionId, path: portablePath(relative(absoluteWorkspace, workspaceTarget)),
      mimeType: MEDIA_TYPES[extname(workspaceTarget).toLowerCase()] ?? 'application/octet-stream',
      bytes: size, sha256: hash.digest('hex'),
      ...(description === undefined ? {} : { description }),
    };
    return { artifact, size, ...(previewLimit === 0 ? {} : { preview: Buffer.concat(previewChunks) }) };
  } finally { await handle.close(); }
}

export async function readFileArtifacts(files: readonly PresentFile[], sessionId: string, workspaceRoot: string, boundary: string, signal?: AbortSignal): Promise<readonly FileArtifact[]> {
  if (!Array.isArray(files) || files.length < 1 || files.length > 16) throw new KernelError('artifact_file_count_invalid');
  const artifacts: FileArtifact[] = [];
  let total = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const result = await readFileArtifact(file, sessionId, workspaceRoot, boundary, signal, TOTAL_LIMIT - total);
    total += result.size;
    if (total > TOTAL_LIMIT) throw new KernelError('artifact_total_too_large');
    artifacts.push(result.artifact);
  }
  return artifacts;
}

export async function previewFileArtifact(artifact: FileArtifact, workspaceRoot: string, boundary: string) {
  const isImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mimeType);
  const isText = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'application/yaml'].includes(artifact.mimeType);
  const current = await readFileArtifact({ path: artifact.path }, artifact.sessionId, workspaceRoot, boundary,
    undefined, TOTAL_LIMIT, isImage ? FILE_LIMIT : isText ? 8192 : 0);
  if (current.artifact.sha256 !== artifact.sha256 || current.size !== artifact.bytes) throw new KernelError('artifact_modified');
  if (isText) return { type: 'text' as const, text: current.preview!.toString('utf8'), truncated: current.size > current.preview!.length };
  if (isImage) {
    const converted = await sharp(current.preview!, { limitInputPixels: 40_000_000, failOn: 'warning', page: 0, pages: 1 })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 }).toBuffer();
    if (converted.byteLength > 256 * 1024) throw new KernelError('artifact_preview_too_large');
    return { type: 'image' as const, mimeType: 'image/webp', base64: converted.toString('base64') };
  }
  return { type: 'unsupported_preview' as const };
}
