import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDelegationGrant, listDelegationGrants } from '../../core/dist/host/agent-control.js';
import { setTrusted } from '../../core/dist/kernel/workspace-trust.js';
import type { Scenario, ScenarioResult, Sample } from '../lib.ts';
import { MOCK_CREDENTIAL, startMockMessagesProvider } from '../provider.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const EXPECTED_TOOLS = 14;

type ToolResult = {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

type McpClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult>;
  close(): Promise<void>;
  getServerVersion(): { name?: string } | undefined;
};

type McpTransport = {
  pid: number | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  onclose?: () => void;
  close(): Promise<void>;
};

type Sdk = {
  createClient: () => McpClient;
  createTransport: (options: Record<string, unknown>) => McpTransport;
};

async function loadSdk(root: string): Promise<Sdk> {
  const esm = join(root, 'dist', 'esm');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(join(esm, 'client', 'index.js')).href) as Promise<{ Client: new (identity: unknown, options: unknown) => McpClient }>,
    import(pathToFileURL(join(esm, 'client', 'stdio.js')).href) as Promise<{ StdioClientTransport: new (options: Record<string, unknown>) => McpTransport }>,
  ]);
  return {
    createClient: () => new Client({ name: 'ligule-benchmark-client', version: '1.0.0' }, { capabilities: {} }),
    createTransport: (options) => new StdioClientTransport(options),
  };
}

function serverEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.LIGULE_HOME = home;
  environment.LIGULE_BENCH_API_KEY = MOCK_CREDENTIAL;
  return environment;
}

function errorCode(result: ToolResult): string | undefined {
  const text = result.content?.find((entry) => entry.type === 'text')?.text;
  if (text === undefined) return undefined;
  try { return (JSON.parse(text) as { code?: string }).code; } catch { return undefined; }
}

function dataOf(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((entry) => entry.type === 'text')?.text;
  if (text === undefined) throw new Error('mcp_tool_result_missing');
  return JSON.parse(text) as Record<string, unknown>;
}

async function startMcp(sdk: Sdk, cli: string, project: string, home: string, grantId: string): Promise<{
  client: McpClient;
  close: () => Promise<void>;
}> {
  const client = sdk.createClient();
  const transport = sdk.createTransport({
    command: process.execPath,
    args: [cli, 'mcp-server', '--project', project, '--grant', grantId],
    cwd: project,
    env: serverEnvironment(home),
    stderr: 'pipe',
    maxBufferSize: 1024 * 1024,
  });
  let stderrText = '';
  transport.stderr?.on('data', (chunk) => { stderrText = (stderrText + String(chunk)).slice(-4_096); });
  let markClosed: () => void = () => undefined;
  const processClosed = new Promise<void>((resolveClosed) => { markClosed = resolveClosed; });
  const inheritedClose = transport.onclose;
  transport.onclose = () => {
    try { inheritedClose?.(); } finally { markClosed(); }
  };
  await client.connect(transport);
  if (transport.pid === null) throw new Error(`mcp_server_process_missing:${stderrText}`);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => undefined);
    await Promise.race([
      processClosed,
      delay(10_000).then(() => { throw new Error('mcp_server_exit_timeout'); }),
    ]);
  };
  return { client, close };
}

async function locateSessionFile(home: string, sessionId: string): Promise<string> {
  for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
      return join(entry.parentPath, entry.name);
    }
  }
  throw new Error(`session_file_missing:${sessionId}`);
}

async function fileIdentity(path: string): Promise<{ sha256: string; mtimeMs: number }> {
  const bytes = await readFile(path);
  const info = await stat(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: info.mtimeMs };
}

