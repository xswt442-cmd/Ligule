import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createControl } from '../dist/host/control.js';
import { requestAgentControl } from '../dist/host/agent-control-runtime.js';
import type { Host } from '../dist/host/host.js';

test('external operation status exposes only an approval summary and the local human channel can expand it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-control-approval-'));
  const projectRoot = join(root, 'project');
  const home = join(root, 'home');
  await Promise.all([mkdir(projectRoot), mkdir(home)]);
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  const content = 'x'.repeat(100_000);
  const args = { path: 'app.js', content };
  let answer;
  const requestId = 'approval-1';
  const hash = createHash('sha256').update(content).digest('hex');
  const host: Host = {
    async handle(message, connection) {
      if (message.method === 'session.create') return { sessionId: 'session-1' };
      if (message.method === 'run.start') {
        answer = await connection.request('approval.request', {
          requestId, detailsRef: requestId, sessionId: 'session-1', runId: 'run-1', callId: 'call-1', tool: 'create',
          args: { path: args.path, content: `${content.slice(0, 512)}…`, contentBytes: content.length, contentSha256: hash },
          argumentBytes: Buffer.byteLength(JSON.stringify(args)),
          argumentSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
          contentBytes: content.length, contentSha256: hash, preview: `${content.slice(0, 512)}…`,
          rememberable: true, rememberScopes: ['session', 'project'], rememberHintKey: 'file', rememberTargetOptions: ['file', 'workspace'],
        });
        return { text: 'done', iterations: 1, modelCalls: 1 };
      }
      if (message.method === 'approval.details') return { requestId, sessionId: 'session-1', argumentSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'), args };
      if (message.method === 'session.close') return { sessionId: 'session-1' };
      if (message.method === 'run.cancel') return { cancelled: true };
      if (message.method === 'status.get') return { sessionId: 'session-1' };
      throw new Error(`unexpected host method: ${message.method}`);
    },
    async release() {},
  };
  const control = createControl(host, projectRoot, { operator: true });
  try {
    const opened = await control.create(projectRoot);
    const started = control.start(opened.sessionId, 'create a page');
    const deadline = Date.now() + 5_000;
    let status;
    while (Date.now() < deadline) {
      status = control.status(started.operationId);
      if (status.pendingInteractions.length > 0) break;
      await delay(10);
    }
    const pending = status?.pendingInteractions[0];
    assert.ok(pending);
    assert.equal(JSON.stringify(status).includes(content), false);
    assert.equal(pending.details.contentBytes, content.length);
    assert.equal(pending.details.contentSha256, hash);
    assert.equal(pending.details.callId, 'call-1');
    assert.ok(String((pending.details.args as { content: unknown }).content).length <= 513);

    assert.throws(() => control.replyInteraction({
      sessionId: opened.sessionId, requestId, type: 'approval', decision: 'allow', rememberScope: 'project', rememberTarget: 'file',
    }, 'controller'), { code: 'policy_memory_trusted_user_required' });

    const expanded = await requestAgentControl(projectRoot, opened.sessionId, { action: 'details', requestId });
    assert.equal((expanded as { args: { content: unknown } }).args.content, content);
    await requestAgentControl(projectRoot, opened.sessionId, {
      action: 'reply', requestId, type: 'approval', decision: 'allow', rememberScope: 'project', rememberTarget: 'file',
    });
    const finished = await control.await(started.operationId, 5_000);
    assert.equal(finished.state, 'done');
    assert.deepEqual(answer, { decision: 'allow', source: 'human', rememberScope: 'project', rememberTarget: 'file' });
  } finally {
    await control.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
