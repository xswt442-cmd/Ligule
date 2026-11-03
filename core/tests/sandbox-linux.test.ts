import test, { after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinuxSandbox } from '../dist/capability/sandbox-linux.js';
import type { LinuxSandboxRequest, LinuxSandboxResult } from '../dist/capability/sandbox-linux.js';

type SandboxFixture = { root: string; workspace: string; privateTempDir: string };
type AvailableSandbox = Extract<LinuxSandboxResult, { available: true }>;

const linux = process.platform === 'linux';
const testDirectory = fileURLToPath(new URL('../../testplace/tmp/', import.meta.url));
const temporaryDirectories = new Set<string>();

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function fixture(t: TestContext): SandboxFixture | undefined {
  if (!linux) return undefined;
  mkdirSync(testDirectory, { recursive: true });
  const root = mkdtempSync(join(testDirectory, 'sandbox-linux-'));
  temporaryDirectories.add(root);
  const privateTempDir = mkdtempSync(join(tmpdir(), 'ligule-sandbox-private-'));
  chmodSync(privateTempDir, 0o700);
  temporaryDirectories.add(privateTempDir);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    temporaryDirectories.delete(root);
    rmSync(privateTempDir, { recursive: true, force: true });
    temporaryDirectories.delete(privateTempDir);
  });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return { root, workspace, privateTempDir };
}

function request(paths: SandboxFixture, overrides: Partial<LinuxSandboxRequest> = {}): LinuxSandboxRequest {
  return {
    profile: 'workspace-write',
    network: 'disabled',
    workspaceRoot: paths.workspace,
    cwd: paths.workspace,
    privateTempDir: paths.privateTempDir,
    executable: '/bin/sh',
    argv: ['-c', 'echo sandbox-ready'],
    environment: { TERM: 'dumb' },
    ...overrides,
  };
}

function run(result: LinuxSandboxResult) {
  assert.equal(result.available, true, result.available ? '' : result.reason);
  const sandbox = result as AvailableSandbox;
  const child = spawnSync(sandbox.executable, sandbox.argv, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(child.error, undefined, child.error?.message);
  return child;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

test('the actual WSL bubblewrap command limits writable paths and clears inherited credentials', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  const result = await buildLinuxSandbox(request(paths, {
    argv: ['-c', 'touch /run/ligule/workspace/workspace-file; touch /run/ligule/tmp/temp-file; test -z "$(ls -A /home)"; test -z "$(ls -A /root)"; test -z "$(ls -A /mnt)"; test -z "$(ls -A /dev/shm)"; test ! -e /mnt/c/Windows; if touch /run/other 2>/dev/null; then exit 45; fi; if touch /etc/ligule-probe 2>/dev/null; then exit 46; fi; if env | cut -d= -f1 | grep -Eq "(_KEY|_TOKEN|_SECRET|CREDENTIAL)"; then exit 47; fi; echo isolated'],
  }));
  if (!result.available) return t.skip(result.reason);

  assert.equal(result.capabilities.filesystemRead, 'partial');
  assert.equal(result.capabilities.filesystemWrite, 'partial');
  assert.equal(result.capabilities.network, 'full');
  assert.equal(result.capabilities.process, 'full');
  assert.match(result.cwd, /^\/run\/ligule\/workspace(?:\/|$)/);
  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /isolated/);
  assert.equal(lstatSync(join(paths.workspace, 'workspace-file')).isFile(), true);
  assert.equal(lstatSync(join(paths.privateTempDir, 'temp-file')).isFile(), true);
});

