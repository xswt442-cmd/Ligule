import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';

const ELECTRON_ROOT = resolve(process.cwd(), 'desktop', 'electron');
const DESKTOP_ROOT = resolve(ELECTRON_ROOT, '..');
const TEMP_ROOT = join(DESKTOP_ROOT, 'testplace', 'tmp');
const EVIDENCE_ROOT = join(DESKTOP_ROOT, 'testplace', 'readings');
const HOST_ENTRY = join(ELECTRON_ROOT, 'dist', 'host-entry.js');
const NODE = join(DESKTOP_ROOT, 'vendor', 'node', 'node.exe');
const VENDORED_CORE_DIST = join(DESKTOP_ROOT, 'vendor', 'app', 'node_modules', '@ligule', 'core', 'dist');
const RUNTIME_NODE_MODULES = join(DESKTOP_ROOT, 'vendor', 'app', 'node_modules');
const NODE_VERSION = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'node-pin.json'), 'utf8')).version as string;
const { HostController } = createRequire(join(ELECTRON_ROOT, 'package.json'))('./dist/host.js') as {
  HostController: new (options: {
    node: string;
    hostEntry: string;
    entry: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    onFrame(frame: string): void;
    onFault(fault: string): void;
  }) => TestHostController;
};
const evidence: Record<string, unknown> = {
  nodeVersion: process.version,
  nodeExecutable: process.execPath,
  platform: process.platform,
  startedAt: new Date().toISOString(),
  cases: [],
};

test('normal stdin EOF closes the real Host wrapper and its descendants', {
  skip: process.platform === 'win32' ? false : 'Windows Job Object verification requires Windows',
}, async () => {
  await runControllerCase({ name: 'stdin-eof', exitOnStdinEnd: true, expectForcedTermination: false });
});

test('HostController forced termination closes the real Host wrapper Job Object', {
  skip: process.platform === 'win32' ? false : 'Windows Job Object verification requires Windows',
}, async () => {
  await runControllerCase({ name: 'forced-host-kill', exitOnStdinEnd: false, expectForcedTermination: true });
});

test('an abruptly terminated Main parent releases the wrapper Job Object', {
  skip: process.platform === 'win32' ? false : 'Windows Job Object verification requires Windows',
}, async () => {
  await runMainCrashCase();
});

after(async () => {
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const output = join(EVIDENCE_ROOT, 'process-tree-windows.json');
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`Windows process-tree evidence: ${output}\n`);
});

interface ControllerCaseOptions {
  name: string;
  exitOnStdinEnd: boolean;
  expectForcedTermination: boolean;
}

