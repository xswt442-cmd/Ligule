// 删除只移入操作系统回收站；系统功能不可用或拒绝目标时由调用方返回错误。
// 平台实现集中在此处：Windows 使用系统接口，Linux 调用 GIO 系统回收站，macOS 暂无系统后端。
// 每个进程只探测一次系统回收站能力。
import { spawn } from 'node:child_process';
import { KernelError } from '../errors.js';

type RecycleBackend = {
  name: string;
  probe: () => Promise<void>;
  send: (target: string) => Promise<void>;
};
type RecyclerResolution =
  | { recycler: RecycleBackend }
  | { recycler: undefined; code: string };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

function errorMessage(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
}

// 通过环境变量将目标路径传给 PowerShell，避免引号或分号被解释为额外命令。
const SEND_COMMAND = [
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$target = $env:LIGULE_TRASH_TARGET',
  'if (Test-Path -LiteralPath $target -PathType Container) {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '} else {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '}',
].join('\n');

// 探测只验证 PowerShell 和系统回收站接口可用，不执行删除操作。
const PROBE_COMMAND = 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem] | Out-Null';

function runPowershell(command: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    // 丢弃 stdout，避免子进程写满管道后阻塞。
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new KernelError('recycle_backend_failed', { cause: error, detail: `powershell could not be started to move the file to the recycle bin: ${errorCode(error) ?? errorMessage(error)}` })));
    child.on('close', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new KernelError('recycle_backend_failed', { detail: stderr.trim() || `powershell exited with ${code}` }));
    });
  });
}

export const windowsRecycleBin = {
  name: 'system recycle bin',
  async probe(): Promise<void> {
    return runPowershell(PROBE_COMMAND);
  },
  send(target: string): Promise<void> {
    return runPowershell(SEND_COMMAND, { LIGULE_TRASH_TARGET: target });
  },
};

function runGio(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('gio', args, {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      const code = errorCode(error);
      reject(new KernelError(code === 'ENOENT' ? 'recycle_backend_missing' : 'recycle_backend_failed', {
        cause: error,
        detail: `gio could not send the item to the system trash: ${code ?? errorMessage(error)}`,
      }));
    });
    child.on('close', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new KernelError('recycle_backend_failed', { detail: stderr.trim() || `gio exited with ${code}` }));
    });
  });
}

// GIO 调用系统回收站；不支持回收的挂载点会明确返回错误。
export const linuxSystemTrash = {
  name: 'system trash',
  async probe(): Promise<void> {
    await runGio(['help', 'trash']);
  },
  async send(target: string): Promise<void> {
    await runGio(['trash', '--', target]);
  },
};

const CANDIDATES: Partial<Record<NodeJS.Platform, RecycleBackend>> = { win32: windowsRecycleBin, linux: linuxSystemTrash };

let resolved: RecyclerResolution | undefined;

// 选择当前平台的回收站后端并探测可用性；不可用时由调用方报告失败。
// 返回探测错误供调用方生成可行动错误。每个进程只缓存当前平台的探测结果。
export async function resolveRecycler(platform: NodeJS.Platform = process.platform): Promise<RecyclerResolution> {
  if (platform === process.platform && resolved !== undefined) return resolved;
  const result = await resolveOnce(platform);
  if (platform === process.platform) resolved = result;
  return result;
}

async function resolveOnce(platform: NodeJS.Platform): Promise<RecyclerResolution> {
  const candidate = CANDIDATES[platform];
  if (candidate === undefined) return { recycler: undefined, code: 'recycle_backend_missing' };
  try {
    await candidate.probe();
    return { recycler: candidate };
  } catch (error) {
    return { recycler: undefined, code: errorCode(error) ?? 'recycle_probe_failed' };
  }
}
