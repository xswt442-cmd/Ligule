// 跨会话搜索直接扫描会话记录目录，与会话列表使用相同的数据来源。
// 返回会话 ID 和事件序号，供界面打开会话并定位到命中记录。
// 搜索指定会话时还会读取溢出文件中的完整工具结果。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../errors.js';
import { SPILL_NAME } from '../kernel/result.js';
import { listSessions } from './list.js';
import type { SessionEvent } from './format.js';
import { foldLabel } from './format.js';
import { parseSessionBytes } from './record.js';

export interface SearchHit {
  sessionId: string;
  // 返回会话名称；名称为空时由界面显示会话编号。
  name: string;
  seq: number;
  kind: string;
  // 返回命中附近的文本片段；完整内容可通过 `session.read` 和事件序号读取。
  text: string;
  // 跨会话搜索只使用记录中保留的结果摘要，不读取其他会话的溢出文件。
  spilled?: string;
}

// 摘录在命中前保留 16 个字符、后保留 44 个字符，为列表中的会话编号和事件序号留出空间。
const BEFORE = 16;
const AFTER = 44;
// 限制每个会话返回的命中数量，避免常见词产生过多结果。
const PER_RECORD = 3;
export const SEARCH_LIMIT = 50;

function excerpt(text: string, at: number, width: number): string {
  const from = Math.max(0, at - BEFORE);
  const to = Math.min(text.length, at + width + AFTER);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

// 搜索用户和模型消息、工具参数与结果、权限拒绝原因，以及保存在 `label` 事件中的会话名称。
function sources(event: SessionEvent): (readonly [string, string])[] {
  if (event.kind === 'user' || event.kind === 'assistant' || event.kind === 'reasoning') {
    return typeof event.text === 'string' && event.text !== '' ? [[event.text, 'text']] : [];
  }
  if (event.kind === 'label') {
    return typeof event.name === 'string' && event.name !== '' ? [[event.name, 'name']] : [];
  }
  if (event.kind !== 'tool') return [];
  const result = (event.result ?? {}) as { content?: unknown; reason?: unknown };
  const content = result.content;
  const body = typeof content === 'string' ? content : typeof (content as { text?: unknown })?.text === 'string' ? (content as { text: string }).text : '';
  const args = JSON.stringify(event.args ?? {});
  const found: (readonly [string, string])[] = [[args, 'args'], [body, 'result'], [typeof result.reason === 'string' ? result.reason : '', 'reason']];
  return found.filter(([text]) => text !== '' && text !== '{}');
}

function spilledName(event: SessionEvent): string | undefined {
  const name = (event.result as { spilled?: unknown } | undefined)?.spilled;
  return typeof name === 'string' ? name : undefined;
}

function matchIn(id: string, name: string, event: SessionEvent, needle: string, extra?: string): SearchHit | undefined {
  const candidates: (readonly [string, string])[] = [...sources(event), ...(extra === undefined ? [] : [[extra, 'spill']] as (readonly [string, string])[])];
  for (const [raw, where] of candidates) {
    // 先将连续空白归一，避免换行和缩进打断匹配或截断摘录。
    const text = raw.replace(/\s+/g, ' ').trim();
    const at = text.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    const spilled = spilledName(event);
    return {
      sessionId: id,
      name,
      seq: event.seq,
      kind: String(event.kind),
      text: excerpt(text, at, needle.length),
      ...((where === 'result' || where === 'spill') && spilled !== undefined ? { spilled } : {}),
    };
  }
  return undefined;
}

// 从溢出文件读取完整工具结果，与 `session.read` 的 `fullResults` 使用相同数据。
// 验证文件名后再拼接路径，拒绝分隔符和 `..`，防止访问记录目录之外的文件。
async function spillBody(directory: string, event: SessionEvent): Promise<string | undefined> {
  const name = spilledName(event);
  if (name === undefined || !SPILL_NAME.test(name)) return undefined;
  try {
    return await readFile(join(directory, name), 'utf8');
  } catch {
    // 溢出文件缺失或已更换时保留记录中的摘要，不重复产生错误。
    return undefined;
  }
}

export interface SearchQuery {
  query: string;
  projectRoot?: string;
  sessionId?: string;
  limit?: number;
}

export async function searchSessions(directory: string, options: SearchQuery): Promise<SearchHit[]> {
  return await searchSessionDirectories([directory], options);
}

export async function searchSessionDirectories(directories: readonly string[], options: SearchQuery): Promise<SearchHit[]> {
  const needle = options.query.trim().toLocaleLowerCase();
  const limit = options.limit ?? SEARCH_LIMIT;
  if (options.sessionId !== undefined) {
    for (const directory of directories) {
      try {
        return await searchOne(directory, options.sessionId, needle, limit);
      } catch (error) {
        if ((error as { code?: string }).code !== 'session_not_found') throw error;
      }
    }
    throw new KernelError('session_not_found', { detail: options.sessionId });
  }
  const groups = await Promise.all(directories.map(async (directory) => ({
    directory,
    sessions: await listSessions(directory, { projectRoot: options.projectRoot }),
  })));
  const sessions = new Map<string, { directory: string; updatedAt: string; id: string; name: string }>();
  for (const group of groups) {
    for (const session of group.sessions) {
      if (!sessions.has(session.id)) sessions.set(session.id, {
        directory: group.directory,
        updatedAt: session.updatedAt,
        id: session.id,
        name: session.name,
      });
    }
  }
  const listed = [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const hits: SearchHit[] = [];
  // 结果按会话列表顺序排列；同一会话中的命中按事件序号递增。
  for (const item of listed) {
    // 不搜索不可恢复的派生会话记录；派生内容通过父会话结果读取。
    if (/\.sub-\d+$/.test(item.id)) continue;
    let events: SessionEvent[];
    try {
      // 列表已读取过记录文件；为搜索正文再次读取同一记录。
      events = parseSessionBytes(await readFile(join(item.directory, `${item.id}.jsonl`))).events;
    } catch {
      // 无法读取的记录错误已由会话列表返回；搜索时跳过该记录，不猜测其内容。
      continue;
    }
    let inThisRecord = 0;
    for (const event of events) {
      if (inThisRecord === PER_RECORD) break;
      const hit = matchIn(item.id, item.name, event, needle);
      if (hit === undefined) continue;
      hits.push(hit);
      inThisRecord += 1;
      if (hits.length === limit) return hits;
    }
  }
  return hits;
}

// 搜索指定会话时每个事件最多返回一个命中；记录摘要不足时才读取溢出内容。
// 达到 `limit` 后立即停止，避免读取过多溢出文件。
async function searchOne(directory: string, id: string, needle: string, limit: number): Promise<SearchHit[]> {
  let events: SessionEvent[];
  try {
    events = parseSessionBytes(await readFile(join(directory, `${id}.jsonl`))).events;
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') throw new KernelError('session_not_found', { detail: id });
    throw cause;
  }
  const { name } = foldLabel(events);
  const hits: SearchHit[] = [];
  for (const event of events) {
    let hit = matchIn(id, name, event, needle);
    if (hit === undefined) hit = matchIn(id, name, event, needle, await spillBody(directory, event));
    if (hit === undefined) continue;
    hits.push(hit);
    if (hits.length === limit) return hits;
  }
  return hits;
}
