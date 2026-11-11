import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDecisionChain, createConfig, createKernel, createPermissionContext, createSessionLog,
  execTool, resolveShell, withNativeExitCode,
} from '../dist/index.js';
import { decode, runManagedExec, settleManagedCompletion } from '../dist/capability/exec.js';
import type { ExecRunContext, ManagedExecLease } from '../dist/capability/exec.js';
import type { CapabilityLimits } from '../dist/capability/limits.js';
import type { PermissionContext } from '../dist/kernel/permission.js';
import type { PolicyAsk, PolicyMode, PolicyQuestion } from '../dist/kernel/policy.js';
import { KernelError } from '../dist/kernel/error.js';
import { bindScript } from '../dist/capability/script-binding.js';
import { probeLinuxSandboxIsolation } from '../dist/capability/sandbox-linux.js';
import { setTrusted } from '../dist/kernel/workspace-trust.js';

type CodedFailure = { code: string; cause?: unknown };

type ExecOutcome = { text: string; exitCode: number | null };

type ExecLimits = Partial<Record<keyof CapabilityLimits, number>>;

type RecordedShell = { kind: string; executable: string; segments: string[]; tail?: string };

// Host 选择命令后端并传入这里；测试使用当前机器实际支持的后端。
// 被测的是 exec 自己的那几件事（头尾分页、标准输入、取消、退出码），所以脚本片段落到一个临时文件里再跑：
// Windows PowerShell 5.1 把传给原生命令的引号参数重排过一次，`<`、`>` 与 `=>` 都会被截掉（本机 2026-10-03 实测），
// 那段文本能不能原样送到 node 手上是 PowerShell 的事情，不是这一件工具的事情。斜杠两种 shell 都认，路径统一写成正斜杠。
// 命令写成 `node "<脚本>"` 这种一条简单原生命令的形状，退出码那一段尾巴才按内核那一条规则补得上。
const shell = resolveShell({});
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
}, { workspaceTrusted: true });
const directory = mkdtempSync(join(tmpdir(), 'ligule-exec-'));
// 这一份跑完就收掉：留在系统临时目录里的话，每跑一次 `npm test` 就多一份，几十次之后没人会再去清。
after(() => rmSync(directory, { recursive: true, force: true }));
let counter = 0;
function nodeCommand(code: string) {
  const script = join(directory, `case-${(counter += 1)}.js`).replace(/\\/g, '/');
  writeFileSync(script, code);
  return `node "${script}"`;
}

async function run(command: string, limits?: ExecLimits, signal?: AbortSignal, permission = fullAccess) {
  const boundary = process.cwd();
  const scriptBinding = await bindScript({ command, shell, boundary, workspaceRoot: boundary, cwd: boundary, permission });
  return execTool.run({ command }, {
    config: { boundary, limits: limits as CapabilityLimits }, permission, signal,
    shell: withNativeExitCode(shell, command),
    ...(scriptBinding === undefined ? {} : { scriptBinding }),
  });
}

async function runManagedNodeScript<TResult>(
  workspace: string, name: string, source: string, permission: PermissionContext,
  onManagedProcess: (lease: ManagedExecLease) => Promise<TResult>,
): Promise<TResult> {
  const scriptPath = join(workspace, name);
  writeFileSync(scriptPath, source);
  const command = `node "${scriptPath.replaceAll('\\', '/')}"`;
  const scriptBinding = await bindScript({ command, shell, boundary: workspace, workspaceRoot: workspace, cwd: workspace, permission });
  const managedShell = shell.kind === 'bash'
    ? { ...shell, tail: '; __ligule_test_exit=$?; exit "$__ligule_test_exit"' }
    : withNativeExitCode(shell, command);
  return runManagedExec({ command }, {
    config: { boundary: workspace }, permission, shell: managedShell,
    ...(scriptBinding === undefined ? {} : { scriptBinding }),
  }, onManagedProcess);
}

function processIsRunning(pid: number) {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) {
      if ((error as CodedFailure).code === 'ENOENT') return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as CodedFailure).code === 'ESRCH') return false;
    throw error;
  }
}

async function assertStopped(pid: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await delay(20);
  }
  assert.fail(`test-owned descendant process ${pid} remained alive`);
}

async function startTestMonitor(name: string) {
  const marker = join(directory, `${name}-${(counter += 1)}.ready`);
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true });
  if (child.pid === undefined) throw new Error('test-owned process did not receive a PID');
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !existsSync(marker)) await delay(10);
  if (!existsSync(marker)) {
    child.kill();
    throw new Error(`test-owned process ${name} did not report readiness`);
  }
  return child;
}

