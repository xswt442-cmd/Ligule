// TUI 与 Host 在同一进程中运行，通过 `core/src/host/memory.ts` 的内存连接通信。
// TUI 使用与 Desktop 相同的协议，包括会话、轮次、通知和审批请求。
// Ink 和 React 是可选依赖；缺少时 TUI 返回 `tui_dependency_missing`，其他 CLI 命令仍可使用。
import { createElement } from 'react';
import { render, type RenderOptions } from 'ink';
import { createConnection, createInteractivePermissionContext, createMemoryConnectionPair, serveHost } from '@ligule/core/tui.js';
import { App } from './app.js';
import type { TuiClient } from './app.js';
import { flushHistory, historyPathOf, loadHistory, rememberHistory, type Locale } from '@ligule/core/tui.js';
import { flushInput, inputPathOf, readInput, rememberInput } from './input-store.js';
import { flushKeys, keyPathOf, readKeys, writeKeys } from './key-store.js';
import { titleEscape } from './output.js';
import { setTrusted } from './trust-store.js';
import { modeOptions } from './mode-options.js';

type ServeOptions = Parameters<typeof serveHost>[0];

export interface RunTuiOptions extends Omit<ServeOptions, 'input' | 'output' | 'interactive'> {
  readonly locale?: Locale;
  readonly stdout?: RenderOptions['stdout'];
  readonly stdin?: RenderOptions['stdin'];
  readonly stderr?: RenderOptions['stderr'];
  readonly editor?: string;
  readonly historyFile?: string;
  readonly inputFile?: string;
  readonly keyFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function runTui({ config, provider, policy, logger, modeName, modePaths, extensions, locale = 'zh', stdout = process.stdout, stdin = process.stdin, stderr = process.stderr, editor = process.env.VISUAL || process.env.EDITOR, historyFile = historyPathOf(), inputFile = inputPathOf(), keyFile = keyPathOf(), ...hostOptions }: RunTuiOptions): Promise<void> {
  const pair = createMemoryConnectionPair();
  const permission = await createInteractivePermissionContext({
    shellConfig: config,
    workspaceRoot: typeof config.workspaceRoot === 'string' ? config.workspaceRoot : typeof config.boundary === 'string' ? config.boundary : process.cwd(),
  });
  // 启动 TUI 前已确认 stdin 和 stdout 连接交互式终端，因此可以处理用户提问。
  const host = serveHost({
    ...hostOptions,
    input: pair.host.input, output: pair.host.output, config, provider, policy, logger, modeName, modePaths, extensions,
    interactive: true, permission, permissionControl: true,
  });
  // 内存连接与此处创建的 Host 配对；`TuiClient` 定义协议方法在本进程中的响应结构。
  const client = createConnection(pair.client) as TuiClient;
  try {
    const created = await client.request('session.create', {});
    if (!isRecord(created) || typeof created.sessionId !== 'string') throw new Error('tui_session_create_invalid');
    const { sessionId } = created;
    // 启动时读取输入历史并交给界面；之后的浏览由界面处理，写入也由界面发起。
    const history = {
      entries: await loadHistory(historyFile),
      // 只提交新输入；写入时 Host 在锁内读取最新历史并合并，避免覆盖其他客户端的更新。
      // 界面采用 Host 返回的完整列表，保持屏幕内容与文件同步。
      remember: (text: string) => rememberHistory(historyFile, [text]),
    };
    const instance = render(
      createElement(App, {
        client,
        sessionId,
        locale,
        // 启动层读取编辑器环境变量，避免界面直接访问进程环境。
        info: {
          model: typeof config.model?.model === 'string' ? config.model.model : undefined,
          boundary: typeof config.workspaceRoot === 'string' ? config.workspaceRoot : typeof config.boundary === 'string' ? config.boundary : undefined,
          editor,
        },
        history,
        // 启动层提供草稿和队列的持久化接口；界面不直接访问文件路径。
        inputs: {
          read: (projectRoot: string, own: string) => readInput(inputFile, projectRoot, own),
          write: (projectRoot: string, own: string, draft: string, queued: readonly string[]) => rememberInput(inputFile, { projectRoot, sessionId: own, draft, queued: [...queued] }),
        },
        interactive: Boolean(stdin.isTTY && stdout.isTTY),
        // 启动层提供用户快捷键的读取和写入接口；界面不直接访问文件路径。
        keys: { read: () => readKeys(keyFile), write: (overrides: Parameters<typeof writeKeys>[1]) => writeKeys(keyFile, overrides) },
        trust: { revoke: () => setTrusted(String(config.workspaceRoot ?? config.boundary), false) },
        modes: modePaths === undefined ? undefined : { read: () => modeOptions(modePaths) },
        // 启动层读取终端列数，供界面状态行调整布局。
        stdout,
      }),
      // 显式启用 Ink 交互渲染，确保真实终端和模拟 TTY 均按交互模式运行。
      { stdout, stdin, stderr, exitOnCtrlC: false, interactive: Boolean(stdin.isTTY && stdout.isTTY) },
    );
    await instance.waitUntilExit();
  } finally {
    // 退出前清除终端标题，避免关闭后仍显示过期的模型和会话信息。
    // 标题清理失败不应阻止后续资源释放。
    try {
      stdout.write(titleEscape(''));
    } catch { /* 标准输出已经不接了 */ }
    try {
      await Promise.all([flushHistory(historyFile), flushInput(inputFile), flushKeys()]);
    } finally {
      // 界面退出后关闭客户端连接；Host 收到 EOF 后会取消活动轮次并按逆序释放插件。
      pair.client.output.end();
      await host.release();
    }
  }
}
