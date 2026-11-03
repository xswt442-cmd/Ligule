// 验证 MCP 配置、工具参数校验、工具说明和摘要，以及 stdio 服务器通信。
// 协议层用的是官方 SDK，服务器用的是官方那个文件系统参考服务器；摘要与陈旧那两条读的是我们自己那一段逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createConfig, createConnection, createDecisionChain, createKernel, createMcpPlugin, createMcpRegistry, createMcpTools, createMemoryConnectionPair, loadAssembly, MESSAGES_CAPABILITIES, serveHost,
  mcpServerConfigs, validateToolArguments,
} from '../dist/index.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { KernelError } from '../dist/kernel/error.js';
import { policyArgsHash } from '../dist/kernel/policy.js';
import type { McpRegistry } from '../dist/capability/mcp.js';
import type { ToolDefinition } from '../dist/kernel/kernel.js';
import type { HostOptions } from '../dist/host/host.js';
import type { HostProvider } from '../dist/host/provider.js';

type CodedError = { code?: string; detail?: string };
type RegistryView = Pick<McpRegistry, 'servers' | 'toolsOf' | 'definition' | 'call'>;
type FakeRegistry = RegistryView & { calls: [string, string, unknown][] };
type InspectResult = { text: string; schemaDigest: string };
type PolicyQuestionView = { tool: string; identityDigest?: string };

const serverEntry = fileURLToPath(new URL('../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', import.meta.url));
const externalPermission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'full',
});

test('the server config takes a plain command and only ${NAME} credential references', () => {
  const projectRoot = process.cwd();
  const config = {
    mcp: {
      servers: {
        fs: { command: process.execPath, args: [serverEntry, '/tmp'], env: { TOKEN: '${MCP_TEST_TOKEN}' } },
      },
    },
  };
  const configs = mcpServerConfigs({
    ...config,
  }, { MCP_TEST_TOKEN: 'a-secret' }, projectRoot);
  assert.deepEqual(configs.map(({ env, ...settings }) => settings), [{
    name: 'fs', command: process.execPath, args: [serverEntry, '/tmp'], cwd: projectRoot,
    environmentNames: ['TOKEN'], identityDigest: configs[0].identityDigest,
  }]);
  assert.deepEqual(configs[0].env, { TOKEN: 'a-secret' });
  assert.match(configs[0].identityDigest, /^[0-9a-f]{64}$/u);
  assert.equal(mcpServerConfigs(config, { MCP_TEST_TOKEN: 'rotated-secret' }, projectRoot)[0].identityDigest, configs[0].identityDigest,
    'the trusted identity contains the environment reference name, never its secret value');
  // 变量没设时不把字面量 `${NAME}` 传下去：那看着像一个凭据，其实是配置没填。
  assert.deepEqual(mcpServerConfigs(configsToConfig({ TOKEN: '${MCP_TEST_TOKEN}' }), {}).map((entry) => entry.env), [{}]);
  assert.throws(
    () => mcpServerConfigs(configsToConfig({ TOKEN: 'a-secret' })),
    (error) => (error as CodedError).code === 'mcp_env_unsupported',
  );
  assert.throws(() => mcpServerConfigs(configsToConfig(undefined, { command: 'node /x.js' })), (error) => (error as CodedError).code === 'mcp_command_invalid');
  // 判据看的是空白：合法的可执行文件名里常带字母 s，按字母判会把整份配置拒掉。
  const plain = mcpServerConfigs(configsToConfig(undefined, { command: 'mcp-server-stdio' }))[0];
  assert.equal(plain.command, 'mcp-server-stdio');
  assert.deepEqual(plain.environmentNames, []);
  assert.equal(plain.cwd, process.cwd());
  assert.match(plain.identityDigest, /^[0-9a-f]{64}$/u);
});