function assertRunning(child: ChildProcess, label: string) {
  assert.notEqual(child.pid, undefined);
  assert.equal(processIsRunning(child.pid!), true, `${label} should still be running`);
}

async function stopTestMonitor(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, delay(3_000).then(() => { throw new Error('test-owned process did not exit'); })]);
}

test('exec returns the command output and its exit code', async () => {
  const result = await run(nodeCommand('console.log("out");console.error("err");process.exit(3)'));
  assert.equal(result.exitCode, 3);
  assert.match(result.text, /out/);
  assert.match(result.text, /err/);
});

test('output beyond the limit keeps both ends and says how much is missing', async () => {
  const result = await run(nodeCommand('process.stdout.write("x".repeat(400))'), { execBytes: 40 });
  assert.match(result.text, /^x{20}/);
  assert.match(result.text, /\[truncated: \d+ bytes total, \d+ bytes in the middle omitted]/);
  assert.match(result.text, /x{20}$/);
});

// 不给标准输入：把父进程的那一个继承下去，等着读输入的命令就一直挂着，这一轮再也回不来。
test('the command gets no readable standard input', async () => {
  const script = 'let n=0;'
    + 'process.stdin.on("data",(d)=>{n+=d.length});'
    + 'process.stdin.on("end",()=>{console.log("eof:" + n);process.exit(0)});'
    + 'setTimeout(()=>{console.log("hang");process.exit(9)},2000)';
  const result = await run(nodeCommand(script));
  assert.equal(result.exitCode, 0, 'the command ends on its own once the input is closed');
  assert.match(result.text, /eof:0/);
  assert.doesNotMatch(result.text, /hang/);
});

// 一千万字节的输出：留下的只有头尾那一页，中间那一段既不收集也不在最后整体拼一次。
test('a large output keeps a bounded page and reports the exact arithmetic', async () => {
  const result = await run(
    nodeCommand('for (let i = 0; i < 200; i++) process.stdout.write("y".repeat(50000));'),
    { execBytes: 60 },
  );
  assert.match(result.text, /\[truncated: 10000000 bytes total, 9999940 bytes in the middle omitted]/);
  assert.match(result.text, /^y{30}/);
  assert.match(result.text, /y{30}$/);
  assert.equal(result.text.split('\n')[0], 'y'.repeat(30), 'the head is exactly the first half of the limit');
  assert.equal(result.text.split('\n').at(-1), 'y'.repeat(30), 'the tail is the rest of the limit');
  assert.equal(result.text.split('\n').length, 3, 'three lines: head, one notice, tail');
});

test('an abort terminates the command tree instead of waiting for it', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => run(nodeCommand('setTimeout(() => {}, 20000)'), undefined, controller.signal),
    (error) => (error as CodedFailure).code === 'exec_cancelled',
  );
  assert.ok(Date.now() - started < 5000, 'the cancelled call should settle long before the command would');
});

test('the configured execution timeout terminates a command with a distinct error code', async () => {
  const started = Date.now();
  await assert.rejects(
    () => run(nodeCommand('setTimeout(() => {}, 20000)'), { execTimeoutMs: 150 }),
    (error) => (error as CodedFailure).code === 'exec_timeout',
  );
  assert.ok(Date.now() - started < 5000, 'the timeout should settle long before the command would');
});

test('managed completion releases private resources exactly once when the exit status is null', async () => {
  let cleanupCalls = 0;
  await assert.rejects(
    settleManagedCompletion(Promise.resolve(null), async () => { cleanupCalls += 1; }),
    { code: 'exec_process_interrupted' },
  );
  assert.equal(cleanupCalls, 1);
});

test('a null managed completion exposes cleanup failure and retains the interruption cause', async () => {
  let cleanupCalls = 0;
  const cleanupFailure = new KernelError('exec_script_snapshot_cleanup_failed');
  await assert.rejects(
    settleManagedCompletion(Promise.resolve(null), async () => {
      cleanupCalls += 1;
      throw cleanupFailure;
    }),
    error => {
      const failure = error as CodedFailure;
      assert.equal(failure.code, 'exec_script_snapshot_cleanup_failed');
      assert.ok(failure.cause instanceof AggregateError);
      assert.deepEqual(failure.cause.errors.map(item => item.code), [
        'exec_process_interrupted', 'exec_script_snapshot_cleanup_failed',
      ]);
      return true;
    },
  );
  assert.equal(cleanupCalls, 1);
});

