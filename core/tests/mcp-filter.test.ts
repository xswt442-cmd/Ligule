import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpRegistry, createMcpTools, mcpServerConfigs } from '../dist/index.js';
import type { NormalizedMcpServerConfig } from '../dist/capability/mcp.js';

type FixturePaths = { directory: string; version: string; calls: string; unsafeEffect: string; filenameEffect: string };
type SchemaView = { properties: Record<string, Record<string, unknown>>; additionalProperties?: unknown };

const fixturePath = fileURLToPath(new URL('./fixtures/mcp-filter-server.mjs', import.meta.url));
const testplace = join(process.cwd(), 'testplace');

test('a paused server cannot be started by discovery queued before access was revoked', async () => {
  await withFixture(async (paths, configs) => {
    let paused = false;
    const registry = createMcpRegistry(configs, { assertServerAccess: () => {
      if (paused) throw Object.assign(new Error('paused'), { code: 'browser_stopped' });
    } });
    try {
      const queued = registry.toolsOf('browser');
      paused = true;
      await assert.rejects(queued, { code: 'browser_stopped' });
      assert.deepEqual(registry.activeServers(), []);
      await absent(paths.calls);
      paused = false;
      await registry.toolsOf('browser');
      assert.deepEqual(registry.activeServers(), ['browser']);
      const next = registry.toolsOf('browser');
      paused = true;
      const stopped = registry.revoke('browser');
      await assert.rejects(next);
      await stopped;
      await assert.rejects(registry.toolsOf('browser'), { code: 'browser_stopped' });
      assert.deepEqual(registry.activeServers(), []);
    } finally { await registry.close(); }
  });
});