test('a relative server command is resolved from its workspace and its launch settings change its identity', () => {
  const projectRoot = join(tmpdir(), 'mcp-trust-project');
  const settings = { command: './bin/server', args: ['--stdio'], cwd: 'runtime', env: { API_KEY: '${MCP_API_KEY}' } };
  const config = { mcp: { servers: { browser: settings } } };
  const first = mcpServerConfigs(config, { MCP_API_KEY: 'secret' }, projectRoot)[0];

  assert.equal(first.cwd, join(projectRoot, 'runtime'));
  assert.equal(first.command, join(projectRoot, 'runtime', 'bin', 'server'));
  const changedArguments = { mcp: { servers: { browser: { ...settings, args: ['--json'] } } } };
  const changedCredentialReference = { mcp: { servers: { browser: { ...settings, env: { API_KEY: '${OTHER_API_KEY}' } } } } };
  assert.notEqual(mcpServerConfigs(changedArguments, {}, projectRoot)[0].identityDigest, first.identityDigest);
  assert.notEqual(mcpServerConfigs(changedCredentialReference, {}, projectRoot)[0].identityDigest, first.identityDigest);
});

test('a server without an explicit working directory is bound to its project root', () => {
  const config = { mcp: { servers: { local: { command: 'node', args: ['server.js'] } } } };
  const firstRoot = join(tmpdir(), 'mcp-default-cwd-first');
  const secondRoot = join(tmpdir(), 'mcp-default-cwd-second');
  const first = mcpServerConfigs(config, {}, firstRoot)[0];
  const second = mcpServerConfigs(config, {}, secondRoot)[0];

  assert.equal(first.cwd, firstRoot);
  assert.equal(second.cwd, secondRoot);
  assert.notEqual(first.identityDigest, second.identityDigest);
});

test('the server identity depends on PATH only when a bare command needs PATH lookup', () => {
  const projectRoot = join(tmpdir(), 'mcp-path-identity-project');
  const configFor = (command: string) => ({ mcp: { servers: { probe: { command, args: [], cwd: projectRoot } } } });

  const absolute = configFor(process.execPath);
  const absoluteFromFirstPath = mcpServerConfigs(absolute, { PATH: 'C:\\tools\\first' }, projectRoot)[0];
  const absoluteFromSecondPath = mcpServerConfigs(absolute, { PATH: 'C:\\tools\\second' }, projectRoot)[0];
  assert.equal(absoluteFromFirstPath.identityDigest, absoluteFromSecondPath.identityDigest,
    'an absolute executable is unaffected by the caller’s PATH');

  const bare = configFor('ligule-mcp-probe');
  const bareFromFirstPath = mcpServerConfigs(bare, { PATH: 'C:\\tools\\first' }, projectRoot)[0];
  const bareFromSecondPath = mcpServerConfigs(bare, { PATH: 'C:\\tools\\second' }, projectRoot)[0];
  assert.notEqual(bareFromFirstPath.identityDigest, bareFromSecondPath.identityDigest,
    'a bare executable can resolve to a different server when PATH changes');
});

test('an MCP child inherits runtime variables and only explicitly referenced secrets', async () => {
  const ambientName = 'LIGULE_MCP_AMBIENT_SECRET';
  const explicitName = 'LIGULE_MCP_EXPLICIT_SECRET';
  const previous = { ambient: process.env[ambientName], explicit: process.env[explicitName] };
  process.env[ambientName] = 'ambient-test-secret';
  process.env[explicitName] = 'explicit-test-secret';
  const fixture = fileURLToPath(new URL('../../tests/fixtures/mcp-environment.mjs', import.meta.url));
  const registry = createMcpRegistry(mcpServerConfigs({
    mcp: { servers: { env: {
      command: process.execPath,
      args: [fixture],
      env: { MCP_FIXTURE_TOKEN: '${' + explicitName + '}' },
    } } },
  }));
  try {
    await registry.toolsOf('env');
    const response = await registry.call('env', 'inspect_environment', {}) as { content: { text: string }[] };
    assert.deepEqual(JSON.parse(response.content[0].text), {
      ambient: null,
      explicit: 'explicit-test-secret',
      pathAvailable: true,
    });
  } finally {
    await registry.close();
    if (previous.ambient === undefined) delete process.env[ambientName];
    else process.env[ambientName] = previous.ambient;
    if (previous.explicit === undefined) delete process.env[explicitName];
    else process.env[explicitName] = previous.explicit;
  }
});

