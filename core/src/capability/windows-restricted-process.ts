import { randomInt } from 'node:crypto';
import { KernelError } from '../errors.js';
import type { NativeHandle } from './windows-appcontainer-process.js';
import type { OwnedProcessJob } from './win32-job.js';

type Koffi = typeof import('koffi')['default'];

const NULL = 0n;
const PROCESS_QUERY_INFORMATION = 0x0400;
const TOKEN_ASSIGN_PRIMARY = 0x0001;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_QUERY = 0x0008;
const TOKEN_ADJUST_DEFAULT = 0x0080;
const TOKEN_GROUPS = 2;
const TOKEN_DEFAULT_DACL = 6;
const ERROR_INSUFFICIENT_BUFFER = 122;
const SE_GROUP_LOGON_ID = 0xc0000000;
const WIN_WORLD_SID = 1;
const SECURITY_MAX_SID_SIZE = 68;
const DISABLE_MAX_PRIVILEGE = 0x00000001;
const LUA_TOKEN = 0x00000004;
const WRITE_RESTRICTED = 0x00000008;
const GRANT_ACCESS = 1;
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_UNKNOWN = 0;
const FILE_ALL_ACCESS = 0x001f01ff;
const CREATE_SUSPENDED = 0x00000004;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const STARTF_USESTDHANDLES = 0x00000100;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
const HANDLE_FLAG_INHERIT = 0x00000001;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const STILL_ACTIVE = 259;

interface AllocationSet {
  make(type: Parameters<Koffi['alloc']>[0], count?: number): Buffer;
  free(): void;
}

function isNull(handle: NativeHandle | null | undefined): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}

function pointer(koffi: Koffi, value: unknown): NativeHandle {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'number' || typeof value === 'bigint' ? value : koffi.address(value);
}

function allocate(koffi: Koffi): AllocationSet {
  const values: Buffer[] = [];
  return {
    make(type, count = 1) {
      const value = koffi.alloc(type, count) as Buffer;
      values.push(value);
      return value;
    },
    free() {
      const failures: unknown[] = [];
      for (const value of values.reverse()) {
        try { koffi.free(value); }
        catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'restricted-token native buffers could not be freed');
    },
  };
}

function win32Failure(api: ReturnType<typeof bindings>, operation: string, code = api.lastError()): Error {
  return new Error(`${operation} failed with Win32 error ${code}`);
}

