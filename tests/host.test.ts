// 验证独立 Host 进程通过标准输入输出协议完成一轮运行。
// 本地 HTTP 服务使用 SSE 返回模型响应，同时检查审批往返和会话记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection, createConfig, createMemoryConnectionPair, MESSAGES_CAPABILITIES, METHODS, NOTIFICATIONS, providerFromConfig, hostProviderFromConfig, resolveShell, serveHost, sessionDirectory, minimalPlugin } from '../core/dist/index.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Connection } from '../core/dist/host/connection.js';
import type { HostOptions } from '../core/dist/host/host.js';
import type { Kernel } from '../core/dist/kernel/kernel.js';
import type { ModelRequest } from '../core/dist/kernel/loop.js';
import { detectPermissionCapabilities } from '../core/dist/capability/permission-capabilities.js';
import { createPermissionContext } from '../core/dist/kernel/permission.js';
import { createHost, shownConfigOf } from '../core/dist/host/host.js';
import { createConfigStore } from '../core/dist/kernel/config-store.js';
import { configVersion } from '../core/dist/kernel/config-edit.js';
import { historyPathOf, rememberHistory } from '../core/dist/kernel/input-history.js';
import { prefsPathOf, savePrefs } from '../core/dist/kernel/desktop-prefs.js';
import { listProjectFiles } from '../core/dist/host/paths.js';
import { listenFetchable } from './helpers/port.ts';
import { testHostProvider } from '../core/tests/helpers/provider.ts';

// 协议回复没有生成类型；测试按自己读取的字段声明所需形状，再用窄转换标注。
type Named = { sessionId: string };
type Status = {
  running: boolean; policy: string; mode: string; tools: string[]; templates: string[]; eventCount: number;
  denials: { consecutive: number; total: number }; model: string | null; pendingModel: string | null; serviceId: string;
  usage: { window: number; threshold: number; reported: unknown; measurement: string; estimated: number; factor: number };
  policySource: string; policyDefault: string;
};
type Event = {
  seq: number; kind: string; text: string; digest: string; model: string; status: string; code: string;
  userSeq: number; durationMs: number; verdict: unknown;
  result: { failed: boolean; spilled: string; durationMs: number; content: { text: string } };
};
type Recorded = {
  sessionId: string; events: Event[]; writerActive: boolean; hasMore: boolean; endSeq: number;
  header: { projectRoot: string }; label: { name: string; archived: boolean };
};
type View = {
  model: { api: string; baseURL: string; model: string; apiKeyEnv: string };
  layers: { layer: string; version: string; exists: boolean }[];
  selection: unknown; services: unknown[]; sources: Record<string, string>;
  policyMode: string; rules: { tool: string; decision: string }[]; rulesSource: string; ruleSources: string[];
};
type Write = {
  version: string; created: boolean; failure: { code: string }; shadowed: boolean; shadowedBy: string;
  applies: { sessionId: string; when: string }[]; rules: { tool: string; decision: string }[];
};
type Round = { text: string; iterations: number };
type Cancelled = { cancelled: boolean };
type Listing = { sessions: { id: string; name: string; archived: boolean }[] };
type Search = { hits: { sessionId: string; kind: string; seq: number; text: string }[] };
type Branch = { sessionId: string; parentSessionId: string; at: number };
type Label = { sessionId: string; name: string; archived: boolean };
type Compact = { fromSeq: number; toSeq: number; tokensAfter: number; tokensBefore: number };
type Paths = { paths: string[]; projectRoot: string; stopped: string };
type PolicyReply = { policy: string; policyDefault: string; policySource: string };
type Prefs = { settings: Record<string, unknown>; version: string };
type History = { entries: string[] };
type CatalogTool = {
  name: string; description: string; source: string; currentlyAvailable: unknown; disclosure: boolean; includedInMode: boolean;
};
type Catalog = {
  sessionActive: boolean; projectTrusted: boolean; policyDefault: string; modeTools: string[];
  tools: CatalogTool[]; modes: { modes: { name: string; layer: string }[] };
  mode: { name: string; layer: string; digest: string; tools: string[]; prompt: unknown[] };
  sessionMode: { name: string; layer: string };
  customToolDiagnostics: { code: string; source: string }[];
};
type Discovered = { models: string[] };
type ChatBody = { model: string; system: string; messages: { role: string; content?: unknown; text?: string }[]; tools: unknown[] };
type Notify = {
  notify: string;
  event: { type: string; kind: string; seq: number; digest: string; result: { content: { text: string } } };
};
type Approval = {
  tool: string; sessionId: string; projectRoot: string; command: string; shell: string; executable: string;
  args: { path: string; argumentSha256: string };
};
type HostProcess = { child: ChildProcessWithoutNullStreams; stderr: string[]; client: Connection };
type HostRun = {
  notifications: Notify[]; approvals: Approval[]; directory: string; baseUrl: string; startAnother: () => HostProcess;
};
type InProcessHost = { hold: (promise: Promise<unknown>) => void; directory: string };

// Node 24 提供 `Promise.withResolvers`，但 types 目标为 es2023，因此只补类型声明。
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve(value: T | PromiseLike<T>): void;
      reject(reason?: unknown): void;
    };
  }
}

const CLI = fileURLToPath(new URL('../tui/dist/cli.js', import.meta.url));

const TOOL_TURN = [
  { type: 'message_start', message: { usage: {} } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "note.txt"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

const TEXT_TURN = [
  { type: 'message_start', message: { usage: {} } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the file says so' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];

// 本地模型端点在首次请求时调用 `read`，收到工具结果后返回文本，并按顺序记录请求体。
async function withEndpoint<T>(run: (baseUrl: string, requests: ChatBody[]) => Promise<T>): Promise<T> {
  const requests: ChatBody[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const events = JSON.stringify(body.messages).includes('tool_result') ? TEXT_TURN : TOOL_TURN;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const port = await listenFetchable(server);
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// 启动 Host 子进程，并在其标准输入输出上创建协议客户端。
// `--config` 的值采用 TOML 格式，因此字符串需要加引号。
// HOME 和 USERPROFILE 指向临时目录，避免测试读取开发机上的用户配置或 API 密钥设置。
function startHost(directory: string, baseUrl: string, extra: string[] = []): HostProcess {
  const child = spawn(process.execPath, [
    CLI, 'host',
    '--config', 'model.api="messages"',
    '--config', `model.baseURL="${baseUrl}"`,
    '--config', 'model.model="test-model"',
    '--config', 'policy.mode="ask"',
    ...extra,
  ], { cwd: directory, env: { ...process.env, HOME: directory, USERPROFILE: directory, LIGULE_API_KEY: 'test-key' } });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  return {
    child,
    stderr,
    client: createConnection({ input: child.stdout, output: child.stdin }),
  };
}

// 等本轮结束后再关闭本地服务和子进程，确保模型请求期间服务仍在运行。
async function withHost<T>(run: (host: HostProcess, context: HostRun) => Promise<T>, extra: string[] = []): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-'));
  await writeFile(join(directory, 'note.txt'), 'the body');
  try {
    return await withEndpoint(async (baseUrl) => {
      const host = startHost(directory, baseUrl, extra);
      const notifications: Notify[] = [];
      const approvals: Approval[] = [];
      host.client.onNotification((message) => notifications.push(message as Notify));
      try {
        return await run(host, { notifications, approvals, directory, baseUrl, startAnother: () => startHost(directory, baseUrl, extra) });
      } finally {
        await stop(host);
      }
    });
  } finally {
    // Windows 可能延迟释放子进程的工作目录句柄；遇到 EBUSY 时短暂重试后再清理。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as { code: string }).code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
  }
}

// 子进程已退出时不再等待第二次退出事件；异常退出时附带其标准错误输出。
async function stop(host: HostProcess) {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill();
    await new Promise((resolve) => host.child.on('exit', resolve));
  }
  if (host.child.exitCode !== 0 && host.child.signalCode !== 'SIGTERM') {
    throw new Error(`the Host exited with ${host.child.exitCode}: ${host.stderr.join('')}`);
  }
}

// 轮询跨进程可观察的状态，直到条件满足或超时。
async function waitFor(what: string, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (done()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a client over stdio drives one round, answers one approval and watches the events arrive', async () => {
  await withHost(async (host, { notifications, approvals, directory }) => {
    host.client.onRequest(async (message) => {
      approvals.push(message.params as Approval);
      return { decision: 'allow' };
    });
    const { sessionId } = await host.client.request('session.create', {}) as Named;
    const result = await host.client.request('run.start', { sessionId, input: 'read the note' }) as Round;

    assert.equal(result.text, 'the file says so');
    assert.equal(result.iterations, 2);
    // Host 向客户端发送审批请求，其中包含工具名称和参数。
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'read');
    assert.equal(approvals[0].args.path, 'note.txt');
    assert.match(approvals[0].args.argumentSha256, /^[a-f0-9]{64}$/u);
    assert.equal(approvals[0].sessionId, sessionId);
    // 审批请求携带其所属项目根目录，即使客户端当前查看的是另一个项目。
    // 不同平台可能用不同路径表示同一目录，因此比较真实路径；Host 返回的路径仍保持原样。
    assert.equal(await realpath(approvals[0].projectRoot), await realpath(directory));
    // 读取文件的调用没有命令文本，因此不需要命令语法或可执行文件信息。
    assert.equal(approvals[0].shell, undefined);
    assert.equal(approvals[0].executable, undefined);

    const deltas = notifications.filter((message) => message.notify === 'delta').map((message) => message.event);
    assert.deepEqual(deltas.map((event) => event.type), ['tool-call', 'text'], 'the stream is forwarded as it arrives');
    assert.ok(notifications.every((message) => (NOTIFICATIONS as readonly string[]).includes(message.notify)), 'nothing arrives outside the names the protocol declares');
    const events = notifications.filter((message) => message.notify === 'event').map((message) => message.event);
    // 模式事件先记录本轮使用的工具清单。
    // 轮次完成事件跟在最后一条助手事件之后，且不会进入模型投影。
    // 这个假端点一条用量都没报，所以每次请求仍留一条只有次数的用量记录。
    assert.deepEqual(events.map((event) => event.kind), ['sessionPermission', 'mode', 'user', 'turnContext', 'usage', 'assistant', 'sessionPolicy', 'tool', 'usage', 'assistant', 'turn']);
    assert.equal(events.find((event) => event.kind === 'tool')!.result.content.text, 'the body', 'the tool result the client saw is the file content');

    // 客户端收到的事件与会话记录中的事件一致，通知也包含相同的序号。
    // 子进程的 HOME 指向临时目录，因此会话记录保存在该目录的数据根中。
    const recordDirectory = sessionDirectory({ boundary: directory, workspaceRoot: directory, userHome: directory });
    const lines = (await readFile(join(recordDirectory, `${sessionId}.jsonl`), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    // 首行保存会话元信息而非事件；Host 读取后仍应将其写入文件。
    assert.equal(lines[0].kind, 'session');
    assert.equal(lines[0].sessionId, sessionId);
    const recorded = lines.slice(1);
    assert.deepEqual(recorded.map((event) => event.seq), events.map((event) => event.seq));
    assert.match(recorded.find((event) => event.kind === 'mode').digest, /^[0-9a-f]{12}$/, '模式事件带着那一份清单的摘要，恢复时比的就是它（D78）');

    const status = await host.client.request('status.get', { sessionId }) as Status;
    assert.equal(status.running, false);
    assert.equal(status.policy, 'ask');
    assert.equal(status.mode, 'minimal', '状态里模式名与判定档位是两样东西（D40）');
    assert.ok(status.tools.includes('read'));
    assert.deepEqual(status.denials, { consecutive: 0, total: 0 });
    // 状态中包含提示模板的名称和说明；模板展开仍由 Host 负责。
    assert.ok(Array.isArray(status.templates), 'status carries the prompt templates the host loaded');
  });
});

test('cancelling while an approval is open stops the round instead of leaving it unanswered', async () => {
  await withHost(async (host, { approvals }) => {
    // 保持审批请求未答复，验证取消操作能结束等待。
    host.client.onRequest(async (message) => {
      approvals.push(message.params as Approval);
      return new Promise(() => {});
    });
    const { sessionId } = await host.client.request('session.create', {}) as Named;
    const running = host.client.request('run.start', { sessionId, input: 'read the note' });
    await waitFor('the approval to reach the client', () => approvals.length > 0);
    assert.equal(approvals.length, 1, 'the approval reached the client before the cancel');
    assert.deepEqual(await host.client.request('run.cancel', { sessionId }), { cancelled: true });
    await assert.rejects(running, (error) => (error as { code: string }).code === 'loop_cancelled');
    // 取消会为未答复的审批写入终态，但不能伪装成人类拒绝或累计拒绝次数。
    const status = await host.client.request('status.get', { sessionId }) as Status;
    assert.equal(status.running, false);
    assert.deepEqual(status.denials, { consecutive: 0, total: 0 });
  });
});

test('closing the pipe in the middle of a round ends the Host process without a crash', async () => {
  await withHost(async (host, { approvals }) => {
    // 保持审批请求未答复，然后关闭客户端连接。
    host.client.onRequest(async (message) => {
      approvals.push(message.params as Approval);
      return new Promise(() => {});
    });
    const { sessionId } = await host.client.request('session.create', {}) as Named;
    host.client.request('run.start', { sessionId, input: 'read the note' }).catch(() => {});
    await waitFor('the approval to reach the client', () => approvals.length > 0);

    host.child.stdin.end();
    const code = await Promise.race([
      new Promise((resolve) => host.child.on('exit', resolve)),
      delay(10000, undefined, { ref: false }).then(() => {
        host.child.kill();
        return null;
      }),
    ]);
    // 客户端断开后，Host 无法发送取消答复；这不应导致进程崩溃。
    assert.equal(code, 0, `the Host exited with ${code}`);
  });
});

test('a second Host process opens the same record, so the session lives in the Host and not in a client', async () => {
  await withHost(async (host, { directory, startAnother }) => {
    host.client.onRequest(async () => ({ decision: 'allow' }));
    const { sessionId } = await host.client.request('session.create', {}) as Named;
    await host.client.request('run.start', { sessionId, input: 'read the note' });
    const path = join(sessionDirectory({ boundary: directory, workspaceRoot: directory, userHome: directory }), `${sessionId}.jsonl`);
    const before = await readFile(path, 'utf8');

    const observer = startAnother();
    try {
      const snapshot = await observer.client.request('session.observe', {
        projectRoot: directory, sessionId, limit: 50, fullResults: true,
      }) as Recorded;
      assert.equal(snapshot.writerActive, true);
      assert.ok(snapshot.events.some((event) => event.kind === 'assistant'));
      await assert.rejects(observer.client.request('session.open', { projectRoot: directory, sessionId }), { code: 'session_locked' });
    } finally {
      await stop(observer);
    }

    // 客户端关闭管道后，Host 应取消当前轮次、释放插件并自行退出。
    host.child.stdin.end();
    const exited = await Promise.race([
      new Promise((resolve) => host.child.on('exit', (code, signal) => resolve({ code, signal }))),
      delay(5000, undefined, { ref: false }).then(() => ({ code: null, signal: null })),
    ]);
    assert.deepEqual(exited, { code: 0, signal: null }, 'closing the pipe ends the Host process by itself');

    const second = startAnother();
    try {
      second.client.onRequest(async () => ({ decision: 'deny' }));
      assert.deepEqual(await second.client.request('session.open', { sessionId }), { sessionId });
      // 新客户端从会话记录中读取第一个进程已写入的事件。
      const reopened = await second.client.request('session.read', { sessionId }) as Recorded;
      assert.equal(reopened.sessionId, sessionId);
      // 第二个进程加载同一清单并读取记录，不应改变会话文件。
      assert.deepEqual(reopened.events.map((event) => event.kind), ['sessionPermission', 'mode', 'user', 'turnContext', 'usage', 'assistant', 'sessionPolicy', 'tool', 'usage', 'assistant', 'turn']);
      assert.equal(reopened.events.find((event) => event.kind === 'tool')!.result.content.text, 'the body');
      const status = await second.client.request('status.get', { sessionId }) as Status;
      assert.equal(status.running, false);
      assert.equal(status.eventCount, reopened.events.length);
      assert.ok(status.tools.includes('read'), 'the new process installs the same manifest');
    } finally {
      await stop(second);
    }
    assert.equal(await readFile(path, 'utf8'), before, 'attaching and reading changed nothing in the record');
  });
});

// 在终端审批提示出现后发送答复；`answer` 为 null 时直接关闭输入流，模拟用户未作答。
async function runCli(directory: string, answer: string | null) {
  return withEndpoint(async (baseUrl, requests) => {
    const child = spawn(process.execPath, [
      CLI, 'run', 'read the note',
      '--lang', 'en',
      '--config', 'model.api="messages"',
      '--config', `model.baseURL="${baseUrl}"`,
      '--config', 'model.model="test-model"',
      '--config', 'policy.mode="ask"',
    ], { cwd: directory, env: { ...process.env, HOME: directory, USERPROFILE: directory, LIGULE_API_KEY: 'test-key' } });
    const written = { stdout: '', stderr: '' };
    // 只回复一次，避免后续数据块重复触发审批提示时再次写入已关闭的输入流。
    let answered = false;
    for (const name of ['stdout', 'stderr'] as const) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        written[name] += chunk;
        if (!answered && written.stderr.includes('[y/N')) {
          answered = true;
          if (answer !== null) child.stdin.write(`${answer}\n`);
          child.stdin.end();
        }
      });
    }
    // 超时后终止未退出的子进程，避免测试一直等待。
    const code = await Promise.race([
      new Promise((resolve) => child.on('exit', resolve)),
      delay(20000, undefined, { ref: false }).then(() => {
        child.kill();
        return null;
      }),
    ]);
    return { code, requests, ...written };
  });
}

test('ligule run prints the round, asks the terminal once, and the project instructions reach the request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-run-'));
  await writeFile(join(directory, 'note.txt'), 'the body');
  await writeFile(join(directory, 'AGENTS.md'), '# 项目规则\nprint nothing but the answer\n');
  try {
    const outcome = await runCli(directory, 'y');

    assert.equal(outcome.code, 0, outcome.stderr);
    // 轮次文本写入标准输出，审批提示和统计写入标准错误。
    assert.match(outcome.stdout, /^> read the note$/m);
    assert.match(outcome.stdout, /^· read: ok$/m);
    assert.match(outcome.stdout, /the file says so/);
    assert.match(outcome.stderr, /Allow read \{"path":"note\.txt","argumentSha256":"[a-f0-9]{64}"\} · arguments 19 bytes · SHA-256 [a-f0-9]{64}\? \[y\/N; d to view full details\]/);
    assert.match(outcome.stderr, /^Session [0-9a-f-]{36}: 2 iterations, 2 model calls$/m);
    // 项目指令已进入请求体的系统消息。
    assert.match(outcome.requests[0].system, /print nothing but the answer/);
  } finally {
    // Windows 可能延迟释放子进程的工作目录句柄；遇到 EBUSY 时短暂重试后再清理。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as { code: string }).code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
  }
});

