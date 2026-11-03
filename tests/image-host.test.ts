import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createMemoryConnectionPair, serveHost, sessionDirectory } from '../core/dist/index.js';
import { createConfigStore } from '../core/dist/kernel/config-store.js';
import { loadHostEnvironment } from '../core/dist/host/environment.js';
import { createMediaStore } from '../core/dist/capability/media.js';
import { listenFetchable } from './helpers/port.ts';
import { exportImageUrl } from '../core/dist/host/export.js';

const API_KEY_ENV = 'LIGULE_IMAGE_HOST_TEST_KEY';
const requireCore = createRequire(new URL('../core/package.json', import.meta.url));
const sharp = requireCore('sharp');
const { PDFDocument, StandardFonts } = requireCore('pdf-lib');

async function documentFixture(projectRoot) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 200]).drawText('Document host text', { font, size: 14, x: 20, y: 150 });
  await writeFile(join(projectRoot, 'document.pdf'), await pdf.save());
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function deadline(promise, label, within = 10_000) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), within);
  });
  try { return await Promise.race([promise, expired]); }
  finally { clearTimeout(timer); }
}

function textPlan(text) { return { kind: 'text', text }; }
function toolPlan(name, args) { return { kind: 'tool', name, args }; }

function sseFrames(plan) {
  const call = plan.kind === 'tool';
  const frames = [
    { choices: [{ index: 0, delta: call
      ? { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: plan.name, arguments: JSON.stringify(plan.args) } }] }
      : { content: plan.text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function providerEndpoint() {
  const requests = [];
  const plans = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = await readJson(request);
      requests.push(body);
      let plan = plans.shift();
      if (plan?.kind === 'hold') {
        plan.started.resolve(body);
        await plan.release.promise;
        plan = textPlan(plan.text);
      }
      if (plan === undefined) throw new Error('image_host_response_plan_missing');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sseFrames(plan));
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  const port = await listenFetchable(server);
  return {
    server,
    requests,
    failures,
    plans,
    baseURL: `http://127.0.0.1:${port}/v1`,
    enqueue(...items) { plans.push(...items); },
    holdText(text) {
      const started = deferred();
      const release = deferred();
      plans.push({ kind: 'hold', text, started, release });
      return { started: started.promise, release: release.resolve };
    },
  };
}

function imageUrls(body) {
  return body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((part) => part.type === 'image_url')
    .map((part) => part.image_url.url);
}

async function record(directory, sessionId) {
  const text = await readFile(join(directory, `${sessionId}.jsonl`), 'utf8');
  return text.trimEnd().split(/\r?\n/u).map((line) => JSON.parse(line));
}

async function withImageHost(run, { permissionControl = false, screenCaptureConsent = false, searchLayer, searchReference = API_KEY_ENV, searchCredentialValue } = {}) {
  const scratch = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'image-host-'));
  const projectRoot = join(root, 'project');
  const homeDirectory = join(root, 'home');
  const dataRoot = join(root, 'data');
  await Promise.all([projectRoot, homeDirectory, dataRoot, join(projectRoot, '.ligule')].map((path) => mkdir(path, { recursive: true })));

  const envKeys = ['HOME', 'USERPROFILE', 'LIGULE_HOME', API_KEY_ENV, ...(searchCredentialValue === undefined ? [] : [searchReference])];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = homeDirectory;
  process.env.USERPROFILE = homeDirectory;
  process.env.LIGULE_HOME = dataRoot;
  process.env[API_KEY_ENV] = 'isolated-local-test-key';
  if (searchCredentialValue !== undefined) process.env[searchReference] = searchCredentialValue;

  const endpoint = await providerEndpoint();
  let pair;
  let host;
  try {
    const searchConfig = '\n[search]\nprovider = "deepseek"\nserviceId = "official-search"\n';
    await writeFile(join(dataRoot, 'config.toml'), '[policy]\nmode = "auto"\n' + (searchLayer === 'user' ? searchConfig : ''), 'utf8');
    if (searchLayer === 'project') await writeFile(join(projectRoot, '.ligule', 'config.toml'), searchConfig, 'utf8');
    const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#4269ed' } }).png().toBuffer();
    await writeFile(join(projectRoot, 'sample.png'), png);

    const modesDirectory = fileURLToPath(new URL('../core/modes/', import.meta.url));
    const loaded = await loadHostEnvironment(projectRoot, modesDirectory);
    const { layers, ...environment } = loaded;
    const configStoreFor = (rootForStore, storeLayers) => createConfigStore({
      projectRoot: rootForStore,
      userHome: homeDirectory,
      layers: storeLayers,
    });
    const loadEnvironment = async (otherProject) => await loadHostEnvironment(otherProject, modesDirectory);
    pair = createMemoryConnectionPair();
    host = serveHost({
      ...pair.host,
      ...environment,
      configLayers: layers,
      configStoreFor,
      loadEnvironment,
      permissionControl,
      screenCaptureConsent,
    });
    const client = createConnection(pair.client);
    const projectInfo = { projectRoot };
    const initialServices = [{
      id: 'local-images',
      name: 'Local image protocol fixture',
      api: 'chat-completions',
      baseURL: endpoint.baseURL,
      apiKeyEnv: API_KEY_ENV,
      models: ['image-on', 'image-off', 'unknown-image'],
      modelSettings: [
        { id: 'image-on', imageInput: true },
        { id: 'image-off', imageInput: false },
      ],
    }];
    if (searchLayer !== undefined) initialServices.push({ id: 'official-search', name: 'Official search binding',
      api: 'chat-completions', baseURL: 'https://api.deepseek.com', apiKeyEnv: searchReference, models: ['deepseek-flash'] });
    const settings = await client.request('config.get', projectInfo);
    const userLayer = settings.layers.find((entry) => entry.layer === 'user');
    assert.ok(userLayer, 'the real Host config store exposes the user layer version');
    await client.request('config.set', {
      ...projectInfo,
      field: 'model.services',
      layer: 'user',
      version: userLayer.version,
      value: initialServices,
    });
    const sessionDirectoryPath = sessionDirectory(environment.config);
    return await run({
      client,
      host,
      config: environment.config,
      projectRoot,
      sessionDirectory: sessionDirectoryPath,
      endpoint,
      png,
      initialServices,
    });
  } finally {
    try {
      if (pair !== undefined) pair.client.output.end();
      if (host !== undefined) await host.release();
    } finally {
      try {
        if (endpoint.server.listening) {
          endpoint.server.closeAllConnections();
          await new Promise((resolve, reject) => endpoint.server.close((error) => error ? reject(error) : resolve()));
        }
      } finally {
        for (const key of envKeys) {
          const value = previousEnv.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

async function createSession(client, projectRoot, model = 'image-on') {
  const result = await client.request('session.create', {
    projectRoot,
    initialProvider: 'local-images',
    initialModel: model,
  });
  return result.sessionId;
}

async function setFullMode(client, sessionId) {
  await client.request('mode.set', { sessionId, name: 'full' });
}

test('real Host keeps read_image out of minimal and sends a decoded image through full mode', async () => {
  await withImageHost(async ({ client, config, projectRoot, sessionDirectory, endpoint, png }) => {
    const sessionId = await createSession(client, projectRoot);
    endpoint.enqueue(textPlan('minimal response'));
    await client.request('run.start', { sessionId, input: 'check minimal manifest' });
    assert.equal(endpoint.requests[0].tools.some((tool) => tool.function.name === 'read_image'), false);

    await setFullMode(client, sessionId);
    endpoint.enqueue(
      toolPlan('read_image', { path: 'sample.png' }),
      textPlan('the image was received'),
    );
    await client.request('run.start', { sessionId, input: 'inspect sample.png' });
    assert.equal(endpoint.requests[1].tools.some((tool) => tool.function.name === 'read_image'), true);
    const [imageUrl] = imageUrls(endpoint.requests[2]);
    assert.match(imageUrl, /^data:image\/png;base64,/u);

    const events = await record(sessionDirectory, sessionId);
    const readResult = events.find((event) => event.kind === 'tool' && event.tool === 'read_image');
    assert.equal(readResult.result.failed, false);
    assert.equal(readResult.result.images[0].sessionId, sessionId);
    const media = createMediaStore(config, sessionId);
    const stored = await media.read(readResult.result.images[0]);
    assert.deepEqual(Buffer.from(imageUrl.slice('data:image/png;base64,'.length), 'base64'), stored);
    assert.ok(stored.length > 0 && png.length > 0);
    const path = join(projectRoot, 'exports', 'review (image).md');
    const exported = await client.request('session.export', { sessionId, path });
    assert.deepEqual(exported.failed, []);
    const reference = readResult.result.images[0];
    const previewParams = { projectRoot, sessionId, imageId: reference.id };
    const preview = await client.request('session.image.preview', previewParams);
    assert.equal(preview.imageId, reference.id);
    assert.equal(preview.mimeType, 'image/webp');
    const previewBytes = Buffer.from(preview.base64, 'base64');
    const previewInfo = await sharp(previewBytes).metadata();
    assert.equal(previewInfo.format, 'webp');
    assert.equal(previewInfo.width, preview.width);
    assert.equal(previewInfo.height, preview.height);
    assert.ok(preview.width <= 512 && preview.height <= 512 && previewBytes.length <= 256 * 1024);
    const otherProject = join(projectRoot, 'other-workspace');
    await mkdir(otherProject);
    await assert.rejects(client.request('session.image.preview', { ...previewParams, projectRoot: otherProject }), { code: 'image_owner_mismatch' });
    const branch = await client.request('session.branch', { sessionId });
    assert.deepEqual(await client.request('session.image.preview', { ...previewParams, sessionId: branch.sessionId }), preview);
    const unrecorded = await media.put(png, 'file');
    await assert.rejects(client.request('session.image.preview', { ...previewParams, imageId: unrecorded.id }), { code: 'image_not_in_session' });
    const otherSession = await createSession(client, projectRoot);
    await assert.rejects(client.request('session.image.preview', { ...previewParams, sessionId: otherSession }), { code: 'image_not_in_session' });
    await assert.rejects(client.request('session.image.preview', { ...previewParams, imageId: '../sample.png' }), { code: 'protocol_args_invalid' });
    const beforePreview = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8');
    await client.request('session.close', { sessionId });
    assert.deepEqual(await client.request('session.image.preview', previewParams), preview);
    assert.equal(await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8'), beforePreview);
    await client.request('session.open', { projectRoot, sessionId });
    const asset = join(projectRoot, 'exports', 'review (image).assets', `${reference.id}.png`);
    assert.ok(exported.written.includes(asset));
    assert.deepEqual(await readFile(asset), stored);
    assert.ok((await readFile(path, 'utf8')).includes(`](${exportImageUrl(path, reference.id)})`));
    await unlink(join(media.directory, `${reference.id}.png`));
    await assert.rejects(client.request('session.image.preview', previewParams), { code: 'image_missing' });
    const missingPath = join(projectRoot, 'exports', 'missing-image.md');
    const missing = await client.request('session.export', { sessionId, path: missingPath });
    assert.equal(missing.failed.some(item => item.code === 'image_missing'), true);
    assert.ok((await readFile(missingPath, 'utf8')).includes('图片文件未随导出包含'));
    assert.equal(endpoint.failures.length, 0);
    assert.equal(endpoint.plans.length, 0);
  }, { permissionControl: true });
});

test('real Host exposes read_document only in full, projects text and sends rendered PDF pages as persistent images', async () => {
  await withImageHost(async ({ client, config, projectRoot, sessionDirectory, endpoint }) => {
    await documentFixture(projectRoot);
    const sessionId = await createSession(client, projectRoot);
    endpoint.enqueue(textPlan('minimal document check'));
    await client.request('run.start', { sessionId, input: 'minimal tools' });
    assert.equal(endpoint.requests[0].tools.some(tool => tool.function.name === 'read_document'), false);
    await setFullMode(client, sessionId);
    endpoint.enqueue(toolPlan('read_document', { path: 'document.pdf', count: 1 }), textPlan('text received'));
    await client.request('run.start', { sessionId, input: 'read document text' });
    assert.equal(endpoint.requests[1].tools.some(tool => tool.function.name === 'read_document'), true);
    const textResult = (await record(sessionDirectory, sessionId)).find(event => event.kind === 'tool' && event.tool === 'read_document');
    assert.match(JSON.parse(textResult.result.content).chunks[0].text, /Document host text/u);
    assert.equal(textResult.result.images, undefined);
    endpoint.enqueue(toolPlan('read_document', { path: 'document.pdf', renderPage: 1 }), textPlan('rendered page received'));
    await client.request('run.start', { sessionId, input: 'render document page' });
    const rendered = (await record(sessionDirectory, sessionId)).filter(event => event.kind === 'tool' && event.tool === 'read_document').at(-1);
    assert.equal(rendered.result.failed, false);
    const reference = rendered.result.images[0];
    assert.equal(reference.source, 'document');
    assert.equal(reference.sessionId, sessionId);
    const image = await createMediaStore(config, sessionId).read(reference);
    assert.deepEqual(Buffer.from(imageUrls(endpoint.requests.at(-1))[0].split(',')[1], 'base64'), image);
    const preview = await client.request('session.image.preview', { projectRoot, sessionId, imageId: reference.id });
    assert.equal((await sharp(Buffer.from(preview.base64, 'base64')).metadata()).format, 'webp');
    assert.equal((await client.request('status.get', { sessionId })).screenCapture.enabled, false);
    const noImages = await createSession(client, projectRoot, 'image-off');
    await setFullMode(client, noImages);
    endpoint.enqueue(toolPlan('read_document', { path: 'missing.pdf', renderPage: 1 }), textPlan('rendering refused'));
    await client.request('run.start', { sessionId: noImages, input: 'attempt image without capability' });
    const refused = (await record(sessionDirectory, noImages)).find(event => event.kind === 'tool' && event.tool === 'read_document');
    assert.equal(refused.result.code, 'model_image_input_unsupported');
    endpoint.enqueue(toolPlan('read_document', { path: 'document.pdf' }), textPlan('text without image support'));
    await client.request('run.start', { sessionId: noImages, input: 'read text without image support' });
    assert.equal((await record(sessionDirectory, noImages)).filter(event => event.kind === 'tool' && event.tool === 'read_document').at(-1).result.failed, false);
  });
});

test('internal subagent document rendering remains within its inherited tool ceiling and owns its image', async () => {
  await withImageHost(async ({ client, config, projectRoot, sessionDirectory, endpoint }) => {
    await documentFixture(projectRoot);
    const sessionId = await createSession(client, projectRoot);
    await setFullMode(client, sessionId);
    endpoint.enqueue(toolPlan('subagent', { task: 'Render document.pdf page 1' }),
      toolPlan('read_document', { path: 'document.pdf', renderPage: 1 }), textPlan('child saw page'), textPlan('parent received result'));
    await client.request('run.start', { sessionId, input: 'delegate page rendering' });
    assert.equal(endpoint.requests[1].tools.some(tool => tool.function.name === 'read_document'), true);
    const childName = (await readdir(sessionDirectory)).find(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
    const childId = childName.slice(0, -'.jsonl'.length);
    const result = (await record(sessionDirectory, childId)).find(event => event.kind === 'tool' && event.tool === 'read_document');
    assert.equal(result.result.failed, false);
    assert.equal(result.result.images[0].sessionId, childId);
    assert.equal(result.result.images[0].source, 'document');
    await assert.rejects(createMediaStore(config, sessionId).read(result.result.images[0]), { code: 'image_owner_mismatch' });
    assert.ok(imageUrls(endpoint.requests[2]).length > 0);
  });
});

test('configured search uses the full manifest, rejects invalid queries, and remains subject to network permission', async () => {
  await withImageHost(async ({ client, projectRoot, sessionDirectory, endpoint }) => {
    const sessionId = await createSession(client, projectRoot);
    assert.deepEqual((await client.request('status.get', { sessionId })).search,
      { configured: true, available: true, serviceId: 'official-search' });
    endpoint.enqueue(textPlan('minimal search check'));
    await client.request('run.start', { sessionId, input: 'minimal manifest' });
    assert.equal(endpoint.requests[0].tools.some(tool => tool.function.name === 'web_search'), false);
    await setFullMode(client, sessionId);
    endpoint.enqueue(toolPlan('web_search', { query: '   ' }), textPlan('invalid query rejected'));
    await client.request('run.start', { sessionId, input: 'check whitespace validation only' });
    assert.equal(endpoint.requests[1].tools.some(tool => tool.function.name === 'web_search'), true);
    assert.equal((await record(sessionDirectory, sessionId)).find(event => event.kind === 'tool' && event.tool === 'web_search').result.code, 'search_query_invalid');
    await client.request('permission.set', { sessionId, permissionProfile: 'read-only', permissionNetwork: 'disabled' });
    endpoint.enqueue(toolPlan('web_search', { query: 'permission gate check' }), textPlan('network permission rejected'));
    await client.request('run.start', { sessionId, input: 'check permission before any service request' });
    assert.equal(endpoint.requests.at(-2).tools.some(tool => tool.function.name === 'web_search'), false);
    const refused = (await record(sessionDirectory, sessionId)).filter(event => event.kind === 'tool' && event.tool === 'web_search').at(-1);
    assert.equal(refused.result.failed, true);
    assert.match(refused.result.code, /^permission_/u);
    assert.equal(JSON.stringify(await record(sessionDirectory, sessionId)).includes('isolated-local-test-key'), false);
  }, { searchLayer: 'user', permissionControl: true });
});

test('a project cannot enable search with a user service credential', async () => {
  await withImageHost(async ({ client, projectRoot, endpoint }) => {
    const sessionId = await createSession(client, projectRoot);
    await setFullMode(client, sessionId);
    assert.deepEqual((await client.request('status.get', { sessionId })).search,
      { configured: false, available: false, code: 'search_not_configured' });
    endpoint.enqueue(textPlan('project-only search is absent'));
    await client.request('run.start', { sessionId, input: 'show available tools' });
    assert.equal(endpoint.requests[0].tools.some(tool => tool.function.name === 'web_search'), false);
  }, { searchLayer: 'project' });
});

test('a configured service without a credential does not register a failing search tool', async () => {
  await withImageHost(async ({ client, projectRoot, endpoint }) => {
    const sessionId = await createSession(client, projectRoot);
    await setFullMode(client, sessionId);
    const status = (await client.request('status.get', { sessionId })).search;
    assert.equal(status.configured, true);
    assert.equal(status.available, false);
    assert.ok(['search_credential_missing', 'credential_store_unavailable'].includes(status.code));
    endpoint.enqueue(textPlan('search requires a configured credential'));
    await client.request('run.start', { sessionId, input: 'show available tools' });
    assert.equal(endpoint.requests[0].tools.some(tool => tool.function.name === 'web_search'), false);
  }, { searchLayer: 'user', searchReference: `LIGULE_MISSING_SEARCH_${randomUUID().replaceAll('-', '').toUpperCase()}` });
});

test('a malformed credential is diagnosed before advertising a search tool', async () => {
  await withImageHost(async ({ client, projectRoot, endpoint }) => {
    const sessionId = await createSession(client, projectRoot);
    await setFullMode(client, sessionId);
    const status = (await client.request('status.get', { sessionId })).search;
    assert.equal(status.available, false);
    assert.equal(status.code, 'search_credential_invalid');
    endpoint.enqueue(textPlan('invalid search credential is unavailable'));
    await client.request('run.start', { sessionId, input: 'show available tools' });
    assert.equal(endpoint.requests[0].tools.some(tool => tool.function.name === 'web_search'), false);
  }, { searchLayer: 'user', searchReference: 'LIGULE_BAD_SEARCH_HEADER', searchCredentialValue: 'invalid header key' });
});

test('screenshot remains unauthorized for an ordinary controller even with an image model and full tool mode', async () => {
  await withImageHost(async ({ client, projectRoot, sessionDirectory, endpoint }) => {
    const sessionId = await createSession(client, projectRoot);
    await setFullMode(client, sessionId);
    await assert.rejects(client.request('screen-capture.set', { sessionId, enabled: true, confirmScreenCapture: true }), { code: 'screen_capture_control_unavailable' });
    endpoint.enqueue(toolPlan('screenshot', {}), textPlan('screen permission is required'));
    await client.request('run.start', { sessionId, input: 'check screen permission only' });
    const result = (await record(sessionDirectory, sessionId)).find(event => event.kind === 'tool' && event.tool === 'screenshot');
    assert.equal(result.result.code, 'screen_capture_not_authorized');
    assert.equal(result.result.images, undefined);
    assert.deepEqual((await client.request('status.get', { sessionId })).screenCapture, { enabled: false, source: 'none', changeAllowed: false });
  });
});

test('trusted screen consent needs confirmation, can be revoked, and is not restored from old Session events', async () => {
  await withImageHost(async ({ client, projectRoot, sessionDirectory }) => {
    const sessionId = await createSession(client, projectRoot);
    await assert.rejects(client.request('screen-capture.set', { sessionId, enabled: true }), { code: 'screen_capture_confirmation_required' });
    assert.equal((await client.request('screen-capture.set', { sessionId, enabled: true, confirmScreenCapture: true })).enabled, true);
    assert.equal((await client.request('status.get', { sessionId })).screenCapture.enabled, true);
    assert.equal((await client.request('screen-capture.set', { sessionId, enabled: false })).enabled, false);
    await client.request('screen-capture.set', { sessionId, enabled: true, confirmScreenCapture: true });
    await client.request('session.close', { sessionId });
    await client.request('session.open', { projectRoot, sessionId });
    assert.deepEqual((await client.request('status.get', { sessionId })).screenCapture, { enabled: false, source: 'none', changeAllowed: true });
    const audit = (await record(sessionDirectory, sessionId)).filter(event => event.kind === 'screenCapture');
    assert.deepEqual(audit.map(event => event.enabled), [true, false, true]);
    assert.ok(audit.every(event => event.ignorable === true && event.source === 'trusted-ui'));
  }, { permissionControl: true });
});

test('revocation during a pending screen consent update wins over the late enable', async () => {
  await withImageHost(async ({ client, projectRoot }) => {
    const sessionId = await createSession(client, projectRoot);
    const enable = client.request('screen-capture.set', { sessionId, enabled: true, confirmScreenCapture: true });
    const revoke = client.request('screen-capture.set', { sessionId, enabled: false });
    const results = await Promise.allSettled([enable, revoke]);
    assert.equal(results[1].status, 'fulfilled');
    const status = await client.request('status.get', { sessionId });
    assert.equal(status.screenCapture.enabled, false);
    assert.equal(status.screenCapture.source, 'none');
  }, { permissionControl: true });
});

test('Host shutdown drains a concurrent revocation without reopening the retired Session writer', async () => {
  await withImageHost(async ({ client, host, projectRoot, sessionDirectory }) => {
    const sessionId = await createSession(client, projectRoot);
    const revoke = client.request('screen-capture.set', { sessionId, enabled: false });
    await Promise.allSettled([revoke, host.release()]);
    assert.equal((await readdir(sessionDirectory)).filter(name => name.endsWith('.lock')).length, 0);
  }, { permissionControl: true });
});

test('explicit process startup consent is recorded without starting a capture', async () => {
  await withImageHost(async ({ client, projectRoot, sessionDirectory, endpoint }) => {
    const sessionId = await createSession(client, projectRoot);
    assert.deepEqual((await client.request('status.get', { sessionId })).screenCapture, { enabled: true, source: 'startup', changeAllowed: false });
    assert.equal((await record(sessionDirectory, sessionId)).some(event => event.kind === 'screenCapture' && event.enabled === true && event.source === 'startup'), true);
    assert.equal(endpoint.requests.length, 0);
  }, { screenCaptureConsent: true });
});

test('an undeclared model image capability rejects read_image before sending image content', async () => {
  await withImageHost(async ({ client, projectRoot, sessionDirectory, endpoint }) => {
    const sessionId = await createSession(client, projectRoot, 'unknown-image');
    await setFullMode(client, sessionId);
    endpoint.enqueue(
      toolPlan('read_image', { path: 'sample.png' }),
      textPlan('the refusal was received'),
    );
    await client.request('run.start', { sessionId, input: 'try the unknown vision model' });

    assert.equal(endpoint.requests[0].tools.some((tool) => tool.function.name === 'read_image'), true,
      'full mode exposes the tool independently of model capability');
    assert.equal(endpoint.requests.flatMap(imageUrls).length, 0, 'no image data is sent to an undeclared model');
    const events = await record(sessionDirectory, sessionId);
    const result = events.find((event) => event.kind === 'tool' && event.tool === 'read_image');
    assert.equal(result.result.failed, true);
    assert.equal(result.result.code, 'model_image_input_unsupported');
    assert.equal(endpoint.failures.length, 0);
  });
});

test('read_image in an internal subagent stores and resolves its image under the child Session', async () => {
  await withImageHost(async ({ client, config, projectRoot, sessionDirectory, endpoint }) => {
    const sessionId = await createSession(client, projectRoot);
    await setFullMode(client, sessionId);
    endpoint.enqueue(
      toolPlan('subagent', { task: 'Inspect sample.png with read_image' }),
      toolPlan('read_image', { path: 'sample.png' }),
      textPlan('the child saw the image'),
      textPlan('the parent received the child result'),
    );
    await client.request('run.start', { sessionId, input: 'delegate image inspection' });

    assert.equal(endpoint.requests[0].tools.some((tool) => tool.function.name === 'subagent'), true);
    assert.equal(endpoint.requests[1].tools.some((tool) => tool.function.name === 'read_image'), true);
    assert.equal(endpoint.requests[1].tools.some((tool) => tool.function.name === 'subagent'), false,
      'the child uses its inherited tool ceiling and cannot create a recursive child');
    assert.ok(imageUrls(endpoint.requests[2]).some((url) => url.startsWith('data:image/png;base64,')));

    const names = await readdir(sessionDirectory);
    const childName = names.find((name) => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
    assert.ok(childName, 'the internal child has a real Session record');
    const childId = childName.slice(0, -'.jsonl'.length);
    const childEvents = await record(sessionDirectory, childId);
    const childResult = childEvents.find((event) => event.kind === 'tool' && event.tool === 'read_image');
    assert.equal(childResult.result.failed, false);
    const reference = childResult.result.images[0];
    assert.equal(reference.sessionId, childId);
    assert.ok(childEvents.some((event) => event.kind === 'image' && event.callId === childResult.callId));

    const childMedia = createMediaStore(config, childId);
    const stored = await childMedia.read(reference);
    assert.ok(stored.length > 0);
    await assert.rejects(createMediaStore(config, sessionId).read(reference), { code: 'image_owner_mismatch' });
    assert.equal((await record(sessionDirectory, sessionId)).some((event) => event.kind === 'image'), false,
      'the parent record does not claim the child image');
    assert.equal(endpoint.failures.length, 0);
  });
});

test('a modelSettings.imageInput-only configStore write refreshes an explicit Session after its active turn', async () => {
  await withImageHost(async ({ client, projectRoot, sessionDirectory, endpoint }) => {
    const sessionId = await createSession(client, projectRoot, 'image-on');
    await setFullMode(client, sessionId);
    const held = endpoint.holdText('the held turn completed');
    const running = client.request('run.start', { sessionId, input: 'wait for this local model response' })
      .then((result) => ({ result }), (error) => ({ error }));
    await deadline(held.started, 'receive the held local model request');

    try {
      const current = await client.request('config.get', { projectRoot });
      const userLayer = current.layers.find((entry) => entry.layer === 'user');
      const services = current.services.map((service) => service.id !== 'local-images' ? service : ({
        ...service,
        modelSettings: service.modelSettings.map((setting) => setting.id === 'image-on'
          ? { ...setting, imageInput: false }
          : setting),
      }));
      const saved = await client.request('config.set', {
        projectRoot,
        field: 'model.services',
        layer: 'user',
        version: userLayer.version,
        value: services,
      });
      assert.equal(saved.changed, true);
      assert.ok(saved.applies.some((entry) => entry.sessionId === sessionId && entry.when === 'round'),
        'an explicit Session adopts the capability change at the round boundary');
    } finally { held.release(); }

    const outcome = await deadline(running, 'finish the held model request');
    assert.equal(outcome.error, undefined);
    endpoint.enqueue(toolPlan('read_image', { path: 'sample.png' }), textPlan('the model received the refusal'));
    await client.request('run.start', { sessionId, input: 'read the image after the capability change' });
    assert.equal(endpoint.requests.at(-2).tools.some((tool) => tool.function.name === 'read_image'), true);
    assert.equal(imageUrls(endpoint.requests.at(-1)).length, 0, 'the refreshed provider does not receive image bytes');
    const events = await record(sessionDirectory, sessionId);
    assert.equal(events.filter((event) => event.kind === 'tool' && event.tool === 'read_image').at(-1).result.code,
      'model_image_input_unsupported');
    assert.equal(endpoint.failures.length, 0);
  });
});
