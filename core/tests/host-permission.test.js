import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { createInteractivePermissionContext } from '../dist/capability/permission-capabilities.js';
import { resolveShell } from '../dist/capability/shell.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';
import { withoutAutoInheritanceMarker } from './helpers/windows-acl.js';

const fullPermission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});
const permissionWithOwnedProcesses = createPermissionContext('read-only', 'policy', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'full',
});
const windowsPartialPermission = createPermissionContext('read-only', 'policy', {
  filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
}, {
  profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
  limitations: ['Windows workspace-write has partial isolation.'],
  partialWorkspaceWriteConfirmationRequired: true,
});

test('a Host without trusted permission controls cannot change a session profile', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(
      client.request('permission.set', {
        sessionId, permissionProfile: 'full-access', confirmFullAccess: true,
      }),
      { code: 'permission_control_unavailable' },
    );
    assert.equal((await client.request('status.get', { sessionId })).permission.profile, 'read-only');
  });
});

test('only a trusted UI can change workspace trust and the current session sees the result', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    assert.equal((await client.request('status.get', { sessionId })).permission.workspaceTrusted, false);
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    assert.equal((await client.request('status.get', { sessionId })).permission.workspaceTrusted, true);
  }, { permissionControl: true });

  await withTuiHost(async ({ client, projectDirectory }) => {
    await assert.rejects(client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    }), { code: 'workspace_trust_control_unavailable' });
  });
});

test('a loaded in-process extension prevents an immediate permission downgrade', async () => {
  const extensionPath = fileURLToPath(new URL('./fixtures/noop-extension.mjs', import.meta.url));
  await withTuiHost(async ({ client, sessionId }) => {
    const status = await client.request('status.get', { sessionId });
    assert.equal(status.permission.profile, 'full-access');
    assert.equal(status.permission.network, 'unrestricted');
    assert.equal(status.permission.changeAllowed, false);
    assert.equal(status.permission.changeReason, 'permission_extension_restart_required');
    await assert.rejects(
      client.request('permission.set', { sessionId, permissionProfile: 'read-only' }),
      { code: 'permission_extension_restart_required' },
    );
    assert.equal((await client.request('status.get', { sessionId })).permission.profile, 'full-access');
  }, {
    permissionControl: true,
    permission: fullPermission,
    extensions: { paths: [extensionPath], ignored: [] },
  });
});

test('trusted permission changes require separate confirmations and survive reopening', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    const initial = await client.request('status.get', { sessionId });
    assert.equal(initial.permission.profile, 'read-only');
    assert.equal(initial.permission.network, 'policy');
    assert.equal(initial.permission.changeAllowed, true);

    await assert.rejects(
      client.request('permission.set', { sessionId, permissionProfile: 'full-access' }),
      { code: 'permission_full_access_confirmation_required' },
    );
    await assert.rejects(
      client.request('permission.set', {
        sessionId, permissionProfile: 'read-only', permissionNetwork: 'unrestricted',
      }),
      { code: 'permission_network_confirmation_required' },
    );

    const [changed, policy] = await Promise.all([
      client.request('permission.set', {
        sessionId, permissionProfile: 'full-access', confirmFullAccess: true,
      }),
      client.request('policy.set', { sessionId, mode: 'auto' }),
    ]);
    assert.equal(changed.permission.profile, 'full-access');
    assert.equal(policy.policy, 'auto');
    const profileStatus = await client.request('status.get', { sessionId });
    assert.equal(profileStatus.permission.profile, 'full-access');
    assert.equal(profileStatus.permission.network, 'policy');
    assert.equal(profileStatus.permission.execution.available, false);
    assert.equal(profileStatus.policy, 'auto');

    await assert.rejects(
      client.request('permission.set', {
        sessionId, permissionProfile: 'full-access', permissionNetwork: 'unrestricted',
      }),
      { code: 'permission_network_confirmation_required' },
    );
    const unrestricted = await client.request('permission.set', {
      sessionId,
      permissionProfile: 'full-access',
      permissionNetwork: 'unrestricted',
      confirmNetwork: true,
    });
    assert.equal(unrestricted.permission.network, 'unrestricted');
    assert.equal(unrestricted.permission.execution.available, true);

    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const reopened = await client.request('status.get', { sessionId });
    assert.equal(reopened.permission.profile, 'full-access');
    assert.equal(reopened.permission.network, 'unrestricted');
    const records = await client.request('session.read', { sessionId });
    const changes = records.events.filter((event) => event.kind === 'sessionPermission');
    assert.equal(changes[0].source, 'host-default');
    assert.equal(changes.at(-1).source, 'trusted-ui');
    assert.equal(changes.at(-1).confirmedNetwork, true);
    assert.equal(changes.some((event) => event.profile === 'full-access' && event.confirmedFullAccess === true), true);
  }, { permissionControl: true, permission: permissionWithOwnedProcesses });
});