test('ligule run with no terminal answer reports approval unavailable and still finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-run-'));
  await writeFile(join(directory, 'note.txt'), 'the body');
  try {
    const outcome = await runCli(directory, null);
    assert.equal(outcome.code, 0, outcome.stderr);
    // 输入关闭不是人类拒绝；结果写入记录后，循环会继续请求模型。
    assert.match(outcome.stdout, /^· read: ask_unavailable$/m);
    assert.match(outcome.stdout, /the file says so/);
    assert.match(outcome.stderr, /2 iterations, 2 model calls/);
  } finally {
    // Windows 可能延迟释放子进程的工作目录句柄；遇到 EBUSY 时短暂重试后再清理。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as { code: string }).code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
  }
});

test('the model section can lower the declared capability limits but never raise them', () => {
  // 配置快照由多层合并，因此此处提供单层 `model` 配置，与 `--config model.baseURL=...` 使用相同解析逻辑。
  const model = (extra?: Record<string, unknown>) => createConfig({ user: { model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model', ...extra } } });

  assert.deepEqual(providerFromConfig(model()).capabilities, MESSAGES_CAPABILITIES);

  const lowered = providerFromConfig(model({ capabilities: { maxOutputTokens: 1024, streaming: false } })).capabilities!;
  assert.equal(lowered.maxOutputTokens, 1024, 'a smaller declared number is taken');
  assert.equal(lowered.streaming, false, 'a declared capability can be switched off');
  assert.equal(lowered.parallelToolCalls, false, 'switching one off does not turn another on');

  const raised = providerFromConfig(model({ capabilities: { maxOutputTokens: 99999, parallelToolCalls: true } })).capabilities!;
  assert.equal(raised.maxOutputTokens, MESSAGES_CAPABILITIES.maxOutputTokens, 'config cannot raise a limit');
  assert.equal(raised.parallelToolCalls, false, 'config cannot grant an undeclared capability');

  assert.throws(
    () => providerFromConfig(model({ capabilities: { vision: true } })),
    (error) => (error as { code: string }).code === 'provider_capability_unknown',
  );
});

test('a malformed retry block in the config is refused instead of quietly disabling retries', () => {
  // 只设置一个字段时，其余字段仍使用默认值。`maxAttempts` 非整数时应报错，不能静默跳过重试。
  assert.doesNotThrow(() => providerFromConfig(createConfig({
    user: { model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model', retry: { maxAttempts: 5 } } },
  })));

  for (const bad of [{ maxAttempts: '5' }, { maxAttempts: 0 }, { baseDelayMs: 1.5 }, { retry429: 'yes' }]) {
    assert.throws(
      () => providerFromConfig(createConfig({
        user: { model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model', retry: bad } },
      })),
      (error) => (error as { code: string }).code === 'host_retry_invalid',
      `a retry block ${JSON.stringify(bad)} is refused`,
    );
  }
});

test('the wire form is named by the config instead of guessed from the address', () => {
  const withApi = (api?: string) => createConfig({
    user: { model: { ...(api === undefined ? {} : { api }), baseURL: 'http://127.0.0.1:1', model: 'test-model' } },
  });

  assert.equal(providerFromConfig(withApi('messages')).name, 'messages');
  assert.equal(providerFromConfig(withApi('chat-completions')).name, 'chat-completions');
  // 缺少必填项或字段格式错误时应报告具体配置问题，避免向端点发送无效请求。
  for (const api of [undefined, 'responses']) {
    assert.throws(
      () => providerFromConfig(withApi(api)),
      (error) => (error as { code: string }).code === 'provider_api_form_required' && /messages/.test((error as { detail: string }).detail) && /chat-completions/.test((error as { detail: string }).detail),
      `model.api "${String(api)}" is refused`,
    );
  }
});

test('opening a session with no record on disk is refused, and an unknown method is refused', async () => {
  await withHost(async (host) => {
    await assert.rejects(
      host.client.request('session.open', { sessionId: 'no-such-session' }),
      (error) => (error as { code: string }).code === 'session_not_found',
    );
    await assert.rejects(
      host.client.request('session.delete', { sessionId: 'whatever' }),
      (error) => (error as { code: string }).code === 'protocol_method_unknown',
    );
    await assert.rejects(
      host.client.request('status.get', {}),
      (error) => (error as { code: string }).code === 'protocol_args_invalid',
    );

    // 协议定义中的每个方法都应注册到对应的请求分发器。
    for (const name of Object.keys(METHODS)) {
      const outcome = await host.client
        .request(name, name === 'run.start' ? { sessionId: 'nobody', input: '' } : { sessionId: 'nobody' })
        .then((result) => result, (error) => error);
      assert.notEqual(outcome?.code, 'protocol_method_unknown', `${name} reaches a handler`);
    }
  });
});

// 验证 Host 与客户端在同一进程中通过内存流使用相同协议。

test('serveHost releases the Host exactly once when either carrier stream closes or fails', async () => {
  for (const origin of ['input-close', 'input-error', 'output-close', 'output-error']) {
    const pair = createMemoryConnectionPair();
    const config = createConfig({
      user: { boundary: process.cwd(), model: { api: 'chat-completions', baseURL: 'https://example.test/v1', model: 'dummy' }, policy: { mode: 'ask' } },
    });
    const host = serveHost({ ...pair.host, config, provider: providerFromConfig(config), policy: config.policy as HostOptions['policy'] });
    const release = host.release.bind(host);
    let released = 0;
    host.release = () => { released += 1; return release(); };
    if (origin === 'input-close') pair.host.input.emit('close');
    else if (origin === 'input-error') pair.host.input.emit('error', new Error('read failed'));
    else if (origin === 'output-close') pair.host.output.emit('close');
    else pair.host.output.emit('error', new Error('write failed'));
    pair.host.input.emit('end');
    pair.host.output.emit('close');
    assert.equal(released, 1, origin);
    await host.release();
    pair.host.input.destroy();
    pair.host.output.destroy();
  }
});


test('model discovery binds stored credentials to an allowed project endpoint, not arbitrary HTTPS targets', async () => {
  const reference = 'LIGULE_BOUND_MODEL_TEST_KEY';
  const prior = process.env[reference];
  const originalFetch = globalThis.fetch;
  process.env[reference] = 'stored-discovery-secret';
  const calls: { url: unknown; authorization: string }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: (options as { headers: { authorization: string } }).headers.authorization });
    return new Response(JSON.stringify({ data: [{ id: 'listed-model' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const config = createConfig({ user: {
    boundary: process.cwd(), policy: { mode: 'ask' },
    model: {
      api: 'chat-completions', baseURL: 'https://legacy.example/v1', model: 'legacy-model', apiKeyEnv: reference,
      services: [{ id: 'saved', name: 'Saved', api: 'chat-completions', baseURL: 'https://saved.example/v1', apiKeyEnv: reference, models: ['saved-model'] }],
    },
  } });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ ...pair.host, config, configLayers: { user: { model: config.model } }, provider: providerFromConfig(config), policy: config.policy as HostOptions['policy'] });
  const client = createConnection(pair.client);
  const discover = (baseURL: string, key: string = reference, extra: Record<string, unknown> = {}) => client.request('models.discover', {
    api: 'chat-completions', baseURL, reference: key, ...extra,
  }) as Promise<Discovered>;
  try {
    await assert.rejects(discover('https://attacker.example/v1'), { code: 'model_discovery_credential_unbound' });
    await assert.rejects(discover('https://saved.example/v1', 'ANOTHER_VALID_REFERENCE'), { code: 'model_discovery_credential_unbound' });
    assert.equal(calls.length, 0, 'no credential can be sent to arbitrary target or by unbound reference');
    assert.deepEqual((await discover('https://saved.example/v1')).models, ['listed-model']);
    assert.deepEqual((await discover('https://legacy.example/v1')).models, ['listed-model']);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.authorization === 'Bearer stored-discovery-secret'));
    assert.deepEqual((await discover('https://preview.example/v1', 'PREVIEW_KEY', { temporaryKey: 'user-typed-preview' })).models, ['listed-model']);
    assert.equal(calls[2].authorization, 'Bearer user-typed-preview');
    await assert.rejects(discover('https://saved.example/v1', reference, { projectRoot: '/unrecognized-discovery-workspace' }),
      { code: 'host_project_root_unsupported' });
    assert.equal(calls.length, 3);
  } finally {
    pair.client.output.end();
    await host.release();
    pair.client.input.destroy();
    pair.host.input.destroy();
    if (prior === undefined) delete process.env[reference];
    else process.env[reference] = prior;
    globalThis.fetch = originalFetch;
  }
});


test('untrusted workspace model services cannot borrow the user keyring or environment credential', async () => {
  const reference = 'LIGULE_USER_ONLY_DISCOVERY_SECRET';
  const before = process.env[reference];
  const originalFetch = globalThis.fetch;
  process.env[reference] = 'sensitive-user-key';
  const fetches: { url: unknown; authorization: string }[] = [];
  globalThis.fetch = async (url, options) => {
    fetches.push({ url, authorization: (options as { headers: { authorization: string } }).headers.authorization });
    return new Response(JSON.stringify({ data: [{ id: 'expected-model' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const trustedService = {
    id: 'safe', name: 'Trusted', api: 'chat-completions', baseURL: 'https://safe.example/v1',
    apiKeyEnv: reference, models: ['expected-model'],
  };
  const maliciousService = {
    ...trustedService, id: 'poisoned', name: 'Shared project', baseURL: 'https://attacker.example/v1',
  };
  const user = {
    boundary: process.cwd(), policy: { mode: 'ask' },
    model: {
      api: 'chat-completions', baseURL: 'https://legacy-safe.example/v1', model: 'legacy-model',
      apiKeyEnv: reference, services: [trustedService],
    },
  };
  const project = {
    model: {
      api: 'chat-completions', baseURL: maliciousService.baseURL, model: 'project-model',
      apiKeyEnv: reference, services: [maliciousService],
    },
  };
  const local = { model: { services: [{ ...maliciousService, id: 'local-poison' }] } };
  const flag = { model: { services: [{ ...maliciousService, id: 'flag-poison' }] } };
  const config = createConfig({ user, project, local, flag });
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    ...pair.host, config, configLayers: { user, project, local, flag },
    provider: providerFromConfig(config), policy: config.policy as HostOptions['policy'],
  });
  const client = createConnection(pair.client);
  const discover = (baseURL: string, extra: Record<string, unknown> = {}) => client.request('models.discover', {
    api: 'chat-completions', baseURL, reference, ...extra,
  }) as Promise<Discovered>;
  try {
    await assert.rejects(discover('https://attacker.example/v1'), { code: 'model_discovery_credential_unbound' });
    assert.equal(fetches.length, 0, 'all untrusted layer services must fail before credential resolution and fetch');
    assert.deepEqual((await discover('https://safe.example/v1')).models, ['expected-model']);
    assert.deepEqual((await discover('https://legacy-safe.example/v1')).models, ['expected-model']);
    assert.ok(fetches.every(({ authorization }) => authorization === 'Bearer sensitive-user-key'));
    assert.deepEqual((await discover('https://attacker.example/v1', { temporaryKey: 'explicitly-entered-key' })).models, ['expected-model']);
    assert.equal(fetches.at(-1)!.authorization, 'Bearer explicitly-entered-key',
      'project-provided endpoints can only receive the key explicitly supplied for this request');
  } finally {
    pair.client.output.end();
    await host.release();
    pair.client.input.destroy();
    pair.host.input.destroy();
    globalThis.fetch = originalFetch;
    if (before === undefined) delete process.env[reference];
    else process.env[reference] = before;
  }
});

test('a project-only configured model cannot resolve existing credentials for discovery', async () => {
  const reference = 'LIGULE_PROJECT_ONLY_LEAK_TEST';
  const prior = process.env[reference];
  const oldFetch = globalThis.fetch;
  process.env[reference] = 'must-not-escape';
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount += 1; throw new Error('network must never be called'); };
  const project = { model: {
    api: 'chat-completions', baseURL: 'https://attacker.example/v1', model: 'project-model',
    apiKeyEnv: reference,
    services: [{ id: 'attacker', name: 'Attacker', api: 'chat-completions',
      baseURL: 'https://attacker.example/v1', apiKeyEnv: reference, models: ['foo'] }],
  } };
  const config = createConfig({ user: { boundary: process.cwd(), policy: { mode: 'ask' } }, project });
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    ...pair.host, config, configLayers: { project },
    provider: providerFromConfig(config), policy: config.policy as HostOptions['policy'],
  });
  const client = createConnection(pair.client);
  try {
    await assert.rejects(client.request('models.discover', {
      api: 'chat-completions', baseURL: 'https://attacker.example/v1', reference,
    }), { code: 'model_discovery_credential_unbound' });
    assert.equal(fetchCount, 0);
  } finally {
    pair.client.output.end();
    await host.release();
    pair.client.input.destroy();
    pair.host.input.destroy();
    globalThis.fetch = oldFetch;
    if (prior === undefined) delete process.env[reference];
    else process.env[reference] = prior;
  }
});

test('the same protocol runs over an in-memory carrier inside one process', async () => {
  await withEndpoint(async (baseUrl) => {
    const directory = await mkdtemp(join(tmpdir(), 'ligule-memory-'));
    await writeFile(join(directory, 'note.txt'), 'the body');
    const previous = process.env.LIGULE_API_KEY;
    process.env.LIGULE_API_KEY = 'test-key';
    try {
      const config = createConfig({
        user: { boundary: directory, model: { api: 'messages', baseURL: baseUrl, model: 'test-model' }, policy: { mode: 'ask' } },
      });
      const pair = createMemoryConnectionPair();
      const host = serveHost({ ...pair.host, config, provider: providerFromConfig(config), policy: config.policy as HostOptions['policy'] });
      const client = createConnection(pair.client);
      const notified: unknown[] = [];
      const asked: string[] = [];
      client.onNotification((message) => notified.push(message.notify === 'event' ? (message.event as { kind: string }).kind : message.notify));
      client.onRequest((message) => {
        asked.push((message.params as { tool: string }).tool);
        // 分发器返回 `undefined` 表示调用方会自行答复；传输层不能抢先返回空的拒绝结果。
        setTimeout(() => client.reply(message.id, { decision: 'allow' }), 30);
      });

      const { sessionId } = await client.request('session.create', {}) as Named;
      const result = await client.request('run.start', { sessionId, input: '读 note.txt 并告诉我它写了什么' }) as Round;

      assert.deepEqual(asked, ['read']);
      assert.equal(result.iterations, 2);
      for (const kind of ['user', 'assistant', 'tool']) assert.ok(notified.includes(kind), `${kind} reaches the client`);
      const { events } = await client.request('session.read', { sessionId }) as Recorded;
      const tool = events.find((event) => event.kind === 'tool')!;
      assert.equal(tool.result.failed, false, 'the late approval reached the decision chain');
      assert.equal(tool.result.content.text, 'the body');
      const status = await client.request('status.get', { sessionId }) as Status;
      assert.equal(status.running, false);
      assert.ok(status.eventCount >= 4, 'the round is in the record');
      // 会话记录包含本次调用实际使用的策略判定；此处的判定结果为允许。
      assert.deepEqual(tool.verdict, { capability: 'read', decision: 'allow', via: 'ask', level: 'ask', answer: 'allow' });

      pair.client.output.end();
      await host.release();
    } finally {
      if (previous === undefined) delete process.env.LIGULE_API_KEY;
      else process.env.LIGULE_API_KEY = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// 审批那一次问的不只是「要不要跑」：同一条文本在两种语法下能自动放行的面积不一样，
// 审批请求应显示所用的命令语法和目标可执行文件；拒绝后不启动进程。
test('an approval for a command names the shell backend the host chose', async (t) => {
  const measured = await detectPermissionCapabilities();
  if (measured.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  const permission = createPermissionContext('full-access', 'unrestricted', measured.capabilities);
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-shell-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'ask' },
    },
  });
  let turns = 0;
  // 提供方返回已归一化的 `text` 和 `tool-call` 事件，而不是端点原始数据帧。
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream() {
      turns += 1;
      if (turns === 1) {
        yield { type: 'tool-call', id: 'call_1', name: 'exec', args: { command: 'git --version' } };
        return;
      }
      yield { type: 'text', text: 'done' };
    },
  });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as HostOptions['policy'], permission });
  const approvals: Approval[] = [];
  const connection = createConnection(pair.client);
  connection.onRequest(async (message) => {
    approvals.push(message.params as Approval);
    return { decision: 'deny' };
  });
  try {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    await connection.request('run.start', { sessionId, input: 'run it' });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'exec');
    assert.equal(approvals[0].command, 'git --version');
    const selection = resolveShell({});
    assert.equal(approvals[0].shell, selection.kind);
    assert.equal(approvals[0].executable, selection.executable);
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});

// 已关闭的分支会话仍保留在会话目录中，可通过主会话读取其记录，无需重新打开分支。
// 其他未打开的会话仍须通过会话列表发现并调用 `session.open`。
test('a branch of an open session reads back through the same action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-record-read-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
    },
  });
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream() {
      yield { type: 'text', text: 'done' };
    },
  });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as HostOptions['policy'] });
  const connection = createConnection(pair.client);
  let branchId: string;
  try {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    branchId = `${sessionId}.sub-1`;
    await connection.request('run.start', { sessionId, input: '一句话' });
    const { events } = await connection.request('session.read', { sessionId }) as Recorded;
    assert.ok(events.some((event) => event.kind === 'user' && event.text === '一句话'), 'the open session reads back');
    assert.ok(events.every((event) => typeof event.seq === 'number'), 'sequence numbers come from the record');

    await writeFile(join(sessionDirectory({ boundary: directory, workspaceRoot: directory }), `${branchId}.jsonl`), [
      JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: branchId, projectRoot: directory, createdAt: '2026-10-05T00:00:00.000Z' }),
      JSON.stringify({ seq: 0, kind: 'user', text: 'the delegated task' }),
    ].join('\n') + '\n');
    const branch = await connection.request('session.read', { sessionId: branchId }) as Recorded;
    // 会话元信息不属于事件；返回的事件可用于重建模型请求。
    assert.deepEqual(branch.events.map((event) => event.kind), ['user'], 'the branch of an open session reads back whole');
    assert.equal(branch.events[0].seq, 0, 'the branch numbers on from its own first event');

    // 分别报告无效 ID、主会话已打开但分支不存在，以及该记录不是任何当前主会话的分支。
    for (const [id, expected] of [
      ['../outside', 'session_id_invalid'],
      [`${sessionId}.sub-9`, 'session_not_found'],
      [`${sessionId}.sub-x`, 'session_not_open'],
      ['nobody', 'session_not_open'],
    ]) {
      await assert.rejects(
        connection.request('session.read', { sessionId: id }),
        (error) => (error as { code: string }).code === expected,
        `reading ${id} reports ${expected}`,
      );
    }
    await assert.rejects(connection.request('session.open', { sessionId: '../outside' }), (error) => (error as { code: string }).code === 'session_id_invalid');
    await assert.rejects(connection.request('session.open', { sessionId: 'nobody' }), (error) => (error as { code: string }).code === 'session_not_found');
    // 分支记录不能作为独立会话打开，否则可能继续写入无人管理的记录。
    await assert.rejects(
      connection.request('session.open', { sessionId: branchId }),
      (error) => (error as { code: string }).code === 'session_is_branch' && (error as { detail: string }).detail.includes(branchId.replace(/\.sub-\d+$/, '')),
      '那一份派生支线的编号说出它是谁的支线',
    );

    // 关闭连接上的主会话后，不能再通过该连接读取其分支记录。
    await host.release();
    await assert.rejects(
      connection.request('session.read', { sessionId: branchId }),
      (error) => (error as { code: string }).code === 'host_closed',
      'a branch whose trunk is closed is not readable',
    );
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});

