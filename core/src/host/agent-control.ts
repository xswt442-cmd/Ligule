import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { setTimeout as delay } from 'node:timers/promises';
import { dataRoot } from '../kernel/config-file.js';
import { KernelError, KernelRuntimeError } from '../kernel/error.js';
import { POLICY_SEMANTICS } from '../kernel/policy.js';
import type { PermissionNetwork, PermissionProfile } from '../kernel/permission.js';

export type DelegationPolicy = 'always' | 'ask' | 'auto' | 'never';
export type DelegationSource = 'trusted-ui' | 'legacy';

export interface DelegationGrant {
  readonly id: string;
  readonly name: string;
  readonly projectRoot: string;
  readonly source: DelegationSource;
  readonly defaultPermissionProfile: PermissionProfile;
  readonly maxPermissionProfile: PermissionProfile;
  readonly defaultNetwork: PermissionNetwork;
  readonly maxNetwork: PermissionNetwork;
  readonly defaultPolicy: DelegationPolicy;
  readonly allowedPolicies: readonly DelegationPolicy[];
  readonly allowOperator: boolean;
  readonly allowScreenCapture: boolean;
  readonly confirmedScreenCapture: boolean;
  readonly allowedMcpServers: readonly string[];
  readonly allowedMcpTools: readonly string[];
  readonly allowedModes?: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly maxOutputTokens?: number;
  readonly confirmedFullAccess: boolean;
  readonly confirmedUnrestrictedNetwork: boolean;
  readonly confirmedPartialWorkspaceWrite: boolean;
  // 授权文件写入语义版本；缺失表示旧版本写入的 none/never 字面值。
  readonly policySemantics?: number;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export type DelegationEventKind = 'grant.used' | 'permission.selected' | 'permission.denied';

export interface DelegationAuditEvent {
  readonly at: string;
  readonly kind: 'grant.created' | 'grant.revoked' | DelegationEventKind;
  readonly grantId: string;
  readonly source?: DelegationSource;
  readonly permissionProfile?: PermissionProfile;
  readonly network?: PermissionNetwork;
  readonly policy?: DelegationPolicy;
  readonly code?: string;
}

export interface DelegationSnapshot {
  readonly version: string;
  readonly grants: readonly DelegationGrant[];
}

export interface CreateDelegationGrantInput {
  readonly name: string;
  readonly projectRoot: string;
  readonly defaultPermissionProfile: PermissionProfile;
  readonly maxPermissionProfile: PermissionProfile;
  readonly defaultNetwork: PermissionNetwork;
  readonly maxNetwork: PermissionNetwork;
  readonly defaultPolicy: DelegationPolicy;
  readonly allowedPolicies: readonly DelegationPolicy[];
  readonly allowOperator: boolean;
  readonly allowScreenCapture?: boolean;
  readonly confirmScreenCapture?: boolean;
  readonly confirmFullAccess: boolean;
  readonly confirmUnrestrictedNetwork: boolean;
  readonly confirmPartialWorkspaceWrite?: boolean;
  readonly allowedMcpServers?: readonly string[];
  readonly allowedMcpTools?: readonly string[];
  readonly allowedModes?: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly maxOutputTokens?: number;
  readonly expiresAt: string | null;
}

interface DelegationStore {
  readonly schemaVersion: 1;
  readonly grants: DelegationGrant[];
  readonly audit: DelegationAuditEvent[];
}

interface StoreRead {
  readonly store: DelegationStore;
  readonly version: string;
  readonly mode?: number;
}

interface StoreLock {
  assertOwned(): void;
  release(): Promise<void>;
}

const STORE_LIMIT_BYTES = 2 * 1024 * 1024;
const GRANT_LIMIT = 256;
const AUDIT_LIMIT = 2048;
const LOCK_STALE_MS = 10_000;
const PROFILES: readonly PermissionProfile[] = ['read-only', 'workspace-write', 'full-access'];
const NETWORKS: readonly PermissionNetwork[] = ['disabled', 'policy', 'unrestricted'];
const POLICIES: readonly DelegationPolicy[] = ['always', 'ask', 'auto', 'never'];
const PROFILE_RANK: Readonly<Record<PermissionProfile, number>> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
const NETWORK_RANK: Readonly<Record<PermissionNetwork, number>> = { disabled: 0, policy: 1, unrestricted: 2 };

export function delegationPathOf(home = homedir()): string {
  return join(dataRoot(home), 'agent-control.json');
}

function invalidStore(cause?: unknown): KernelError {
  return new KernelError('agent_control_store_invalid', { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isMcpServerName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 128 && !/[\u0000-\u001f/\\]/u.test(value);
}

function isMcpToolCapability(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^mcp:[^/\u0000-\u001f]+\/.+$/u.test(value);
}

function isProfile(value: unknown): value is PermissionProfile {
  return PROFILES.includes(value as PermissionProfile);
}

function isNetwork(value: unknown): value is PermissionNetwork {
  return NETWORKS.includes(value as PermissionNetwork);
}

function isPolicy(value: unknown): value is DelegationPolicy {
  return POLICIES.includes(value as DelegationPolicy);
}

const MODE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
/** A grant may name either a bare model id or the canonical `service/model` reference. */
const MODEL_REF = /^([a-z][a-z0-9.-]{0,63}\/)?[A-Za-z0-9._:+-]{1,128}$/u;
const OUTPUT_TOKENS_MAX = 1_000_000;

function isModeName(value: unknown): value is string {
  return typeof value === 'string' && MODE_NAME.test(value);
}

function isModelRef(value: unknown): value is string {
  return typeof value === 'string' && MODEL_REF.test(value);
}

function isOutputTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= OUTPUT_TOKENS_MAX;
}

function uniqueStrings(value: unknown, check: (one: unknown) => boolean): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((one) => !check(one))) return undefined;
  const list = value as string[];
  return new Set(list).size === list.length ? list : undefined;
}

