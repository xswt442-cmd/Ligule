// 外控授权草稿的校验与提交映射：只判断草稿是否可继续/可保存，不持有界面状态。
import type { Grant, NetworkLimit, PermissionProfile, PolicySelection } from './components/agent-control-types';

export type GrantDraft = {
  name: string;
  defaultPermissionProfile: PermissionProfile;
  maxPermissionProfile: PermissionProfile;
  defaultNetwork: NetworkLimit;
  maxNetwork: NetworkLimit;
  defaultPolicy: PolicySelection;
  allowedPolicies: PolicySelection[];
  allowOperator: boolean;
  allowScreenCapture: boolean;
  confirmScreenCapture: boolean;
  allowedMcpServers: string[];
  allowedMcpTools: string[];
  confirmFullAccess: boolean;
  confirmUnrestrictedNetwork: boolean;
  confirmPartialWorkspaceWrite: boolean;
  confirmWorkspaceTrust: boolean;
  expiresAt: string;
};

const PROFILE_RANK: Record<PermissionProfile, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
const NETWORK_RANK: Record<NetworkLimit, number> = { disabled: 0, policy: 1, unrestricted: 2 };

/** 新草稿默认只读、禁用网络、24 小时后到期。 */
export function emptyGrantDraft(now = Date.now()): GrantDraft {
  const expiry = new Date(now + 24 * 60 * 60 * 1000);
  const localExpiry = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60_000);
  return {
    name: '',
    defaultPermissionProfile: 'read-only',
    maxPermissionProfile: 'read-only',
    defaultNetwork: 'disabled',
    maxNetwork: 'disabled',
    defaultPolicy: 'ask',
    allowedPolicies: ['ask'],
    allowOperator: false,
    allowScreenCapture: false,
    confirmScreenCapture: false,
    allowedMcpServers: [],
    allowedMcpTools: [],
    confirmFullAccess: false,
    confirmUnrestrictedNetwork: false,
    confirmPartialWorkspaceWrite: false,
    confirmWorkspaceTrust: false,
    expiresAt: localExpiry.toISOString().slice(0, 16),
  };
}

export function sameProjectPath(left: string, right: string): boolean {
  const clean = (value: string) => value.replace(/[\\/]+$/u, '');
  const first = clean(left);
  const second = clean(right);
  return typeof navigator !== 'undefined' && /Windows/u.test(navigator.userAgent)
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

export type GrantDraftFlags = {
  readonly profileExceeds: boolean;
  readonly networkExceeds: boolean;
  readonly policyMissing: boolean;
  readonly mcpLimitInvalid: boolean;
  readonly invalidExpiry: boolean;
};

/** 只报错，不改草稿；界面据此显示逐项提示。 */
export function grantDraftFlags(draft: GrantDraft, now = Date.now()): GrantDraftFlags {
  const expiration = draft.expiresAt === '' ? undefined : Date.parse(draft.expiresAt);
  return {
    profileExceeds: PROFILE_RANK[draft.defaultPermissionProfile] > PROFILE_RANK[draft.maxPermissionProfile],
    networkExceeds: NETWORK_RANK[draft.defaultNetwork] > NETWORK_RANK[draft.maxNetwork],
    policyMissing: !draft.allowedPolicies.includes(draft.defaultPolicy),
    mcpLimitInvalid: draft.allowedMcpTools.some((capability) => {
      const server = capability.startsWith('mcp:') ? capability.slice(4).split('/')[0] : '';
      return !draft.allowedMcpServers.includes(server);
    }),
    invalidExpiry: expiration !== undefined && (!Number.isFinite(expiration) || expiration <= now),
  };
}

/** 能力与上限这一步能否继续：只看能力项与本步内的风险确认。 */
export function limitsReady(draft: GrantDraft): boolean {
  const flags = grantDraftFlags(draft);
  return !flags.profileExceeds && !flags.networkExceeds && !flags.policyMissing && !flags.mcpLimitInvalid
    && (!draft.allowScreenCapture || draft.confirmScreenCapture)
    && (draft.maxPermissionProfile !== 'full-access' || draft.confirmFullAccess)
    && (draft.maxPermissionProfile === 'read-only' || draft.confirmPartialWorkspaceWrite)
    && (draft.maxNetwork !== 'unrestricted' || draft.confirmUnrestrictedNetwork);
}

/** 最终能否创建：在 limitsReady 之上再加项目、名称、到期时间与工作区信任确认。 */
export function grantReady(draft: GrantDraft, project: string, now = Date.now()): boolean {
  return project !== '' && draft.name.trim() !== '' && !grantDraftFlags(draft, now).invalidExpiry
    && draft.confirmWorkspaceTrust && limitsReady(draft);
}

/** agent-control.create 的请求体；字段名与 Host 协议一致，顺序固定便于比对。 */
export function createGrantRequest(draft: GrantDraft, project: string, version: string): Record<string, unknown> {
  const expiration = draft.expiresAt === '' ? '' : new Date(draft.expiresAt).toISOString();
  return {
    version,
    grantName: draft.name,
    projectRoot: project,
    defaultPermissionProfile: draft.defaultPermissionProfile,
    maxPermissionProfile: draft.maxPermissionProfile,
    defaultNetwork: draft.defaultNetwork,
    maxNetwork: draft.maxNetwork,
    defaultPolicy: draft.defaultPolicy,
    allowedPolicyAlways: draft.allowedPolicies.includes('always'),
    allowedPolicyAsk: draft.allowedPolicies.includes('ask'),
    allowedPolicyAuto: draft.allowedPolicies.includes('auto'),
    allowedPolicyNever: draft.allowedPolicies.includes('never'),
    allowOperator: draft.allowOperator,
    allowScreenCapture: draft.allowScreenCapture,
    confirmScreenCapture: draft.confirmScreenCapture,
    allowedMcpServers: draft.allowedMcpServers,
    allowedMcpTools: draft.allowedMcpTools,
    confirmFullAccess: draft.confirmFullAccess,
    confirmUnrestrictedNetwork: draft.confirmUnrestrictedNetwork,
    confirmPartialWorkspaceWrite: draft.confirmPartialWorkspaceWrite,
    confirmWorkspaceTrust: draft.confirmWorkspaceTrust,
    expiresAt: expiration,
  };
}

/** 授权列表上的状态标签，到期与撤销优先于可用。 */
export function grantState(grant: Grant, t: (chinese: string, english: string) => string, now = Date.now()): string {
  if (grant.revokedAt !== null) return t('已撤销', 'Revoked');
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now) return t('已到期', 'Expired');
  return t('可用', 'Available');
}
