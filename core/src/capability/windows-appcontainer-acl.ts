type Koffi = typeof import('koffi')['default'];
import type { NativeHandle } from './windows-appcontainer-process.js';
import { createHash } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { dataRoot } from '../data-root.js';
import { KernelError } from '../errors.js';

export type AppContainerHandle = NativeHandle;

const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 0x00000004;
const LABEL_SECURITY_INFORMATION = 0x00000010;
const GRANT_ACCESS = 1;
const REVOKE_ACCESS = 4;
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_UNKNOWN = 0;
const OBJECT_AND_CONTAINER_INHERIT = 0x00000003;
const FILE_GENERIC_READ = 0x00120089;
const FILE_TRAVERSE = 0x00000020;
const FILE_GENERIC_WRITE = 0x00120116;
const FILE_GENERIC_EXECUTE = 0x001200a0;
const DELETE_ACCESS = 0x00010000;
const FILE_WORKSPACE_MODIFY = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE_ACCESS;
const SECURITY_MAX_SID_SIZE = 68;
const ACL_HEADER_SIZE = 8;
const MANDATORY_ACE_OVERHEAD = 8;
const ACL_REVISION = 2;
const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;
const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP = 0x00000001;
const WIN_LOW_LABEL_SID = 66;
const LOCAL_ALLOC_ZEROED = 0x0040;
const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACE_OBJECT_TYPE_PRESENT = 0x00000001;
const ACE_INHERITED_OBJECT_TYPE_PRESENT = 0x00000002;

const SIMPLE_ACE_SID_OFFSET = new Map([
  [0, 8], [1, 8], [2, 8], [3, 8], [9, 8], [10, 8], [13, 8], [14, 8],
  [17, 8], [18, 8], [19, 8], [20, 8], [21, 8],
]);
const OBJECT_ACE_TYPES = new Set([5, 6, 7, 8, 11, 12, 15, 16]);

interface AceRecord {
  readonly type: number;
  readonly flags: number;
  readonly mask: number | undefined;
  readonly sid: AppContainerHandle;
}

function isNull(pointer: AppContainerHandle | null | undefined): boolean {
  return pointer === null || pointer === undefined || pointer === 0 || pointer === 0n;
}

function pointerOffset(pointer: AppContainerHandle, offset: number): AppContainerHandle {
  return typeof pointer === 'bigint' ? pointer + BigInt(offset) : pointer + offset;
}

function bindings(koffi: Koffi) {
  const kernel = koffi.load('kernel32.dll');
  const advapi = koffi.load('advapi32.dll');
  const PVOID = koffi.pointer('void');
  const TRUSTEE_W = koffi.struct({
    pMultipleTrustee: PVOID,
    MultipleTrusteeOperation: 'int32_t',
    TrusteeForm: 'int32_t',
    TrusteeType: 'int32_t',
    ptstrName: PVOID,
  });
  const EXPLICIT_ACCESS_W = koffi.struct({
    grfAccessPermissions: 'uint32_t',
    grfAccessMode: 'int32_t',
    grfInheritance: 'uint32_t',
    Trustee: TRUSTEE_W,
  });
  const ACL_SIZE_INFORMATION = koffi.struct({ AceCount: 'uint32_t', AclBytesInUse: 'uint32_t', AclBytesFree: 'uint32_t' });
  const bind = (library: ReturnType<Koffi['load']>, name: string, result: string | ReturnType<Koffi['pointer']>, args: Array<string | ReturnType<Koffi['pointer']>>) =>
    library.func('__stdcall', name, result, args) as unknown as (...parameters: any[]) => any;
  return {
    PVOID,
    EXPLICIT_ACCESS_W,
    ACL_SIZE_INFORMATION,
    getNamedSecurityInfo: bind(advapi, 'GetNamedSecurityInfoW', 'uint32_t', [
      'str16', 'int32_t', 'uint32_t', koffi.pointer(PVOID), koffi.pointer(PVOID), koffi.pointer(PVOID), koffi.pointer(PVOID), koffi.pointer(PVOID),
    ]),
    convertStringSid: bind(advapi, 'ConvertStringSidToSidW', 'int32_t', ['str16', koffi.pointer(PVOID)]),
    createWellKnownSid: bind(advapi, 'CreateWellKnownSid', 'int32_t', ['uint32_t', PVOID, PVOID, koffi.pointer('uint32_t')]),
    setEntriesInAcl: bind(advapi, 'SetEntriesInAclW', 'uint32_t', ['uint32_t', koffi.pointer(EXPLICIT_ACCESS_W), PVOID, koffi.pointer(PVOID)]),
    setNamedSecurityInfo: bind(advapi, 'SetNamedSecurityInfoW', 'uint32_t', ['str16', 'int32_t', 'uint32_t', PVOID, PVOID, PVOID, PVOID]),
    initializeAcl: bind(advapi, 'InitializeAcl', 'int32_t', [PVOID, 'uint32_t', 'uint32_t']),
    addMandatoryAce: bind(advapi, 'AddMandatoryAce', 'int32_t', [PVOID, 'uint32_t', 'uint32_t', 'uint32_t', PVOID]),
    localAlloc: bind(kernel, 'LocalAlloc', PVOID, ['uint32_t', 'size_t']),
    equalSid: bind(advapi, 'EqualSid', 'int32_t', [PVOID, PVOID]),
    isValidSid: bind(advapi, 'IsValidSid', 'int32_t', [PVOID]),
    getLengthSid: bind(advapi, 'GetLengthSid', 'uint32_t', [PVOID]),
    getAclInformation: bind(advapi, 'GetAclInformation', 'int32_t', [PVOID, PVOID, 'uint32_t', 'int32_t']),
    getAce: bind(advapi, 'GetAce', 'int32_t', [PVOID, 'uint32_t', koffi.pointer(PVOID)]),
    localFree: bind(kernel, 'LocalFree', PVOID, [PVOID]),
    lastError: bind(kernel, 'GetLastError', 'uint32_t', []),
  };
}