// 旧授权文件里的档位是旧语义：`none` 与 `never` 都不能升级成新 `never`（跳过审批），
// 一律降级为 `ask`。映射后重新去重；默认档位不在白名单里时整份授权失效，要求重新授权。
function legacyPolicy(value: unknown): DelegationPolicy | undefined {
  if (value === 'none' || value === 'never') return 'ask';
  return value === 'ask' || value === 'auto' ? value : undefined;
}

function validateGrant(value: unknown): DelegationGrant {
  const keys = ['id', 'name', 'projectRoot', 'defaultPermissionProfile', 'maxPermissionProfile', 'defaultNetwork', 'maxNetwork',
    'source', 'defaultPolicy', 'allowedPolicies', 'allowOperator', 'confirmedFullAccess', 'confirmedUnrestrictedNetwork',
    'confirmedPartialWorkspaceWrite', 'allowedMcpServers', 'allowedMcpTools', 'allowedModes', 'allowedModels', 'maxOutputTokens',
    'allowScreenCapture', 'confirmedScreenCapture', 'createdAt', 'expiresAt', 'revokedAt', 'policySemantics'];
  const requiredKeys = keys.filter((key) => !['source', 'confirmedPartialWorkspaceWrite', 'allowedMcpServers', 'allowedMcpTools',
    'allowedModes', 'allowedModels', 'maxOutputTokens', 'allowScreenCapture', 'confirmedScreenCapture'].includes(key));
  const valueRecord = isRecord(value) ? value : {};
  const semantics = valueRecord.policySemantics;
  const legacy = semantics === undefined;
  const normalizedDefault = legacy ? legacyPolicy(valueRecord.defaultPolicy) : isPolicy(valueRecord.defaultPolicy) ? valueRecord.defaultPolicy : undefined;
  const normalizedAllowed = Array.isArray(valueRecord.allowedPolicies)
    ? [...new Set((valueRecord.allowedPolicies as unknown[]).map((one) => legacy ? legacyPolicy(one) : isPolicy(one) ? one : undefined)
      .filter((one): one is DelegationPolicy => one !== undefined))]
    : undefined;
  const mcpServers = Array.isArray(valueRecord.allowedMcpServers) ? valueRecord.allowedMcpServers : [];
  const mcpTools = Array.isArray(valueRecord.allowedMcpTools) ? valueRecord.allowedMcpTools : [];
  const allowedModes = uniqueStrings(valueRecord.allowedModes, isModeName);
  const allowedModels = uniqueStrings(valueRecord.allowedModels, isModelRef);
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))
    || requiredKeys.some((key) => !Object.hasOwn(value, key))
    || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)
    || typeof value.name !== 'string' || value.name.trim() === '' || value.name.length > 80
    || typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot)
    || (value.source !== undefined && value.source !== 'trusted-ui' && value.source !== 'legacy')
    || !isProfile(value.defaultPermissionProfile) || !isProfile(value.maxPermissionProfile)
    || PROFILE_RANK[value.defaultPermissionProfile] > PROFILE_RANK[value.maxPermissionProfile]
    || !isNetwork(value.defaultNetwork) || !isNetwork(value.maxNetwork)
    || NETWORK_RANK[value.defaultNetwork] > NETWORK_RANK[value.maxNetwork]
    || (semantics !== undefined && semantics !== POLICY_SEMANTICS)
    || normalizedDefault === undefined
    || normalizedAllowed === undefined || normalizedAllowed.length === 0
    || !normalizedAllowed.includes(normalizedDefault)
    || typeof value.allowOperator !== 'boolean'
    || (value.allowScreenCapture !== undefined && typeof value.allowScreenCapture !== 'boolean')
    || (value.confirmedScreenCapture !== undefined && typeof value.confirmedScreenCapture !== 'boolean')
    || (value.allowScreenCapture === true && (value.confirmedScreenCapture !== true || value.source !== 'trusted-ui'))
    || typeof value.confirmedFullAccess !== 'boolean'
    || typeof value.confirmedUnrestrictedNetwork !== 'boolean'
    || (value.confirmedPartialWorkspaceWrite !== undefined && typeof value.confirmedPartialWorkspaceWrite !== 'boolean')
    || (value.allowedMcpServers !== undefined && (!Array.isArray(value.allowedMcpServers) || value.allowedMcpServers.some((server) => !isMcpServerName(server))))
    || (value.allowedMcpTools !== undefined && (!Array.isArray(value.allowedMcpTools) || value.allowedMcpTools.some((tool) => !isMcpToolCapability(tool))))
    || (valueRecord.allowedModes !== undefined && allowedModes === undefined)
    || (valueRecord.allowedModels !== undefined && allowedModels === undefined)
    || (value.maxOutputTokens !== undefined && !isOutputTokens(value.maxOutputTokens))
    || new Set(mcpServers).size !== mcpServers.length
    || new Set(mcpTools).size !== mcpTools.length
    || mcpTools.some((tool) => !mcpServers.includes(String(tool).slice(4).split('/')[0]!))
    || (value.maxPermissionProfile === 'full-access' && value.confirmedFullAccess !== true)
    || (value.maxNetwork === 'unrestricted' && value.confirmedUnrestrictedNetwork !== true)
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
    || (value.expiresAt !== null && (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt))))
    || (value.revokedAt !== null && (typeof value.revokedAt !== 'string' || Number.isNaN(Date.parse(value.revokedAt))))) {
    throw invalidStore();
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    projectRoot: value.projectRoot,
    source: value.source === undefined ? 'legacy' : value.source,
    defaultPermissionProfile: value.defaultPermissionProfile,
    maxPermissionProfile: value.maxPermissionProfile,
    defaultNetwork: value.defaultNetwork,
    maxNetwork: value.maxNetwork,
    defaultPolicy: normalizedDefault,
    allowedPolicies: Object.freeze([...normalizedAllowed]) as DelegationPolicy[],
    allowOperator: value.allowOperator,
    allowScreenCapture: value.allowScreenCapture === true,
    confirmedScreenCapture: value.confirmedScreenCapture === true,
    allowedMcpServers: Object.freeze([...mcpServers]) as string[],
    allowedMcpTools: Object.freeze([...mcpTools]) as string[],
    ...(allowedModes === undefined ? {} : { allowedModes: Object.freeze([...allowedModes]) as string[] }),
    ...(allowedModels === undefined ? {} : { allowedModels: Object.freeze([...allowedModels]) as string[] }),
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens as number }),
    confirmedFullAccess: value.confirmedFullAccess,
    confirmedUnrestrictedNetwork: value.confirmedUnrestrictedNetwork,
    confirmedPartialWorkspaceWrite: value.confirmedPartialWorkspaceWrite === true,
    ...(semantics === undefined ? {} : { policySemantics: semantics }),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
  });
}

