import { randomUUID } from 'node:crypto';
import { KernelError } from '../errors.js';

type Koffi = typeof import('koffi')['default'];
export type NativeHandle = number | bigint;

const NULL = 0n;
const CREATE_SUSPENDED = 0x00000004;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const STARTF_USESTDHANDLES = 0x00000100;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
const HANDLE_FLAG_INHERIT = 0x00000001;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const STILL_ACTIVE = 259;

function isNull(handle: NativeHandle | null | undefined): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}

function nativeHandle(koffi: Koffi, value: unknown): NativeHandle {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'number' || typeof value === 'bigint' ? value : koffi.address(value);
}

function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  let result = '"';
  let slashes = 0;
  for (const character of argument) {
    if (character === '\\') slashes += 1;
    else if (character === '"') {
      result += `${'\\'.repeat(slashes * 2 + 1)}"`;
      slashes = 0;
    } else {
      result += `${'\\'.repeat(slashes)}${character}`;
      slashes = 0;
    }
  }
  return `${result}${'\\'.repeat(slashes * 2)}"`;
}

function environmentBlock(environment: NodeJS.ProcessEnv): Buffer {
  const entries = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => {
      if (name.includes('\0') || value.includes('\0') || name === '' || (name.includes('=') && !/^=[A-Za-z]:$/.test(name))) {
        throw new TypeError('environment contains an invalid Windows variable');
      }
      return [name, value] as [string, string];
    })
    .sort(([left], [right]) => left.toUpperCase() < right.toUpperCase() ? -1 : left.toUpperCase() > right.toUpperCase() ? 1 : 0);
  const text = `${entries.map(([name, value]) => `${name}=${value}`).join('\0')}\0\0`;
  return Buffer.from(text, 'utf16le');
}

function bindings(koffi: Koffi) {
  const kernel = koffi.load('kernel32.dll');
  const userenv = koffi.load('userenv.dll');
  const advapi = koffi.load('advapi32.dll');
  const bind = (library: ReturnType<Koffi['load']>, name: string, result: string | ReturnType<Koffi['pointer']>, args: Array<string | ReturnType<Koffi['pointer']>>) =>
    library.func('__stdcall', name, result, args) as unknown as (...parameters: any[]) => any;
  const PVOID = koffi.pointer('void');
  const PROCESS_INFORMATION = koffi.struct({ hProcess: PVOID, hThread: PVOID, dwProcessId: 'uint32_t', dwThreadId: 'uint32_t' });
  const STARTUPINFOEXW = koffi.struct({
    cb: 'uint32_t', lpReserved: PVOID, lpDesktop: PVOID, lpTitle: PVOID, dwX: 'uint32_t', dwY: 'uint32_t',
    dwXSize: 'uint32_t', dwYSize: 'uint32_t', dwXCountChars: 'uint32_t', dwYCountChars: 'uint32_t',
    dwFillAttribute: 'uint32_t', dwFlags: 'uint32_t', wShowWindow: 'uint16_t', cbReserved2: 'uint16_t',
    lpReserved2: PVOID, hStdInput: PVOID, hStdOutput: PVOID, hStdError: PVOID, lpAttributeList: PVOID,
  });
  const SECURITY_CAPABILITIES = koffi.struct({ AppContainerSid: PVOID, Capabilities: PVOID, CapabilityCount: 'uint32_t', Reserved: 'uint32_t' });
  return {
    PVOID, PROCESS_INFORMATION, STARTUPINFOEXW, SECURITY_CAPABILITIES,
    createProfile: bind(userenv, 'CreateAppContainerProfile', 'int32_t', ['str16', 'str16', 'str16', PVOID, 'uint32_t', koffi.pointer(PVOID)]),
    deleteProfile: bind(userenv, 'DeleteAppContainerProfile', 'int32_t', ['str16']),
    deriveSid: bind(userenv, 'DeriveAppContainerSidFromAppContainerName', 'int32_t', ['str16', koffi.pointer(PVOID)]),
    freeSid: bind(advapi, 'FreeSid', PVOID, [PVOID]),
    closeHandle: bind(kernel, 'CloseHandle', 'int32_t', [PVOID]),
    lastError: bind(kernel, 'GetLastError', 'uint32_t', []),
    createProcess: bind(kernel, 'CreateProcessW', 'int32_t', ['str16', PVOID, PVOID, PVOID, 'int32_t', 'uint32_t', PVOID, 'str16', koffi.pointer(STARTUPINFOEXW), koffi.pointer(PROCESS_INFORMATION)]),
    initializeAttributes: bind(kernel, 'InitializeProcThreadAttributeList', 'int32_t', [PVOID, 'uint32_t', 'uint32_t', koffi.pointer('size_t')]),
    updateAttribute: bind(kernel, 'UpdateProcThreadAttribute', 'int32_t', [PVOID, 'uint32_t', 'uintptr_t', PVOID, 'size_t', PVOID, PVOID]),
    deleteAttributes: bind(kernel, 'DeleteProcThreadAttributeList', 'void', [PVOID]),
    getStdHandle: bind(kernel, 'GetStdHandle', PVOID, ['int32_t']),
    getHandleInformation: bind(kernel, 'GetHandleInformation', 'int32_t', [PVOID, koffi.pointer('uint32_t')]),
    isProcessInJob: bind(kernel, 'IsProcessInJob', 'int32_t', [PVOID, PVOID, koffi.pointer('int32_t')]),
    resumeThread: bind(kernel, 'ResumeThread', 'uint32_t', [PVOID]),
    terminateProcess: bind(kernel, 'TerminateProcess', 'int32_t', [PVOID, 'uint32_t']),
    wait: bind(kernel, 'WaitForSingleObject', 'uint32_t', [PVOID, 'uint32_t']),
    getExitCode: bind(kernel, 'GetExitCodeProcess', 'int32_t', [PVOID, koffi.pointer('uint32_t')]),
    setHandleInformation: bind(kernel, 'SetHandleInformation', 'int32_t', [PVOID, 'uint32_t', 'uint32_t']),
  };
}

