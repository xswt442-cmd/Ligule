// Host 将界面设置保存在数据根；`ligule.ui` 仅缓存首屏，只有正式文档不存在时才迁移缓存。
// 读取失败时不写入磁盘；草稿和队列保持完整，由 Host 校验文档大小。
import type { Verbosity } from './components/types';
import type { Client } from './protocol';
import type { Language } from './locale';
import type { ModelSelection } from './model-catalog';
import { defaultNotifications, notificationsFrom, type NotificationPreferences } from './notifications.ts';

const SETTINGS_RPC_TIMEOUT_MS = 60_000;
// The first Host-backed settings read can include filesystem-cold startup; keep writes on the shorter request budget.
const PREFS_READ_RPC_TIMEOUT_MS = 90_000;

// 支持六种具名配色，具体颜色定义在 `styles/01-foundation.css` 的 `data-palette` 变量中。
export const PALETTES = ['ink', 'parchment', 'sky', 'graphite', 'forest', 'dusk'] as const;
export type Palette = (typeof PALETTES)[number];

export type Settings = {
  language: Language;
  notifications: NotificationPreferences;
  lastSession: { id: string; projectRoot: string } | null;
  newSelections: Record<string, ModelSelection>;
  // 选中的配色应用到根元素的 `data-palette`，并保存在本地界面偏好中。
  palette: Palette;
  font: 'small' | 'medium' | 'large';
  fontUi: number;
  fontUser: number;
  fontAssistant: number;
  transcriptLineHeight: number;
  sidebar: number;
  dock: 'right' | 'left';
  verbosity: Verbosity;
  collapsed: boolean;
  // 草稿和队列按项目与会话分别保存，不同会话之间不会共用输入状态。
  drafts: Record<string, Record<string, string>>;
  queued: Record<string, Record<string, string[]>>;
  // 用户快捷键覆盖将动作名称映射到按键写法，保存在本地界面偏好中。
  keys: Record<string, string>;
  // 保存当前窗口额外关注的项目目录；会话配置和权限仍由 Host 根据所属项目决定。
  projects: string[];
  hiddenProjects: string[];
};

const KEY = 'ligule.ui';
const VERBOSITY: Verbosity[] = ['brief', 'standard', 'detailed', 'full'];

export const defaultSettings: Settings = {
  language: 'auto',
  notifications: { ...defaultNotifications },
  lastSession: null,
  newSelections: {},
  palette: 'ink',
  font: 'medium',
  fontUi: 16,
  fontUser: 14,
  fontAssistant: 14,
  transcriptLineHeight: 1.6,
  sidebar: 280,
  dock: 'right',
  verbosity: 'standard',
  collapsed: false,
  drafts: {},
  queued: {},
  keys: {},
  projects: [],
  hiddenProjects: [],
};

const oneOf = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;
const clamped = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && value >= low && value <= high ? Math.round(value) : fallback;
// 键位覆盖只接受“动作名称到按键写法”的映射；按键写法由 hotkeys 模块校验。
const stringMap = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) if (typeof text === 'string') out[name] = text;
  return out;
};

// 额外关注目录只保留有效路径并去重，不限制条目数。
// 此列表只控制当前窗口显示哪些目录；持久工作区登记由 Host 单独维护。
const rootList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((each): each is string => typeof each === 'string' && each !== ''))] : [];

// 草稿必须是字符串，队列必须是字符串数组；其他格式均视为无效。
const draftTable = (value: unknown): Record<string, Record<string, string>> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [project, sessions] of Object.entries(value)) {
    if (typeof sessions !== 'object' || sessions === null) continue;
    const kept: Record<string, string> = {};
    for (const [session, text] of Object.entries(sessions)) {
      if (typeof text === 'string' && text !== '') kept[session] = text;
    }
    if (Object.keys(kept).length > 0) out[project] = kept;
  }
  return out;
};
const queueTable = (value: unknown): Record<string, Record<string, string[]>> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, string[]>> = {};
  for (const [project, sessions] of Object.entries(value)) {
    if (typeof sessions !== 'object' || sessions === null) continue;
    const kept: Record<string, string[]> = {};
    for (const [session, items] of Object.entries(sessions)) {
      if (!Array.isArray(items)) continue;
      const sentences = items.filter((each): each is string => typeof each === 'string' && each !== '');
      if (sentences.length > 0) kept[session] = sentences;
    }
    if (Object.keys(kept).length > 0) out[project] = kept;
  }
  return out;
};