function bindings(koffi: Koffi) {
  const kernel = koffi.load('kernel32.dll');
  const advapi = koffi.load('advapi32.dll');
  const PVOID = koffi.pointer('void');
  const SID_AND_ATTRIBUTES = koffi.struct({ Sid: PVOID, Attributes: 'uint32_t' });
  const TRUSTEE_W = koffi.struct({
    pMultipleTrustee: PVOID, MultipleTrusteeOperation: 'int32_t', TrusteeForm: 'int32_t', TrusteeType: 'int32_t', ptstrName: PVOID,
  });
  const EXPLICIT_ACCESS_W = koffi.struct({
    grfAccessPermissions: 'uint32_t', grfAccessMode: 'int32_t', grfInheritance: 'uint32_t', Trustee: TRUSTEE_W,
  });
  const TOKEN_DEFAULT_DACL = koffi.struct({ DefaultDacl: PVOID });
  const PROCESS_INFORMATION = koffi.struct({ hProcess: PVOID, hThread: PVOID, dwProcessId: 'uint32_t', dwThreadId: 'uint32_t' });
  const STARTUPINFOEXW = koffi.struct({
    cb: 'uint32_t', lpReserved: PVOID, lpDesktop: PVOID, lpTitle: PVOID, dwX: 'uint32_t', dwY: 'uint32_t',
    dwXSize: 'uint32_t', dwYSize: 'uint32_t', dwXCountChars: 'uint32_t', dwYCountChars: 'uint32_t',
    dwFillAttribute: 'uint32_t', dwFlags: 'uint32_t', wShowWindow: 'uint16_t', cbReserved2: 'uint16_t',
    lpReserved2: PVOID, hStdInput: PVOID, hStdOutput: PVOID, hStdError: PVOID, lpAttributeList: PVOID,
  });
  const bind = (
    library: ReturnType<Koffi['load']>, name: string, result: string | ReturnType<Koffi['pointer']>,
    args: Array<string | ReturnType<Koffi['pointer']>>,
  ) => library.func('__stdcall', name, result, args) as unknown as (...parameters: any[]) => any;
  return {
    PVOID, SID_AND_ATTRIBUTES, EXPLICIT_ACCESS_W, TOKEN_DEFAULT_DACL, PROCESS_INFORMATION, STARTUPINFOEXW,
    openProcess: bind(kernel, 'OpenProcess', PVOID, ['uint32_t', 'int32_t', 'uint32_t']),
    openProcessToken: bind(advapi, 'OpenProcessToken', 'int32_t', [PVOID, 'uint32_t', koffi.pointer(PVOID)]),
    getTokenInformation: bind(advapi, 'GetTokenInformation', 'int32_t', [PVOID, 'int32_t', PVOID, 'uint32_t', koffi.pointer('uint32_t')]),
    createRestrictedToken: bind(advapi, 'CreateRestrictedToken', 'int32_t', [PVOID, 'uint32_t', 'uint32_t', PVOID, 'uint32_t', PVOID, 'uint32_t', PVOID, koffi.pointer(PVOID)]),
    createWellKnownSid: bind(advapi, 'CreateWellKnownSid', 'int32_t', ['uint32_t', PVOID, PVOID, koffi.pointer('uint32_t')]),
    isValidSid: bind(advapi, 'IsValidSid', 'int32_t', [PVOID]),
    convertStringSid: bind(advapi, 'ConvertStringSidToSidW', 'int32_t', ['str16', koffi.pointer(PVOID)]),
    setEntriesInAcl: bind(advapi, 'SetEntriesInAclW', 'uint32_t', ['uint32_t', koffi.pointer(EXPLICIT_ACCESS_W), PVOID, koffi.pointer(PVOID)]),
    setTokenInformation: bind(advapi, 'SetTokenInformation', 'int32_t', [PVOID, 'int32_t', PVOID, 'uint32_t']),
    createProcessAsUser: bind(advapi, 'CreateProcessAsUserW', 'int32_t', [PVOID, 'str16', PVOID, PVOID, PVOID, 'int32_t', 'uint32_t', PVOID, 'str16', koffi.pointer(STARTUPINFOEXW), koffi.pointer(PROCESS_INFORMATION)]),
    initializeAttributes: bind(kernel, 'InitializeProcThreadAttributeList', 'int32_t', [PVOID, 'uint32_t', 'uint32_t', koffi.pointer('size_t')]),
    updateAttribute: bind(kernel, 'UpdateProcThreadAttribute', 'int32_t', [PVOID, 'uint32_t', 'uintptr_t', PVOID, 'size_t', PVOID, PVOID]),
    deleteAttributes: bind(kernel, 'DeleteProcThreadAttributeList', 'void', [PVOID]),
    getStdHandle: bind(kernel, 'GetStdHandle', PVOID, ['int32_t']),
    getHandleInformation: bind(kernel, 'GetHandleInformation', 'int32_t', [PVOID, koffi.pointer('uint32_t')]),
    setHandleInformation: bind(kernel, 'SetHandleInformation', 'int32_t', [PVOID, 'uint32_t', 'uint32_t']),
    resumeThread: bind(kernel, 'ResumeThread', 'uint32_t', [PVOID]),
    wait: bind(kernel, 'WaitForSingleObject', 'uint32_t', [PVOID, 'uint32_t']),
    getExitCodeProcess: bind(kernel, 'GetExitCodeProcess', 'int32_t', [PVOID, koffi.pointer('uint32_t')]),
    terminateProcess: bind(kernel, 'TerminateProcess', 'int32_t', [PVOID, 'uint32_t']),
    isProcessInJob: bind(kernel, 'IsProcessInJob', 'int32_t', [PVOID, PVOID, koffi.pointer('int32_t')]),
    closeHandle: bind(kernel, 'CloseHandle', 'int32_t', [PVOID]),
    localFree: bind(kernel, 'LocalFree', PVOID, [PVOID]),
    lastError: bind(kernel, 'GetLastError', 'uint32_t', []),
  };
}

