import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelError } from '../errors.js';
import { IMAGE_LIMITS } from '../media.js';
import { createOwnedProcessJob } from './win32-job.js';

export interface CaptureOptions {
  readonly target?: 'screen' | 'active-window';
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}
export interface CapturedScreen {
  readonly png: Buffer;
  readonly target: 'screen' | 'active-window';
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}
export const SCREEN_CAPTURE_TIMEOUT_MS = 12_000;

export function checkedCaptureOptions(value: unknown): CaptureOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('screenshot_options_invalid');
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => key !== 'target' && key !== 'region')
    || (options.target !== undefined && options.target !== 'screen' && options.target !== 'active-window')) throw new KernelError('screenshot_options_invalid');
  if (options.region !== undefined) {
    if (typeof options.region !== 'object' || options.region === null || Array.isArray(options.region)) throw new KernelError('screenshot_region_invalid');
    const region = options.region as Record<string, unknown>;
    if (Object.keys(region).length !== 4 || Object.keys(region).some(key => !['x', 'y', 'width', 'height'].includes(key))
      || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(region[key]))
      || Number(region.x) < 0 || Number(region.y) < 0 || Number(region.width) < 1 || Number(region.height) < 1
      || Number(region.x) > 100_000 || Number(region.y) > 100_000 || Number(region.width) * Number(region.height) > IMAGE_LIMITS.pixels) {
      throw new KernelError('screenshot_region_invalid');
    }
  }
  return { target: options.target as CaptureOptions['target'] ?? 'screen',
    ...(options.region === undefined ? {} : { region: { ...options.region } as CaptureOptions['region'] }) };
}

/** One isolated native capture. The worker waits until its bounded Windows Job owns it. */
export async function captureScreen(options: CaptureOptions = {}, signal?: AbortSignal): Promise<CapturedScreen> {
  const checked = checkedCaptureOptions(options);
  signal?.throwIfAborted();
  if (process.platform !== 'win32') throw new KernelError('screenshot_platform_unsupported');
  const job = await createOwnedProcessJob({ assignCurrentProcess: false, processMemoryBytes: 512 * 1024 * 1024 });
  try {
    signal?.throwIfAborted();
    const worker = fileURLToPath(new URL('./screen-capture-worker.js', import.meta.url));
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'TEMP', 'TMP', 'LOCALAPPDATA', 'SESSIONNAME']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const capture = spawn(process.execPath, ['--max-old-space-size=64', worker], {
      cwd: dirname(worker), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    return await new Promise<CapturedScreen>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: KernelError | undefined;
      let metadata: { sourceWidth: number; sourceHeight: number } | undefined;
      const stop = (error: KernelError) => {
        failure ??= error;
        try { job.close(); }
        catch (cause) { failure = new KernelError('screenshot_cleanup_failed', { cause: new AggregateError([failure, cause], 'capture cleanup failed') }); }
        capture.kill();
      };
      const abort = () => stop(signal?.reason instanceof KernelError ? signal.reason : new KernelError('screenshot_cancelled'));
      const timer = setTimeout(() => stop(new KernelError('screenshot_timeout')), SCREEN_CAPTURE_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      capture.stderr?.resume();
      capture.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > IMAGE_LIMITS.outputBytes) stop(new KernelError('screenshot_bytes_exceeded'));
        else chunks.push(chunk);
      });
      capture.on('message', message => {
        if (typeof message !== 'object' || message === null) return;
        if ('ready' in message && message.ready === capture.pid) {
          if (failure !== undefined) return;
          try {
            job.assignPid(capture.pid!);
            if (signal?.aborted) abort();
            else capture.send(checked, error => { if (error !== null) stop(new KernelError('screenshot_worker_failed')); });
          } catch { stop(new KernelError('screenshot_worker_failed')); }
        } else if ('error' in message && typeof message.error === 'string') {
          const codes = ['screenshot_backend_unavailable', 'screenshot_unavailable', 'screenshot_permission_denied', 'screenshot_no_active_window',
            'screenshot_pixels_exceeded', 'screenshot_region_invalid', 'screenshot_bytes_exceeded', 'screenshot_window_spans_monitors', 'screenshot_window_changed', 'screenshot_display_changed'];
          failure ??= new KernelError(codes.includes(message.error) ? message.error : 'screenshot_capture_failed');
        } else if ('sourceWidth' in message && 'sourceHeight' in message
          && Number.isSafeInteger(message.sourceWidth) && Number.isSafeInteger(message.sourceHeight)
          && Number(message.sourceWidth) > 0 && Number(message.sourceHeight) > 0) {
          metadata = { sourceWidth: Number(message.sourceWidth), sourceHeight: Number(message.sourceHeight) };
        }
      });
      capture.once('error', () => { failure ??= new KernelError('screenshot_worker_failed'); });
      capture.once('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure !== undefined) reject(failure);
        else if (code !== 0 || bytes === 0 || metadata === undefined) reject(new KernelError('screenshot_capture_failed'));
        else resolve({ png: Buffer.concat(chunks), target: checked.target ?? 'screen', ...metadata });
      });
      if (capture.pid === undefined) stop(new KernelError('screenshot_worker_failed'));
      else if (signal?.aborted) abort();
    });
  } finally { job.close(); }
}
