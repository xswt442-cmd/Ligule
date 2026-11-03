import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('AppContainer command inherits Guardian output and exits through the Job', { skip: process.platform !== 'win32' }, async (t) => {
  const moduleUrl = pathToFileURL(resolve('dist/capability/windows-appcontainer-process.js')).href;
  const script = `
    import koffi from 'koffi';
    import { createAppContainerProfile, deriveAppContainerSid, freeAppContainerSid, runAppContainerCommand } from ${JSON.stringify(moduleUrl)};
    const kernel = koffi.load('kernel32.dll');
    const advapi = koffi.load('advapi32.dll');
    const createJob = kernel.func('__stdcall', 'CreateJobObjectW', 'intptr', ['void*', 'str16']);
    const currentProcess = kernel.func('__stdcall', 'GetCurrentProcess', 'intptr', []);
    const assign = kernel.func('__stdcall', 'AssignProcessToJobObject', 'int', ['intptr', 'intptr']);
    const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32_t', []);
    const getStdHandle = kernel.func('__stdcall', 'GetStdHandle', 'intptr', ['int']);
    const getHandleInformation = kernel.func('__stdcall', 'GetHandleInformation', 'int', ['intptr', koffi.pointer('uint32_t')]);
    const equalSid = advapi.func('__stdcall', 'EqualSid', 'int', ['void*', 'void*']);
    const job = createJob(null, null);
    if (!job) throw new Error('CreateJobObjectW failed: ' + lastError());
    if (!assign(job, currentProcess())) { close(job); throw new Error('AssignProcessToJobObject failed: ' + lastError()); }
    const profile = await createAppContainerProfile();
    try {
      const stdoutHandle = getStdHandle(-11);
      const stdoutFlags = Buffer.alloc(4);
      if (!getHandleInformation(stdoutHandle, stdoutFlags)) throw new Error('GetHandleInformation(stdout) failed: ' + lastError());
      const originalStdoutFlags = stdoutFlags.readUInt32LE();
      const recoveredSid = await deriveAppContainerSid(profile.name);
      try {
        if (!equalSid(profile.sid, recoveredSid)) throw new Error('derived SID does not match the created profile SID');
      } finally {
        await freeAppContainerSid(recoveredSid);
      }
      const exitCode = await runAppContainerCommand({
        executable: process.env.SystemRoot + '\\\\System32\\\\cmd.exe',
        argv: ['/d', '/q', '/c', 'echo LIGULE APPCONTAINER OUTPUT'],
        cwd: process.env.SystemRoot + '\\\\System32',
        identity: profile,
        environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => new Set([
          'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMDRIVE',
          'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
        ]).has(name.toUpperCase()))),
      });
      if (!getHandleInformation(stdoutHandle, stdoutFlags)) throw new Error('GetHandleInformation(stdout after launch) failed: ' + lastError());
      if (stdoutFlags.readUInt32LE() !== originalStdoutFlags) throw new Error('launcher did not restore stdout handle flags');
      console.log('LIGULE_APPCONTAINER_EXIT:' + exitCode);
      const identityExit = await runAppContainerCommand({
        executable: process.env.SystemRoot + '\\\\System32\\\\whoami.exe',
        argv: ['/all'],
        cwd: process.env.SystemRoot + '\\\\System32',
        identity: profile,
        environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => new Set([
          'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMDRIVE',
          'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
        ]).has(name.toUpperCase()))),
      });
      console.log('LIGULE_APPCONTAINER_WHOAMI_EXIT:' + identityExit);
    } finally {
      await profile.dispose();
      close(job);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /LIGULE APPCONTAINER OUTPUT\r?\n/);
  assert.match(stdout, /LIGULE_APPCONTAINER_EXIT:0/);
  const integritySid = /S-1-16-\d+/u.exec(stdout)?.[0];
  assert.ok(integritySid, 'whoami must report the AppContainer process integrity SID');
  t.diagnostic(`AppContainer integrity SID: ${integritySid}`);
});
