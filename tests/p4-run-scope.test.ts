import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDelegationGrant, listDelegationGrants, requireDelegationGrant, revokeDelegationGrant } from '../core/dist/host/agent-control.js';
import { createConnection } from '../core/dist/host/connection.js';
import { createMemoryConnectionPair } from '../core/dist/host/memory.js';
import { serveHost } from '../core/dist/host/host.js';
import { createControl } from '../core/dist/host/control.js';
import { hostProviderFromConfig } from '../core/dist/host/provider.js';
import { modeDirectories } from '../core/dist/kernel/modes.js';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';

const testDirectory = fileURLToPath(new URL('../testplace/', import.meta.url));

async function logEvidence(directory, message) {
  await appendFile(join(directory, 'p4-run-scope.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function grantInput(projectRoot, name, expiresAt = null) {
  return {
    name, projectRoot,
    defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only',
    defaultNetwork: 'policy', maxNetwork: 'policy', defaultPolicy: 'ask',
    allowedPolicies: ['ask'], allowOperator: false,
    confirmFullAccess: false, confirmUnrestrictedNetwork: false, expiresAt,
  };
}

function startGrantHost({ config, projectDirectory, directory, storePath, grantId }) {
  const pair = createMemoryConnectionPair();
  const homeDirectory = join(directory, 'home');
  const host = serveHost({
    ...pair.host,
    config,
    provider: hostProviderFromConfig(config),
    policy: config.policy,
    modeName: 'minimal',
    modePaths: modeDirectories(projectDirectory, fileURLToPath(new URL('../core/modes/', import.meta.url)), homeDirectory),
    agentControl: {
      grantId, storePath, operator: false,
      validate: () => requireDelegationGrant(storePath, grantId, projectDirectory),
    },
  });
  return {
    client: createConnection(pair.client),
    async stop() { pair.client.output.end(); await host.release(); },
  };
}

test('run receipt and result reads stay within the active Grant scope and validate it before lookup', async () => {
  let storePath;
  let firstGrantId;
  let secondGrantId;
  let expiredGrantId;
  await withTuiHost(async ({ client, config, sessionId, sessionDirectory, projectDirectory, directory }) => {
    const first = await client.request('run.submit', {
      sessionId, origin: 'controller', input: 'scope-bound result', requestKey: 'scope-key',
    });
    await client.request('run.wait', { sessionId, origin: 'controller', runId: first.runId });
    const ownReceipt = await client.request('run.receipt', { projectRoot: projectDirectory, sessionId, requestKey: 'scope-key' });
    assert.equal(ownReceipt.runId, first.runId);
    const ownResult = await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: first.runId, offset: 0 });
    assert.match(ownResult.json, /scope-bound result/u);

    await client.request('session.close', { sessionId });
    const peer = startGrantHost({ config, projectDirectory, directory, storePath, grantId: secondGrantId });
    try {
      await peer.client.request('session.open', { sessionId });
      await assert.rejects(peer.client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'run_not_found' });
      await assert.rejects(peer.client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'run_not_found' });
      await assert.rejects(peer.client.request('run.wait', { sessionId, origin: 'controller', runId: first.runId }), { code: 'run_not_found' });
      const second = await peer.client.request('run.submit', {
        sessionId, origin: 'controller', input: 'scope-bound result', requestKey: 'scope-key',
      });
      assert.notEqual(second.runId, first.runId, 'a second Grant must not reuse another Grant’s idempotency key');
      await peer.client.request('run.wait', { sessionId, origin: 'controller', runId: second.runId });
      // origin 不再参与授权：不能靠声明 human 换 scope，归属只来自持久 Acceptance。
      assert.equal((await peer.client.request('run.wait', {
        sessionId, origin: 'human', runId: second.runId,
      })).text, 'Local response: scope-bound result');
      const claimedHuman = await peer.client.request('run.submit', {
        sessionId, origin: 'human', input: 'a Grant cannot claim a human receipt',
      });
      await peer.client.request('run.wait', { sessionId, origin: 'controller', runId: claimedHuman.runId });
      assert.equal((await peer.client.request('run.wait', {
        sessionId, origin: 'human', runId: claimedHuman.runId,
      })).text, 'Local response: a Grant cannot claim a human receipt');
      const acceptances = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).split(String.fromCharCode(10))
        .filter(line => line.trim() !== '').map(line => JSON.parse(line))
        .filter(event => event.kind === 'user' && event.run !== undefined);
      assert.equal(acceptances.at(-1).run.callerScope, `controller:${secondGrantId}`,
        'a Grant’s run must stay bound to its own controller scope whatever origin it declares');

      const otherProject = join(directory, 'other-project');
      await mkdir(otherProject);
      await assert.rejects(peer.client.request('run.receipt', { projectRoot: otherProject, sessionId, runId: second.runId }), { code: 'agent_control_project_forbidden' });
      await assert.rejects(peer.client.request('run.result', { projectRoot: otherProject, sessionId, runId: second.runId }), { code: 'agent_control_project_forbidden' });

      const snapshot = await listDelegationGrants(storePath);
      await revokeDelegationGrant(storePath, secondGrantId, snapshot.version);
      await assert.rejects(peer.client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: second.runId }), { code: 'agent_control_grant_revoked' });
      await assert.rejects(peer.client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: second.runId }), { code: 'agent_control_grant_revoked' });
    } finally { await peer.stop(); }

    await delay(1_600);
    const expiredPeer = startGrantHost({ config, projectDirectory, directory, storePath, grantId: expiredGrantId });
    try {
      await assert.rejects(expiredPeer.client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'agent_control_grant_expired' });
      await assert.rejects(expiredPeer.client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'agent_control_grant_expired' });
    } finally { await expiredPeer.stop(); }
    await logEvidence(directory, 'PASS same-project Grant isolation, revoke/expiry authorization, and cross-workspace denial via real Hosts and Grant storage');
  }, {
    testDirectory,
    agentControl: async ({ directory, projectDirectory }) => {
      storePath = join(directory, 'agent-control.json');
      const empty = await listDelegationGrants(storePath);
      const first = await createDelegationGrant(storePath, grantInput(projectDirectory, 'P4 first scope'), empty.version);
      firstGrantId = first.grants[0].id;
      const second = await createDelegationGrant(storePath, grantInput(projectDirectory, 'P4 second scope'), first.version);
      secondGrantId = second.grants.find(grant => grant.name === 'P4 second scope').id;
      const expiresAt = new Date(Date.now() + 1_200).toISOString();
      const third = await createDelegationGrant(storePath, grantInput(projectDirectory, 'P4 expiring scope', expiresAt), second.version);
      expiredGrantId = third.grants.find(grant => grant.name === 'P4 expiring scope').id;
      return {
        grantId: firstGrantId, storePath, operator: false,
        validate: () => requireDelegationGrant(storePath, firstGrantId, projectDirectory),
      };
    },
  });
});

