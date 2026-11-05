import { app, dialog, type BrowserWindow } from 'electron';
import { resolve, join } from 'node:path';
import { HostController } from './host.js';
import { resolveHostRuntime } from './runtime.js';
import { NativeServices } from './native.js';
import { registerDesktopIpc } from './ipc.js';
import { APP_PAGE, DEV_PAGE, approvedPage } from './security.js';
import { registerAppScheme, installResourceProtocol, createApplicationWindow } from './secure-window.js';

const APP_USER_MODEL_ID = 'app.ligule.desktop';
const DEVELOPMENT_APP_USER_MODEL_ID = `${APP_USER_MODEL_ID}.dev`;
const appUserModelId = app.isPackaged ? APP_USER_MODEL_ID : DEVELOPMENT_APP_USER_MODEL_ID;

registerAppScheme();
app.enableSandbox();
app.setAppUserModelId(appUserModelId);
const development = !app.isPackaged && process.argv.includes('--dev');
const page = development ? DEV_PAGE : APP_PAGE;
let window: BrowserWindow;
let native: NativeServices;
let host: HostController;
let detachIpc: (() => void) | undefined;
let confirmedQuit = false;
let quitting: Promise<void> | undefined;
let rendererAvailable = false;
let quitDialogOpen = false;

function emit(channel: string, value?: string): void {
  if (window !== undefined && !window.isDestroyed() && approvedPage(window.webContents.mainFrame.url, page)) window.webContents.send(channel, value);
}

function requestQuit(): void {
  if (native === undefined) return;
  native.restore();
  if (rendererAvailable) {
    emit('ligule:quit-requested');
    return;
  }
  // Renderer 不可用时仍显示系统对话框，让用户确认是否中断后台任务。
  if (quitDialogOpen) return;
  quitDialogOpen = true;
  void dialog.showMessageBox({
    type: 'warning', title: 'ligule',
    message: '界面暂不可用。退出将中断后台任务。\nThe interface is unavailable. Quitting will interrupt background tasks.',
    buttons: ['取消 / Cancel', '退出 / Quit'], defaultId: 0, cancelId: 0,
  }).then(async result => {
    if (result.response === 1) await quit();
  }).catch(() => dialog.showErrorBox('ligule', 'desktop_quit_failed')).finally(() => { quitDialogOpen = false; });
}

async function quit(): Promise<void> {
  if (quitting !== undefined) return await quitting;
  quitting = (async () => {
    try {
      await host.stop();
    } finally {
      try { detachIpc?.(); } finally {
        try { native?.dispose(); } finally {
          confirmedQuit = true;
          app.quit();
        }
      }
    }
  })();
  return await quitting;
}

async function boot(): Promise<void> {
  const assets = join(app.getAppPath(), 'frontend', 'dist');
  if (!development) installResourceProtocol(assets);
  window = createApplicationWindow({
    preload: join(__dirname, 'preload.js'), iconPath: join(app.getAppPath(), 'icons', 'icon.png'),
    page, development, nonce: development ? process.env.LIGULE_DESKTOP_CSP_NONCE : undefined,
  });
  if (process.platform === 'win32') {
    window.setAppDetails({
      appId: appUserModelId,
      appIconPath: app.isPackaged ? process.execPath : join(app.getAppPath(), 'icons', 'icon.ico'),
      appIconIndex: 0,
    });
  }
  window.webContents.on('did-finish-load', () => { rendererAvailable = true; });
  window.webContents.on('render-process-gone', () => { rendererAvailable = false; });
  window.webContents.on('destroyed', () => { rendererAvailable = false; });
  native = new NativeServices({ window, onQuitRequested: requestQuit, onNotificationOpen: target => emit('ligule:notification-open', target), onFault: code => emit('ligule:host-log', code), iconPath: join(app.getAppPath(), 'icons', 'icon.png') });
  const repository = resolve(__dirname, '../../..');
  const runtime = resolveHostRuntime(app.isPackaged ? { resourcesPath: process.resourcesPath } : { repositoryRoot: repository, node: join(repository, 'desktop', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node') });
  host = new HostController({ ...runtime, entry: app.isPackaged ? join(process.resourcesPath, 'host-entry.js') : join(__dirname, 'host-entry.js'),
    onFrame: frame => emit('ligule:host-frame', frame), onFault: fault => emit('ligule:host-fault', `host_closed:${fault}`),
  });
  detachIpc = registerDesktopIpc(window, page, host, native, quit);
  await host.start();
  window.on('close', event => {
    if (confirmedQuit) return;
    event.preventDefault();
    if (native.canHide()) window.hide();
    else requestQuit();
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(page);
}

app.on('before-quit', event => {
  if (confirmedQuit) return;
  event.preventDefault();
  if (native !== undefined) requestQuit();
});
app.on('activate', () => native?.restore());
void app.whenReady().then(boot).catch(async () => {
  try {
    if (host !== undefined) await host.stop();
  } catch {
    console.error('desktop_host_cleanup_failed');
  } finally {
    try { detachIpc?.(); } catch { console.error('desktop_ipc_cleanup_failed'); }
    try { native?.dispose(); } catch { console.error('desktop_native_cleanup_failed'); }
  }
  console.error('desktop_start_failed');
  dialog.showErrorBox('ligule', 'Desktop 启动失败，请检查随包运行时。\nDesktop could not start. Check the bundled runtime.');
  confirmedQuit = true;
  app.exit(1);
});
