// MCP 仅支持 stdio 传输，协议实现使用官方 SDK。
//
// `mcp.servers.<name>` 配置包含可执行文件 `command`，以及可选的 `args`、`env` 和 `cwd`。
// `command` 作为可执行文件直接启动，不经过 shell。`env` 只支持 `${NAME}` 环境变量引用，不接受明文凭据。
//
// 模型只看到固定的 `mcp.inspect` 和 `mcp.call` 工具；服务器自身的工具定义按需披露，不会扩大基础工具清单。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { KernelError } from '../errors.js';
import { createOwnedProcessJob, type OwnedProcessJob } from './win32-job.js';

export interface McpServerConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

export interface NormalizedMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly identityDigest: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  digest: string;
  annotations: Record<string, unknown>;
}

export type McpToolPolicy = (server: string, tool: string, inputSchema: Record<string, unknown>) => Record<string, unknown> | undefined;

export interface McpRegistryOptions {
  readonly assertServerAccess?: (server: string) => void;
  readonly toolPolicy?: McpToolPolicy;
  readonly afterCall?: (server: string) => Promise<void>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  child?: ChildProcess;
  processGroupId?: number;
  job?: OwnedProcessJob;
  jobAssigned?: boolean;
  toolPolicy?: McpToolPolicy;
  tools: Map<string, ToolDefinition>;
}

const MCP_RUNTIME_ENVIRONMENT = new Set([
  'appdata', 'ci', 'comspec', 'force_color', 'home', 'homedrive', 'homepath', 'lang', 'lc_all',
  'localappdata', 'no_color', 'path', 'pathext', 'systemdrive', 'systemroot', 'term', 'tmp',
  'temp', 'tmpdir', 'userprofile', 'windir',
]);

function mcpEnvironment(referenced: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && MCP_RUNTIME_ENVIRONMENT.has(name.toLowerCase())) environment[name] = value;
  }
  return { ...environment, ...referenced };
}

async function refreshTools(opened: ConnectedServer, signal?: AbortSignal): Promise<Map<string, ToolDefinition>> {
  const listed = await opened.client.listTools(undefined, signal === undefined ? undefined : { signal });
  const tools = new Map<string, ToolDefinition>();
  for (const raw of listed.tools as unknown as Record<string, unknown>[]) {
    const definition = definitionOf(raw, opened.name, opened.toolPolicy);
    if (definition !== undefined) tools.set(definition.name, definition);
  }
  opened.tools = tools;
  return opened.tools;
}

// 环境值必须完整匹配 `${NAME}`；不支持在普通字符串中插值。
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function expandEnv(env: Record<string, unknown>, environment: NodeJS.ProcessEnv): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new KernelError('mcp_env_unsupported', { detail: `${key} must be a "\${NAME}" reference` });
    const matched = ENV_REFERENCE.exec(value);
    if (matched === null) throw new KernelError('mcp_env_unsupported', { detail: `${key}="${value}" is not a \${NAME} reference` });
    const taken = environment[matched[1]];
    // 环境变量未设置时省略该项，不把 `${NAME}` 字面字符串传给服务器。
    if (taken !== undefined) expanded[key] = taken;
  }
  return expanded;
}

function definitionOf(
  raw: { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown },
  server: string,
  policy?: McpToolPolicy,
): ToolDefinition | undefined {
  if (typeof raw.name !== 'string' || raw.name === '') throw new KernelError('mcp_tool_name_missing');
  const originalSchema = (raw.inputSchema ?? { type: 'object' }) as Record<string, unknown>;
  let schema = originalSchema;
  if (policy !== undefined) {
    const filtered = policy(server, raw.name, structuredClone(originalSchema));
    if (filtered === undefined) return undefined;
    if (typeof filtered !== 'object' || filtered === null || Array.isArray(filtered)) {
      throw new KernelError('mcp_tool_policy_invalid');
    }
    schema = structuredClone(filtered);
  }
  // 摘要覆盖模型可见的名称、说明、参数结构和标注；这些定义任一变化都会改变摘要。
  const digest = createHash('sha256').update(JSON.stringify({
    name: raw.name,
    description: raw.description ?? '',
    inputSchema: schema,
    annotations: raw.annotations ?? {},
  })).digest('hex').slice(0, 12);
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    inputSchema: schema,
    digest,
    annotations: (raw.annotations ?? {}) as Record<string, unknown>,
  };
}

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const DRAFT_7 = 'http://json-schema.org/draft-07/schema#';

