import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPermissionContext,
  type PermissionCapabilities,
  type PermissionContext,
  type PermissionContextOptions,
  type PermissionProfileCapabilities,
} from '../kernel/permission.js';
import { dataRoot } from '../data-root.js';
import {
  probeLinuxSandboxIsolation,
  type LinuxSandboxProbeResult,
} from './sandbox-linux.js';
import { resolveShell, type ShellSelection } from './shell.js';
import { spawnWindowsCommand } from './windows-command.js';

export interface PermissionCapabilitySnapshot {
  readonly backend: 'bubblewrap' | 'windows-appcontainer-restricted-token' | 'windows-restricted-token' | 'windows-appcontainer' | 'unavailable';
  readonly capabilities: PermissionCapabilities;
  readonly profiles: PermissionProfileCapabilities;
  readonly limitations: readonly string[];
  readonly partialWorkspaceWriteConfirmationRequired: boolean;
  readonly reason?: string;
}

export interface WindowsSandboxProbeResult {
  readonly readOnlyAvailable: boolean;
  readonly workspaceWriteAvailable: boolean;
  readonly readOnlyReason?: string;
  readonly workspaceWriteReason?: string;
}

export interface PermissionCapabilityProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly probeLinux?: () => Promise<LinuxSandboxProbeResult>;
  readonly probeLinuxProcessOwnership?: () => Promise<boolean>;
  readonly probeWindowsProcessOwnership?: () => Promise<boolean>;
  readonly probeWindowsSandbox?: () => Promise<WindowsSandboxProbeResult>;
  readonly shell?: ShellSelection;
  readonly shellConfig?: Parameters<typeof resolveShell>[0];
  readonly workspaceRoot?: string;
}

const UNAVAILABLE_CAPABILITIES: PermissionCapabilities = Object.freeze({
  filesystemRead: 'unavailable',
  filesystemWrite: 'unavailable',
  network: 'unavailable',
  process: 'unavailable',
});

function unavailableSnapshot(reason: string): PermissionCapabilitySnapshot {
  return Object.freeze({
    backend: 'unavailable',
    capabilities: UNAVAILABLE_CAPABILITIES,
    profiles: Object.freeze({ readOnly: 'unavailable', workspaceWrite: 'unavailable' }),
    limitations: Object.freeze([reason]),
    partialWorkspaceWriteConfirmationRequired: false,
    reason,
  });
}

