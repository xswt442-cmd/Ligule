import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../../dist/kernel/config.js';
import type { ConfigSnapshot } from '../../dist/kernel/config.js';
import { createPermissionContext } from '../../dist/kernel/permission.js';
import type { PermissionContext } from '../../dist/kernel/permission.js';
import { detectPermissionCapabilities } from '../../dist/capability/permission-capabilities.js';
import { createConnection } from '../../dist/host/connection.js';
import type { Connection } from '../../dist/host/connection.js';
import { createMemoryConnectionPair } from '../../dist/host/memory.js';
import type { MemoryConnectionPair } from '../../dist/host/memory.js';
import { serveHost } from '../../dist/host/host.js';
import type { Host, HostOptions } from '../../dist/host/host.js';
import { providerFromConfig } from '../../dist/host/provider.js';
import { modeDirectories } from '../../dist/kernel/modes.js';
import { listenFetchable } from './port.ts';

type ChatMessage = { role: string; content?: unknown };

type ChatRequestBody = {
  messages: ChatMessage[];
  tools?: { function: { name: string } }[];
};

type ToolOperation = { tool?: string; args?: unknown; toolCalls?: unknown[] };

type RequestedCall = { tool: string; args?: unknown };

type TestConfig = ConfigSnapshot & {
  boundary: string;
  host: { sessionDirectory: string };
  model: { api: 'chat-completions'; baseURL: string; model: string; apiKeyEnv: string };
  policy: { mode: 'ask' };
};

export type TuiHostSetupPaths = {
  directory: string;
  projectDirectory: string;
  homeDirectory: string;
  sessionDirectory: string;
};

export type TuiHostContext = Omit<TuiHostSetupPaths, 'homeDirectory'> & {
  client: Connection;
  config: TestConfig;
  sessionId: string;
  requests: { method: string; params: unknown }[];
  notifications: Record<string, unknown>[];
  providerRequests: ChatRequestBody[];
  host: Host;
  hostOutput: PassThrough;
  restart(): Promise<Connection>;
};

type AgentControlOption = HostOptions['agentControl'];

export type TuiHostOptions = {
  delayMs?: number;
  beforeResponse?: (body: ChatRequestBody) => void | Promise<void>;
  setup?: (paths: TuiHostSetupPaths) => void | Promise<void>;
  config?: Record<string, unknown>;
  interactive?: boolean;
  permissionControl?: boolean;
  permission?: PermissionContext | ((paths: TuiHostSetupPaths) => PermissionContext | Promise<PermissionContext>);
  extensions?: HostOptions['extensions'];
  agentControl?: AgentControlOption | ((paths: TuiHostSetupPaths) => AgentControlOption | Promise<AgentControlOption>);
  modeName?: string;
  testDirectory?: string;
};

export async function measuredPermissionContext(
  profile: PermissionContext['profile'],
  network: PermissionContext['network'],
): Promise<PermissionContext> {
  const snapshot = await detectPermissionCapabilities();
  return createPermissionContext(profile, network, snapshot.capabilities, {
    profiles: snapshot.profiles,
    limitations: snapshot.limitations,
    partialWorkspaceWriteConfirmationRequired: snapshot.partialWorkspaceWriteConfirmationRequired,
  });
}

function observeFrames(stream: PassThrough, visit: (message: Record<string, unknown>) => void): void {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line !== '') visit(JSON.parse(line) as Record<string, unknown>);
      end = buffer.indexOf('\n');
    }
  });
}

// 轮询条件直到成立或超时；超时时附上最近的终端输出，便于定位失败原因。
export async function waitFor(condition: () => boolean | Promise<boolean>, {
  within = 150_000,
  every = 30,
  read = () => '',
}: { within?: number; every?: number; read?: () => string } = {}): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`等的条件没有成立\n${read().slice(-1_500)}`);
    await delay(every);
  }
}

function requestedCallsOf(operation: ToolOperation | undefined): RequestedCall[] {
  if (Array.isArray(operation?.toolCalls)) {
    return operation.toolCalls.filter((entry): entry is RequestedCall =>
      typeof entry === 'object' && entry !== null && typeof (entry as { tool?: unknown }).tool === 'string');
  }
  return typeof operation?.tool === 'string' ? [{ tool: operation.tool, args: operation.args }] : [];
}

