import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpRegistry, mcpServerConfigs } from '../dist/capability/mcp.js';

const serverEntry = fileURLToPath(new URL('./fixtures/mcp-owned-process.mjs', import.meta.url));
const posixProcessGroupsAvailable = process.platform !== 'win32' && typeof process.execve === 'function';

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') return false;
    if ((error as { code?: string }).code === 'EPERM') return true;
    throw error;
  }
}

async function waitForFile(path: string, within = 5_000) {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`fixture did not write ${path}`);
}

async function waitForExit(pid: number) {
  const deadline = Date.now() + 10_000;
  while (processExists(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(processExists(pid), false, `process ${pid} remained alive after MCP cleanup`);
}

test('Windows MCP revoke and registry close terminate owned stdio server trees', { skip: process.platform !== 'win32' }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-owned-process-'));
  const servers: Record<string, { command: string; args: string[]; cwd: string }> = {};
  const markers = new Map();
  for (const name of ['revoke', 'close']) {
    const rootPidPath = join(root, `${name}-root.pid`);
    const childPidPath = join(root, `${name}-child.pid`);
    markers.set(name, { rootPidPath, childPidPath });
    servers[name] = { command: process.execPath, args: [serverEntry, rootPidPath, childPidPath], cwd: root };
  }
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers } }, {}, root));
  try {
    await registry.toolsOf('revoke');
    const revokedRoot = await waitForFile(markers.get('revoke').rootPidPath);
    const revokedChild = await waitForFile(markers.get('revoke').childPidPath);
    assert.equal(processExists(revokedRoot), true);
    assert.equal(processExists(revokedChild), true);
    await registry.revoke('revoke');
    await Promise.all([waitForExit(revokedRoot), waitForExit(revokedChild)]);

    await registry.toolsOf('close');
    const closedRoot = await waitForFile(markers.get('close').rootPidPath);
    const closedChild = await waitForFile(markers.get('close').childPidPath);
    assert.equal(processExists(closedRoot), true);
    assert.equal(processExists(closedChild), true);
    await registry.close();
    await Promise.all([waitForExit(closedRoot), waitForExit(closedChild)]);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows MCP connection failure cleans the captured server process tree', { skip: process.platform !== 'win32' }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-owned-connect-failure-'));
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers: { broken: {
    command: process.execPath, args: [serverEntry, rootPidPath, childPidPath, 'true'], cwd: root,
  } } } }, {}, root));
  try {
    await assert.rejects(() => registry.toolsOf('broken'), (error) => (error as { code?: string }).code === 'mcp_connect_failed');
    const rootPid = await waitForFile(rootPidPath);
    const childPid = await waitForFile(childPidPath);
    await Promise.all([waitForExit(rootPid), waitForExit(childPid)]);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX MCP cancellation closes its owned server and child process group', { skip: !posixProcessGroupsAvailable, timeout: 60_000 }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-posix-cancel-'));
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers: { cancel: {
    command: process.execPath, args: [serverEntry, rootPidPath, childPidPath, 'false', 'hang-list'], cwd: root,
  } } } }, {}, root));
  const controller = new AbortController();
  let rootPid: number;
  let childPid: number;
  let openingFailure: { code?: string; detail?: string } | undefined;
  try {
    const opening = registry.toolsOf('cancel', controller.signal);
    void opening.catch(error => { openingFailure = error as { code?: string; detail?: string }; });
    try {
      [rootPid, childPid] = await Promise.all([
        waitForFile(rootPidPath, 40_000),
        waitForFile(childPidPath, 40_000),
      ]);
    } catch (error) {
      throw new Error(`${(error as Error).message}; opening failed=${openingFailure?.code ?? 'no'} ${openingFailure?.detail ?? ''}`, { cause: error });
    }
    assert.equal(processExists(rootPid), true);
    assert.equal(processExists(childPid), true);
    controller.abort(new Error('test cancellation'));
    await assert.rejects(opening);
    await Promise.all([waitForExit(rootPid), waitForExit(childPid)]);
  } finally {
    await registry.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX MCP connection failure cleans the server process group and its descendants', { skip: !posixProcessGroupsAvailable }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-posix-connect-failure-'));
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers: { broken: {
    command: process.execPath, args: [serverEntry, rootPidPath, childPidPath, 'true'], cwd: root,
  } } } }, {}, root));
  let rootPid;
  let childPid;
  try {
    await assert.rejects(registry.toolsOf('broken'), { code: 'mcp_connect_failed' });
    rootPid = await waitForFile(rootPidPath);
    childPid = await waitForFile(childPidPath);
    await Promise.all([waitForExit(rootPid), waitForExit(childPid)]);
  } finally {
    await registry.close().catch(() => undefined);
    if (childPid !== undefined && processExists(childPid)) process.kill(childPid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX MCP cleans descendants that retain stdio after natural server exit and repeated close is safe', { skip: !posixProcessGroupsAvailable }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-posix-natural-exit-'));
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers: { natural: {
    command: process.execPath, args: [serverEntry, rootPidPath, childPidPath, 'false', 'exit-after-list,ignore-term,inherit-stdio'], cwd: root,
  } } } }, {}, root));
  let rootPid;
  let childPid;
  try {
    await registry.toolsOf('natural');
    rootPid = await waitForFile(rootPidPath);
    childPid = await waitForFile(childPidPath);
    await waitForExit(rootPid);
    await waitForExit(childPid);
    await registry.close();
    await registry.close();
  } finally {
    await registry.close().catch(() => undefined);
    if (childPid !== undefined && processExists(childPid)) process.kill(childPid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX MCP does not signal a process group after the whole group exits naturally', { skip: !posixProcessGroupsAvailable }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-posix-empty-group-'));
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers: { empty: {
    command: process.execPath, args: [serverEntry, rootPidPath, childPidPath, 'false', 'exit-after-list,no-child'], cwd: root,
  } } } }, {}, root));
  const originalKill = process.kill;
  const groupSignals: { pid: number; signal: string | number }[] = [];
  process.kill = function (pid, signal) {
    if (typeof pid === 'number' && pid < 0 && signal !== undefined && signal !== 0) groupSignals.push({ pid, signal });
    return originalKill.call(process, pid, signal);
  };
  let rootPid;
  try {
    await registry.toolsOf('empty');
    rootPid = await waitForFile(rootPidPath);
    await waitForExit(rootPid);
    await registry.close();
    assert.deepEqual(groupSignals, [], 'an empty process group must not receive stale TERM/KILL signals');
  } finally {
    process.kill = originalKill;
    await registry.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX MCP reports failed group termination, retries it, and leaves unrelated groups alone', { skip: !posixProcessGroupsAvailable }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-posix-retry-'));
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers: { retry: {
    command: process.execPath, args: [serverEntry, rootPidPath, childPidPath, 'false', 'ignore-term'], cwd: root,
  } } } }, {}, root));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    unrelated.once('error', reject);
    unrelated.once('spawn', resolve);
  });
  const unrelatedPid = unrelated.pid as number;
  assert.notEqual(unrelatedPid, undefined);
  const originalKill = process.kill;
  let denyGroupSignals = false;
  process.kill = function (pid, signal) {
    if (denyGroupSignals && typeof pid === 'number' && pid < 0 && signal !== 0) {
      throw Object.assign(new Error('simulated process-group termination failure'), { code: 'EPERM' });
    }
    return originalKill.call(process, pid, signal);
  };
  let rootPid;
  let childPid;
  try {
    await registry.toolsOf('retry');
    rootPid = await waitForFile(rootPidPath);
    childPid = await waitForFile(childPidPath);
    denyGroupSignals = true;
    await assert.rejects(registry.close(), { code: 'mcp_process_cleanup_failed' });
    assert.equal(processExists(childPid), true, 'failed group termination leaves the descendant available for retry');
    assert.deepEqual(registry.activeServers(), ['retry'], 'failed cleanup remains owned and visible');
    denyGroupSignals = false;
    await registry.close();
    await registry.close();
    await Promise.all([waitForExit(rootPid), waitForExit(childPid)]);
    assert.equal(processExists(unrelatedPid), true, 'cleanup does not signal a separately owned process group');
  } finally {
    denyGroupSignals = false;
    process.kill = originalKill;
    await registry.close().catch(() => undefined);
    if (childPid !== undefined && processExists(childPid)) process.kill(childPid, 'SIGKILL');
    if (unrelatedPid !== undefined && processExists(unrelatedPid)) process.kill(-unrelatedPid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