export async function detectPermissionCapabilities(
  options: PermissionCapabilityProbeOptions = {},
): Promise<PermissionCapabilitySnapshot> {
  const platform = options.platform ?? process.platform;
  let processOwnership = false;
  try {
    if (platform === 'linux') {
      processOwnership = await (options.probeLinuxProcessOwnership ?? probeLinuxProcessOwnership)();
    } else if (platform === 'win32') {
      processOwnership = await (options.probeWindowsProcessOwnership ?? probeWindowsProcessOwnership)();
    }
  } catch {
    processOwnership = false;
  }

  if (platform !== 'linux') {
    if (platform === 'win32') {
      if (!processOwnership) {
        const reason = 'the Windows command Guardian could not prove process ownership';
        return Object.freeze({
          ...unavailableSnapshot(reason),
          limitations: Object.freeze([reason]),
        });
      }
      let sandbox: WindowsSandboxProbeResult;
      try {
        sandbox = await (options.probeWindowsSandbox ?? (() => probeWindowsSandbox(options.shell, options.shellConfig, options.workspaceRoot)))();
      } catch (error) {
        const reason = `Windows sandbox probe failed (${stableCode(error)})`;
        sandbox = { readOnlyAvailable: false, workspaceWriteAvailable: false, readOnlyReason: reason, workspaceWriteReason: reason };
      }
      if (!sandbox.readOnlyAvailable && !sandbox.workspaceWriteAvailable) {
        const reason = sandbox.workspaceWriteReason ?? sandbox.readOnlyReason ?? 'Windows restricted sandbox is unavailable';
        return Object.freeze({
          ...unavailableSnapshot(reason),
          capabilities: Object.freeze({ ...UNAVAILABLE_CAPABILITIES, process: 'full' }),
          profiles: Object.freeze({ readOnly: 'unavailable', workspaceWrite: 'unavailable' }),
          limitations: Object.freeze([
            ...(sandbox.readOnlyReason === undefined ? [] : [`read-only: ${sandbox.readOnlyReason}`]),
            ...(sandbox.workspaceWriteReason === undefined ? [] : [`workspace-write: ${sandbox.workspaceWriteReason}`]),
          ]),
        });
      }
      const backend = sandbox.readOnlyAvailable && sandbox.workspaceWriteAvailable
        ? 'windows-appcontainer-restricted-token'
        : sandbox.readOnlyAvailable ? 'windows-appcontainer' : 'windows-restricted-token';
      return Object.freeze({
        backend,
        capabilities: Object.freeze({ filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full' }),
        profiles: Object.freeze({
          readOnly: sandbox.readOnlyAvailable ? 'partial' : 'unavailable',
          workspaceWrite: sandbox.workspaceWriteAvailable ? 'partial' : 'unavailable',
        }),
        partialWorkspaceWriteConfirmationRequired: sandbox.workspaceWriteAvailable,
        limitations: Object.freeze([
          ...(sandbox.readOnlyReason === undefined ? [] : [`read-only: ${sandbox.readOnlyReason}`]),
          ...(sandbox.workspaceWriteReason === undefined ? [] : [`workspace-write: ${sandbox.workspaceWriteReason}`]),
          ...(sandbox.readOnlyAvailable ? ['Windows read-only uses AppContainer with temporary workspace read/execute access so Shell can use the workspace as its current directory; writes and Shell networking are blocked, while readable public operating-system files remain visible. / Windows 只读模式使用 AppContainer，临时授予工作区读取、遍历和执行权限以便 Shell 在工作区运行；阻止工作区写入和 Shell 联网，系统中公开可读的文件仍可能被读取。'] : []),
          ...(sandbox.workspaceWriteAvailable ? [
            'Windows workspace-write uses a per-run WRITE_RESTRICTED token and temporary workspace ACL grants. Reads remain unrestricted, network is allowed only when the session explicitly selects unrestricted, and the result is partial. / Windows 工作区写入使用每次运行独立的 WRITE_RESTRICTED Token 和临时 ACL；文件读取不受限制，只有会话明确选择不受限网络时才允许运行，整体隔离为部分隔离。',
            'Existing hard links, a writable ancestor FILE_DELETE_CHILD ACE, or a concurrent same-user ACL change can escape the workspace boundary. The backend does not claim protection from hostile native code. / 既有硬链接、可写祖先目录的 FILE_DELETE_CHILD ACE 或并发 ACL 修改可能越过工作区边界；此后端不承诺隔离恶意原生代码。',
            'The runner does not lower Integrity Level. A forced Guardian termination can leave a unique SID-only ACE; ordinary same-user and Low-integrity access must remain at baseline. / Runner 不降低完整性级别。强制终止 Guardian 后可能残留独立 SID ACE；同一用户普通进程和 Low 完整性进程的访问权限应保持原状。',
            'Windows may mark affected workspace DACLs as auto-inherited while propagating temporary ACEs. Normal cleanup revokes the ACE, but the inheritance metadata may remain; this does not retain the run’s ACE permission, though exact DACL metadata restoration is not guaranteed. / Windows 传播临时 ACE 时可能把受影响的工作区 DACL 标记为自动继承。正常清理会撤销 ACE，但继承元数据标记可能保留；该标记不会保留本次 ACE 权限，因此不保证 DACL 元数据完全恢复。',
            'Windows workspace-write gives each Shell command a private temporary user profile and cache roots. User-home settings are not carried into the command, and tool caches are removed when it ends. / Windows 工作区写入会为每条 Shell 命令提供私有临时用户配置目录和缓存目录；用户目录里的设置不会带入命令，工具缓存会在命令结束后清理。',
          ] : []),
        ]),
      });
    }
    const reason = `no OS sandbox backend is available for ${platform}`;
    return Object.freeze({
      ...unavailableSnapshot(reason),
      capabilities: Object.freeze({ ...UNAVAILABLE_CAPABILITIES, process: processOwnership ? 'full' : 'unavailable' }),
      limitations: Object.freeze([
        reason,
        ...(processOwnership ? ['Job Object APIs loaded; process assignment is verified when the Guardian starts.'] : []),
        ...(processOwnership ? [] : ['the command process ownership backend is unavailable']),
      ]),
      partialWorkspaceWriteConfirmationRequired: false,
    });
  }

  let result: LinuxSandboxProbeResult;
  try {
    result = await (options.probeLinux ?? probeLinuxSandboxIsolation)();
  } catch (error) {
    result = { available: false, reason: `Linux sandbox capability probe failed: ${(error as Error).message}` };
  }
  if (!result.available) {
    const snapshot = unavailableSnapshot(result.reason);
    return Object.freeze({
      ...snapshot,
      capabilities: Object.freeze({ ...UNAVAILABLE_CAPABILITIES, process: processOwnership ? 'full' : 'unavailable' }),
      limitations: Object.freeze([
        result.reason,
        ...(processOwnership ? [] : ['Linux child subreaper support is unavailable']),
      ]),
    });
  }

  return Object.freeze({
    backend: 'bubblewrap',
    capabilities: Object.freeze({
      filesystemRead: 'partial',
      filesystemWrite: 'partial',
      network: 'full',
      process: processOwnership ? 'full' : 'unavailable',
    }),
    profiles: Object.freeze({
      readOnly: processOwnership ? 'full' : 'unavailable',
      workspaceWrite: processOwnership ? 'partial' : 'unavailable',
    }),
    partialWorkspaceWriteConfirmationRequired: false,
    limitations: Object.freeze([
      'Filesystem reads remain partial because readable host operating-system files are still visible outside the workspace.',
      'Filesystem writes remain partial because hard-link checks and workspace mount validation cannot prevent a concurrent same-user host process from racing them.',
      'Network isolation is full only for disabling Shell network access; destination-based network allowlists are not enforced inside the sandbox.',
      'Process isolation uses a PID namespace and parent-death cleanup, but does not impose CPU, memory, or process-count limits.',
      ...(processOwnership ? [] : ['Linux child subreaper support is unavailable for direct command execution.']),
    ]),
  });
}

function stableCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : 'windows_sandbox_probe_failed';
}

function probeEnvironment(tempDirectory: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LIGULE_HOME', 'LOCALAPPDATA',
    'PATH', 'PATHEXT', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) environment[name] = value;
  }
  environment.TEMP = tempDirectory;
  environment.TMP = tempDirectory;
  return environment;
}

