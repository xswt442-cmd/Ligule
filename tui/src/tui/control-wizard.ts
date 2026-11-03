// 外控授权向导的输入解析、上下限校验和步骤流转。
// 这里不接触 Host 请求、React 状态或消息展示，聊天界面只负责把用户输入交给它、再执行返回的动作。
export type ControlPermissionProfile = 'read-only' | 'workspace-write' | 'full-access';
export type ControlNetworkScope = 'disabled' | 'policy' | 'unrestricted';
export type ControlPolicyMode = 'always' | 'ask' | 'auto' | 'never';

export type ControlWizardValues = {
  name?: string;
  defaultPermissionProfile?: ControlPermissionProfile;
  maxPermissionProfile?: ControlPermissionProfile;
  defaultNetwork?: ControlNetworkScope;
  maxNetwork?: ControlNetworkScope;
  defaultPolicy?: ControlPolicyMode;
  allowedPolicies?: ControlPolicyMode[];
  allowOperator?: boolean;
  allowedMcpServers?: string[];
  allowedMcpTools?: string[];
  expiresAt?: string | null;
  confirmFullAccess?: boolean;
  confirmUnrestrictedNetwork?: boolean;
  confirmPartialWorkspaceWrite?: boolean;
  confirmWorkspaceTrust?: boolean;
};

export type ControlWizard = {
  readonly step: number;
  readonly values: ControlWizardValues;
  readonly mcpServers: readonly string[];
  readonly mcpTools: readonly string[];
};

// 界面把中英文成对文案交给向导，向导只返回结果，不直接渲染。
export type WizardText = (zh: string, en: string) => string;

export type ControlWizardOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'abort'; readonly message: string }
  | { readonly kind: 'step'; readonly wizard: ControlWizard }
  | { readonly kind: 'mcp-servers'; readonly values: ControlWizardValues }
  | { readonly kind: 'submit'; readonly values: ControlWizardValues };

const PERMISSION_PROFILES: readonly ControlPermissionProfile[] = ['read-only', 'workspace-write', 'full-access'];
const NETWORK_SCOPES: readonly ControlNetworkScope[] = ['disabled', 'policy', 'unrestricted'];
const POLICY_MODES: readonly ControlPolicyMode[] = ['always', 'ask', 'auto', 'never'];
const PERMISSION_RANK: Readonly<Record<ControlPermissionProfile, number>> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
const NETWORK_RANK: Readonly<Record<ControlNetworkScope, number>> = { disabled: 0, policy: 1, unrestricted: 2 };

/** 确认项只在对应的上限确实需要时出现，跳过没有意义的步骤。 */
export function controlWizardNext(step: number, values: ControlWizardValues): number {
  if (step === 10) return 11;
  if (step === 11) return values.maxPermissionProfile !== 'read-only' ? 12
    : values.maxNetwork === 'unrestricted' ? 14 : -1;
  if (step === 12) return values.maxPermissionProfile === 'full-access' ? 13
    : values.maxNetwork === 'unrestricted' ? 14 : -1;
  if (step === 13) return values.maxNetwork === 'unrestricted' ? 14 : -1;
  if (step === 14) return -1;
  return step + 1;
}

function listOf(input: string): string[] {
  if (input === '' || input.toLowerCase() === 'none') return [];
  return input.split(',').map((part) => part.trim()).filter(Boolean);
}

function distinct(list: readonly string[]): boolean {
  return new Set(list).size === list.length;
}

function confirmed(input: string): boolean {
  return input.toLowerCase() === 'y' || input.toLowerCase() === 'yes';
}

/**
 * 解析向导当前步骤的一次输入。
 * `step` 分支先做本地校验，全部通过后才交给 `controlWizardNext` 决定下一屏或提交。
 */
