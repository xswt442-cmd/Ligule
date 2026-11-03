import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveShell, withNativeExitCode } from '../dist/index.js';
import type { ShellSelection } from '../dist/capability/shell.js';

function hasCode(error: unknown, code: string): error is { code: string; detail: string } {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

// 探测这一步用一条注入的查找代替真文件系统：这一具 Host 该挑哪一份解释器是逻辑，机器上真有什么是环境。
const windowsEnvironment = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' };
const POWERSHELL: ShellSelection = { kind: 'powershell', executable: 'C:\\powershell.exe', prefix: ['-Command'], tail: '' };

function locates(...names: string[]) {
  const found = new Set(names);
  return (name: string) => (found.has(name) ? name : undefined);
}

test('an unknown backend name is refused at once', () => {
  assert.throws(
    () => resolveShell({ exec: { shell: 'cmd' } }, { platform: 'win32', environment: windowsEnvironment, locateExecutable: locates() }),
    (error) => hasCode(error, 'exec_shell_unknown') && /expected one of auto, bash, powershell/.test(error.detail),
  );
});

test('auto on Windows takes PowerShell first, and PowerShell 7 before the built-in one', () => {
  const both = resolveShell({}, {
    platform: 'win32',
    environment: windowsEnvironment,
    locateExecutable: locates('pwsh.exe', 'powershell.exe'),
  });
  assert.equal(both.kind, 'powershell');
  assert.equal(both.executable, 'pwsh.exe');
  assert.deepEqual(both.prefix, ['-NoProfile', '-NonInteractive', '-Command']);
  // 选定的一份解释器本身不带尾巴：补不补要看判定读出来的那一条命令（下面那几条测试）。
  assert.equal(both.tail, '');
});

test('auto on Windows falls back to Git Bash when there is no PowerShell', () => {
  const shell = resolveShell({}, {
    platform: 'win32',
    environment: windowsEnvironment,
    locateExecutable: locates('C:\\Program Files\\Git\\bin\\bash.exe'),
  });
  assert.equal(shell.kind, 'bash');
  assert.equal(shell.executable, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(shell.prefix, ['-c']);
  assert.equal(shell.tail, '');
});

test('auto on a POSIX platform takes bash from the usual locations in order', () => {
  const withPath = resolveShell({}, { platform: 'linux', environment: { PATH: '/usr/bin' }, locateExecutable: locates('bash') });
  assert.equal(withPath.executable, 'bash');
  const onlySh = resolveShell({}, { platform: 'linux', environment: { PATH: '/usr/bin' }, locateExecutable: locates('sh') });
  assert.equal(onlySh.executable, 'sh');
});

// 显式写了哪一种就只要那一种：回落成另一份等于跑了一份没人判过的语法。
test('an explicitly chosen backend that is missing is reported, not swapped for another', () => {
  assert.throws(
    () => resolveShell({ exec: { shell: 'powershell' } }, {
      platform: 'win32',
      environment: windowsEnvironment,
      locateExecutable: locates('bash.exe'),
    }),
    (error) => hasCode(error, 'exec_shell_unavailable')
      && /exec\.shell="powershell"/.test(error.detail)
      && /pwsh\.exe, powershell\.exe/.test(error.detail)
      && !error.detail.includes('bash'),
  );
});

test('nothing at all on the machine is a stable code naming what was searched', () => {
  assert.throws(
    () => resolveShell({}, { platform: 'win32', environment: { PATH: '' }, locateExecutable: locates() }),
    (error) => hasCode(error, 'exec_shell_unavailable') && /powershell:.*bash:/s.test(error.detail),
  );
});

// Windows PowerShell 5.1 把失败的原生命令一律交回 1，所以判定读出来是一条简单命令、而那个名字又是一个可执行文件时，
// 命令文本后面补一段 `; exit $LASTEXITCODE` 才拿得到真正的退出码。
test('a provable single native invocation gets the exit code tail', () => {
  const withTail = withNativeExitCode(POWERSHELL, 'git status', {
    platform: 'win32',
    environment: { PATHEXT: '.EXE' },
    locateExecutable: (name) => (name === 'git.exe' ? `C:\tools\${name}` : undefined),
  });
  assert.equal(withTail.tail, '; exit $LASTEXITCODE');
  // 选出来的那一份本身不改：补的是这一次调用的事，不是这台机器的配置。
  assert.equal(POWERSHELL.tail, '');
});

// cmdlet 失败不改 `$LASTEXITCODE`：统一补这段会把一次失败读成上一条原生命令留下的旧值，常常是 0，也就是成功。
test('a command name that is not an executable on this machine keeps PowerShell own code', () => {
  const found = withNativeExitCode(POWERSHELL, 'Get-ChildItem -Force', {
    platform: 'win32',
    environment: { PATHEXT: '.EXE' },
    locateExecutable: (name) => (name === 'git.exe' ? `C:\tools\${name}` : undefined),
  });
  assert.equal(found.tail, '');
});

test('the tail is only for a PowerShell command the chain read as one simple command', () => {
  const locate = (name: string) => (name === 'git.exe' ? `C:\tools\${name}` : undefined);
  // 分号与 `&&` 串起来的几条里 `$LASTEXITCODE` 只说最后那一条，前几条的失败会被盖掉：那时调用方交进来的是 undefined。
  assert.equal(withNativeExitCode(POWERSHELL, undefined, { platform: 'win32', environment: { PATHEXT: '.EXE' }, locateExecutable: locate }).tail, '');
  // bash 不需要这一段：`-c` 直接把命令的退出码交回给父进程。
  const bash: ShellSelection = { kind: 'bash', executable: '/bin/bash', prefix: ['-c'], tail: '' };
  assert.equal(withNativeExitCode(bash, 'git status', { platform: 'linux', environment: {}, locateExecutable: (name) => name }).tail, '');
});