test('read-only profile blocks workspace writes but keeps its private temporary directory writable', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  const result = await buildLinuxSandbox(request(paths, {
    profile: 'read-only',
    argv: ['-c', 'if touch /run/ligule/workspace/denied 2>/dev/null; then exit 31; fi; touch /run/ligule/tmp/allowed; echo read-only'],
  }));
  if (!result.available) return t.skip(result.reason);
  assert.equal(result.capabilities.filesystemWrite, 'full');
  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(lstatSync(join(paths.workspace, 'denied'), { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(join(paths.privateTempDir, 'allowed')).isFile(), true);
});

test('the selected Node runtime stays usable through a read-only mount while Home remains hidden', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  assert.ok(Number.isInteger(nodeMajor) && nodeMajor >= 24, 'the Linux sandbox acceptance requires Node 24 or newer');
  const nodeExecutable = realpathSync(process.execPath);
  const binDirectory = dirname(nodeExecutable);
  const sourceRoot = dirname(binDirectory);
  if (basename(binDirectory) !== 'bin') return t.skip('the active Node runtime is not installed in a Node distribution bin directory');
  const hiddenSource = ['/home', '/root', '/mnt', '/media', '/tmp', '/var/tmp', '/var/lib', '/var/log', '/sys', '/dev/shm']
    .some((directory) => sourceRoot === directory || sourceRoot.startsWith(`${directory}/`));
  const identity = statSync(nodeExecutable, { bigint: true });
  const nodeRuntime = {
    executable: nodeExecutable,
    identity: {
      dev: identity.dev.toString(), ino: identity.ino.toString(), size: identity.size.toString(),
      mtimeNs: identity.mtimeNs.toString(), ctimeNs: identity.ctimeNs.toString(),
    },
  };
  writeFileSync(join(paths.workspace, 'node-probe.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./node-version', import.meta.url), process.version); console.log(process.version);\n");
  const command = [
    `'${nodeExecutable}' /run/ligule/workspace/node-probe.mjs`,
    'node -v',
    'npm --version',
    'if test -x /run/ligule/node-runtime/bin/corepack; then corepack --version; fi',
    'echo ordinary-shell-ready',
    ...(hiddenSource ? [`test ! -e '${sourceRoot}'`] : []),
    'test -z "$(ls -A /home)"',
    "test \"$PATH\" = '/run/ligule/node-runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
    "awk '$5 == \"/run/ligule/node-runtime/bin/node\" && $6 ~ /(^|,)ro(,|$)/ { found=1 } END { exit !found }' /proc/self/mountinfo",
    "awk '$5 == \"/run/ligule/node-runtime/lib/node_modules/npm\" && $6 ~ /(^|,)ro(,|$)/ { found=1 } END { exit !found }' /proc/self/mountinfo",
    'test ! -e /run/ligule/node-runtime/lib/node_modules/pnpm',
    'if touch /run/ligule/node-runtime/bin/node 2>/dev/null; then exit 49; fi',
    'echo runtime-isolated',
  ].join('; ');
  const result = await buildLinuxSandbox(request(paths, {
    nodeRuntime: { ...nodeRuntime, rewriteExecutable: true },
    argv: ['-c', command],
  }));
  if (!result.available) return t.skip(result.reason);
  assert.ok(result.argv.includes('/run/ligule/node-runtime/bin/node'), 'the bound absolute interpreter is rewritten to the fixed mount');
  const launchArguments = result.argv.slice(result.argv.indexOf('--') + 1);
  assert.ok(!launchArguments.some((argument) => argument.includes(nodeExecutable)), 'the hidden host path is absent from the command');
  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, new RegExp(process.version.replaceAll('.', '\\.'), 'u'));
  assert.match(child.stdout, /ordinary-shell-ready/u);
  assert.match(child.stdout, /runtime-isolated/u);
  assert.equal(lstatSync(join(paths.workspace, 'node-version')).isFile(), true);
  assert.equal(readFileSync(join(paths.workspace, 'node-version'), 'utf8'), process.version);
});

