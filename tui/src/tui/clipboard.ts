export { clipboardPayload, copyToClipboard, writeClipboard, type ClipboardResult } from '@ligule/core/tui.js';

// 复制记录中最近一条带正文的助手事件，不复制尚未落盘的流式内容。
export function lastAnswer(events: readonly { kind?: string; text?: string }[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'assistant' && typeof event.text === 'string' && event.text !== '') return event.text;
  }
  return '';
}
