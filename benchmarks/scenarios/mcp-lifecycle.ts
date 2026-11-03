import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setTrusted } from '../../core/dist/kernel/workspace-trust.js';
import type { Scenario, ScenarioResult, Sample } from '../lib.ts';

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

async function loadSdk(root: string): Promise<{
  createClient: () => McpClient;
  createTransport: (options: Record<string, unknown>) => McpTransport;
}> {
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
  return environment;
}

function errorCode(result: ToolResult): string | undefined {
  const text = result.content?.find((entry) => entry.type === 'text')?.text;
  if (text === undefined) return undefined;
  try { return (JSON.parse(text) as { code?: string }).code; } catch { return undefined; }
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
    const samples: Sample[] = [];
    const execute = async (index: number, record: boolean): Promise<void> => {
      const directory = join(workRoot, `mcp-${index}`);
      const project = join(directory, 'project');
      const home = join(directory, 'home');
      await mkdir(project, { recursive: true });
      await mkdir(home, { recursive: true });
      await setTrusted(project, true, join(home, 'tui-trust.json'));
      const client = sdk.createClient();
      const transport = sdk.createTransport({
        command: process.execPath,
        args: [cli, 'mcp-server', '--project', project],
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
      try {
        const connectStarted = performance.now();
        await client.connect(transport);
        const connectMs = performance.now() - connectStarted;
        if (transport.pid === null) throw new Error(`mcp_server_process_missing:${stderrText}`);
        const serverName = client.getServerVersion()?.name;
        if (serverName !== 'ligule') throw new Error(`mcp_server_identity_invalid:${String(serverName)}`);
        const listStarted = performance.now();
        const listed = await client.listTools();
        const toolsListMs = performance.now() - listStarted;
        if (listed.tools.length !== EXPECTED_TOOLS) throw new Error(`mcp_tools_count:${listed.tools.length}`);
        const lookupStarted = performance.now();
        const lookup = await client.callTool({ name: 'ligule_run_get', arguments: {
          sessionId: 'benchmark-session-not-opened', runId: 'benchmark-run-not-owned',
        } });
        const receiptLookupMs = performance.now() - lookupStarted;
        if (lookup.isError !== true || errorCode(lookup) !== 'session_not_found') {
          throw new Error(`mcp_receipt_lookup_unexpected:${JSON.stringify(lookup).slice(0, 1_000)}`);
        }
        const closeStarted = performance.now();
        await client.close();
        const closeMs = performance.now() - closeStarted;
        const exitStarted = performance.now();
        await Promise.race([
          processClosed,
          delay(10_000).then(() => { throw new Error('mcp_server_exit_timeout'); }),
        ]);
        const processExitMs = performance.now() - exitStarted;
        if (record) samples.push({ connectMs, toolsListMs, receiptLookupMs, closeMs, processExitMs, tools: listed.tools.length });
      } finally {
        await client.close().catch(() => undefined);
      }
    };
    for (let index = 0; index < warmup; index += 1) await execute(index, false);
    for (let index = 0; index < repeats; index += 1) await execute(warmup + index, true);
    return {
      name: this.name,
      status: 'ok',
      samples,
      notes: {
        cli,
        note: 'receiptLookupMs queries an unknown Session and verifies the read-only session_not_found path without opening a writer.',
      },
    };
  },
};