function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/u.test(argument)) return argument;
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

function throwTokenError(api: ReturnType<typeof bindings>, operation: string): never {
  throw win32Failure(api, operation);
}

function createToken(koffi: Koffi, api: ReturnType<typeof bindings>, writeSidText: string): NativeHandle {
  const memory = allocate(koffi);
  let processHandle: NativeHandle | undefined;
  let sourceToken: NativeHandle | undefined;
  let restrictedToken: NativeHandle | undefined;
  let writeSid: NativeHandle | undefined;
  let worldSid: NativeHandle | undefined;
  let primaryError: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    processHandle = pointer(koffi, api.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid));
    if (isNull(processHandle)) throwTokenError(api, 'OpenProcess(current process)');
    const sourceTokenOut = memory.make(api.PVOID);
    const tokenRights = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY;
    if (api.openProcessToken(processHandle, tokenRights, sourceTokenOut) === 0) throwTokenError(api, 'OpenProcessToken(current process)');
    sourceToken = pointer(koffi, koffi.decode(sourceTokenOut, api.PVOID));
    if (isNull(sourceToken)) throw new Error('OpenProcessToken returned a null token handle');

    const requiredOut = memory.make('uint32_t');
    api.getTokenInformation(sourceToken, TOKEN_GROUPS, NULL, 0, requiredOut);
    const sizeError = api.lastError();
    if (sizeError !== ERROR_INSUFFICIENT_BUFFER) throw win32Failure(api, 'GetTokenInformation(TokenGroups size)', sizeError);
    const required = Number(koffi.decode(requiredOut, 'uint32_t'));
    const groups = memory.make('uint8_t', required);
    if (api.getTokenInformation(sourceToken, TOKEN_GROUPS, groups, required, requiredOut) === 0) throwTokenError(api, 'GetTokenInformation(TokenGroups)');
    const groupCount = Number(koffi.decode(groups, 'uint32_t'));
    const groupsOffset = 8;
    const groupSize = koffi.sizeof(api.SID_AND_ATTRIBUTES);
    if (!Number.isSafeInteger(groupCount) || groupsOffset + groupCount * groupSize > required) {
      throw new Error('GetTokenInformation(TokenGroups) returned an invalid group list');
    }
    let logonSid: NativeHandle | undefined;
    for (let index = 0; index < groupCount; index += 1) {
      const entry = koffi.decode(groups, groupsOffset + index * groupSize, api.SID_AND_ATTRIBUTES) as { Sid: unknown; Attributes: number };
      if (((Number(entry.Attributes) & SE_GROUP_LOGON_ID) >>> 0) !== (SE_GROUP_LOGON_ID >>> 0)) continue;
      logonSid = pointer(koffi, entry.Sid);
      break;
    }
    if (logonSid === undefined || isNull(logonSid) || api.isValidSid(logonSid) === 0) {
      throw new Error('the current token has no valid logon-session SID');
    }

    const worldBuffer = memory.make('uint8_t', SECURITY_MAX_SID_SIZE);
    const worldSize = memory.make('uint32_t');
    koffi.encode(worldSize, 'uint32_t', SECURITY_MAX_SID_SIZE);
    if (api.createWellKnownSid(WIN_WORLD_SID, NULL, worldBuffer, worldSize) === 0) throwTokenError(api, 'CreateWellKnownSid(Everyone)');
    worldSid = pointer(koffi, worldBuffer);
    if (api.isValidSid(worldSid) === 0) throwTokenError(api, 'IsValidSid(Everyone)');

    const writeSidOut = memory.make(api.PVOID);
    if (api.convertStringSid(writeSidText, writeSidOut) === 0) throwTokenError(api, 'ConvertStringSidToSidW(workspace capability)');
    writeSid = pointer(koffi, koffi.decode(writeSidOut, api.PVOID));
    if (isNull(writeSid) || api.isValidSid(writeSid) === 0) throw new Error('the workspace capability SID is invalid');

    const restrictingType = koffi.array(api.SID_AND_ATTRIBUTES, 3);
    const restricting = memory.make(restrictingType);
    koffi.encode(restricting, restrictingType, [logonSid, worldSid, writeSid].map((Sid) => ({ Sid, Attributes: 0 })));
    const tokenOut = memory.make(api.PVOID);
    const flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    if (api.createRestrictedToken(sourceToken, flags, 0, NULL, 0, NULL, 3, restricting, tokenOut) === 0) {
      throwTokenError(api, 'CreateRestrictedToken(WRITE_RESTRICTED)');
    }
    restrictedToken = pointer(koffi, koffi.decode(tokenOut, api.PVOID));
    if (isNull(restrictedToken)) throw new Error('CreateRestrictedToken returned a null token handle');
    setDefaultDaclGrant(koffi, api, memory, restrictedToken, writeSid);
    const result = restrictedToken;
    restrictedToken = undefined;
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!isNull(restrictedToken) && api.closeHandle(restrictedToken as NativeHandle) === 0) cleanupFailures.push(win32Failure(api, 'CloseHandle(restricted token)'));
    if (!isNull(sourceToken) && api.closeHandle(sourceToken as NativeHandle) === 0) cleanupFailures.push(win32Failure(api, 'CloseHandle(source token)'));
    if (!isNull(processHandle) && api.closeHandle(processHandle as NativeHandle) === 0) cleanupFailures.push(win32Failure(api, 'CloseHandle(source process)'));
    if (!isNull(writeSid) && !isNull(api.localFree(writeSid as NativeHandle))) cleanupFailures.push(win32Failure(api, 'LocalFree(workspace capability SID)'));
    try { memory.free(); }
    catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length > 0) throw new AggregateError(primaryError === undefined ? cleanupFailures : [primaryError, ...cleanupFailures], 'restricted token construction cleanup failed');
  }
}

