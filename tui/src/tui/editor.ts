// Ink 的 suspendTerminal 负责让出 raw mode 与重画；文件和子进程由 capability 处理。
import { editInExternalEditor as edit } from '@ligule/core/tui.js';

export type EditorOutcome = Awaited<ReturnType<typeof edit>>;

export function editInExternalEditor(command: string, content: string): Promise<EditorOutcome> {
  return edit(command, content);
}
