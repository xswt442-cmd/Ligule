// 加载器读取用户、项目共享和项目本地配置，并生成 `createConfig` 所需的层对象。
// 用户配置位于 `~/.ligule/config.toml`；项目配置位于 `.ligule/config.toml` 和 `.ligule/config.local.toml`。
// 管理端配置层尚未接入。配置文件不保存密钥，凭据只通过环境变量读取。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { dataRoot } from '../data-root.js';
import { mergeInto } from './config.js';
import { KernelError } from './error.js';
import type { ConfigLayer } from './config.js';

export interface ConfigPaths {
  readonly user: string;
  readonly project: string;
  readonly local: string;
}

export interface ConfigLoadOptions {
  readonly projectRoot: string;
  readonly userHome?: string;
  readonly flags?: readonly string[];
}

export type LoadedConfigLayers = Partial<Record<Exclude<ConfigLayer, 'managed'>, Record<string, unknown>>>;

export const CONFIG_DIRECTORY = '.ligule';
export const CONFIG_FILE = 'config.toml';
export const LOCAL_CONFIG_FILE = 'config.local.toml';
export { dataRoot } from '../data-root.js';

// 项目根和用户主目录由调用方提供；项目根标记由指令加载器解析。
// 用户主目录可显式传入，便于隔离安装和测试。
export function configPaths(projectRoot: string, userHome = homedir()): ConfigPaths {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('config_project_root_required');
  return {
    user: join(dataRoot(userHome), CONFIG_FILE),
    project: join(projectRoot, CONFIG_DIRECTORY, CONFIG_FILE),
    local: join(projectRoot, CONFIG_DIRECTORY, LOCAL_CONFIG_FILE),
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function readLayer(path: string, layer: string): Promise<Record<string, unknown>> {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // 用户、项目共享和项目本地配置文件均可不存在。
    if (errorCode(error) === 'ENOENT') return {};
    throw new KernelError('config_file_read_failed', { cause: error, detail: `${layer}: ${path}` });
  }
  try {
    return parse(text);
  } catch (error) {
    // 解析失败时返回配置层和文件路径，不把损坏文件当成缺失配置。
    throw new KernelError('config_file_invalid', { cause: error, detail: `${layer}: ${path}` });
  }
}

// 将 `a.b=c` 按 TOML 语法解析，由 TOML 决定值类型。
// 多条命令行覆盖按键合并，并复用配置层合并逻辑。
export function flagLayer(flags: readonly string[]): Record<string, unknown> {
  const layer: Record<string, unknown> = {};
  for (const flag of flags) {
    let parsed;
    try {
      parsed = parse(flag);
    } catch (error) {
      throw new KernelError('config_flag_invalid', { cause: error, detail: flag });
    }
    mergeInto(layer, parsed);
  }
  return layer;
}

export async function loadConfigLayers({ projectRoot, userHome, flags = [] }: ConfigLoadOptions): Promise<LoadedConfigLayers> {
  const paths = configPaths(projectRoot, userHome);
  const layers = {
    user: await readLayer(paths.user, 'user'),
    project: await readLayer(paths.project, 'project'),
    local: await readLayer(paths.local, 'local'),
    flag: flagLayer(flags),
  };
  for (const layer of ['project', 'local'] as const) {
    if (Object.hasOwn(layers[layer], 'ripgrepPath')) {
      throw new KernelError('search_backend_source_untrusted', {
        detail: `${layer}: ripgrepPath selects executable code and must be set in user configuration or command-line flags`,
      });
    }
  }
  return layers;
}