function aceSidOffset(koffi: Koffi, ace: AppContainerHandle, type: number): number {
  const simpleOffset = SIMPLE_ACE_SID_OFFSET.get(type);
  if (simpleOffset !== undefined) return simpleOffset;
  if (type === 4) return 12;
  if (OBJECT_ACE_TYPES.has(type)) {
    const objectFlags = Number(koffi.decode(ace, 8, 'uint32_t'));
    return 12
      + ((objectFlags & ACE_OBJECT_TYPE_PRESENT) === 0 ? 0 : 16)
      + ((objectFlags & ACE_INHERITED_OBJECT_TYPE_PRESENT) === 0 ? 0 : 16);
  }
  throw new Error(`unsupported ACE type ${type}; refusing to change an unfamiliar DACL`);
}

function readTargetAces(koffi: Koffi, api: ReturnType<typeof bindings>, dacl: AppContainerHandle, targetSid: AppContainerHandle): AceRecord[] {
  const info = koffi.alloc(api.ACL_SIZE_INFORMATION, 1) as Buffer;
  const aceOut = koffi.alloc(api.PVOID, 1) as Buffer;
  try {
    if (api.getAclInformation(dacl, info, koffi.sizeof(api.ACL_SIZE_INFORMATION), 2) === 0) {
      throw new Error(`GetAclInformation failed with Win32 error ${api.lastError() as number}`);
    }
    const count = Number(koffi.decode(info, 'uint32_t'));
    const matches: AceRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      if (api.getAce(dacl, index, aceOut) === 0) throw new Error(`GetAce(${index}) failed with Win32 error ${api.lastError() as number}`);
      const ace = koffi.decode(aceOut, api.PVOID) as AppContainerHandle;
      const type = Number(koffi.decode(ace, 0, 'uint8_t'));
      const flags = Number(koffi.decode(ace, 1, 'uint8_t'));
      const size = Number(koffi.decode(ace, 2, 'uint16_t'));
      if (size < 8) throw new Error(`ACE ${index} has invalid size ${size}`);
      const sidOffset = aceSidOffset(koffi, ace, type);
      if (sidOffset >= size) throw new Error(`ACE ${index} has no SID at the expected offset`);
      const sid = pointerOffset(ace, sidOffset);
      if (api.isValidSid(sid) === 0) throw new Error(`ACE ${index} contains an invalid SID`);
      if (api.equalSid(sid, targetSid) !== 0) {
        const mask = type === ACCESS_ALLOWED_ACE_TYPE || type === 1 || type === 2 || type === 3 || type === SYSTEM_MANDATORY_LABEL_ACE_TYPE
          ? Number(koffi.decode(ace, 4, 'uint32_t'))
          : undefined;
        matches.push({ type, flags, mask, sid });
      }
    }
    return matches;
  } finally {
    koffi.free(aceOut);
    koffi.free(info);
  }
}

