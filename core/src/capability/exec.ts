// `exec` 负责命令执行和进程生命周期。Host 选择解释器并传入此处。
// Windows 进程由 Job Object 管理，Linux 命令由子收养者守护进程管理；受限 Profile 使用可用的 OS Sandbox。
// 调用方通过 signal 取消执行，配置上限同时限制命令运行时间。
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, parse, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelError } from '../errors.js';
import { dataRoot } from '../kernel/config-file.js';
import { isWithin, resolveWithin } from './paths.js';
import { boundaryOf, limitsOf, workingDirectoryOf, type CapabilityConfig } from './limits.js';
import { spawnWindowsCommand, type OwnedWindowsCommand } from './windows-command.js';
import { buildLinuxSandbox, type PermissionCapabilities } from './sandbox-linux.js';
import type { WindowsCommandLaunch } from './windows-command.js';
import { permissionDenial, type PermissionContext } from '../kernel/permission.js';
import type { ShellSelection } from './shell.js';
import { assertInterpreterIdentity, assertScriptBinding, bindScript, commandUsesNodeRuntime, readBoundScript, resolveNodeRuntime, type ScriptBinding } from './script-binding.js';

type ExecArguments = { command?: unknown; cwd?: string };
export interface ManagedExecLease {
  readonly completion: Promise<number>;
  readonly logs: () => string;
  /** Resolves only after owned-process completion and temporary-resource cleanup are confirmed. */
  stop(): Promise<void>;
}
export interface ExecRunContext {
  config: CapabilityConfig;
  permission: PermissionContext;
  signal?: AbortSignal;
  shell?: ShellSelection;
  scriptBinding?: ScriptBinding;
}
type ExecResult = { text: string; exitCode: number | null };

const MAX_EXEC_TIMEOUT_MS = 600_000;
const EXEC_ENVIRONMENT = new Set([
  'appdata', 'ci', 'comspec', 'force_color', 'home', 'homedrive', 'homepath', 'lang', 'lc_all', 'ligule_home',
  'localappdata', 'no_color', 'path', 'pathext', 'systemdrive', 'systemroot', 'term', 'tmp',
  'temp', 'tmpdir', 'userprofile', 'windir',
]);
const SANDBOX_ENVIRONMENT = new Set(['CI', 'FORCE_COLOR', 'LANG', 'NO_COLOR', 'TERM']);

function executionEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && EXEC_ENVIRONMENT.has(name.toLowerCase())) environment[name] = value;
  }
  return environment;
}

function sandboxEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && SANDBOX_ENVIRONMENT.has(name.toUpperCase())) allowed[name.toUpperCase()] = value;
  }
  return allowed;
}

function executionTimeout(config: CapabilityConfig): number {
  const configured = config.limits?.execTimeoutMs;
  const timeout = configured === undefined ? limitsOf(config).execTimeoutMs : configured;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_EXEC_TIMEOUT_MS) {
    throw new KernelError('exec_timeout_invalid', {
      detail: `limits.execTimeoutMs must be a positive safe integer no greater than ${MAX_EXEC_TIMEOUT_MS}`,
    });
  }
  return timeout;
}

function permissionMode(permission: PermissionContext | undefined): 'direct' | 'sandboxed' {
  if (permission === undefined) throw new KernelError('exec_permission_required');
  if (!['read-only', 'workspace-write', 'full-access'].includes(permission.profile)) {
    throw new KernelError('permission_profile_invalid');
  }
  if (!['policy', 'unrestricted', 'disabled'].includes(permission.network)) {
    throw new KernelError('permission_network_mode_invalid');
  }
  const denial = permissionDenial(permission, 'exec');
  if (denial !== undefined) throw new KernelError(denial.code, { detail: denial.reason });
  if (permission.profile === 'full-access') {
    if (permission.network !== 'unrestricted') {
      throw new KernelError('permission_network_isolation_unavailable', {
        detail: 'full-access shell execution requires unrestricted network access on this backend',
      });
    }
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      throw new KernelError('permission_process_isolation_unavailable', {
        detail: `the ${process.platform} exec backend cannot guarantee ownership of detached descendants`,
      });
    }
    return 'direct';
  }
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    throw new KernelError('permission_sandbox_unavailable', {
      detail: `the ${process.platform} exec backend cannot enforce the ${permission.profile} profile`,
    });
  }
  return 'sandboxed';
}