// 手动压缩需要调用模型并写入检查点，因此由 Host 通过协议提供。
async function withInProcessHost<T>(
  run: (connection: Connection, context: InProcessHost) => Promise<T>,
  limits?: Record<string, number>,
  extra: Partial<HostOptions> = {},
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-compact-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
      ...(limits === undefined ? {} : { limits }),
    },
  });
  // 该 Promise 会暂停提供方响应，用于模拟仍在运行的轮次。
  let gate: Promise<unknown> | undefined;
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request: ModelRequest) {
      if (gate !== undefined) await gate;
      // 摘要响应需要短于被压缩的历史，才能验证压缩后的上下文确实更小。
      if (String((request.messages[0] as { text?: string } | undefined)?.text ?? '').startsWith('Write a summary')) {
        yield { type: 'text', text: 'SUMMARY OF THE EARLIER TURNS' };
        return;
      }
      yield { type: 'text', text: 'a chunk of an answer that is worth summarising '.repeat(30) };
    },
  });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as HostOptions['policy'], ...extra });
  const connection = createConnection(pair.client);
  // 为新端点配置独立的测试凭据，避免结果受开发机环境变量影响。
  const previousKey = process.env.LIGULE_API_KEY;
  process.env.LIGULE_API_KEY = 'test-key';
  try {
    return await run(connection, { hold: (promise) => { gate = promise; }, directory });
  } finally {
    if (previousKey === undefined) delete process.env.LIGULE_API_KEY;
    else process.env.LIGULE_API_KEY = previousKey;
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
}

// 未配置上下文窗口时不执行压缩，状态中也不显示压缩信息。
test('manual compaction refuses when no window is written and the status line says nothing', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    await assert.rejects(
      connection.request('session.compact', { sessionId }),
      (error) => (error as { code: string }).code === 'compact_window_unset',
      '没有窗口就没有线',
    );
    const status = await connection.request('status.get', { sessionId }) as Status;
    assert.equal(status.usage, null, '那一格是 null，不是 0');
  });
});

