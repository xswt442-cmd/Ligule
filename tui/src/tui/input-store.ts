// TUI 草稿和队列保存在独立文件中，跨退出保留，不写入会话记录。
// 每行对应一个 `{ projectRoot, sessionId, draft, queued }` 状态；更新时替换旧行并移到末尾。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dataRoot } from '@ligule/core/tui.js';

export type SavedInput = { projectRoot: string; sessionId: string; draft: string; queued: string[] };

/** 限制可持久保存的会话输入状态数量。 */
export const INPUT_LIMIT = 50;
const DRAFT_LIMIT = 8000;
const QUEUE_LIMIT = 20;

export function inputPathOf(userHome = homedir()): string {
  return join(dataRoot(userHome), 'tui-input.jsonl');
}

// 忽略格式无效的单行输入状态，不让辅助数据损坏阻止会话打开。
export function parseInputs(bytes: string): SavedInput[] {
  const found: SavedInput[] = [];
  for (const line of bytes.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const value = parsed as Partial<SavedInput>;
    if (typeof value?.sessionId !== 'string') continue;
    found.push({
      projectRoot: typeof value.projectRoot === 'string' ? value.projectRoot : '',
      sessionId: value.sessionId,
      draft: typeof value.draft === 'string' ? value.draft.slice(0, DRAFT_LIMIT) : '',
      queued: Array.isArray(value.queued) ? value.queued.filter((item): item is string => typeof item === 'string').slice(0, QUEUE_LIMIT) : [],
    });
  }
  return found;
}

async function load(path: string): Promise<SavedInput[]> {
  try {
    return parseInputs(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
}

/** 返回会话的草稿和待发送队列；未保存时返回空值。 */
export async function readInput(path: string, projectRoot: string, sessionId: string): Promise<SavedInput> {
  const entries = await load(path);
  const empty = { projectRoot, sessionId, draft: '', queued: [] as string[] };
  // 同一 ID 可能属于不同项目，必须同时匹配项目根和会话 ID。
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.sessionId === sessionId && entry.projectRoot === projectRoot) return entry;
  }
  return empty;
}

const pendingWrites = new Map<string, Promise<void>>();

/** 整体重写并为每个会话只保留一行；先写临时文件再重命名，避免留下半行。 */
export async function rememberInput(path: string, entry: SavedInput): Promise<void> {
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const kept = (await load(path)).filter((item) => !(item.sessionId === entry.sessionId && item.projectRoot === entry.projectRoot));
    // 草稿和队列都为空时删除该会话的状态行。
    const next = entry.draft === '' && entry.queued.length === 0 ? kept : [...kept, entry].slice(-INPUT_LIMIT);
    if (next.length === 0) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${next.map((item) => JSON.stringify(item)).join('\n')}\n`, { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  pendingWrites.set(path, current);
  try {
    await current;
  } finally {
    if (pendingWrites.get(path) === current) pendingWrites.delete(path);
  }
}

export async function flushInput(path: string): Promise<void> {
  await pendingWrites.get(path);
}