test('managed completion cleans up rejected exit states without erasing their error code', async () => {
  for (const code of ['exec_cancelled', 'exec_process_interrupted', 'exec_guardian_failed', 'exec_sandbox_cleanup_failed']) {
    let cleanupCalls = 0;
    const failure = new KernelError(code);
    await assert.rejects(
      settleManagedCompletion(Promise.reject(failure), async () => { cleanupCalls += 1; }),
      { code },
    );
    assert.equal(cleanupCalls, 1, `${code} should still release private resources exactly once`);
  }
});

test('managed exec reports and retries script-snapshot cleanup after an interrupted shell exit', {
  timeout: 15_000,
  skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'requires an unprivileged Linux Guardian' : false,
}, async (t) => {
  const workspace = mkdtempSync(join(directory, 'managed-interrupted-'));
  t.after(() => {
    chmodSync(workspace, 0o700);
    rmSync(workspace, { recursive: true, force: true });
  });
  const scriptPath = join(workspace, 'interrupt.js');
  let lease!: ManagedExecLease;
  let completionError!: CodedFailure;
  await runManagedNodeScript(workspace, 'interrupt.js',
    "require('node:fs').chmodSync(__dirname, 0o500); process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000);\n",
    fullAccess, async (managedLease) => {
      lease = managedLease;
      const watchdog = setTimeout(() => { void managedLease.stop().catch(() => undefined); }, 3_000);
      try {
        await managedLease.completion;
      } catch (error) {
        completionError = error as CodedFailure;
      } finally {
        clearTimeout(watchdog);
      }
    });

  assert.equal(completionError.code, 'exec_script_snapshot_cleanup_failed');
  assert.ok(completionError.cause instanceof AggregateError);
  assert.ok(completionError.cause.errors.some((error) => error.code === 'exec_process_interrupted'));
  chmodSync(workspace, 0o700);
  assert.equal(readdirSync(workspace).filter((name) => name !== 'interrupt.js').length, 1, 'the failed deletion must leave the snapshot for retry');

  await lease.stop();
  assert.deepEqual(readdirSync(workspace), ['interrupt.js'], 'a later stop must retry and confirm snapshot removal');
});

test('managed exec retries private temporary-directory cleanup after the process exits', {
  timeout: 15_000,
  skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'requires an unprivileged Linux sandbox' : false,
}, async (t) => {
  const probe = await probeLinuxSandboxIsolation();
  if (!probe.available) return t.skip(probe.reason);

  const workspace = mkdtempSync(join(directory, 'managed-temp-cleanup-'));
  const hostTempRoot = mkdtempSync(join(directory, 'managed-host-temp-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = hostTempRoot;
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (existsSync(hostTempRoot)) {
      for (const name of readdirSync(hostTempRoot)) chmodSync(join(hostTempRoot, name), 0o700);
      rmSync(hostTempRoot, { recursive: true, force: true });
    }
    rmSync(workspace, { recursive: true, force: true });
  });
  const permission = createPermissionContext('workspace-write', 'disabled', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  }, { workspaceTrusted: true });
  let lease!: ManagedExecLease;
  const cleanupError = await runManagedNodeScript(workspace, 'cleanup.js',
    "const fs = require('node:fs'); const path = require('node:path'); const temp = process.env.TMPDIR; if (!temp) throw new Error('sandbox TMPDIR is missing'); fs.writeFileSync(path.join(temp, 'ligule-cleanup-canary'), 'test'); fs.chmodSync(temp, 0o500);\n",
    permission, async (managedLease) => {
      lease = managedLease;
      try { await managedLease.completion; }
      catch (error) { return error as CodedFailure; }
      return undefined;
    });

  assert.equal(cleanupError!.code, 'exec_temp_cleanup_failed');
  const tempEntries = readdirSync(hostTempRoot);
  assert.equal(tempEntries.length, 1);
  const privateTemp = join(hostTempRoot, tempEntries[0]);
  assert.equal(statSync(privateTemp).mode & 0o777, 0o500);
  chmodSync(privateTemp, 0o700);
  await lease.stop();
  assert.equal(existsSync(privateTemp), false);
  assert.deepEqual(readdirSync(workspace), ['cleanup.js']);
});

