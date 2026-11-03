import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ToolDefinition } from '../dist/kernel/kernel.js';
import { createConfig, createDecisionChain, createKernel, createPermissionContext, DEFAULT_PERMISSION_CONTEXT } from '../dist/index.js';
import { fetchTool } from '../dist/tools/network.js';

test('a registered static network target shares the real approval and connection path and cannot be changed afterwards', async () => {
  const paths: (string | undefined)[] = [];
  const server = createServer((request, response) => { paths.push(request.url); response.end('approved page'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}/approved`;
  const asked: { reason: string | undefined }[] = [];
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }),
    policy: createDecisionChain({ mode: 'auto', ask: async question => { asked.push(question); return true; } }) });
  const tool = { name: 'fixed_fetch', description: 'Fetch a fixed local endpoint', access: 'network', readOnly: true,
    networkTarget: url, parameters: { type: 'object', additionalProperties: false, properties: {} },
    run: async (_args, context) => await fetchTool.run({ url }, context) } satisfies ToolDefinition;
  kernel.register(tool);
  tool.networkTarget = `${url}/changed`;
  try {
    assert.equal((kernel.manifest()[0] as { networkTarget?: string }).networkTarget, undefined);
    const result = await kernel.call('fixed_fetch', {}) as { text: string };
    assert.equal(result.text, 'approved page');
    assert.deepEqual(paths, ['/approved']);
    assert.equal(asked.length, 1);
    assert.match(asked[0].reason as string, /loopback/u);
    const forbidden = createKernel({ permission: createPermissionContext('read-only', 'disabled', DEFAULT_PERMISSION_CONTEXT.capabilities) });
    forbidden.register(tool);
    await assert.rejects(forbidden.call('fixed_fetch', {}));
    assert.deepEqual(paths, ['/approved']);
    assert.throws(() => kernel.register({ ...tool, name: 'conflict', targetArgument: 'url' }), { code: 'tool_network_target_invalid' });
    assert.throws(() => kernel.register({ ...tool, name: 'wrong_access', access: 'read' }), { code: 'tool_network_target_invalid' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