function readDacl(koffi: Koffi, api: ReturnType<typeof bindings>, path: string): { dacl: AppContainerHandle; descriptor: AppContainerHandle } {
  const allocations = [
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
  ];
  const [owner, group, daclOut, sacl, descriptorOut] = allocations;
  try {
    const result = api.getNamedSecurityInfo(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, owner, group, daclOut, sacl, descriptorOut);
    if (result !== 0) throw new Error(`GetNamedSecurityInfoW failed with Win32 error ${result}`);
    const dacl = koffi.decode(daclOut, api.PVOID) as AppContainerHandle;
    const descriptor = koffi.decode(descriptorOut, api.PVOID) as AppContainerHandle;
    if (isNull(dacl)) throw new Error('GetNamedSecurityInfoW returned a null DACL; refusing to replace a permissive null DACL');
    if (isNull(descriptor)) throw new Error('GetNamedSecurityInfoW returned a null security descriptor');
    return { dacl, descriptor };
  } finally {
    for (const allocation of allocations) koffi.free(allocation);
  }
}

function freeNative(api: ReturnType<typeof bindings>, pointer: AppContainerHandle | undefined, operation: string): void {
  if (pointer === undefined || isNull(pointer)) return;
  const result = api.localFree(pointer) as AppContainerHandle;
  if (!isNull(result)) throw new Error(`LocalFree(${operation}) failed`);
}

async function withDirectoryAclLock<T>(path: string, action: () => Promise<T>, lockRoot = dataRoot()): Promise<T> {
  if (lockRoot.trim() === '' || lockRoot.includes('\0') || !isAbsolute(lockRoot)) {
    throw new KernelError('exec_acl_lock_failed', { detail: 'the ACL lock root must be an absolute directory' });
  }
  let canonical: string;
  try { canonical = await realpath(resolve(path)); }
  catch (cause) { throw new KernelError('exec_acl_path_unavailable', { cause }); }
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const directory = join(lockRoot, 'locks', 'windows-acl');
  try { await mkdir(directory, { recursive: true }); }
  catch (cause) { throw new KernelError('exec_acl_lock_failed', { cause }); }
  const target = join(directory, `${createHash('sha256').update(identity).digest('hex')}.target`);
  let handle;
  try {
    handle = await open(target, 'a');
    await handle.close();
  } catch (cause) {
    try { await handle?.close(); } catch { /* Keep the original lock-file error. */ }
    throw new KernelError('exec_acl_lock_failed', { cause });
  }
  let release: (() => Promise<void>);
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 60, factor: 1.2, minTimeout: 10, maxTimeout: 50 },
    });
  } catch (cause) {
    throw new KernelError('exec_acl_lock_failed', { cause });
  }
  try { return await action(); }
  finally {
    try { await release(); }
    catch (cause) { throw new KernelError('exec_acl_unlock_failed', { cause }); }
  }
}