export function validateToolArguments(args: unknown, schema: Record<string, unknown>): string[] {
  try {
    const declaredDialect = schema.$schema;
    const options = {
      allErrors: true,
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      validateFormats: true,
      validateSchema: true,
    };
    const ajv = declaredDialect === undefined || declaredDialect === DRAFT_2020_12
      ? new Ajv2020(options)
      : declaredDialect === DRAFT_7
        ? new Ajv(options)
        : undefined;
    if (ajv === undefined) return [`tool schema dialect is unsupported: ${String(declaredDialect)}`];
    formatsModule.default.default(ajv as Ajv);
    const validator = new AjvJsonSchemaValidator(ajv as Ajv);
    const validate = validator.getValidator<Record<string, unknown>>({ type: 'object', ...schema } as JsonSchemaType);
    const result = validate(args);
    return result.valid ? [] : [result.errorMessage ?? 'arguments do not match the tool schema'];
  } catch (error) {
    return [`tool schema cannot be validated: ${error instanceof Error ? error.message : String(error)}`];
  }
}

// 将 MCP 配置转换为按名称排序的服务器列表，保证重复加载结果顺序稳定。
export function mcpServerConfigs(
  config: { mcp?: { servers?: unknown } },
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): NormalizedMcpServerConfig[] {
  const servers = (config.mcp?.servers ?? {}) as Record<string, McpServerConfig>;
  return Object.keys(servers).sort().map((name) => {
    const entry = servers[name];
    if (typeof entry?.command !== 'string' || entry.command === '') throw new KernelError('mcp_command_required', { detail: `${name} needs a command` });
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') throw new KernelError('mcp_cwd_invalid', { detail: name });
    const cwd = entry.cwd === undefined ? resolve(projectRoot) : resolve(projectRoot, entry.cwd);
    const commandUsesPath = !entry.command.includes('/') && !entry.command.includes('\\') && !isAbsolute(entry.command);
    const command = commandUsesPath ? entry.command : resolve(cwd, entry.command);
    // `command` 必须是可执行文件路径，不能包含参数或 shell 管道。
    if (/\s/.test(entry.command) && !existsSync(command)) throw new KernelError('mcp_command_invalid', { detail: `${name}.command is a single executable; put its arguments in args` });
    const args = entry.args === undefined ? [] : entry.args;
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new KernelError('mcp_args_invalid', { detail: `${name}.args must be an array of strings` });
    const env = entry.env === undefined ? {} : entry.env;
    if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new KernelError('mcp_env_invalid', { detail: `${name}.env must be a table of \${NAME} references` });
    const references = env as Record<string, unknown>;
    const environmentNames = Object.keys(references).sort();
    const identityDigest = createHash('sha256').update(JSON.stringify({
      name,
      command,
      args,
      cwd,
      env: environmentNames.map((key) => [key, references[key]]),
      ...(commandUsesPath ? { path: environment.PATH ?? '' } : {}),
    })).digest('hex');
    return {
      name,
      command,
      args: args as string[],
      env: expandEnv(references, environment),
      cwd,
      environmentNames,
      identityDigest,
    };
  });
}

function childIsAlive(child: ChildProcess | undefined): child is ChildProcess & { pid: number } {
  return child?.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function waitForChildClose(child: ChildProcess): Promise<void> {
  if (!childIsAlive(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.off('close', finish);
      reject(new KernelError('mcp_process_cleanup_failed', { detail: `server process ${child.pid} remained alive after termination` }));
    }, 5_000);
    child.once('close', finish);
  });
}

