import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { createConfig, createDecisionChain, createKernel, createLoop, createSessionLog, readTool } from '../dist/index.js';
import { createChatCompletionsProvider } from '../dist/model/chat-completions.js';
import { createMessagesProvider } from '../dist/model/messages.js';
import { createMediaStore } from '../dist/capability/media.js';
import { createReadImagePlugin } from '../dist/tools/read-image.js';
import { branchSession } from '../dist/session/branch.js';
import { prefixDigest } from '../dist/session/checkpoint.js';
import { estimateTokens } from '../dist/session/usage.js';
import { flatten } from '../dist/session/compaction.js';
import { parseSessionEvents } from '../dist/session/format.js';
import type { SessionEvent } from '../dist/session/format.js';
import type { ConfigSnapshot } from '../dist/kernel/config.js';
import type { ImageReference } from '../dist/media.js';
import { imageInputOf } from '../dist/model/images.js';
import { listenFetchable } from './helpers/port.ts';

const credentialReference = 'LIGULE_IMAGE_FIXTURE_KEY';

type FixtureConfig = ConfigSnapshot & { boundary: string; workspaceRoot: string };

type WireBlock = {
  type: string;
  tool_use_id?: string;
  content?: WireBlock[];
  source?: { data: string };
  image_url?: { url: string };
};

type WireMessage = { role?: string; content?: WireBlock[] };

type WireBody = { messages: WireMessage[] };

type FixtureToolEvent = SessionEvent & {
  tool?: string;
  callId?: string;
  ignorable?: boolean;
  result: { failed: boolean; spilled?: string; images: ImageReference[] };
};

type ProviderOptions = NonNullable<Parameters<typeof createChatCompletionsProvider>[0]>;

type FixtureOptions = {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  imageInput: boolean;
  capabilities: { streaming: boolean };
  retry: NonNullable<ProviderOptions['retry']>;
};

type FixtureProvider = ReturnType<typeof createMessagesProvider>;

type FixtureContext = {
  root: string;
  config: FixtureConfig;
  requests: WireBody[];
  provider: FixtureProvider;
  factory: typeof createMessagesProvider | typeof createChatCompletionsProvider;
  options: FixtureOptions;
  session: ReturnType<typeof createSessionLog>;
  media: ReturnType<typeof createMediaStore>;
  kernel: ReturnType<typeof createKernel>;
};

