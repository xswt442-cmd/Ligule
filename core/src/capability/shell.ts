// Host 根据 `exec.shell` 配置为 `exec` 选择 `auto`、`bash` 或 `powershell`。
// 将所选语法和实际可执行文件写入记录，确保权限判定和执行使用同一解释器。
// 通过检查文件路径探测解释器，不启动进程。
import { existsSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { KernelError } from '../errors.js';

export type ShellKind = 'bash' | 'powershell';

export interface ShellSelection {
  kind: ShellKind;
  // 记录实际启动的可执行文件，避免把解释器记录成含糊的系统默认值。
  executable: string;
  // 解释器参数列表；命令文本作为最后一个参数传入。
  prefix: string[];
  // 仅当 `withNativeExitCode` 确认命令是原生命令时，才追加这段退出码处理代码。
  tail: string;
}

interface ShellProbe {
  platform?: NodeJS.Platform;
  environment?: Record<string, string | undefined>;
  locateExecutable?: (name: string, environment: Record<string, string | undefined>) => string | undefined;
}

const CHOICES = ['auto', 'bash', 'powershell'];

// `-NoProfile` 避免用户配置文件中的函数和别名改变命令含义；`-NonInteractive` 禁止等待交互输入。
// 命令通过 `-Command` 参数传入，不需要修改系统执行策略。
const POWERSHELL_PREFIX = ['-NoProfile', '-NonInteractive', '-Command'];
const BASH_PREFIX = ['-c'];

// Windows PowerShell 5.1 通过 `-Command` 返回 1 表示失败的原生命令，而实际退出码保存在 `$LASTEXITCODE`。
// 不能对所有命令都读取该变量，因为 cmdlet 失败不会更新它，可能误用上一条原生命令的退出码。
// 因此只在 `withNativeExitCode` 确认命令为原生命令时追加退出码处理。
const POWERSHELL_TAIL = '; exit $LASTEXITCODE';

function known(directory: string | undefined, ...parts: string[]): string | undefined {
  // 这些路径表示 Windows 目标机上的位置，应始终使用 Windows 路径规则拼接。
  // 在 POSIX 主机上使用平台默认分隔符会生成 Windows 无法识别的路径。
  return directory === undefined || directory === '' ? undefined : win32.join(directory, ...parts);
}

// 名称包含路径分隔符时直接检查该路径；否则逐个检查 PATH 目录。
function locate(name: string, environment: Record<string, string | undefined>): string | undefined {
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : undefined;
  for (const directory of (environment.PATH ?? environment.Path ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Windows 可执行文件后缀来自 PATHEXT，例如 PATH 中可能只有 `git.exe`。
// 不将 `.ps1` 视为原生命令，避免对脚本附加不适用的退出码处理。
function windowsExtensions(environment: Record<string, string | undefined>): string[] {
  return (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((entry) => entry !== '');
}

function firstFound(
  names: (string | undefined)[],
  environment: Record<string, string | undefined>,
  locateExecutable: (name: string, environment: Record<string, string | undefined>) => string | undefined,
): { executable: string | undefined; searched: string[] } {
  const searched = names.filter((name): name is string => name !== undefined);
  for (const name of searched) {
    const found = locateExecutable(name, environment);
    if (found !== undefined) return { executable: found, searched };
  }
  return { executable: undefined, searched };
}

function bashCandidates(platform: NodeJS.Platform, environment: Record<string, string | undefined>): (string | undefined)[] {
  // POSIX 系统依次尝试 `/bin/bash`、PATH 中的 `bash` 和 `sh`。
  if (platform !== 'win32') return ['/bin/bash', 'bash', 'sh'];
  // Windows 的 Bash 来自 Git for Windows。
  return [
    known(environment.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    known(environment['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    'bash.exe',
    'bash',
  ];
}

function powershellCandidates(platform: NodeJS.Platform): string[] {
  // 优先使用 PowerShell 7（`pwsh`），再使用 Windows 自带的 `powershell`。
  return platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh', 'powershell'];
}

// `auto` 在 Windows 上依次选择 PowerShell 和 Git Bash，在其他平台上选择 Bash。
// 显式指定解释器时只使用该解释器；找不到时返回稳定错误，不替换成另一种语法。
export function resolveShell(
  config: { exec?: { shell?: unknown } },
  { platform = process.platform, environment = process.env, locateExecutable = locate }: ShellProbe = {},
): ShellSelection {
  const requested = config.exec?.shell ?? 'auto';
  if (typeof requested !== 'string' || !CHOICES.includes(requested)) {
    throw new KernelError('exec_shell_unknown', { detail: `exec.shell is ${JSON.stringify(requested)}, expected one of ${CHOICES.join(', ')}` });
  }
  const kinds: ShellKind[] = requested === 'auto' ? (platform === 'win32' ? ['powershell', 'bash'] : ['bash']) : [requested as ShellKind];
  const failures: string[] = [];
  for (const kind of kinds) {
    const names = kind === 'bash' ? bashCandidates(platform, environment) : powershellCandidates(platform);
    const { executable, searched } = firstFound(names, environment, locateExecutable);
    if (executable !== undefined) {
      return { kind, executable, prefix: kind === 'bash' ? BASH_PREFIX : POWERSHELL_PREFIX, tail: '' };
    }
    failures.push(`${kind}: ${searched.join(', ')}`);
  }
  const looked = failures.join('; ');
  if (requested === 'auto') throw new KernelError('exec_shell_unavailable', { detail: `no shell backend was found (looked for ${looked})` });
  throw new KernelError('exec_shell_unavailable', { detail: `exec.shell="${requested}" but nothing matched ${looked}` });
}

// 只有权限判定已将输入识别为单条简单命令，且命令名解析为可执行文件时，才附加退出码处理。
// cmdlet、函数和别名不使用 `$LASTEXITCODE`，避免返回上一条原生命令留下的值。
// 仅支持单条命令；使用分号或 `&&` 组合的命令可能覆盖前面命令的退出码。
export function withNativeExitCode(
  shell: ShellSelection,
  command: string | undefined,
  { platform = process.platform, environment = process.env, locateExecutable = locate }: ShellProbe = {},
): ShellSelection {
  if (shell.kind !== 'powershell' || shell.tail !== '' || command === undefined) return shell;
  const name = /^(\S+)(\s|$)/.exec(command)?.[1];
  if (name === undefined) return shell;
  const extensions = platform === 'win32' ? windowsExtensions(environment) : [];
  const candidates = [name, ...extensions.flatMap((extension) => [name + extension.toLowerCase(), name + extension])];
  for (const candidate of candidates) {
    if (locateExecutable(candidate, environment) !== undefined) return { ...shell, tail: POWERSHELL_TAIL };
  }
  return shell;
}