function validateAudit(value: unknown): DelegationAuditEvent {
  const keys = ['at', 'kind', 'grantId', 'source', 'permissionProfile', 'network', 'policy', 'code'];
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))
    || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))
    || typeof value.grantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.grantId)
    || !['grant.created', 'grant.revoked', 'grant.used', 'permission.selected', 'permission.denied'].includes(String(value.kind))
    || (value.source !== undefined && ((value.source !== 'trusted-ui' && value.source !== 'legacy') || value.kind !== 'grant.created'))
    || (value.permissionProfile !== undefined && !isProfile(value.permissionProfile))
    || (value.network !== undefined && !isNetwork(value.network))
    || (value.policy !== undefined && !isPolicy(value.policy))
    || (value.code !== undefined && (typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value.code)))) {
    throw invalidStore();
  }
  return Object.freeze({
    at: value.at,
    kind: value.kind as DelegationAuditEvent['kind'],
    grantId: value.grantId,
    ...(value.kind === 'grant.created' ? { source: value.source === undefined ? 'legacy' as const : value.source as DelegationSource } : {}),
    ...(value.permissionProfile === undefined ? {} : { permissionProfile: value.permissionProfile as PermissionProfile }),
    ...(value.network === undefined ? {} : { network: value.network as PermissionNetwork }),
    ...(value.policy === undefined ? {} : { policy: value.policy as DelegationPolicy }),
    ...(value.code === undefined ? {} : { code: value.code as string }),
  });
}

