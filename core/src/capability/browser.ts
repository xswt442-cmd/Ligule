import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createConfig, type ConfigLayer, type ConfigSnapshot } from '../kernel/config.js';
import type { LoadedLayers } from '../kernel/config-store.js';
import { dataRoot } from '../data-root.js';
import { workspaceIdentity } from '../workspace-identity.js';
import { claimStorageOwner, closeStorageOwner } from './storage-gc.js';
import { KernelError } from '../errors.js';
import { workspaceDataDirectory, type SessionDirectoryConfig } from '../session/list.js';
import { mcpServerConfigs, type NormalizedMcpServerConfig } from './mcp.js';
import { BROWSER_SERVER } from './browser-policy.js';

export interface BrowserStatus { readonly configured: boolean; readonly available: boolean; readonly code?: string }
export interface BrowserSupport {
  readonly status: BrowserStatus;
  readonly server?: NormalizedMcpServerConfig;
  session(id: string): Promise<NormalizedMcpServerConfig>;
  verify(): Promise<void>;
  clearSession(id: string): Promise<void>;
  closeSession(id: string): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function ownedDirectory(root: string, path: string): Promise<void> {
  const local = relative(root, path);
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new KernelError('browser_storage_invalid');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const part of ['', ...local.split(sep).filter(Boolean)]) {
    if (part !== '') current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('browser_storage_link');
  }
}