function setDefaultDaclGrant(
  koffi: Koffi,
  api: ReturnType<typeof bindings>,
  memory: AllocationSet,
  token: NativeHandle,
  writeSid: NativeHandle,
): void {
  const requiredOut = memory.make('uint32_t');
  api.getTokenInformation(token, TOKEN_DEFAULT_DACL, NULL, 0, requiredOut);
  const sizeError = api.lastError();
  if (sizeError !== ERROR_INSUFFICIENT_BUFFER) throw win32Failure(api, 'GetTokenInformation(TokenDefaultDacl size)', sizeError);
  const required = Number(koffi.decode(requiredOut, 'uint32_t'));
  if (required < koffi.sizeof(api.PVOID)) throw new Error('TokenDefaultDacl returned an invalid size');
  const currentInfo = memory.make('uint8_t', required);
  if (api.getTokenInformation(token, TOKEN_DEFAULT_DACL, currentInfo, required, requiredOut) === 0) {
    throwTokenError(api, 'GetTokenInformation(TokenDefaultDacl)');
  }
  const currentDacl = pointer(koffi, koffi.decode(currentInfo, api.PVOID));
  if (isNull(currentDacl)) throw new Error('the current token has a null default DACL');
  const entry = memory.make(api.EXPLICIT_ACCESS_W);
  const EXPLICIT_ACCESS = api.EXPLICIT_ACCESS_W;
  koffi.encode(entry, EXPLICIT_ACCESS, {
    grfAccessPermissions: FILE_ALL_ACCESS,
    grfAccessMode: GRANT_ACCESS,
    grfInheritance: 0,
    Trustee: { pMultipleTrustee: NULL, MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: writeSid },
  });
  const daclOut = memory.make(api.PVOID);
  const merged = api.setEntriesInAcl(1, entry, currentDacl, daclOut);
  if (merged !== 0) throw win32Failure(api, 'SetEntriesInAclW(token default DACL)', merged);
  const newDacl = pointer(koffi, koffi.decode(daclOut, api.PVOID));
  if (isNull(newDacl)) throw new Error('SetEntriesInAclW returned a null token default DACL');
  const tokenDacl = memory.make(api.TOKEN_DEFAULT_DACL);
  koffi.encode(tokenDacl, api.TOKEN_DEFAULT_DACL, { DefaultDacl: newDacl });
  if (api.setTokenInformation(token, TOKEN_DEFAULT_DACL, tokenDacl, koffi.sizeof(api.TOKEN_DEFAULT_DACL)) === 0) {
    throwTokenError(api, 'SetTokenInformation(TokenDefaultDacl)');
  }
  if (!isNull(api.localFree(newDacl))) throw win32Failure(api, 'LocalFree(merged token default DACL)');
}