function storeVersion(grants: readonly DelegationGrant[]): string {
  return createHash('sha256').update(JSON.stringify(grants)).digest('hex');
}

async function readStore(path: string): Promise<StoreRead> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const store: DelegationStore = { schemaVersion: 1, grants: [], audit: [] };
      return { store, version: storeVersion(store.grants) };
    }
    throw new KernelRuntimeError('agent_control_store_read_failed', { cause: error });
  }
  if (bytes.byteLength > STORE_LIMIT_BYTES) throw new KernelError('agent_control_store_too_large');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (cause) { throw invalidStore(cause); }
  if (!isRecord(value) || !onlyKeys(value, ['schemaVersion', 'grants', 'audit']) || value.schemaVersion !== 1
    || !Array.isArray(value.grants) || value.grants.length > GRANT_LIMIT
    || !Array.isArray(value.audit) || value.audit.length > AUDIT_LIMIT) throw invalidStore();
  const grants = value.grants.map(validateGrant);
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length) throw invalidStore();
  const audit = value.audit.map(validateAudit);
  const store: DelegationStore = { schemaVersion: 1, grants, audit };
  return { store, version: storeVersion(grants), mode: (await stat(path)).mode & 0o777 };
}

async function acquireStoreLock(path: string): Promise<StoreLock> {
  let compromised: Error | undefined;
  let unlock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    unlock = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      stale: LOCK_STALE_MS,
      update: 2_000,
      retries: { retries: 6, minTimeout: 10, maxTimeout: 80 },
      onCompromised: (error) => { compromised = error; },
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') throw new KernelError('agent_control_store_locked', { cause });
    throw new KernelRuntimeError('agent_control_store_lock_failed', { cause });
  }
  return {
    assertOwned() {
      if (compromised !== undefined) throw new KernelRuntimeError('agent_control_store_lock_lost', { cause: compromised });
    },
    async release() {
      if (compromised !== undefined) throw new KernelRuntimeError('agent_control_store_lock_lost', { cause: compromised });
      try { await unlock!(); } catch (cause) { throw new KernelRuntimeError('agent_control_store_unlock_failed', { cause }); }
    },
  };
}

