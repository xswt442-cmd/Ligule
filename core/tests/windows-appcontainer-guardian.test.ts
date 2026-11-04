import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnWindowsCommand } from '../dist/capability/windows-command.js';
import test from 'node:test';

test('Guardian AppContainer requires LOCALAPPDATA and cleans its private temp directory', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async (t) => {
  const testDirectory = resolve('testplace');
  await mkdir(testDirectory, { recursive: true });
  const root = await mkdtemp(join(testDirectory, 'appcontainer-guardian-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot);
  const command = join(systemRoot, 'System32', 'cmd.exe');
  const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMDRIVE',
    'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ]).has(name.toUpperCase())));
  const minimalEnvironment = {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const canonicalPathEnvironment = {
    SystemRoot: process.env.SystemRoot,
    Path: process.env.Path,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const cases = [
    { name: 'safe', environment: safeEnvironment },
    { name: 'minimal', environment: minimalEnvironment },
    { name: 'minimal-canonical-path', environment: canonicalPathEnvironment },
    { name: 'minimal-plus-LOCALAPPDATA', environment: { ...minimalEnvironment, LOCALAPPDATA: process.env.LOCALAPPDATA } },
  ];
  const acl = (path: string) => execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
  const baselineAcl = acl(workspace);
  const outcomes: Array<{ name: string; exitCode?: number; errorCode?: string; detail?: string; stdout?: string; stderr?: string }> = [];

  try {
    for (const scenario of cases) {
      const commandText = `echo GUARDIAN_APPCONTAINER_${scenario.name} & exit /b 23`;
      const owned = spawnWindowsCommand(command, ['/d', '/q', '/c', commandText], workspace, scenario.environment, {
        kind: 'appcontainer', workspaceRoot: workspace,
      });
      let stdout = '';
      let stderr = '';
      owned.child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      owned.child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      try {
        outcomes.push({ name: scenario.name, exitCode: await owned.completion, stdout: stdout.trim(), stderr: stderr.trim() });
      } catch (error: unknown) {
        const failure = error as { code?: string; detail?: string };
        outcomes.push({ name: scenario.name, errorCode: failure.code, detail: failure.detail, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    }

    const tempSource = [
      "const fs=require('node:fs');const path=require('node:path');",
      "const directory=process.env.TEMP||'';const file=path.join(directory,'ligule-temp-canary.txt');",
      "fs.writeFileSync(file,'private-temp');",
      "process.stdout.write(JSON.stringify({directory,roundTrip:fs.readFileSync(file,'utf8')==='private-temp',file}));",
    ].join(';');
    const tempCommand = spawnWindowsCommand(process.execPath, ['-e', tempSource], workspace, safeEnvironment, {
      kind: 'appcontainer', workspaceRoot: workspace,
    });
    let tempStdout = '';
    let tempStderr = '';
    tempCommand.child.stdout?.setEncoding('utf8').on('data', (chunk) => { tempStdout += chunk; });
    tempCommand.child.stderr?.setEncoding('utf8').on('data', (chunk) => { tempStderr += chunk; });
    const tempExitCode = await tempCommand.completion;
    const tempResult = JSON.parse(tempStdout.trim());

    t.diagnostic(JSON.stringify({ outcomes, tempResult, tempExitCode, tempStderr: tempStderr.trim() }));
    const safe = outcomes.find(({ name }) => name === 'safe');
    assert.equal(safe?.exitCode, 23, JSON.stringify(outcomes));
    assert.match(safe?.stdout ?? '', /GUARDIAN_APPCONTAINER_safe/u);
    const minimal = outcomes.find(({ name }) => name === 'minimal');
    assert.equal(minimal?.errorCode, 'exec_spawn_failed', JSON.stringify(outcomes));
    assert.match(minimal?.detail ?? '', /CreateProcessW failed with Win32 error 203/u);
    const withLocalAppData = outcomes.find(({ name }) => name === 'minimal-plus-LOCALAPPDATA');
    assert.equal(withLocalAppData?.exitCode, 23, JSON.stringify(outcomes));
    assert.match(withLocalAppData?.stdout ?? '', /GUARDIAN_APPCONTAINER_minimal-plus-LOCALAPPDATA/u);
    assert.equal(tempExitCode, 0, tempStderr);
    assert.match(tempResult.directory, /\\Packages\\Ligule-[^\\]+\\AC\\Temp$/iu);
    assert.equal(tempResult.roundTrip, true);
    assert.equal(await access(tempResult.file).then(() => true, () => false), false,
      'the profile-scoped temp directory must disappear after Guardian releases the AppContainer profile');

    const cancelSource = [
      "const fs=require('node:fs');const path=require('node:path');",
      "const file=path.join(process.env.TEMP,'ligule-cancel-temp-canary.txt');fs.writeFileSync(file,'private-temp');",
      "process.stdout.write('APPCONTAINER_STARTED:'+file+'\\n');setTimeout(()=>{},20000);",
    ].join('');
    const running = spawnWindowsCommand(process.execPath, ['-e', cancelSource], workspace, safeEnvironment, {
      kind: 'appcontainer', workspaceRoot: workspace,
    });
    let runningOutput = '';
    let runningError = '';
    running.child.stdout?.setEncoding('utf8').on('data', (chunk) => { runningOutput += chunk; });
    running.child.stderr?.setEncoding('utf8').on('data', (chunk) => { runningError += chunk; });
    let tempAfterCancel;
    try {
      const startupDeadline = Date.now() + 5_000;
      while (!runningOutput.includes('APPCONTAINER_STARTED:') && Date.now() < startupDeadline) {
        if (running.child.exitCode !== null) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      assert.match(runningOutput, /APPCONTAINER_STARTED:/u, runningError);
      tempAfterCancel = /APPCONTAINER_STARTED:([^\r\n]+)/u.exec(runningOutput)?.[1];
      assert.ok(tempAfterCancel);
      running.cancel();
      await assert.rejects(running.completion, { code: 'exec_cancelled' });
      assert.equal(await access(tempAfterCancel).then(() => true, () => false), false,
        'cancellation must release the AppContainer profile and remove its private temp directory');
    } finally {
      if (running.child.exitCode === null && running.child.signalCode === null) {
        running.cancel();
        await running.completion.catch(() => {});
      }
    }
    assert.equal(acl(workspace), baselineAcl, 'workspace ACL must return to baseline after every launch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