export interface AppContainerProfile {
  readonly name: string;
  readonly sid: NativeHandle;
  dispose(): Promise<void>;
}

export async function createAppContainerProfile(): Promise<AppContainerProfile> {
  if (process.platform !== 'win32') throw new Error('AppContainer profiles are available only on Windows');
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  const name = `Ligule-${randomUUID()}`;
  const sidOut = koffi.alloc(api.PVOID, 1) as Buffer;
  let hr: number;
  let sidPointer: NativeHandle;
  let profileCreated = false;
  try {
    hr = api.createProfile(name, name, name, NULL, 0, sidOut) as number;
    if (hr < 0) throw new Error(`CreateAppContainerProfile failed with HRESULT 0x${(hr >>> 0).toString(16)}`);
    profileCreated = true;
    sidPointer = nativeHandle(koffi, koffi.decode(sidOut, api.PVOID));
  } catch (error) {
    if (profileCreated) {
      const cleanup = api.deleteProfile(name) as number;
      if (cleanup < 0) throw new AggregateError([error, new Error(`DeleteAppContainerProfile cleanup failed with HRESULT 0x${(cleanup >>> 0).toString(16)}`)], 'AppContainer profile creation cleanup failed');
    }
    throw error;
  } finally {
    koffi.free(sidOut);
  }
  if (isNull(sidPointer)) {
    const cleanup = api.deleteProfile(name) as number;
    if (cleanup < 0) throw new Error(`CreateAppContainerProfile returned a null SID and DeleteAppContainerProfile cleanup failed with HRESULT 0x${(cleanup >>> 0).toString(16)}`);
    throw new Error('CreateAppContainerProfile returned a null SID');
  }
  let sidFreed = false;
  return {
    name,
    sid: sidPointer,
    async dispose() {
      const result = api.deleteProfile(name) as number;
      const freeResult = sidFreed ? NULL : api.freeSid(sidPointer) as NativeHandle;
      sidFreed = isNull(freeResult);
      const failures = [
        ...(result < 0 ? [new Error(`DeleteAppContainerProfile failed with HRESULT 0x${(result >>> 0).toString(16)}`)] : []),
        ...(!isNull(freeResult) ? [new Error('FreeSid failed while releasing the AppContainer SID')] : []),
      ];
      if (failures.length > 0) throw new AggregateError(failures, 'AppContainer profile disposal failed');
    },
  };
}