async function writeStore(path: string, before: StoreRead, store: DelegationStore, lock: StoreLock): Promise<void> {
  const json = `${JSON.stringify(store)}\n`;
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.byteLength > STORE_LIMIT_BYTES) throw new KernelError('agent_control_store_too_large');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    lock.assertOwned();
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, before.mode ?? 0o600);
    for (let attempt = 0; ; attempt += 1) {
      lock.assertOwned();
      if ((await readStore(path)).version !== before.version) throw new KernelError('agent_control_version_stale');
      try { await rename(temporary, path); break; }
      catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') || attempt >= 8) {
          throw new KernelRuntimeError('agent_control_store_replace_failed', { cause });
        }
        await delay(Math.min(20 * (2 ** attempt), 200));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function publicSnapshot(store: DelegationStore, version: string): DelegationSnapshot {
  return { version, grants: store.grants };
}

export async function listDelegationGrants(path = delegationPathOf()): Promise<DelegationSnapshot> {
  const { store, version } = await readStore(resolve(path));
  return publicSnapshot(store, version);
}

function checkedInput(input: CreateDelegationGrantInput): Omit<DelegationGrant, 'id' | 'createdAt' | 'revokedAt' | 'source'> {
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 80) throw new KernelError('agent_control_grant_name_invalid');
  if (!isProfile(input.defaultPermissionProfile) || !isProfile(input.maxPermissionProfile)
    || PROFILE_RANK[input.defaultPermissionProfile] > PROFILE_RANK[input.maxPermissionProfile]) throw new KernelError('agent_control_permission_limit_invalid');
  if (!isNetwork(input.defaultNetwork) || !isNetwork(input.maxNetwork)
    || NETWORK_RANK[input.defaultNetwork] > NETWORK_RANK[input.maxNetwork]) throw new KernelError('agent_control_network_limit_invalid');
  if (!isPolicy(input.defaultPolicy) || !Array.isArray(input.allowedPolicies) || input.allowedPolicies.length === 0
    || input.allowedPolicies.some((one) => !isPolicy(one)) || new Set(input.allowedPolicies).size !== input.allowedPolicies.length
    || !input.allowedPolicies.includes(input.defaultPolicy)) throw new KernelError('agent_control_policy_limit_invalid');
  if (typeof input.allowOperator !== 'boolean' || typeof input.confirmFullAccess !== 'boolean'
    || typeof input.confirmUnrestrictedNetwork !== 'boolean'
    || (input.confirmPartialWorkspaceWrite !== undefined && typeof input.confirmPartialWorkspaceWrite !== 'boolean')
    || (input.allowScreenCapture !== undefined && typeof input.allowScreenCapture !== 'boolean')
    || (input.confirmScreenCapture !== undefined && typeof input.confirmScreenCapture !== 'boolean')) {
    throw new KernelError('agent_control_grant_invalid');
  }
  const allowedMcpServers = input.allowedMcpServers ?? [];
  const allowedMcpTools = input.allowedMcpTools ?? [];
  if (!Array.isArray(allowedMcpServers) || allowedMcpServers.some((server) => !isMcpServerName(server))
    || new Set(allowedMcpServers).size !== allowedMcpServers.length
    || !Array.isArray(allowedMcpTools) || allowedMcpTools.some((tool) => !isMcpToolCapability(tool))
    || new Set(allowedMcpTools).size !== allowedMcpTools.length
    || allowedMcpTools.some((tool) => !allowedMcpServers.includes(tool.slice(4).split('/')[0]!))) {
    throw new KernelError('agent_control_mcp_limit_invalid');
  }
  if (input.maxPermissionProfile === 'full-access' && !input.confirmFullAccess) throw new KernelError('agent_control_full_access_confirmation_required');
  if (input.maxNetwork === 'unrestricted' && !input.confirmUnrestrictedNetwork) throw new KernelError('agent_control_unrestricted_network_confirmation_required');
  if (input.allowScreenCapture === true && input.confirmScreenCapture !== true) throw new KernelError('screen_capture_confirmation_required');
  const allowedModes = uniqueStrings(input.allowedModes, isModeName);
  const allowedModels = uniqueStrings(input.allowedModels, isModelRef);
  if ((input.allowedModes !== undefined && allowedModes === undefined)
    || (input.allowedModels !== undefined && allowedModels === undefined)) throw new KernelError('agent_control_scope_invalid');
  if (input.maxOutputTokens !== undefined && !isOutputTokens(input.maxOutputTokens)) throw new KernelError('agent_control_scope_invalid');
  if (input.expiresAt !== null && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))
    || Date.parse(input.expiresAt) <= Date.now())) throw new KernelError('agent_control_expiry_invalid');
  if (typeof input.projectRoot !== 'string' || !isAbsolute(input.projectRoot)) throw new KernelError('agent_control_project_invalid');
  return {
    name: input.name.trim(),
    projectRoot: input.projectRoot,
    defaultPermissionProfile: input.defaultPermissionProfile,
    maxPermissionProfile: input.maxPermissionProfile,
    defaultNetwork: input.defaultNetwork,
    maxNetwork: input.maxNetwork,
    defaultPolicy: input.defaultPolicy,
    allowedPolicies: [...input.allowedPolicies],
    policySemantics: POLICY_SEMANTICS,
    allowOperator: input.allowOperator,
    allowScreenCapture: input.allowScreenCapture === true,
    confirmedScreenCapture: input.allowScreenCapture === true && input.confirmScreenCapture === true,
    allowedMcpServers: [...allowedMcpServers],
    allowedMcpTools: [...allowedMcpTools],
    ...(allowedModes === undefined ? {} : { allowedModes: [...allowedModes] }),
    ...(allowedModels === undefined ? {} : { allowedModels: [...allowedModels] }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    confirmedFullAccess: input.confirmFullAccess,
    confirmedUnrestrictedNetwork: input.confirmUnrestrictedNetwork,
    confirmedPartialWorkspaceWrite: input.confirmPartialWorkspaceWrite === true,
    expiresAt: input.expiresAt,
  };
}