// 规范化已解析的设置，供正式文档和首屏缓存共用。
export function settingsFrom(raw: unknown): Settings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  return {
    language: oneOf(value.language, ['auto', 'zh', 'en'], 'auto'),
    lastSession: typeof value.lastSession?.id === 'string' && typeof value.lastSession?.projectRoot === 'string'
      ? { id: value.lastSession.id, projectRoot: value.lastSession.projectRoot } : null,
    newSelections: Object.fromEntries(Object.entries(value.newSelections ?? {})
      .filter(([, item]) => typeof item?.provider === 'string' && typeof item?.model === 'string')
      .map(([root, item]) => [root, { provider: item.provider, model: item.model }])),
    notifications: notificationsFrom(value.notifications),
    palette: oneOf(value.palette, [...PALETTES], 'ink'),
    font: oneOf(value.font, ['small', 'medium', 'large'], 'medium'),
    fontUi: clamped(value.fontUi, 10, 24, value.font === 'small' ? 15 : value.font === 'large' ? 18 : 16),
    fontUser: clamped(value.fontUser, 12, 32, 14),
    fontAssistant: clamped(value.fontAssistant, 12, 32, 14),
    transcriptLineHeight: typeof value.transcriptLineHeight === 'number' && value.transcriptLineHeight >= 1.2 && value.transcriptLineHeight <= 2.4
      ? Math.round(value.transcriptLineHeight * 10) / 10 : 1.6,
    sidebar: clamped(value.sidebar, 264, 420, defaultSettings.sidebar),
    dock: oneOf(value.dock, ['right', 'left'], 'right'),
    verbosity: oneOf(value.verbosity, VERBOSITY, 'standard'),
    collapsed: value.collapsed === true,
    drafts: draftTable(value.drafts),
    queued: queueTable(value.queued),
    keys: stringMap(value.keys),
    projects: rootList(value.projects),
    hiddenProjects: rootList(value.hiddenProjects),
  };
}

export function readSettings(): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return defaultSettings;
  }
  return settingsFrom(raw);
}

/** 读取本地首屏缓存；仅当 Host 报告正式文档不存在时才迁移。 */
export function cachedSettingsJson(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

// 首屏缓存写入失败不影响持久数据，因此不作为保存错误报告。
export function cacheSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 首屏缓存写入失败可以忽略。
  }
}

type ClientSettingsState = {
  version: string;
  writable: boolean;
  tail: Promise<void>;
  loading?: Promise<Settings>;
};

const clientSettings = new WeakMap<Client, ClientSettingsState>();

function errorWithCode(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return error;
    return Object.assign(error, { code: fallback });
  }
  return Object.assign(new Error(String(error)), { code: fallback });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cachedLegacySettings(): Settings | undefined {
  const json = cachedSettingsJson();
  if (json === '') return undefined;
  try {
    const raw: unknown = JSON.parse(json);
    if (objectValue(raw) === undefined) return undefined;
    return settingsFrom(raw);
  } catch {
    return undefined;
  }
}

function writeSettings(client: Client, state: ClientSettingsState, settings: Settings, version?: string): Promise<void> {
  const pending = state.tail.then(async () => {
    if (!state.writable) throw Object.assign(new Error('prefs_reload_required'), { code: 'prefs_reload_required' });
    const result = await client.call('prefs.write', {
      json: JSON.stringify(settings),
      version: version ?? state.version,
    }, SETTINGS_RPC_TIMEOUT_MS);
    const updated = objectValue(result);
    if (typeof updated?.version !== 'string') {
      throw Object.assign(new Error('prefs_write_version_invalid'), { code: 'prefs_write_version_invalid' });
    }
    state.version = updated.version;
  });
  state.tail = pending.then(
    () => undefined,
    () => { state.writable = false; },
  );
  return pending.catch((error: unknown) => {
    state.writable = false;
    throw errorWithCode(error, 'prefs_write_failed');
  });
}

/** 从 Host 读取设置版本；读取成功后客户端才可以写入。 */
export function loadSettings(client: Client): Promise<Settings> {
  let state = clientSettings.get(client);
  if (state === undefined) {
    state = { version: '', writable: false, tail: Promise.resolve() };
    clientSettings.set(client, state);
  }
  if (state.loading !== undefined) return state.loading;
  state.writable = false;

  const loading = (async () => {
    await state.tail;
    try {
      const result = objectValue(await client.call('prefs.read', {}, PREFS_READ_RPC_TIMEOUT_MS));
      if (result === undefined || typeof result.version !== 'string') {
        throw Object.assign(new Error('prefs_read_version_invalid'), { code: 'prefs_read_version_invalid' });
      }
      state.version = result.version;
      state.writable = true;
      const settings = settingsFrom(result.settings);
      if (state.version !== '') {
        cacheSettings(settings);
        return settings;
      }

      const legacy = cachedLegacySettings();
      if (legacy !== undefined) {
        await writeSettings(client, state, legacy, '');
        cacheSettings(legacy);
        return legacy;
      }
      cacheSettings(settings);
      return settings;
    } catch (error) {
      state.writable = false;
      throw errorWithCode(error, 'prefs_read_failed');
    }
  })();
  state.loading = loading;
  void loading.then(
    () => { if (state.loading === loading) state.loading = undefined; },
    () => { if (state.loading === loading) state.loading = undefined; },
  );
  return loading;
}

/** 更新首屏缓存；正式保存必须使用最近一次成功读取的版本。 */
export async function saveSettings(client: Client, settings: Settings): Promise<void> {
  cacheSettings(settings);
  const state = clientSettings.get(client);
  if (state === undefined || !state.writable) {
    throw Object.assign(new Error('prefs_reload_required'), { code: 'prefs_reload_required' });
  }
  await writeSettings(client, state, settings);
}

// Host 重连后将暂停队列按顺序追加到草稿，保留原草稿在前，不自动发送。
// 用户主动取消时不调用此函数，队列仍保留在输入区并保持暂停。
export function mergeQueueIntoDraft(draft: string, items: string[]): string {
  return [draft, ...items].filter((text) => text !== '').join('\n\n');
}