test('new sessions accept elevated permission only from a confirmed trusted UI request', async () => {
  await withTuiHost(async ({ client }) => {
    await assert.rejects(
      client.request('session.create', {
        initialPermissionProfile: 'full-access', initialPermissionNetwork: 'unrestricted',
        confirmInitialFullAccess: true, confirmInitialNetwork: true,
      }),
      { code: 'permission_control_unavailable' },
    );
  });

  await withTuiHost(async ({ client }) => {
    const request = {
      initialMode: 'minimal', initialPolicy: 'auto',
      initialPermissionProfile: 'full-access', initialPermissionNetwork: 'unrestricted',
      confirmInitialFullAccess: true,
    };
    await assert.rejects(client.request('session.create', request), { code: 'permission_network_confirmation_required' });

    const created = await client.request('session.create', { ...request, confirmInitialNetwork: true });
    const status = await client.request('status.get', { sessionId: created.sessionId });
    assert.equal(status.permission.profile, 'full-access');
    assert.equal(status.permission.network, 'unrestricted');
    assert.equal(status.mode, 'minimal');
    assert.equal(status.policy, 'auto');
    const records = await client.request('session.read', { sessionId: created.sessionId });
    const permission = records.events.find((event) => event.kind === 'sessionPermission');
    assert.equal(permission.source, 'trusted-ui');
    assert.equal(permission.confirmedFullAccess, true);
    assert.equal(permission.confirmedNetwork, true);
    await client.request('session.close', { sessionId: created.sessionId });

    const workspaceWrite = await client.request('session.create', {
      initialPermissionProfile: 'workspace-write', initialPermissionNetwork: 'policy',
      confirmInitialFullAccess: true, confirmInitialNetwork: true,
    });
    const workspaceRecords = await client.request('session.read', { sessionId: workspaceWrite.sessionId });
    const workspacePermission = workspaceRecords.events.find((event) => event.kind === 'sessionPermission');
    assert.equal(workspacePermission.source, 'trusted-ui');
    assert.equal(workspacePermission.profile, 'workspace-write');
    assert.equal(workspacePermission.confirmedFullAccess, false);
    assert.equal(workspacePermission.confirmedNetwork, false);
    await client.request('session.close', { sessionId: workspaceWrite.sessionId });
  }, { permissionControl: true, permission: permissionWithOwnedProcesses });
});

test('partial Windows workspace-write requires trust confirmation and preserves it across reopening', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(client.request('permission.set', {
      sessionId, permissionProfile: 'workspace-write',
    }), { code: 'permission_partial_sandbox_confirmation_required' });

    const changed = await client.request('permission.set', {
      sessionId, permissionProfile: 'workspace-write', confirmPartialWorkspaceWrite: true,
    });
    assert.equal(changed.permission.profile, 'workspace-write');
    assert.equal(changed.permission.partialWorkspaceWriteConfirmed, true);
    assert.deepEqual(changed.permission.profiles, { readOnly: 'partial', workspaceWrite: 'partial' });
    assert.match(changed.permission.limitations.join('\n'), /partial isolation/u);

    const records = await client.request('session.read', { sessionId });
    const latest = records.events.filter((event) => event.kind === 'sessionPermission').at(-1);
    assert.equal(latest.confirmedPartialWorkspaceWrite, true);

    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const reopened = await client.request('status.get', { sessionId });
    assert.equal(reopened.permission.partialWorkspaceWriteConfirmed, true);
    assert.equal(reopened.permission.execution.available, false);
  }, { permissionControl: true, permission: windowsPartialPermission });

  await withTuiHost(async ({ client }) => {
    await assert.rejects(client.request('session.create', {
      initialPermissionProfile: 'workspace-write', initialPermissionNetwork: 'policy',
    }), { code: 'permission_partial_sandbox_confirmation_required' });

    const created = await client.request('session.create', {
      initialPermissionProfile: 'workspace-write', initialPermissionNetwork: 'policy',
      confirmInitialPartialWorkspaceWrite: true,
    });
    const status = await client.request('status.get', { sessionId: created.sessionId });
    assert.equal(status.permission.partialWorkspaceWriteConfirmed, true);
    await client.request('session.close', { sessionId: created.sessionId });
  }, { permissionControl: true, permission: windowsPartialPermission });
});

