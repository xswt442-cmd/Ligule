import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  createConfig, createDecisionChain, createKernel, createMcpPlugin, createMcpRegistry,
  createMediaStore, createSessionLog, loadAssembly, mcpServerConfigs,
} from '../dist/index.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import type { ImageReference } from '../dist/media.js';
import type { MediaStore } from '../dist/capability/media.js';
import type { SessionLog } from '../dist/session/session.js';
import type { SessionDirectoryConfig } from '../dist/session/list.js';
import type { Kernel } from '../dist/kernel/kernel.js';

type McpCallResult = { kind?: string; text: string; images: readonly ImageReference[] };
type ToolEventResult = { failed: boolean; code?: string; content: string; images?: unknown };
type ImagesContext = {
  root: string;
  input: Buffer;
  media: MediaStore;
  session: SessionLog;
  kernel: Kernel;
  call: (mode?: string, signal?: AbortSignal) => Promise<McpCallResult>;
};
type ImagesOptions = { enabled?: boolean; source?: ImageReference['source']; unknownSource?: boolean };

const serverEntry = fileURLToPath(new URL('./fixtures/mcp-image-server.mjs', import.meta.url));
const permission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'full',
});

async function withMcpImages({ enabled = true, source = 'file', unknownSource = false }: ImagesOptions = {}, run: (context: ImagesContext) => Promise<void>) {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-images-'));
  const input = await sharp({ create: { width: 7, height: 5, channels: 3, background: '#44aaff' } }).png().toBuffer();
  const imagePath = join(root, 'sample.png');
  await writeFile(imagePath, input);
  const config = createConfig({ user: {
    boundary: root,
    workspaceRoot: root,
    userHome: join(root, 'home'),
    policy: { mode: 'auto' },
    mcp: { servers: { images: { command: process.execPath, args: [serverEntry, imagePath] } } },
  } });
  const registry = createMcpRegistry(mcpServerConfigs(config, process.env, root));
  const session = createSessionLog({ directory: join(root, 'sessions'), id: 'image-session', meta: { projectRoot: root } });
  const media = createMediaStore(config as unknown as SessionDirectoryConfig, 'image-session');
  const kernel = createKernel({ config, session, permission, policy: createDecisionChain({ mode: 'auto' }) });
  const images = enabled ? {
    media,
    sourceFor: () => unknownSource ? undefined : source,
  } : undefined;
  const assembly = loadAssembly(kernel, [createMcpPlugin(registry, {}, images)]);
  try {
    const inspected = await kernel.call('mcp.inspect', { server: 'images', tool: 'fetch_image' }) as { schemaDigest: string };
    const call = (mode = 'image', signal?: AbortSignal) => kernel.call('mcp.call', {
      server: 'images', tool: 'fetch_image', arguments: JSON.stringify({ mode }), schemaDigest: inspected.schemaDigest,
    }, { signal }) as Promise<McpCallResult>;
    await run({ root, input, media, session, kernel, call });
  } finally {
    assembly.dispose();
    await session.close();
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('real stdio MCP image content is persisted and represented in Session only by references', async () => {
  await withMcpImages({}, async ({ input, media, session, call }) => {
    const result = await call();
    assert.equal(result.kind, 'image_result');
    assert.match(result.text, /fixture image result/u);
    assert.match(result.text, /shotId=/u);
    assert.match(result.text, /source=file/u);
    assert.equal(result.images.length, 1);
    const [reference] = result.images;
    assert.equal(reference.source, 'file');
    const stored = await media.reference(reference.id);
    const bytes = await media.read(stored);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), stored.sha256);
    assert.ok(bytes.length > 0);
    const serialized = await readFile(join(session.directory, 'image-session.jsonl'), 'utf8');
    assert.equal(serialized.includes(input.toString('base64')), false);
    assert.equal(serialized.includes(bytes.toString('base64')), false);
    assert.equal(serialized.includes('base64'), false);
    const events = await session.read();
    const terminal = events.filter((event) => event.kind === 'tool' && event.tool === 'mcp.call');
    assert.equal(terminal.length, 1);
    assert.equal((terminal[0].result as ToolEventResult).failed, false);
    assert.deepEqual((terminal[0].result as ToolEventResult).images, result.images);
  });
});

test('ordinary MCP text results retain their existing result shape', async () => {
  await withMcpImages({}, async ({ call, session }) => {
    const result = await call('text');
    assert.deepEqual(result, {
      text: 'ordinary MCP response', server: 'images', tool: 'fetch_image',
      effectiveCapability: 'mcp:images/fetch_image', failed: false,
    });
    assert.equal((await session.read()).some((event) => event.kind === 'image'), false);
  });
});

test('image results fail clearly when persistence or a source mapping is unavailable', async () => {
  for (const options of [{ enabled: false }, { unknownSource: true }]) {
    await withMcpImages(options, async ({ call, session }) => {
      await assert.rejects(() => call(), (error) => (error as { code?: string }).code === 'mcp_image_unsupported');
      const terminal = (await session.read()).filter((event) => event.kind === 'tool' && event.tool === 'mcp.call');
      assert.equal(terminal.length, 1);
      assert.equal((terminal[0].result as ToolEventResult).failed, true);
      assert.equal((terminal[0].result as ToolEventResult).code, 'mcp_image_unsupported');
    });
  }
});

test('invalid base64, unsupported MIME, and too many images fail without success records', async () => {
  for (const [mode, code] of [
    ['bad-base64', 'mcp_image_invalid'],
    ['unsupported', 'mcp_image_unsupported'],
    ['too-many', 'mcp_image_count_exceeded'],
  ]) {
    await withMcpImages({}, async ({ call, session }) => {
      await assert.rejects(() => call(mode), (error) => (error as { code?: string }).code === code, mode);
      const terminal = (await session.read()).filter((event) => event.kind === 'tool' && event.tool === 'mcp.call');
      assert.equal(terminal.length, 1);
      assert.equal((terminal[0].result as ToolEventResult).failed, true);
      assert.equal((terminal[0].result as ToolEventResult).code, code);
    });
  }
});

test('MCP isError becomes one failed tool result with bounded UTF-8 diagnostic text', async () => {
  await withMcpImages({}, async ({ call, session }) => {
    await assert.rejects(() => call('error'), (error) => {
      assert.equal((error as { code?: string }).code, 'mcp_tool_failed');
      assert.ok(Buffer.byteLength((error as { detail?: string }).detail as string, 'utf8') <= 4_000);
      return true;
    });
    const terminal = (await session.read()).filter((event) => event.kind === 'tool' && event.tool === 'mcp.call');
    assert.equal(terminal.length, 1);
    assert.equal((terminal[0].result as ToolEventResult).failed, true);
    assert.equal((terminal[0].result as ToolEventResult).code, 'mcp_tool_failed');
    assert.ok(Buffer.byteLength((terminal[0].result as ToolEventResult).content, 'utf8') <= 4_000);
  });
});