test('trusted local UI can read both run scopes even when a Grant is active', async () => {
  let storePath;
  let grantId;
  let otherGrantId;
  await withTuiHost(async ({ client, config, sessionId, projectDirectory, sessionDirectory, directory }) => {
    const human = await client.request('run.submit', { sessionId, origin: 'human', input: 'human scope result', requestKey: 'shared-key' });
    // run.wait 不再要求 origin：Host 从持久 Acceptance 推导 Run 归属，再按调用方可读 scope 授权。
    await client.request('run.wait', { sessionId, runId: human.runId });
    await client.request('run.wait', { sessionId, origin: 'human', runId: human.runId });
    const controller = await client.request('run.submit', { sessionId, origin: 'controller', input: 'controller scope result', requestKey: 'shared-key' });
    await client.request('run.wait', { sessionId, origin: 'controller', runId: controller.runId });
    await assert.rejects(client.request('run.receipt', {
      projectRoot: projectDirectory, sessionId, requestKey: 'shared-key',
    }), { code: 'run_request_key_ambiguous' });
    const direct = await client.request('run.start', { sessionId, input: 'direct trusted UI run' });
    assert.equal((await client.request('run.wait', { sessionId, runId: direct.runId })).text, direct.text);
    const recordPath = join(sessionDirectory, `${sessionId}.jsonl`);
    const beforeReads = await readFile(recordPath);

    assert.equal((await client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: human.runId })).state, 'completed');
    assert.equal((await client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: controller.runId })).state, 'completed');
    assert.match((await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: human.runId })).json, /human scope result/u);
    assert.match((await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: controller.runId })).json, /controller scope result/u);
    assert.deepEqual(await readFile(recordPath), beforeReads, 'trusted reads must not append history');

    await client.request('session.close', { sessionId });
    const peer = startGrantHost({ config, projectDirectory, directory, storePath, grantId: otherGrantId });
    let grantBRun;
    try {
      await peer.client.request('session.open', { sessionId });
      grantBRun = await peer.client.request('run.submit', {
        sessionId, origin: 'controller', input: 'controller scope B result', requestKey: 'grant-b-key',
      });
      await peer.client.request('run.wait', { sessionId, origin: 'controller', runId: grantBRun.runId });
      await peer.client.request('session.close', { sessionId });
    } finally { await peer.stop(); }

    await client.request('session.open', { sessionId });
    // origin 不再选择 scope：可信 UI 读到的是这条 Run 的唯一持久归属，两种写法结果相同。
    assert.equal((await client.request('run.wait', {
      sessionId, origin: 'human', runId: grantBRun.runId,
    })).text, 'Local response: controller scope B result');
    assert.equal((await client.request('run.wait', {
      sessionId, origin: 'controller', runId: grantBRun.runId,
    })).text, 'Local response: controller scope B result');
    assert.equal((await client.request('run.receipt', {
      projectRoot: projectDirectory, sessionId, runId: grantBRun.runId,
    })).state, 'completed');
    await logEvidence(directory, 'PASS trusted local UI read human/controller run results without changing Session JSONL');
  }, {
    testDirectory,
    permissionControl: true,
    agentControl: async ({ directory, projectDirectory }) => {
      storePath = join(directory, 'agent-control.json');
      const empty = await listDelegationGrants(storePath);
      const created = await createDelegationGrant(storePath, grantInput(projectDirectory, 'trusted UI read scope'), empty.version);
      grantId = created.grants[0].id;
      const other = await createDelegationGrant(storePath, grantInput(projectDirectory, 'other controller scope'), created.version);
      otherGrantId = other.grants[0].id;
      return {
        grantId, storePath, operator: false,
        validate: () => requireDelegationGrant(storePath, grantId, projectDirectory),
      };
    },
  });
});