export async function deriveAppContainerSid(name: string): Promise<NativeHandle> {
  if (process.platform !== 'win32') throw new Error('AppContainer profiles are available only on Windows');
  if (name.trim() === '' || name.includes('\0')) throw new TypeError('profile name must be a non-empty string without NUL characters');
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  const sidOut = koffi.alloc(api.PVOID, 1) as Buffer;
  let sid: NativeHandle;
  try {
    const result = api.deriveSid(name, sidOut) as number;
    if (result < 0) throw new Error(`DeriveAppContainerSidFromAppContainerName failed with HRESULT 0x${(result >>> 0).toString(16)}`);
    sid = nativeHandle(koffi, koffi.decode(sidOut, api.PVOID));
  } finally {
    koffi.free(sidOut);
  }
  if (isNull(sid)) throw new Error('DeriveAppContainerSidFromAppContainerName returned a null SID');
  return sid;
}

export async function freeAppContainerSid(sid: NativeHandle): Promise<void> {
  if (process.platform !== 'win32') throw new Error('AppContainer profiles are available only on Windows');
  if (isNull(sid)) throw new TypeError('SID handle is required');
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  if (!isNull(api.freeSid(sid) as NativeHandle)) throw new Error('FreeSid failed while releasing the AppContainer SID');
}

export async function deleteAppContainerProfile(name: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('AppContainer profiles are available only on Windows');
  if (name.trim() === '' || name.includes('\0')) throw new TypeError('profile name must be a non-empty string without NUL characters');
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  const result = api.deleteProfile(name) as number;
  if (result < 0) throw new Error(`DeleteAppContainerProfile failed with HRESULT 0x${(result >>> 0).toString(16)}`);
}

export interface AppContainerCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly identity: AppContainerProfile;
  readonly environment: NodeJS.ProcessEnv;
  readonly assignToJob?: (processHandle: NativeHandle) => void;
}

