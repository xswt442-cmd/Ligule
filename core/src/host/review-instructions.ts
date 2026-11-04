import type { SessionEvent } from '../session/format.js';
import type { SessionLog } from '../session/session.js';

/** 复审最多看到几条用户原文：再多也只是把预算填满，并不会让判定更准。 */
export const REVIEW_INSTRUCTION_LIMIT = 5;
/** 单条原文的字符上限：超长的粘贴内容对“是否仍然有效”没有额外信息量。 */
export const REVIEW_INSTRUCTION_CHARS = 1000;

/**
 * 复审要的是“用户仍然有效的约束”，不是全部聊天记录，也不应只看最后一条：
 * 用户常在开头说“后续不要联网”，等到第六个工具调用时，最后一条指令早已与审批无关。
 * 因此取最近几条用户原文各自截断，交给装配层按预算判断；读不到记录时返回 undefined，保留上一次的快照。
 */
export async function recentReviewInstructions(session: SessionLog): Promise<string[] | undefined> {
  let events: SessionEvent[];
  try { events = await session.read(); } catch { return undefined; }
  const chosen: string[] = [];
  for (let index = events.length - 1; index >= 0 && chosen.length < REVIEW_INSTRUCTION_LIMIT; index -= 1) {
    const event = events[index];
    if (event.kind !== 'user' || typeof event.text !== 'string') continue;
    const text = event.text.trim();
    if (text === '') continue;
    chosen.push(text.length > REVIEW_INSTRUCTION_CHARS ? text.slice(0, REVIEW_INSTRUCTION_CHARS) : text);
  }
  return chosen.reverse();
}