async function fixture(
  protocol: 'chat-completions' | 'messages',
  run: (context: FixtureContext) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'image-input-'));
  const config = createConfig({ user: { boundary: root, workspaceRoot: root, userHome: join(root, 'home'), limits: { resultBytes: 64 }, policy: { mode: 'auto' } } }) as FixtureConfig;
  const requests: WireBody[] = [];
  const input = await sharp({ create: { width: 6, height: 4, channels: 3, background: '#b115ff' } }).png().toBuffer();
  await writeFile(join(root, 'sample.png'), input);
  await writeFile(join(root, 'note.txt'), 'ordinary tool result');
  const key = randomUUID();
  const previous = process.env[credentialReference];
  process.env[credentialReference] = key;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(protocol === 'messages' ? request.headers['x-api-key'] : request.headers.authorization, protocol === 'messages' ? key : `Bearer ${key}`);
      requests.push(body);
      response.setHeader('content-type', 'application/json');
      if (requests.length === 1) {
        const calls = [{ id: 'image_call', name: 'read_image', args: { path: 'sample.png' } }, { id: 'text_call', name: 'read', args: { path: 'note.txt' } }];
        response.end(JSON.stringify(protocol === 'messages'
          ? { role: 'assistant', content: calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })), stop_reason: 'tool_use' }
          : { choices: [{ message: { content: null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: 'tool_calls' }] }));
      } else {
        response.end(JSON.stringify(protocol === 'messages'
          ? { role: 'assistant', content: [{ type: 'text', text: 'image received' }], stop_reason: 'end_turn' }
          : { choices: [{ message: { content: 'image received' }, finish_reason: 'stop' }] }));
      }
    } catch {
      response.statusCode = 500;
      response.end('{}');
    }
  });
  const port = await listenFetchable(server);
  const factory = protocol === 'messages' ? createMessagesProvider : createChatCompletionsProvider;
  const options: FixtureOptions = { baseUrl: `http://127.0.0.1:${port}`, model: 'local-image-fixture', apiKeyEnv: credentialReference,
    imageInput: true, capabilities: { streaming: false }, retry: { maxAttempts: 1, baseDelayMs: 1, retry429: false, retry5xx: false, retryTransport: false } };
  const provider: FixtureProvider = factory(options);
  const session = createSessionLog({ directory: join(root, 'sessions'), id: 'parent', meta: { projectRoot: root } });
  const media = createMediaStore(config, 'parent');
  const kernel = createKernel({ config, session, policy: createDecisionChain({ mode: 'auto' }) });
  const dispose = createReadImagePlugin({ media, supportsImages: () => provider.imageInput }).setup(kernel);
  kernel.register(readTool);
  try { await run({ root, config, requests, provider, factory, options, session, media, kernel }); }
  finally {
    dispose();
    await session.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env[credentialReference];
    else process.env[credentialReference] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

for (const protocol of ['chat-completions', 'messages'] as const) {
  test(`${protocol}: real image tools, bounded text, persistent projection and HTTP image blocks`, async () => {
    await fixture(protocol, async ({ config, requests, provider, session, media, kernel, factory, options }) => {
      const loop = createLoop({ kernel, provider, session, resolveImage: media.read, limits: { iterations: 3, modelCalls: 3 } });
      assert.equal((await loop.run('inspect the sample')).text, 'image received');
      const events = await session.read();
      const result = events.find(event => event.kind === 'tool' && event.tool === 'read_image') as unknown as FixtureToolEvent;
      assert.equal(result.result.failed, false);
      assert.ok(result.result.spilled, 'the small text limit is exercised');
      assert.equal(result.result.images.length, 1, 'text spilling preserves image references');
      const reference = result.result.images[0];
      const durable = await media.read(reference);
      assert.ok(events.some(event => event.kind === 'image' && event.callId === result.callId && event.ignorable !== true));
      const header = await session.header();
      assert.throws(() => parseSessionEvents([header, ...events.filter(event => event.kind !== 'image')] as unknown as SessionEvent[]), { code: 'session_image_reference_invalid' });
      assert.throws(() => parseSessionEvents([header, ...events.map(event => event.kind === 'image' ? { ...event, ignorable: true } : event)] as unknown as SessionEvent[]), { code: 'session_image_reference_invalid' });
      const raw = await readFile(join(session.directory, 'parent.jsonl'), 'utf8');
      assert.equal(raw.includes('base64'), false);
      assert.equal(raw.includes(durable.toString('base64')), false);
      const body = requests[1];
      let encoded: string;
      if (protocol === 'messages') {
        const results = body.messages.find(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))!.content!;
        assert.equal(results.length, 2);
        encoded = results.find(block => block.tool_use_id === 'image_call')!.content!.find(block => block.type === 'image')!.source!.data;
      } else {
        const toolIndexes = body.messages.flatMap((message, index) => message.role === 'tool' ? [index] : []);
        assert.equal(toolIndexes.length, 2);
        const imageIndex = body.messages.findIndex(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url'));
        assert.ok(imageIndex > Math.max(...toolIndexes), 'images follow the entire completed tool batch');
        encoded = body.messages[imageIndex].content!.find(block => block.type === 'image_url')!.image_url!.url.split(',')[1];
      }
      assert.deepEqual(Buffer.from(encoded, 'base64'), durable);
      const view = await session.modelView();
      assert.ok(estimateTokens(view) >= 4096);
      assert.ok(flatten(events).includes(reference.id));
      assert.notEqual(prefixDigest(events), prefixDigest(events.map(event => event === result ? { ...event, result: { ...(event as FixtureToolEvent).result, images: [{ ...reference, width: 1 }] } } : event)));

      const before = requests.length;
      const unsupported = factory({ ...options, imageInput: false });
      await assert.rejects(async () => { for await (const _event of unsupported.stream({ system: '', tools: [], messages: view, resolveImage: media.read } as unknown as Parameters<FixtureProvider['stream']>[0])) { /* consume */ } }, { code: 'model_image_input_unsupported' });
      assert.equal(requests.length, before, 'unsupported models reject images before HTTP');
      assert.equal(provider.withModel('another-model').imageInput, false);
      assert.equal(provider.withModel(options.model).imageInput, true);

      await session.close();
      const reopened = createSessionLog({ directory: session.directory, id: 'parent' });
      try { assert.deepEqual(await reopened.modelView(), view); }
      finally { await reopened.close(); }
      const branch = await branchSession(session.directory, 'parent', { projectRoot: config.workspaceRoot });
      const branched = createSessionLog({ directory: session.directory, id: branch.sessionId });
      try {
        const branchView = await branched.modelView() as { role?: string; images?: ImageReference[] }[];
        const inherited = branchView.filter(message => message.role === 'tool').flatMap(message => message.images ?? []);
        const branchMedia = createMediaStore(config, branch.sessionId, inherited);
        assert.deepEqual(await branchMedia.read(reference), durable);
      } finally { await branched.close(); }
    });
  });
}

test('invalid image plugin results produce exactly one failed terminal tool record', async () => {
  await fixture('chat-completions', async ({ kernel, session }) => {
    kernel.register({ name: 'invalid_image', description: 'Invalid image result fixture', access: 'read', parameters: { type: 'object', properties: {} },
      run: async () => ({ kind: 'image_result', text: 'bad output', images: [{}] }) });
    await assert.rejects(kernel.call('invalid_image', {}), { code: 'tool_failed' });
    const results = (await session.read()).filter(event => event.kind === 'tool' && event.tool === 'invalid_image') as unknown as FixtureToolEvent[];
    assert.equal(results.length, 1);
    assert.equal(results[0].result.failed, true);
  });
});

test('read_image enforces its source contract and filesystem boundary and can reread an owned shotId', async () => {
  await fixture('chat-completions', async ({ kernel, root, requests }) => {
    await assert.rejects(kernel.call('read_image', {}), { code: 'image_source_required' });
    await assert.rejects(kernel.call('read_image', { path: 'sample.png', shotId: randomUUID() }), { code: 'image_source_required' });
    await assert.rejects(kernel.call('read_image', { path: '../outside.png' }), { code: 'path_escapes_boundary' });
    await writeFile(join(root, 'broken.png'), 'invalid image bytes');
    await assert.rejects(kernel.call('read_image', { path: 'broken.png' }), { code: 'image_decode_failed' });
    const image = await kernel.call('read_image', { path: 'sample.png' }) as { images: ImageReference[] };
    const reread = await kernel.call('read_image', { shotId: image.images[0].id }) as { images: ImageReference[] };
    assert.deepEqual(reread.images, image.images);
    assert.equal(requests.length, 0);
  });
});

test('automatic image capability is restricted to verified official routes and explicit declarations', () => {
  assert.equal(imageInputOf('https://api.deepseek.com/v1', 'deepseek-flash'), true);
  assert.equal(imageInputOf('https://api.deepseek.com/anthropic/v1', 'deepseek-flash', undefined, 'messages'), true);
  assert.equal(imageInputOf('https://api.deepseek.com/v1', 'deepseek-flash', undefined, 'messages'), false);
  assert.equal(imageInputOf('https://api.deepseek.com/anthropic/v1', 'deepseek-flash'), false);
  assert.equal(imageInputOf('https://api.deepseek.com/v1', 'unknown-vision-model'), false);
  assert.equal(imageInputOf('https://api.deepseek.com.example.test', 'deepseek-flash'), false);
  assert.equal(imageInputOf('http://api.deepseek.com', 'deepseek-flash'), false);
  assert.equal(imageInputOf('https://api.deepseek.com', 'deepseek-flash', false), false);
  assert.equal(imageInputOf('https://custom.example.test', 'custom-model', true), true);
});
