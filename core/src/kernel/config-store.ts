// Host 通过此模块读写配置，并由此解析层名与文件的对应关系。
// 仅用户配置和当前项目的本地配置可写；项目共享配置随代码库维护，命令行和管理端配置只读。
// 只读层优先级更高时，写入较低层不会改变当前有效值。
import { configPaths } from './config-file.js';
import {
  EDITABLE,
  editableField,
  mcpServersOfLayer,
  readConfigLayer,
  rulesOfLayer,
  writeConfigField,
  type PolicyRule,
  type WriteRequest,
} from './config-edit.js';
import { KernelError } from './error.js';
import { createConfig, mergePolicyRules, type ConfigSnapshot } from './config.js';

const LAYERS = ['user', 'projectLocal'];
// 按优先级从高到低查找配置值：命令行、本地项目、共享项目、用户配置。
const PRECEDENCE = ['flag', 'local', 'project', 'user'] as const;
type Source = typeof PRECEDENCE[number] | 'merged' | 'none';

/** 加载时读取的四层配置。`read()` 会刷新两个可写层的当前文件内容。 */
export type LoadedLayers = Partial<Record<(typeof PRECEDENCE)[number], Record<string, unknown>>>;

const inLayer = (layer: Record<string, unknown> | undefined, path: readonly string[]): boolean => {
  let node: unknown = layer;
  for (const part of path) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
};

const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

// 按层展示的 MCP 服务器表；只保留界面编辑所需字段，环境值仅接受引用形式。
// 该层没有定义或结构读不懂时返回 undefined，不伪装成空表。
function serversShownOfLayer(table: Record<string, unknown>): Record<string, { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> }> | undefined {
  try {
    const servers = mcpServersOfLayer(table);
    if (Object.keys(servers).length === 0 && !inLayer(table, ['mcp', 'servers'])) return undefined;
    const shown: Record<string, { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> }> = {};
    for (const [name, entry] of Object.entries(servers)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const given = entry as Record<string, unknown>;
      const env = given.env;
      const envShown: Record<string, string> = {};
      if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
        for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
          if (typeof value === 'string' && ENV_REFERENCE.test(value)) envShown[key] = value;
        }
      }
      shown[name] = {
        ...(typeof given.command === 'string' ? { command: given.command } : {}),
        ...(Array.isArray(given.args) && given.args.every((item) => typeof item === 'string') ? { args: given.args as string[] } : {}),
        ...(typeof given.cwd === 'string' ? { cwd: given.cwd } : {}),
        ...(Object.keys(envShown).length === 0 ? {} : { env: envShown }),
      };
    }
    return shown;
  } catch {
    return undefined;
  }
}

/** 指定配置层中的字段值；字段不存在时返回 undefined。 */
const valueIn = (layer: Record<string, unknown> | undefined, path: readonly string[]): unknown =>
  path.reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], layer);