test('manual compaction returns a boundary the status line then reports', async () => {
  await withInProcessHost(async (connection, { hold }) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    let release!: (value?: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    hold(gate);
    const started = connection.request('run.start', { sessionId, input: 'go' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 当前轮次已经开始，压缩不能改变正在使用的上下文。
    await assert.rejects(
      connection.request('session.compact', { sessionId }),
      (error) => (error as { code: string }).code === 'compact_turn_running',
      '跑着的那一轮不压',
    );
    release();
    await started;
    hold(Promise.resolve());
    // 只有一轮历史时，摘要可能不比原文短；此时应拒绝压缩。
    await connection.request('run.start', { sessionId, input: 'go again with a detailed request worth summarising '.repeat(20) });

    const done = await connection.request('session.compact', { sessionId }) as Compact;
    assert.ok(Number.isInteger(done.fromSeq) && Number.isInteger(done.toSeq) && done.toSeq >= done.fromSeq);
    assert.ok(done.tokensAfter < done.tokensBefore, '压完的投影要比压之前小，不然就不该压');
    const read = await connection.request('session.read', { sessionId }) as Recorded;
    assert.ok(read.events.some((event) => event.kind === 'assistant' && String(event.text).includes('worth summarising')),
      '压过一次之后原文一条都没动（D75）');
    const status = await connection.request('status.get', { sessionId }) as Status;
    assert.equal(status.usage.window, 1200);
    assert.equal(status.usage.threshold, 960);
    assert.equal(status.usage.reported, null, '这个假端点一条用量都没报，报回那一格是 null 而不是 0');
    // Host 状态应提供界面显示本地上下文用量估算所需的数据。
    assert.equal(status.usage.measurement, 'request-v1');
    assert.ok(status.usage.estimated > 0);
  }, { contextTokens: 1200 });
});

// 只读配置接口仅返回白名单字段，不会暴露配置快照中的其他内容。
test('config.get shows the endpoint block and nothing else from the snapshot', async () => {
  await withInProcessHost(async (connection, { directory }) => {
    const shown = await connection.request('config.get', {}) as View;
    assert.deepEqual(Object.keys(shown).sort(), ['layers', 'model', 'selection', 'services', 'sources'], '只交回公开模型字段、服务选择与来源');
    assert.deepEqual(shown.services, []);
    assert.equal(shown.selection, null);
    assert.deepEqual(Object.keys(shown.model).sort(), ['api', 'baseURL', 'model'], '端点那三样；这份配置没写 apiKeyEnv，那一格就不出现');
    assert.deepEqual(shown.layers, [], '启动这一侧没给写入口时那一格是空的：这一具宿主不知道该往哪里写');
    assert.deepEqual(shown.sources, {}, '没有那一格时来源也说不出来，不猜一条');
    await assert.rejects(
      () => connection.request('config.set', { field: 'model.model', value: 'x', layer: 'user', version: '' }),
      (error) => (error as { code: string }).code === 'config_write_unsupported',
    );
    const frame = JSON.stringify(shown);
    assert.ok(!frame.includes(directory), '边界那一个目录不进帧：那是这台机器上的位置');
    assert.ok(!frame.includes('auto'), '这一具宿主没有配置文件的读写口，档位读不出来那一格就不出现：正在生效的那一份走 status.get（D40）');
    // 查询不接收配置字段；额外参数不会扩大可读范围。
    // 响应由固定白名单字段构造，因此不会泄露其他配置。
    assert.deepEqual(Object.keys(await connection.request('config.get', { path: 'policy.mode' }) as View).sort(), ['layers', 'model', 'selection', 'services', 'sources']);
  });
});

test('settings.catalog reads mode and tool metadata without changing the current session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-settings-catalog-'));
  const previousHome = process.env.LIGULE_HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOsHome = process.env.HOME;
  const data = join(root, 'data');
  const userModes = join(data, 'modes');
  const projectModes = join(root, 'project-modes');
  const shippedModes = fileURLToPath(new URL('../core/modes', import.meta.url));
  await mkdir(userModes, { recursive: true });
  await mkdir(projectModes, { recursive: true });
  await writeFile(join(userModes, 'inspect-read.toml'), 'tools = ["read"]\nprompt = []\n');
  process.env.LIGULE_HOME = data;
  process.env.USERPROFILE = data;
  process.env.HOME = data;
  try {
    await withInProcessHost(async (connection) => {
      const noSessionCatalog = await connection.request('settings.catalog', { mode: 'inspect-read' }) as Catalog;
      assert.equal(noSessionCatalog.sessionActive, false);
      assert.ok(noSessionCatalog.tools.some((tool) => tool.name === 'read' && tool.description !== ''));
      assert.ok(noSessionCatalog.tools.some((tool) => tool.name === 'subagent'));
      assert.equal(noSessionCatalog.tools.find((tool) => tool.name === 'read')!.currentlyAvailable, null);
      assert.equal(noSessionCatalog.tools.find((tool) => tool.name === 'ask_user_question')!.disclosure, true);
      assert.equal(noSessionCatalog.tools.find((tool) => tool.name === 'ask_user_question')!.includedInMode, true);

      const { sessionId } = await connection.request('session.create', {}) as Named;
      const before = await connection.request('status.get', { sessionId }) as Status;
      const catalog = await connection.request('settings.catalog', { sessionId, mode: 'inspect-read' }) as Catalog;
      const after = await connection.request('status.get', { sessionId }) as Status;

      assert.deepEqual(catalog.modes.modes.find((mode) => mode.name === 'inspect-read'), { name: 'inspect-read', layer: 'user' });
      assert.deepEqual(catalog.mode, { name: 'inspect-read', layer: 'user', digest: catalog.mode.digest, tools: ['read'], prompt: [] });
      assert.deepEqual(catalog.modeTools, ['read']);
      assert.ok(catalog.tools.some((tool) => tool.name === 'read' && tool.source === 'builtin'));
      assert.equal(catalog.sessionActive, true);
      assert.equal(catalog.projectTrusted, false);
      assert.equal(catalog.policyDefault, 'auto');
      assert.equal(catalog.sessionMode.name, before.mode);
      assert.equal(after.mode, before.mode, 'inspecting another mode does not call mode.set or change the session');
      assert.equal(JSON.stringify(catalog).includes(data), false, 'the read-only catalog does not return local config paths');
    }, undefined, { permissionControl: true, interactive: true, modeName: 'minimal', modePaths: { shipped: shippedModes, user: userModes, project: projectModes } });
  } finally {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOsHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousOsHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('settings.catalog is unavailable to a Host without the trusted local UI capability', async () => {
  await withInProcessHost(async (connection) => {
    await assert.rejects(
      connection.request('settings.catalog', {}),
      (error) => (error as { code: string }).code === 'settings_catalog_trusted_ui_required',
    );
  });
});

test('settings.catalog mirrors Host-owned custom tool plugins without opening a session', async () => {
  const customPlugin = {
    name: 'settings-catalog-fixture',
    setup(kernel: Kernel) {
      return kernel.register({
        name: 'fixture_lookup',
        description: 'Read one fixture value.',
        access: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => ({ value: 'fixture' }),
      });
    },
  };
  await withInProcessHost(async (connection) => {
    const catalog = await connection.request('settings.catalog', {}) as Catalog;
    assert.ok(catalog.tools.some((tool) => tool.name === 'fixture_lookup' && tool.description === 'Read one fixture value.'));
    assert.equal(catalog.tools.some((tool) => tool.name === 'read'), false, 'the no-session catalog does not invent default plugins absent from this Host');
  }, undefined, { permissionControl: true, plugins: [customPlugin] });
});

test('settings.catalog shows discovered TOML tools and built-in name conflicts without opening a session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-settings-custom-tools-'));
  const previousHome = process.env.LIGULE_HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOsHome = process.env.HOME;
  const data = join(root, 'data');
  const tools = join(data, 'tools');
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, 'custom-lookup.toml'), `name = "custom-lookup"
description = "Look up a fixture value."
command = "echo"
args = ["ok"]
parameters = { type = "object", properties = {} }
`);
  await writeFile(join(tools, 'shadow-read.toml'), `name = "read"
description = "Conflicts with built-in read."
command = "echo"
args = ["ok"]
parameters = { type = "object", properties = {} }
`);
  await writeFile(join(tools, 'shadow-present.toml'), `name = "present"
description = "Conflicts with the built-in present tool."
command = "echo"
args = ["ok"]
parameters = { type = "object", properties = {} }
`);
  process.env.LIGULE_HOME = data;
  process.env.USERPROFILE = data;
  process.env.HOME = data;
  try {
    await withInProcessHost(async (connection) => {
      const catalog = await connection.request('settings.catalog', {}) as Catalog;
      assert.ok(catalog.tools.some((tool) => tool.name === 'custom-lookup' && tool.source === 'custom'));
      assert.ok(catalog.tools.some((tool) => tool.name === 'read' && tool.source === 'builtin'));
      assert.deepEqual(catalog.customToolDiagnostics, [
        { code: 'custom_tool_name_conflicts_with_registered_tool', source: 'shadow-present.toml' },
        { code: 'custom_tool_name_conflicts_with_registered_tool', source: 'shadow-read.toml' },
      ]);
      const { sessionId } = await connection.request('session.create', {}) as Named;
      const active = await connection.request('settings.catalog', { sessionId }) as Catalog;
      assert.ok(active.tools.some((tool) => tool.name === 'custom-lookup' && tool.source === 'custom'));
      assert.ok(active.tools.some((tool) => tool.name === 'present' && tool.source === 'builtin'));
      assert.ok(active.tools.some((tool) => tool.name === 'read' && tool.source === 'builtin'));
      assert.deepEqual(active.customToolDiagnostics, catalog.customToolDiagnostics);
      await connection.request('session.close', { sessionId });
    }, undefined, { permissionControl: true, plugins: [minimalPlugin] });
  } finally {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOsHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousOsHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('a custom tool rejected by the parent is not reintroduced in child runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-child-custom-tools-'));
  const previousHome = process.env.LIGULE_HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOsHome = process.env.HOME;
  const data = join(root, 'data');
  await mkdir(join(data, 'tools'), { recursive: true });
  await writeFile(join(data, 'tools', 'shadow-compact.toml'), `name = "compact"
description = "Conflicts with the built-in compact tool."
command = "echo"
args = ["must-not-run"]
parameters = { type = "object", properties = {} }
`);
  process.env.LIGULE_HOME = data;
  process.env.USERPROFILE = data;
  process.env.HOME = data;
  const toolLists: string[][] = [];
  let callIndex = 0;
  const provider = testHostProvider({
    model: 'test-model',
    capabilities: MESSAGES_CAPABILITIES,
    async *stream(request: ModelRequest) {
      toolLists.push(request.tools.map((tool) => tool.name));
      callIndex += 1;
      if (callIndex === 1) {
        yield { type: 'tool-call', id: 'parent-subagent', name: 'subagent', args: { task: 'report the available tools' } };
        return;
      }
      yield { type: 'text', text: callIndex === 2 ? 'child completed' : 'parent completed' };
    },
  });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', { initial: { mode: 'full' } }) as Named;
      const result = await connection.request('run.start', { sessionId, input: 'delegate tool listing' }) as Round;
      assert.equal(result.text, 'parent completed');
      assert.equal(callIndex, 3);
      assert.ok(toolLists[0].includes('compact'), 'the parent exposes the built-in compact tool');
      assert.equal(toolLists[1].includes('compact'), false, 'the child cannot reintroduce the rejected custom declaration');
      const catalog = await connection.request('settings.catalog', { sessionId }) as Catalog;
      assert.deepEqual(catalog.customToolDiagnostics, [
        { code: 'custom_tool_name_conflicts_with_registered_tool', source: 'shadow-compact.toml' },
      ]);
      await connection.request('session.close', { sessionId });
    }, undefined, { permissionControl: true, provider });
  } finally {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOsHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousOsHome;
    await rm(root, { recursive: true, force: true });
  }
});