test('a Grant-bound control facade cannot read another Host’s human receipt', async () => {
  // MCP stdio 走 createControl 的本地控制面。该控制面不是 authenticated Agent Control bridge，
  // 因此不能借 human scope 读取可信 UI 建立的 human run（P6-A 身份统一前它曾能读到）。
  await withTuiHost(async ({ client, config, sessionId, projectDirectory, directory }) => {
    const human = await client.request('run.submit', {
      sessionId, origin: 'human', input: 'human-only receipt', requestKey: 'facade-key',
    });
    await client.request('run.wait', { sessionId, origin: 'human', runId: human.runId });
    await client.request('session.close', { sessionId });

    const storePath = join(directory, 'agent-control.json');
    const empty = await listDelegationGrants(storePath);
    const created = await createDelegationGrant(storePath, grantInput(projectDirectory, 'facade scope'), empty.version);
    const grantId = created.grants[0].id;
    const pair = createMemoryConnectionPair();
    const peer = serveHost({
      ...pair.host, config,
      provider: hostProviderFromConfig(config),
      policy: config.policy,
      modeName: 'minimal',
      modePaths: modeDirectories(projectDirectory, fileURLToPath(new URL('../core/modes/', import.meta.url)), join(directory, 'home')),
      agentControl: { grantId, storePath, operator: false, validate: () => requireDelegationGrant(storePath, grantId, projectDirectory) },
    });
    const control = createControl(peer, projectDirectory, { operator: false });
    try {
      await control.open(projectDirectory, sessionId);
      await assert.rejects(control.getRun(sessionId, { runId: human.runId }), { code: 'run_not_found' });
      await assert.rejects(control.getRun(sessionId, { requestKey: 'facade-key' }), { code: 'run_not_found' });
      const own = await control.submit(sessionId, 'facade-owned run', undefined, 'facade-own-key');
      const got = await control.getRun(sessionId, { runId: own.receipt.runId });
      assert.equal(got.receipt.runId, own.receipt.runId);
      await logEvidence(directory, 'PASS grant-bound control facade is denied human-scope receipts and keeps its own controller receipt');
    } finally {
      await control.release();
      pair.client.output.end();
      await peer.release();
    }
  }, { testDirectory, permissionControl: true });
});