async function updateDirectoryAce(
  path: string,
  sid: AppContainerHandle | string,
  action: 'grant' | 'revoke',
  accessMask: number,
  kind: 'read' | 'workspace-write',
  lockRoot = dataRoot(),
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows directory ACLs are available only on Windows');
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) throw new TypeError('directory path must be a non-empty Windows path');
  if ((typeof sid !== 'string' && isNull(sid)) || (typeof sid === 'string' && (sid.trim() === '' || sid.includes('\0')))) {
    throw new TypeError('directory access SID is required');
  }
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  let targetSid: AppContainerHandle;
  let ownedSid = false;
  if (typeof sid === 'string') {
    const sidOut = koffi.alloc(api.PVOID, 1) as Buffer;
    try {
      if (api.convertStringSid(sid, sidOut) === 0) throw new Error(`ConvertStringSidToSidW failed with Win32 error ${api.lastError() as number}`);
      targetSid = koffi.decode(sidOut, api.PVOID) as AppContainerHandle;
      if (isNull(targetSid)) throw new Error('ConvertStringSidToSidW returned a null SID');
      ownedSid = true;
    } finally { koffi.free(sidOut); }
  } else {
    targetSid = sid;
  }
  const canonical = await realpath(resolve(path));
  try { return await withDirectoryAclLock(canonical, async () => {
  const current = readDacl(koffi, api, canonical);
  let newDacl: AppContainerHandle | undefined;
  let primaryError: unknown;
  try {
    const matches = readTargetAces(koffi, api, current.dacl, targetSid);
    if (action === 'grant' && matches.length !== 0) {
      throw new Error(`target SID already has an ACE; refusing to alter pre-existing ${kind} permissions`);
    }
    if (action === 'revoke') {
      if (matches.length === 0) return;
      if (matches.length !== 1) throw new Error(`expected exactly one target SID ACE before revoke, found ${matches.length}`);
      const [match] = matches;
      if (match?.type !== ACCESS_ALLOWED_ACE_TYPE || match.mask !== accessMask || match.flags !== OBJECT_AND_CONTAINER_INHERIT) {
        throw new Error('target SID ACE changed; refusing to revoke a modified permission');
      }
    }

    const entry = koffi.alloc(api.EXPLICIT_ACCESS_W, 1) as Buffer;
    let daclOut = koffi.alloc(api.PVOID, 1) as Buffer;
    try {
      koffi.encode(entry, api.EXPLICIT_ACCESS_W, {
        grfAccessPermissions: action === 'grant' ? accessMask : 0,
        grfAccessMode: action === 'grant' ? GRANT_ACCESS : REVOKE_ACCESS,
        grfInheritance: OBJECT_AND_CONTAINER_INHERIT,
        Trustee: { pMultipleTrustee: 0n, MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: targetSid },
      });
      const mergeResult = api.setEntriesInAcl(1, entry, current.dacl, daclOut);
      if (mergeResult !== 0) throw new Error(`SetEntriesInAclW(${action}) failed with Win32 error ${mergeResult}`);
      newDacl = koffi.decode(daclOut, api.PVOID) as AppContainerHandle;
      if (isNull(newDacl)) throw new Error('SetEntriesInAclW returned a null DACL');
      const applyResult = api.setNamedSecurityInfo(canonical, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, 0n, 0n, newDacl, 0n);
      if (applyResult !== 0) throw new Error(`SetNamedSecurityInfoW(${action}) failed with Win32 error ${applyResult}`);
    } finally {
      freeNative(api, newDacl, 'merged DACL');
      newDacl = undefined;
      koffi.free(daclOut);
      koffi.free(entry);
    }

      const updated = readDacl(koffi, api, canonical);
    try {
      const updatedMatches = readTargetAces(koffi, api, updated.dacl, targetSid);
      if (action === 'grant') {
        if (updatedMatches.length !== 1 || updatedMatches[0]?.type !== ACCESS_ALLOWED_ACE_TYPE
          || updatedMatches[0].mask !== accessMask || updatedMatches[0].flags !== OBJECT_AND_CONTAINER_INHERIT) {
          throw new Error(`target SID ${kind} ACE did not match the requested permission after grant`);
        }
      } else if (updatedMatches.length !== 0) {
        throw new Error('target SID ACE remained after revoke');
      }
    } finally {
      freeNative(api, updated.descriptor, 'updated security descriptor');
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: Error[] = [];
    try { freeNative(api, newDacl, 'merged DACL'); }
    catch (error) { cleanupErrors.push(error as Error); }
    try { freeNative(api, current.descriptor, 'security descriptor'); }
    catch (error) { cleanupErrors.push(error as Error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors], 'AppContainer directory ACL cleanup failed');
    }
  }
  }, lockRoot); }
  finally {
    if (ownedSid) freeNative(api, targetSid!, 'converted SID');
  }
}

export interface AppContainerDirectoryReadGrant {
  readonly workspaceRoot: string;
}

export async function createAppContainerDirectoryReadGrant(path: string): Promise<AppContainerDirectoryReadGrant> {
  const workspaceRoot = await realpath(resolve(path));
  return Object.freeze({ workspaceRoot });
}

export async function grantAppContainerDirectoryRead(
  pathOrGrant: string | AppContainerDirectoryReadGrant,
  sid: AppContainerHandle,
): Promise<AppContainerDirectoryReadGrant> {
  const grant = typeof pathOrGrant === 'string'
    ? await createAppContainerDirectoryReadGrant(pathOrGrant)
    : pathOrGrant;
  await updateDirectoryAce(grant.workspaceRoot, sid, 'grant', FILE_GENERIC_READ | FILE_TRAVERSE, 'read');
  return grant;
}

