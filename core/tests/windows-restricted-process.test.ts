import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAppContainerProfile, runAppContainerCommand } from '../dist/capability/windows-appcontainer-process.js';
import { createOwnedProcessJob } from '../dist/capability/win32-job.js';
import { spawnWindowsCommand } from '../dist/capability/windows-command.js';
import { withoutAutoInheritanceMarker } from './helpers/windows-acl.ts';

test('a WRITE_RESTRICTED process writes the workspace and refuses a sibling path', {
  skip: process.platform !== 'win32',
  timeout: 165_000,
}, async () => {
  const testRoot = resolve('testplace');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'restricted-process-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const temp = join(root, 'temp');
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(temp)]);
  const outsideFile = join(outside, 'canary.txt');
  await writeFile(outsideFile, 'outside-baseline');
  const gitExecutable = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/u)[0];
  assert.ok(gitExecutable, 'Git for Windows must be installed for the sandbox compatibility check');
  const jobUrl = pathToFileURL(resolve('dist/capability/win32-job.js')).href;
  const aclUrl = pathToFileURL(resolve('dist/capability/windows-appcontainer-acl.js')).href;
  const runnerUrl = pathToFileURL(resolve('dist/capability/windows-restricted-process.js')).href;
  const childSource = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createOwnedProcessJob } from ${JSON.stringify(jobUrl)};
    import { grantRestrictedDirectoryWrite, revokeRestrictedDirectoryWrite } from ${JSON.stringify(aclUrl)};
    import { randomWorkspaceRestrictedSid, runRestrictedWindowsCommand } from ${JSON.stringify(runnerUrl)};
    const [workspace, outside, temp, gitExecutable] = process.argv.slice(1);
    const sid = randomWorkspaceRestrictedSid();
    const job = await createOwnedProcessJob({ assignCurrentProcess: false });
    let workspaceGrant = false;
    let tempGrant = false;
    const run = (executable, argv) => runRestrictedWindowsCommand({ executable, argv, cwd: workspace, writeSid: sid, job });
    try {
      await grantRestrictedDirectoryWrite(workspace, sid);
      workspaceGrant = true;
      await grantRestrictedDirectoryWrite(temp, sid);
      tempGrant = true;
      const executable = join(process.env.SystemRoot, 'System32', 'cmd.exe');
      const cmdExitCode = await run(executable, ['/d', '/q', '/c', 'echo workspace-write> created.txt & echo escaped> ..\\outside\\canary.txt']);
      const powershellExitCode = await run(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-Command', "Set-Content -LiteralPath 'powershell.txt' -Value 'powershell-write'",
      ]);
      const nodeExitCode = await run(process.execPath, ['-e', "require('node:fs').writeFileSync('node.txt','node-write')"]);
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      process.env.GIT_CONFIG_GLOBAL = join(temp, 'empty-git-config');
      process.env.GIT_TERMINAL_PROMPT = '0';
      const gitInitExitCode = await run(gitExecutable, ['init']);
      const safeDirectory = workspace.replaceAll('\\\\', '/');
      const gitAddExitCode = await run(gitExecutable, [
        '-c', 'safe.directory=' + safeDirectory,
        '-c', 'user.name=Ligule Test', '-c', 'user.email=ligule-test@example.invalid',
        'add', 'created.txt', 'powershell.txt', 'node.txt',
      ]);
      const report = {
        cmdExitCode,
        powershellExitCode,
        nodeExitCode,
        gitInitExitCode,
        gitAddExitCode,
        workspaceFile: readFileSync(join(workspace, 'created.txt'), 'utf8').trim(),
        powershellFile: readFileSync(join(workspace, 'powershell.txt'), 'utf8').trim(),
        nodeFile: readFileSync(join(workspace, 'node.txt'), 'utf8').trim(),
        outsideFile: readFileSync(join(outside, 'canary.txt'), 'utf8').trim(),
      };
      await new Promise((resolvePromise) => process.stdout.write(JSON.stringify(report) + '\\n', resolvePromise));
    } finally {
      if (tempGrant) await revokeRestrictedDirectoryWrite(temp, sid);
      if (workspaceGrant) await revokeRestrictedDirectoryWrite(workspace, sid);
      job.close();
    }
  `;
  const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && new Set(['COMSPEC', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR', 'LIGULE_HOME']).has(name.toUpperCase())));
  safeEnvironment.TEMP = temp;
  safeEnvironment.TMP = temp;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, workspace, outside, temp, gitExecutable], {
    cwd: resolve('.'),
    env: safeEnvironment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill(), 150_000);
  try {
    const [exitCode, signal] = await once(child, 'close');
    assert.equal(signal, null, stderr);
    assert.equal(exitCode, 0, `stdout=${stdout}\nstderr=${stderr}`);
    const report = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)!);
    assert.equal(report.cmdExitCode, 0, JSON.stringify(report));
    assert.equal(report.powershellExitCode, 0, JSON.stringify(report));
    assert.equal(report.nodeExitCode, 0, JSON.stringify(report));
    assert.equal(report.gitInitExitCode, 0, JSON.stringify(report));
    assert.equal(report.gitAddExitCode, 0, `${JSON.stringify(report)}\nstderr=${stderr}`);
    assert.equal(report.workspaceFile, 'workspace-write');
    assert.equal(report.powershellFile, 'powershell-write');
    assert.equal(report.nodeFile, 'node-write');
    assert.equal(report.outsideFile, 'outside-baseline');
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
});

test('the Guardian grants workspace and private-temp writes, then blocks a sibling write', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-guardian-restricted-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const temp = join(root, 'temp');
  const home = join(root, 'ligule-home');
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(temp), mkdir(home)]);
  const outsideCanary = join(outside, 'canary.txt');
  await writeFile(outsideCanary, 'outside-baseline');
  const workspaceAclBefore = execFileSync('icacls.exe', [workspace], { encoding: 'utf8' });
  const tempAclBefore = execFileSync('icacls.exe', [temp], { encoding: 'utf8' });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && new Set(['APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
      'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR']).has(name.toUpperCase())));
  environment.LIGULE_HOME = home;
  environment.TEMP = temp;
  environment.TMP = temp;
  const command = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
  const owned = spawnWindowsCommand(command, [
    '/d', '/q', '/c', 'echo %TEMP% & echo workspace-write> workspace.txt & echo private-temp> %TEMP%\\private.txt & echo escaped> ..\\outside\\escaped.txt',
  ], workspace, environment, { kind: 'restricted-token', workspaceRoot: workspace, tempDirectory: temp, aclLockRoot: home });
  let stdout = '';
  let stderr = '';
  owned.child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  owned.child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try {
    const exitCode = await owned.completion;
    assert.ok(Number.isInteger(exitCode), stderr);
    assert.equal(await readFile(join(workspace, 'workspace.txt'), 'utf8').then((text) => text.trim()), 'workspace-write', stdout + stderr);
    const privateTemp = await readFile(join(temp, 'private.txt'), 'utf8').then((text) => text.trim(), () => undefined);
    assert.equal(privateTemp, 'private-temp', `exit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    assert.equal(await readFile(outsideCanary, 'utf8'), 'outside-baseline');
    await assert.rejects(readFile(join(outside, 'escaped.txt')));
    assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [workspace], { encoding: 'utf8' })), withoutAutoInheritanceMarker(workspaceAclBefore));
    assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [temp], { encoding: 'utf8' })), withoutAutoInheritanceMarker(tempAclBefore));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent Guardians serialize workspace ACL changes across private user profiles', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-guardian-acl-lock-'));
  const workspace = join(root, 'workspace');
  const lockRoot = join(root, 'ligule-home');
  const runCount = 8;
  const tempDirectories = Array.from({ length: runCount }, (_, index) => join(root, `temp-${index}`));
  const profiles = tempDirectories.map((directory) => join(directory, 'profile'));
  await Promise.all([mkdir(workspace), mkdir(lockRoot), ...tempDirectories.map((directory) => mkdir(directory)), ...profiles.map((profile) => mkdir(profile))]);
  const workspaceAclBefore = execFileSync('icacls.exe', [workspace], { encoding: 'utf8' });
  const tempAclsBefore = tempDirectories.map((directory) => execFileSync('icacls.exe', [directory], { encoding: 'utf8' }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && new Set(['COMSPEC', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR']).has(name.toUpperCase())));
  const owned = tempDirectories.map((tempDirectory, index) => {
    const profile = profiles[index];
    const environment = {
      ...inherited,
      HOME: profile,
      USERPROFILE: profile,
      TEMP: tempDirectory,
      TMP: tempDirectory,
    };
    return spawnWindowsCommand(process.execPath, ['-e', `require('node:fs').writeFileSync('concurrent-${index}.txt','ok')`],
      workspace, environment, { kind: 'restricted-token', workspaceRoot: workspace, tempDirectory, aclLockRoot: lockRoot });
  });
  try {
    assert.deepEqual(await Promise.all(owned.map((item) => item.completion)), Array(runCount).fill(0));
    for (let index = 0; index < runCount; index += 1) {
      assert.equal(await readFile(join(workspace, `concurrent-${index}.txt`), 'utf8'), 'ok');
      assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [tempDirectories[index]], { encoding: 'utf8' })),
        withoutAutoInheritanceMarker(tempAclsBefore[index] ?? ''));
    }
    assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [workspace], { encoding: 'utf8' })),
      withoutAutoInheritanceMarker(workspaceAclBefore));
    await access(join(lockRoot, 'locks', 'windows-acl'));
    for (const profile of profiles) await assert.rejects(access(join(profile, '.ligule', 'locks', 'windows-acl')));
  } finally {
    for (const item of owned) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.cancel();
    }
    await Promise.all(owned.map((item) => item.completion.catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
  }
});