test('artifacts and export stay inside the caller’s visible Run scope', async () => {
  await withTuiHost(async ({ client, config, sessionId, projectDirectory, directory }) => {
    const storePath = join(directory, 'agent-control.json');
    const created = await createDelegationGrant(storePath, grantInput(projectDirectory, 'artifact scope'), (await listDelegationGrants(storePath)).version);
    const grantId = created.grants[0].id;
    await writeFile(join(projectDirectory, 'human-report.txt'), 'human evidence');
    await client.request('session.configure', { sessionId, mode: 'full' });
    await client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'present', args: { files: [{ path: 'human-report.txt' }] } }),
    });
    const listing = await client.request('artifact.list', { projectRoot: projectDirectory, sessionId });
    assert.equal(listing.items.length, 1, 'the trusted local UI sees the human run artifact');
    const humanReceipt = (await client.request('run.receipts', { projectRoot: projectDirectory, sessionId })).receipts[0];
    const humanRunId = humanReceipt.runId;
    assert.equal(humanReceipt.via, 'trusted-ui', 'the receipt records which channel submitted the run');
    assert.equal(humanReceipt.resolvedBy, 'permission-control', 'the receipt records why the run counts as human');
    await client.request('session.export', { sessionId, path: join(directory, 'human-export.md') });
    await client.request('session.close', { sessionId });

    const peer = startGrantHost({ config, projectDirectory, directory, storePath, grantId });
    try {
      await peer.client.request('session.open', { sessionId });
      await assert.rejects(peer.client.request('artifact.list', {
        projectRoot: projectDirectory, sessionId, runId: humanRunId,
      }), { code: 'run_not_found' }, 'a Grant cannot ask for artifacts of a run it cannot read');
      const scoped = await peer.client.request('artifact.list', { projectRoot: projectDirectory, sessionId });
      assert.equal(scoped.items.length, 0, 'a Grant cannot enumerate artifacts produced outside its scope');
      await assert.rejects(peer.client.request('session.export', { sessionId, path: join(directory, 'peer-export.md') }),
        { code: 'session_export_trusted_ui_required' });
      await logEvidence(directory, 'PASS Grant-bound scope hides human artifacts and refuses session export');
    } finally { await peer.stop(); }
  }, { testDirectory, permissionControl: true, config: { policy: { mode: 'auto' } } });
});

test('a session transcript stays readable while one Run’s full result stays scoped', async () => {
  let storePath;
  let grantId;
  await withTuiHost(async ({ client, config, sessionId, projectDirectory, directory }) => {
    const human = await client.request('run.submit', { sessionId, origin: 'human', input: 'human transcript task' });
    await client.request('run.wait', { sessionId, runId: human.runId });
    await client.request('session.close', { sessionId });

    const peer = startGrantHost({ config, projectDirectory, directory, storePath, grantId });
    try {
      await peer.client.request('session.open', { sessionId });
      // 转录属于会话：拿到会话读取权就能看到已持久化的消息。
      const transcript = await peer.client.request('session.read', { sessionId, limit: 100 });
      assert.match(JSON.stringify(transcript.events), /Local response: human transcript task/u);
      // 完整结果属于 Run：另一个 scope 的控制器既读不到回执，也读不到结果。
      await assert.rejects(peer.client.request('run.receipt', {
        projectRoot: projectDirectory, sessionId, runId: human.runId,
      }), { code: 'run_not_found' });
      await assert.rejects(peer.client.request('run.result', {
        projectRoot: projectDirectory, sessionId, runId: human.runId,
      }), { code: 'run_not_found' });
      // 同一个调用方自己的 Run：两类内容都可见。
      const own = await peer.client.request('run.submit', { sessionId, origin: 'controller', input: 'own scoped task' });
      await peer.client.request('run.wait', { sessionId, origin: 'controller', runId: own.runId });
      assert.match((await peer.client.request('run.result', {
        projectRoot: projectDirectory, sessionId, runId: own.runId,
      })).json, /own scoped task/u);
    } finally {
      await peer.client.request('session.close', { sessionId }).catch(() => undefined);
      await peer.stop();
    }
    await logEvidence(directory, 'PASS transcript readable, Run result scoped to the caller');
  }, {
    testDirectory,
    permissionControl: true,
    agentControl: async ({ directory, projectDirectory }) => {
      storePath = join(directory, 'agent-control.json');
      const empty = await listDelegationGrants(storePath);
      const created = await createDelegationGrant(storePath, grantInput(projectDirectory, 'transcript reader'), empty.version);
      grantId = created.grants[0].id;
      return { grantId, storePath, operator: false, validate: () => requireDelegationGrant(storePath, grantId, projectDirectory) };
    },
  });
});
