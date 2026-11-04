import { resolve } from 'node:path';
import { createConfig } from '../kernel/config.js';
import { loadConfigLayers } from '../kernel/config-file.js';
import { extensionSources } from '../kernel/extensions.js';
import { readExtensionState } from '../kernel/extension-state.js';
import { DEFAULT_MODE, modeDirectories } from '../kernel/modes.js';
import { readPersistedPolicyMode } from '../kernel/policy.js';
import { KernelRuntimeError } from '../kernel/error.js';
import { hostProviderFromConfig } from './provider.js';
import type { createHost, EnvironmentSeed } from './host.js';

/** 从同一份配置层快照读取项目资源。 */
export async function loadProjectConfig(projectRoot: string, flags: string[] = []) {
  const layers = await loadConfigLayers({ projectRoot, flags });
  const user = { boundary: projectRoot, ...layers.user };
  const config = createConfig({ ...layers, user });
  // 启停登记属于用户范围。登记存在但读不出来时停用名单不可信：
  // 已安装扩展全部退出活动路径（fail-safe 偏向停用），原因进入诊断；
  // 登记损坏与读取失败都不让 Host 启动失败。
  const state = await readExtensionState();
  const extensions = await extensionSources({
    ...layers,
    user,
  }, {
    projectRoot,
    disabled: state.unavailable === undefined ? state.disabled : null,
  });
  if (state.invalid !== undefined) {
    extensions.ignored.push({ code: 'extension_state_invalid', path: 'extensions-state.json', detail: state.invalid });
  }
  if (state.unavailable !== undefined) {
    extensions.ignored.push({ code: 'extension_state_unavailable', path: 'extensions-state.json', detail: state.unavailable });
  }
  return { config, extensions, layers };
}

export async function loadHostEnvironment(projectRoot: string, shippedModes: string, flags: string[] = []): Promise<EnvironmentSeed> {
  const loaded = await loadProjectConfig(projectRoot, flags);
  const config: EnvironmentSeed['config'] = Object.freeze({ ...loaded.config, workspaceRoot: resolve(projectRoot) });
  return {
    ...loaded,
    config,
    provider: hostProviderFromConfig(config),
    // 配置文件里的审批档位按语义标记解释：缺少标记的 `none`/`never` 是历史值，只降级为 `ask`。
    policy: policyFromConfig(config.policy),
    modeName: typeof config.mode === 'string' ? config.mode : DEFAULT_MODE,
    modePaths: modeDirectories(projectRoot, shippedModes),
  };
}

function policyFromConfig(raw: unknown): Parameters<typeof createHost>[0]['policy'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw as Parameters<typeof createHost>[0]['policy'];
  const value = raw as Record<string, unknown>;
  if (value.mode === undefined) return value as Parameters<typeof createHost>[0]['policy'];
  const mode = readPersistedPolicyMode(value.mode, value.semantics);
  if (mode === undefined) {
    throw new KernelRuntimeError('policy_mode_unknown', {
      detail: `policy.mode is ${JSON.stringify(value.mode)}; expected one of always, ask, auto, never (legacy none and never are read as ask)`,
    });
  }
  return { ...value, mode } as Parameters<typeof createHost>[0]['policy'];
}