export function randomWorkspaceRestrictedSid(): string {
  // randomInt 在区间内均匀取值；对 32 位随机数取模会让靠前的取值被多算一次。
  const randomSubAuthority = () => randomInt(1, 2 ** 30);
  return `S-1-4-${randomSubAuthority()}-${randomSubAuthority()}`;
}

export interface RestrictedWindowsCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly writeSid: string;
  readonly job: OwnedProcessJob;
}

export async function runRestrictedWindowsCommand(command: RestrictedWindowsCommand): Promise<number> {
  if (process.platform !== 'win32') throw new Error('Restricted-token commands are available only on Windows');
  if (command.executable.trim() === '' || command.cwd.trim() === '' || command.writeSid.trim() === '') throw new TypeError('executable, cwd, and write SID are required');
  if ([command.executable, command.cwd, command.writeSid, ...command.argv].some((value) => value.includes('\0'))) throw new TypeError('restricted command arguments cannot contain NUL characters');
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  let token: NativeHandle;
  try { token = createToken(koffi, api, command.writeSid); }
  catch (cause) { throw new KernelError('exec_sandbox_setup_failed', { cause, detail: 'the restricted command token could not be prepared' }); }
  let primaryError: unknown;
  try { return await spawnWithToken(koffi, api, token, command); }
  catch (error) { primaryError = error; throw error; }
  finally {
    if (api.closeHandle(token) === 0) {
      const cleanupError = win32Failure(api, 'CloseHandle(restricted token)');
      const code = primaryError instanceof KernelError
        && ['exec_terminate_failed', 'exec_guardian_failed', 'exec_guardian_protocol', 'exec_termination_cleanup_failed'].includes(primaryError.code)
        ? 'exec_termination_cleanup_failed' : 'exec_sandbox_cleanup_failed';
      throw new KernelError(code, {
        cause: new AggregateError(primaryError === undefined ? [cleanupError] : [primaryError, cleanupError], 'restricted token command cleanup failed'),
        detail: 'the restricted command token could not be released',
      });
    }
  }
}