async function withFixture(run: (paths: FixturePaths, configs: NormalizedMcpServerConfig[]) => Promise<void>) {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'mcp-filter-'));
  const paths = {
    directory,
    version: join(directory, 'version'),
    calls: join(directory, 'calls.jsonl'),
    unsafeEffect: join(directory, 'unsafe-effect'),
    filenameEffect: join(directory, 'filename-effect'),
  };
  const configs = mcpServerConfigs({ mcp: { servers: { browser: {
    command: process.execPath,
    args: [fixturePath, paths.version, paths.calls, paths.unsafeEffect],
  } } } }, {}, process.cwd());
  try {
    await run(paths, configs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function browserToolPolicy(server: string, tool: string, schema: Record<string, unknown>): Record<string, unknown> | undefined {
  if (server !== 'browser' || tool === 'unsafe_action') return undefined;
  if (tool !== 'safe') return undefined;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  return {
    ...schema,
    properties: { text: properties.text },
    required: Array.isArray(schema.required) ? schema.required.filter((name) => name === 'text') : [],
    additionalProperties: false,
  };
}

function digestOf(definition: { name: string; description: string; inputSchema: unknown; annotations: unknown }) {
  return createHash('sha256').update(JSON.stringify({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
  })).digest('hex').slice(0, 12);
}

async function absent(path: string) {
  await assert.rejects(() => access(path), { code: 'ENOENT' });
}

test('registry filters every relisted definition and validates direct calls against its filtered schema', async () => {
  await withFixture(async (paths, configs) => {
    const registry = createMcpRegistry(configs, { toolPolicy: browserToolPolicy });
    const tools = { seen: new Set<string>() };
    const { inspectTool, callTool } = createMcpTools(registry, tools);
    try {
      const firstList = await registry.toolsOf('browser');
      assert.deepEqual(firstList.map((tool) => tool.name), ['safe']);
      assert.equal((firstList[0].inputSchema as SchemaView).properties.filename, undefined);
      assert.equal((firstList[0].inputSchema as SchemaView).additionalProperties, false);

      const listing = await inspectTool.run({ server: 'browser' }) as { tools: { name: string }[] };
      assert.deepEqual(listing.tools.map((tool) => tool.name), ['safe']);
      const firstInspection = await inspectTool.run({ server: 'browser', tool: 'safe' });
      const inspected = JSON.parse(firstInspection.text);
      assert.equal(inspected.inputSchema.properties.filename, undefined);
      assert.equal(inspected.inputSchema.additionalProperties, false);
      assert.equal(inspected.annotations.readOnlyHint, true);
      assert.equal(firstInspection.schemaDigest, digestOf({
        name: inspected.name,
        description: inspected.description,
        inputSchema: inspected.inputSchema,
        annotations: inspected.annotations,
      }));

      await assert.rejects(
        () => registry.call('browser', 'unsafe_action', {}),
        { code: 'mcp_tool_unknown' },
      );
      await assert.rejects(
        () => registry.call('browser', 'safe', { text: 'valid', filename: paths.filenameEffect }),
        { code: 'mcp_arguments_invalid' },
      );
      await absent(paths.unsafeEffect);
      await absent(paths.filenameEffect);

      const firstCall = await callTool.run({
        server: 'browser', tool: 'safe', arguments: JSON.stringify({ text: 'valid' }), schemaDigest: firstInspection.schemaDigest,
      });
      assert.equal(firstCall.text, 'safe: valid');

      await writeFile(paths.version, 'changed');
      const secondList = await registry.toolsOf('browser');
      assert.deepEqual(secondList.map((tool) => tool.name), ['safe']);
      assert.equal((secondList[0].inputSchema as SchemaView).properties.filename, undefined);
      assert.equal((secondList[0].inputSchema as SchemaView).additionalProperties, false);
      const secondInspection = await inspectTool.run({ server: 'browser', tool: 'safe' });
      const updated = JSON.parse(secondInspection.text);
      assert.notEqual(secondInspection.schemaDigest, firstInspection.schemaDigest);
      assert.equal(updated.description, 'Safe tool version 2');
      assert.equal(updated.annotations.readOnlyHint, false);
      assert.equal(updated.inputSchema.properties.filename, undefined);
      assert.equal(updated.inputSchema.properties.text.minLength, 2);
      assert.equal(updated.inputSchema.additionalProperties, false);
      assert.equal(secondInspection.schemaDigest, digestOf({
        name: updated.name,
        description: updated.description,
        inputSchema: updated.inputSchema,
        annotations: updated.annotations,
      }));

      await assert.rejects(
        () => callTool.run({
          server: 'browser', tool: 'safe', arguments: JSON.stringify({ text: 'valid' }), schemaDigest: firstInspection.schemaDigest,
        }),
        { code: 'mcp_definition_stale' },
      );
      await assert.rejects(
        () => registry.call('browser', 'safe', { text: 'x' }),
        { code: 'mcp_arguments_invalid' },
      );
      const secondCall = await callTool.run({
        server: 'browser', tool: 'safe', arguments: JSON.stringify({ text: 'new version' }), schemaDigest: secondInspection.schemaDigest,
      });
      assert.equal(secondCall.text, 'safe: new version');

      const calls = (await readFile(paths.calls, 'utf8')).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      assert.deepEqual(calls, [
        { name: 'safe', args: { text: 'valid' } },
        { name: 'safe', args: { text: 'new version' } },
      ]);
      await absent(paths.unsafeEffect);
      await absent(paths.filenameEffect);
    } finally {
      await registry.close();
    }
  });
});

test('registry keeps existing tool visibility when no policy is supplied', async () => {
  await withFixture(async (paths, configs) => {
    const registry = createMcpRegistry(configs);
    try {
      const tools = await registry.toolsOf('browser');
      assert.deepEqual(tools.map((tool) => tool.name), ['safe', 'unsafe_action']);
      assert.equal((tools.find((tool) => tool.name === 'safe') as unknown as { inputSchema: SchemaView }).inputSchema.properties.filename.type, 'string');
      const safe = await registry.call('browser', 'safe', { text: 'legacy', filename: paths.filenameEffect }) as { content: { text: string }[] };
      assert.equal(safe.content[0].text, 'safe: legacy');
      assert.equal(await readFile(paths.filenameEffect, 'utf8'), 'filename side effect');
      const result = await registry.call('browser', 'unsafe_action', {}) as { content: { text: string }[] };
      assert.equal(result.content[0].text, 'unsafe action ran');
      assert.equal(await readFile(paths.unsafeEffect, 'utf8'), 'unsafe tool ran');
    } finally {
      await registry.close();
    }
  });
});