interface TestHostController {
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function runControllerCase(options: ControllerCaseOptions): Promise<void> {
  assert.equal(process.version, NODE_VERSION, `run this test with the vendored Node ${NODE_VERSION}`);
  assert.equal(await realpath(process.execPath), await realpath(NODE), 'run the test with the vendored standalone Node executable');
  const report = caseReport(options.name);
  const fixture = await createFixture(options.name, options.exitOnStdinEnd);
  let controller: TestHostController | undefined;
  let ownedPids: number[] = [];
  try {
    const ready = deferred<{ hostPid: number; descendantPid: number }>();
    controller = createController(fixture, frame => ready.resolve(parseReadyFrame(frame)));
    await controller.start();
    const processes = await withTimeout(ready.promise, 12_000, 'Host wrapper did not report its descendant PID');
    ownedPids = [processes.hostPid, processes.descendantPid];
    report.processIds = processes;
    const beforeStop = await waitForProcessesToExist(ownedPids, 5_000);
    report.beforeStop = beforeStop;
    assert.equal(beforeStop.length, 2, 'Win32_Process must report the wrapper and its real child process');
    assert.ok(beforeStop.some(item => item.ProcessId === processes.hostPid && item.CommandLine?.includes(HOST_ENTRY)));
    assert.ok(beforeStop.some(item => item.ProcessId === processes.descendantPid));

    const stopStarted = Date.now();
    await controller.stop();
    report.stopDurationMs = Date.now() - stopStarted;
    report.afterStop = await waitForProcessesToExit(ownedPids, 10_000);
    assert.deepEqual(report.afterStop, [], 'the wrapper and descendant must exit after HostController.stop()');
    if (options.expectForcedTermination) {
      assert.ok((report.stopDurationMs as number) >= 2_800, 'the forced-kill case must pass the Host shutdown grace period');
    }
  } finally {
    if (controller !== undefined) await controller.stop().catch(() => undefined);
    if (ownedPids.length > 0) {
      const remaining = await waitForProcessesToExit(ownedPids, 10_000);
      if (remaining.length > 0) {
        await terminateKnownProcessTree(remaining, ownedPids[0], fixture.hostEntry);
        const afterCleanup = await waitForProcessesToExit(ownedPids, 10_000);
        if (afterCleanup.length > 0) throw new Error('test-owned Host processes remain after targeted cleanup');
      }
    }
    await removeFixture(fixture.root);
  }
}

async function runMainCrashCase(): Promise<void> {
  assert.equal(process.version, NODE_VERSION, `run this test with the vendored Node ${NODE_VERSION}`);
  assert.equal(await realpath(process.execPath), await realpath(NODE), 'run the test with the vendored standalone Node executable');
  const report = caseReport('main-parent-crash');
  const fixture = await createFixture('main-parent-crash', false);
  const helperPath = join(fixture.root, 'main-parent.cjs');
  const hostControllerPath = join(ELECTRON_ROOT, 'dist', 'host.js');
  const source = mainParentSource({
    hostControllerPath,
    node: NODE,
    hostEntry: fixture.hostEntry,
    entry: HOST_ENTRY,
    cwd: fixture.root,
  });
  await writeFile(helperPath, source, 'utf8');
  let helper: ChildProcess | undefined;
  let processIds: { mainPid: number; hostPid: number; descendantPid: number } | undefined;
  try {
    helper = spawn(NODE, [helperPath], {
      cwd: fixture.root,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    assert.ok(helper.pid !== undefined, 'the test-owned Main harness must have a process ID');
    const ready = readSingleJsonLine(helper);
    processIds = await withTimeout(ready, 12_000, 'Main harness did not report the Host descendant PID');
    const ownedPids = [helper.pid, processIds.hostPid, processIds.descendantPid];
    report.processIds = processIds;
    const beforeMainTermination = await waitForProcessesToExist(ownedPids, 5_000);
    report.beforeMainTermination = beforeMainTermination;
    const mainRow = beforeMainTermination.find(item => item.ProcessId === helper?.pid);
    const hostRow = beforeMainTermination.find(item => item.ProcessId === processIds?.hostPid);
    const descendantRow = beforeMainTermination.find(item => item.ProcessId === processIds?.descendantPid);
    assert.ok(mainRow?.CommandLine?.includes(helperPath), 'the PID to terminate must identify this test-owned Main harness');
    assert.ok(hostRow?.CommandLine?.includes(HOST_ENTRY), 'Win32_Process must identify the real Host wrapper');
    assert.ok(descendantRow !== undefined, 'Win32_Process must identify the wrapper descendant');

    helper.kill();
    report.mainExit = await waitForChildExit(helper, 5_000);
    report.afterMainTermination = await waitForProcessesToExit(ownedPids.slice(1), 24_000);
    assert.deepEqual(report.afterMainTermination, [], 'the wrapper and descendant must exit after the Main IPC disconnect grace period');
  } finally {
    if (helper !== undefined && helper.exitCode === null && helper.signalCode === null) {
      const mainRow = await queryWin32Processes([helper.pid as number]);
      if (mainRow.some(item => item.CommandLine?.includes(helperPath))) helper.kill();
      await waitForChildExit(helper, 5_000).catch(() => undefined);
    }
    if (processIds !== undefined) {
      const pids = [processIds.hostPid, processIds.descendantPid];
      const remaining = await waitForProcessesToExit(pids, 10_000);
      if (remaining.length > 0) {
        await terminateKnownProcessTree(remaining, processIds.hostPid, fixture.hostEntry);
        const afterCleanup = await waitForProcessesToExit(pids, 10_000);
        if (afterCleanup.length > 0) throw new Error('test-owned Host processes remain after targeted cleanup');
      }
    }
    await removeFixture(fixture.root);
  }
}

function createController(fixture: { root: string; hostEntry: string }, onFrame: (frame: string) => void): TestHostController {
  return new HostController({
    node: NODE,
    hostEntry: fixture.hostEntry,
    entry: HOST_ENTRY,
    cwd: fixture.root,
    env: { ...process.env },
    onFrame,
    onFault: fault => { throw new Error(`HostController reported ${fault}`); },
  });
}

async function createFixture(name: string, exitOnStdinEnd: boolean): Promise<{ root: string; hostEntry: string }> {
  const root = join(TEMP_ROOT, `process-tree-${name}-${process.pid}-${Date.now()}`);
  assertInsideTempRoot(root);
  const capability = join(root, 'dist', 'capability');
  const kernel = join(root, 'dist', 'kernel');
  const hostDirectory = join(root, 'dist', 'host');
  await Promise.all([mkdir(capability, { recursive: true }), mkdir(kernel, { recursive: true }), mkdir(hostDirectory, { recursive: true })]);
  await Promise.all([
    copyFile(join(VENDORED_CORE_DIST, 'capability', 'win32-job.js'), join(capability, 'win32-job.js')),
    copyFile(join(VENDORED_CORE_DIST, 'errors.js'), join(root, 'dist', 'errors.js')),
    copyFile(join(VENDORED_CORE_DIST, 'kernel', 'error.js'), join(kernel, 'error.js')),
    symlink(RUNTIME_NODE_MODULES, join(root, 'dist', 'node_modules'), 'junction'),
  ]);
  const hostEntry = join(hostDirectory, 'desktop-entry.js');
  await writeFile(hostEntry, cliSource(exitOnStdinEnd), 'utf8');
  return { root, hostEntry };
}

async function removeFixture(path: string): Promise<void> {
  assertInsideTempRoot(path);
  await rm(path, { recursive: true, force: true });
}

function assertInsideTempRoot(path: string): void {
  const root = resolve(TEMP_ROOT);
  const target = resolve(path);
  const child = relative(root, target);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`refusing to remove a path outside desktop/testplace/tmp: ${target}`);
  }
}

function cliSource(exitOnStdinEnd: boolean): string {
  return `const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
process.stdout.write(JSON.stringify({ hostPid: process.pid, descendantPid: descendant.pid }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => { if (${exitOnStdinEnd}) process.exit(0); });
setInterval(() => {}, 1000);
`;
}

function mainParentSource(options: { hostControllerPath: string; node: string; hostEntry: string; entry: string; cwd: string }): string {
  return `const { HostController } = require(${JSON.stringify(options.hostControllerPath)});
const controller = new HostController({
  node: ${JSON.stringify(options.node)},
  hostEntry: ${JSON.stringify(options.hostEntry)},
  entry: ${JSON.stringify(options.entry)},
  cwd: ${JSON.stringify(options.cwd)},
  env: { ...process.env },
  onFrame(frame) {
    const child = JSON.parse(frame);
    process.stdout.write(JSON.stringify({ mainPid: process.pid, hostPid: child.hostPid, descendantPid: child.descendantPid }) + '\\n');
  },
  onFault(fault) { process.stderr.write(fault + '\\n'); },
});
controller.start().catch(error => { process.stderr.write(String(error) + '\\n'); process.exitCode = 1; });
setInterval(() => {}, 1000);
`;
}

function parseReadyFrame(frame: string): { hostPid: number; descendantPid: number } {
  const value = JSON.parse(frame) as { hostPid?: unknown; descendantPid?: unknown };
  assert.equal(typeof value.hostPid, 'number');
  assert.equal(typeof value.descendantPid, 'number');
  return { hostPid: value.hostPid as number, descendantPid: value.descendantPid as number };
}

function readSingleJsonLine(child: ChildProcess): Promise<{ mainPid: number; hostPid: number; descendantPid: number }> {
  assert.ok(child.stdout !== null);
  return new Promise((resolveLine, rejectLine) => {
    const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    const errorText: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => errorText.push(chunk));
    child.once('exit', code => rejectLine(new Error(`Main harness exited before reporting PIDs (${code}): ${Buffer.concat(errorText).toString('utf8')}`)));
    reader.once('line', line => {
      reader.close();
      try {
        const parsed = JSON.parse(line) as { mainPid?: unknown; hostPid?: unknown; descendantPid?: unknown };
        assert.equal(typeof parsed.mainPid, 'number');
        assert.equal(typeof parsed.hostPid, 'number');
        assert.equal(typeof parsed.descendantPid, 'number');
        resolveLine({ mainPid: parsed.mainPid as number, hostPid: parsed.hostPid as number, descendantPid: parsed.descendantPid as number });
      } catch (error) {
        rejectLine(error);
      }
    });
  });
}