test('workspace links cannot use hidden host paths and existing hard links fail closed', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  const outside = join(paths.root, 'outside-secret');
  writeFileSync(outside, 'must stay outside the sandbox workspace');
  symlinkSync(outside, join(paths.workspace, 'outside-link'));
  const symbolic = await buildLinuxSandbox(request(paths, {
    argv: ['-c', 'if cat /run/ligule/workspace/outside-link >/dev/null 2>&1; then exit 32; fi; echo link-contained'],
  }));
  if (!symbolic.available) return t.skip(symbolic.reason);
  const child = run(symbolic);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /link-contained/);

  const hardlink = join(paths.workspace, 'outside-hardlink');
  try {
    linkSync(outside, hardlink);
  } catch (error) {
    const failure = error as { code?: string; message: string };
    return t.skip(`this filesystem cannot create the hard-link fixture: ${failure.code ?? failure.message}`);
  }
  assert.equal(lstatSync(outside).nlink, 2, 'the fixture must be a real hard link before checking the sandbox');
  const refused = await buildLinuxSandbox(request(paths)) as Extract<LinuxSandboxResult, { available: false }>;
  assert.equal(refused.available, false);
  assert.equal(refused.code, 'sandbox_unavailable');
  assert.match(refused.reason, /multiply-linked file/);
});

test('the PID namespace hides host processes while allowing child processes', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  const hostProcess = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => hostProcess.kill('SIGKILL'));
  await once(hostProcess, 'spawn');
  const result = await buildLinuxSandbox(request(paths, {
    argv: ['-c', `test ! -e /proc/${hostProcess.pid}; sleep 0.05 & wait; echo process-isolated`],
  }));
  if (!result.available) return t.skip(result.reason);
  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /process-isolated/);
});

test('network stays isolated by default and is shared only when explicitly requested', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  const server = createServer((socket) => socket.end('connected'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const script = 'import socket,sys\ns=socket.socket()\ns.settimeout(0.7)\ntry:\n s.connect(("127.0.0.1",int(sys.argv[1])))\n print("connected")\nexcept OSError:\n print("blocked")\n';

  const closed = await buildLinuxSandbox(request(paths, { executable: '/usr/bin/python3', argv: ['-c', script, String(address.port)] }));
  if (!closed.available) return t.skip(closed.reason);
  const closedRun = run(closed);
  assert.equal(closedRun.status, 0, closedRun.stderr);
  assert.match(closedRun.stdout, /blocked/);

  const shared = await buildLinuxSandbox(request(paths, {
    network: 'unrestricted',
    executable: '/usr/bin/python3',
    argv: ['-c', script, String(address.port)],
  }));
  if (!shared.available) return t.skip(shared.reason);
  const sharedRun = run(shared);
  assert.equal(sharedRun.status, 0, sharedRun.stderr);
  assert.match(sharedRun.stdout, /connected/);
});

test('network isolation also applies to subprocesses started inside the sandbox', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  const server = createServer((socket) => socket.end('connected'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  assert.notEqual(address, null);
  const childScript = [
    'import socket,sys',
    'sock=socket.socket()',
    'sock.settimeout(0.7)',
    'try:',
    ' sock.connect(("127.0.0.1",int(sys.argv[1])))',
    ' print("connected")',
    'except OSError:',
    ' print("blocked")',
  ].join('\n');
  const parentScript = [
    'import subprocess,sys',
    `child=${JSON.stringify(childScript)}`,
    'result=subprocess.run([sys.executable,"-c",child,sys.argv[1]],capture_output=True,text=True,timeout=3)',
    'print(result.stdout.strip())',
  ].join('\n');
  const result = await buildLinuxSandbox(request(paths, {
    executable: '/usr/bin/python3',
    argv: ['-c', parentScript, String(address.port)],
  }));
  if (!result.available) return t.skip(result.reason);

  const child = run(result);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /blocked/u, 'the child process must inherit the restricted network namespace');
});

test('invalid workspace boundaries and unapproved environment variables are rejected', { skip: !linux }, async (t) => {
  const paths = fixture(t)!;
  await assert.rejects(
    () => buildLinuxSandbox(request(paths, { cwd: resolve(paths.workspace, '..') })),
    (error) => hasCode(error, 'sandbox_request_invalid'),
  );
  await assert.rejects(
    () => buildLinuxSandbox(request(paths, { environment: { ANTHROPIC_API_KEY: 'must-not-enter' } })),
    (error) => hasCode(error, 'sandbox_request_invalid'),
  );
  await assert.rejects(
    () => buildLinuxSandbox(request(paths, { privateTempDir: paths.workspace })),
    (error) => hasCode(error, 'sandbox_request_invalid'),
  );
});
