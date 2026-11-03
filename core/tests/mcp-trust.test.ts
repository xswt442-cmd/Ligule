import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { listMcpTrust, mcpServerTrust, setMcpServerTrust } from '../dist/host/mcp-trust.js';
import { createHost } from '../dist/host/host.js';
import type { HostProvider } from '../dist/host/provider.js';
import { createConfig } from '../dist/kernel/config.js';
import { MESSAGES_CAPABILITIES } from '../dist/index.js';

type McpTrustView = {
  version: string;
  servers: { identityDigest: string; trust: { scope: string; trusted: boolean } | null }[];
};

type McpToolsView = { tools: { name: string }[] };

const minimalServer = fileURLToPath(new URL('../../tests/fixtures/mcp-minimal.mjs', import.meta.url));
const cancellableServer = fileURLToPath(new URL('./fixtures/mcp-cancellable.mjs', import.meta.url));

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error instanceof Error && (error as { code?: string }).code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('mcp_fixture_process_still_running');
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await access(path); return; }
    catch (error) { if (!(error instanceof Error && (error as { code?: string }).code === 'ENOENT')) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`mcp_fixture_marker_missing: ${path}`);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

test('user trust applies across projects, project denial masks it, and a changed server identity is untrusted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-trust-'));
  const firstProject = join(root, 'first');
  const secondProject = join(root, 'second');
  const storePath = join(root, 'home', 'mcp-trust.json');
  await mkdir(firstProject, { recursive: true });
  await mkdir(secondProject, { recursive: true });
  const digest = 'a'.repeat(64);
  try {
    const empty = await listMcpTrust(storePath);
    const user = await setMcpServerTrust(storePath, {
      scope: 'user', projectRoot: firstProject, server: 'playwright', identityDigest: digest, trusted: true,
    }, empty.version);

    assert.equal((await mcpServerTrust(storePath, firstProject, 'playwright', digest))?.trusted, true);
    assert.equal((await mcpServerTrust(storePath, secondProject, 'playwright', digest))?.scope, 'user');
    assert.equal(await mcpServerTrust(storePath, secondProject, 'playwright', 'b'.repeat(64)), undefined);

    const project = await setMcpServerTrust(storePath, {
      scope: 'project', projectRoot: firstProject, server: 'playwright', identityDigest: digest, trusted: false,
    }, user.version);
    const blocked = await mcpServerTrust(storePath, firstProject, 'playwright', digest);
    assert.equal(blocked?.scope, 'project');
    assert.equal(blocked?.trusted, false);
    assert.equal((await mcpServerTrust(storePath, secondProject, 'playwright', digest))?.trusted, true);
    assert.equal((await listMcpTrust(storePath)).version, project.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale trust writes and malformed trust files fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-trust-'));
  const projectRoot = join(root, 'project');
  const storePath = join(root, 'home', 'mcp-trust.json');
  await mkdir(projectRoot, { recursive: true });
  try {
    const first = await listMcpTrust(storePath);
    await setMcpServerTrust(storePath, {
      scope: 'project', projectRoot, server: 'playwright', identityDigest: 'a'.repeat(64), trusted: true,
    }, first.version);
    await assert.rejects(
      () => setMcpServerTrust(storePath, {
        scope: 'project', projectRoot, server: 'playwright', identityDigest: 'b'.repeat(64), trusted: true,
      }, first.version),
      (error) => hasCode(error, 'mcp_trust_version_stale'),
    );

    await writeFile(storePath, '{ invalid json');
    await assert.rejects(() => listMcpTrust(storePath), (error) => hasCode(error, 'mcp_trust_store_invalid'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Host trusts only the current server identity and starts it only after trusted UI confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-trust-host-'));
  const projectRoot = join(root, 'project');
  const home = join(root, 'home');
  const projectConfig = join(projectRoot, '.ligule', 'config.toml');
  const schemaPath = join(root, 'schema.json');
  const marker = join(root, 'started.pid');
  await mkdir(join(projectRoot, '.ligule'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(schemaPath, JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }));
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  const serverSettings = { command: process.execPath, args: [minimalServer, schemaPath, marker] };
  const writeProjectConfig = async (markerPath: string) => writeFile(projectConfig, [
    '[mcp.servers.probe]',
    'command = ' + JSON.stringify(process.execPath),
    'args = [' + [minimalServer, schemaPath, markerPath].map((value) => JSON.stringify(value)).join(', ') + ']',
    '',
  ].join('\n'));
  await writeProjectConfig(marker);
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'trust-test',
    async *stream() { yield { type: 'text', text: 'ready' }; },
  } as unknown as HostProvider;
  const config = createConfig({ user: {
    boundary: projectRoot, workspaceRoot: projectRoot,
    mcp: { servers: { probe: serverSettings } },
  } });
  const hostOptions = {
    config, provider, permissionControl: true,
    loadEnvironment: async () => ({ config, provider }),
  };
  const connection = { notify() {}, async request() { return { decision: 'deny' }; } };
  try {
    const untrustedHost = createHost({ ...hostOptions, permissionControl: false });
    try {
      await assert.rejects(
        () => untrustedHost.handle({ method: 'mcp.trust.list', params: {} }, connection),
        (error) => hasCode(error, 'mcp_trust_trusted_ui_required'),
      );
      await assert.rejects(
        () => untrustedHost.handle({ method: 'mcp.trust.set', params: {
          server: 'probe', identityDigest: 'a'.repeat(64), scope: 'project', trusted: true,
          confirmTrust: true, confirmExternalAccess: true, version: 'empty',
        } }, connection),
        (error) => hasCode(error, 'mcp_trust_trusted_ui_required'),
      );
    } finally {
      await untrustedHost.release();
    }

    const host = createHost(hostOptions);
    try {
      const listed = await host.handle({ method: 'mcp.trust.list', params: {} }, connection) as McpTrustView;
      assert.equal(listed.servers[0].trust, null);
      await assert.rejects(
        () => host.handle({ method: 'mcp.trust.tools', params: { server: 'probe' } }, connection),
        (error) => hasCode(error, 'mcp_server_untrusted'),
      );
      await assert.rejects(() => access(marker), (error) => hasCode(error, 'ENOENT'));

      await assert.rejects(() => host.handle({ method: 'mcp.trust.set', params: {
        server: 'probe', identityDigest: listed.servers[0].identityDigest,
        scope: 'project', trusted: true, version: listed.version,
      } }, connection), (error) => hasCode(error, 'mcp_trust_confirmation_required'));
      await assert.rejects(() => access(marker), (error) => hasCode(error, 'ENOENT'));

      const trusted = await host.handle({ method: 'mcp.trust.set', params: {
        server: 'probe', identityDigest: listed.servers[0].identityDigest,
        scope: 'project', trusted: true, confirmTrust: true, confirmExternalAccess: true, version: listed.version,
      } }, connection) as { trusted: boolean };
      assert.equal(trusted.trusted, true);
      const tools = await host.handle({ method: 'mcp.trust.tools', params: { server: 'probe' } }, connection) as McpToolsView;
      assert.deepEqual(tools.tools.map((tool) => tool.name), ['echo']);
      await waitForProcessExit(Number(await readFile(marker, 'utf8')));
    } finally {
      await host.release();
    }

    const restartedHost = createHost(hostOptions);
    try {
      const { sessionId } = await restartedHost.handle({ method: 'session.create', params: { projectRoot } }, connection) as { sessionId: string };
      const restarted = await restartedHost.handle({ method: 'mcp.trust.list', params: { projectRoot, sessionId } }, connection) as McpTrustView;
      assert.equal(restarted.servers[0].trust?.scope, 'project');
      assert.equal(restarted.servers[0].trust?.trusted, true);
      const restartedTools = await restartedHost.handle({ method: 'mcp.trust.tools', params: { projectRoot, sessionId, server: 'probe' } }, connection) as McpToolsView;
      assert.deepEqual(restartedTools.tools.map((tool) => tool.name), ['echo']);
      await waitForProcessExit(Number(await readFile(marker, 'utf8')));

      const current = await restartedHost.handle({ method: 'mcp.trust.list', params: { projectRoot, sessionId } }, connection) as McpTrustView;
      assert.equal(current.servers[0].trust!.scope, 'project');
      assert.equal(current.servers[0].trust!.trusted, true);
      await writeProjectConfig(join(root, 'changed.pid'));
      const changed = await restartedHost.handle({ method: 'mcp.trust.list', params: { projectRoot, sessionId } }, connection) as McpTrustView;
      assert.notEqual(changed.servers[0].identityDigest, current.servers[0].identityDigest);
      assert.equal(changed.servers[0].trust, null);
      await assert.rejects(
        () => restartedHost.handle({ method: 'mcp.trust.tools', params: { projectRoot, server: 'probe' } }, connection),
      (error) => hasCode(error, 'mcp_server_untrusted'),
    );
      await assert.rejects(() => access(join(root, 'changed.pid')), (error) => hasCode(error, 'ENOENT'));
    } finally {
      await restartedHost.release();
    }
  } finally {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('mcp.trust.tools times out a stalled tools/list request and closes its temporary server', { timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-trust-timeout-'));
  const projectRoot = join(root, 'project');
  const home = join(root, 'home');
  const projectConfig = join(projectRoot, '.ligule', 'config.toml');
  const pidPath = join(root, 'mcp.pid');
  const listStartedPath = join(root, 'list.started');
  const callStartedPath = join(root, 'call.started');
  await mkdir(join(projectRoot, '.ligule'), { recursive: true });
  await mkdir(home, { recursive: true });
  const serverSettings = {
    command: process.execPath,
    args: [cancellableServer, pidPath, listStartedPath, callStartedPath, '0', '30000', 'false'],
  };
  await writeFile(projectConfig, [
    '[mcp.servers.probe]',
    `command = ${JSON.stringify(serverSettings.command)}`,
    `args = ${JSON.stringify(serverSettings.args)}`,
    '',
  ].join('\n'));
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'trust-timeout-test',
    async *stream() { yield { type: 'text', text: 'ready' }; },
  } as unknown as HostProvider;
  const config = createConfig({ user: {
    boundary: projectRoot,
    workspaceRoot: projectRoot,
    mcp: { servers: { probe: serverSettings } },
  } });
  const host = createHost({
    config,
    provider,
    permissionControl: true,
    loadEnvironment: async () => ({ config, provider }),
  });
  const connection = { notify() {}, async request() { return { decision: 'deny' }; } };
  try {
    const listed = await host.handle({ method: 'mcp.trust.list', params: {} }, connection) as McpTrustView;
    await host.handle({ method: 'mcp.trust.set', params: {
      server: 'probe',
      identityDigest: listed.servers[0].identityDigest,
      scope: 'project',
      trusted: true,
      confirmTrust: true,
      confirmExternalAccess: true,
      version: listed.version,
    } }, connection);

    const startedAt = Date.now();
    const pending = host.handle({ method: 'mcp.trust.tools', params: { server: 'probe' } }, connection);
    await waitForFile(listStartedPath);
    await assert.rejects(() => pending);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 24_000 && elapsed < 32_000, `expected the bounded lookup to end near 25 seconds, got ${elapsed} ms`);
    await waitForProcessExit(Number(await readFile(pidPath, 'utf8')));
  } finally {
    await host.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
