import { KernelError } from '../errors.js';
import { IMAGE_LIMITS } from '../session/media.js';
import { checkedCaptureOptions } from './screen-capture.js';
const PER_MONITOR_AWARE_V2 = -4;
const DESKTOP_READOBJECTS = 1;
const UOI_NAME = 2;

async function assertInteractiveDesktop(): Promise<void> {
  const koffi = (await import('koffi')).default;
  const user = koffi.load('user32.dll');
  const openDesktop = user.func('__stdcall', 'OpenInputDesktop', 'intptr', ['uint32_t', 'int', 'uint32_t']) as (flags: number, inherit: number, access: number) => number | bigint;
  const closeDesktop = user.func('__stdcall', 'CloseDesktop', 'int', ['intptr']) as (handle: number | bigint) => number;
  const setDpi = user.func('__stdcall', 'SetThreadDpiAwarenessContext', 'intptr', ['intptr']) as (context: number) => number | bigint;
  const setProcessDpi = user.func('__stdcall', 'SetProcessDpiAwarenessContext', 'int', ['intptr']) as (context: number) => number;
  const processDpiAware = user.func('__stdcall', 'IsProcessDPIAware', 'int', []) as () => number;
  if (setProcessDpi(PER_MONITOR_AWARE_V2) === 0 && processDpiAware() === 0) throw new KernelError('screenshot_backend_unavailable');
  const previousDpi = setDpi(PER_MONITOR_AWARE_V2);
  if (previousDpi === 0 || previousDpi === 0n) throw new KernelError('screenshot_backend_unavailable');
  const desktop = openDesktop(0, 0, DESKTOP_READOBJECTS);
  if (desktop === 0 || desktop === 0n) throw new KernelError('screenshot_permission_denied');
  try {
    const getInfo = user.func('__stdcall', 'GetUserObjectInformationW', 'int', ['intptr', 'int', 'void*', 'uint32_t', 'void*']) as
      (handle: number | bigint, kind: number, buffer: Buffer, length: number, needed: Buffer) => number;
    const name = Buffer.alloc(512);
    if (getInfo(desktop, UOI_NAME, name, name.length, Buffer.alloc(4)) === 0
      || name.toString('utf16le').split('\0', 1)[0]?.toLowerCase() !== 'default') throw new KernelError('screenshot_unavailable');
  } finally { if (closeDesktop(desktop) === 0) throw new KernelError('screenshot_permission_denied'); }
}

async function performCapture(value: unknown): Promise<void> {
  const options = checkedCaptureOptions(value);
  let native: typeof import('node-screenshots');
  let sharp: typeof import('sharp')['default'];
  try {
    await assertInteractiveDesktop();
    native = await import('node-screenshots');
    sharp = (await import('sharp')).default;
  } catch (cause) {
    if (cause instanceof KernelError) throw cause;
    throw new KernelError('screenshot_backend_unavailable');
  }
  const window = options.target === 'active-window' ? native.Window.all().find(item => item.isFocused() && !item.isMinimized()) : undefined;
  if (options.target === 'active-window' && window === undefined) throw new KernelError('screenshot_no_active_window');
  const monitor = window?.currentMonitor() ?? native.Monitor.all().find(item => item.isPrimary());
  if (monitor === undefined) throw new KernelError('screenshot_unavailable');
  const sourceWidth = window?.width() ?? monitor.width();
  const sourceHeight = window?.height() ?? monitor.height();
  const sourceX = window?.x() ?? monitor.x();
  const sourceY = window?.y() ?? monitor.y();
  const monitorBounds = { x: monitor.x(), y: monitor.y(), width: monitor.width(), height: monitor.height(), rotation: monitor.rotation() };
  if (sourceWidth < 1 || sourceHeight < 1 || sourceWidth * sourceHeight > IMAGE_LIMITS.pixels) throw new KernelError('screenshot_pixels_exceeded');
  if (options.region !== undefined && (options.region.x + options.region.width > sourceWidth || options.region.y + options.region.height > sourceHeight)) {
    throw new KernelError('screenshot_region_invalid');
  }
  if (monitorBounds.width * monitorBounds.height > IMAGE_LIMITS.pixels) throw new KernelError('screenshot_pixels_exceeded');
  let image = monitor.captureImageSync();
  if (image.width < 1 || image.height < 1 || image.width * image.height > IMAGE_LIMITS.pixels) throw new KernelError('screenshot_pixels_exceeded');
  if (monitor.x() !== monitorBounds.x || monitor.y() !== monitorBounds.y || monitor.width() !== monitorBounds.width
    || monitor.height() !== monitorBounds.height || monitor.rotation() !== monitorBounds.rotation
    || image.width !== monitorBounds.width || image.height !== monitorBounds.height) throw new KernelError('screenshot_display_changed');
  if (window !== undefined) {
    // Capture visible compositor pixels, including accelerated application surfaces.
    if (!window.isFocused() || window.width() !== sourceWidth || window.height() !== sourceHeight || window.x() !== sourceX || window.y() !== sourceY) {
      throw new KernelError('screenshot_window_changed');
    }
    const x = sourceX - monitorBounds.x;
    const y = sourceY - monitorBounds.y;
    if (x < 0 || y < 0 || x + sourceWidth > image.width || y + sourceHeight > image.height) throw new KernelError('screenshot_window_spans_monitors');
    image = image.cropSync(x, y, sourceWidth, sourceHeight);
  }
  if (options.region !== undefined) {
    const { x, y, width, height } = options.region;
    if (x + width > image.width || y + height > image.height) throw new KernelError('screenshot_region_invalid');
    image = image.cropSync(x, y, width, height);
  }
  const raw = image.toRawSync();
  if (raw.length !== image.width * image.height * 4) throw new KernelError('screenshot_capture_failed');
  sharp.cache(false);
  const png = await sharp(raw, { raw: { width: image.width, height: image.height, channels: 4 }, limitInputPixels: IMAGE_LIMITS.pixels })
    .resize({ width: IMAGE_LIMITS.dimension, height: IMAGE_LIMITS.dimension, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  if (png.length > IMAGE_LIMITS.outputBytes) throw new KernelError('screenshot_bytes_exceeded');
  await assertInteractiveDesktop();
  await new Promise<void>((resolve, reject) => process.send!({ sourceWidth, sourceHeight }, error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => process.stdout.write(png, error => error ? reject(error) : resolve()));
}

if (!process.connected || process.platform !== 'win32') process.exitCode = 1;
else {
  process.once('disconnect', () => process.exit(1));
  process.once('message', message => {
    void performCapture(message).catch(async (error: unknown) => {
      const code = error instanceof KernelError ? error.code : 'screenshot_capture_failed';
      await new Promise<void>(resolve => process.send?.({ error: code }, () => resolve()));
      process.exitCode = 1;
    }).finally(() => { process.removeAllListeners('disconnect'); if (process.connected) process.disconnect(); });
  });
  process.send!({ ready: process.pid });
}
