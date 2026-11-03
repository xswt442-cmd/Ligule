import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '../dist/kernel/kernel.js';
import { createConfig } from '../dist/kernel/config.js';
import { createDecisionChain } from '../dist/kernel/policy.js';
import { DEFAULT_PERMISSION_CONTEXT, createPermissionContext } from '../dist/kernel/permission.js';
import { createAskUserPlugin } from '../dist/tools/ask-user.js';
import type { PermissionAccess } from '../dist/kernel/permission.js';
import type { ToolDefinition } from '../dist/kernel/kernel.js';

function tool(access: PermissionAccess, run: ToolDefinition['run']) {
  return {
    name: 'operation',
    description: 'A permission test operation.',
    access,
    parameters: { type: 'object', properties: {}, required: [] },
    run,
  };
}

test('permission denial runs before Policy approval and records the separate decision', async () => {
  let asked = false;
  let executed = false;
  const events: Record<string, unknown>[] = [];
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: DEFAULT_PERMISSION_CONTEXT,
    policy: createDecisionChain({ mode: 'ask', ask: async () => { asked = true; return true; } }),
    session: { directory: process.cwd(), append: async (event) => { events.push(event); } },
  });
  kernel.register(tool('write', async () => { executed = true; }));

  assert.deepEqual(kernel.selectable(), ['operation']);
  assert.deepEqual(kernel.manifest(), []);
  await assert.rejects(kernel.call('operation', {}), { code: 'permission_read_only' });
  assert.equal(asked, false);
  assert.equal(executed, false);
  assert.deepEqual(events[0].permission, {
    decision: 'deny', source: 'kernel-preflight', profile: 'read-only', network: 'policy',
    code: 'permission_read_only', reason: 'this session only permits reads',
  });
  assert.equal(events[0].verdict, undefined);
  assert.equal((events[0].result as { code?: string }).code, 'permission_read_only');
});

test('a workspace profile can execute when the platform reports partial filesystem confinement', async () => {
  let asked = false;
  let executed = false;
  const events: Record<string, unknown>[] = [];
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: createPermissionContext('workspace-write', 'policy', {
      filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
    }),
    policy: createDecisionChain({ mode: 'auto', ask: async () => { asked = true; return true; } }),
    session: { directory: process.cwd(), append: async (event) => { events.push(event); } },
  });
  kernel.register(tool('exec', async () => { executed = true; return { text: 'bounded' }; }));

  const result = await kernel.call('operation', {});
  assert.equal(asked, false);
  assert.equal(executed, true);
  assert.equal((result as { text?: unknown }).text, 'bounded');
  assert.equal(events.some((event) => (event.permission as { decision?: string } | undefined)?.decision === 'deny'), false);
});

test('a workspace profile refuses execution when filesystem confinement is unavailable', async () => {
  let executed = false;
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: createPermissionContext('workspace-write', 'policy', {
      filesystemRead: 'partial', filesystemWrite: 'unavailable', network: 'full', process: 'full',
    }),
    policy: createDecisionChain({ mode: 'auto' }),
    session: { directory: process.cwd(), append: async () => {} },
  });
  kernel.register(tool('exec', async () => { executed = true; }));

  await assert.rejects(kernel.call('operation', {}), { code: 'permission_sandbox_unavailable' });
  assert.equal(executed, false);
});

test('unknown tool access labels are rejected during registration', () => {
  const kernel = createKernel();
  assert.throws(() => kernel.register(tool('files-everywhere' as unknown as PermissionAccess, async () => {})), { code: 'tool_access_unknown' });
});

test('a user question remains available without granting filesystem or network access', () => {
  const kernel = createKernel({ permission: DEFAULT_PERMISSION_CONTEXT });
  createAskUserPlugin({ ask: async () => [] }).setup(kernel);
  assert.deepEqual(kernel.manifest().map((entry) => entry.name), ['ask_user_question']);
  assert.deepEqual(kernel.selectable(), []);
});