function configsToConfig(env: Record<string, string> | undefined, tools: Record<string, unknown> = { command: 'node' }) {
  return { mcp: { servers: { fs: { ...tools, ...(env === undefined ? {} : { env }) } } } };
}

test('arguments are checked against the definition the server declared', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, lines: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['path'],
    additionalProperties: false,
  };
  assert.deepEqual(validateToolArguments({ path: 'a.txt', lines: 3, tags: ['x'] }, schema), []);
  assert.match(validateToolArguments({}, schema).join('; '), /required property 'path'/);
  assert.match(validateToolArguments({ path: 3 }, schema).join('; '), /must be string/);
  assert.match(validateToolArguments({ path: 'a', tags: [1] }, schema).join('; '), /tags\/0 must be string/);
  assert.match(validateToolArguments({ path: 'a', other: 1 }, schema).join('; '), /additional properties/);
});

test('arguments honor numeric, enum, and union schema constraints', () => {
  const schema = {
    type: 'object',
    properties: {
      milliseconds: { type: 'integer', minimum: 1 },
      format: { enum: ['short', 'long'] },
      email: { type: 'string', format: 'email' },
      value: { anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }] },
    },
    required: ['milliseconds', 'format', 'email', 'value'],
    additionalProperties: false,
  };
  assert.deepEqual(validateToolArguments({ milliseconds: 1, format: 'short', email: 'agent@example.com', value: 0 }, schema), []);
  assert.match(validateToolArguments({ milliseconds: 0, format: 'short', email: 'agent@example.com', value: 0 }, schema).join('; '), /minimum|>=/i);
  assert.match(validateToolArguments({ milliseconds: 1, format: 'wide', email: 'agent@example.com', value: 0 }, schema).join('; '), /allowed values/i);
  assert.match(validateToolArguments({ milliseconds: 1, format: 'short', email: 'invalid', value: 0 }, schema).join('; '), /email/);
  assert.match(validateToolArguments({ milliseconds: 1, format: 'short', email: 'agent@example.com', value: false }, schema).join('; '), /anyOf|valid/i);
});

test('a changed schema reusing its $id is validated from the new definition', () => {
  const id = '$id';
  const schema = (minimum: number) => ({
    [id]: 'urn:ligule:mcp:test:changed-schema',
    type: 'object',
    properties: { value: { type: 'integer', minimum } },
    required: ['value'],
  });
  assert.deepEqual(validateToolArguments({ value: 1 }, schema(1)), []);
  assert.match(validateToolArguments({ value: 1 }, schema(10)).join('; '), />= 10/);
});

test('the default schema dialect is Draft 2020-12 and prefixItems are enforced', () => {
  const schema = {
    type: 'object',
    properties: {
      values: { type: 'array', prefixItems: [{ const: 'only' }], items: false, title: 'one value' },
    },
    required: ['values'],
    description: 'This standard annotation is accepted.',
  };
  assert.deepEqual(validateToolArguments({ values: ['only'] }, schema), []);
  assert.notDeepEqual(validateToolArguments({ values: ['other'] }, schema), []);
  assert.notDeepEqual(validateToolArguments({ values: ['only', 'extra'] }, schema), []);
});

test('an explicit Draft 7 schema is supported and unsupported dialects fail closed', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { start: { type: 'boolean' }, end: { type: 'boolean' } },
    dependencies: { start: ['end'] },
  };
  assert.deepEqual(validateToolArguments({ start: true, end: false }, schema), []);
  assert.match(validateToolArguments({ start: true }, schema).join('; '), /dependency|end/);
  assert.notDeepEqual(validateToolArguments({}, { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }), []);
  assert.notDeepEqual(validateToolArguments({}, { type: 'object', properties: { value: { type: 'string', unknownConstraint: true } } }), []);
});

test('an invalid tool schema fails closed with the existing argument error code', async () => {
  const registry = fakeRegistry('aaaa', { type: 'bogus' });
  const disclosed = { seen: new Set(['fs/read_file@aaaa']) };
  const { callTool } = createMcpTools(registry, disclosed);
  assert.notDeepEqual(validateToolArguments({}, { type: 'bogus' }), []);
  await assert.rejects(
    () => callTool.run({ server: 'fs', tool: 'read_file', arguments: '{}', schemaDigest: 'aaaa' }),
    (error) => (error as CodedError).code === 'mcp_arguments_invalid',
  );
  assert.deepEqual(registry.calls, [], 'a call with a schema that cannot compile never reaches the server');
});

