import { applyModeToPrompt, type ModeFile } from '../kernel/modes.js';
import type { Kernel } from '../kernel/kernel.js';
import type { PromptAssembly } from '../kernel/prompt.js';
import type { SessionLog } from '../session/session.js';

export interface SessionModeState {
  file: ModeFile | undefined;
  tools: string[];
  undo(): void;
}

export interface SessionPromptFragment {
  readonly name: string;
  readonly text: string;
}

export async function adoptSessionMode({
  file,
  kernel,
  prompt,
  fragments,
  promptFragmentBytes,
  session,
  mode,
}: {
  readonly file: ModeFile;
  readonly kernel: Kernel;
  readonly prompt: PromptAssembly;
  readonly fragments: readonly SessionPromptFragment[];
  readonly promptFragmentBytes: number;
  readonly session: SessionLog;
  readonly mode: SessionModeState;
}): Promise<void> {
  const previousFile = mode.file;
  // 重新应用相同模式时不修改会话记录；最后一条模式事件是持久选择事实。
  const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);

  // 同步预览新模式的最终清单，然后立即恢复旧 Mode；磁盘写入等待期间始终保持旧 Prompt/工具。
  mode.undo();
  let tools: string[] = [];
  let preview: ReturnType<typeof applyModeToPrompt> | undefined;
  let previewError: unknown;
  try {
    preview = applyModeToPrompt({ file, kernel, prompt, fragments, maxBytes: promptFragmentBytes });
    tools = preview.tools;
  } catch (error) {
    previewError = error;
  }
  preview?.undo();
  if (previousFile !== undefined) {
    try {
      const restored = applyModeToPrompt({ file: previousFile, kernel, prompt, fragments, maxBytes: promptFragmentBytes });
      Object.assign(mode, { undo: restored.undo });
    } catch (restoreError) {
      if (previewError !== undefined) throw new AggregateError([previewError, restoreError], 'mode preview and restore failed');
      throw restoreError;
    }
  }
  if (previewError !== undefined) throw previewError;

  const lastTools = Array.isArray(last?.tools) && last.tools.every((tool): tool is string => typeof tool === 'string')
    ? last.tools
    : undefined;
  if (last === undefined || last.name !== file.name || last.layer !== file.layer || lastTools?.join(' ') !== tools.join(' ') || last.digest !== file.digest) {
    await session.append({ kind: 'mode', name: file.name, layer: file.layer, path: file.path, tools, digest: file.digest });
  }

  // Session 事件成功后，在同一同步片段中替换旧 Mode，避免异步窗口暴露尚未持久化的新状态。
  mode.undo();
  const applied = applyModeToPrompt({ file, kernel, prompt, fragments, maxBytes: promptFragmentBytes });
  Object.assign(mode, { file, tools, undo: applied.undo });
}
