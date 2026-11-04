/**
 * Minimal safe presets for the common ways a person hands a Session to an external
 * controller (MCP client or Agent Control bridge).
 *
 * The presets are suggestions for the local UI: they are derived from the same
 * capability decisions the Host enforces, and they deliberately never carry
 * full-access, unrestricted network, Screen Capture, or Operator rights. A person
 * can still choose those through the explicit confirmation flows.
 */

export type ControlPresetId = 'reader' | 'workspace';

export interface ControlPresetSignals {
  /** Whether the platform needs the partial workspace-write warning before granting it. */
  readonly partialWorkspaceWriteConfirmationRequired: boolean;
  /** Whether that warning was already accepted for this session. */
  readonly partialWorkspaceWriteConfirmed: boolean;
}

export interface ControlPreset {
  readonly id: ControlPresetId;
  readonly defaultPermissionProfile: 'read-only' | 'workspace-write';
  readonly maxPermissionProfile: 'read-only' | 'workspace-write';
  readonly defaultNetwork: 'policy';
  readonly maxNetwork: 'policy';
  readonly defaultPolicy: 'ask' | 'always' | 'auto' | 'never';
  readonly allowedPolicies: readonly ('ask' | 'always' | 'auto' | 'never')[];
  readonly allowOperator: false;
  readonly confirmWorkspaceTrust: boolean;
  readonly confirmPartialWorkspaceWrite: boolean;
}

/**
 * Presets for the two external-control situations that do not need a custom grant:
 * observing a Session, and collaborating on a project that the controller may edit.
 * Every other ceiling (full-access, unrestricted network, Operator, Screen Capture,
 * extra MCP servers or tools) must be chosen deliberately, one confirmation at a time.
 */
export function controlPresets(signals: ControlPresetSignals): readonly ControlPreset[] {
  const needsPartialWarning = signals.partialWorkspaceWriteConfirmationRequired && !signals.partialWorkspaceWriteConfirmed;
  return [
    {
      id: 'reader',
      defaultPermissionProfile: 'read-only',
      maxPermissionProfile: 'read-only',
      defaultNetwork: 'policy',
      maxNetwork: 'policy',
      defaultPolicy: 'ask',
      allowedPolicies: ['ask'],
      allowOperator: false,
      // Creating any grant records the human's project-trust confirmation, so each
      // preset carries that explicit yes rather than letting it default silently.
      confirmWorkspaceTrust: true,
      confirmPartialWorkspaceWrite: false,
    },
    {
      id: 'workspace',
      defaultPermissionProfile: 'read-only',
      maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy',
      maxNetwork: 'policy',
      defaultPolicy: 'ask',
      allowedPolicies: ['ask'],
      allowOperator: false,
      confirmWorkspaceTrust: true,
      confirmPartialWorkspaceWrite: needsPartialWarning,
    },
  ];
}

/** The ceilings a preset is allowed to grant, spelled out for the create path. */
export function presetGrantCeiling(preset: ControlPreset): {
  readonly maxPermissionProfile: ControlPreset['maxPermissionProfile'];
  readonly maxNetwork: ControlPreset['maxNetwork'];
  readonly allowOperator: false;
} {
  return { maxPermissionProfile: preset.maxPermissionProfile, maxNetwork: preset.maxNetwork, allowOperator: false };
}