export function createConfigStore({ projectRoot, userHome, layers = {} }: { projectRoot: string; userHome?: string; layers?: LoadedLayers }) {
  const files = configPaths(projectRoot, userHome);
  const pathOf = (layer: string): string => {
    if (layer === 'user') return files.user;
    if (layer === 'projectLocal') return files.local;
    throw new KernelError('config_layer_unknown', { detail: `writable layers: ${LAYERS.join(', ')}` });
  };
  // 将界面使用的层名映射到加载器配置对象中的键，例如 `projectLocal` 对应 `local`。
  const keyOfLayer = (layer: string) => (layer === 'user' ? 'user' : 'local');
  const holderOf = (field: string) => PRECEDENCE.find((layer) => inLayer(layers[layer], editableField(field).path));
  const sourceOf = (field: string): Source => holderOf(field) ?? 'none';
  // 按优先级从高到低返回第一个定义该字段的配置值。
  const valueOf = (field: string): unknown => {
    const layer = holderOf(field);
    return layer === undefined ? undefined : valueIn(layers[layer], editableField(field).path);
  };
  const resolvedRules = () => mergePolicyRules(PRECEDENCE.flatMap((source) => {
    const rules = (layers[source]?.policy as Record<string, unknown> | undefined)?.rules;
    return Array.isArray(rules) ? [{ source, rules }] : [];
  }));
  const effectiveRules = (): PolicyRule[] => resolvedRules().rules as PolicyRule[];
  const rulesSource = (): Source => {
    const sources = new Set(resolvedRules().sources);
    if (sources.size > 1) return 'merged';
    if (sources.size === 1) return [...sources][0] as Source;
    return PRECEDENCE.find((source) => Array.isArray((layers[source]?.policy as Record<string, unknown> | undefined)?.rules)) ?? 'none';
  };
  // 白名单中的标量字段；规则表作为整体单独处理。
  const scalarFields = Object.keys(EDITABLE).filter((field) => editableField(field).kind !== 'rules');
  // 将白名单标量按配置文件结构组合为 `model` 和 `policy` 两组字段。
  const foldValues = (): Record<string, Record<string, unknown>> => {
    const values: Record<string, Record<string, unknown>> = {};
    for (const field of scalarFields) {
      const [table, key] = editableField(field).path;
      (values[table] ??= {})[key] = valueOf(field);
    }
    // 档位的语义标记不是可写字段，只在读取时跟着它所在的那一层一起带出来；
    // 上层据此区分“新写法里的 never”和“旧文件里的 never”。
    const modeSource = sourceOf('policy.mode');
    const semantics = modeSource === 'none' || modeSource === 'merged'
      ? undefined
      : (layers[modeSource]?.policy as Record<string, unknown> | undefined)?.semantics;
    if (semantics !== undefined) (values.policy ??= {}).semantics = semantics;
    return values;
  };
  // 一次读取两个可写层的文件，并同时返回字段值、字段来源、有效规则和用于后续写入的版本。
  // 只读的项目共享层和命令行层保持加载时的快照，不伪装成文件当前内容。
  // 此接口只供设置页面读取，不影响权限判定、模型提供方或会话记录。
  const readNow = async () => {
    const readLayers = await Promise.all(
      LAYERS.map(async (layer) => {
        const { version, table } = await readConfigLayer(pathOf(layer));
        layers[keyOfLayer(layer)] = table;
        // 只有实际定义规则表的配置层才返回来源；未定义时不伪装成空数组。
        const written = inLayer(table, ['policy', 'rules']);
        // 该层实际定义的 MCP 服务器表随版本一同返回；环境值只保留 ${NAME} 引用，
        // 手写明文凭据不进入界面。结构无法解析的层不返回服务器表。
        const mcpServers = serversShownOfLayer(table);
        return {
          layer,
          version,
          exists: version !== '',
          ...(written ? { rules: rulesOfLayer(table) } : {}),
          ...(mcpServers === undefined ? {} : { mcpServers }),
        };
      }),
    );
    return {
      layers: readLayers,
      // 返回每个白名单字段当前由哪一层提供。`flag` 表示只读的命令行 `--config` 层。
      sources: Object.fromEntries(Object.keys(EDITABLE).map((field) => [field, sourceOf(field)])),
      values: foldValues(),
      // 返回按规则身份合并后的有效表，以及每条规则的真实来源。
      rules: effectiveRules(),
      ruleSources: resolvedRules().sources,
      ruleLayers: Object.fromEntries(PRECEDENCE.map((source) => [source, rulesOfLayer(layers[source] ?? {})])),
      rulesSource: rulesSource(),
    };
  };
  const preview = async (layer: string, table: Record<string, unknown>): Promise<ConfigSnapshot> => {
    pathOf(layer);
    await readNow();
    return createConfig({ ...layers, [keyOfLayer(layer)]: table });
  };
  return {
    read: readNow,
    preview,
    write(request: WriteRequest & { layer: string }, validate?: (candidate: ConfigSnapshot, editedLayer: Record<string, unknown>) => void | Promise<void>) {
      const definition = editableField(request.field);
      const file = pathOf(request.layer);
      // 写入前记录当前有效值，以便判断本次写入是否改变了运行配置。
      // 如果更高优先级层覆盖该字段，写入前后有效值相同，运行中的配置不会变化。
      const before = definition.kind === 'rules' ? JSON.stringify(effectiveRules()) : JSON.stringify(valueOf(request.field));
      return writeConfigField(file, request, validate === undefined ? undefined : async (table) => {
        await validate(await preview(request.layer, table), table);
      }).then(async (written) => {
        // 保存后重新计算有效值和来源，并从同一次读取中取得版本号。
        // 这样可以基于一致状态报告写入是否影响当前运行配置。
        const fresh = await readNow();
        const source = definition.kind === 'rules' ? fresh.rulesSource : fresh.sources[request.field];
        const holder = keyOfLayer(request.layer);
        const effective = definition.kind === 'rules' ? fresh.rules : fresh.values[definition.path[0]]?.[definition.path[1]];
        const shadowed = definition.kind === 'rules'
          ? !fresh.ruleSources.includes(holder)
          : source !== holder;
        return {
          ...written,
          // 返回受影响的模型字段，供 Host 更新提供方，而无需重复维护字段白名单。
          key: definition.path[1],
          table: definition.path[0],
          shadowed,
          shadowedBy: shadowed ? source : undefined,
          changed: JSON.stringify(effective) !== before,
          effective,
          layers: fresh.layers,
        };
      });
    },
  };
}