/** Launch in the Guardian's inherited Job and wait without blocking its IPC event loop. */
export async function runAppContainerCommand(command: AppContainerCommand): Promise<number> {
  if (process.platform !== 'win32') throw new Error('AppContainer processes are available only on Windows');
  if (!command.executable || !command.cwd || command.executable.includes('\0') || command.cwd.includes('\0')) throw new TypeError('executable and cwd are required Windows paths');
  if (command.argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) throw new TypeError('arguments must be strings without NUL characters');
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  const allocations: unknown[] = [];
  const allocate = (type: Parameters<Koffi['alloc']>[0], length: number) => {
    const allocation = koffi.alloc(type, length);
    allocations.push(allocation);
    return allocation;
  };
  let attributesReady = false;
  let attributes: Buffer | undefined;
  const stdHandles: Array<{ handle: NativeHandle; inherit: number; label: string }> = [];
  const cleanFailures: Error[] = [];
  let primaryFailure: unknown;
  let processHandle: NativeHandle | undefined;
  let threadHandle: NativeHandle | undefined;
  let created = false;
  let creationAttempted = false;
  try {
    const caps = allocate(api.SECURITY_CAPABILITIES, 1) as Buffer;
    koffi.encode(caps, api.SECURITY_CAPABILITIES, { AppContainerSid: command.identity.sid, Capabilities: NULL, CapabilityCount: 0, Reserved: 0 });
    const sizeSlot = allocate('size_t', 1) as Buffer;
    api.initializeAttributes(NULL, 2, 0, sizeSlot);
    const attributeSize = Number(koffi.decode(sizeSlot, 'size_t'));
    if (!Number.isSafeInteger(attributeSize) || attributeSize <= 0) throw new Error('InitializeProcThreadAttributeList did not return a valid buffer size');
    attributes = allocate('uint8', attributeSize) as Buffer;
    if ((api.initializeAttributes(attributes, 2, 0, sizeSlot) as number) === 0) throw new Error(`InitializeProcThreadAttributeList failed with Win32 error ${api.lastError() as number}`);
    attributesReady = true;
    if ((api.updateAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, caps, koffi.sizeof(api.SECURITY_CAPABILITIES), NULL, NULL) as number) === 0) throw new Error(`UpdateProcThreadAttribute failed with Win32 error ${api.lastError() as number}`);
    for (const [fd, kind] of [[-10, 'stdin'], [-11, 'stdout'], [-12, 'stderr']] as const) {
      const handle = nativeHandle(koffi, api.getStdHandle(fd));
      if (isNull(handle)) throw new Error(`GetStdHandle(${kind}) returned a null handle`);
      const info = allocate('uint32_t', 1) as Buffer;
      if ((api.getHandleInformation(handle, info) as number) === 0) throw new Error(`GetHandleInformation(${kind}) failed with Win32 error ${api.lastError() as number}`);
      const originalFlags = Number(koffi.decode(info, 'uint32_t'));
      stdHandles.push({ handle, inherit: originalFlags & HANDLE_FLAG_INHERIT, label: kind });
      if ((api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) as number) === 0) throw new Error(`SetHandleInformation(${kind}, inherit) failed with Win32 error ${api.lastError() as number}`);
    }
    const handleType = koffi.array(api.PVOID, stdHandles.length);
    const handleList = allocate(handleType, 1) as Buffer;
    koffi.encode(handleList, handleType, stdHandles.map(({ handle }) => handle));
    if ((api.updateAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, stdHandles.length * koffi.sizeof(api.PVOID), NULL, NULL) as number) === 0) throw new Error(`UpdateProcThreadAttribute(HANDLE_LIST) failed with Win32 error ${api.lastError() as number}`);
    const startup = allocate(api.STARTUPINFOEXW, 1) as Buffer;
    const processInfo = allocate(api.PROCESS_INFORMATION, 1) as Buffer;
    const startupValue = {
      cb: koffi.sizeof(api.STARTUPINFOEXW), lpReserved: NULL, lpDesktop: NULL, lpTitle: NULL,
      dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0,
      dwFillAttribute: 0, dwFlags: STARTF_USESTDHANDLES, wShowWindow: 0, cbReserved2: 0,
      lpReserved2: NULL, hStdInput: stdHandles[0]?.handle, hStdOutput: stdHandles[1]?.handle, hStdError: stdHandles[2]?.handle,
      lpAttributeList: koffi.address(attributes),
    };
    koffi.encode(startup, api.STARTUPINFOEXW, startupValue);
    const line = [command.executable, ...command.argv].map(quoteWindowsArgument).join(' ');
    const commandLine = Buffer.from(`${line}\0`, 'utf16le');
    const env = environmentBlock(command.environment);
    creationAttempted = true;
    if ((api.createProcess(command.executable, commandLine, NULL, NULL, 1, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, env, command.cwd, startup, processInfo) as number) === 0) throw new Error(`CreateProcessW failed with Win32 error ${api.lastError() as number}`);
    created = true;
    const processValues = koffi.decode(processInfo, api.PROCESS_INFORMATION) as { hProcess: NativeHandle; hThread: NativeHandle };
    processHandle = nativeHandle(koffi, processValues.hProcess);
    threadHandle = nativeHandle(koffi, processValues.hThread);
    if (isNull(processHandle) || isNull(threadHandle)) throw new Error('CreateProcessW returned a null process or thread handle');
    command.assignToJob?.(processHandle);
    const inJob = allocate('int32_t', 1) as Buffer;
    if ((api.isProcessInJob(processHandle, NULL, inJob) as number) === 0) throw new Error(`IsProcessInJob failed with Win32 error ${api.lastError() as number}`);
    if (koffi.decode(inJob, 'int32_t') !== 1) throw new Error('the AppContainer process is outside the Guardian Job');
    if ((api.resumeThread(threadHandle) as number) === 0xffffffff) throw new Error(`ResumeThread failed with Win32 error ${api.lastError() as number}`);
    if ((api.closeHandle(threadHandle) as number) === 0) throw new Error(`CloseHandle(thread) failed after ResumeThread with Win32 error ${api.lastError() as number}`);
    threadHandle = undefined;
    for (;;) {
      const state = api.wait(processHandle, 0) as number;
      if (state === WAIT_OBJECT_0) break;
      if (state !== WAIT_TIMEOUT) throw new Error(`WaitForSingleObject failed with result ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exitCodeSlot = allocate('uint32_t', 1) as Buffer;
    if ((api.getExitCode(processHandle, exitCodeSlot) as number) === 0) throw new Error(`GetExitCodeProcess failed with Win32 error ${api.lastError() as number}`);
    const exitCode = Number(koffi.decode(exitCodeSlot, 'uint32_t'));
    if (exitCode === STILL_ACTIVE) throw new Error('GetExitCodeProcess returned STILL_ACTIVE for a signaled process');
    return exitCode;
  } catch (error) {
    primaryFailure = error;
    if (created) {
      if (isNull(processHandle)) {
        const failure = new KernelError('exec_terminate_failed', { cause: error, detail: 'the AppContainer child was created without a usable process handle' });
        primaryFailure = failure;
        throw failure;
      }
      let current: number;
      try { current = api.wait(processHandle, 0) as number; }
      catch (cause) {
        const failure = new KernelError('exec_terminate_failed', {
          cause: new AggregateError([error, cause]), detail: 'the AppContainer child exit state could not be checked',
        });
        primaryFailure = failure;
        throw failure;
      }
      if (current === WAIT_OBJECT_0) {
        const interrupted = new KernelError('exec_process_interrupted', { cause: error, detail: 'the AppContainer child exited while the command result was being collected' });
        primaryFailure = interrupted;
        throw interrupted;
      }
      if (current !== WAIT_TIMEOUT) {
        const failure = new KernelError('exec_terminate_failed', { cause: error, detail: `WaitForSingleObject failed while checking the AppContainer child (${current})` });
        primaryFailure = failure;
        throw failure;
      }
      let terminated: number;
      try { terminated = api.terminateProcess(processHandle, 1) as number; }
      catch (cause) {
        const failure = new KernelError('exec_terminate_failed', {
          cause: new AggregateError([error, cause]), detail: 'the AppContainer child could not be terminated',
        });
        primaryFailure = failure;
        throw failure;
      }
      if (terminated === 0) {
        const failure = new KernelError('exec_terminate_failed', { cause: error, detail: `TerminateProcess failed while cleaning up the AppContainer child (Win32 error ${api.lastError() as number})` });
        primaryFailure = failure;
        throw failure;
      }
      for (;;) {
        let state: number;
        try { state = api.wait(processHandle, 0) as number; }
        catch (cause) {
          const failure = new KernelError('exec_terminate_failed', {
            cause: new AggregateError([error, cause]), detail: 'the AppContainer child exit could not be confirmed',
          });
          primaryFailure = failure;
          throw failure;
        }
        if (state === WAIT_OBJECT_0) break;
        if (state !== WAIT_TIMEOUT) {
          const failure = new KernelError('exec_terminate_failed', { cause: error, detail: `WaitForSingleObject failed while cleaning up the AppContainer child (${state})` });
          primaryFailure = failure;
          throw failure;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const interrupted = new KernelError('exec_process_interrupted', { cause: error, detail: 'the AppContainer child was terminated after a command failure' });
      primaryFailure = interrupted;
      throw interrupted;
    }
    const failure = new KernelError(creationAttempted ? 'exec_spawn_failed' : 'exec_sandbox_setup_failed', {
      cause: error,
      detail: error instanceof Error ? error.message : undefined,
    });
    primaryFailure = failure;
    throw failure;
  } finally {
    if (!isNull(threadHandle) && (api.closeHandle(threadHandle as NativeHandle) as number) === 0) cleanFailures.push(new Error(`CloseHandle(thread) failed with Win32 error ${api.lastError() as number}`));
    if (!isNull(processHandle) && (api.closeHandle(processHandle as NativeHandle) as number) === 0) cleanFailures.push(new Error(`CloseHandle(process) failed with Win32 error ${api.lastError() as number}`));
    if (attributesReady && attributes !== undefined) api.deleteAttributes(attributes);
    for (const { handle, inherit, label } of stdHandles) {
      if ((api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, inherit) as number) === 0) cleanFailures.push(new Error(`SetHandleInformation(${label}, restore inherit) failed with Win32 error ${api.lastError() as number}`));
    }
    for (const allocation of allocations.reverse()) {
      try {
        koffi.free(allocation);
      } catch (error) {
        cleanFailures.push(new Error('Koffi allocation could not be released', { cause: error }));
      }
    }
    if (cleanFailures.length > 0) {
      const code = primaryFailure instanceof KernelError && primaryFailure.code === 'exec_terminate_failed'
        ? 'exec_termination_cleanup_failed' : 'exec_sandbox_cleanup_failed';
      throw new KernelError(code, {
        cause: new AggregateError(primaryFailure === undefined ? cleanFailures : [primaryFailure, ...cleanFailures], 'AppContainer launch or cleanup failed'),
        detail: 'AppContainer process or platform resources could not be fully cleaned',
      });
    }
  }
}