export async function revokeAppContainerDirectoryRead(
  grant: AppContainerDirectoryReadGrant,
  sid: AppContainerHandle,
): Promise<void> {
  await updateDirectoryAce(grant.workspaceRoot, sid, 'revoke', FILE_GENERIC_READ | FILE_TRAVERSE, 'read');
}

export async function grantRestrictedDirectoryWrite(path: string, sid: AppContainerHandle | string, lockRoot?: string): Promise<void> {
  await updateDirectoryAce(path, sid, 'grant', FILE_WORKSPACE_MODIFY, 'workspace-write', lockRoot);
}

export async function revokeRestrictedDirectoryWrite(path: string, sid: AppContainerHandle | string, lockRoot?: string): Promise<void> {
  await updateDirectoryAce(path, sid, 'revoke', FILE_WORKSPACE_MODIFY, 'workspace-write', lockRoot);
}

function lowIntegritySid(koffi: Koffi, api: ReturnType<typeof bindings>): Buffer {
  const sid = koffi.alloc('uint8_t', SECURITY_MAX_SID_SIZE) as Buffer;
  const size = koffi.alloc('uint32_t', 1) as Buffer;
  try {
    koffi.encode(size, 'uint32_t', SECURITY_MAX_SID_SIZE);
    if (api.createWellKnownSid(WIN_LOW_LABEL_SID, 0n, sid, size) === 0) {
      throw new Error(`CreateWellKnownSid(Low Integrity) failed with Win32 error ${api.lastError() as number}`);
    }
    if (api.isValidSid(sid) === 0) throw new Error('CreateWellKnownSid(Low Integrity) returned an invalid SID');
    return sid;
  } catch (error) {
    koffi.free(sid);
    throw error;
  } finally {
    koffi.free(size);
  }
}

function readLabelAcl(koffi: Koffi, api: ReturnType<typeof bindings>, path: string): { acl: AppContainerHandle | null; descriptor: AppContainerHandle } {
  const outputs = Array.from({ length: 5 }, () => koffi.alloc(api.PVOID, 1) as Buffer);
  const [owner, group, dacl, sacl, descriptorOut] = outputs;
  try {
    const result = api.getNamedSecurityInfo(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, owner, group, dacl, sacl, descriptorOut);
    if (result !== 0) throw new Error(`GetNamedSecurityInfoW(label) failed with Win32 error ${result}`);
    const acl = koffi.decode(sacl, api.PVOID) as AppContainerHandle;
    const descriptor = koffi.decode(descriptorOut, api.PVOID) as AppContainerHandle;
    if (isNull(descriptor)) throw new Error('GetNamedSecurityInfoW(label) returned a null security descriptor');
    return { acl: isNull(acl) ? null : acl, descriptor };
  } finally {
    for (const output of outputs) koffi.free(output);
  }
}

function aceCount(koffi: Koffi, api: ReturnType<typeof bindings>, acl: AppContainerHandle): number {
  const infoType = api.ACL_SIZE_INFORMATION;
  const info = koffi.alloc(infoType, 1) as Buffer;
  try {
    if (api.getAclInformation(acl, info, koffi.sizeof(infoType), 2) === 0) {
      throw new Error(`GetAclInformation(label) failed with Win32 error ${api.lastError() as number}`);
    }
    return Number(koffi.decode(info, 'uint32_t'));
  } finally { koffi.free(info); }
}