test('execution timeout configuration stays within its fixed bound', async () => {
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), { execTimeoutMs: 0 }),
    (error) => (error as CodedFailure).code === 'exec_timeout_invalid',
  );
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), { execTimeoutMs: 600_001 }),
    (error) => (error as CodedFailure).code === 'exec_timeout_invalid',
  );
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), { execTimeoutMs: null } as unknown as ExecLimits),
    (error) => (error as CodedFailure).code === 'exec_timeout_invalid',
  );
});

test('the execution layer requires permission and explicit network access for full-access commands', async () => {
  await assert.rejects(
    () => execTool.run({ command: 'node -e "process.exit(0)"' }, {
      config: { boundary: process.cwd() }, shell,
    } as unknown as ExecRunContext),
    (error) => (error as CodedFailure).code === 'exec_permission_required',
  );
  const networkLimitedFullAccess = createPermissionContext('full-access', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  }, { workspaceTrusted: true });
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), undefined, undefined, networkLimitedFullAccess),
    (error) => (error as CodedFailure).code === 'permission_network_isolation_unavailable',
  );
});

test('Linux read-only Shell runs under bubblewrap and cannot write to its workspace', {
  skip: process.platform === 'linux' ? false : 'requires the Linux bubblewrap backend',
}, async (t) => {
  const probe = await probeLinuxSandboxIsolation();
  if (!probe.available) return t.skip(probe.reason);

  const workspace = mkdtempSync(join(directory, 'read-only-sandbox-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = 'printf restricted-ok; if touch denied; then exit 18; fi';
  const permission = createPermissionContext('read-only', 'disabled', {
    filesystemRead: 'partial', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const result = await execTool.run({ command }, {
    config: { boundary: workspace }, permission,
    shell: withNativeExitCode(shell, command),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /restricted-ok/u);
  assert.equal(existsSync(join(workspace, 'denied')), false);
});

test('Linux workspace-write Shell writes inside its workspace and cannot escape it', {
  skip: process.platform === 'linux' ? false : 'requires the Linux bubblewrap backend',
}, async (t) => {
  const probe = await probeLinuxSandboxIsolation();
  if (!probe.available) return t.skip(probe.reason);

  const root = mkdtempSync(join(directory, 'workspace-write-sandbox-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  mkdirSync(workspace);
  writeFileSync(outside, 'outside content stays unchanged');
  symlinkSync(outside, join(workspace, 'outside-link'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const command = 'printf workspace-write-ok > allowed.txt; if touch ../outside.txt 2>/dev/null; then exit 31; fi; if touch outside-link 2>/dev/null; then exit 32; fi; printf complete';
  const permission = createPermissionContext('workspace-write', 'disabled', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  });
  const result = await execTool.run({ command }, {
    config: { boundary: workspace }, permission,
    shell: withNativeExitCode(shell, command),
  });

  assert.equal(result.exitCode, 0, result.text);
  assert.equal(readFileSync(join(workspace, 'allowed.txt'), 'utf8'), 'workspace-write-ok');
  assert.equal(readFileSync(outside, 'utf8'), 'outside content stays unchanged');
});

test('Linux sandbox timeout stops descendants before they can change the workspace', {
  skip: process.platform === 'linux' ? false : 'requires the Linux bubblewrap backend',
}, async (t) => {
  const probe = await probeLinuxSandboxIsolation();
  if (!probe.available) return t.skip(probe.reason);

  const workspace = mkdtempSync(join(directory, 'sandbox-timeout-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = '(touch started; sleep 2; touch leaked-after-timeout) & wait';
  const permission = createPermissionContext('workspace-write', 'disabled', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  });
  await assert.rejects(
    () => execTool.run({ command }, {
      config: { boundary: workspace, limits: { execTimeoutMs: 1_000 } as ExecLimits as CapabilityLimits }, permission,
      shell: withNativeExitCode(shell, command),
    }),
    (error) => (error as CodedFailure).code === 'exec_timeout',
  );
  await delay(2_100);
  assert.equal(existsSync(join(workspace, 'started')), true, 'the child process must have started inside the sandbox');
  assert.equal(existsSync(join(workspace, 'leaked-after-timeout')), false, 'a killed descendant must not write after timeout');
});

test('Linux sandbox cancellation stops descendants before they can change the workspace', {
  skip: process.platform === 'linux' ? false : 'requires the Linux bubblewrap backend',
}, async (t) => {
  const probe = await probeLinuxSandboxIsolation();
  if (!probe.available) return t.skip(probe.reason);

  const workspace = mkdtempSync(join(directory, 'sandbox-cancel-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = '(touch started; sleep 1; touch leaked-after-cancel) & wait';
  const permission = createPermissionContext('workspace-write', 'disabled', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  });
  const controller = new AbortController();
  const execution = execTool.run({ command }, {
    config: { boundary: workspace }, permission, signal: controller.signal,
    shell: withNativeExitCode(shell, command),
  });
  try {
    const startedAt = Date.now();
    const deadline = startedAt + 5_000;
    while (Date.now() < deadline && !existsSync(join(workspace, 'started'))) await delay(10);
    assert.equal(existsSync(join(workspace, 'started')), true, 'the child process must have started inside the sandbox');
    t.diagnostic(`Linux sandbox cancellation child startup: ${Date.now() - startedAt}ms`);
    controller.abort();
    await assert.rejects(() => execution, (error) => (error as CodedFailure).code === 'exec_cancelled');
    await delay(1_100);
    assert.equal(existsSync(join(workspace, 'leaked-after-cancel')), false, 'a cancelled descendant must not write afterward');
  } finally {
    controller.abort();
    await execution.catch(() => undefined);
  }
});

test('the child receives approved environment variables without provider secrets', async () => {
  const secretName = 'LIGULE_EXEC_TEST_PROVIDER_SECRET';
  process.env[secretName] = 'exec-test-secret-sentinel';
  try {
    const result = await run(nodeCommand(`console.log(process.env[${JSON.stringify(secretName)}] ?? 'not-inherited')`));
    assert.equal(result.text.trim(), 'not-inherited');
  } finally {
    delete process.env[secretName];
  }
});

test('timeout terminates a detached descendant without leaving it alive', async () => {
  const childPidFile = join(directory, `child-${(counter += 1)}.pid`).replace(/\\/g, '/');
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  await assert.rejects(
    () => run(nodeCommand(script), { execTimeoutMs: 3_000 }),
    (error) => (error as CodedFailure).code === 'exec_timeout',
  );
  const pid = Number(readFileSync(childPidFile, 'utf8'));
  await assertStopped(pid);
});

test('cancellation terminates a detached descendant without leaving it alive', async (t) => {
  const childPidFile = join(directory, `cancel-child-${(counter += 1)}.pid`).replace(/\\/g, '/');
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const controller = new AbortController();
  const execution = run(nodeCommand(script), undefined, controller.signal);
  try {
    const startedAt = Date.now();
    const deadline = startedAt + 5_000;
    while (Date.now() < deadline && !existsSync(childPidFile)) await delay(10);
    assert.ok(existsSync(childPidFile), 'the command should record its owned child PID before cancellation');
    t.diagnostic(`detached cancellation child PID startup: ${Date.now() - startedAt}ms`);
    const pid = Number(readFileSync(childPidFile, 'utf8'));
    controller.abort();
    await assert.rejects(() => execution, (error) => (error as CodedFailure).code === 'exec_cancelled');
    await assertStopped(pid);
  } finally {
    controller.abort();
    await execution.catch(() => undefined);
  }
});

test('an empty command line and a working directory outside the boundary are rejected', async () => {
  await assert.rejects(() => run('   '), (error) => (error as CodedFailure).code === 'exec_command_required');
  await assert.rejects(
    () => execTool.run({ command: 'dir', cwd: '..' }, { config: { boundary: process.cwd() }, permission: fullAccess, shell }),
    (error) => (error as CodedFailure).code === 'path_escapes_boundary',
  );
});

test('the decision chain sees the command text before anything is spawned', async () => {
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: fullAccess,
    policy: createDecisionChain({ rules: [{ tool: 'exec', decision: 'deny', match: 'rm *' }] }),
  });
  kernel.register(execTool);
  await assert.rejects(
    () => kernel.call('exec', { command: 'rm -rf /tmp/nowhere' }),
    (error) => (error as CodedFailure).code === 'policy_denied',
  );
});

test('approved explicit multi-process termination kills only its listed test processes', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 20_000,
}, async () => {
  const targets: ChildProcess[] = [];
  const monitors: ChildProcess[] = [];
  try {
    targets.push(await startTestMonitor('batch-target-a'));
    targets.push(await startTestMonitor('batch-target-b'));
    monitors.push(await startTestMonitor('independent-monitor-a'));
    monitors.push(await startTestMonitor('independent-monitor-b'));
    const targetPids = targets.map((child) => String(child.pid));
    const command = targetPids.map((pid) => process.platform === 'win32'
      ? `Stop-Process -Id ${pid} -Force`
      : `kill -KILL ${pid}`).join('; ');
    const createApprovalKernel = (mode: PolicyMode, ask: PolicyAsk) => {
      const kernel = createKernel({
        config: createConfig({ user: { boundary: directory, workspaceRoot: directory } }),
        permission: fullAccess,
        policy: createDecisionChain({ mode, ask }),
      });
      kernel.register(execTool);
      return kernel;
    };

    // 新四档里 `never` 明确跳过 Policy 层（包括必须人工批准的那一类），所以它既不弹窗也不拦命令；
    // 为了不去动后面要用的目标进程，这里单独开一个可丢弃的进程验证。
    const disposable = await startTestMonitor('disposable-under-never');
    try {
      let neverRequests = 0;
      const neverKernel = createApprovalKernel('never', async () => { neverRequests += 1; return true; });
      const neverCommand = process.platform === 'win32'
        ? `Stop-Process -Id ${disposable.pid} -Force`
        : `kill -KILL ${disposable.pid}`;
      const neverOutcome = await neverKernel.call('exec', { command: neverCommand }) as ExecOutcome;
      assert.equal(neverOutcome.exitCode, 0, neverOutcome.text);
      assert.equal(neverRequests, 0, 'never mode does not consult the approval channel');
      await assertStopped(disposable.pid!);
      for (const child of [...targets, ...monitors]) assertRunning(child, 'process after Policy never');
    } finally {
      await stopTestMonitor(disposable);
    }

    const declined: PolicyQuestion[] = [];
    const declineKernel = createApprovalKernel('ask', async (request) => {
      declined.push(request);
      return false;
    });
    await assert.rejects(() => declineKernel.call('exec', { command }), { code: 'ask_declined' });
    assert.equal(declined.length, 1);
    assert.equal(declined[0].command, command, 'the approval displays the exact PID list that will execute');
    assert.match(declined[0].reason!, /process ownership is unknown/u);
    for (const child of [...targets, ...monitors]) assertRunning(child, 'process after denied approval');

    const approved: PolicyQuestion[] = [];
    const approveKernel = createApprovalKernel('ask', async (request) => {
      approved.push(request);
      return true;
    });
    const result = await approveKernel.call('exec', { command }) as ExecOutcome;
    assert.equal(result.exitCode, 0, result.text);
    assert.equal(approved.length, 1);
    assert.equal(approved[0].command, command);
    for (const child of targets) await assertStopped(child.pid!);
    for (const child of monitors) assertRunning(child, 'independent monitoring process after approval');
  } finally {
    for (const child of [...targets, ...monitors]) await stopTestMonitor(child);
  }
});

// 记录应说明使用的语法、启动的可执行文件，以及命令解析出的各段参数。
test('the record names the backend a command was judged and run under', async () => {
  const session = createSessionLog({ directory: mkdtempSync(join(directory, 'record-')), id: 'backend' });
  await setTrusted(process.cwd(), true);
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: fullAccess,
    policy: createDecisionChain({ mode: 'auto', ask: () => true }),
    session,
  });
  kernel.register(execTool);
  await kernel.call('exec', { command: 'git status' });
  const [entry] = await session.read();
  // 尾巴补没补由这台机器的 PATH 决定（`git` 是个可执行文件才补），两种都在这一条里接受，但不接受第三种值。
  const { tail, ...chosen } = entry.shell as RecordedShell;
  assert.deepEqual(chosen, { kind: shell.kind, executable: shell.executable, segments: ['git status'] });
  assert.ok(tail === undefined || tail === '; exit $LASTEXITCODE', `unexpected tail: ${tail}`);
});

// Windows 上子进程写的是控制台码页，按 utf8 硬解会得到一串乱字（界面里就是问号）。
// 这一条只在码页真是 cp936 的控制台上跑：别的码页要的标签不在 WHATWG 的编码表里，测了也不代表那台机器。
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
const consolePage = process.platform === 'win32'
  ? /(\d+)/.exec(execFileSync('chcp.com', [], { encoding: 'utf8' }))?.[1]
  : undefined;

test('a child writing the console code page is decoded instead of garbled', {
  skip: consolePage === '936' ? false : `needs a cp936 console (this one: ${consolePage ?? process.platform})`,
}, () => {
  assert.equal(decode(GBK_ZHONGWEN), '中文');
  assert.equal(decode(Buffer.from('普通的 utf8 输出', 'utf8')), '普通的 utf8 输出');
});
