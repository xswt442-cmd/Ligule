import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelError } from '../errors.js';
import { boundaryOf, limitsOf, workingDirectoryOf, type CapabilityConfig } from './limits.js';
import { resolveWithin } from './paths.js';
import { createOwnedProcessJob } from './win32-job.js';
import { checkedDocumentOptions, DOCUMENT_LIMITS, type DocumentOptions, type DocumentResult } from './document-types.js';
export type { DocumentOptions, DocumentResult } from './document-types.js';

let active = 0;

async function readInput(config: CapabilityConfig, path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const target = await resolveWithin(boundaryOf(config), path, { cwd: workingDirectoryOf(config) });
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new KernelError('document_file_invalid');
  const file = await open(target, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new KernelError('document_file_changed');
    if (info.size === 0 || info.size > maxBytes) throw new KernelError('document_bytes_exceeded');
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      signal?.throwIfAborted();
      const next = await file.read(bytes, used, Math.min(bytes.length - used, 64 * 1024), null);
      if (next.bytesRead === 0) break;
      used += next.bytesRead;
    }
    if (used === 0 || used > maxBytes) throw new KernelError('document_bytes_exceeded');
    return bytes.subarray(0, used);
  } finally { await file.close(); }
}

/** Parses bytes in a disposable process; the worker cannot write files or spawn processes. */
export async function readDocument(config: CapabilityConfig, options: DocumentOptions, signal?: AbortSignal): Promise<{ result: DocumentResult; png?: Buffer }> {
  const format = checkedDocumentOptions(options);
  const limits = limitsOf(config);
  if (![limits.documentBytes, limits.documentOutputBytes, limits.documentTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1)
    || limits.documentOutputBytes < 256) throw new KernelError('document_limits_invalid');
  if (active >= 2) throw new KernelError('document_busy');
  active++;
  const job = process.platform === 'win32'
    ? await createOwnedProcessJob({ assignCurrentProcess: false, processMemoryBytes: 512 * 1024 * 1024 }).catch(error => { active--; throw error; }) : undefined;
  try {
    const input = await readInput(config, options.path, Math.min(limits.documentBytes, DOCUMENT_LIMITS.inputBytes), signal);
    if (format !== 'pdf' && input.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new KernelError('document_encrypted_or_legacy');
    const worker = fileURLToPath(new URL('./document-worker.js', import.meta.url));
    const core = dirname(dirname(dirname(worker)));
    const roots = [core];
    // pnpm symlinks resolve into the workspace node_modules; installed packages use an ancestor node_modules.
    for (let parent = core; ; parent = dirname(parent)) {
      try { roots.push(await realpath(join(parent, 'node_modules'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (dirname(parent) === parent) break;
    }
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(process.execPath, ['--max-old-space-size=192', '--permission', '--allow-addons',
      ...[...new Set(roots)].map(path => `--allow-fs-read=${path}`), worker], {
      env, cwd: dirname(worker), windowsHide: true, detached: process.platform !== 'win32',
      serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    return await new Promise((resolve, reject) => {
      let failure: KernelError | undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let started = false;
      let diagnosticTail = '';
      let warned = false;
      let imageTooLarge = false;
      const stop = (error: KernelError) => {
        failure ??= error;
        try {
          if (job !== undefined) job.close();
          else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') failure = new KernelError('document_cleanup_failed', { cause });
        }
        child.kill();
      };
      const abort = () => stop(new KernelError('document_cancelled'));
      const timer = setTimeout(() => stop(new KernelError('document_timeout')), Math.min(limits.documentTimeoutMs, DOCUMENT_LIMITS.timeoutMs));
      signal?.addEventListener('abort', abort, { once: true });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = diagnosticTail + chunk.toString('utf8');
        warned ||= /(?:^|[\r\n])Warning:/u.test(text);
        imageTooLarge ||= text.includes('Image exceeded maximum allowed size');
        diagnosticTail = text.slice(-512);
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 12 * 1024 * 1024) stop(new KernelError('document_output_exceeded'));
        else chunks.push(chunk);
      });
      child.on('message', message => {
        if (typeof message !== 'object' || message === null) return;
        if ('ready' in message && message.ready === child.pid && !started && failure === undefined) {
          started = true;
          try {
            job?.assignPid(child.pid!);
            if (signal?.aborted) abort();
            else child.send({ options, format, input, outputBytes: Math.min(limits.documentOutputBytes, DOCUMENT_LIMITS.outputBytes) }, error => {
              if (error !== null) stop(new KernelError('document_worker_failed'));
            });
          } catch { stop(new KernelError('document_worker_failed')); }
        } else if ('error' in message && typeof message.error === 'string') {
          failure ??= new KernelError(/^document_[a-z_]{1,60}$/u.test(message.error) ? message.error : 'document_parse_failed');
        }
      });
      child.once('error', () => { failure ??= new KernelError('document_worker_failed'); });
      child.once('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure !== undefined) { reject(signal?.aborted ? signal.reason : failure); return; }
        // PDF.js can finish after omitting an image; a warned render must never look complete.
        if (format === 'pdf' && options.renderPage !== undefined && warned) {
          reject(new KernelError(imageTooLarge ? 'document_pixels_exceeded' : 'document_render_incomplete'));
          return;
        }
        if (code !== 0 || !started || bytes === 0) { reject(new KernelError('document_worker_failed')); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result: DocumentResult; png?: string };
          if (value.result?.format !== format || !Array.isArray(value.result.chunks)) throw new Error('invalid result');
          if (format === 'pdf' && warned) value.result = { ...value.result, truncated: true,
            warnings: [...value.result.warnings, 'PDF parser reported warnings; extracted text may be incomplete.'] };
          resolve({ result: value.result, ...(value.png === undefined ? {} : { png: Buffer.from(value.png, 'base64') }) });
        } catch (cause) { reject(new KernelError('document_worker_failed', { cause })); }
      });
      if (child.pid === undefined) stop(new KernelError('document_worker_failed'));
      else if (signal?.aborted) abort();
    });
  } finally { try { job?.close(); } finally { active--; } }
}