interface Win32ProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
}

function queryWin32Processes(pids: number[]): Promise<Win32ProcessRow[]> {
  assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  const ids = pids.join(',');
  const script = `$rows = @(); foreach ($processId in @(${ids})) { $item = Get-CimInstance Win32_Process -Filter (\"ProcessId = $processId\") -ErrorAction SilentlyContinue; if ($null -ne $item) { $rows += [pscustomobject]@{ ProcessId=[int]$item.ProcessId; ParentProcessId=[int]$item.ParentProcessId; Name=$item.Name; CommandLine=$item.CommandLine } } }; ConvertTo-Json -InputObject $rows -Compress`;
  return new Promise((resolveRows, rejectRows) => {
    const powershell = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    powershell.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    powershell.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    powershell.once('error', rejectRows);
    powershell.once('exit', code => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) {
        rejectRows(new Error(`PowerShell Win32_Process query failed: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(output || '[]');
        resolveRows(Array.isArray(parsed) ? parsed as Win32ProcessRow[] : [parsed as Win32ProcessRow]);
      } catch {
        rejectRows(new Error(`PowerShell returned invalid Win32_Process JSON: ${output}`));
      }
    });
  });
}

async function waitForProcessesToExit(pids: number[], timeoutMs: number): Promise<Win32ProcessRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: Win32ProcessRow[] = [];
  while (Date.now() < deadline) {
    rows = await queryWin32Processes(pids);
    if (rows.length === 0) return rows;
    await delay(500);
  }
  return await queryWin32Processes(pids);
}

async function waitForProcessesToExist(pids: number[], timeoutMs: number): Promise<Win32ProcessRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: Win32ProcessRow[] = [];
  while (Date.now() < deadline) {
    rows = await queryWin32Processes(pids);
    if (rows.length === pids.length) return rows;
    await delay(250);
  }
  return await queryWin32Processes(pids);
}

async function terminateKnownProcessTree(rows: Win32ProcessRow[], hostPid: number, hostEntry: string): Promise<void> {
  const host = rows.find(item => item.ProcessId === hostPid);
  if (host?.CommandLine?.includes(HOST_ENTRY) && host.CommandLine.includes(hostEntry)) process.kill(hostPid);
  const descendant = rows.find(item => item.ParentProcessId === hostPid && item.CommandLine?.includes('-e "setInterval(() => {}, 1000)"'));
  if (descendant !== undefined) process.kill(descendant.ProcessId);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await withTimeout(new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))), timeoutMs, 'test-owned helper process did not exit');
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: value => resolvePromise(value) };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function caseReport(name: string): Record<string, unknown> {
  const item: Record<string, unknown> = { name, startedAt: new Date().toISOString() };
  (evidence.cases as Record<string, unknown>[]).push(item);
  return item;
}