export async function createDelegationGrant(
  path: string,
  input: CreateDelegationGrantInput,
  expectedVersion: string,
): Promise<DelegationSnapshot> {
  const target = resolve(path);
  const checked = checkedInput(input);
  let projectRoot: string;
  try {
    projectRoot = await realpath(checked.projectRoot);
    if (!(await stat(projectRoot)).isDirectory()) throw new KernelError('agent_control_project_invalid');
  } catch (cause) {
    if (cause instanceof KernelError) throw cause;
    throw new KernelError('agent_control_project_invalid', { cause });
  }
  const lock = await acquireStoreLock(target);
  try {
    const before = await readStore(target);
    if (expectedVersion !== before.version) throw new KernelError('agent_control_version_stale');
    if (before.store.grants.length >= GRANT_LIMIT) throw new KernelError('agent_control_grant_limit');
    const now = new Date().toISOString();
    const grant = validateGrant({ ...checked, id: randomUUID(), projectRoot, source: 'trusted-ui', createdAt: now, revokedAt: null });
    const store: DelegationStore = {
      ...before.store,
      grants: [...before.store.grants, grant],
      audit: [...before.store.audit, { at: now, kind: 'grant.created' as const, grantId: grant.id, source: grant.source }].slice(-AUDIT_LIMIT),
    };
    await writeStore(target, before, store, lock);
    return publicSnapshot(store, storeVersion(store.grants));
  } finally { await lock.release(); }
}

export async function revokeDelegationGrant(path: string, id: string, expectedVersion: string): Promise<DelegationSnapshot> {
  const target = resolve(path);
  const lock = await acquireStoreLock(target);
  try {
    const before = await readStore(target);
    if (expectedVersion !== before.version) throw new KernelError('agent_control_version_stale');
    const index = before.store.grants.findIndex((grant) => grant.id === id);
    if (index < 0) throw new KernelError('agent_control_grant_not_found');
    const current = before.store.grants[index]!;
    if (current.revokedAt !== null) throw new KernelError('agent_control_grant_revoked');
    const now = new Date().toISOString();
    const grant = validateGrant({ ...current, revokedAt: now });
    const grants = before.store.grants.map((one, at) => at === index ? grant : one);
    const store: DelegationStore = {
      ...before.store,
      grants,
      audit: [...before.store.audit, { at: now, kind: 'grant.revoked' as const, grantId: id }].slice(-AUDIT_LIMIT),
    };
    await writeStore(target, before, store, lock);
    return publicSnapshot(store, storeVersion(store.grants));
  } finally { await lock.release(); }
}