async function spawnWithToken(
  koffi: Koffi,
  api: ReturnType<typeof bindings>,
  token: NativeHandle,
  command: RestrictedWindowsCommand,
): Promise<number> {
  const memory = allocate(koffi);
  let attributesReady = false;
  let attributes: Buffer | undefined;
  const standardHandles: Array<{ handle: NativeHandle; flags: number; name: string }> = [];
  let processHandle: NativeHandle | undefined;
  let threadHandle: NativeHandle | undefined;
  let created = false;
  let creationAttempted = false;
  let primaryError: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    const sizeOut = memory.make('size_t');
    api.initializeAttributes(NULL, 1, 0, sizeOut);
    const attributeSize = Number(koffi.decode(sizeOut, 'size_t'));
    if (!Number.isSafeInteger(attributeSize) || attributeSize <= 0) throw new Error('InitializeProcThreadAttributeList returned an invalid size');
    attributes = memory.make('uint8_t', attributeSize);
    if (api.initializeAttributes(attributes, 1, 0, sizeOut) === 0) throwTokenError(api, 'InitializeProcThreadAttributeList');
    attributesReady = true;

    for (const [standardId, label] of [[-10, 'stdin'], [-11, 'stdout'], [-12, 'stderr']] as const) {
      const handle = pointer(koffi, api.getStdHandle(standardId));
      if (isNull(handle)) throw new Error(`GetStdHandle(${label}) returned a null handle`);
      const flagsOut = memory.make('uint32_t');
      if (api.getHandleInformation(handle, flagsOut) === 0) throwTokenError(api, `GetHandleInformation(${label})`);
      const flags = Number(koffi.decode(flagsOut, 'uint32_t'));
      standardHandles.push({ handle, flags: flags & HANDLE_FLAG_INHERIT, name: label });
      if (api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) === 0) {
        throwTokenError(api, `SetHandleInformation(${label}, inherit)`);
      }
    }

    const handleArray = koffi.array(api.PVOID, standardHandles.length);
    const handleList = memory.make(handleArray);
    koffi.encode(handleList, handleArray, standardHandles.map(({ handle }) => handle));
    if (api.updateAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, standardHandles.length * koffi.sizeof(api.PVOID), NULL, NULL) === 0) {
      throwTokenError(api, 'UpdateProcThreadAttribute(HANDLE_LIST)');
    }

    const startup = memory.make(api.STARTUPINFOEXW);
    const processInfo = memory.make(api.PROCESS_INFORMATION);
    koffi.encode(startup, api.STARTUPINFOEXW, {
      cb: koffi.sizeof(api.STARTUPINFOEXW), lpReserved: NULL, lpDesktop: NULL, lpTitle: NULL,
      dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0,
      dwFillAttribute: 0, dwFlags: STARTF_USESTDHANDLES, wShowWindow: 0, cbReserved2: 0, lpReserved2: NULL,
      hStdInput: standardHandles[0]?.handle, hStdOutput: standardHandles[1]?.handle, hStdError: standardHandles[2]?.handle,
      lpAttributeList: koffi.address(attributes),
    });
    const commandLine = Buffer.from(`${[command.executable, ...command.argv].map(quoteWindowsArgument).join(' ')}\0`, 'utf16le');
    creationAttempted = true;
    const started = api.createProcessAsUser(
      token, command.executable, commandLine, NULL, NULL, 1,
      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, NULL, command.cwd, startup, processInfo,
    );
    if (started === 0) throwTokenError(api, 'CreateProcessAsUserW(restricted token)');
    created = true;
    const info = koffi.decode(processInfo, api.PROCESS_INFORMATION) as { hProcess: unknown; hThread: unknown };
    processHandle = pointer(koffi, info.hProcess);
    threadHandle = pointer(koffi, info.hThread);
    if (isNull(processHandle) || isNull(threadHandle)) throw new Error('CreateProcessAsUserW returned a null process or thread handle');
    command.job.assign(processHandle);
    const inJob = memory.make('int32_t');
    if (api.isProcessInJob(processHandle, NULL, inJob) === 0) throwTokenError(api, 'IsProcessInJob(restricted child)');
    if (Number(koffi.decode(inJob, 'int32_t')) !== 1) throw new Error('the restricted process is outside the owned Job');
    if (api.resumeThread(threadHandle) === 0xffffffff) throwTokenError(api, 'ResumeThread(restricted child)');
    if (api.closeHandle(threadHandle) === 0) throwTokenError(api, 'CloseHandle(restricted thread)');
    threadHandle = undefined;
    for (;;) {
      const result = api.wait(processHandle, 0);
      if (result === WAIT_OBJECT_0) break;
      if (result !== WAIT_TIMEOUT) throw new Error(`WaitForSingleObject(restricted child) returned ${result}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    const exitOut = memory.make('uint32_t');
    if (api.getExitCodeProcess(processHandle, exitOut) === 0) throwTokenError(api, 'GetExitCodeProcess(restricted child)');
    const exitCode = Number(koffi.decode(exitOut, 'uint32_t'));
    if (exitCode === STILL_ACTIVE) throw new Error('GetExitCodeProcess returned STILL_ACTIVE for an exited restricted child');
    return exitCode;
  } catch (error) {
    primaryError = error;
    if (created) {
      if (isNull(processHandle)) {
        const failure = new KernelError('exec_terminate_failed', { cause: error, detail: 'the restricted child was created without a usable process handle' });
        primaryError = failure;
        throw failure;
      }
      let current: number;
      try { current = api.wait(processHandle, 0); }
      catch (cause) {
        const failure = new KernelError('exec_terminate_failed', {
          cause: new AggregateError([error, cause]), detail: 'the restricted child exit state could not be checked',
        });
        primaryError = failure;
        throw failure;
      }
      if (current === WAIT_OBJECT_0) {
        const interrupted = new KernelError('exec_process_interrupted', { cause: error, detail: 'the restricted child exited while its result was being collected' });
        primaryError = interrupted;
        throw interrupted;
      }
      if (current !== WAIT_TIMEOUT) {
        const failure = new KernelError('exec_terminate_failed', { cause: error, detail: `WaitForSingleObject failed while checking the restricted child (${current})` });
        primaryError = failure;
        throw failure;
      }
      let terminated: number;
      try { terminated = api.terminateProcess(processHandle, 1); }
      catch (cause) {
        const failure = new KernelError('exec_terminate_failed', {
          cause: new AggregateError([error, cause]), detail: 'the restricted child could not be terminated',
        });
        primaryError = failure;
        throw failure;
      }
      if (terminated === 0) {
        const failure = new KernelError('exec_terminate_failed', { cause: error, detail: `TerminateProcess failed while cleaning up the restricted child (Win32 error ${api.lastError() as number})` });
        primaryError = failure;
        throw failure;
      }
      for (;;) {
        let result: number;
        try { result = api.wait(processHandle, 0); }
        catch (cause) {
          const failure = new KernelError('exec_terminate_failed', {
            cause: new AggregateError([error, cause]), detail: 'the restricted child exit could not be confirmed',
          });
          primaryError = failure;
          throw failure;
        }
        if (result === WAIT_OBJECT_0) break;
        if (result !== WAIT_TIMEOUT) {
          const failure = new KernelError('exec_terminate_failed', { cause: error, detail: `WaitForSingleObject failed while cleaning up the restricted child (${result})` });
          primaryError = failure;
          throw failure;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      const interrupted = new KernelError('exec_process_interrupted', { cause: error, detail: 'the restricted child was terminated after a command failure' });
      primaryError = interrupted;
      throw interrupted;
    }
    const failure = new KernelError(creationAttempted ? 'exec_spawn_failed' : 'exec_sandbox_setup_failed', {
      cause: error,
      detail: error instanceof Error ? error.message : undefined,
    });
    primaryError = failure;
    throw failure;
  } finally {
    if (attributesReady && attributes !== undefined) api.deleteAttributes(attributes);
    for (const { handle, flags, name } of standardHandles) {
      if (api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, flags) === 0) cleanupFailures.push(win32Failure(api, `SetHandleInformation(${name}, restore inherit)`));
    }
    if (!isNull(threadHandle) && api.closeHandle(threadHandle as NativeHandle) === 0) cleanupFailures.push(win32Failure(api, 'CloseHandle(restricted thread)'));
    if (!isNull(processHandle) && api.closeHandle(processHandle as NativeHandle) === 0) cleanupFailures.push(win32Failure(api, 'CloseHandle(restricted process)'));
    try { memory.free(); }
    catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length > 0) {
      const code = primaryError instanceof KernelError && primaryError.code === 'exec_terminate_failed'
        ? 'exec_termination_cleanup_failed' : 'exec_sandbox_cleanup_failed';
      throw new KernelError(code, {
        cause: new AggregateError(primaryError === undefined ? cleanupFailures : [primaryError, ...cleanupFailures], 'restricted process cleanup failed'),
        detail: 'restricted process or platform resources could not be fully cleaned',
      });
    }
  }
}