// 一台假的服务器，只用来把「定义换了」这一件事演出来：真实协议的那一段在下面那几条里跑。
function fakeRegistry(digest = 'aaaa', inputSchema: Record<string, unknown> = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }): FakeRegistry {
  const definition = { name: 'read_file', description: 'read one file', digest, inputSchema, annotations: { readOnlyHint: true } };
  const calls: [string, string, unknown][] = [];
  return {
    calls,
    servers: () => ['fs'],
    toolsOf: async () => [definition],
    definition: async () => definition,
    call: async (server, tool, args) => {
      calls.push([server, tool, args]);
      return { content: [{ type: 'text', text: 'the body' }] };
    },
  };
}

test('a call needs a disclosure, and a moved definition has to be inspected again', async () => {
  const registry = fakeRegistry('aaaa');
  const disclosed = { seen: new Set<string>() };
  const { inspectTool, callTool } = createMcpTools(registry, disclosed);
  const seen = await inspectTool.run({ server: 'fs', tool: 'read_file' });
  assert.equal(seen.schemaDigest, 'aaaa');

  // 没见过的那一版：先让它去看。
  await assert.rejects(
    () => callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'bbbb' }),
    (error) => (error as CodedError).code === 'mcp_not_disclosed',
  );
  // 看过 aaaa 而服务器现在是 cccc：按一份没在看的形状发起调用要挡住，并要求重新 inspect。
  const moved = { registry: fakeRegistry('cccc'), disclosed: { seen: new Set(['fs/read_file@aaaa']) } };
  const second = createMcpTools(moved.registry, moved.disclosed);
  await assert.rejects(
    () => second.callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'aaaa' }),
    (error) => (error as CodedError).code === 'mcp_definition_stale' && /now at cccc/.test((error as CodedError).detail as string),
  );

  await assert.rejects(
    () => callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"nope":1}', schemaDigest: 'aaaa' }),
    (error) => (error as CodedError).code === 'mcp_arguments_invalid',
  );
  await assert.rejects(
    () => callTool.run({ server: 'fs', tool: 'read_file', arguments: 'not json', schemaDigest: 'aaaa' }),
    (error) => (error as CodedError).code === 'mcp_arguments_invalid_json',
  );
  const result = await callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'aaaa' });
  assert.equal(result.text, 'the body');
  assert.equal(result.effectiveCapability, 'mcp:fs/read_file');
  assert.deepEqual(registry.calls, [['fs', 'read_file', { path: 'a.txt' }]]);
});

test('the decision chain judges the effective capability, not mcp.call', async () => {
  const registry = fakeRegistry();
  const disclosed = { seen: new Set(['fs/read_file@aaaa']) };
  const { callTool } = createMcpTools(registry, disclosed);
  const asked: PolicyQuestionView[] = [];
  const chain = createDecisionChain({
    mode: 'ask',
    rules: [{ tool: 'mcp:fs/edit_file', decision: 'deny', reason: 'editing through MCP is not allowed' }],
    ask: async (call) => {
      asked.push(call);
      return true;
    },
  });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: externalPermission,
    policy: chain,
  });
  kernel.register(callTool as ToolDefinition);
  await assert.rejects(
    () => kernel.call('mcp.call', { server: 'fs', tool: 'edit_file', arguments: '{}', schemaDigest: 'aaaa' }),
    (error) => (error as CodedError).code === 'policy_denied',
  );
  const seenByGuard: string[] = [];
  chain.guard(({ tool }) => {
    seenByGuard.push(tool);
    return undefined;
  });
  await kernel.call('mcp.call', { server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'aaaa' });
  assert.deepEqual(seenByGuard, ['mcp:fs/read_file'], '守卫与规则表看见的都是那一条能力名');
  assert.deepEqual(asked.map((call) => call.tool), ['mcp:fs/read_file'], 'the configured ask policy uses the actual MCP capability');
});

