// 将五层配置合并为只读快照。`LAYER_ORDER` 按优先级从低到高排列，后续层覆盖前序层。
// 文件和命令行参数由加载器读取；Kernel 只接收已合并配置。
import { KernelError } from './error.js';

// 配置层优先级：用户、项目共享、项目本地、命令行参数、管理端。
export const LAYER_ORDER = ['user', 'project', 'local', 'flag', 'managed'] as const;
export type ConfigLayer = typeof LAYER_ORDER[number];
export type ConfigSnapshot = Readonly<Record<string, unknown>>;

// 只有普通对象按字段递归合并；日期时间等类实例整体替换，避免丢失其内部值。
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// 嵌套对象按键合并，数组和标量整体替换，避免拼接出任何配置层都未声明的数组。
// 同一函数也用于合并单层中的多条命令行覆盖。
export function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    // 拒绝 `__proto__` 键，防止不可信的项目配置修改对象原型并影响后续权限判定。
    if (key === '__proto__') throw new KernelError('config_key_unsafe', { detail: key });
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value);
    else target[key] = structuredClone(value);
  }
}

function deepFreeze(value: unknown): unknown {
  if (isPlainObject(value) || Array.isArray(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function ruleIdentity(value: unknown): string | undefined {
  if (!isPlainObject(value) || typeof value.tool !== 'string'
    || (value.match !== undefined && typeof value.match !== 'string')
    || (value.target !== undefined && value.target !== 'file' && value.target !== 'workspace')
    || (value.path !== undefined && typeof value.path !== 'string')
    || (value.argsHash !== undefined && typeof value.argsHash !== 'string')) return undefined;
  return JSON.stringify([value.tool, value.match ?? '', value.target ?? '', value.path ?? '', value.argsHash ?? '']);
}

function decisionRank(value: unknown): number {
  if (!isPlainObject(value)) return 0;
  return value.decision === 'deny' ? 2 : value.decision === 'ask' ? 1 : 0;
}

/** 按优先级从高到低合并规则，同一工具和匹配条件只保留一项判定。 */
export function mergePolicyRules(layers: readonly { readonly source: string; readonly rules: readonly unknown[] }[]): {
  readonly rules: unknown[];
  readonly sources: string[];
} {
  const selected = new Map<string, { rule: unknown; source: string; rank: number }>();
  for (const layer of layers) {
    const withinLayer = new Map<string, { rule: unknown; rank: number }>();
    layer.rules.forEach((rule, index) => {
      const identity = ruleIdentity(rule) ?? `invalid:${layer.source}:${index}`;
      const rank = decisionRank(rule);
      const existing = withinLayer.get(identity);
      if (existing === undefined) withinLayer.set(identity, { rule, rank });
      else if (rank > existing.rank) withinLayer.set(identity, { rule, rank });
    });
    for (const [identity, entry] of withinLayer) {
      if (!selected.has(identity)) selected.set(identity, { ...entry, source: layer.source });
    }
  }
  const entries = [...selected.values()];
  return { rules: entries.map((entry) => entry.rule), sources: entries.map((entry) => entry.source) };
}

export function createConfig(layers: unknown): ConfigSnapshot {
  if (!isPlainObject(layers)) throw new KernelError('config_layers_must_be_object');
  for (const name of Object.keys(layers)) {
    // 未知配置层会导致整层被忽略，因此必须立即返回错误。
    if (!LAYER_ORDER.some((layer) => layer === name)) throw new KernelError('config_layer_unknown');
    if (layers[name] !== undefined && !isPlainObject(layers[name])) throw new KernelError('config_layer_must_be_object');
  }
  const snapshot: Record<string, unknown> = {};
  for (const name of LAYER_ORDER) {
    const layer = layers[name];
    if (layer !== undefined) {
      if (!isPlainObject(layer)) throw new KernelError('config_layer_must_be_object');
      mergeInto(snapshot, layer);
    }
  }
  if (isPlainObject(snapshot.policy)) {
    const rules = [...LAYER_ORDER].reverse().flatMap((source) => {
      const layer = layers[source];
      if (!isPlainObject(layer) || !isPlainObject(layer.policy) || !Array.isArray(layer.policy.rules)) return [];
      return [{ source, rules: layer.policy.rules }];
    });
    if (rules.length > 0) snapshot.policy.rules = mergePolicyRules(rules).rules;
    // 语义标记必须与它解释的那一档来自同一层：上层只写 `mode` 时不能继承下层留下的
    // `semantics`，否则旧文件里的 `never` 会被读成新语义的“跳过审批”。
    const modeLayer = [...LAYER_ORDER].reverse().find((name) => {
      const layer = layers[name];
      return isPlainObject(layer) && isPlainObject(layer.policy) && layer.policy.mode !== undefined;
    });
    const semantics = modeLayer === undefined
      ? undefined
      : ((layers[modeLayer] as Record<string, unknown>).policy as Record<string, unknown> | undefined)?.semantics;
    if (semantics === undefined) delete snapshot.policy.semantics;
    else snapshot.policy.semantics = semantics;
  }
  deepFreeze(snapshot);
  return snapshot;
}