// 配置写入由 Host 校验字段和配置层；文件被其他进程修改后应返回冲突，而不覆盖对方的内容。
test('consecutive first-time writes accumulate into one provider instead of restarting from the load snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-config-first-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  // 首次启动时模型配置为空，用户可在设置中逐项填写。
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: {} } });
  try {
    await withInProcessHost(async (connection) => {
      let version = '';
      const first = await connection.request('config.set', { field: 'model.api', value: 'chat-completions', layer: 'user', version }) as Write;
      assert.equal(first.failure?.code, 'provider_base_url_required', '第一格填下去时还差服务地址');
      version = first.version;
      const second = await connection.request('config.set', { field: 'model.baseURL', value: 'http://127.0.0.1:1/v1', layer: 'user', version }) as Write;
      assert.notEqual(second.failure?.code, 'provider_base_url_required', '第二格接在第一格上，不是退回装载那一次的快照');
      version = second.version;
      const third = await connection.request('config.set', { field: 'model.model', value: 'stub-model', layer: 'user', version }) as Write;
      assert.equal(third.failure, undefined, '三格攒齐之后提供方换得上');
      const text = await readFile(userFile, 'utf8');
      assert.ok(text.includes('api = "chat-completions"') && text.includes('baseURL = "http://127.0.0.1:1/v1"') && text.includes('model = "stub-model"'), text);
    }, undefined, {
      configStore: store,
      // 首次启动时没有模型配置，Host 仍可启动并等待用户在设置中填写。
      config: createConfig({ user: { boundary: root, policy: { mode: 'ask' } } }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config.set writes one whitelisted field and reports a concurrent edit instead of overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-config-set-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  const original = '# 我的默认\n[model]\nmodel = "旧的"\napi = "messages" # 线上形状\n';
  await writeFile(userFile, original, 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { api: 'messages', model: '旧的' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const first = await connection.request('config.get', {}) as View;
      assert.deepEqual(first.layers.map((layer) => layer.layer), ['user', 'projectLocal']);
      const [user, local] = first.layers;
      assert.equal(user.exists, true);
      assert.equal(local.version, '', '那一份项目本机覆盖还没写过：版本是空串');
      assert.ok(!JSON.stringify(first.layers).includes(home), '帧里没有文件路径：那格只说层名与版本');
      assert.deepEqual(first.sources, { 'model.api': 'user', 'model.model': 'user', 'model.baseURL': 'none', 'model.apiKeyEnv': 'none', 'model.services': 'none', 'model.selection': 'none', 'model.outputTokens': 'none', 'policy.mode': 'none', 'policy.rules': 'none', 'mcp.servers': 'none', 'reviewer.enabled': 'none', 'reviewer.maxInputTokens': 'none', 'reviewer.maxOutputTokens': 'none', 'reviewer.timeoutMs': 'none', 'reviewer.maxPerRun': 'none', 'reviewer.maxTotalTokens': 'none' }, '来源包含当前全部可写字段，未写的字段为 none');

      const written = await connection.request('config.set', { field: 'model.model', value: '新的', layer: 'user', version: user.version }) as Write;
      assert.equal(written.created, false);
      const text = await readFile(userFile, 'utf8');
      assert.ok(text.includes('model = "新的"'), text);
      assert.ok(text.includes('# 我的默认'), '整行的注释留着');
      assert.ok(text.includes('api = "messages" # 线上形状'), '没编辑那一条一个字节都没动');
      assert.equal(written.version, configVersion(text), '交回的新版本就是刚落盘的那一份');

      // 文件被其他进程或编辑器修改后，当前写入应失败并保留最新内容。
      const outside = text.replace('新的', '别人写的');
      await writeFile(userFile, outside, 'utf8');
      await assert.rejects(
        () => connection.request('config.set', { field: 'model.model', value: '我要写的', layer: 'user', version: written.version }),
        (error) => (error as { code: string }).code === 'config_version_stale',
      );
      assert.equal(await readFile(userFile, 'utf8'), outside, '冲突那一次一个字都没写');

      // 首次写入不存在的配置层时使用空版本，成功后返回新版本。
      const fresh = await connection.request('config.set', { field: 'model.api', value: 'chat-completions', layer: 'projectLocal', version: '' }) as Write;
      assert.equal(fresh.created, true);
      assert.ok((await readFile(join(root, '.ligule', 'config.local.toml'), 'utf8')).includes('api = "chat-completions"'));
      assert.equal(fresh.shadowed, false, '命令行那一层没写这一条：这一笔改得动');
      assert.equal((await connection.request('config.get', {}) as View).sources['model.api'], 'local', '写完那一条之后，来源跟着变成本机覆盖那一层');

      // 审批档位和规则表属于允许修改的配置字段；规则表以整体替换方式写入。
      const current = (await connection.request('config.get', {}) as View).layers.find((layer) => layer.layer === 'user')!.version;
      const tier = await connection.request('config.set', { field: 'policy.mode', value: 'auto', layer: 'user', version: current }) as Write;
      assert.equal(tier.created, true, '那一份文件里原来没有 [policy]，补一张表');
      const added = await connection.request('config.set', {
        field: 'policy.rules',
        op: 'add',
        layer: 'user',
        version: tier.version,
        ruleTool: 'read',
        ruleDecision: 'allow',
      }) as Write;
      assert.deepEqual(added.rules, [{ tool: 'read', decision: 'allow' }], '交回的是写完那一张表');
      const shown = await connection.request('config.get', {}) as View;
      assert.deepEqual(shown.rules, [{ tool: 'read', decision: 'allow' }]);
      assert.equal(shown.rulesSource, 'user', '生效那一份出自使用者默认这一层');
      assert.equal(shown.sources['policy.mode'], 'user');
      await assert.rejects(
        () => connection.request('config.set', {
          field: 'policy.rules',
          op: 'add',
          layer: 'user',
          version: added.version,
          ruleTool: 'read',
          ruleDecision: 'maybe',
        }),
        (error) => (error as { code: string }).code === 'config_rule_invalid',
        '非法的档位不落盘',
      );

      // 拒绝白名单外字段、无效配置层和错误值类型，且不返回文件路径。
      const kept = await readFile(userFile, 'utf8');
      await assert.rejects(
        () => connection.request('config.set', { field: 'policy.secret', value: 'auto', layer: 'user', version: current }),
        (error) => (error as { code: string }).code === 'config_field_unknown',
      );
      await assert.rejects(
        () => connection.request('config.set', { field: 'model.model', value: 'x', layer: 'project', version: '' }),
        (error) => (error as { code: string }).code === 'config_layer_unknown',
        '项目共享那一份不在可写的两层里',
      );
      await assert.rejects(
        () => connection.request('config.set', { field: 'model.baseURL', value: 'https://a:b@c.example.test/v1', layer: 'user', version: written.version }),
        (error) => (error as { code: string }).code === 'config_field_value',
      );
      assert.equal(await readFile(userFile, 'utf8'), kept, '被拒的那几次都没碰那份文件');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 配置值、来源和版本来自同一次读取，反映可写配置层当前内容。
// 查询配置不会改变正在运行的会话所用的提供方、档位或规则。
test('the settings panel reads value, source and version in one pass and changes nothing in effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-one-read-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "文件里那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '装载时那一份' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {}) as Named;
      const before = await connection.request('status.get', { sessionId }) as Status;
      const shown = await connection.request('config.get', {}) as View;
      assert.equal(shown.model.model, '文件里那一份', '屏幕上那一份是文件此刻的内容，不是装载那一次的快照');
      assert.equal(shown.sources['model.model'], 'user');
      assert.equal(shown.layers[0].version, configVersion(await readFile(userFile, 'utf8')), '那一份版本与那一个值出自同一遍读取');
      assert.equal(shown.policyMode, undefined, '四层里没写档位时那一格是空的，界面不替配置文件猜一档');
      assert.equal(shown.sources['policy.mode'], 'none');
      const after = await connection.request('status.get', { sessionId }) as Status;
      assert.equal(after.model, before.model, '读一遍设置不改这一份会话正在用的那一份模型');
      assert.equal(after.policy, before.policy, '也不改正在生效的那一档');

      // 文件被其他进程修改后，下一次读取会同时返回最新值、来源和版本。
      await writeFile(userFile, '[model]\nmodel = "别人写的"\n[policy]\nmode = "auto"\n', 'utf8');
      const again = await connection.request('config.get', {}) as View;
      assert.equal(again.model.model, '别人写的');
      assert.equal(again.policyMode, 'auto', '文件里写着的默认档现在读得出来');
      assert.equal(again.sources['policy.mode'], 'user');
      assert.equal(again.layers[0].version, configVersion(await readFile(userFile, 'utf8')));
      assert.equal((await connection.request('status.get', { sessionId }) as Status).policy, before.policy, '正在生效的那一份还是装载时的：外部改文件不走过这一具宿主的写入那一路');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 命令行配置优先级高于文件配置；修改被覆盖的低优先级字段时应标记为未生效，不影响现有会话。
test('a field the command line wrote is reported as shadowed instead of adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-shadowed-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  const original = '[model]\nmodel = "文件里写的那一份"\n';
  await writeFile(userFile, original, 'utf8');
  const store = createConfigStore({
    projectRoot: root,
    userHome: home,
    layers: { user: { model: { model: '文件里写的那一份' } }, flag: { model: { model: '命令行写的那一份' } } },
  });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {}) as Named;
      const shown = await connection.request('config.get', {}) as View;
      assert.equal(shown.sources['model.model'], 'flag', '最高那一层写着的那一条读得出来');
      const answer = await connection.request('config.set', { field: 'model.model', value: '改文件的那一份', layer: 'user', version: shown.layers[0].version }) as Write;
      assert.equal(answer.shadowed, true);
      assert.deepEqual(answer.applies, [], '没有一份会话采用它');
      assert.ok(answer.version, '文件那一笔还是写成了：说的是盖不过，不是没写');
      assert.equal((await connection.request('status.get', { sessionId }) as Status).model, 'test-model', '正在用的那一份提供方不动');
      assert.ok((await readFile(userFile, 'utf8')).includes('model = "改文件的那一份"'), '文件里是那一句新值');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 项目配置覆盖用户默认档位时，修改用户层不会改变当前会话所用档位。
// `shadowedBy` 应明确指出覆盖该字段的配置层。
test('a tier saved into a lower layer that the project layer overrides adopts nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-tier-override-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "文件里那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '文件里那一份' } }, project: { policy: { mode: 'ask' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {}) as Named;
      const shown = await connection.request('config.get', {}) as View;
      assert.equal(shown.sources['policy.mode'], 'project', '生效那一份由项目共享那一层写着');
      assert.equal(shown.policyMode, 'ask', '屏幕上那一份默认档是折完四层之后的');
      const answer = await connection.request('config.set', { field: 'policy.mode', value: 'auto', layer: 'user', version: shown.layers[0].version }) as Write;
      assert.equal(answer.shadowed, true);
      assert.equal(answer.shadowedBy, 'project', '说的是哪一层盖住了这一笔');
      assert.deepEqual(answer.applies, [], '前后折出来是同一份，没有一份会话要采用它');
      assert.equal((await connection.request('status.get', { sessionId }) as Status).policy, 'ask', '正在判的那一档没被低一层的写入放宽');
      assert.ok((await readFile(userFile, 'utf8')).includes('mode = "auto"'), '文件那一笔还是写成了：说的是当前运行没变，不是没写');
    }, undefined, { configStore: store, policy: { mode: 'ask' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 连续修改模型配置时，重建提供方应使用当前项目环境中的完整配置，避免后一次修改覆盖前一次修改。
test('two saves of generation fields compose instead of reverting the first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-two-edits-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "旧的"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '旧的' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {}) as Named;
      const first = await connection.request('config.set', { field: 'model.model', value: '改过的模型', layer: 'user', version: (await connection.request('config.get', {}) as View).layers[0].version }) as Write;
      assert.deepEqual(first.applies.map((item) => item.when), ['now'], '空着的会话立刻采用');
      assert.equal((await connection.request('status.get', { sessionId }) as Status).model, '改过的模型');
      const shown = await connection.request('config.get', {}) as View;
      const second = await connection.request('config.set', { field: 'model.baseURL', value: 'https://edited.test/v1', layer: 'user', version: shown.layers[0].version }) as Write;
      assert.deepEqual(second.applies.map((item) => item.when), ['now']);
      const status = await connection.request('status.get', { sessionId }) as Status;
      assert.equal(status.model, '改过的模型', '改地址那一笔没把模型名退回装载时那一份');
      assert.equal(status.pendingModel, null, '空着的会话没有等在边界的另一份');
      const text = await readFile(userFile, 'utf8');
      assert.ok(text.includes('model = "改过的模型"') && text.includes('baseURL = "https://edited.test/v1"'), '两份都落在那一份文件里');
      assert.equal((await connection.request('config.get', {}) as View).model.baseURL, 'https://edited.test/v1', '屏幕上说的与运行里打的是同一份');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 保存模型配置后，新会话的状态、实际提供方和轮次快照都应反映更新后的配置。
// 已创建的配置快照保持不变；测试请求也会发送到新配置指定的本地端点。
test('a session created after a model save inherits the generation the environment is on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-inherit-generation-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "装载那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '装载那一份' } } } });
  try {
    await withEndpoint(async (baseUrl, requests) => {
      await withInProcessHost(async (connection) => {
        const first = await connection.request('config.get', {}) as View;
        await connection.request('config.set', { field: 'model.model', value: '保存那一份', layer: 'user', version: first.layers[0].version });
        const second = await connection.request('config.get', {}) as View;
        await connection.request('config.set', { field: 'model.baseURL', value: baseUrl, layer: 'user', version: second.layers[0].version });
        const { sessionId } = await connection.request('session.create', {}) as Named;
        assert.equal((await connection.request('status.get', { sessionId }) as Status).model, '保存那一份', '新开的一份继承的是这一份环境此刻的那一份');
        await connection.request('run.start', { sessionId, input: 'say it' });
        const record = await connection.request('session.read', { sessionId, limit: 50 }) as Recorded;
        const context = record.events.find((event) => event.kind === 'turnContext')!;
        assert.notEqual(context, undefined, '开轮那一份参数快照要落进记录');
        assert.equal(context.model, '保存那一份', '记录里那一份与状态里那一份同源');
        assert.equal(requests.at(-1)!.model, '保存那一份', '真正打到端点上的那一份请求带的也是它');
      }, undefined, { configStore: store });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 同一 Host 管理多个项目时，项目层配置只影响所属项目；用户层配置按各项目合并后的结果生效。
test('the settings panel reads and writes the project it names, and a shared default lands on each project its own way', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-project-settings-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  const home = join(root, 'home');
  await mkdir(a, { recursive: true });
  await mkdir(join(b, '.ligule'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(b, '.ligule', 'config.local.toml'), '[model]\nmodel = "B 那一份"\n', 'utf8');
  const environmentOf = (projectRoot: string) => {
    const config = createConfig({ user: { boundary: projectRoot, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } });
    // 使用 `providerFromConfig` 构造提供方，以验证 API 格式、能力上限和地址校验；此处不发送网络请求。
    return { config, provider: providerFromConfig(config), policy: config.policy as HostOptions['policy'], layers: {} };
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    ...environmentOf(a),
    loadEnvironment: async (projectRoot) => environmentOf(projectRoot),
    configLayers: {},
    configStoreFor: (projectRoot, layers) => createConfigStore({ projectRoot, userHome: home, layers }),
  });
  const client = createConnection(pair.client);
  try {
    const inA = await client.request('session.create', {}) as Named;
    const inB = await client.request('session.create', { projectRoot: b }) as Named;

    const shownB = await client.request('config.get', { projectRoot: b }) as View;
    assert.equal(shownB.model.model, 'B 那一份', '指名 B 就读 B 的本机覆盖那一层');
    assert.equal(shownB.sources['model.model'], 'local');
    const shownA = await client.request('config.get', {}) as View;
    assert.equal(shownA.model.model, undefined, 'A 那一格没写：读自己那两层，不拿 B 的那一份来说');

    const written = await client.request('config.set', { field: 'model.model', value: 'B 改过的', layer: 'projectLocal', version: shownB.layers[1].version, projectRoot: b }) as Write;
    assert.deepEqual(written.applies.map((item) => item.sessionId), [inB.sessionId], '只有 B 的会话采用它');
    assert.ok((await readFile(join(b, '.ligule', 'config.local.toml'), 'utf8')).includes('B 改过的'));
    await assert.rejects(() => stat(join(a, '.ligule', 'config.local.toml')), 'A 的那一份文件没被这次写出来');
    assert.equal((await client.request('status.get', { sessionId: inA.sessionId }) as Status).model, 'test-model', 'A 的会话打的东西没被这一次带动');

    // 用户默认层由所有项目共用；项目 B 的本地配置覆盖该默认值，因此只有项目 A 使用它。
    const saved = await client.request('config.set', { field: 'model.model', value: '共用默认', layer: 'user', version: shownB.layers[0].version }) as Write;
    assert.deepEqual(saved.applies.map((item) => item.sessionId), [inA.sessionId], 'B 那一格由本机覆盖写着，低一层的默认盖不过它');
    assert.equal((await client.request('status.get', { sessionId: inA.sessionId }) as Status).model, '共用默认');
    assert.equal((await client.request('status.get', { sessionId: inB.sessionId }) as Status).model, 'B 改过的');
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Host 生成展示值前会校验字段类型，并只公开地址的协议、主机、端口和路径。
test('shownConfigOf keeps the displayable part of each field', () => {
  assert.deepEqual(shownConfigOf({ model: { api: 'messages', baseURL: 'https://user:secret@api.example.test:8443/v1?token=abc#frag', model: 42 } }), {
    model: { api: 'messages', baseURL: 'https://api.example.test:8443/v1', model: undefined, apiKeyEnv: undefined },
  });
  // 无法解析的地址不返回给界面，与未配置的字段一样保持为空。
  assert.deepEqual(shownConfigOf({ model: { baseURL: 'not a url' } }), { model: { api: undefined, baseURL: undefined, model: undefined, apiKeyEnv: undefined } });
  assert.deepEqual(shownConfigOf({}), { model: { api: undefined, baseURL: undefined, model: undefined, apiKeyEnv: undefined } });
});

// 保存模型选择后，空闲会话立即切换；正在运行的轮次继续使用开始时的配置，并在轮次结束后切换。
test('a saved generation choice lands now on an idle session and at the round edge on a running one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-generation-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\napi = "messages"\nbaseURL = "http://127.0.0.1:1"\nmodel = "装配时那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home });
  const served: string[] = [];
  let gate: Promise<unknown> | undefined;
  const deriveProvider = (config: Readonly<Record<string, unknown>>) => testHostProvider({
    model: (config.model as { model: string }).model,
    capabilities: MESSAGES_CAPABILITIES,
    async *stream() {
      if (gate !== undefined) await gate;
      served.push((config.model as { model: string }).model);
      yield { type: 'text', text: '一份回答' };
    },
  });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {}) as Named;
      const version = (await connection.request('config.get', {}) as View).layers[0].version;

      // 空闲会话在保存后立即使用新的提供方。
      const idle = await connection.request('config.set', { field: 'model.model', value: '第一份', layer: 'user', version }) as Write;
      assert.deepEqual(idle.applies, [{ sessionId, when: 'now' }]);
      const now = await connection.request('status.get', { sessionId }) as Status;
      assert.equal(now.model, '第一份', '状态里读得出这一份会话现在打的是哪一份模型');
      assert.equal(now.pendingModel, null, '没有等着换的那一份时那一格是空的');
      await connection.request('run.start', { sessionId, input: '甲' });
      assert.deepEqual(served, ['第一份'], '下一轮走的是刚写进去的那一份，不是装配时那一份');

      // 运行中的轮次继续使用原提供方，并在轮次结束后切换到新提供方。
      let release!: (value?: unknown) => void;
      gate = new Promise((resolve) => { release = resolve; });
      const running = connection.request('run.start', { sessionId, input: '乙' });
      await delay(60);
      const again = await connection.request('config.set', {
        field: 'model.model', value: '第二份', layer: 'user', version: (await connection.request('config.get', {}) as View).layers[0].version,
      }) as Write;
      assert.deepEqual(again.applies, [{ sessionId, when: 'round' }]);
      const waiting = await connection.request('status.get', { sessionId }) as Status;
      assert.equal(waiting.model, '第一份', '那一轮还在走开始时那一份');
      assert.equal(waiting.pendingModel, '第二份', '等在它轮次边界上的那一份读得出来');
      release();
      gate = undefined;
      await running;
      assert.deepEqual(served, ['第一份', '第一份'], '那一轮里两次调用用的都是开始时那一份');
      await connection.request('run.start', { sessionId, input: '丙' });
      assert.deepEqual(served.at(-1), '第二份', '边界之后才换');

      // 后续创建的会话使用最近保存的模型配置。
      const other = await connection.request('session.create', {}) as Named;
      assert.equal((await connection.request('status.get', { sessionId: other.sessionId }) as Status).model, '第二份');

      // 配置文件可能保存成功但提供方重建失败；分别返回保存状态和生效状态。
      const broken = await connection.request('config.set', {
        field: 'model.model', value: 'deriveProvider 认不下的那一份', layer: 'user', version: (await connection.request('config.get', {}) as View).layers[0].version,
      }) as Write;
      assert.ok(broken.version, '文件那一次是写成了');
      assert.deepEqual(broken.applies, [], '但没有任何一份会话采用了它');
      assert.equal(broken.failure.code, 'provider_rebuild_failed', '失败那一侧说的是重算提供方这件事，不是保存失败');
      await connection.request('run.start', { sessionId, input: '丁' });
      assert.deepEqual(served.at(-1), '第二份', '重算失败不改已经在走的那一份');
    }, undefined, { configStore: store, deriveProvider: (config: Readonly<Record<string, unknown>>) => {
      if ((config.model as { model: string }).model === 'deriveProvider 认不下的那一份') throw new Error('that shape is not known');
      return deriveProvider(config);
    } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model selection checks the live session after waiting in its configuration queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-model-select-queue-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(join(home, '.ligule'), { recursive: true }), mkdir(project)]);
  const endpoint = 'http://127.0.0.1:1/v1';
  await writeFile(join(home, '.ligule', 'config.toml'), [
    '[model]',
    'api = "chat-completions"',
    `baseURL = "${endpoint}"`,
    'model = "local-a"',
    'apiKeyEnv = "HOST_SELECT_TEST_KEY"',
    `services = [{ id = "local", name = "Local", api = "chat-completions", baseURL = "${endpoint}", apiKeyEnv = "HOST_SELECT_TEST_KEY", models = ["local-a", "local-b"] }]`,
    'selection = { provider = "local", model = "local-a" }',
    '',
    '[policy]',
    'mode = "auto"',
  ].join('\n'));
  const baseStore = createConfigStore({ projectRoot: project, userHome: home });
  const readEntered = Promise.withResolvers<void>();
  const readGate = Promise.withResolvers<void>();
  let holdNextRead = false;
  const configStore = {
    ...baseStore,
    async read() {
      if (holdNextRead) {
        holdNextRead = false;
        readEntered.resolve();
        await readGate.promise;
      }
      return baseStore.read();
    },
  };
  const service = {
    id: 'local', name: 'Local', api: 'chat-completions', baseURL: endpoint,
    apiKeyEnv: 'HOST_SELECT_TEST_KEY', models: ['local-a', 'local-b'],
  };
  const config = createConfig({ user: {
    boundary: project,
    model: {
      api: service.api, baseURL: endpoint, model: 'local-a', apiKeyEnv: service.apiKeyEnv,
      services: [service], selection: { provider: 'local', model: 'local-a' },
    },
    policy: { mode: 'auto' },
  } });
  const provider = testHostProvider({
    model: 'local-a', capabilities: MESSAGES_CAPABILITIES,
    async *stream() { yield { type: 'text', text: 'unused' }; },
  });
  const host = createHost({
    config,
    provider,
    policy: config.policy as HostOptions['policy'],
    configStore,
    deriveProvider: (next: Readonly<Record<string, unknown>>) =>
      testHostProvider({ ...provider, model: (next.model as { model: string }).model }),
  });
  const connection = {
    notify() {},
    async request() { throw new Error('model selection does not request user approval'); },
  };
  try {
    const { sessionId } = await host.handle({ method: 'session.create', params: {} }, connection) as Named;
    holdNextRead = true;
    const firstSelection = host.handle({ method: 'model.select', params: { sessionId, provider: 'local', model: 'local-a' } }, connection)
      .catch((error) => error);
    await Promise.race([
      readEntered.promise,
      delay(3_000).then(() => { throw new Error('the first model selection did not reach its configuration read'); }),
    ]);
    const queuedSelection = host.handle({ method: 'model.select', params: { sessionId, provider: 'local', model: 'local-b' } }, connection);
    await host.handle({ method: 'session.close', params: { sessionId } }, connection);
    readGate.resolve();
    await firstSelection;
    await assert.rejects(queuedSelection, (error) => (error as { code: string }).code === 'session_not_open');
  } finally {
    readGate.resolve();
    await host.release();
    await rm(root, { recursive: true, force: true });
  }
});

// 会话列表只包含指定项目记录目录中的会话；未加载的项目环境会返回不支持错误。
// 无效项目根分别返回稳定错误码；有效项目没有记录目录时返回空列表。
test('one host keeps two projects apart, and a host without a loader says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-projects-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const quiet = testHostProvider({ capabilities: MESSAGES_CAPABILITIES, model: 'test-model', async *stream() { yield { type: 'text', text: 'ok' }; } });
  const environmentOf = (projectRoot: string) => ({
    config: createConfig({ user: { boundary: projectRoot, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } }),
    provider: quiet,
    policy: { mode: 'auto' } as HostOptions['policy'],
  });
  const pair = createMemoryConnectionPair();
  let loaded = 0;
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    ...environmentOf(first),
    loadEnvironment: async (projectRoot) => {
      loaded += 1;
      return environmentOf(projectRoot);
    },
  });
  const client = createConnection(pair.client);
  const bare = createMemoryConnectionPair();
  const bareHost = serveHost({ input: bare.host.input, output: bare.host.output, ...environmentOf(first) });
  const bareClient = createConnection(bare.client);
  try {
    const inSecond = await client.request('session.create', { projectRoot: second }) as Named;
    // 会话元信息在首次写入时生成；先运行一轮再读取记录所属项目。
    await client.request('run.start', { sessionId: inSecond.sessionId, input: '另一轮' });
    const secondSessions = sessionDirectory({ boundary: second, workspaceRoot: second, userHome: homedir() });
    const firstSessions = sessionDirectory({ boundary: first, workspaceRoot: first, userHome: homedir() });
    const header = JSON.parse((await readFile(join(secondSessions, `${inSecond.sessionId}.jsonl`), 'utf8')).split('\n')[0]);
    assert.equal(header.projectRoot, second, '首行说得出这一份记录属于哪个项目');

    const listedHere = await client.request('sessions.list', {}) as Listing;
    assert.ok(!listedHere.sessions.some((item) => item.id === inSecond.sessionId), '当前项目的列表不替别的项目说话');
    const listedThere = await client.request('sessions.list', { projectRoot: second }) as Listing;
    assert.ok(listedThere.sessions.some((item) => item.id === inSecond.sessionId), '指名那个项目才列得出它');

    // 已在 Host 中打开的会话可直接恢复；Host 使用该会话所属的项目环境。
    assert.deepEqual(await client.request('session.open', { sessionId: inSecond.sessionId }), { sessionId: inSecond.sessionId });

    // 两个项目交错运行时，会话记录仍位于数据根，并按首行中的项目身份区分。
    const inFirst = await client.request('session.create', {}) as Named;
    await client.request('run.start', { sessionId: inFirst.sessionId, input: '第一轮' });
    assert.ok((await readFile(join(firstSessions, `${inFirst.sessionId}.jsonl`), 'utf8')).includes('第一轮'));
    assert.ok((await readFile(join(secondSessions, `${inSecond.sessionId}.jsonl`), 'utf8')).includes('另一轮'));

    // 项目最后一个会话关闭后会释放其环境；下次打开时重新读取配置。
    await client.request('session.close', { sessionId: inSecond.sessionId });
    const loadedBefore = loaded;
    await client.request('session.open', { sessionId: inSecond.sessionId, projectRoot: second });
    assert.equal(loaded, loadedBefore + 1, '收了最后一份会话之后，那一份项目环境重新装载一次');

    await assert.rejects(
      bareClient.request('session.create', { projectRoot: second }),
      (error) => (error as { code: string }).code === 'host_project_root_unsupported',
      '装载侧没给那条路时说出来，不用当前这一份项目环境去读别的项目',
    );

    // 不存在的项目根、指向文件的项目根和没有记录目录的有效项目分别返回对应结果。
    await assert.rejects(
      client.request('sessions.list', { projectRoot: join(root, 'never-created') }),
      (error) => (error as { code: string }).code === 'host_project_root_missing',
      '这一条路不存在说出来，不把它当成一份没有会话的项目',
    );
    // 创建会话前先验证项目根，避免无效路径被记录初始化流程创建出来。
    await assert.rejects(
      client.request('session.create', { projectRoot: join(root, 'never-created') }),
      (error) => (error as { code: string }).code === 'host_project_root_missing',
      '拼错的项目根开不成会话',
    );
    assert.equal(await stat(join(root, 'never-created')).then(() => 'created', (error) => (error as { code: string }).code), 'ENOENT',
      '被拒绝的那一次没有留下任何目录');
    await writeFile(join(root, 'a-file.txt'), 'x');
    await assert.rejects(
      client.request('sessions.list', { projectRoot: join(root, 'a-file.txt') }),
      (error) => (error as { code: string }).code === 'host_project_root_not_directory',
      '那一条路是文件：说的不是「不存在」',
    );
    // 当路径中的上级部分是文件时，不同平台可能返回 ENOENT 或 ENOTDIR；两者都表示该路径不能作为目录打开。
    const nested = await client.request('sessions.list', { projectRoot: join(root, 'a-file.txt', 'nested') })
      .then(() => 'resolved', (error) => (error as { code: string }).code);
    assert.ok(nested === 'host_project_root_missing' || nested === 'host_project_root_not_directory',
      `路上有一段是文件时要说出来，实际是 ${nested}`);
    const empty = join(root, 'third');
    await mkdir(empty, { recursive: true });
    assert.deepEqual((await client.request('sessions.list', { projectRoot: empty }) as Listing).sessions, [],
      '有效项目还没跑过任何一轮时交回空列表：记录目录不存在不是错误（参照 E09）');
  } finally {
    pair.client.output.end();
    bare.client.output.end();
    await host.release();
    await bareHost.release();
    await rm(root, { recursive: true, force: true });
  }
});

// 关闭会话会释放运行环境和记录锁，但不修改记录内容。
// 如果轮次仍在运行，关闭操作应先返回冲突，而不打断该轮次。
test('closing a session hands back its record lock and leaves the record alone', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    await connection.request('run.start', { sessionId, input: '说一句' });
    const before = await connection.request('session.read', { sessionId }) as Recorded;

    assert.deepEqual(await connection.request('session.close', { sessionId }), { sessionId });
    await assert.rejects(
      connection.request('session.read', { sessionId }),
      (error) => (error as { code: string }).code === 'session_not_open',
      '收了之后读不到的是这一份装配，不是那一份记录',
    );

    // 会话关闭后锁已释放；重新获取同一路径的独占锁时应返回 `session_locked`。
    const reopened = await connection.request('session.open', { sessionId }) as Named;
    assert.deepEqual(reopened, { sessionId });
    const after = await connection.request('session.read', { sessionId }) as Recorded;
    assert.deepEqual(after.events, before.events, '收过一次之后，记录里的事件一条没多、一条没少');
  });
});

// 读取正在运行的会话不会重建环境、关闭连接或中断当前轮次。
test('opening a session that is already open and running is a read, not an interruption', async () => {
  await withInProcessHost(async (connection, { hold }) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    let release!: (value?: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    hold(gate);
    const running = connection.request('run.start', { sessionId, input: '慢一点' });
    await delay(50);
    assert.deepEqual(await connection.request('session.open', { sessionId }), { sessionId }, '接回来这一份是成立的：它没被打断，也没换装配');
    const read = await connection.request('session.read', { sessionId }) as Recorded;
    assert.ok(read.events.some((event) => event.kind === 'user'), '正在跑的那一句已经在记录里，画面读得到');
    assert.equal((await connection.request('status.get', { sessionId }) as Status).running, true, '这一轮还在跑');
    release(undefined);
    assert.ok((await running as Round).iterations >= 1, '这一轮自己走完了');
  });
});

// 关闭会话时应报告清理失败，并拒绝关闭仍在运行的会话。
test('closing a session while its round runs says so instead of interrupting', async () => {
  await withInProcessHost(async (connection, { hold }) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    let release!: (value?: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    hold(gate);
    const running = connection.request('run.start', { sessionId, input: '慢一点' });
    await delay(50);
    await assert.rejects(
      connection.request('session.close', { sessionId }),
      (error) => (error as { code: string }).code === 'run_already_running',
      'close 不暗中打断正在跑的那一轮',
    );
    release(undefined);
    await running;
    await connection.request('session.close', { sessionId });
    await assert.rejects(
      connection.request('status.get', { sessionId }),
      (error) => (error as { code: string }).code === 'session_not_open',
    );
  });
});

// 历史分页使用事件序号作为游标，确保记录稳定且单调。
// 向前翻页只读取当前页最早事件之前的记录，因此新增事件不会导致旧页重复或遗漏。
test('a history page names its own end and an older page picks up where it stopped', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    await connection.request('run.start', { sessionId, input: '第一轮' });
    await connection.request('run.start', { sessionId, input: '第二轮' });

    const newest = await connection.request('session.read', { sessionId, limit: 3 }) as Recorded;
    assert.equal(newest.events.length, 3, '说了三条就交三条');
    assert.deepEqual(newest.events.map((event) => event.seq), [newest.endSeq - 2, newest.endSeq - 1, newest.endSeq], '序号连着一段，页内从早到晚');
    assert.equal(newest.hasMore, true, '更早的那些还在后面');

    const older = await connection.request('session.read', { sessionId, limit: 3, before: newest.events[0].seq }) as Recorded;
    assert.equal(older.events.at(-1)!.seq, newest.events[0].seq - 1, '上一页的最早一条正好接在下一页的最后一条之后');
    assert.ok(older.events.every((event) => event.seq < newest.events[0].seq), '游标之外的一条也不给');

    // 新事件追加在记录末尾；使用相同游标重新读取时，旧页内容保持不变。
    await connection.request('run.start', { sessionId, input: '第三轮' });
    const again = await connection.request('session.read', { sessionId, limit: 3, before: newest.events[0].seq }) as Recorded;
    assert.deepEqual(again.events.map((event) => event.seq), older.events.map((event) => event.seq), '旧页不重复也不漏');
    const tail = await connection.request('session.read', { sessionId, limit: 3 }) as Recorded;
    assert.ok(tail.endSeq > newest.endSeq, '快照末端跟着新事件往前走');

    const whole = await connection.request('session.read', { sessionId }) as Recorded;
    assert.equal(whole.hasMore, false, '不带那一格就是整份记录，前面没有更早的');
    assert.ok(whole.events.length > tail.events.length, '整份读仍然比一页多');

    const picked = whole.events.find((event) => event.seq === newest.events[1].seq)!;
    const exact = await connection.request('session.read', { sessionId, at: newest.events[1].seq }) as Recorded;
    assert.deepEqual(exact.events, [picked], 'at 精确读回指定的那一条事件');
    assert.equal(exact.endSeq, picked.seq);
    assert.equal(exact.hasMore, picked.seq > 1, '单条读取仍报告它之前是否有记录');

    await assert.rejects(
      connection.request('session.read', { sessionId, before: 9999 }),
      (error) => (error as { code: string }).code === 'session_cursor_invalid',
      '认不出这一份记录里那条序号的游标要说失效，不能静默当成第一页',
    );
    await assert.rejects(
      connection.request('session.read', { sessionId, at: 9999 }),
      (error) => (error as { code: string }).code === 'session_cursor_invalid',
      '不存在的精确事件序号要说游标失效',
    );
    await assert.rejects(
      connection.request('session.read', { sessionId, at: 1, before: 2 }),
      (error) => (error as { code: string }).code === 'protocol_args_invalid',
      '精确读取与向前分页不能同时指定',
    );
  });
});

// 会话名称和归档状态写入会话记录，列表也从同一份记录读取。
test('naming or archiving a session appends one fact the listing reads back', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    await connection.request('run.start', { sessionId, input: '说一句' });
    assert.deepEqual(
      await connection.request('session.label', { sessionId, name: ' 读数那一轮 ' }),
      { sessionId, name: '读数那一轮', archived: false },
      '两端读的是同一份事实',
    );
    assert.deepEqual(
      await connection.request('session.label', { sessionId, archived: true }),
      { sessionId, name: '读数那一轮', archived: true },
      '只说归档时名字沿用，不是清掉',
    );
    const listed = (await connection.request('sessions.list', {}) as Listing).sessions.find((item) => item.id === sessionId)!;
    assert.equal(listed.name, '读数那一轮', '列表那一处读的是记录里折出来的当前值');
    assert.equal(listed.archived, true);
    const page = await connection.request('session.read', { sessionId, before: 2, limit: 1 }) as Recorded;
    assert.deepEqual(page.label, { name: '读数那一轮', archived: true }, '会话标题由完整记录折出，不受当前历史页影响');
    await assert.rejects(
      connection.request('session.label', { sessionId, name: '   ' }),
      (error) => (error as { code: string }).code === 'session_name_invalid',
      '整条空白不算一个名字',
    );
    await assert.rejects(
      connection.request('session.label', { sessionId }),
      (error) => (error as { code: string }).code === 'session_label_empty',
      '什么都不改的一次调用要说出为什么不改',
    );
  });
});

