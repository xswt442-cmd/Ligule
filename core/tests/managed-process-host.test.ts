import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDelegationGrant, delegationPathOf, listDelegationGrants, requireDelegationGrant } from '../dist/host/agent-control.js';
import type { CreateDelegationGrantInput } from '../dist/host/agent-control.js';
import { detectPermissionCapabilities } from '../dist/capability/permission-capabilities.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import type { PermissionContext } from '../dist/kernel/permission.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

type ManagedContent = { id: string; status: string; port: number; logs: string };

type ToolEvent = {
  kind?: string;
  tool?: string;
  result: { failed?: boolean; code?: string; reason?: string; content: ManagedContent };
};

const windowsWorkspaceWrite = createPermissionContext('workspace-write', 'unrestricted', {
  filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
}, {
  profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
  limitations: ['Windows workspace-write has partial isolation.'],
  partialWorkspaceWriteConfirmationRequired: true,
  partialWorkspaceWriteConfirmed: true,
});

async function availableLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return (address as AddressInfo).port;
}

async function waitForUnavailable(url: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
    } catch {
      return;
    }
    await delay(20);
  }
  assert.fail(`server at ${url} remained reachable`);
}

async function waitForRequest(url: string): Promise<Response> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { return await fetch(url); }
    catch { await delay(20); }
  }
  assert.fail(`server at ${url} did not accept an HTTP request`);
}