test('an unconfirmed Windows partial profile refuses exec before Policy approval or process launch', async () => {
  const unconfirmed = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, {
    profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
    limitations: ['Windows workspace-write has partial isolation.'],
    partialWorkspaceWriteConfirmationRequired: true,
  });
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const approvals = [];
    client.onRequest((message) => {
      if (message.method === 'approval.request') {
        approvals.push(message.params);
        return { decision: 'allow' };
      }
      return undefined;
    });
    const marker = join(projectDirectory, 'must-not-run.txt');
    const command = `node -e "require('fs').writeFileSync('must-not-run.txt','ran')"`;
    const status = await client.request('status.get', { sessionId });
    assert.equal(status.tools.includes('exec'), false);
    const response = await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command } }) });
    assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);
    assert.deepEqual(approvals, []);
    assert.equal(typeof response.text, 'string');
    const calls = (await client.request('session.read', { sessionId })).events
      .filter((event) => event.kind === 'tool' && event.tool === 'exec');
    assert.equal(calls.length, 0);
  }, { permission: unconfirmed });
});

test('Windows read-only Host execution follows the measured AppContainer workspace capability', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot);
  const previousPath = process.env.PATH;
  process.env.PATH = [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), dirname(process.execPath), join(systemRoot, 'System32')].join(';');
  try {
    const shell = resolveShell({ exec: { shell: 'powershell' } });
    assert.equal(shell.executable.toLowerCase(), join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase());
    await withTuiHost(async ({ client, sessionId, directory, projectDirectory }) => {
    const status = await client.request('status.get', { sessionId });
    if (status.permission.profiles.readOnly === 'unavailable') {
      assert.equal(status.permission.execution.available, false);
      assert.equal(status.tools.includes('exec'), false);
      const approvals = [];
      client.onRequest((message) => {
        if (message.method === 'approval.request') approvals.push(message.params);
        return undefined;
      });
      const response = await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'exec', args: { command: 'Get-Location' } }),
      });
      assert.equal(typeof response.text, 'string');
      assert.deepEqual(approvals, []);
      const calls = (await client.request('session.read', { sessionId })).events
        .filter((event) => event.kind === 'tool' && event.tool === 'exec');
      assert.equal(calls.length, 0);
      return;
    }
    assert.equal(status.permission.profiles.readOnly, 'partial');
    const workspaceFile = join(projectDirectory, 'readonly-canary.txt');
    const outsideFile = join(directory, 'readonly-outside.txt');
    await writeFile(workspaceFile, 'workspace-baseline');
    const aclBefore = execFileSync('icacls.exe', [projectDirectory], { encoding: 'utf8' });
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const approvals = [];
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals.push(message.params);
      return { decision: 'allow' };
    });
    const source = [
      "$ErrorActionPreference='Stop'",
      "$result=@{cwd=(Get-Location).Path;read='';overwriteDenied=$false;createDenied=$false;outsideCreateDenied=$false}",
      "try{$result.read=Get-Content -Raw -LiteralPath 'readonly-canary.txt'}catch{$result.readError=$_.Exception.Message}",
      "try{Set-Content -LiteralPath 'readonly-canary.txt' -Value 'blocked'}catch{$result.overwriteDenied=$true}",
      "try{Set-Content -LiteralPath 'readonly-new.txt' -Value 'blocked'}catch{$result.createDenied=$true}",
      "try{Set-Content -LiteralPath '..\\readonly-outside.txt' -Value 'blocked'}catch{$result.outsideCreateDenied=$true}",
      "$tempFile=Join-Path $env:TEMP 'ligule-host-readonly-temp.txt';Set-Content -LiteralPath $tempFile -Value 'private-temp'",
      "$result.tempRoundTrip=((Get-Content -Raw -LiteralPath $tempFile).Trim() -eq 'private-temp');$result.tempDirectory=$env:TEMP;$result.tempFile=$tempFile",
      "$result | ConvertTo-Json -Compress",
    ].join(';');
    const response = await client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'exec', args: { command: source } }),
    });
    const events = (await client.request('session.read', { sessionId })).events;
    const execCall = events.filter((event) => event.kind === 'tool' && event.tool === 'exec').at(-1);
    const result = execCall?.result;
    assert.equal(typeof result?.content?.text, 'string', JSON.stringify({ response, execCall }));
    let output;
    try { output = JSON.parse(result.content.text.trim()); }
    catch { assert.fail(JSON.stringify({ response, execCall, text: result.content.text })); }

    assert.notEqual(result.failed, true, JSON.stringify({ response, result, approvals }));
    assert.equal(result.content.exitCode, 0, JSON.stringify(result));
    assert.equal(approvals.length, 1);
    assert.equal(output.cwd.toLowerCase(), projectDirectory.toLowerCase());
    assert.equal(output.read, 'workspace-baseline', JSON.stringify(output));
    assert.equal(output.overwriteDenied, true);
    assert.equal(output.createDenied, true);
    assert.equal(output.outsideCreateDenied, true);
    assert.equal(output.tempRoundTrip, true);
    assert.match(output.tempDirectory, /\\Packages\\Ligule-[^\\]+\\AC\\Temp$/iu);
    assert.equal(await readFile(workspaceFile, 'utf8'), 'workspace-baseline');
    assert.equal(existsSync(join(projectDirectory, 'readonly-new.txt')), false);
    assert.equal(existsSync(outsideFile), false);
    assert.equal(existsSync(output.tempFile), false, 'the AppContainer profile temp directory is removed after the command exits');
    assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [projectDirectory], { encoding: 'utf8' })),
      withoutAutoInheritanceMarker(aclBefore));
    }, {
      permission: ({ projectDirectory }) => createInteractivePermissionContext({
        shellConfig: { exec: { shell: 'powershell' } }, workspaceRoot: projectDirectory,
      }),
      interactive: true, permissionControl: true, config: { exec: { shell: 'powershell' } },
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('confirmed Windows workspace-write executes through the Host and restricted Guardian', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  const permission = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, {
    profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
    limitations: ['Windows workspace-write has partial isolation.'],
    partialWorkspaceWriteConfirmationRequired: true,
    partialWorkspaceWriteConfirmed: true,
  });
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const approvals = [];
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals.push(message.params);
      return { decision: 'allow' };
    });
    const command = `node -e "require('fs').writeFileSync('guardian-host-result.txt','live-write')"`;
    const response = await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command } }) });
    const events = (await client.request('session.read', { sessionId })).events;
    const result = events.filter((event) => event.kind === 'tool' && event.tool === 'exec').at(-1);
    const output = await readFile(join(projectDirectory, 'guardian-host-result.txt'), 'utf8').catch(() => undefined);
    assert.equal(output, 'live-write', JSON.stringify({ response, result, approvals }));
    assert.equal(approvals.length, 1);
    assert.notEqual(result.result.failed, true);
    assert.deepEqual(result.result.content, { text: '', exitCode: 0 });

    const runExec = async (command) => {
      await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command } }) });
      const toolResult = (await client.request('session.read', { sessionId })).events
        .filter((event) => event.kind === 'tool' && event.tool === 'exec').at(-1).result;
      assert.notEqual(toolResult.failed, true, JSON.stringify(toolResult));
      assert.equal(toolResult.content.exitCode, 0, JSON.stringify(toolResult));
      return toolResult.content.text;
    };
    await runExec("Set-Content -LiteralPath 'powershell-result.txt' -Value 'powershell-write'");
    assert.equal(await readFile(join(projectDirectory, 'powershell-result.txt'), 'utf8'), 'powershell-write' + '\r\n');
    await runExec('git init -q');
    await runExec('git add powershell-result.txt');
    assert.match(await runExec('git ls-files --error-unmatch powershell-result.txt'), /powershell-result\.txt/u);
    assert.equal(approvals.length, 5);
  }, { permission, interactive: true, permissionControl: true });
});