export async function withTuiHost<TResult>(run: (context: TuiHostContext) => TResult | Promise<TResult>, {
  delayMs = 0,
  beforeResponse,
  setup,
  config: extra = {},
  interactive = false,
  permissionControl = false,
  permission,
  extensions,
  agentControl,
  modeName = 'minimal',
  testDirectory = 'testplace',
}: TuiHostOptions = {}): Promise<TResult> {
  const testplace = resolve(testDirectory);
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'tui-host-'));
  const absoluteDirectory = resolve(directory);
  if (!absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('tui_host_test_directory_invalid');
  }
  const homeDirectory = join(directory, 'home');
  const projectDirectory = join(directory, 'project');
  const sessionDirectory = join(directory, 'sessions');
  await Promise.all([mkdir(homeDirectory), mkdir(projectDirectory)]);
  const paths: TuiHostSetupPaths = { directory, projectDirectory, homeDirectory, sessionDirectory };
  await setup?.(paths);
  const agentControlOptions = typeof agentControl === 'function' ? await agentControl(paths) : agentControl;
  const permissionContext = typeof permission === 'function' ? await permission(paths) : permission;

  const envKeys = ['HOME', 'USERPROFILE', 'LIGULE_TUI_TEST_API_KEY'] as const;
  const previousEnv: Partial<Record<(typeof envKeys)[number], string>> = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  process.env.HOME = homeDirectory;
  process.env.USERPROFILE = homeDirectory;
  process.env.LIGULE_TUI_TEST_API_KEY = 'test-key';

  const providerRequests: ChatRequestBody[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString('utf8')) as ChatRequestBody;
      providerRequests.push(body);
      await beforeResponse?.(body);
      const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
      if (typeof lastUser?.content !== 'string') throw new Error('tui_host_user_message_missing');
      let operation: ToolOperation | undefined;
      try { operation = JSON.parse(lastUser.content) as ToolOperation; } catch { /* 普通文本走回显服务。 */ }
      const finalMessage = body.messages.at(-1);
      if (finalMessage === undefined) throw new Error('tui_host_messages_missing');
      const requestedCalls = requestedCallsOf(operation);
      const calls = finalMessage.role === 'tool' ? [] : requestedCalls.filter((call) =>
        body.tools?.some((tool) => tool.function.name === call.tool) === true);
      const answer = `Local response: ${finalMessage.role === 'tool' ? finalMessage.content : lastUser.content}`;
      if (delayMs > 0) await delay(delayMs);
      if (response.destroyed) return;
      const frames = [
        { choices: [{ index: 0, delta: calls.length > 0 ? { tool_calls: calls.map((call, index) => ({
          index, id: randomUUID(), type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args ?? {}) },
        })) } : { content: answer } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }] },
        { choices: [], usage: { prompt_tokens: rawBody.byteLength, completion_tokens: Buffer.byteLength(answer) } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
    } catch {
      // This loopback fixture is test-only. Neither the body nor the stderr line may
      // carry the exception text: a test host that echoes error details back over
      // HTTP or into shared logs is exactly the stack-trace exposure CodeQL reports.
      process.stderr.write('[tui host fixture] request failed\n');
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('tui_host_fixture_failure');
    }
  });

  let host: Host | undefined;
  let pair: MemoryConnectionPair | undefined;
  let client: Connection | undefined;
  let running = false;
  let start: () => Promise<void>;
  const started = (): { host: Host; pair: MemoryConnectionPair; client: Connection } => {
    if (host === undefined || pair === undefined || client === undefined) throw new Error('tui_host_not_started');
    return { host, pair, client };
  };
  const stop = async (): Promise<void> => {
    if (!running) return;
    running = false;
    const current = started();
    try { current.pair.client.output.end(); }
    finally { await current.host.release(); }
  };
  try {
    const baseUrl = `http://127.0.0.1:${await listenFetchable(server)}/v1`;
    const config = createConfig({ user: {
      boundary: projectDirectory,
      host: { sessionDirectory },
      model: { api: 'chat-completions', baseURL: baseUrl, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' },
      loop: { iterations: 2, modelCalls: 2 },
      limits: { contextTokens: 200000 },
      policy: { mode: 'ask' },
      ...extra,
    } }) as TestConfig;
    const provider = providerFromConfig(config);
    const modesDirectory = fileURLToPath(new URL('../../../core/modes/', import.meta.url));
    // 同一 Host 打开第二个项目时，按指定目录重新加载环境；其余配置仍使用默认来源。
    // 配置那一格拼写是 `baseURL`，提供方工厂要的是 `baseUrl`：两边各按各的名字给，不混用。
    const modelShape = { api: 'chat-completions', baseURL: baseUrl, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' };
    const loadEnvironment = async (projectRoot: string) => {
      const sessions = join(projectRoot, 'sessions');
      await mkdir(sessions, { recursive: true });
      const other = createConfig({ user: {
        boundary: projectRoot,
        host: { sessionDirectory: sessions },
        model: modelShape,
        loop: { iterations: 2, modelCalls: 2 },
        limits: { contextTokens: 200000 },
        policy: { mode: 'ask' },
      } }) as TestConfig;
      return {
        config: other,
        provider: providerFromConfig(other),
        policy: other.policy,
        modeName,
        modePaths: modeDirectories(projectRoot, modesDirectory, homeDirectory),
      };
    };
    const requests: TuiHostContext['requests'] = [];
    const notifications: TuiHostContext['notifications'] = [];
    start = async () => {
      pair = createMemoryConnectionPair();
      observeFrames(pair.host.input, (message) => {
        if (typeof message.method === 'string') requests.push({ method: message.method, params: message.params });
      });
      observeFrames(pair.client.input, (message) => {
        if (typeof message.notify === 'string') notifications.push(message);
      });
      host = serveHost({ ...pair.host, config, provider, policy: config.policy, loadEnvironment,
        // 客户端声明支持回答模型提问，与终端和桌面客户端使用相同的协议字段。
        interactive,
        ...(permissionContext === undefined ? {} : { permission: permissionContext }),
        ...(extensions === undefined ? {} : { extensions }),
        ...(agentControlOptions === undefined ? {} : { agentControl: agentControlOptions }),
        permissionControl,
        modeName, modePaths: modeDirectories(projectDirectory, modesDirectory, homeDirectory),
      });
      client = createConnection(pair.client);
      running = true;
    };
    await start();
    const { sessionId } = await started().client.request('session.create', {}) as { sessionId: string };
    return await run({
      get client() { return started().client; },
      config, directory, projectDirectory, sessionDirectory, sessionId, requests, notifications, providerRequests,
      get host() { return started().host; },
      get hostOutput() { return started().pair.host.output; },
      async restart() { await stop(); await start(); return started().client; },
    });
  } finally {
    try {
      try {
        if (running) await stop();
      } finally {
        // 那台 HTTP 服务一定要关掉：它开着的时候整个测试进程退不出去，收尾失败报出来的就只剩一个挂住。
        if (server.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
        }
      }
    } finally {
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
      // A just-released lock entry can briefly race recursive removal on Linux; keep
      // retrying cleanup bounded, and let a persistent filesystem error fail the test.
      await rm(absoluteDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
