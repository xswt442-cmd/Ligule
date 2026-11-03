import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  grantAppContainerTempDirectoryWrite,
  grantRestrictedDirectoryWrite,
  revokeAppContainerTempDirectoryWrite,
  revokeRestrictedDirectoryWrite,
} from '../dist/capability/windows-appcontainer-acl.js';
import { createAppContainerProfile } from '../dist/capability/windows-appcontainer-process.js';

test('read-only AppContainer denies workspace writes and direct network access', {
  skip: process.platform !== 'win32',
}, async () => {
  const testDirectory = process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined
    ? resolve('testplace') : resolve(process.env.LIGULE_APPCONTAINER_TEST_ROOT);
  if (process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined) await mkdir(testDirectory, { recursive: true });
  const root = await mkdtemp(join(testDirectory, 'appcontainer-readonly-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  const script = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createServer } from 'node:net';
    import { join } from 'node:path';
    import { createOwnedProcessJob } from ${JSON.stringify(pathToFileURL(resolve('dist/capability/win32-job.js')).href)};
    import { createAppContainerProfile, runAppContainerCommand } from ${JSON.stringify(pathToFileURL(resolve('dist/capability/windows-appcontainer-process.js')).href)};

    const workspace = process.argv[1];
    const outside = process.argv[2];
    const systemRoot = process.env.SystemRoot;
    const cmd = systemRoot + '\\\\System32\\\\cmd.exe';
    const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => new Set([
      'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
    ]).has(name.toUpperCase())));
    const job = await createOwnedProcessJob();
    const profile = await createAppContainerProfile();
    const baselineFile = join(workspace, 'baseline.txt');
    const outsideFile = join(outside, 'outside.txt');
    writeFileSync(baselineFile, 'baseline');
    writeFileSync(outsideFile, 'outside-baseline');
    const baselineAcl = execFileSync('icacls.exe', [workspace], { encoding: 'utf8' });
    try {
      await runAppContainerCommand({
        executable: cmd,
        argv: ['/d', '/q', '/c', 'type baseline.txt & echo OVERWRITE> baseline.txt & echo NEW> new.txt & echo OUTSIDE> ..\\\\outside\\\\outside-new.txt'],
        cwd: workspace,
        identity: profile,
        environment: safeEnvironment,
      });
      assert.equal(readFileSync(baselineFile, 'utf8'), 'baseline');
      assert.equal(existsSync(join(workspace, 'new.txt')), false);
      assert.equal(readFileSync(outsideFile, 'utf8'), 'outside-baseline');
      assert.equal(existsSync(join(outside, 'outside-new.txt')), false);
      assert.equal(execFileSync('icacls.exe', [workspace], { encoding: 'utf8' }), baselineAcl);

      const server = createServer((socket) => socket.end('host-loopback-reached'));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const port = server.address().port;
        const networkProbe = [
          "const net=require('node:net');",
          "const socket=net.createConnection({host:'127.0.0.1',port:" + port + "});",
          "socket.once('connect',()=>{console.log('APPCONTAINER_NETWORK_CONNECTED');process.exit(2)});",
          "socket.once('error',()=>{console.log('APPCONTAINER_NETWORK_BLOCKED');process.exit(0)});",
          "setTimeout(()=>{console.log('APPCONTAINER_NETWORK_BLOCKED');process.exit(0)},1500).unref();",
        ].join('');
        const networkExit = await runAppContainerCommand({
          executable: process.execPath,
          argv: ['-e', networkProbe],
          cwd: workspace,
          identity: profile,
          environment: safeEnvironment,
        });
        assert.equal(networkExit, 0, 'the AppContainer command and its socket capability probe must exit cleanly');
        console.log('APPCONTAINER_READONLY_NETWORK_EXIT:' + networkExit);
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      writeFileSync(${JSON.stringify(join(root, 'result.json'))}, JSON.stringify({
        workspaceUnchanged: readFileSync(baselineFile, 'utf8') === 'baseline',
        workspaceCreateDenied: !existsSync(join(workspace, 'new.txt')),
        outsideUnchanged: readFileSync(outsideFile, 'utf8') === 'outside-baseline',
        outsideCreateDenied: !existsSync(join(outside, 'outside-new.txt')),
        workspaceAclUnchanged: execFileSync('icacls.exe', [workspace], { encoding: 'utf8' }) === baselineAcl,
      }));
    } finally {
      await profile.dispose();
      job.close();
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, workspace, outside], {
    cwd: resolve('.'),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, `stdout=${stdout}\nstderr=${stderr}`);
    assert.doesNotMatch(stdout, /^baseline$/mu, 'an AppContainer without an explicit workspace read ACE cannot read the existing file');
    assert.match(stdout, /APPCONTAINER_NETWORK_BLOCKED/u);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'result.json'), 'utf8')), {
      workspaceUnchanged: true,
      workspaceCreateDenied: true,
      outsideUnchanged: true,
      outsideCreateDenied: true,
      workspaceAclUnchanged: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a temporary restricted-token write ACE covers existing and new workspace files, then revokes cleanly', {
  skip: process.platform !== 'win32',
}, async () => {
  const testDirectory = process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined
    ? resolve('testplace') : resolve(process.env.LIGULE_APPCONTAINER_TEST_ROOT);
  if (process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined) await mkdir(testDirectory, { recursive: true });
  const root = await mkdtemp(join(testDirectory, 'restricted-write-acl-'));
  const workspace = join(root, 'workspace');
  const nested = join(workspace, 'nested');
  await mkdir(nested, { recursive: true });
  const existingFile = join(nested, 'existing.txt');
  const createdFile = join(nested, 'created.txt');
  await writeFile(existingFile, 'existing');
  const sidPart = () => randomInt(1, 2 ** 30);
  const sid = `S-1-4-${sidPart()}-${sidPart()}`;
  const acl = (path: string) => execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
  const before = new Map([workspace, nested, existingFile].map((path) => [path, acl(path)]));
  let grantAttempted = false;
  try {
    grantAttempted = true;
    await grantRestrictedDirectoryWrite(workspace, sid);
    for (const path of [workspace, nested, existingFile]) assert.equal(acl(path).includes(sid), true, `grant ACE is missing from ${path}`);
    await writeFile(createdFile, 'created');
    assert.equal(acl(createdFile).includes(sid), true, 'new files inherit the grant ACE');
    await revokeRestrictedDirectoryWrite(workspace, sid);
    grantAttempted = false;
    for (const [path, original] of before) assert.equal(acl(path), original, `ACL changed after revoking ${sid} from ${path}`);
    assert.equal(acl(createdFile).includes(sid), false, 'new file inherited grant was removed with the root grant');
  } finally {
    if (grantAttempted) await revokeRestrictedDirectoryWrite(workspace, sid).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('an unavailable AppContainer temp grant leaves the directory ACL unchanged', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  const testDirectory = process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined
    ? resolve('testplace') : resolve(process.env.LIGULE_APPCONTAINER_TEST_ROOT);
  if (process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined) await mkdir(testDirectory, { recursive: true });
  const root = await mkdtemp(join(testDirectory, 'appcontainer-temp-restore-'));
  const temp = join(root, 'temp');
  await mkdir(temp);
  const before = execFileSync('icacls.exe', [temp], { encoding: 'utf8' });
  const profile = await createAppContainerProfile();
  let granted = false;
  let grantError;
  try {
    try {
      await grantAppContainerTempDirectoryWrite(temp, profile.sid);
      granted = true;
    } catch (error) {
      grantError = error;
    }
    if (granted) await revokeAppContainerTempDirectoryWrite(temp, profile.sid);
    assert.equal(execFileSync('icacls.exe', [temp], { encoding: 'utf8' }), before,
      grantError instanceof Error ? grantError.message : 'temporary ACL state changed');
  } finally {
    await profile.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a scoped AppContainer read ACE grants workspace reads only and revokes without changing other ACEs', {
  skip: process.platform !== 'win32',
}, async () => {
  const testDirectory = process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined
    ? resolve('testplace') : resolve(process.env.LIGULE_APPCONTAINER_TEST_ROOT);
  if (process.env.LIGULE_APPCONTAINER_TEST_ROOT === undefined) await mkdir(testDirectory, { recursive: true });
  const root = await mkdtemp(join(testDirectory, 'appcontainer-read-ace-'));
  const workspace = join(root, 'workspace');
  const sibling = join(root, 'sibling');
  const changedWorkspace = join(root, 'changed-workspace');
  const resultPath = join(root, 'result.json');
  await Promise.all([mkdir(workspace), mkdir(sibling), mkdir(changedWorkspace)]);
  const moduleUrl = pathToFileURL(resolve('dist/capability/windows-appcontainer-process.js')).href;
  const aclUrl = pathToFileURL(resolve('dist/capability/windows-appcontainer-acl.js')).href;
  const jobUrl = pathToFileURL(resolve('dist/capability/win32-job.js')).href;
  const script = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createAppContainerProfile, runAppContainerCommand } from ${JSON.stringify(moduleUrl)};
    import { createAppContainerDirectoryReadGrant, grantAppContainerDirectoryRead, revokeAppContainerDirectoryRead } from ${JSON.stringify(aclUrl)};
    import { createOwnedProcessJob } from ${JSON.stringify(jobUrl)};

    const [workspace, sibling, changedWorkspace, resultPath] = process.argv.slice(1);
    const rootFile = workspace + '\\\\known.txt';
    const descendant = workspace + '\\\\nested';
    const descendantFile = descendant + '\\\\known-nested.txt';
    const siblingFile = sibling + '\\\\outside.txt';
    const siblingWrite = sibling + '\\\\new-outside.txt';
    const createdFile = workspace + '\\\\created.txt';
    const changedFile = changedWorkspace + '\\\\changed.txt';
    const rootText = 'APP_CONTAINER_READ_CANARY_ROOT';
    const nestedText = 'APP_CONTAINER_READ_CANARY_NESTED';
    const siblingText = 'APP_CONTAINER_READ_CANARY_SIBLING';
    const systemRoot = process.env.SystemRoot;
    const system32 = systemRoot + '\\\\System32';
    const cmd = system32 + '\\\\cmd.exe';
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => new Set([
      'APPDATA','COMSPEC','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','PATH','PATHEXT','SYSTEMDRIVE','SYSTEMROOT','TEMP','TMP','USERPROFILE','WINDIR'
    ]).has(name.toUpperCase())));
    const icacls = (path) => execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
    const run = (commandArgs, cwd = system32) => runAppContainerCommand({
      executable: cmd, argv: ['/d','/q','/c',...commandArgs], cwd, identity: profile, environment,
    });
    const koffi = (await import('koffi')).default;
    const advapi = koffi.load('advapi32.dll');
    const kernel = koffi.load('kernel32.dll');
    const PVOID = koffi.pointer('void');
    const convert = advapi.func('__stdcall','ConvertSidToStringSidW','int32_t',[PVOID,koffi.pointer(PVOID)]);
    const localFree = kernel.func('__stdcall','LocalFree',PVOID,[PVOID]);
    const profileSidText = (sid) => {
      const out = koffi.alloc(PVOID,1);
      let text;
      try {
        if (convert(sid,out) === 0) throw new Error('ConvertSidToStringSidW failed');
        text = koffi.decode(out,PVOID);
        let value = '';
        for (let offset=0;offset<512;offset+=2) {
          const unit = Number(koffi.decode(text,offset,'uint16_t'));
          if (unit === 0) break;
          value += String.fromCharCode(unit);
        }
        return value;
      } finally {
        if (text !== undefined && localFree(text) !== null) throw new Error('LocalFree(SID text) failed');
        koffi.free(out);
      }
    };
    const job = await createOwnedProcessJob();
    const profile = await createAppContainerProfile();
    const sidText = profileSidText(profile.sid);
    let workspaceGrant;
    let changedGrant;
    let result;
    try {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(descendant));
      writeFileSync(rootFile, rootText + '\\r\\n');
      writeFileSync(descendantFile, nestedText + '\\r\\n');
      writeFileSync(siblingFile, siblingText + '\\r\\n');
      writeFileSync(changedFile, 'ACE_CHANGE_TARGET');
      const baselineWorkspaceAcl = icacls(workspace);
      const baselineRootFileAcl = icacls(rootFile);
      const baselineDescendantAcl = icacls(descendant);
      const baselineDescendantFileAcl = icacls(descendantFile);
      const baselineChangedAcl = icacls(changedWorkspace);

      workspaceGrant = await createAppContainerDirectoryReadGrant(workspace);
      await grantAppContainerDirectoryRead(workspaceGrant, profile.sid);
      const workspaceAclWithGrant = icacls(workspace);
      assert.ok(workspaceAclWithGrant.includes(sidText) && workspaceAclWithGrant.includes('(OI)(CI)(RX)'));
      const rootReadExit = await run(['type', rootFile]);
      const nestedReadExit = await run(['type', descendantFile]);
      const createExit = await run(['echo CREATE_ATTEMPT>' + createdFile]);
      const overwriteExit = await run(['echo OVERWRITE_ATTEMPT>' + rootFile]);
      const deleteExit = await run(['del', '/f', '/q', rootFile]);
      const siblingReadExit = await run(['type', siblingFile, '>NUL']);
      const siblingWriteExit = await run(['echo SIBLING_WRITE>' + siblingWrite]);
      const workspaceReadSucceeded = rootReadExit === 0 && nestedReadExit === 0;
      const workspaceCreateDenied = !existsSync(createdFile);
      const workspaceOverwriteDenied = readFileSync(rootFile, 'utf8') === rootText + '\\r\\n';
      const workspaceDeleteDenied = existsSync(rootFile);
      const siblingReadDenied = siblingReadExit !== 0;
      const siblingWriteDenied = !existsSync(siblingWrite);

      await revokeAppContainerDirectoryRead(workspaceGrant, profile.sid);
      workspaceGrant = undefined;
      const workspaceDaclRestored = icacls(workspace) === baselineWorkspaceAcl;
      const rootFileDaclRestored = icacls(rootFile) === baselineRootFileAcl;
      const descendantDaclRestored = icacls(descendant) === baselineDescendantAcl;
      const descendantFileDaclRestored = icacls(descendantFile) === baselineDescendantFileAcl;
      execFileSync('icacls.exe', [workspace, '/grant', '*' + sidText + ':(OI)(CI)(R)'], { encoding: 'utf8', windowsHide: true });
      const icaclsRootReadExit = await run(['type', rootFile]);
      const icaclsRootFileAcl = icacls(rootFile);
      execFileSync('icacls.exe', [workspace, '/remove', '*' + sidText], { encoding: 'utf8', windowsHide: true });
      const icaclsRootDaclRestored = icacls(workspace) === baselineWorkspaceAcl;
      const icaclsFileDaclRestored = icacls(rootFile) === baselineRootFileAcl;

      changedGrant = await createAppContainerDirectoryReadGrant(changedWorkspace);
      await grantAppContainerDirectoryRead(changedGrant, profile.sid);
      execFileSync('icacls.exe', [changedWorkspace, '/grant', '*' + sidText + ':(OI)(CI)(M)'], { encoding: 'utf8', windowsHide: true });
      let changedAceRefused = false;
      try { await revokeAppContainerDirectoryRead(changedGrant, profile.sid); }
      catch { changedAceRefused = true; }
      const changedAclAfterRefusal = icacls(changedWorkspace);
      const changedAcePreserved = changedAclAfterRefusal.includes(sidText) && changedAclAfterRefusal.includes('(OI)(CI)(M)');
      execFileSync('icacls.exe', [changedWorkspace, '/remove', '*' + sidText], { encoding: 'utf8', windowsHide: true });
      changedGrant = undefined;
      const changedDaclRestored = icacls(changedWorkspace) === baselineChangedAcl;
      result = {
        targetSid: sidText,
        workspaceAclWithGrant,
        rootFileAclWithGrant: icacls(rootFile),
        icaclsRootReadExit,
        icaclsRootFileAcl,
        icaclsRootDaclRestored,
        icaclsFileDaclRestored,
        workspaceRootReadExitCode: rootReadExit,
        workspaceDescendantReadExitCode: nestedReadExit,
        workspaceReadSucceeded,
        workspaceCreateExitCode: createExit,
        workspaceCreateDenied,
        workspaceOverwriteExitCode: overwriteExit,
        workspaceOverwriteDenied,
        workspaceDeleteExitCode: deleteExit,
        workspaceDeleteDenied,
        siblingReadExitCode: siblingReadExit,
        siblingReadDenied,
        siblingWriteExitCode: siblingWriteExit,
        siblingWriteDenied,
        workspaceDaclRestored,
        rootFileDaclRestored,
        descendantDaclRestored,
        descendantFileDaclRestored,
        changedAceRefused,
        changedAcePreserved,
        changedDaclRestored,
      };
      assert.equal(workspaceReadSucceeded, true, JSON.stringify(result));
      assert.equal(workspaceCreateDenied, true, JSON.stringify(result));
      assert.equal(workspaceOverwriteDenied, true, JSON.stringify(result));
      assert.equal(workspaceDeleteDenied, true, JSON.stringify(result));
      assert.equal(siblingReadDenied, true, JSON.stringify(result));
      assert.equal(siblingWriteDenied, true, JSON.stringify(result));
      assert.equal(workspaceDaclRestored && rootFileDaclRestored && descendantDaclRestored && descendantFileDaclRestored, true, JSON.stringify(result));
      assert.equal(changedAceRefused && changedAcePreserved && changedDaclRestored, true, JSON.stringify(result));
    } finally {
      if (workspaceGrant !== undefined) {
        try { await revokeAppContainerDirectoryRead(workspaceGrant, profile.sid); }
        catch {
          execFileSync('icacls.exe', [workspace, '/remove', '*' + sidText], { encoding: 'utf8', windowsHide: true });
        }
      }
      if (changedGrant !== undefined) {
        execFileSync('icacls.exe', [changedWorkspace, '/remove', '*' + sidText], { encoding: 'utf8', windowsHide: true });
      }
      await profile.dispose();
      writeFileSync(resultPath, JSON.stringify(result));
      job.close();
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, workspace, sibling, changedWorkspace, resultPath], {
    cwd: resolve('.'),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, `stdout=${stdout}\nstderr=${stderr}`);
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.match(stdout, /APP_CONTAINER_READ_CANARY_ROOT/u);
    assert.match(stdout, /APP_CONTAINER_READ_CANARY_NESTED/u);
    assert.match(result.targetSid, /^S-1-15-2-/u);
    for (const key of [
      'workspaceReadSucceeded', 'workspaceCreateDenied', 'workspaceOverwriteDenied', 'workspaceDeleteDenied',
      'siblingReadDenied', 'siblingWriteDenied', 'workspaceDaclRestored', 'rootFileDaclRestored',
      'descendantDaclRestored', 'descendantFileDaclRestored', 'changedAceRefused', 'changedAcePreserved', 'changedDaclRestored',
    ]) assert.equal(result[key], true, JSON.stringify(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
