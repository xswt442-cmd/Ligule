import type { Client } from './protocol';

export type SettingsCatalog = {
  projectTrusted: boolean;
  policyDefault: string | null;
  hostNodeVersion: string;
  sessionActive: boolean;
  modes: {
    modes: { name: string; layer: string }[];
    invalid: { name: string; code: string }[];
    truncated: boolean;
  };
  mode: { name: string; layer: string; digest: string; tools: readonly string[] | '*'; prompt: readonly string[] | '*' } | null;
  modeError: string | null;
  sessionMode: { name: string; layer: string } | null;
  pendingMode: string | null;
  modeTools: string[];
  tools: { name: string; description: string; access: string; source: string; disclosure: boolean; includedInMode: boolean; currentlyAvailable: boolean | null }[];
  skills: { name: string; description: string; requires: string[]; source: string }[];
  skillDiagnostics: { code: string }[];
  extensions: { name: string; source: string; enabled: boolean; loaded: boolean; registeredTools: string[] }[];
  extensionDiagnostics: { code: string; source: string }[];
  customToolDiagnostics: { code: string; source: string }[];
};

export async function readSettingsCatalog(client: Client, projectRoot: string, sessionId: string | null, mode?: string): Promise<SettingsCatalog> {
  return await client.call('settings.catalog', {
    ...(projectRoot === '' ? {} : { projectRoot }),
    ...(sessionId === null ? {} : { sessionId }),
    ...(mode === undefined ? {} : { mode }),
  }, 30_000) as SettingsCatalog;
}