test('MCP server and tool authorization runs before registry operations', async () => {
  const registry = fakeRegistry();
  let serverChecks = 0;
  let toolChecks = 0;
  const { inspectTool, callTool } = createMcpTools(registry, { seen: new Set(['fs/read_file@aaaa']) }, {
    authorizeServer: async () => { serverChecks += 1; throw new Error('mcp_server_untrusted'); },
    authorizeTool: async () => { toolChecks += 1; throw new Error('agent_control_mcp_tool_denied'); },
  });

  await assert.rejects(() => inspectTool.run({ server: 'fs' }), /mcp_server_untrusted/u);
  await assert.rejects(() => callTool.run({ server: 'fs', tool: 'read_file', arguments: '{}', schemaDigest: 'aaaa' }), /agent_control_mcp_tool_denied/u);
  assert.equal(serverChecks, 1);
  assert.equal(toolChecks, 1);
  assert.deepEqual(registry.calls, []);
});

test('remembered MCP approval identity includes the normalized server configuration digest', () => {
  const registry = fakeRegistry();
  const { callTool } = createMcpTools(registry, { seen: new Set() }, {
    identityDigest: (server) => server === 'fs' ? 'configuration-digest' : undefined,
  });
  assert.equal(callTool.policyIdentity({ server: 'fs' }), 'configuration-digest');
  assert.equal(callTool.policyIdentity({ server: 'unknown' }), undefined);
});

test('an Agent Control MCP ceiling denies before Policy asks or any MCP operation starts', async () => {
  const registry = fakeRegistry();
  let asked = 0;
  const { callTool } = createMcpTools(registry, { seen: new Set(['fs/read_file@aaaa']) }, {
    authorizeTool: () => { throw new KernelError('agent_control_mcp_tool_denied'); },
  });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: externalPermission,
    policy: createDecisionChain({ mode: 'ask', ask: async () => { asked += 1; return true; } }),
  });
  kernel.register(callTool as ToolDefinition);

  await assert.rejects(
    () => kernel.call('mcp.call', { server: 'fs', tool: 'read_file', arguments: '{}', schemaDigest: 'aaaa' }),
    (error) => (error as CodedError).code === 'agent_control_mcp_tool_denied',
  );
  assert.equal(asked, 0);
  assert.deepEqual(registry.calls, []);
});

test('trusted MCP tools are visible and callable in workspace-write without full-access', async () => {
  const registry = fakeRegistry();
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, { profiles: { readOnly: 'full', workspaceWrite: 'partial' }, workspaceTrusted: true });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission,
    policy: createDecisionChain({ mode: 'ask', ask: async () => true }),
  });
  loadAssembly(kernel, [createMcpPlugin(registry)]);
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['mcp.call', 'mcp.inspect']);

  await kernel.call('mcp.inspect', { server: 'fs', tool: 'read_file' });
  const result = await kernel.call('mcp.call', {
    server: 'fs', tool: 'read_file', arguments: '{"path":"note.txt"}', schemaDigest: 'aaaa',
  }) as { text: string };
  assert.equal(result.text, 'the body');
  assert.equal(registry.calls.length, 1);
});

test('nothing is registered when no server is configured', () => {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  const undo = createMcpPlugin({ servers: () => [], toolsOf: async () => [], definition: async () => ({}), call: async () => ({}) } as unknown as RegistryView).setup(kernel);
  assert.deepEqual(kernel.list(), [], '两件固定工具不登记：没人用的工具会改掉每次请求的前缀字节（D12）');
  undo();
});