test('the Guardian still permits known hard-link and FILE_DELETE_CHILD boundary escapes', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-guardian-known-escapes-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const temp = join(root, 'temp');
  const home = join(root, 'ligule-home');
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(temp), mkdir(home)]);
  const hardlinkTarget = join(outside, 'hardlink-target.txt');
  const deleteTarget = join(outside, 'delete-target.txt');
  await Promise.all([writeFile(hardlinkTarget, 'outside-baseline'), writeFile(deleteTarget, 'delete-baseline')]);
  await link(hardlinkTarget, join(workspace, 'hardlink-alias.txt'));
  const outsideAclBefore = execFileSync('icacls.exe', [outside], { encoding: 'utf8' });
  const workspaceAclBefore = execFileSync('icacls.exe', [workspace], { encoding: 'utf8' });
  execFileSync('icacls.exe', [outside, '/grant', '*S-1-1-0:(OI)(CI)(M,DC)'], { windowsHide: true });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && new Set(['COMSPEC', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR']).has(name.toUpperCase())));
  environment.LIGULE_HOME = home;
  environment.TEMP = temp;
  environment.TMP = temp;
  const command = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
  try {
    const write = spawnWindowsCommand(process.execPath, ['-e', "require('fs').writeFileSync('hardlink-alias.txt','outside-modified')"],
      workspace, environment, { kind: 'restricted-token', workspaceRoot: workspace, tempDirectory: temp, aclLockRoot: home });
    assert.equal(await write.completion, 0);
    assert.equal(await readFile(hardlinkTarget, 'utf8'), 'outside-modified');

    const remove = spawnWindowsCommand(command, ['/d', '/q', '/c', 'del ..\\outside\\delete-target.txt'],
      workspace, environment, { kind: 'restricted-token', workspaceRoot: workspace, tempDirectory: temp, aclLockRoot: home });
    assert.equal(await remove.completion, 0);
    await assert.rejects(readFile(deleteTarget));
  } finally {
    try {
      execFileSync('icacls.exe', [root, '/reset', '/T', '/C', '/Q'], { windowsHide: true, stdio: 'ignore' });
      assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [outside], { encoding: 'utf8' })), withoutAutoInheritanceMarker(outsideAclBefore));
      assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [workspace], { encoding: 'utf8' })), withoutAutoInheritanceMarker(workspaceAclBefore));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a force-killed Guardian leaves a SID-only ACE that a same-user Low AppContainer cannot use', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-guardian-residue-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const temp = join(root, 'temp');
  const home = join(root, 'ligule-home');
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(temp), mkdir(home)]);
  const canary = join(workspace, 'canary.txt');
  await writeFile(canary, 'medium-baseline');
  const workspaceAclBefore = execFileSync('icacls.exe', [workspace], { encoding: 'utf8' });
  const tempAclBefore = execFileSync('icacls.exe', [temp], { encoding: 'utf8' });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && new Set(['APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
      'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR']).has(name.toUpperCase())));
  environment.LIGULE_HOME = home;
  environment.TEMP = temp;
  environment.TMP = temp;
  const command = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
  const tryLowIntegrityWrite = async () => {
    const profile = await createAppContainerProfile();
    const job = await createOwnedProcessJob({ assignCurrentProcess: false });
    try {
      return await runAppContainerCommand({
        executable: command,
        argv: ['/d', '/q', '/c', 'echo low-write> canary.txt'],
        cwd: workspace,
        identity: profile,
        environment,
        assignToJob: (processHandle) => job.assign(processHandle),
      });
    } finally {
      await profile.dispose();
      job.close();
    }
  };
  let guardian: ReturnType<typeof spawnWindowsCommand> | undefined;
  try {
    await tryLowIntegrityWrite();
    assert.equal(await readFile(canary, 'utf8'), 'medium-baseline');

    const source = "require('fs').writeFileSync('started.txt','yes');setTimeout(()=>require('fs').writeFileSync('late.txt','late'),2000);setTimeout(()=>{},20000);";
    guardian = spawnWindowsCommand(process.execPath, ['-e', source], workspace, environment, {
      kind: 'restricted-token', workspaceRoot: workspace, tempDirectory: temp, aclLockRoot: home,
    });
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('restricted Guardian did not grant its ACLs')), 5_000);
      guardian!.child.once('message', (message) => {
        if (typeof message !== 'object' || message === null || !('kind' in message) || message.kind !== 'ready') return;
        clearTimeout(timer);
        resolveReady();
      });
    });
    await ready;
    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline && await readFile(join(workspace, 'started.txt'), 'utf8').then(() => false, () => true)) {
      await delay(20);
    }
    assert.equal(await readFile(join(workspace, 'started.txt'), 'utf8').catch(() => undefined), 'yes');

    assert.equal(guardian.child.kill(), true);
    await assert.rejects(guardian.completion);
    await delay(2_200);
    await assert.rejects(readFile(join(workspace, 'late.txt')));

    const residueAcl = execFileSync('icacls.exe', [workspace], { encoding: 'utf8' });
    assert.notEqual(residueAcl, workspaceAclBefore);
    const sid = /S-1-4-\d+-\d+/u.exec(residueAcl)?.[0];
    assert.ok(sid, `the remaining grant should name only the per-run restricting SID\n${residueAcl}`);
    assert.doesNotMatch(residueAcl, /Mandatory Label\\Low Mandatory Level/iu);
    await tryLowIntegrityWrite();
    assert.equal(await readFile(canary, 'utf8'), 'medium-baseline');
    t.diagnostic(`force-kill residue SID ${sid} did not let the same-user Low AppContainer overwrite the Medium canary`);
  } finally {
    if (guardian !== undefined && guardian.child.exitCode === null && guardian.child.signalCode === null) guardian.child.kill();
    if (guardian !== undefined) await guardian.completion.catch(() => {});
    try {
      execFileSync('icacls.exe', [root, '/reset', '/T', '/C', '/Q'], { windowsHide: true, stdio: 'ignore' });
      assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [workspace], { encoding: 'utf8' })), withoutAutoInheritanceMarker(workspaceAclBefore));
      assert.equal(withoutAutoInheritanceMarker(execFileSync('icacls.exe', [temp], { encoding: 'utf8' })), withoutAutoInheritanceMarker(tempAclBefore));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