export async function requireDelegationGrant(path: string, id: string, projectRoot: string): Promise<DelegationGrant> {
  const { store } = await readStore(resolve(path));
  const grant = store.grants.find((one) => one.id === id);
  if (grant === undefined) throw new KernelError('agent_control_grant_not_found');
  if (grant.revokedAt !== null) throw new KernelError('agent_control_grant_revoked');
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now()) throw new KernelError('agent_control_grant_expired');
  if (!isAbsolute(projectRoot)) throw new KernelError('agent_control_project_forbidden');
  let actual: string;
  try { actual = await realpath(projectRoot); } catch { throw new KernelError('agent_control_project_forbidden'); }
  const expectedKey = process.platform === 'win32' ? grant.projectRoot.toLowerCase() : grant.projectRoot;
  const actualKey = process.platform === 'win32' ? actual.toLowerCase() : actual;
  if (actualKey !== expectedKey) throw new KernelError('agent_control_project_forbidden');
  return grant;
}

export function assertDelegationPermission(grant: DelegationGrant, profile: PermissionProfile, network: PermissionNetwork): void {
  if (PROFILE_RANK[profile] > PROFILE_RANK[grant.maxPermissionProfile]
    || NETWORK_RANK[network] > NETWORK_RANK[grant.maxNetwork]) {
    throw new KernelError('agent_control_permission_exceeds_grant');
  }
}

export function assertDelegationPolicy(grant: DelegationGrant, policy: string): asserts policy is DelegationPolicy {
  if (!isPolicy(policy) || !grant.allowedPolicies.includes(policy)) throw new KernelError('agent_control_policy_exceeds_grant');
}

export function assertDelegationMode(grant: DelegationGrant, mode: string): void {
  if (grant.allowedModes !== undefined && !grant.allowedModes.includes(mode)) throw new KernelError('agent_control_mode_denied');
}

/** `selection` is the `service/model` reference; a bare model id is accepted when the grant lists it. */
export function assertDelegationModelSelection(grant: DelegationGrant, selection: string): void {
  if (grant.allowedModels === undefined) return;
  const bare = selection.includes('/') ? selection.slice(selection.indexOf('/') + 1) : selection;
  if (!grant.allowedModels.includes(selection) && !grant.allowedModels.includes(bare)) throw new KernelError('agent_control_model_denied');
}

/** Rejects an explicit output budget above the grant ceiling; `undefined` means the grant does not bound it. */
export function boundedOutputTokens(grant: DelegationGrant | undefined, requested: number): number {
  const ceiling = grant?.maxOutputTokens;
  if (ceiling === undefined) return requested;
  if (requested > ceiling) throw new KernelError('agent_control_output_tokens_exceeds_grant');
  return requested;
}

export function assertDelegationMcpServer(grant: DelegationGrant, server: string): void {
  if (!grant.allowedMcpServers.includes(server)) throw new KernelError('agent_control_mcp_server_denied');
}

export function assertDelegationMcpTool(grant: DelegationGrant, capability: string): void {
  const server = capability.startsWith('mcp:') ? capability.slice(4).split('/')[0] : '';
  assertDelegationMcpServer(grant, server);
  if (!grant.allowedMcpTools.includes(capability)) throw new KernelError('agent_control_mcp_tool_denied');
}

export async function recordDelegationEvent(
  path: string,
  event: Omit<DelegationAuditEvent, 'at'>,
): Promise<void> {
  const target = resolve(path);
  const lock = await acquireStoreLock(target);
  try {
    const before = await readStore(target);
    const auditEvent = validateAudit({ ...event, at: new Date().toISOString() });
    const store: DelegationStore = { ...before.store, audit: [...before.store.audit, auditEvent].slice(-AUDIT_LIMIT) };
    await writeStore(target, before, store, lock);
  } finally { await lock.release(); }
}
