import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { dataRoot } from '../dist/kernel/config-file.js';
import { createAgentControlRuntime, requestAgentControl } from '../dist/host/agent-control-runtime.js';
import type { AgentControlRequest } from '../dist/host/agent-control-runtime.js';

const testplace = resolve('testplace');

async function fixture<TResult>(
  run: (paths: { directory: string; projectRoot: string; otherProject: string }) => TResult | Promise<TResult>,
): Promise<TResult> {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'agent-control-runtime-'));
  const projectRoot = join(directory, 'project');
  const otherProject = join(directory, 'other-project');
  await Promise.all([mkdir(projectRoot), mkdir(otherProject)]);
  try { return await run({ directory, projectRoot, otherProject }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('a registered local controller accepts scoped status and human actions', async () => {
  await fixture(async ({ projectRoot, otherProject }) => {
    const calls: { requestedSessionId: string; request: AgentControlRequest }[] = [];
    const sessionId = 'session-for-local-control';
    const runtime = createAgentControlRuntime(projectRoot, async (requestedSessionId, request) => {
      calls.push({ requestedSessionId, request });
      return { sessionId: requestedSessionId, action: request.action };
    });
    try {
      await runtime.register(sessionId);
      if (process.platform !== 'win32') {
        const descriptorPath = join(dataRoot(homedir()), 'agent-control-runtime', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
        const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as { endpoint: string };
        assert.ok(Buffer.byteLength(descriptor.endpoint, 'utf8') <= 107, 'Unix socket paths must fit sun_path');
      }
      const response = await requestAgentControl(projectRoot, sessionId, {
        action: 'status', after: 0, limit: 10, waitMs: 0,
      });
      assert.deepEqual(response, { sessionId, action: 'status' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].requestedSessionId, sessionId);

      const sent = await requestAgentControl(projectRoot, sessionId, { action: 'send', input: 'Continue with the next step.' });
      assert.deepEqual(sent, { sessionId, action: 'send' });
      assert.equal((calls[1].request as { input?: string }).input, 'Continue with the next step.');

      await assert.rejects(
        requestAgentControl(otherProject, sessionId, { action: 'status', after: 0, limit: 10, waitMs: 0 }),
        { code: 'control_project_forbidden' },
      );
      await assert.rejects(
        requestAgentControl(projectRoot, '../other-session', { action: 'status', after: 0, limit: 10, waitMs: 0 }),
        { code: 'agent_control_request_invalid' },
      );
    } finally {
      await runtime.close();
    }
    await assert.rejects(
      requestAgentControl(projectRoot, sessionId, { action: 'status', after: 0, limit: 10, waitMs: 0 }),
      { code: 'agent_control_runtime_unavailable' },
    );
  });
});

test('a local controller resolves alternate Windows path casing to its bound project', {
  skip: process.platform !== 'win32',
}, async () => {
  await fixture(async ({ projectRoot }) => {
    const sessionId = 'session-for-canonical-project';
    const runtime = createAgentControlRuntime(projectRoot.toUpperCase(), async (requestedSessionId, request) => ({
      sessionId: requestedSessionId, action: request.action,
    }));
    try {
      await runtime.register(sessionId);
      const status = await requestAgentControl(projectRoot, sessionId, { action: 'status', after: 0, limit: 10, waitMs: 0 });
      assert.deepEqual(status, { sessionId, action: 'status' });
    } finally {
      await runtime.close();
    }
  });
});

test('long data roots use a Unix socket path that fits the platform address limit', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ directory, projectRoot }) => {
    const previousHome = process.env.LIGULE_HOME;
    process.env.LIGULE_HOME = join(directory, 'long-data-root-'.repeat(8));
    const sessionId = 'session-with-long-data-root';
    const runtime = createAgentControlRuntime(projectRoot, async (requestedSessionId) => ({ sessionId: requestedSessionId }));
    try {
      await runtime.register(sessionId);
      const descriptorPath = join(dataRoot(homedir()), 'agent-control-runtime', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as { endpoint: string };
      assert.equal(resolve(descriptor.endpoint).startsWith(resolve(tmpdir()) + '/'), true);
      assert.ok(Buffer.byteLength(descriptor.endpoint, 'utf8') <= 107, 'Unix socket paths must fit sun_path');
      assert.deepEqual(await requestAgentControl(projectRoot, sessionId, { action: 'cancel' }), { sessionId });
    } finally {
      await runtime.close();
      if (previousHome === undefined) delete process.env.LIGULE_HOME;
      else process.env.LIGULE_HOME = previousHome;
    }
  });
});

test('the local controller validates replies and keeps request errors bounded', async () => {
  await fixture(async ({ projectRoot }) => {
    const runtime = createAgentControlRuntime(projectRoot, async () => { throw Object.assign(new Error('private path'), { code: 'control_interaction_stale' }); });
    try {
      await runtime.register('session-reply-control');
      await assert.rejects(
        requestAgentControl(projectRoot, 'session-reply-control', {
          action: 'reply', requestId: 'request-1', type: 'approval', decision: 'allow',
        }),
        { code: 'control_interaction_stale' },
      );
      await assert.rejects(
        requestAgentControl(projectRoot, 'session-reply-control', { action: 'reply', requestId: 'request-1', type: 'approval', decision: 'maybe' as unknown as 'allow' }),
        { code: 'agent_control_request_invalid' },
      );
      await assert.rejects(
        requestAgentControl(projectRoot, 'session-reply-control', { action: 'send', input: '   ' }),
        { code: 'agent_control_request_invalid' },
      );
    } finally { await runtime.close(); }
  });
});