export function parseControlWizardInput(wizard: ControlWizard, raw: string, t: WizardText): ControlWizardOutcome {
  const input = raw.trim();
  if (input.toLowerCase() === 'cancel' || input.toLowerCase() === '/cancel') return { kind: 'cancelled' };
  const values: ControlWizardValues = { ...wizard.values };
  const fail = (message: string): ControlWizardOutcome => ({ kind: 'error', message });
  const step = { kind: 'step' as const, wizard: { step: 0, values, mcpServers: wizard.mcpServers, mcpTools: wizard.mcpTools } };

  if (wizard.step === 0) {
    if (input === '' || input.length > 80) return fail(t('名称须为 1 到 80 个字符。', 'Name must contain 1 to 80 characters.'));
    values.name = input;
  } else if (wizard.step === 1 || wizard.step === 2) {
    if (!PERMISSION_PROFILES.includes(input as ControlPermissionProfile)) {
      return fail(t('请输入 read-only、workspace-write 或 full-access。', 'Enter read-only, workspace-write, or full-access.'));
    }
    if (wizard.step === 1) values.defaultPermissionProfile = input as ControlPermissionProfile;
    else {
      const max = input as ControlPermissionProfile;
      if (values.defaultPermissionProfile !== undefined && PERMISSION_RANK[max] < PERMISSION_RANK[values.defaultPermissionProfile]) {
        return fail(t('权限上限不能低于默认权限。', 'The permission ceiling cannot be lower than its default.'));
      }
      values.maxPermissionProfile = max;
    }
  } else if (wizard.step === 3 || wizard.step === 4) {
    if (!NETWORK_SCOPES.includes(input as ControlNetworkScope)) {
      return fail(t('请输入 disabled、policy 或 unrestricted。', 'Enter disabled, policy, or unrestricted.'));
    }
    if (wizard.step === 3) values.defaultNetwork = input as ControlNetworkScope;
    else {
      const max = input as ControlNetworkScope;
      if (values.defaultNetwork !== undefined && NETWORK_RANK[max] < NETWORK_RANK[values.defaultNetwork]) {
        return fail(t('网络上限不能低于默认网络范围。', 'The network ceiling cannot be lower than its default.'));
      }
      values.maxNetwork = max;
    }
  } else if (wizard.step === 5) {
    if (!POLICY_MODES.includes(input as ControlPolicyMode)) {
      return fail(t('请输入 always、ask、auto 或 never。', 'Enter always, ask, auto, or never.'));
    }
    values.defaultPolicy = input as ControlPolicyMode;
  } else if (wizard.step === 6) {
    const allowed = input.split(',').map((part) => part.trim()).filter(Boolean);
    if (allowed.length === 0 || allowed.some((part) => !POLICY_MODES.includes(part as ControlPolicyMode))
      || !distinct(allowed) || !allowed.includes(values.defaultPolicy ?? 'ask')) {
      return fail(t('请输入不重复的 Policy 列表，例如 ask,auto，并包含默认 Policy。', 'Enter distinct Policy modes such as ask,auto, including the default.'));
    }
    values.allowedPolicies = allowed as ControlPolicyMode[];
  } else if (wizard.step === 7) {
    if (!['y', 'yes', 'n', 'no'].includes(input.toLowerCase())) return fail(t('请输入 yes 或 no。', 'Enter yes or no.'));
    values.allowOperator = input.toLowerCase() === 'y' || input.toLowerCase() === 'yes';
  } else if (wizard.step === 8) {
    const allowed = listOf(input);
    if (!distinct(allowed) || allowed.some((server) => !wizard.mcpServers.includes(server))) {
      return fail(t(`请输入已信任的 Server 名称列表：${wizard.mcpServers.join(', ') || 'none'}。`, `Enter a list of trusted server names: ${wizard.mcpServers.join(', ') || 'none'}.`));
    }
    values.allowedMcpServers = allowed;
    values.allowedMcpTools = [];
    // 列工具要问 Host，交给调用方异步完成后再回到第 9 步。
    return { kind: 'mcp-servers', values };
  } else if (wizard.step === 9) {
    const allowed = listOf(input);
    if (!distinct(allowed) || allowed.some((tool) => !wizard.mcpTools.includes(tool))) {
      return fail(t(`请输入可授权清单中的完整能力名：${wizard.mcpTools.join(', ') || 'none'}。`, `Enter exact capability names from the available list: ${wizard.mcpTools.join(', ') || 'none'}.`));
    }
    values.allowedMcpTools = allowed;
  } else if (wizard.step === 10) {
    if (input === '' || input.toLowerCase() === 'none') values.expiresAt = null;
    else {
      const expiry = input.length === 10 ? Date.parse(`${input}T23:59:59`) : Date.parse(input);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        return fail(t('请输入未来的日期/时间或 none。', 'Enter a future date/time or none.'));
      }
      values.expiresAt = new Date(expiry).toISOString();
    }
  } else if (wizard.step === 11) {
    if (!confirmed(input)) return { kind: 'abort', message: t('未确认信任此项目，授权未创建。', 'Project trust was not confirmed; no grant was created.') };
    values.confirmWorkspaceTrust = true;
  } else if (wizard.step === 12) {
    if (!confirmed(input)) return { kind: 'abort', message: t('未确认工作区部分隔离限制，授权未创建。', 'Partial workspace-write limits were not confirmed; no grant was created.') };
    values.confirmPartialWorkspaceWrite = true;
  } else if (wizard.step === 13) {
    if (!confirmed(input)) return { kind: 'abort', message: t('未确认 full-access，授权未创建。', 'Full-access was not confirmed; no grant was created.') };
    values.confirmFullAccess = true;
  } else if (wizard.step === 14) {
    if (!confirmed(input)) return { kind: 'abort', message: t('未确认不受限网络，授权未创建。', 'Unrestricted network was not confirmed; no grant was created.') };
    values.confirmUnrestrictedNetwork = true;
  }

  const next = controlWizardNext(wizard.step, values);
  if (next < 0) return { kind: 'submit', values };
  return { ...step, wizard: { ...step.wizard, step: next } };
}

/** 把向导收集的值映射成 `agent-control.create` 的请求体。 */
export function controlGrantRequest(values: ControlWizardValues, projectRoot: string, version: string): Record<string, unknown> {
  return {
    version,
    grantName: values.name!,
    projectRoot,
    defaultPermissionProfile: values.defaultPermissionProfile!,
    maxPermissionProfile: values.maxPermissionProfile!,
    defaultNetwork: values.defaultNetwork!,
    maxNetwork: values.maxNetwork!,
    defaultPolicy: values.defaultPolicy!,
    allowedPolicyAlways: values.allowedPolicies!.includes('always'),
    allowedPolicyAsk: values.allowedPolicies!.includes('ask'),
    allowedPolicyAuto: values.allowedPolicies!.includes('auto'),
    allowedPolicyNever: values.allowedPolicies!.includes('never'),
    allowOperator: values.allowOperator!,
    allowedMcpServers: values.allowedMcpServers ?? [],
    allowedMcpTools: values.allowedMcpTools ?? [],
    confirmFullAccess: values.confirmFullAccess === true,
    confirmUnrestrictedNetwork: values.confirmUnrestrictedNetwork === true,
    confirmPartialWorkspaceWrite: values.confirmPartialWorkspaceWrite === true,
    confirmWorkspaceTrust: values.confirmWorkspaceTrust === true,
    expiresAt: values.expiresAt ?? '',
  };
}
