import { createMcpRegistry, mcpServerConfigs } from '../capability/mcp.js';
import { browserToolPolicy } from '../capability/browser-policy.js';
import { KernelError } from '../errors.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import { loadAssembly, type Plugin } from '../kernel/assembly.js';
import type { ModeDirectories } from '../kernel/modes.js';
import type { ConfigSnapshot } from '../kernel/config.js';
import type { PolicyMode } from '../kernel/policy.js';
import type { PolicyRule } from '../kernel/config-edit.js';
import { createDecisionChain } from '../kernel/policy.js';
import type { SkillRegistry } from '../kernel/skills.js';
import { createMcpPlugin } from '../tools/mcp.js';
import { createTodoWritePlugin } from '../tools/todo-write.js';
import { createReadImagePlugin } from '../tools/read-image.js';
import { createReadDocumentPlugin } from '../tools/read-document.js';
import { createPresentPlugin } from '../tools/present.js';
import { createScreenshotPlugin } from '../tools/screenshot.js';
import { createAskUserPlugin } from '../tools/ask-user.js';
import { createSkillPlugin } from '../tools/skill.js';
import { createSubagentPlugin } from '../tools/subagent.js';
import { managedProcessPlugin, createManagedProcessRegistry } from '../capability/managed-process.js';
import type { HostProvider } from './provider.js';

interface SettingsToolCatalogOptions {
  readonly config: ConfigSnapshot;
  readonly provider: HostProvider;
  readonly policy?: { readonly mode?: PolicyMode; readonly rules?: PolicyRule[] };
  readonly directory: string;
  readonly modePaths?: ModeDirectories;
  readonly skills: SkillRegistry;
  readonly plugins: readonly Plugin<Kernel>[];
  readonly customToolPlugin?: Plugin<Kernel>;
  readonly searchPlugin?: Plugin<Kernel>;
  readonly mcpConfigs: ReturnType<typeof mcpServerConfigs>;
  readonly interactive: boolean;
}

export async function settingsToolCatalog({ config, provider, policy, directory, modePaths, skills, plugins,
  customToolPlugin, searchPlugin, mcpConfigs, interactive }: SettingsToolCatalogOptions): Promise<ReturnType<Kernel['catalog']>> {
  const kernel = createKernel({ config });
  const mcp = createMcpRegistry(mcpConfigs, { toolPolicy: browserToolPolicy });
  const managedProcesses = createManagedProcessRegistry();
  const basePlugins: Plugin<Kernel>[] = [
    ...plugins,
    ...(searchPlugin === undefined ? [] : [searchPlugin]),
    ...(skills.skills.length === 0 ? [] : [createSkillPlugin(skills, () => mcpConfigs.map((server) => server.name))]),
    createMcpPlugin(mcp),
  ];
  const catalogPlugins: Plugin<Kernel>[] = [
    ...basePlugins,
    createTodoWritePlugin(),
    createReadImagePlugin(),
    createReadDocumentPlugin(),
    createPresentPlugin(),
    createScreenshotPlugin(),
    managedProcessPlugin(managedProcesses),
    ...(interactive ? [createAskUserPlugin({ ask: async () => { throw new KernelError('settings_catalog_not_executable'); } })] : []),
    createSubagentPlugin({
      config,
      provider,
      chain: createDecisionChain({ mode: policy?.mode ?? 'ask', rules: policy?.rules ?? [] }),
      prompt: { staticPrefix: '' },
      directory,
      sessionId: 'settings-catalog',
      plugins: basePlugins,
      customToolPlugin,
      modePaths,
    }),
    ...(customToolPlugin === undefined ? [] : [customToolPlugin]),
  ];
  const assembly = loadAssembly(kernel, catalogPlugins);
  try {
    return kernel.catalog();
  } finally {
    assembly.dispose();
    await Promise.all([mcp.close(), managedProcesses.close()]);
  }
}