// 跨会话搜索读取 Host 管理的记录目录，并返回会话 ID 和匹配事件序号。
test('a search over the records names the session and the event each hit is in', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    await connection.request('run.start', { sessionId, input: '读数那一段跑一遍' });
    const hits = (await connection.request('sessions.search', { query: '读数' }) as Search).hits;
    assert.deepEqual([hits[0].sessionId, hits[0].kind, hits[0].seq], [sessionId, 'user', 1], '会话 Permission 事实先占一条记录，命中仍指向用户输入');
    assert.ok(hits[0].text.includes('读数'), '摘录带着命中那一段');
    assert.ok(hits.every((hit) => hit.sessionId === sessionId), '这个项目根下只跑过这一份会话');
    assert.deepEqual((await connection.request('sessions.search', { query: '没有这段文字' }) as Search).hits, [], '查不到不是错误');
    // 指定会话时只搜索该会话，并读取存放在溢出文件中的完整工具结果。
    const scoped = await connection.request('sessions.search', { query: '读数', sessionId }) as Search;
    assert.ok(scoped.hits.length > 0 && scoped.hits.every((hit) => hit.sessionId === sessionId), '指名一份就只交那一份的命中');
    await assert.rejects(
      connection.request('sessions.search', { query: '读数', sessionId: '../outside' }),
      (error) => (error as { code: string }).code === 'session_id_invalid',
      '会话编号要拼成记录文件名，形状先查，不混进「找不到这份会话」',
    );
    await assert.rejects(
      connection.request('sessions.search', { query: '   ' }),
      (error) => (error as { code: string }).code === 'search_query_empty',
      '空白的查询在每份记录里都能对上，那一份结果没有意义，扫之前就说清',
    );
  });
});