export const mcpLifecycle: Scenario = {
  name: 'mcp-lifecycle',
  async run({ repeats, warmup, workRoot }): Promise<ScenarioResult> {
    const cli = process.env.LIGULE_BENCH_CLI === undefined
      ? join(repository, 'tui', 'dist', 'cli.js')
      : resolve(process.env.LIGULE_BENCH_CLI);
    const sdkRoot = process.env.LIGULE_BENCH_MCP_SDK === undefined
      ? join(repository, 'core', 'node_modules', '@modelcontextprotocol', 'sdk')
      : resolve(process.env.LIGULE_BENCH_MCP_SDK);
    const sdk = await loadSdk(sdkRoot);
    const provider = await startMockMessagesProvider();
    const samples: Sample[] = [];
    const execute = async (index: number, record: boolean): Promise<void> => {
      const directory = join(workRoot, `mcp-${index}`);
      const project = join(directory, 'project');
      const home = join(directory, 'home');
      await mkdir(project, { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'config.toml'), [
        '[model]',
        'api = "messages"',
        `baseURL = "${provider.baseUrl}"`,
        'model = "benchmark-model"',
        'apiKeyEnv = "LIGULE_BENCH_API_KEY"',
        'capabilities.streaming = false',
        '[loop]',
        'iterations = 4',
        'modelCalls = 4',
        '[policy]',
        'mode = "auto"',
        '',
      ].join('\n'));
      await setTrusted(project, true, join(home, 'tui-trust.json'));
      const storePath = join(home, 'agent-control.json');
      const created = await createDelegationGrant(storePath, {
        name: 'benchmark receipt',
        projectRoot: project,
        defaultPermissionProfile: 'read-only',
        maxPermissionProfile: 'workspace-write',
        defaultNetwork: 'disabled',
        maxNetwork: 'policy',
        defaultPolicy: 'auto',
        allowedPolicies: ['ask', 'auto', 'none'],
        allowOperator: true,
        confirmPartialWorkspaceWrite: true,
        confirmFullAccess: false,
        confirmUnrestrictedNetwork: false,
        expiresAt: null,
      }, (await listDelegationGrants(storePath)).version);
      const grantId = created.grants[0].id;

      const firstStart = performance.now();
      const first = await startMcp(sdk, cli, project, home, grantId);
      const firstConnectMs = performance.now() - firstStart;
      let sessionId: string;
      let runId: string;
      let toolCount = 0;
      let sessionCreateMs = 0;
      let runMs = 0;
      try {
        const listed = await first.client.listTools();
        toolCount = listed.tools.length;
        if (toolCount !== EXPECTED_TOOLS) throw new Error(`mcp_tools_count:${toolCount}`);
        const missing = await first.client.callTool({ name: 'ligule_run_get', arguments: {
          sessionId: 'benchmark-session-not-opened', runId: 'benchmark-run-not-owned',
        } });
        if (missing.isError !== true || errorCode(missing) !== 'session_not_found') {
          throw new Error(`mcp_receipt_lookup_unexpected:${JSON.stringify(missing).slice(0, 1_000)}`);
        }
        const sessionStarted = performance.now();
        const session = dataOf(await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }));
        sessionCreateMs = performance.now() - sessionStarted;
        if (typeof session.sessionId !== 'string') throw new Error('mcp_session_create_missing_id');
        sessionId = session.sessionId;
        provider.reset();
        const runStarted = performance.now();
        const run = dataOf(await first.client.callTool({ name: 'ligule_run', arguments: {
          sessionId, input: 'Reply with benchmark complete.', requestKey: 'benchmark-receipt',
        } }));
        runMs = performance.now() - runStarted;
        const result = run.result as { runId?: unknown; state?: unknown } | undefined;
        if (run.state !== 'done' || result?.state !== 'completed' || typeof result.runId !== 'string') {
          throw new Error(`mcp_run_unexpected:${JSON.stringify(run).slice(0, 1_000)}`);
        }
        runId = result.runId;
      } finally {
        await first.close();
      }

      const sessionPath = await locateSessionFile(home, sessionId);
      const before = await fileIdentity(sessionPath);
      const secondStart = performance.now();
      const second = await startMcp(sdk, cli, project, home, grantId);
      const secondConnectMs = performance.now() - secondStart;
      try {
        const receiptStarted = performance.now();
        const receipt = dataOf(await second.client.callTool({ name: 'ligule_run_get', arguments: { sessionId, runId } }));
        const receiptReadMs = performance.now() - receiptStarted;
        const stored = receipt.receipt as { runId?: unknown; sessionId?: unknown; state?: unknown } | undefined;
        if (stored?.runId !== runId || stored.sessionId !== sessionId || stored.state !== 'completed') {
          throw new Error(`mcp_receipt_unexpected:${JSON.stringify(receipt).slice(0, 1_000)}`);
        }
        const after = await fileIdentity(sessionPath);
        if (after.sha256 !== before.sha256 || after.mtimeMs !== before.mtimeMs) throw new Error('mcp_receipt_modified_session');
        const files = await readdir(home, { recursive: true });
        if (files.some((name) => name.endsWith('.lock'))) throw new Error('mcp_receipt_took_lock');
        if (record) samples.push({
          workload: 'restart-receipt-read', firstConnectMs, sessionCreateMs, runMs, secondConnectMs, receiptReadMs, tools: toolCount,
        });
      } finally {
        await second.close();
      }
    };
    try {
      for (let index = 0; index < warmup; index += 1) await execute(index, false);
      for (let index = 0; index < repeats; index += 1) await execute(warmup + index, true);
    } finally {
      await provider.close();
    }
    return {
      name: this.name,
      status: 'ok',
      samples,
      notes: {
        cli,
        note: 'Each sample creates a Session and one completed Run through a real MCP process, closes it, then reads the persisted receipt through a new process without session_open. The session JSONL hash and mtime must not change and no lock may appear. An unknown-Session lookup is also exercised before creating the receipt.',
        providerRequestsPerSample: provider.requestCount(),
      },
    };
  },
};