test('trusted Windows project commands can install without scripts, build, and run a cancellable dev server', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, async () => {
  const permission = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, {
    profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
    limitations: ['Windows workspace-write has partial isolation.'],
    partialWorkspaceWriteConfirmationRequired: true,
    partialWorkspaceWriteConfirmed: true,
  });
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const packageManifest = {
      name: 'ligule-windows-project-tools',
      version: '1.0.0',
      packageManager: 'pnpm@12.9.1',
      scripts: {
        preinstall: `node -e "require('node:fs').writeFileSync('install-script-ran','yes')"`,
        build: 'node build.cjs',
        dev: 'node server.cjs',
      },
    };
    await writeFile(join(projectDirectory, 'package.json'), JSON.stringify(packageManifest));
    await writeFile(join(projectDirectory, 'build.cjs'), "require('node:fs').writeFileSync('build-output.txt', 'build-ok');\n");
    await writeFile(join(projectDirectory, 'server.cjs'), [
      "const fs=require('node:fs');",
      "const http=require('node:http');",
      "const server=http.createServer((_request,response)=>response.end('ligule-dev-server-ok'));",
      "server.listen(0,'127.0.0.1',()=>fs.writeFileSync('server-state.json',JSON.stringify({pid:process.pid,port:server.address().port})));",
    ].join('\n'));
    const aclBefore = execFileSync('icacls.exe', [projectDirectory], { encoding: 'utf8' });
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const approvals = [];
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals.push(message.params);
      return { decision: 'allow' };
    });
    const runExec = async (command) => {
      const accepted = await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command } }) });
      await client.request('run.wait', { sessionId, runId: accepted.runId, origin: 'human' });
      const toolResult = (await client.request('session.read', { sessionId })).events
        .filter((event) => event.kind === 'tool' && event.tool === 'exec').at(-1).result;
      assert.notEqual(toolResult.failed, true, JSON.stringify({ command, toolResult, approvals }));
      assert.equal(toolResult.content.exitCode, 0, JSON.stringify({ command, toolResult, approvals }));
      return toolResult.content.text;
    };

    const executionPaths = JSON.parse((await runExec('node -p "JSON.stringify({cwd:process.cwd(),temp:process.env.TEMP,home:process.env.HOME,profile:process.env.USERPROFILE,corepack:process.env.COREPACK_HOME,local:process.env.LOCALAPPDATA,roaming:process.env.APPDATA})"')).trim());
    assert.equal(await realpath(executionPaths.cwd), await realpath(projectDirectory));
    assert.equal(executionPaths.home, join(executionPaths.temp, 'profile'));
    assert.equal(executionPaths.profile, join(executionPaths.temp, 'profile'));
    assert.equal(executionPaths.corepack, join(executionPaths.temp, 'corepack'));
    assert.equal(executionPaths.local, join(executionPaths.profile, 'AppData', 'Local'));
    assert.equal(executionPaths.roaming, join(executionPaths.profile, 'AppData', 'Roaming'));
    await runExec('pnpm install --ignore-scripts');
    assert.equal(existsSync(join(projectDirectory, 'install-script-ran')), false, 'the package preinstall hook must not run when scripts are disabled');
    await runExec('pnpm run build');
    assert.equal(await readFile(join(projectDirectory, 'build-output.txt'), 'utf8'), 'build-ok');

    const devRun = client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command: 'pnpm run dev' } }) });
    const devOutcome = devRun.then(() => undefined, (error) => error);
    const serverStatePath = join(projectDirectory, 'server-state.json');
    await waitFor(() => existsSync(serverStatePath), { within: 60_000, every: 25 });
    const serverState = JSON.parse(await readFile(serverStatePath, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${serverState.port}`);
    assert.equal(await response.text(), 'ligule-dev-server-ok');
    assert.deepEqual(await client.request('run.cancel', { sessionId }), { cancelled: true });
    assert.equal((await devOutcome)?.code, 'loop_cancelled');
    assert.ok(Number.isSafeInteger(serverState.pid) && serverState.pid > 0);
    const deadline = Date.now() + 3_000;
    let serverRunning = true;
    while (Date.now() < deadline) {
      try { process.kill(serverState.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') { serverRunning = false; break; }
        throw error;
      }
      await delay(25);
    }
    assert.equal(serverRunning, false, `dev server process ${serverState.pid} remained alive after cancellation`);
    assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [projectDirectory], { encoding: 'utf8' })),
      withoutAutoInheritanceMarker(aclBefore));
    assert.ok(approvals.length >= 4, 'each trusted project command still requires per-call approval');
  }, { permission, interactive: true, permissionControl: true, testDirectory: tmpdir() });
});

test('cancelling a Windows workspace-write Host command kills descendants and restores its workspace ACL', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  const permission = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, {
    profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
    limitations: ['Windows workspace-write has partial isolation.'],
    partialWorkspaceWriteConfirmationRequired: true,
    partialWorkspaceWriteConfirmed: true,
  });
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const aclBefore = execFileSync('icacls.exe', [projectDirectory], { encoding: 'utf8' });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const source = "const fs=require('fs');const cp=require('child_process');const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'});fs.writeFileSync('started.txt',String(child.pid));child.unref();setTimeout(()=>{},20000);";
    const command = `node -e "${source}"`;
    const running = client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command } }) });
    await waitFor(() => existsSync(join(projectDirectory, 'started.txt')), { within: 5_000, every: 25 });
    const cancelled = await client.request('run.cancel', { sessionId });
    assert.deepEqual(cancelled, { cancelled: true });
    await assert.rejects(running, { code: 'loop_cancelled' });
    const pid = Number(await readFile(join(projectDirectory, 'started.txt'), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const deadline = Date.now() + 3_000;
    let childRunning = true;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') { childRunning = false; break; }
        throw error;
      }
      await delay(25);
    }
    assert.equal(childRunning, false, `detached Job descendant ${pid} remained alive after cancellation`);
    assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [projectDirectory], { encoding: 'utf8' })),
      withoutAutoInheritanceMarker(aclBefore));
  }, { permission, interactive: true, permissionControl: true });
});

test('permission events record only confirmations required by the change', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await client.request('permission.set', {
      sessionId, permissionProfile: 'workspace-write', confirmFullAccess: true, confirmNetwork: true,
    });
    const records = await client.request('session.read', { sessionId });
    const permission = records.events.filter((event) => event.kind === 'sessionPermission').at(-1);
    assert.equal(permission.profile, 'workspace-write');
    assert.equal(permission.confirmedFullAccess, false);
    assert.equal(permission.confirmedNetwork, false);
  }, { permissionControl: true, permission: permissionWithOwnedProcesses });
});

test('changing permission preserves the session policy override across reopening', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await client.request('policy.set', { sessionId, mode: 'ask' });
    const before = await client.request('status.get', { sessionId });
    assert.equal(before.policy, 'ask');
    assert.deepEqual(before.denials, { consecutive: 0, total: 0 });
    await client.request('permission.set', { sessionId, permissionProfile: 'workspace-write' });
    const after = await client.request('status.get', { sessionId });
    assert.equal(after.policy, 'ask');
    assert.deepEqual(after.denials, before.denials);
    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const reopened = await client.request('status.get', { sessionId });
    assert.equal(reopened.policy, 'ask');
    assert.deepEqual(reopened.denials, before.denials);
  }, {
    permissionControl: true,
    config: { policy: { mode: 'auto' } },
  });
});

test('forced ask and denial counters survive a session reopen', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'deny' } : undefined);
    await client.request('policy.set', { sessionId, mode: 'ask' });
    await writeFile(join(projectDirectory, 'notes.md'), 'contents');
    for (let index = 0; index < 3; index += 1) {
      const accepted = await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'read', args: { path: 'notes.md' } }),
      });
      await client.request('run.wait', { sessionId, runId: accepted.runId, origin: 'human' });
    }
    await client.request('policy.set', { sessionId, mode: 'auto' });
    const before = await client.request('status.get', { sessionId });
    assert.equal(before.policy, 'ask');
    assert.equal(before.denials.total, 3);
    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const after = await client.request('status.get', { sessionId });
    assert.equal(after.policy, 'ask');
    assert.deepEqual(after.denials, before.denials);
  }, {
    permissionControl: true,
    permission: createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    }),
    config: { policy: { mode: 'ask' } },
  });
});

test('legacy sessions reject permission changes before appending an unsupported event', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    await client.request('session.close', { sessionId });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    const before = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    const header = { ...before[0], formatVersion: 1 };
    const legacyEvents = before.slice(1).filter((event) => event.kind !== 'sessionPermission');
    const legacy = `${[header, ...legacyEvents].map((event) => JSON.stringify(event)).join('\n')}\n`;
    await writeFile(path, legacy);
    await client.request('session.open', { sessionId });
    const openedBytes = await readFile(path, 'utf8');
    const openedEvents = (await client.request('session.read', { sessionId })).events.length;
    await assert.rejects(client.request('permission.set', { sessionId, permissionProfile: 'workspace-write' }), {
      code: 'session_permission_format_unsupported',
    });
    await assert.rejects(client.request('policy.set', { sessionId, mode: 'ask' }), {
      code: 'session_policy_format_unsupported',
    });
    assert.equal(await readFile(path, 'utf8'), openedBytes);
    const record = await client.request('session.read', { sessionId });
    assert.equal(record.events.length, legacyEvents.length);
  }, { permissionControl: true });
});

test('headerless v0 sessions reject permission and policy changes without changing their record', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    await client.request('session.close', { sessionId });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    const legacy = '{"seq":0,"kind":"user","text":"legacy input"}\n';
    await writeFile(path, legacy);
    await client.request('session.open', { sessionId });
    const openedBytes = await readFile(path, 'utf8');
    const openedEvents = (await client.request('session.read', { sessionId })).events.length;
    await assert.rejects(client.request('permission.set', { sessionId, permissionProfile: 'workspace-write' }), {
      code: 'session_permission_format_unsupported',
    });
    await assert.rejects(client.request('policy.set', { sessionId, mode: 'ask' }), {
      code: 'session_policy_format_unsupported',
    });
    assert.equal(await readFile(path, 'utf8'), openedBytes);
    assert.equal((await client.request('session.read', { sessionId })).events.length, openedEvents);
  }, { permissionControl: true });
});

test('Host approval requests expose the script binding to connected requesters', async () => {
  const permission = createPermissionContext('full-access', 'unrestricted', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const approvals = [];
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const marker = join(projectDirectory, 'marker.txt');
    const script = join(projectDirectory, 'approved.js');
    const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`;
    await writeFile(script, source);
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals.push(message.params);
      return { decision: 'allow' };
    });
    const command = `node "${script.replaceAll('\\', '/')}"`;
    const accepted = await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command } }) });
    await client.request('run.wait', { sessionId, runId: accepted.runId, origin: 'human' });
    assert.equal(await readFile(marker, 'utf8'), 'ran');
    assert.equal(approvals.length, 1);
    const binding = approvals[0].scriptBinding;
    assert.ok(binding);
    assert.equal(binding.path, await realpath(script));
    assert.equal(binding.sha256, createHash('sha256').update(source).digest('hex'));
    assert.match(binding.interpreter, /node(?:\.exe)?$/iu);
    assert.equal(binding.workspaceRoot, await realpath(projectDirectory));
    assert.deepEqual(binding.permission, { profile: 'full-access', network: 'unrestricted', workspaceTrusted: true, capabilities: permission.capabilities });
  }, { permission, permissionControl: true });
});