// 创建分支时复制指定的事件前缀，父会话记录保持不变。
test('branching a session copies a prefix and leaves the parent record alone', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    await connection.request('run.start', { sessionId, input: '说一句' });
    const record = await connection.request('session.read', { sessionId }) as Recorded;
    const marker = record.events.find((event) => event.kind === 'turn');
    assert.ok(marker !== undefined, '一轮正常收尾留下一条可选的轮次标记（第 68 步）');

    const branched = await connection.request('session.branch', { sessionId, at: marker.seq }) as Branch;
    assert.deepEqual([branched.parentSessionId, branched.at], [sessionId, marker.seq], '交回的是新会话与它停在哪一条');
    const opened = await connection.request('session.open', { sessionId: branched.sessionId }) as Named;
    const copied = await connection.request('session.read', { sessionId: opened.sessionId }) as Recorded;
    assert.deepEqual(copied.events.map((event) => event.seq), record.events.filter((event) => event.seq <= marker.seq).map((event) => event.seq),
      '分支那份就是那一段前缀，序号接着父那一份');
    assert.ok((await connection.request('sessions.list', {}) as Listing).sessions.some((item) => item.id === branched.sessionId),
      '写完才出现在列表里');

    const after = await connection.request('session.read', { sessionId }) as Recorded;
    assert.deepEqual(after.events, record.events, '父那一份一个字没动');
    await connection.request('session.close', { sessionId: opened.sessionId });
  });
});