async function runProbeCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  launch?: Parameters<typeof spawnWindowsCommand>[4],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const owned = spawnWindowsCommand(executable, args, cwd, environment, launch);
  let stdout = '';
  let stderr = '';
  owned.child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  owned.child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => {
    try { owned.cancel(); }
    catch { /* 终止失败会由 Guardian 的完成 Promise 报告，定时回调不能吞掉异步错误。 */ }
  }, 5_000);
  timeout.unref();
  try {
    const exitCode = await owned.completion;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeWindowsProcessOwnership(): Promise<boolean> {
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), 'ligule-job-probe-'));
    const environment = probeEnvironment(root);
    return (await runProbeCommand(process.execPath, ['--version'], root, environment)).exitCode === 0;
  } catch {
    return false;
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function probeWindowsSandbox(
  selectedShell?: ShellSelection,
  shellConfig?: Parameters<typeof resolveShell>[0],
  workspaceRoot?: string,
): Promise<WindowsSandboxProbeResult> {
  let root: string | undefined;
  let workspace: string | undefined;
  let outside: string | undefined;
  let temp: string | undefined;
  let networkServer: ReturnType<typeof createServer> | undefined;
  let readOnlyAvailable = false;
  let workspaceWriteAvailable = false;
  let readOnlyReason: string | undefined;
  let workspaceWriteReason: string | undefined;
  try {
    if (process.platform !== 'win32') {
      const reason = 'Windows sandbox probe is Windows-only';
      return { readOnlyAvailable: false, workspaceWriteAvailable: false, readOnlyReason: reason, workspaceWriteReason: reason };
    }
    const systemRoot = process.env.SystemRoot;
    if (typeof systemRoot !== 'string' || systemRoot === '') {
      const reason = 'Windows SystemRoot is unavailable';
      return { readOnlyAvailable: false, workspaceWriteAvailable: false, readOnlyReason: reason, workspaceWriteReason: reason };
    }
    const shell = selectedShell ?? resolveShell(shellConfig ?? {});
    const configuredWorkspace = await realpath(workspaceRoot ?? process.cwd());
    if (!(await stat(configuredWorkspace)).isDirectory()) throw new Error('the configured workspace is not a directory');
    root = await mkdtemp(join(tmpdir(), 'ligule-sandbox-probe-'));
    workspace = join(root, 'workspace');
    outside = join(root, 'outside');
    temp = join(root, 'temp');
    await Promise.all([mkdir(workspace), mkdir(outside), mkdir(temp)]);
    const existing = join(workspace, 'existing.txt');
    const outsideCanary = join(outside, 'outside.txt');
    await writeFile(existing, 'workspace-baseline');
    await writeFile(outsideCanary, 'outside-baseline');
    const environment = probeEnvironment(temp);
    try {
      const readOnlySource = [
        "const fs=require('node:fs');const path=require('node:path');",
        "const result={read:fs.readFileSync('existing.txt','utf8')};",
        "try{fs.writeFileSync('existing.txt','blocked');result.overwriteDenied=false}catch{result.overwriteDenied=true}",
        "try{fs.writeFileSync('new.txt','blocked');result.createDenied=false}catch{result.createDenied=true}",
        "try{fs.writeFileSync(path.resolve('..','outside','escaped.txt'),'blocked');result.outsideCreateDenied=false}catch{result.outsideCreateDenied=true}",
        "const tempPath=process.env.TEMP||'';result.privateTemp= /\\\\Packages\\\\Ligule-[^\\\\]+\\\\AC\\\\Temp$/iu.test(tempPath);",
        "const tempFile=path.join(tempPath,'read-only-temp.txt');fs.writeFileSync(tempFile,'temp');result.privateTempRoundTrip=fs.readFileSync(tempFile,'utf8')==='temp';",
        "process.stdout.write(JSON.stringify(result));",
      ].join(';');
      const readOnly = await runProbeCommand(process.execPath, ['-e', readOnlySource], workspace, environment, {
        kind: 'appcontainer', workspaceRoot: workspace,
      });
      let observation: Record<string, unknown> | undefined;
      try { observation = JSON.parse(readOnly.stdout) as Record<string, unknown>; }
      catch { observation = undefined; }
      const shellCommand = shell.kind === 'powershell'
        ? "Write-Output 'LIGULE_SANDBOX_SHELL_OK'"
        : "printf '%s' 'LIGULE_SANDBOX_SHELL_OK'";
      const readOnlyShell = await runProbeCommand(shell.executable, [...shell.prefix, shellCommand], workspace, environment, {
        kind: 'appcontainer', workspaceRoot: workspace,
      });
      const powershellWorkspace = configuredWorkspace.replaceAll("'", "''");
      const bashWorkspace = configuredWorkspace.replaceAll("'", "'\\''");
      const configuredCwdCommand = shell.kind === 'powershell'
        ? `$actual=(Get-Location).Path.TrimEnd([char]92).ToLowerInvariant();$expected='${powershellWorkspace}'.TrimEnd([char]92).ToLowerInvariant();if($actual -ne $expected){exit 71};Write-Output 'LIGULE_SANDBOX_CWD_OK'`
        : `actual="$(pwd -W)";expected='${bashWorkspace}';[ "$actual" = "$expected" ] && printf '%s' 'LIGULE_SANDBOX_CWD_OK'`;
      const configuredCwd = await runProbeCommand(shell.executable, [...shell.prefix, configuredCwdCommand], configuredWorkspace, environment, {
        kind: 'appcontainer', workspaceRoot: configuredWorkspace,
      });
      const readOnlyFailures = [
        ...(readOnly.exitCode === 0 ? [] : [`node_probe_exit_${readOnly.exitCode}`]),
        ...(readOnlyShell.exitCode === 0 && readOnlyShell.stdout.trim().endsWith('LIGULE_SANDBOX_SHELL_OK')
          ? [] : ['configured_shell_unavailable']),
        ...(configuredCwd.exitCode === 0 && configuredCwd.stdout.trim().endsWith('LIGULE_SANDBOX_CWD_OK')
          ? [] : ['configured_workspace_current_directory_unavailable']),
        ...(observation?.read === 'workspace-baseline' ? [] : ['workspace_read_failed']),
        ...(observation?.overwriteDenied === true ? [] : ['workspace_write_allowed']),
        ...(observation?.createDenied === true ? [] : ['workspace_create_allowed']),
        ...(observation?.outsideCreateDenied === true ? [] : ['outside_create_allowed']),
        ...(observation?.privateTemp === true && observation.privateTempRoundTrip === true ? [] : ['private_temp_unavailable']),
        ...((await readFile(existing, 'utf8')) !== 'workspace-baseline' ? ['workspace_write_allowed'] : []),
        ...((await access(join(workspace, 'new.txt')).then(() => true, () => false)) ? ['workspace_create_allowed'] : []),
        ...((await access(join(outside, 'escaped.txt')).then(() => true, () => false)) ? ['outside_create_allowed'] : []),
        ...((await readFile(outsideCanary, 'utf8')) !== 'outside-baseline' ? ['outside_write_allowed'] : []),
      ];
      if (readOnlyFailures.length === 0) {
        networkServer = createServer((socket) => socket.end('host-loopback-canary'));
        await new Promise<void>((resolvePromise, reject) => {
          networkServer!.once('error', reject);
          networkServer!.listen(0, '127.0.0.1', resolvePromise);
        });
        const address = networkServer.address();
        if (address === null || typeof address === 'string') throw new Error('AppContainer network probe did not bind an IPv4 loopback port');
        const networkSource = [
          "const net=require('net');let settled=false;",
          `const socket=net.connect(${address.port},'127.0.0.1');`,
          "const done=(result)=>{if(settled)return;settled=true;process.stdout.write(result);process.exit(result==='blocked'?0:2)};",
          "socket.once('connect',()=>done('connected'));socket.once('error',()=>done('blocked'));setTimeout(()=>done('timeout'),1000);",
        ].join('');
        const network = await runProbeCommand(process.execPath, ['-e', networkSource], workspace, environment, {
          kind: 'appcontainer', workspaceRoot: workspace,
        });
        if (network.exitCode === 0 && network.stdout === 'blocked') readOnlyAvailable = true;
        else readOnlyReason = `Windows AppContainer probe failed (network_not_blocked; exit ${network.exitCode})`;
      } else readOnlyReason = `Windows AppContainer probe failed (${readOnlyFailures.join(',')})`;
    } catch (error) {
      readOnlyReason = probeFailureReason('Windows AppContainer probe failed', error, root);
    }

    try {
      const workspaceWriteSource = [
        "const fs=require('node:fs');const path=require('node:path');",
        "fs.writeFileSync('write.txt','allowed');",
        "fs.writeFileSync(path.join(process.env.TEMP,'workspace-temp.txt'),'temp');",
        "try{fs.writeFileSync(path.resolve('..','outside','escaped.txt'),'blocked')}catch{}",
        "try{fs.writeFileSync(path.resolve('..','outside','outside.txt'),'blocked')}catch{}",
      ].join('');
      const workspaceWrite = await runProbeCommand(process.execPath, ['-e', workspaceWriteSource], workspace, environment, {
        kind: 'restricted-token', workspaceRoot: workspace, tempDirectory: temp, aclLockRoot: dataRoot(),
      });
      const workspaceWriteShellCommand = shell.kind === 'powershell'
        ? "Set-Content -LiteralPath 'shell-write.txt' -Value 'shell-write'; Write-Output 'LIGULE_SANDBOX_SHELL_OK'"
        : "printf '%s' 'shell-write' > shell-write.txt && printf '%s' 'LIGULE_SANDBOX_SHELL_OK'";
      const workspaceWriteShell = await runProbeCommand(shell.executable, [...shell.prefix, workspaceWriteShellCommand], workspace, environment, {
        kind: 'restricted-token', workspaceRoot: workspace, tempDirectory: temp, aclLockRoot: dataRoot(),
      });
      const writeFailures = [
        ...((await readFile(join(workspace, 'write.txt'), 'utf8').then((text) => text.trim() === 'allowed', () => false)) ? [] : ['workspace_write_denied']),
        ...((await readFile(join(temp, 'workspace-temp.txt'), 'utf8').then((text) => text.trim() === 'temp', () => false)) ? [] : ['private_temp_write_denied']),
        ...((await access(join(outside, 'escaped.txt')).then(() => true, () => false)) ? ['outside_create_allowed'] : []),
        ...((await readFile(outsideCanary, 'utf8')) !== 'outside-baseline' ? ['outside_write_allowed'] : []),
        ...(workspaceWrite.exitCode === 0 ? [] : [`node_probe_exit_${workspaceWrite.exitCode}`]),
        ...(workspaceWriteShell.exitCode === 0 && workspaceWriteShell.stdout.trim().endsWith('LIGULE_SANDBOX_SHELL_OK')
          ? [] : ['configured_shell_unavailable']),
        ...((await access(join(workspace, 'shell-write.txt')).then(() => true, () => false)) ? [] : ['configured_shell_workspace_write_denied']),
      ];
      if (writeFailures.length === 0) workspaceWriteAvailable = true;
      else workspaceWriteReason = `Windows WRITE_RESTRICTED probe failed (${writeFailures.join(',')})`;
    } catch (error) {
      workspaceWriteReason = probeFailureReason('Windows WRITE_RESTRICTED probe failed', error, root);
    }
  } catch (error) {
    const reason = probeFailureReason('Windows sandbox probe failed', error, root);
    readOnlyReason ??= reason;
    workspaceWriteReason ??= reason;
  } finally {
    if (networkServer?.listening) {
      await new Promise<void>((resolvePromise) => networkServer!.close(() => resolvePromise()));
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return {
    readOnlyAvailable,
    workspaceWriteAvailable,
    ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
    ...(workspaceWriteReason === undefined ? {} : { workspaceWriteReason }),
  };
}

function probeFailureReason(prefix: string, error: unknown, root: string | undefined): string {
  const message = typeof error === 'object' && error !== null && 'detail' in error && typeof error.detail === 'string'
    ? error.detail : error instanceof Error ? error.message : String(error);
  const detail = root === undefined ? message : message.replaceAll(root, '<sandbox-probe>');
  return `${prefix} (${stableCode(error)}: ${detail.slice(0, 240)})`;
}

async function probeLinuxProcessOwnership(): Promise<boolean> {
  try {
    const koffi = (await import('koffi')).default;
    const libc = koffi.load('libc.so.6');
    const getChildSubreaper = libc.func('prctl', 'int', [
      'int', koffi.out(koffi.pointer('int')), 'uintptr_t', 'uintptr_t', 'uintptr_t',
    ]) as (option: number, value: Array<number | null>, arg3: number, arg4: number, arg5: number) => number;
    const value: Array<number | null> = [null];
    return getChildSubreaper(37, value, 0, 0, 0) === 0 && (value[0] === 0 || value[0] === 1);
  } catch {
    return false;
  }
}

export async function createInteractivePermissionContext(
  options: PermissionCapabilityProbeOptions = {},
): Promise<PermissionContext> {
  const snapshot = await detectPermissionCapabilities(options);
  const contextOptions: PermissionContextOptions = {
    profiles: snapshot.profiles,
    limitations: snapshot.limitations,
    partialWorkspaceWriteConfirmationRequired: snapshot.partialWorkspaceWriteConfirmationRequired,
  };
  return createPermissionContext('read-only', 'policy', snapshot.capabilities, contextOptions);
}