function requireFullCapability(
  capabilities: PermissionCapabilities,
  name: keyof PermissionCapabilities,
  code: string,
): void {
  if (capabilities[name] !== 'full') {
    throw new KernelError(code, { detail: `the ${process.platform} exec backend reported ${name}=${capabilities[name]}` });
  }
}

function requireAvailableCapability(
  capabilities: PermissionCapabilities,
  name: keyof PermissionCapabilities,
  code: string,
): void {
  if (capabilities[name] === 'unavailable') {
    throw new KernelError(code, { detail: `the ${process.platform} exec backend reported ${name}=unavailable` });
  }
}

// Windows 命令输出可能使用控制台 OEM 编码，不能始终按 UTF-8 解码。
// 先尝试严格 UTF-8；失败时读取当前代码页并按该编码解码，代码页信息在进程内缓存。
let oemPage: string | undefined;
function codePage(): string {
  if (oemPage === undefined) {
    try {
      oemPage = /(\d+)/.exec(execFileSync('chcp.com', [], { encoding: 'utf8' }))?.[1] ?? '';
    } catch {
      oemPage = '';
    }
  }
  return oemPage;
}

// Windows 代码页名称与 WHATWG 编码标签不完全一致；为常见中文代码页提供映射，其余尝试 `windows-<编号>`。
const DOUBLE_BYTE: Readonly<Record<string, string>> = { 932: 'shift_jis', 936: 'gbk', 950: 'big5' };

export function decode(bytes: Buffer): string {
  if (process.platform !== 'win32') return bytes.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder(DOUBLE_BYTE[codePage()] ?? `windows-${codePage()}`).decode(bytes);
    } catch {
      // 编码不受支持时使用宽松 UTF-8 解码，保留输出字节而不抛错。
      return bytes.toString('utf8');
    }
  }
}

// 输出超限时保留开头和末尾片段，并在中间添加截断说明；末尾通常包含最终结果和错误原因。
// 流式收集只保留预算范围内的内容，避免大输出耗尽内存。
function pageOutput(total: number, head: Buffer, tail: Buffer[], limit: number): string {
  if (total <= limit) return decode(Buffer.concat(tail, total));
  const reached = Buffer.concat(tail);
  const kept = reached.subarray(Math.max(0, reached.length - (limit - head.length)));
  return `${decode(head)}\n[truncated: ${total} bytes total, ${total - head.length - kept.length} bytes in the middle omitted]\n${decode(kept)}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export function settleManagedCompletion(
  completion: Promise<number | null>,
  releaseResources: () => Promise<void>,
): Promise<number> {
  const failAfterCleanup = async (error: unknown): Promise<never> => {
    try { await releaseResources(); }
    catch (cleanupError) {
      if (cleanupError instanceof KernelError
        && (cleanupError.code === 'exec_temp_cleanup_failed' || cleanupError.code === 'exec_script_snapshot_cleanup_failed')) {
        const completionCode = errorCode(error);
        const cause = new AggregateError([error, cleanupError], 'process completion and temporary-resource cleanup both failed');
        if (completionCode === 'exec_sandbox_cleanup_failed') {
          throw new KernelError(completionCode, {
            cause,
            detail: error instanceof KernelError ? error.detail : 'Guardian cleanup and host temporary-resource cleanup both failed',
          });
        }
        if (completionCode === 'exec_termination_cleanup_failed') {
          throw new KernelError(completionCode, {
            cause,
            detail: error instanceof KernelError ? error.detail : 'process termination and temporary-resource cleanup are both unconfirmed',
          });
        }
        if (completionCode === 'exec_guardian_failed' || completionCode === 'exec_guardian_protocol' || completionCode === 'exec_terminate_failed') {
          throw new KernelError('exec_termination_cleanup_failed', {
            cause,
            detail: 'the command may still be running and temporary-resource cleanup also failed',
          });
        }
        throw new KernelError(cleanupError.code, {
          cause,
          detail: cleanupError.detail,
        });
      }
      throw cleanupError;
    }
    throw error;
  };
  return completion.then(async (exitCode) => {
    if (exitCode === null) return failAfterCleanup(new KernelError('exec_process_interrupted'));
    await releaseResources();
    return exitCode;
  }, failAfterCleanup);
}

function quoteScriptPath(path: string, kind: ShellSelection['kind']): string {
  return kind === 'powershell' ? `'${path.replaceAll("'", "''")}'` : `'${path.replaceAll("'", "'\\''")}'`;
}