test('a real stdio server answers inspect and call through the registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-'));
  await writeFile(join(root, 'note.txt'), 'hello from the server');
  const configs = mcpServerConfigs({
    mcp: { servers: { fs: { command: process.execPath, args: [serverEntry, root] } } },
  });
  const { createMcpRegistry } = await import('../dist/index.js');
  const registry = createMcpRegistry(configs);
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: externalPermission,
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
  });
  loadAssembly(kernel, [createMcpPlugin(registry)]);
  try {
  assert.deepEqual(kernel.list(), ['mcp.call', 'mcp.inspect']);
  const listed = await kernel.call('mcp.inspect', {}) as InspectResult;
  assert.equal(listed.text, 'fs');
  const tools = await kernel.call('mcp.inspect', { server: 'fs' }) as InspectResult;
  assert.match(tools.text, /read_text_file\t[0-9a-f]{12}/);
  const one = await kernel.call('mcp.inspect', { server: 'fs', tool: 'read_text_file' }) as InspectResult;
  assert.equal(one.schemaDigest.length, 12);
  const read = await kernel.call('mcp.call', {
    server: 'fs',
    tool: 'read_text_file',
    arguments: JSON.stringify({ path: join(root, 'note.txt') }),
    schemaDigest: one.schemaDigest,
  }) as { text: string };
  assert.match(read.text, /hello from the server/);
  await assert.rejects(
    () => kernel.call('mcp.inspect', { server: 'gone' }),
    (error) => (error as CodedError).code === 'mcp_server_unknown',
  );
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('registered real MCP calls retain configuration identity for deny and remembered allow rules', async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-identity-'));
  const otherCwd = join(root, 'other');
  await mkdir(otherCwd);
  await writeFile(join(root, 'note.txt'), 'identity-bound content');
  const questions: PolicyQuestionView[] = [];
  const chain = createDecisionChain({ mode: 'ask', ask: (question) => { questions.push(question); return false; } });
  let firstIdentity;
  try {
    for (const cwd of [root, otherCwd]) {
      const configs = mcpServerConfigs({ mcp: { servers: { fs: { command: process.execPath, args: [serverEntry, root], cwd } } } });
      const identity = configs[0].identityDigest;
      const registry = createMcpRegistry(configs);
      try {
        const { inspectTool, callTool } = createMcpTools(registry, { seen: new Set() }, { identityDigest: () => identity });
        const definition = await inspectTool.run({ server: 'fs', tool: 'read_text_file' });
        const args = { server: 'fs', tool: 'read_text_file', arguments: JSON.stringify({ path: join(root, 'note.txt') }), schemaDigest: definition.schemaDigest };
        const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), permission: externalPermission, policy: chain });
        kernel.register(callTool as ToolDefinition);
        if (firstIdentity === undefined) {
          firstIdentity = identity;
          const argsHash = policyArgsHash(args, identity);
          chain.setRules([{ tool: 'mcp:fs/read_text_file', decision: 'deny', argsHash }]);
          await assert.rejects(kernel.call('mcp.call', args), { code: 'policy_denied' });
          assert.equal(questions.length, 0, 'a matching denial must not ask');
          chain.setRules([{ tool: 'mcp:fs/read_text_file', decision: 'allow', argsHash }]);
          assert.equal((await kernel.call('mcp.call', args) as { text: string }).text, 'identity-bound content');
          assert.equal(questions.length, 0, 'a remembered allow must match after registration');
        } else {
          assert.notEqual(identity, firstIdentity);
          await assert.rejects(kernel.call('mcp.call', args), { code: 'ask_declined' });
          assert.equal(questions.length, 1, 'the former allow must not cover changed launch settings');
          assert.equal(questions[0].identityDigest, identity);
        }
      } finally { await registry.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Host Policy denies a real MCP write under the server root', async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-policy-'));
  const target = join(root, 'denied.txt');
  const configs = mcpServerConfigs({
    mcp: { servers: { fs: { command: process.execPath, args: [serverEntry, root] } } },
  });
  const registry = createMcpRegistry(configs);
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root } }),
    permission: externalPermission,
    policy: createDecisionChain({ mode: 'auto', ask: async () => true, rules: [{ tool: 'mcp:fs/write_file', decision: 'deny', reason: 'test denial' }] }),
  });
  loadAssembly(kernel, [createMcpPlugin(registry)]);
  try {
    const definition = await kernel.call('mcp.inspect', { server: 'fs', tool: 'write_file' }) as InspectResult;
    await assert.rejects(
      () => kernel.call('mcp.call', {
        server: 'fs',
        tool: 'write_file',
        arguments: JSON.stringify({ path: target, content: 'must not be written' }),
        schemaDigest: definition.schemaDigest,
      }),
      (error) => (error as CodedError).code === 'policy_denied',
    );
    await assert.rejects(() => access(target), { code: 'ENOENT' });
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

// 服务器工具定义变化后摘要应更新；旧摘要的调用需等重新检查后才能继续。
test('a server that moved its definition is caught over the real protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-fixture-'));
  const schema = join(root, 'schema.json');
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }));
  const registry = createMcpRegistry(mcpServerConfigs({
    mcp: { servers: { fx: { command: process.execPath, args: [fileURLToPath(new URL('../../tests/fixtures/mcp-minimal.mjs', import.meta.url)), schema] } } },
  }));
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root } }),
    permission: externalPermission,
    policy: createDecisionChain({ mode: 'auto', ask: async () => true }),
  });
  loadAssembly(kernel, [createMcpPlugin(registry)]);
  try {
  const first = await kernel.call('mcp.inspect', { server: 'fx', tool: 'echo' }) as InspectResult;
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }));
  await assert.rejects(
    () => kernel.call('mcp.call', { server: 'fx', tool: 'echo', arguments: '{"value":"x"}', schemaDigest: first.schemaDigest }),
    (error) => (error as CodedError).code === 'mcp_definition_stale',
  );
  const second = await kernel.call('mcp.inspect', { server: 'fx', tool: 'echo' }) as InspectResult;
  assert.notEqual(second.schemaDigest, first.schemaDigest, 'the digest follows the definition');
  // 新的那一份声明要的是数字：按新形状递才通得过，这一句同时说明校验读的是当前定义而不是旧的。
  const called = await kernel.call('mcp.call', { server: 'fx', tool: 'echo', arguments: '{"value":7}', schemaDigest: second.schemaDigest }) as { text: string; effectiveCapability: string };
  assert.match(called.text, /echo: 7/);
  assert.equal(called.effectiveCapability, 'mcp:fx/echo');
  await assert.rejects(
    () => kernel.call('mcp.call', { server: 'fx', tool: 'echo', arguments: '{"value":"x"}', schemaDigest: second.schemaDigest }),
    (error) => (error as CodedError).code === 'mcp_arguments_invalid',
  );
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