/** Managed launch settings are a trusted configuration capability, never a project-provided command. */
export async function createBrowserSupport(config: ConfigSnapshot & SessionDirectoryConfig, layers: LoadedLayers): Promise<BrowserSupport> {
  const unavailable = (status: BrowserStatus): BrowserSupport => ({ status,
    session: async () => { throw new KernelError(status.code ?? 'browser_unavailable'); },
    verify: async () => { throw new KernelError(status.code ?? 'browser_unavailable'); },
    clearSession: async () => {}, closeSession: async () => {} });
  let settings: unknown;
  if (Object.keys(layers).length === 0) settings = config.browser;
  else {
    const trusted: Partial<Record<ConfigLayer, Record<string, unknown>>> = {};
    for (const layer of ['user', 'flag', 'managed'] as const) {
      const value = layers[layer as keyof LoadedLayers];
      if (value !== undefined && record(value) && value.browser !== undefined) trusted[layer] = { browser: value.browser };
    }
    settings = createConfig(trusted).browser;
  }
  if (settings === undefined) return unavailable({ configured: false, available: false, code: 'browser_not_configured' });
  try {
    if (!record(settings) || settings.provider !== 'playwright-mcp'
      || Object.keys(settings).some(key => !['provider', 'entryPoint', 'executablePath'].includes(key))
      || typeof settings.entryPoint !== 'string' || !isAbsolute(settings.entryPoint)
      || typeof settings.executablePath !== 'string' || !isAbsolute(settings.executablePath)) throw new KernelError('browser_settings_invalid');
    let entry: string;
    let executable: string;
    try { entry = await realpath(settings.entryPoint); executable = await realpath(settings.executablePath); }
    catch (cause) { throw new KernelError('browser_backend_unavailable', { cause }); }
    const pkg = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8')) as Record<string, unknown>;
    if (pkg.name !== '@playwright/mcp' || pkg.version !== '0.0.83' || !record(pkg.bin)
      || typeof pkg.bin['playwright-mcp'] !== 'string' || resolve(dirname(entry), pkg.bin['playwright-mcp']) !== entry) throw new KernelError('browser_backend_unsupported');
    if (!(await lstat(executable)).isFile() || !(await lstat(entry)).isFile()) throw new KernelError('browser_backend_unavailable');
    const storageRoot = workspaceDataDirectory(config);
    const base = join(storageRoot, 'browser');
    const workspace = workspaceIdentity(config.workspaceRoot ?? config.boundary);
    const leases = new Map<string, Promise<() => Promise<void>>>();
    function claimSession(id: string): Promise<() => Promise<void>> {
      const existing = leases.get(id);
      if (existing !== undefined) return existing;
      const claim = claimStorageOwner(storageRoot, workspace, 'browser', id);
      leases.set(id, claim);
      void claim.catch(() => { if (leases.get(id) === claim) leases.delete(id); });
      return claim;
    }
    const sessionDirectory = (id: string) => {
      if (!/^[a-zA-Z0-9._-]{1,256}$/u.test(id) || id === '.' || id === '..') throw new KernelError('browser_session_invalid');
      return join(base, 'sessions', id);
    };
    const checkedSessionDirectory = async (id: string) => {
      const directory = sessionDirectory(id);
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('browser_storage_link');
        const resolved = await realpath(directory);
        const expected = join(await realpath(base), 'sessions', id);
        if (resolved !== expected) throw new KernelError('browser_storage_link');
        return resolved;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const root = dataRoot(typeof config.userHome === 'string' ? config.userHome : undefined);
    await ownedDirectory(root, base);
    const text = JSON.stringify({ browser: { browserName: 'chromium', isolated: true,
      launchOptions: { executablePath: executable, headless: true, chromiumSandbox: true },
      contextOptions: { viewport: { width: 1280, height: 800 }, acceptDownloads: false } },
      capabilities: ['vision'], imageResponses: 'allow' });
    const digest = createHash('sha256').update(text).digest('hex');
    const path = join(base, `${digest}.json`);
    const verify = async () => {
      await ownedDirectory(root, base);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== Buffer.byteLength(text)) throw new KernelError('browser_configuration_changed');
      const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      try {
        const info = await file.stat();
        if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) throw new KernelError('browser_configuration_changed');
        const bytes = Buffer.alloc(Buffer.byteLength(text) + 1);
        let used = 0;
        while (used < bytes.length) {
          const result = await file.read(bytes, used, bytes.length - used, null);
          if (result.bytesRead === 0) break;
          used += result.bytesRead;
        }
        if (bytes.subarray(0, used).toString('utf8') !== text) throw new KernelError('browser_configuration_changed');
      } finally { await file.close(); }
    };
    try { await verify(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = join(base, `${randomUUID()}.part`);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); }
      finally { await file.close(); }
      try { await rename(temporary, path); }
      finally { try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
      await verify();
    }
    const [server] = mcpServerConfigs({ mcp: { servers: { [BROWSER_SERVER]: { command: process.execPath,
      args: [entry, '--config', path, '--headless', '--isolated', '--caps', 'vision', '--image-responses', 'allow', '--output-dir', base] } } } }, {},
      typeof config.workspaceRoot === 'string' ? config.workspaceRoot : String(config.boundary));
    return { status: { configured: true, available: true }, server, verify,
      clearSession: async id => {
        const lease = leases.get(id);
        if (lease === undefined) return; // Never clear unknown or pre-existing session directories.
        await lease;
        const directory = await checkedSessionDirectory(id);
        if (directory === undefined) return;
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink()) throw new KernelError('browser_storage_link');
          if (item.isFile() && item.name !== '.ligule-owner.json') await unlink(join(directory, item.name));
        }
      },
      closeSession: async id => {
        const lease = leases.get(id);
        if (lease === undefined) return; // Unknown old directories have no proven owner.
        const release = await lease;
        await closeStorageOwner(storageRoot, 'browser', id, release, async () => {
          const directory = await checkedSessionDirectory(id);
          if (directory !== undefined) await rm(directory, { recursive: true, force: true });
        });
        leases.delete(id);
      },
      session: async id => {
        await verify();
        const directory = sessionDirectory(id);
        await claimSession(id);
        await ownedDirectory(root, directory);
        const args = [...server.args];
        args[args.indexOf('--output-dir') + 1] = directory;
        // Session-local storage is an implementation detail, not a new server authority.
        return { ...server, args };
      } };
  } catch (error) {
    if (error instanceof KernelError) return unavailable({ configured: true, available: false, code: error.code });
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return unavailable({ configured: true, available: false, code: 'browser_backend_unavailable' });
    throw error;
  }
}
