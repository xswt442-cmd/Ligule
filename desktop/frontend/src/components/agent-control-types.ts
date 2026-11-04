export type PermissionProfile = 'read-only' | 'workspace-write' | 'full-access';
export type NetworkLimit = 'disabled' | 'policy' | 'unrestricted';
export type PolicySelection = 'always' | 'ask' | 'auto' | 'never';
export type PolicyMode = PolicySelection;

export type Grant = {
  id: string;
  name: string;
  projectRoot: string;
  source: 'trusted-ui' | 'legacy';
  defaultPermissionProfile: PermissionProfile;
  maxPermissionProfile: PermissionProfile;
  defaultNetwork: NetworkLimit;
  maxNetwork: NetworkLimit;
  defaultPolicy: PolicyMode;
  allowedPolicies: PolicyMode[];
  allowOperator: boolean;
  allowScreenCapture?: boolean;
  confirmedScreenCapture?: boolean;
  allowedMcpServers: string[];
  allowedMcpTools: string[];
  confirmedFullAccess: boolean;
  confirmedUnrestrictedNetwork: boolean;
  confirmedPartialWorkspaceWrite: boolean;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};