async function addLowIntegrityLabel(path: string): Promise<void> {
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  const lowSid = lowIntegritySid(koffi, api);
  const lowSidPointer = koffi.address(lowSid) as AppContainerHandle;
  let current: ReturnType<typeof readLabelAcl> | undefined;
  let labelAcl: AppContainerHandle | undefined;
  let primaryError: unknown;
  try {
    current = await withDirectoryAclLock(path, async () => readLabelAcl(koffi, api, path));
    if (current.acl !== null && aceCount(koffi, api, current.acl) > 0) {
      throw new Error('the private temp directory already has a mandatory label; refusing to replace it');
    }
    const sidLength = Number(api.getLengthSid(lowSidPointer));
    if (sidLength <= 0) throw new Error('GetLengthSid(Low Integrity) returned an invalid size');
    const aclLength = ACL_HEADER_SIZE + MANDATORY_ACE_OVERHEAD + sidLength;
    labelAcl = api.localAlloc(LOCAL_ALLOC_ZEROED, aclLength) as AppContainerHandle;
    if (isNull(labelAcl)) throw new Error(`LocalAlloc(label ACL) failed with Win32 error ${api.lastError() as number}`);
    if (api.initializeAcl(labelAcl, aclLength, ACL_REVISION) === 0) {
      throw new Error(`InitializeAcl(label) failed with Win32 error ${api.lastError() as number}`);
    }
    if (api.addMandatoryAce(labelAcl, ACL_REVISION, OBJECT_AND_CONTAINER_INHERIT, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowSidPointer) === 0) {
      throw new Error(`AddMandatoryAce(Low Integrity) failed with Win32 error ${api.lastError() as number}`);
    }
    await withDirectoryAclLock(path, async () => {
      const latest = readLabelAcl(koffi, api, path);
      try {
        if (latest.acl !== null && aceCount(koffi, api, latest.acl) > 0) {
          throw new Error('the private temp directory label changed before grant');
        }
      } finally { freeNative(api, latest.descriptor, 'temp label descriptor'); }
      const result = api.setNamedSecurityInfo(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, 0n, 0n, 0n, labelAcl);
      if (result !== 0) throw new Error(`SetNamedSecurityInfoW(label grant) failed with Win32 error ${result}`);
    });
    const updated = await withDirectoryAclLock(path, async () => readLabelAcl(koffi, api, path));
    try {
      if (updated.acl === null) throw new Error('the Low Integrity label is missing after grant');
      const matches = readTargetAces(koffi, api, updated.acl, lowSidPointer);
      if (matches.length !== 1 || matches[0]?.type !== SYSTEM_MANDATORY_LABEL_ACE_TYPE
        || matches[0].mask !== SYSTEM_MANDATORY_LABEL_NO_WRITE_UP || matches[0].flags !== OBJECT_AND_CONTAINER_INHERIT) {
        throw new Error('the Low Integrity label does not match the temporary write permission');
      }
    } finally { freeNative(api, updated.descriptor, 'updated temp label descriptor'); }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    try { freeNative(api, labelAcl, 'temporary Low Integrity ACL'); }
    catch (error) { failures.push(error); }
    if (current !== undefined) {
      try { freeNative(api, current.descriptor, 'original temp label descriptor'); }
      catch (error) { failures.push(error); }
    }
    try { koffi.free(lowSid); }
    catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'temporary Low Integrity label cleanup failed');
  }
}

async function removeLowIntegrityLabel(path: string): Promise<void> {
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  const lowSid = lowIntegritySid(koffi, api);
  const lowSidPointer = koffi.address(lowSid) as AppContainerHandle;
  try {
    await withDirectoryAclLock(path, async () => {
      const current = readLabelAcl(koffi, api, path);
      try {
        if (current.acl === null) return;
        const matches = readTargetAces(koffi, api, current.acl, lowSidPointer);
        if (aceCount(koffi, api, current.acl) !== 1 || matches.length !== 1
          || matches[0]?.type !== SYSTEM_MANDATORY_LABEL_ACE_TYPE
          || matches[0].mask !== SYSTEM_MANDATORY_LABEL_NO_WRITE_UP
          || matches[0].flags !== OBJECT_AND_CONTAINER_INHERIT) {
          throw new Error('the temp mandatory label changed; refusing to remove it');
        }
        const result = api.setNamedSecurityInfo(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, 0n, 0n, 0n, 0n);
        if (result !== 0) throw new Error(`SetNamedSecurityInfoW(label revoke) failed with Win32 error ${result}`);
      } finally { freeNative(api, current.descriptor, 'temp label descriptor'); }
    });
  } finally { koffi.free(lowSid); }
}

export async function grantAppContainerTempDirectoryWrite(path: string, sid: AppContainerHandle): Promise<void> {
  await grantRestrictedDirectoryWrite(path, sid);
  try { await addLowIntegrityLabel(path); }
  catch (error) {
    await revokeRestrictedDirectoryWrite(path, sid).catch(() => {});
    throw error;
  }
}

export async function revokeAppContainerTempDirectoryWrite(path: string, sid: AppContainerHandle): Promise<void> {
  const failures: unknown[] = [];
  try { await removeLowIntegrityLabel(path); }
  catch (error) { failures.push(error); }
  try { await revokeRestrictedDirectoryWrite(path, sid); }
  catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, 'AppContainer temp directory ACL cleanup failed');
}