// 固定的 MCP 披露工具不受模式筛选，始终可用。
test('a mode can neither select nor hide the two MCP tools', async () => {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }), permission: externalPermission });
  loadAssembly(kernel, [createMcpPlugin({ servers: () => ['fx'], toolsOf: async () => [], definition: async () => ({}), call: async () => ({}) } as unknown as RegistryView)]);
  assert.deepEqual(kernel.list(), ['mcp.call', 'mcp.inspect']);
  assert.deepEqual(kernel.selectable(), [], '登记了但不在模式能挑的范围里');
  const chain = createDecisionChain({ mode: 'auto' });
  assert.deepEqual(chain.evaluate === undefined, false);
});

// Host 那一条接线：配置里有一台服务器就在会话里多出那两件固定工具，没配就一件都不加。
// 注册表是惰性连接的，所以这一条不会起子进程。
test('the host wires the two tools from the config, and not when there is no server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-host-'));
  const withServer = createConfig({
    user: {
      boundary: root,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'm' },
      policy: { mode: 'ask' },
      mcp: { servers: { fs: { command: process.execPath, args: [serverEntry, root] } } },
    },
  });
  const provider = { capabilities: MESSAGES_CAPABILITIES, model: 'm', async *stream() { yield { type: 'text', text: 'ok' }; } } as unknown as HostProvider;
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    input: pair.host.input, output: pair.host.output, config: withServer, provider, policy: withServer.policy as HostOptions['policy'],
    permission: externalPermission,
  });
  const connection = createConnection(pair.client);
  try {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    const status = await connection.request('status.get', { sessionId }) as { tools: string[] };
    assert.deepEqual(status.tools.filter((name) => name.startsWith('mcp.')), ['mcp.call', 'mcp.inspect']);
    assert.equal(status.tools.includes('read'), true, 'the rest of the registry is untouched');
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(root, { recursive: true, force: true });
  }
});