// Host 按项目边界列出文件路径，客户端无需直接扫描文件系统。
// 返回相对路径，排除 `.git`、`node_modules` 和符号链接，并限制结果数量。
test('the host lists project files for an interface without exposing links or noise', async () => {
  await withInProcessHost(async (connection, { directory }) => {
    await mkdir(join(directory, 'notes'), { recursive: true });
    await mkdir(join(directory, '.git'), { recursive: true });
    await mkdir(join(directory, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(directory, 'notes', 'Readings Old.md'), 'x');
    await writeFile(join(directory, 'notes', 'readings-3.md'), 'x');
    await writeFile(join(directory, 'notes', '读数 第三版.md'), 'x');
    await writeFile(join(directory, '.git', 'config'), 'x');
    await writeFile(join(directory, 'node_modules', 'pkg', 'index.js'), 'x');
    // Windows 创建符号链接可能需要开发者模式；权限不足时跳过相关断言。
    let linked = false;
    try {
      await symlink(join(directory, 'notes', 'readings-3.md'), join(directory, 'notes', 'inside-link.md'));
      linked = true;
    } catch {
      linked = false;
    }

    const listed = await connection.request('paths.list', { query: 'readings' }) as Paths;
    assert.deepEqual(listed.paths, ['notes/Readings Old.md', 'notes/readings-3.md'], '大小写不分，交回的是斜杠书写的相对路径');
    assert.equal(listed.projectRoot, directory, '交回的是列的哪一个项目');
    assert.equal(listed.stopped, '', '这一份小目录翻得完，不说「可能没找全」');
    assert.equal((await connection.request('paths.list', { query: 'config' }) as Paths).paths.length, 0, '.git 里的东西不进候选');
    assert.equal((await connection.request('paths.list', { query: 'index.js' }) as Paths).paths.length, 0, 'node_modules 里的东西不进候选');
    if (linked) assert.equal((await connection.request('paths.list', { query: 'inside-link' }) as Paths).paths.length, 0,
      '符号链接既不跟也不列：指向边界之内也一样不替人决定那一条路通向哪里');

    assert.deepEqual((await connection.request('paths.list', { query: '读数' }) as Paths).paths, ['notes/读数 第三版.md'],
      '中文与带空格的文件名照原样交回：路径里那一个空格不改写成别的形状');
    const capped = await connection.request('paths.list', { query: '', limit: 1 }) as Paths;
    assert.equal(capped.paths.length, 1, '一次最多交 `limit` 条');
    await assert.rejects(connection.request('paths.list', { projectRoot: join(directory, 'nope') }),
      (error) => (error as { code: string }).code === 'host_project_root_unsupported', '没装载过的项目根不猜边界');
  });
});

test('a file listing that ran out of its budget says so instead of finding nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-paths-budget-'));
  try {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) await writeFile(join(directory, name), 'x');
    const partial = await listProjectFiles(directory, 'zzz', 20, 2);
    assert.equal(partial.visited, 2, '翻到那一个上限就停手');
    assert.equal(partial.stopped, 'budget', '一条没找到也要说这份清单不一定全：人据此改字重问，不会把没翻完当成项目里没有');
    const complete = await listProjectFiles(directory, 'zzz', 20, 99);
    assert.deepEqual(complete.paths, [], '整棵翻完时才说没有对得上的');
    assert.equal(complete.stopped, '', '整棵翻完时不说「可能没找全」');
  } finally {
    // Windows 可能延迟释放子进程的工作目录句柄；遇到 EBUSY 时短暂重试后再清理。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as { code: string }).code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
  }
});

// 配置提供默认审批档位，会话可以单独覆盖该默认值。
test('a session overrides the approval tier without touching the settings file', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {}) as Named;
    const before = await connection.request('status.get', { sessionId }) as Status;
    assert.equal(before.policySource, 'config', '刚开起来的会话用的是配置那一份');
    const switched = await connection.request('policy.set', { sessionId, mode: 'auto' }) as PolicyReply;
    assert.equal(switched.policy, 'auto');
    assert.equal(switched.policySource, 'session');
    assert.equal(switched.policyDefault, before.policy, '交回的是配置里那一份默认，界面上才有「退回」可说');
    const after = await connection.request('status.get', { sessionId }) as Status;
    assert.equal(after.policy, 'auto');
    assert.equal(after.policySource, 'session');
    const noApproval = await connection.request('policy.set', { sessionId, mode: 'never' }) as PolicyReply;
    assert.equal(noApproval.policy, 'never');
    assert.equal((await connection.request('status.get', { sessionId }) as Status).policy, 'never');
    const back = await connection.request('policy.set', { sessionId, mode: 'default' }) as PolicyReply;
    assert.equal(back.policySource, 'config');
    assert.equal(back.policy, before.policy);
    // 档位覆盖只影响指定会话；同一 Host 中的其他会话继续使用配置默认值。
    const other = await connection.request('session.create', {}) as Named;
    await connection.request('policy.set', { sessionId, mode: 'auto' });
    const aside = await connection.request('status.get', { sessionId: other.sessionId }) as Status;
    assert.equal(aside.policySource, 'config', '另一份会话没有被带着改');
    assert.equal(aside.policy, before.policy);
    assert.equal((await connection.request('status.get', { sessionId }) as Status).policySource, 'session');
    await assert.rejects(
      () => connection.request('policy.set', { sessionId, mode: 'sometimes' }),
      (error) => (error as { code: string }).code === 'policy_mode_unknown',
    );
  });
});

// 用户规则可以补充项目共享规则，单独覆盖同一工具和匹配条件时才替换对应项。
test('a lower layer adds a rule without replacing unrelated shared rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-rules-layer-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const store = createConfigStore({
    projectRoot: root,
    userHome: home,
    layers: { project: { policy: { mode: 'ask', rules: [{ tool: 'read', decision: 'allow' }] } } },
  });
  try {
    await withInProcessHost(async (connection) => {
      const shown = await connection.request('config.get', {}) as View;
      assert.deepEqual(shown.rules, [{ tool: 'read', decision: 'allow' }]);
      assert.equal(shown.rulesSource, 'project', '生效那一份是项目共享那一层写着的');
      const [user] = shown.layers.filter((layer) => layer.layer === 'user');
      await connection.request('config.set', {
        field: 'policy.rules', op: 'add', layer: 'user', version: user.version, ruleTool: 'exec', ruleDecision: 'deny',
      });
      const updated = await connection.request('config.get', {}) as View;
      assert.deepEqual(updated.rules, [
        { tool: 'read', decision: 'allow' },
        { tool: 'exec', decision: 'deny' },
      ]);
      assert.deepEqual(updated.ruleSources, ['project', 'user']);
      assert.equal(updated.rulesSource, 'merged');
      assert.equal((await readFile(join(home, '.ligule', 'config.toml'), 'utf8')).includes('tool = "exec"'), true);
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 新 Host 恢复会话后，应能从溢出文件读取完整工具结果和实际耗时。
// 后续轮次不能改写之前的工具结果；关闭会话时释放写锁。
test('a restarted Host reads back the spilled body and the stored duration of the earlier round', async () => {
  await withHost(async (host, { directory, startAnother }) => {
    host.client.onRequest(() => ({ decision: 'allow' }));
    await writeFile(join(directory, 'note.txt'), '这一段正文要长到越过那一格上限。'.repeat(40));
    const { sessionId } = await host.client.request('session.create', {}) as Named;
    await host.client.request('run.start', { sessionId, input: 'read the note' });

    const first = (await host.client.request('session.read', { sessionId, fullResults: true }) as Recorded).events;
    const tool = first.find((event) => event.kind === 'tool');
    assert.ok(tool !== undefined, `这一轮没留下工具结果那一条事实：${first.map((event) => event.kind).join(',')}`);
    assert.equal(typeof tool.result?.spilled, 'string', `那一次结果没走溢出文件：${String(tool.result?.content).slice(0, 80)}`);
    const stored = tool.durationMs ?? tool.result?.durationMs;
    const body = JSON.stringify(tool.result?.content ?? '');
    assert.equal(typeof stored, 'number', `那次工具调用没带上实际耗时：${body.slice(0, 200)}`);
    const exact = await host.client.request('session.read', { sessionId, at: tool.seq, fullResults: true }) as Recorded;
    assert.equal(exact.events.length, 1, '精确读取只返回这一条工具结果');
    assert.ok(JSON.stringify(exact.events[0].result?.content ?? '').includes('这一段正文要长到越过那一格上限'), '精确读取仍补回该条溢出的完整正文');

    await host.client.request('session.close', { sessionId });
    const again = startAnother();
    try {
      again.client.onRequest(() => ({ decision: 'allow' }));
      await again.client.request('session.open', { sessionId });
      const reread = (await again.client.request('session.read', { sessionId, fullResults: true }) as Recorded).events.find((event) => event.kind === 'tool')!;
      assert.ok(JSON.stringify(reread.result?.content ?? '').includes('这一段正文要长到越过那一格上限'), `重开之后整段正文没读回来：${JSON.stringify(reread.result?.content).slice(0, 120)}`);
      assert.equal(reread.durationMs ?? reread.result?.durationMs, stored, '重开之后那次工具调用的实际耗时变了');
      await again.client.request('run.start', { sessionId, input: 'read the note again' });
      const after = (await again.client.request('session.read', { sessionId, fullResults: true }) as Recorded).events.find((event) => event.kind === 'tool')!;
      assert.equal(after.result?.spilled, tool.result.spilled, '新一轮改写了上一轮那条结果的溢出文件引用');
      assert.equal(after.durationMs ?? after.result?.durationMs, stored, '新一轮改写了上一轮那次调用的实际耗时');
    } finally {
      await stop(again);
    }
  }, ['--config', 'limits.resultBytes=48']);
});

// 输入历史由 Host 管理，客户端可读取和追加内容，但无法查询文件路径。
// 终端和桌面客户端读写同一份历史记录。
test('the host keeps the input history both surfaces share: newest first, one copy per sentence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-input-history-'));
  const previous = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = join(root, 'data');
  const config = createConfig({ user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } });
  const quiet = testHostProvider({ capabilities: MESSAGES_CAPABILITIES, model: 'test-model', async *stream() { yield { type: 'text', text: 'ok' }; } });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider: quiet, policy: { mode: 'auto' } });
  const client = createConnection(pair.client);
  try {
    assert.deepEqual((await client.request('history.read', {}) as History).entries, [], '还没有过任何一次输入不是错误');
    assert.deepEqual((await client.request('history.append', { text: '第一句' }) as History).entries, ['第一句']);
    assert.deepEqual((await client.request('history.append', { text: '  第二句  ' }) as History).entries, ['第二句', '第一句'], '最新的排在最前，两头空的字去掉');
    assert.deepEqual((await client.request('history.append', { text: '第一句' }) as History).entries, ['第一句', '第二句'], '同一句让位过来，不占两格');
    await client.request('history.append', { text: '   ' });
    assert.deepEqual((await client.request('history.read', {}) as History).entries, ['第一句', '第二句'], '什么都没有的那一句不改这份历史');

    await rememberHistory(historyPathOf(), ['另一端写下的一句']);
    assert.deepEqual((await client.request('history.read', {}) as History).entries, ['另一端写下的一句', '第一句', '第二句'], '两端读的是同一份文件');
    assert.ok((await readFile(join(root, 'data', 'tui-history.jsonl'), 'utf8')).split('\n')[0].includes('另一端写下的一句'));
    await assert.rejects(client.request('history.append', {}), (error) => (error as { code: string }).code === 'protocol_args_invalid', '没有句子就没有要记的东西');
  } finally {
    pair.client.output.end();
    await host.release();
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// 桌面偏好由 Host 管理；客户端可读写完整文档，但不能指定文件路径。
// 文件被其他进程修改后应返回最新内容；格式错误的文档必须拒绝。
test('the host keeps one desktop preferences document the interface writes whole and reads back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-desktop-prefs-'));
  const previous = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = join(root, 'data');
  const config = createConfig({ user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } });
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider: providerFromConfig(config), policy: { mode: 'auto' } });
  const client = createConnection(pair.client);
  try {
    const empty = await client.request('prefs.read', {}) as Prefs;
    assert.deepEqual(empty, { settings: {}, version: '' }, '缺失文件有明确的空版本');
    const document = { palette: 'forest', drafts: { '/p': { s1: '没发出去的一句' } }, queued: { '/p': { s1: ['排着的两句'] } } };
    const saved = await client.request('prefs.write', { json: JSON.stringify(document), version: empty.version }) as Prefs;
    assert.deepEqual(saved.settings, document, '写下的那一份交回来');
    assert.notEqual(saved.version, empty.version);
    assert.deepEqual((await client.request('prefs.read', {}) as Prefs).settings, document, '再读回来是同一份');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'data', 'desktop.json'), 'utf8')), document, '文件里就是这一份整份文档');

    await savePrefs(prefsPathOf(), { palette: 'graphite' });
    await assert.rejects(client.request('prefs.write', { json: JSON.stringify(document), version: saved.version }), (error) => (error as { code: string }).code === 'desktop_prefs_version_stale');
    const latest = await client.request('prefs.read', {}) as Prefs;
    assert.deepEqual(latest.settings, { palette: 'graphite' }, '文件被另一端改写后，读出的是文件里那一份');

    await assert.rejects(client.request('prefs.write', { json: '{ not json', version: latest.version }), (error) => (error as { code: string }).code === 'desktop_prefs_invalid', '读不出来的那一份不上桥');
    await assert.rejects(client.request('prefs.write', { json: '[1]', version: latest.version }), (error) => (error as { code: string }).code === 'desktop_prefs_invalid', '不是对象的那一份也拒');
    await assert.rejects(client.request('prefs.write', { json: '{}' }), (error) => (error as { code: string }).code === 'protocol_args_invalid', '未读取版本的客户端不能覆盖文件');
    await assert.rejects(client.request('prefs.write', {}), (error) => (error as { code: string }).code === 'protocol_args_invalid', '没有文档就没有要写的东西');
    assert.deepEqual((await client.request('prefs.read', {}) as Prefs).settings, { palette: 'graphite' }, '被拒的那几次一个字都没写进文件');
  } finally {
    pair.client.output.end();
    await host.release();
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// 数据根没有 `[model]` 配置时，Host 仍可启动，以便用户通过桌面设置完成配置。
// 命令行和终端入口在配置缺失时立即报错，继续使用 `providerFromConfig`。
test('the host keeps a shape to serve from when no model is configured yet', async () => {
  const pending = hostProviderFromConfig({});
  assert.equal(pending.pending, true, '缺的那几格由这一枚占位的顶着');
  assert.equal(typeof pending.stream, 'function', '宿主认的就是 `provider.stream` 是一个函数，这一枚要过得去');
  await assert.rejects(async () => {
    for await (const chunk of pending.stream({ messages: [] } as unknown as ModelRequest)) void chunk;
  }, (error) => (error as { code: string }).code === 'host_model_config_missing', '真要发一轮时说的是缺哪几格');
  assert.throws(() => pending.withModel('deepseek-chat'), (error) => (error as { code: string }).code === 'host_model_config_missing', '换模型也换不出一份不存在的配置');
  assert.equal(hostProviderFromConfig({ model: { api: 'other' } }).pending, true, '线上形状写错的那一种也留着让界面改得动');
  assert.throws(() => providerFromConfig({}), (error) => (error as { code: string }).code === 'host_model_config_missing', '命令行那一路照旧当场说');
});