test('Host-managed server survives the tool return and Session close terminates its process tree', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('host-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const approvals: { tool?: string; scriptBinding?: unknown }[] = [];
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals.push(message.params as { tool?: string; scriptBinding?: unknown });
      return { decision: 'allow' };
    });

    const invoke = async (args: Record<string, unknown>): Promise<ManagedContent> => {
      await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'managed_process', args }),
      });
      const record = await client.request('session.read', { sessionId }) as { events: ToolEvent[] };
      const result = record.events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1)?.result;
      assert.notEqual(result?.failed, true, JSON.stringify(result));
      return result!.content;
    };

    const started = await invoke({
      action: 'start',
      command: `node "${serverPath.replaceAll('\\', '/')}" ${port}`,
      readyUrl: url,
    });
    assert.equal(started.status, 'running');
    assert.equal(started.port, port);
    assert.equal('pid' in started, false, 'the exposed handle does not label the Guardian PID as the server PID');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'exec');
    assert.ok(approvals[0].scriptBinding);
    const response = await fetch(url);
    assert.equal(await response.text(), 'host-managed-ready');

    const status = await invoke({ action: 'status', id: started.id });
    assert.equal(status.status, 'running');
    assert.match(status.logs, /listening/);
    await client.request('session.close', { sessionId });
    await assert.rejects(() => fetch(url));
  }, {
    permissionControl: true,
    permission: windowsWorkspaceWrite,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('Linux bubblewrap Host-managed server survives the tool return and Session close terminates it', {
  skip: process.platform !== 'linux',
  timeout: 45_000,
}, async (t) => {
  const capabilities = await detectPermissionCapabilities({ platform: 'linux' });
  if (capabilities.profiles.workspaceWrite === 'unavailable') {
    t.skip(capabilities.limitations.join('; '));
    return;
  }
  const permission = createPermissionContext('workspace-write', 'unrestricted', capabilities.capabilities, {
    profiles: capabilities.profiles,
    limitations: capabilities.limitations,
    partialWorkspaceWriteConfirmed: false,
  });
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('linux-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', {
      sessionId,
      input: JSON.stringify({
        tool: 'managed_process',
        args: {
          action: 'start',
          command: `node "${serverPath}" ${port}`,
          readyUrl: url,
        },
      }),
    });
    const events = (await client.request('session.read', { sessionId }) as { events: ToolEvent[] }).events;
    const managedCall = events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1);
    assert.ok(managedCall, 'the Host records the managed_process result');
    assert.equal(managedCall.result.failed, false,
      `managed_process start failed: ${managedCall.result.code ?? managedCall.result.reason ?? JSON.stringify(managedCall.result)}`);
    const started = managedCall.result.content;
    assert.equal(started?.status, 'running', 'the Host reports the readiness-checked process as running');
    assert.equal(started.port, port);
    assert.equal(await (await fetch(url)).text(), 'linux-managed-ready');

    await client.request('session.close', { sessionId });
    await waitForUnavailable(url);
  }, {
    permission,
    permissionControl: true,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('Session close and run.cancel stop only their managed processes and preserve other Session and user processes', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 45_000,
}, async (t) => {
  let permission = windowsWorkspaceWrite;
  if (process.platform === 'linux') {
    const capabilities = await detectPermissionCapabilities({ platform: 'linux' });
    if (capabilities.profiles.workspaceWrite === 'unavailable') {
      t.skip(capabilities.limitations.join('; '));
      return;
    }
    permission = createPermissionContext('workspace-write', 'unrestricted', capabilities.capabilities, {
      profiles: capabilities.profiles,
      limitations: capabilities.limitations,
      partialWorkspaceWriteConfirmed: false,
    });
  }

  await withTuiHost(async ({ client, sessionId: firstSessionId, projectDirectory, providerRequests }) => {
    const { sessionId: secondSessionId } = await client.request('session.create', {}) as { sessionId: string };
    const firstPort = await availableLoopbackPort();
    const secondPort = await availableLoopbackPort();
    const userPort = await availableLoopbackPort();
    const secondUserPort = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'session-monitor.mjs');
    const userMonitorPath = join(projectDirectory, 'user-monitor.mjs');
    const secondUserMonitorPath = join(projectDirectory, 'independent-monitor.mjs');
    await writeFile(serverPath, [
      "import { createServer } from 'node:http';",
      `createServer((_request, response) => response.end(process.argv[3])).listen(Number(process.argv[2]), '127.0.0.1');`,
    ].join('\n'));
    await writeFile(userMonitorPath, [
      "import { createServer } from 'node:http';",
      `createServer((_request, response) => response.end('user-monitor-alive')).listen(Number(process.argv[2]), '127.0.0.1');`,
    ].join('\n'));
    await writeFile(secondUserMonitorPath, [
      "import { createServer } from 'node:http';",
      `createServer((_request, response) => response.end('second-monitor-alive')).listen(Number(process.argv[2]), '127.0.0.1');`,
    ].join('\n'));
    const firstUrl = `http://127.0.0.1:${firstPort}/`;
    const secondUrl = `http://127.0.0.1:${secondPort}/`;
    const userUrl = `http://127.0.0.1:${userPort}/`;
    const secondUserUrl = `http://127.0.0.1:${secondUserPort}/`;
    const userProcess = spawn(process.execPath, [userMonitorPath, String(userPort)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const secondUserProcess = spawn(process.execPath, [secondUserMonitorPath, String(secondUserPort)], {
      stdio: 'ignore', windowsHide: true,
    });
    t.after(async () => {
      for (const process of [userProcess, secondUserProcess]) {
        if (process.exitCode !== null || process.signalCode !== null) continue;
        process.kill();
        await Promise.race([
          new Promise((resolveExit) => process.once('exit', resolveExit)),
          delay(3_000).then(() => { throw new Error('test-owned user monitor did not exit'); }),
        ]);
      }
    });

    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);

    const startManagedServer = async (id: string, port: number, marker: string) => {
      await client.request('run.start', {
        sessionId: id,
        input: JSON.stringify({
          tool: 'managed_process',
          args: {
            action: 'start',
            command: `node "${serverPath.replaceAll('\\', '/')}" ${port} ${marker}`,
            readyUrl: `http://127.0.0.1:${port}/`,
          },
        }),
      });
      const { events } = await client.request('session.read', { sessionId: id }) as { events: ToolEvent[] };
      const result = events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1)?.result;
      assert.notEqual(result?.failed, true, JSON.stringify(result));
      assert.equal(result!.content.status, 'running');
    };

    await startManagedServer(firstSessionId, firstPort, 'first-session-alive');
    await startManagedServer(secondSessionId, secondPort, 'second-session-alive');
    assert.equal(await (await waitForRequest(firstUrl)).text(), 'first-session-alive');
    assert.equal(await (await waitForRequest(secondUrl)).text(), 'second-session-alive');
    assert.equal(await (await waitForRequest(userUrl)).text(), 'user-monitor-alive');
    assert.equal(await (await waitForRequest(secondUserUrl)).text(), 'second-monitor-alive');

    await client.request('session.close', { sessionId: firstSessionId });
    await waitForUnavailable(firstUrl);
    assert.equal(await (await fetch(secondUrl)).text(), 'second-session-alive');
    assert.equal(await (await fetch(userUrl)).text(), 'user-monitor-alive');
    assert.equal(await (await fetch(secondUserUrl)).text(), 'second-monitor-alive');
    assert.equal(secondUserProcess.exitCode, null);
    assert.equal(secondUserProcess.signalCode, null);
    assert.equal(userProcess.exitCode, null, 'the independently started user monitor must remain alive');
    assert.equal(userProcess.signalCode, null, 'the independently started user monitor must not be signalled');

    const { sessionId: cancelledSessionId } = await client.request('session.create', {}) as { sessionId: string };
    const cancelledPort = await availableLoopbackPort();
    const cancelledUrl = `http://127.0.0.1:${cancelledPort}/`;
    await startManagedServer(cancelledSessionId, cancelledPort, 'cancelled-session-alive');
    assert.equal(await (await waitForRequest(cancelledUrl)).text(), 'cancelled-session-alive');

    const requestCount = providerRequests.length;
    const pendingRun = client.request('run.start', { sessionId: cancelledSessionId, input: 'wait for cancellation' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitFor(() => providerRequests.length > requestCount, { within: 10_000, every: 10 });
    assert.equal(await (await fetch(cancelledUrl)).text(), 'cancelled-session-alive');
    assert.deepEqual(await client.request('run.cancel', { sessionId: cancelledSessionId }), { cancelled: true });
    await waitForUnavailable(cancelledUrl);
    const cancellation = await pendingRun as Error & { code?: string };
    assert.ok(cancellation instanceof Error, 'the cancelled run must not report success');
    assert.ok(['loop_cancelled', 'provider_cancelled'].includes(cancellation.code ?? ''), cancellation.code);
    assert.equal(await (await fetch(secondUrl)).text(), 'second-session-alive');
    assert.equal(await (await fetch(userUrl)).text(), 'user-monitor-alive');
    assert.equal(await (await fetch(secondUserUrl)).text(), 'second-monitor-alive');
    assert.equal(secondUserProcess.exitCode, null);
    assert.equal(secondUserProcess.signalCode, null);
    assert.equal(userProcess.exitCode, null, 'run.cancel must not terminate the independently started user monitor');
    assert.equal(userProcess.signalCode, null, 'run.cancel must not signal the independently started user monitor');
  }, {
    delayMs: 750,
    permissionControl: true,
    permission,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('revoking workspace trust stops a Host-managed project server', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 45_000,
}, async (t) => {
  let permission = windowsWorkspaceWrite;
  if (process.platform === 'linux') {
    const capabilities = await detectPermissionCapabilities({ platform: 'linux' });
    if (capabilities.profiles.workspaceWrite === 'unavailable') {
      t.skip(capabilities.limitations.join('; '));
      return;
    }
    permission = createPermissionContext('workspace-write', 'unrestricted', capabilities.capabilities, {
      profiles: capabilities.profiles,
      limitations: capabilities.limitations,
      partialWorkspaceWriteConfirmed: false,
    });
  }

  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((_request, response) => response.end('trusted-host-server-ready')).listen(port, '127.0.0.1');\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', {
      sessionId,
      input: JSON.stringify({
        tool: 'managed_process',
        args: {
          action: 'start',
          command: `node "${serverPath.replaceAll('\\', '/')}" ${port}`,
          readyUrl: url,
        },
      }),
    });
    const events = (await client.request('session.read', { sessionId }) as { events: ToolEvent[] }).events;
    const started = events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1)!.result.content;
    assert.equal(started.status, 'running');
    assert.equal(await (await fetch(url)).text(), 'trusted-host-server-ready');

    const revoked = await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: false }) as { trusted?: boolean };
    assert.equal(revoked.trusted, false);
    await waitForUnavailable(url);
    const status = await client.request('status.get', { sessionId }) as { permission: { workspaceTrusted: boolean } };
    assert.equal(status.permission.workspaceTrusted, false);
  }, {
    permissionControl: true,
    permission,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('run.cancel terminates the Session-managed process tree while the Agent is waiting on its next model request', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 45_000,
}, async (t) => {
  let permission: PermissionContext;
  if (process.platform === 'win32') {
    permission = windowsWorkspaceWrite;
  } else {
    const capabilities = await detectPermissionCapabilities({ platform: 'linux' });
    if (capabilities.profiles.workspaceWrite === 'unavailable') {
      t.skip(capabilities.limitations.join('; '));
      return;
    }
    permission = createPermissionContext('workspace-write', 'unrestricted', capabilities.capabilities, {
      profiles: capabilities.profiles,
      limitations: capabilities.limitations,
    });
  }

  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('cancel-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const run = client.request('run.start', {
      sessionId,
      input: JSON.stringify({
        tool: 'managed_process',
        args: {
          action: 'start',
          command: `node "${serverPath.replaceAll('\\', '/')}" ${port}`,
          readyUrl: url,
        },
      }),
    });
    const outcome = run.then(() => undefined, (error: unknown) => error);
    await waitFor(() => providerRequests.length >= 2, { within: 15_000, every: 10 });
    assert.equal((await fetch(url)).status, 200);
    assert.deepEqual(await client.request('run.cancel', { sessionId }), { cancelled: true });
    await waitForUnavailable(url);
    const failure = await outcome as Error & { code?: string };
    assert.ok(failure instanceof Error, 'the cancelled model run does not report success');
    assert.ok(['loop_cancelled', 'provider_cancelled'].includes(failure.code ?? ''), failure.code);
  }, {
    delayMs: 1_500,
    permissionControl: true,
    permission,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('revoking the owning Agent Control Grant stops the Session server and releases its port', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  let grant!: { id: string; storePath: string };
  await withTuiHost(async ({ client, sessionId, projectDirectory, directory }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('grant-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', {
      sessionId,
      input: JSON.stringify({
        tool: 'managed_process',
        args: {
          action: 'start',
          command: `node "${serverPath.replaceAll('\\', '/')}" ${port}`,
          readyUrl: url,
        },
      }),
    });
    const events = (await client.request('session.read', { sessionId }) as { events: ToolEvent[] }).events;
    const started = events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1)!.result.content;
    assert.equal(started.status, 'running');
    assert.equal((await fetch(url)).status, 200);

    const store = await listDelegationGrants(grant.storePath);
    const revoked = await client.request('agent-control.revoke', { grantId: grant.id, version: store.version }) as {
      grants: { id: string; revokedAt?: string | null }[];
    };
    assert.ok(revoked.grants.find((entry) => entry.id === grant.id)?.revokedAt);
    await waitForUnavailable(url);
    await assert.rejects(client.request('status.get', { sessionId }), { code: 'agent_control_grant_revoked' });
  }, {
    permissionControl: true,
    permission: windowsWorkspaceWrite,
    testDirectory: join(process.cwd(), 'testplace'),
    agentControl: async ({ projectDirectory, homeDirectory }) => {
      const storePath = delegationPathOf(homeDirectory);
      const initial = await listDelegationGrants(storePath);
      const created = await createDelegationGrant(storePath, {
        name: 'managed process lifecycle test',
        projectRoot: projectDirectory,
        defaultPermissionProfile: 'workspace-write',
        maxPermissionProfile: 'workspace-write',
        defaultNetwork: 'unrestricted',
        maxNetwork: 'unrestricted',
        defaultPolicy: 'ask',
        allowedPolicies: ['ask'],
        allowOperator: true,
        confirmFullAccess: false,
        confirmUnrestrictedNetwork: true,
        confirmWorkspaceTrust: true,
        confirmPartialWorkspaceWrite: true,
        expiresAt: null,
      } as CreateDelegationGrantInput, initial.version);
      grant = { id: created.grants[0].id, storePath };
      return {
        grantId: grant.id,
        storePath,
        operator: true,
        validate: () => requireDelegationGrant(storePath, grant.id, projectDirectory),
      };
    },
  });
});