function quoteExecutablePath(path: string, kind: ShellSelection['kind']): string {
  const quoted = quoteScriptPath(path, kind);
  return kind === 'powershell' ? `& ${quoted}` : quoted;
}

async function createScriptSnapshot(boundary: string, approvedPath: string, source: Buffer, allowOutsideBoundary: boolean): Promise<string> {
  const snapshot = join(dirname(approvedPath), `.ligule-approved-${randomUUID()}${extname(approvedPath)}`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);
  let handle: FileHandle | undefined;
  let identity: { dev: bigint; ino: bigint } | undefined;
  let safeToRemove = false;
  try {
    const realBoundary = await realpath(boundary);
    const parent = await realpath(dirname(approvedPath));
    if (!allowOutsideBoundary && !isWithin(realBoundary, parent)) {
      throw new KernelError('exec_script_snapshot_failed', { detail: 'the script snapshot directory is outside the workspace boundary' });
    }
    handle = await open(snapshot, flags, 0o400);
    const opened = await handle.stat({ bigint: true });
    identity = { dev: opened.dev, ino: opened.ino };
    const actualPath = await realpath(snapshot);
    const pathInfo = await stat(snapshot, { bigint: true });
    if (actualPath !== snapshot || (!allowOutsideBoundary && !isWithin(realBoundary, actualPath))
      || opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino) {
      throw new KernelError('exec_script_snapshot_failed', { detail: 'the script snapshot path changed while it was opened' });
    }
    safeToRemove = true;
    await handle.writeFile(source);
    await handle.chmod(0o400);
    if ((await handle.stat({ bigint: true })).size !== BigInt(source.length)) {
      throw new KernelError('exec_script_snapshot_failed', { detail: 'the script snapshot size does not match the approved content' });
    }
    if (!source.equals(await readBoundScript(boundary, snapshot, allowOutsideBoundary))) {
      throw new KernelError('exec_script_snapshot_failed', { detail: 'the script snapshot content does not match the approved content' });
    }
    await handle.close();
    handle = undefined;
    return snapshot;
  } catch (error) {
    if (safeToRemove && identity !== undefined) {
      const current = await stat(snapshot, { bigint: true }).catch(() => undefined);
      const path = await realpath(snapshot).catch(() => undefined);
      if (current?.dev === identity.dev && current.ino === identity.ino && path === snapshot) {
        await rm(snapshot, { force: true }).catch((cleanupError) => {
          throw new KernelError('exec_script_snapshot_cleanup_failed', { cause: cleanupError, detail: 'the failed script snapshot could not be removed' });
        });
      }
    }
    if (error instanceof KernelError) throw error;
    throw new KernelError('exec_script_snapshot_failed', { cause: error, detail: 'the private script snapshot could not be created beside the approved script' });
  } finally {
    await handle?.close();
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
}

async function confirmProcessGroupStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return;
      throw new KernelError('exec_terminate_failed', { cause: error, detail: 'the command process group could not be checked after termination' });
    }
    if (Date.now() >= deadline) {
      throw new KernelError('exec_terminate_failed', { detail: 'the command process group remained alive after termination' });
    }
    await delay(20);
  }
}

async function createPrivateTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-exec-'));
  try {
    await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new KernelError('exec_sandbox_setup_failed', { cause: error, detail: 'the private temporary directory could not be secured' });
  }
}

export const execTool = {
  name: 'exec',
  access: 'exec' as const,
  description: 'Run a command line with the shell backend the host chose. The default working directory is the workspace root; an explicit cwd is relative to that root and must resolve inside the workspace boundary.',
  // 该命令必须使用 Kernel 选定的解释器；解析、权限判定、执行记录均依据同一后端。
  commandArgument: 'command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Optional working directory relative to the workspace root, within the workspace boundary.' },
    },
    required: ['command'],
  },
  run(args: ExecArguments, context: ExecRunContext): Promise<ExecResult> {
    return runExec(args, context);
  },
};