const MCP_PROCESS_GROUP_START_TIMEOUT_MS = 2_000;
const MCP_PROCESS_GROUP_TERM_TIMEOUT_MS = 1_000;
const MCP_PROCESS_GROUP_KILL_TIMEOUT_MS = 1_000;

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroup(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

async function processGroupOf(child: ChildProcess | undefined): Promise<number | undefined> {
  if (child?.pid === undefined) return undefined;
  const deadline = Date.now() + MCP_PROCESS_GROUP_START_TIMEOUT_MS;
  while (true) {
    try {
      process.kill(-child.pid, 0);
      return child.pid;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
    if (!childIsAlive(child) || Date.now() >= deadline) return undefined;
    await delay(10);
  }
}

async function processGroupLauncherPath(): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  if (typeof process.execve !== 'function') {
    throw new KernelError('mcp_process_group_unavailable', { detail: 'POSIX MCP process groups require Node.js process.execve support' });
  }
  try {
    const koffiModule = await import('koffi');
    koffiModule.default.load(null).func('int setsid(void)');
  } catch (cause) {
    throw new KernelError('mcp_process_group_unavailable', {
      cause,
      detail: 'POSIX MCP process groups require the Koffi native dependency and libc setsid support',
    });
  }
  return fileURLToPath(new URL('./mcp-posix.js', import.meta.url));
}

async function terminatePosixProcessGroup(processGroupId: number): Promise<void> {
  if (!processGroupExists(processGroupId)) return;
  try { process.kill(-processGroupId, 'SIGTERM'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    // Still attempt the bounded forced stop below; it may succeed when graceful termination did not.
  }
  if (await waitForProcessGroup(processGroupId, MCP_PROCESS_GROUP_TERM_TIMEOUT_MS)) return;

  try { process.kill(-processGroupId, 'SIGKILL'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new KernelError('mcp_process_cleanup_failed', {
      cause: error,
      detail: `could not force-stop owned MCP process group ${processGroupId}`,
    });
  }
  if (!await waitForProcessGroup(processGroupId, MCP_PROCESS_GROUP_KILL_TIMEOUT_MS)) {
    throw new KernelError('mcp_process_cleanup_failed', {
      detail: `owned MCP process group ${processGroupId} remained alive after SIGKILL`,
    });
  }
}

async function terminateWindowsTree(child: ChildProcess | undefined): Promise<void> {
  if (!childIsAlive(child)) return;
  let code: number | null;
  try {
    const killer = spawn('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    code = await new Promise<number | null>((resolve, reject) => {
      killer.once('error', reject);
      killer.once('close', resolve);
    });
  } catch (cause) {
    if (!childIsAlive(child)) return;
    throw new KernelError('mcp_process_cleanup_failed', { cause, detail: `could not terminate server process ${child.pid}` });
  }
  if (childIsAlive(child)) {
    if (code !== 0) throw new KernelError('mcp_process_cleanup_failed', { detail: `taskkill could not terminate server process ${child.pid} (exit ${code ?? 'unknown'})` });
    await waitForChildClose(child);
  }
}

function throwCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

async function closeClient(opened: Pick<ConnectedServer, 'client' | 'child' | 'processGroupId' | 'job' | 'jobAssigned'>): Promise<void> {
  const errors: unknown[] = [];
  let jobClosed = opened.job === undefined;
  if (opened.job !== undefined) {
    try { opened.job.close(); jobClosed = true; }
    catch (error) { errors.push(error); }
  }

  if (process.platform === 'win32') {
    if (opened.jobAssigned !== true || !jobClosed) {
      try { await terminateWindowsTree(opened.child); }
      catch (error) { errors.push(error); }
    } else if (opened.child !== undefined) {
      try { await waitForChildClose(opened.child); }
      catch (error) {
        errors.push(error);
        try { await terminateWindowsTree(opened.child); }
        catch (fallbackError) { errors.push(fallbackError); }
      }
    }
  }

  try { await opened.client.close(); }
  catch (error) { errors.push(error); }

  if (process.platform !== 'win32' && opened.processGroupId !== undefined) {
    try { await terminatePosixProcessGroup(opened.processGroupId); }
    catch (error) { errors.push(error); }
    if (opened.child !== undefined) {
      try { await waitForChildClose(opened.child); }
      catch (error) { errors.push(error); }
    }
  }
  throwCleanupErrors(errors, 'MCP client cleanup failed');
}

// 每台服务器最多启动一个子进程，并在 Host 生命周期内复用；不自动重连或并发启动多个进程。
export async function connectServer(
  settings: NormalizedMcpServerConfig,
  signal?: AbortSignal,
  toolPolicy?: McpToolPolicy,
  onCleanupPending?: (opened: ConnectedServer) => void,
): Promise<ConnectedServer> {
  const job = process.platform === 'win32' ? await createOwnedProcessJob({ assignCurrentProcess: false }) : undefined;
  const processGroupLauncher = await processGroupLauncherPath();
  const transport = new StdioClientTransport({
    command: processGroupLauncher === undefined ? settings.command : process.execPath,
    args: processGroupLauncher === undefined ? settings.args : [processGroupLauncher, settings.command, ...settings.args],
    cwd: settings.cwd,
    env: mcpEnvironment(settings.env),
    stderr: 'pipe',
  });
  // Drain diagnostics without retaining or logging server output that may contain credentials.
  (transport.stderr as { resume?: () => void } | null)?.resume?.();
  // 这是 MCP 客户端协议身份，不代表 Core 有独立版本。
  const client = new Client({ name: 'ligule', version: '1.0.0' });
  let child: ChildProcess | undefined;
  let processGroupId: number | undefined;
  let jobAssigned = false;
  try {
    const connecting = client.connect(transport, signal === undefined ? undefined : { signal });
    child = (transport as unknown as { _process?: ChildProcess })._process;
    connecting.catch(() => undefined);
    if (job !== undefined && child?.pid !== undefined) {
      job.assignPid(child.pid);
      jobAssigned = true;
    }
    await connecting;
    child ??= (transport as unknown as { _process?: ChildProcess })._process;
    if (child?.pid === undefined) throw new KernelError('mcp_process_unavailable', { detail: settings.name });
    if (processGroupLauncher !== undefined) {
      processGroupId = await processGroupOf(child);
      if (processGroupId === undefined) throw new KernelError('mcp_process_group_unavailable', { detail: settings.name });
    }
    if (job !== undefined && !jobAssigned) {
      job.assignPid(child.pid);
      jobAssigned = true;
    }
    const opened = { name: settings.name, client, child, processGroupId, job, jobAssigned, toolPolicy, tools: new Map<string, ToolDefinition>() };
    await refreshTools(opened, signal);
    return opened;
  } catch (error) {
    child ??= (transport as unknown as { _process?: ChildProcess })._process;
    let failureCause: unknown = error;
    if (processGroupLauncher !== undefined && processGroupId === undefined) {
      try { processGroupId = await processGroupOf(child); }
      catch (groupError) {
        failureCause = new AggregateError([error, groupError], 'MCP connection and process-group inspection failed');
      }
    }
    const failure = new KernelError('mcp_connect_failed', {
      cause: failureCause,
      detail: `${settings.name}: ${error instanceof Error ? error.message : String(error)}`,
    });
    const opened = { name: settings.name, client, child, processGroupId, job, jobAssigned, toolPolicy, tools: new Map<string, ToolDefinition>() };
    try { await closeClient(opened); }
    catch (cleanupError) {
      onCleanupPending?.(opened);
      throw new KernelError('mcp_connect_failed', { cause: new AggregateError([failure, cleanupError], 'MCP connection and cleanup failed'), detail: failure.detail });
    }
    throw failure;
  }
}

export interface McpRegistry {
  servers(): string[];
  activeServers(): string[];
  toolsOf(server: string, signal?: AbortSignal): Promise<ToolDefinition[]>;
  definition(server: string, tool: string, signal?: AbortSignal): Promise<ToolDefinition>;
  call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  revoke(server: string): Promise<void>;
  close(): Promise<void>;
}

// 服务器按需连接；未使用的服务器不会启动子进程。
export function createMcpRegistry(configs: NormalizedMcpServerConfig[], options: McpRegistryOptions = {}): McpRegistry {
  const connected = new Map<string, ConnectedServer>();
  const pending = new Map<string, Promise<ConnectedServer>>();
  const cleanupPending = new Set<ConnectedServer>();
  const serverLifetimes = new Map<string, AbortController>();
  const stopping = new Map<string, Promise<void>>();
  const lifetime = new AbortController();
  const closedClients = new WeakSet<Client>();
  const closingClients = new WeakMap<Client, Promise<void>>();
  let closing: Promise<void> | undefined;

  function operationSignal(name: string, signal?: AbortSignal): AbortSignal {
    let serverLifetime = serverLifetimes.get(name);
    if (serverLifetime === undefined) {
      serverLifetime = new AbortController();
      serverLifetimes.set(name, serverLifetime);
    }
    return signal === undefined
      ? AbortSignal.any([lifetime.signal, serverLifetime.signal])
      : AbortSignal.any([lifetime.signal, serverLifetime.signal, signal]);
  }

  async function closeServer(opened: ConnectedServer): Promise<void> {
    if (closedClients.has(opened.client)) return;
    const existing = closingClients.get(opened.client);
    if (existing !== undefined) return existing;
    const attempt = closeClient(opened).then(() => {
      closedClients.add(opened.client);
      cleanupPending.delete(opened);
    }, error => {
      cleanupPending.add(opened);
      throw error;
    }).finally(() => {
      if (closingClients.get(opened.client) === attempt) closingClients.delete(opened.client);
    });
    closingClients.set(opened.client, attempt);
    return attempt;
  }

  function watchProcessGroupExit(opened: ConnectedServer): void {
    if (opened.processGroupId === undefined || opened.child === undefined) return;
    const cleanup = () => {
      cleanupPending.add(opened);
      void closeServer(opened).then(() => {
        if (connected.get(opened.name) === opened) connected.delete(opened.name);
      }).catch(() => undefined);
    };
    opened.child.once('exit', cleanup);
    if (!childIsAlive(opened.child)) cleanup();
  }

  async function server(name: string, signal?: AbortSignal): Promise<ConnectedServer> {
    await stopping.get(name);
    const activeSignal = operationSignal(name, signal);
    if (activeSignal.aborted) throw activeSignal.reason;
    options.assertServerAccess?.(name);
    const existing = connected.get(name);
    if (existing !== undefined) return existing;
    const settings = configs.find((entry) => entry.name === name);
    if (settings === undefined) throw new KernelError('mcp_server_unknown', { detail: `${name} (configured: ${configs.map((entry) => entry.name).join(', ') || 'none'})` });
    const started = pending.get(name) ?? connectServer(settings, activeSignal, options.toolPolicy,
      opened => cleanupPending.add(opened));
    pending.set(name, started);
    try {
      const opened = await started;
      if (activeSignal.aborted) {
        await closeServer(opened);
        throw activeSignal.reason;
      }
      connected.set(name, opened);
      watchProcessGroupExit(opened);
      return opened;
    } finally {
      if (pending.get(name) === started) pending.delete(name);
    }
  }

  return {
    servers: () => configs.map((entry) => entry.name),
    activeServers: () => [...connected.keys()],
    // 每次读取定义时重新获取工具列表，以检测服务器声明是否变化并更新摘要。
    toolsOf: async (name, signal) => [...(await refreshTools(await server(name, signal), operationSignal(name, signal))).values()],
    definition: async (name, tool, signal) => {
      const activeSignal = operationSignal(name, signal);
      const opened = await server(name, activeSignal);
      await refreshTools(opened, activeSignal);
      const found = opened.tools.get(tool);
      if (found === undefined) throw new KernelError('mcp_tool_unknown', { detail: `${name}/${tool}` });
      return found;
    },
    call: async (name, tool, args, signal) => {
      const activeSignal = operationSignal(name, signal);
      const opened = await server(name, activeSignal);
      if (opened.toolPolicy === undefined) {
        if (!opened.tools.has(tool)) throw new KernelError('mcp_tool_unknown', { detail: `${name}/${tool}` });
      } else {
        await refreshTools(opened, activeSignal);
        const definition = opened.tools.get(tool);
        if (definition === undefined) throw new KernelError('mcp_tool_unknown', { detail: `${name}/${tool}` });
        const problems = validateToolArguments(args, definition.inputSchema);
        if (problems.length > 0) throw new KernelError('mcp_arguments_invalid', { detail: problems.join('; ') });
      }
      try {
        return await opened.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, { signal: activeSignal });
      } finally {
        if (!activeSignal.aborted) await options.afterCall?.(name);
      }
    },
    revoke: (name) => {
      const alreadyStopping = stopping.get(name);
      if (alreadyStopping !== undefined) return alreadyStopping;
      const controller = serverLifetimes.get(name);
      controller?.abort(new KernelError('mcp_server_untrusted', { detail: name }));
      const closing = (async () => {
        const inflight = pending.get(name);
        if (inflight !== undefined) await inflight.catch(() => undefined);
        const opened = new Set([...cleanupPending].filter(item => item.name === name));
        const active = connected.get(name);
        if (active !== undefined) opened.add(active);
        const results = await Promise.allSettled([...opened].map(async item => {
          await closeServer(item);
          if (connected.get(name) === item) connected.delete(name);
        }));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length > 0) throwCleanupErrors(errors, 'MCP server cleanup failed');
        pending.delete(name);
        serverLifetimes.delete(name);
      })();
      stopping.set(name, closing);
      return closing.finally(() => {
        if (stopping.get(name) === closing) stopping.delete(name);
      });
    },
    // 先关闭 stdin，再发送 SIGTERM，最后终止仍存活的子进程树。
    close: () => {
      if (closing !== undefined) return closing;
      lifetime.abort(new Error('MCP registry closed'));
      const attempt = (async () => {
        const settled = await Promise.allSettled([...pending.values()]);
        const opened = new Set([...connected.values(), ...cleanupPending]);
        for (const result of settled) if (result.status === 'fulfilled') opened.add(result.value);
        const cleanup = await Promise.allSettled([...opened].map(async item => {
          await closeServer(item);
          for (const [name, active] of connected) if (active === item) connected.delete(name);
        }));
        const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        throwCleanupErrors(errors, 'MCP registry cleanup failed');
        cleanupPending.clear();
        pending.clear();
        serverLifetimes.clear();
      })();
      closing = attempt;
      void attempt.catch(() => { if (closing === attempt) closing = undefined; });
      return attempt;
    },
  };
}