function runExec(args: ExecArguments, context: ExecRunContext): Promise<ExecResult>;
function runExec<TResult>(
  args: ExecArguments,
  context: ExecRunContext,
  onManagedProcess: (lease: ManagedExecLease) => Promise<TResult>,
): Promise<TResult>;
async function runExec<TResult>(
  args: ExecArguments,
  { config, permission, signal, shell, scriptBinding }: ExecRunContext,
  onManagedProcess?: (lease: ManagedExecLease) => Promise<TResult>,
): Promise<ExecResult | TResult> {
    if (typeof args.command !== 'string' || args.command.trim() === '') {
      throw new KernelError('exec_command_required', { detail: 'the command to run is missing' });
    }
    const commandText = args.command;
    if (shell === undefined) throw new KernelError('exec_shell_unavailable', { detail: 'the host did not select a shell backend for exec' });
    const mode = permissionMode(permission);
    const timeoutMs = executionTimeout(config);
    const { execBytes } = limitsOf(config);
    const boundary = boundaryOf(config);
    const workspaceRoot = workingDirectoryOf(config);
    const cwd = args.cwd === undefined
      ? await resolveWithin(boundary, '.', { cwd: workspaceRoot })
      : await resolveWithin(boundary, args.cwd, { cwd: workspaceRoot });
    let currentBinding: ScriptBinding | undefined;
    try { currentBinding = await bindScript({ command: commandText, shell, boundary, workspaceRoot, cwd, permission }); }
    catch (error) {
      if (scriptBinding !== undefined) {
        throw new KernelError('exec_script_binding_changed', { cause: error, detail: 'the approved script could not be rebound to its path, workspace, interpreter, and permission' });
      }
      throw error;
    }
    if (scriptBinding !== undefined || currentBinding !== undefined) assertScriptBinding(scriptBinding, currentBinding);
    let scriptSnapshot: string | undefined;
    let windowsLaunch: WindowsCommandLaunch | undefined;
    let command = commandText;
    if (scriptBinding !== undefined) {
      if (scriptBinding.sourceKind === 'file' && permission.profile === 'read-only') {
        throw new KernelError('exec_script_binding_unavailable', { detail: 'read-only execution cannot create a source-directory snapshot without writing to the workspace' });
      }
      const source = scriptBinding.sourceKind === 'inline'
        ? Buffer.from(scriptBinding.inlineSource ?? '', 'utf8')
        : await readBoundScript(boundary, scriptBinding.path, permission.profile === 'full-access').catch((error) => {
          throw new KernelError('exec_script_binding_changed', { cause: error, detail: 'the approved script could not be reread for an execution snapshot' });
        });
      if (createHash('sha256').update(source).digest('hex') !== scriptBinding.sha256) {
        throw new KernelError('exec_script_binding_changed', { detail: 'the approved script content changed before its execution snapshot was created' });
      }
      const sourceTokens = [scriptBinding.interpreterSource, ...(scriptBinding.sourceKind === 'file' ? [scriptBinding.argumentSource] : [])];
      if (sourceTokens.some((token) => token === '' || commandText.indexOf(token) !== commandText.lastIndexOf(token))) {
        throw new KernelError('exec_script_binding_unavailable', { detail: 'the parsed interpreter and script path do not have unambiguous source tokens to replace' });
      }
      if (scriptBinding.sourceKind === 'file') {
        scriptSnapshot = await createScriptSnapshot(boundary, scriptBinding.path, source, permission.profile === 'full-access');
        const scriptPath = mode === 'sandboxed' ? relative(cwd, scriptSnapshot) : scriptSnapshot;
        command = command.replace(scriptBinding.argumentSource, quoteScriptPath(scriptPath, shell.kind));
      }
      command = command.replace(scriptBinding.interpreterSource, quoteExecutablePath(scriptBinding.interpreter, shell.kind));
    }
    const commandArgs = [...shell.prefix, `${command}${shell.tail}`];
    let linuxNodeRuntime: { executable: string; identity: ScriptBinding['interpreterIdentity']; rewriteExecutable: boolean } | undefined;
    if (mode === 'sandboxed' && process.platform === 'linux') {
      if (scriptBinding !== undefined && basename(scriptBinding.interpreter) === 'node') {
        linuxNodeRuntime = { executable: scriptBinding.interpreter, identity: scriptBinding.interpreterIdentity, rewriteExecutable: true };
      } else if (await commandUsesNodeRuntime(commandText, shell)) {
        const runtime = await resolveNodeRuntime();
        linuxNodeRuntime = { executable: runtime.path, identity: runtime.identity, rewriteExecutable: false };
      }
    }
    const environment = executionEnvironment();
    let executable = shell.executable;
    let argv = commandArgs;
    let privateTempDir: string | undefined;
    if (mode === 'sandboxed') {
      if (permission === undefined || permission.profile === 'full-access') throw new KernelError('exec_permission_required');
      if (signal?.aborted) {
        if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
        throw new KernelError('exec_cancelled', { detail: 'the run was cancelled before the command started' });
      }
      const needsHostTempDir = process.platform === 'linux'
        || (process.platform === 'win32' && permission.profile === 'workspace-write');
      if (needsHostTempDir) {
        try { privateTempDir = await createPrivateTempDir(); }
        catch (error) {
          if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
          throw error;
        }
      }
      try {
        if (process.platform === 'linux') {
          if (privateTempDir === undefined) throw new KernelError('exec_sandbox_setup_failed', { detail: 'the Linux sandbox requires a private temporary directory' });
          const result = await buildLinuxSandbox({
            profile: permission.profile,
            network: permission.network === 'unrestricted' ? 'unrestricted' : 'disabled',
            workspaceRoot: boundary,
            cwd,
            privateTempDir,
            executable: shell.executable,
            argv: commandArgs,
            environment: sandboxEnvironment(environment),
            ...(linuxNodeRuntime === undefined ? {} : { nodeRuntime: linuxNodeRuntime }),
          });
          if (!result.available) {
            throw new KernelError('permission_sandbox_unavailable', { detail: result.reason });
          }
          requireAvailableCapability(result.capabilities, 'filesystemRead', 'permission_sandbox_unavailable');
          if (permission.profile === 'read-only') {
            requireFullCapability(result.capabilities, 'filesystemWrite', 'permission_sandbox_unavailable');
          } else {
            requireAvailableCapability(result.capabilities, 'filesystemWrite', 'permission_sandbox_unavailable');
          }
          requireFullCapability(result.capabilities, 'process', 'permission_process_isolation_unavailable');
          requireFullCapability(result.capabilities, 'network', 'permission_network_isolation_unavailable');
          executable = result.executable;
          argv = result.argv;
        } else if (process.platform === 'win32') {
          requireAvailableCapability(permission.capabilities, 'filesystemRead', 'permission_sandbox_unavailable');
          requireAvailableCapability(permission.capabilities, 'filesystemWrite', 'permission_sandbox_unavailable');
          requireFullCapability(permission.capabilities, 'process', 'permission_process_isolation_unavailable');
          if (permission.profile === 'read-only') {
            if (permission.network === 'unrestricted') {
              throw new KernelError('permission_network_isolation_unavailable', {
                detail: 'the Windows read-only AppContainer disables network access and cannot provide unrestricted networking',
              });
            }
            windowsLaunch = { kind: 'appcontainer', workspaceRoot: boundary };
          } else {
            if (permission.network !== 'unrestricted') {
              throw new KernelError('permission_network_isolation_unavailable', {
                detail: 'the Windows write-restricted token cannot enforce disabled or destination-limited network access; choose unrestricted network explicitly or do not run Shell',
              });
            }
            if (privateTempDir === undefined) throw new KernelError('exec_sandbox_setup_failed', { detail: 'Windows workspace-write requires a private temporary directory' });
            windowsLaunch = { kind: 'restricted-token', workspaceRoot: boundary, tempDirectory: privateTempDir, aclLockRoot: dataRoot() };
            const privateProfile = join(privateTempDir, 'profile');
            const privateLocalAppData = join(privateProfile, 'AppData', 'Local');
            const privateRoamingAppData = join(privateProfile, 'AppData', 'Roaming');
            const privateCorepackHome = join(privateTempDir, 'corepack');
            const privateProfileRoot = parse(privateProfile).root;
            if (privateProfileRoot === '') throw new KernelError('exec_temp_path_invalid');
            await mkdir(privateLocalAppData, { recursive: true });
            await mkdir(privateRoamingAppData, { recursive: true });
            await mkdir(privateCorepackHome, { recursive: true });
            // Corepack and pnpm resolve Windows locks and caches through the user profile; keep those writes in this run's private temp tree.
            environment.HOME = privateProfile;
            environment.USERPROFILE = privateProfile;
            environment.HOMEDRIVE = privateProfileRoot.replace(/[\\/]+$/u, '');
            environment.HOMEPATH = privateProfile.slice(privateProfileRoot.length - 1);
            environment.APPDATA = privateRoamingAppData;
            environment.LOCALAPPDATA = privateLocalAppData;
            environment.COREPACK_HOME = privateCorepackHome;
            environment.TEMP = privateTempDir;
            environment.TMP = privateTempDir;
          }
        } else {
          throw new KernelError('permission_sandbox_unavailable', { detail: `the ${process.platform} exec backend is unavailable` });
        }
      } catch (error) {
        if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
        privateTempDir = undefined;
        if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
        if (error instanceof KernelError) throw error;
        throw new KernelError('exec_sandbox_setup_failed', { cause: error });
      }
    }

    if (mode === 'direct') argv = commandArgs;
    if (scriptBinding !== undefined) {
      try { await assertInterpreterIdentity(scriptBinding.interpreter, scriptBinding.interpreterIdentity); }
      catch (error) {
        if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
        if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
        throw error;
      }
    }
    if (linuxNodeRuntime !== undefined) {
      try { await assertInterpreterIdentity(linuxNodeRuntime.executable, linuxNodeRuntime.identity); }
      catch (error) {
        if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
        if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
        throw error;
      }
    }
    if (signal?.aborted) {
      if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
      if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
      throw new KernelError('exec_cancelled', { detail: 'the run was cancelled before the command started' });
    }

    let owned: OwnedWindowsCommand | null;
    let child: ChildProcess;
    try {
      owned = process.platform === 'win32' || process.platform === 'linux'
        ? spawnWindowsCommand(executable, argv, cwd, environment, windowsLaunch)
        : null;
      child = owned?.child ?? spawn(executable, argv, {
        cwd,
        env: environment,
        detached: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
      if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
      if (error instanceof KernelError) throw error;
      throw new KernelError('exec_spawn_failed', { cause: error, detail: error instanceof Error ? error.message : undefined });
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      if (owned === null) killTree(child);
      else owned.cancel();
      if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
      if (scriptSnapshot !== undefined) await rm(scriptSnapshot, { force: true });
      throw new KernelError('exec_spawn_failed', { detail: 'the command process did not provide output pipes' });
    }
    const half = Math.floor(execBytes / 2);
    let head = Buffer.alloc(0);
    const tail: Buffer[] = [];
    let tailSize = 0;
    let total = 0;
    const collect = (chunk: Buffer): void => {
      total += chunk.length;
      if (head.length < half) head = Buffer.concat([head, chunk.subarray(0, half - head.length)]);
      tail.push(chunk);
      tailSize += chunk.length;
      // 只保留最近的输出预算；按流片段增量丢弃旧字节，避免长输出造成重复复制。
      while (tailSize > execBytes && tail.length > 1) {
        tailSize -= tail[0].length;
        tail.shift();
      }
      if (tail.length === 1 && tailSize > execBytes) {
        tail[0] = tail[0].subarray(tailSize - execBytes);
        tailSize = execBytes;
      }
    };
    stdout.on('data', collect);
    stderr.on('data', collect);

    const completion: Promise<number | null> = owned?.completion ?? new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (onManagedProcess !== undefined) {
      let cleanup: Promise<void> | undefined;
      const releaseResources = (): Promise<void> => {
        if (cleanup !== undefined) return cleanup;
        const attempt = Promise.resolve().then(async () => {
          if (privateTempDir !== undefined) {
            try { await rm(privateTempDir, { recursive: true, force: true }); }
            catch (cause) {
              throw new KernelError('exec_temp_cleanup_failed', { cause, detail: 'the private temporary directory could not be removed' });
            }
            privateTempDir = undefined;
          }
          if (scriptSnapshot !== undefined) {
            try { await rm(scriptSnapshot, { force: true }); }
            catch (cause) {
              throw new KernelError('exec_script_snapshot_cleanup_failed', { cause, detail: 'the private script snapshot could not be removed' });
            }
            scriptSnapshot = undefined;
          }
        });
        cleanup = attempt;
        void attempt.catch(() => {
          if (cleanup === attempt) cleanup = undefined;
        });
        return attempt;
      };
      const managedCompletion = settleManagedCompletion(completion, releaseResources);
      const cleanupFailure = (error: unknown): boolean => error instanceof KernelError
        && (error.code === 'exec_temp_cleanup_failed' || error.code === 'exec_script_snapshot_cleanup_failed');
      const lease: ManagedExecLease = {
        completion: managedCompletion,
        logs: () => {
          const bytes = Buffer.concat(tail).subarray(-16_384);
          return decode(bytes);
        },
        async stop() {
          if (child.exitCode === null && child.signalCode === null) {
            if (owned === null) killTree(child);
            else owned.cancel();
          }
          try { await managedCompletion; }
          catch (error) {
            if (error instanceof KernelError && error.code === 'exec_sandbox_cleanup_failed') {
              try { await releaseResources(); }
              catch (cleanupError) {
                throw new KernelError('exec_sandbox_cleanup_failed', {
                  cause: new AggregateError([error, cleanupError], 'Guardian cleanup and temporary-resource cleanup both failed'),
                  detail: error.detail,
                });
              }
              throw error;
            }
            if (!(error instanceof KernelError) || (error.code !== 'exec_cancelled' && !cleanupFailure(error))) throw error;
          }
          await releaseResources();
        },
      };
      if (signal?.aborted) {
        await lease.stop();
        throw new KernelError('exec_cancelled', { detail: 'the run was cancelled while the managed command was starting' });
      }
      try {
        return await onManagedProcess(lease);
      } catch (error) {
        await lease.stop().catch(() => undefined);
        throw error;
      }
    }

    let termination: 'cancelled' | 'timeout' | undefined;
    let terminationFailure: unknown;
    const terminate = (reason: 'cancelled' | 'timeout'): void => {
      if (termination !== undefined) return;
      termination = reason;
      try {
        if (owned === null) killTree(child);
        else owned.cancel();
      } catch (error) {
        terminationFailure = error;
        if (owned === null) {
          try { child.kill('SIGKILL'); } catch (fallbackError) { terminationFailure = fallbackError; }
        }
      }
    };
    const abort = (): void => terminate('cancelled');
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let exitCode: number | null;
    let completionFailure: unknown;
    let completionFailed = false;
    let processGroupRemains = false;
    try {
      exitCode = await completion;
    } catch (error) {
      exitCode = null;
      completionFailure = error;
      completionFailed = true;
      if (termination !== undefined && errorCode(error) === 'exec_terminate_failed') {
        terminationFailure = error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (termination !== undefined && owned === null && child.pid !== undefined) {
        try {
          await confirmProcessGroupStopped(child.pid);
        } catch (error) {
          terminationFailure ??= error;
          processGroupRemains = true;
        }
      }
      if (privateTempDir !== undefined && !processGroupRemains) {
        try {
          await rm(privateTempDir, { recursive: true, force: true });
        } catch (error) {
          throw new KernelError('exec_temp_cleanup_failed', { cause: error, detail: 'the private temporary directory could not be removed' });
        }
      }
      if (scriptSnapshot !== undefined) {
        try {
          await rm(scriptSnapshot, { force: true });
        } catch (error) {
          throw new KernelError('exec_script_snapshot_cleanup_failed', { cause: error, detail: 'the private script snapshot could not be removed' });
        }
      }
    }
    if (termination !== undefined) {
      if (terminationFailure !== undefined) {
        throw new KernelError('exec_terminate_failed', { cause: terminationFailure, detail: 'the command process tree could not be terminated' });
      }
      if (termination === 'timeout') {
        throw new KernelError('exec_timeout', { detail: `the command exceeded its ${timeoutMs}ms execution limit` });
      }
      throw new KernelError('exec_cancelled', { detail: 'the command was terminated because the run was cancelled' });
    }
    if (completionFailed) {
      if (completionFailure instanceof KernelError) throw completionFailure;
      throw new KernelError('exec_spawn_failed', {
        cause: completionFailure,
        detail: completionFailure instanceof Error ? completionFailure.message : undefined,
      });
    }
  return { text: pageOutput(total, head, tail, execBytes), exitCode };
}

export function runManagedExec<TResult>(
  args: ExecArguments,
  context: ExecRunContext,
  onManagedProcess: (lease: ManagedExecLease) => Promise<TResult>,
): Promise<TResult> {
  return runExec(args, context, onManagedProcess);
}
