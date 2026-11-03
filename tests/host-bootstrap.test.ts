import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from '../core/dist/host/connection.js';
import { loadHostEnvironment } from '../core/dist/host/environment.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repository, 'tui', 'dist', 'cli.js');
const desktopEntry = join(repository, 'core', 'dist', 'host', 'desktop-entry.js');

test('project config cannot choose executable search backends while user and flag choices remain available', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'search-source-'));
  const project = join(root, 'project');
  const data = join(root, 'data');
  await mkdir(join(project, '.ligule'), { recursive: true });
  await mkdir(data);
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = data;
  const modes = join(repository, 'core', 'modes');
  try {
    for (const name of ['config.toml', 'config.local.toml']) {
      const path = join(project, '.ligule', name);
      await writeFile(path, `ripgrepPath = ${JSON.stringify(process.execPath)}\n`);
      await assert.rejects(loadHostEnvironment(project, modes), { code: 'search_backend_source_untrusted' });
      await rm(path);
    }
    await writeFile(join(data, 'config.toml'), `ripgrepPath = ${JSON.stringify(process.execPath)}\n`);
    assert.equal((await loadHostEnvironment(project, modes)).config.ripgrepPath, process.execPath);
    const flags = ['ripgrepPath="explicit-backend"'];
    assert.equal((await loadHostEnvironment(project, modes, flags)).config.ripgrepPath, 'explicit-backend');
  } finally {
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

function deadline(pending, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 10_000);
  });
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
}

// A host finishes sandbox and permission probing before it answers the first request. On Windows
// that costs seconds to tens of seconds depending on the workspace size (measured here: about
// 6.4s for a small workspace, about 25s for this repository). The readiness phase gets its own
// allowance while every protocol request after it keeps the 10s deadline, which tells "the host
// never started" apart from "the request is slow" without enlarging the product timeout.
const STARTUP_READY_MS = 60_000;

async function ready(client, label = 'Host') {
  const limit = Date.now() + STARTUP_READY_MS;
  for (;;) {
    const answered = await Promise.race([
      client.request('prefs.read', {}).then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (answered) return;
    if (Date.now() > limit) throw new Error(`${label} did not answer within ${STARTUP_READY_MS}ms`);
  }
}

function startDesktop(projectRoot, dataRoot) {
  const child = spawn(process.execPath, [desktopEntry], {
    cwd: projectRoot,
    env: { ...process.env, LIGULE_HOME: dataRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stderr.resume();
  const client = createConnection({ input: child.stdout, output: child.stdin });
  return {
    child,
    client,
    async stop() {
      child.stdin.end();
      try { await deadline(exited, 'release DesktopEntry Host'); }
      finally { if (child.exitCode === null) child.kill(); }
    },
  };
}

test('a real unconfigured host opens another workspace while settings remain available', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'host-bootstrap-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const data = join(root, 'data');
  await Promise.all([first, second, data].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(data, 'config.toml'), '[policy]\nmode = "ask"\n', 'utf8');
  const child = spawn(process.execPath, [cli, 'host'], {
    cwd: first,
    env: { ...process.env, LIGULE_HOME: data, LIGULE_BOOTSTRAP_KEY: 'bootstrap-environment-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const client = createConnection({ input: child.stdout, output: child.stdin });
  child.stderr.resume();
  try {
    await ready(client);
    assert.deepEqual(await deadline(client.request('prefs.read', {}), 'read preferences'), { settings: {}, version: '' });
    const opened = await deadline(client.request('session.create', { projectRoot: second }), 'open unconfigured workspace');
    const status = await deadline(client.request('status.get', { sessionId: opened.sessionId }), 'read session status');
    assert.equal(status.running, false);
    assert.equal(status.model, null);
    const shown = await deadline(client.request('config.get', { projectRoot: second }), 'read model settings');
    assert.deepEqual(shown.model, {});
    assert.deepEqual(await client.request('credentials.status', { reference: 'LIGULE_BOOTSTRAP_KEY' }), { reference: 'LIGULE_BOOTSTRAP_KEY', source: 'environment', configured: true });
    await assert.rejects(client.request('credentials.set', { reference: 'LIGULE_BOOTSTRAP_KEY', value: 'replacement' }), (error) => error.code === 'credential_environment_override');
    await assert.rejects(client.request('credentials.delete', { reference: 'LIGULE_BOOTSTRAP_KEY' }), (error) => error.code === 'credential_environment_override');
    const record = await client.request('session.read', { sessionId: opened.sessionId });
    assert.equal(JSON.stringify({ shown, record }).includes('bootstrap-environment-key'), false);
    await assert.rejects(client.request('run.start', { sessionId: opened.sessionId, input: 'an actual unconfigured run' }), error => error.code === 'host_model_config_missing');
    const failed = await client.request('session.read', { sessionId: opened.sessionId });
    const turns = failed.events.filter(event => event.kind === 'turn');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].status, 'failed');
    assert.equal(turns[0].code, 'host_model_config_missing');
    assert.equal(turns[0].userSeq, failed.events.find(event => event.kind === 'user').seq);
    let catalog = await client.request('config.get', { projectRoot: second });
    const services = [
      { id: 'alpha', name: 'Alpha', api: 'messages', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'LIGULE_BOOTSTRAP_KEY', models: ['alpha-1'] },
      { id: 'beta', name: 'Beta', api: 'chat-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'LIGULE_BOOTSTRAP_KEY', models: ['beta-1', 'beta-2'] },
    ];
    await client.request('config.set', { projectRoot: second, field: 'model.services', layer: 'user', version: catalog.layers.find(layer => layer.layer === 'user').version, value: services });
    assert.equal((await client.request('status.get', { sessionId: opened.sessionId })).model, 'alpha-1');
    assert.equal((await client.request('model.select', { sessionId: opened.sessionId, provider: 'beta', model: 'beta-2' })).when, 'now');
    const peer = await client.request('session.create', { projectRoot: second });
    assert.equal((await client.request('status.get', { sessionId: peer.sessionId })).model, 'alpha-1');
    catalog = await client.request('config.get', { projectRoot: second });
    await client.request('config.set', { projectRoot: second, field: 'model.selection', layer: 'user', version: catalog.layers.find(layer => layer.layer === 'user').version, value: { provider: 'alpha', model: 'alpha-1' } });
    assert.equal((await client.request('status.get', { sessionId: opened.sessionId })).model, 'beta-2', '保存默认选择不切换已单独选择的会话');
    await client.request('session.close', { sessionId: opened.sessionId });
    await client.request('session.open', { sessionId: opened.sessionId, projectRoot: second });
    const restored = await client.request('status.get', { sessionId: opened.sessionId });
    assert.equal(restored.model, 'beta-2');
    assert.equal(restored.serviceId, 'beta');
    await assert.rejects(client.request('model.select', { sessionId: opened.sessionId, provider: 'alpha', model: 'unknown' }), error => error.code === 'model_not_available');
    let signalStarted;
    const began = new Promise(resolve => { signalStarted = resolve; });
    client.onNotification(message => {
      if (message.sessionId === opened.sessionId && message.event?.kind === 'user') signalStarted();
    });
    const running = client.request('run.start', { sessionId: opened.sessionId, input: 'cancel a real connection attempt' }).then(result => ({ result }), error => ({ error }));
    await deadline(began, 'observe the round input');
    const selection = await client.request('model.select', { sessionId: opened.sessionId, provider: 'alpha', model: 'alpha-1' });
    assert.equal(selection.when, 'round');
    const during = await client.request('status.get', { sessionId: opened.sessionId });
    assert.equal(during.model, 'beta-2');
    assert.equal(during.pendingModel, 'alpha-1');
    await client.request('run.cancel', { sessionId: opened.sessionId });
    const outcome = await deadline(running, 'cancel the actual model transport');
    assert.equal(outcome.error?.code, 'provider_cancelled');
    const cancelled = await client.request('session.read', { sessionId: opened.sessionId });
    assert.equal(cancelled.events.filter(event => event.kind === 'turn').at(-1).status, 'cancelled');
    assert.equal(cancelled.events.filter(event => event.kind === 'turnContext').at(-1).model, 'beta-2');
    assert.equal((await client.request('status.get', { sessionId: opened.sessionId })).model, 'alpha-1');
    await client.request('session.close', { sessionId: peer.sessionId });
    const saved = await deadline(client.request('prefs.write', { json: '{"palette":"forest"}', version: '' }), 'save preferences');
    assert.deepEqual(saved.settings, { palette: 'forest' });
    assert.notEqual(saved.version, '');
    assert.deepEqual(JSON.parse(await readFile(join(data, 'desktop.json'), 'utf8')), saved.settings);
    await deadline(client.request('session.close', { sessionId: opened.sessionId }), 'close session');
    child.stdin.end();
    assert.equal(await deadline(exited, 'stop host'), 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await deadline(exited, 'clean host');
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace history and local configuration keep their identity when the permission boundary differs', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'workspace-boundary-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const data = join(root, 'data');
  await Promise.all([first, second].map(path => mkdir(join(path, '.ligule'), { recursive: true })));
  await mkdir(data);
  await writeFile(join(data, 'config.toml'), `boundary = ${JSON.stringify(root)}\n`, 'utf8');
  for (const [path, name] of [[first, 'first-model'], [second, 'second-model']]) {
    await writeFile(join(path, '.ligule', 'config.local.toml'), `[model]\napi = "chat-completions"\nbaseURL = "http://127.0.0.1:1"\nmodel = "${name}"\n`, 'utf8');
  }
  const start = (flags = []) => {
    const child = spawn(process.execPath, [cli, 'host', ...flags], { cwd: first, env: { ...process.env, LIGULE_HOME: data }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    child.stderr.resume();
    const client = createConnection({ input: child.stdout, output: child.stdin });
    return { client, stop: async () => { child.stdin.end(); try { await deadline(exited, 'release workspace host'); } finally { if (child.exitCode === null) child.kill(); } } };
  };
  let host = start();
  try {
    await ready(host.client);
    const a = await deadline(host.client.request('session.create', {}), 'create first workspace session');
    const b = await host.client.request('session.create', { projectRoot: second });
    assert.equal((await host.client.request('session.read', { sessionId: a.sessionId })).header.projectRoot, first);
    assert.equal((await host.client.request('session.read', { sessionId: b.sessionId })).header.projectRoot, second);
    assert.deepEqual((await host.client.request('sessions.list', { projectRoot: first })).sessions.map(item => item.id), [a.sessionId]);
    assert.deepEqual((await host.client.request('sessions.list', { projectRoot: second })).sessions.map(item => item.id), [b.sessionId]);
    const settings = await host.client.request('config.get', {});
    await host.client.request('config.set', { field: 'model.model', value: 'saved-for-first', layer: 'projectLocal', version: settings.layers.find(layer => layer.layer === 'projectLocal').version });
    assert.match(await readFile(join(first, '.ligule', 'config.local.toml'), 'utf8'), /saved-for-first/);
    assert.doesNotMatch(await readFile(join(second, '.ligule', 'config.local.toml'), 'utf8'), /saved-for-first/);
    await host.stop();
    host = start(['--config', `boundary = ${JSON.stringify(second)}`]);
    await ready(host.client);
    const listed = await deadline(host.client.request('sessions.list', {}), 'list after a permission change');
    assert.deepEqual(listed.sessions.map(item => item.id), [a.sessionId]);
    await host.client.request('session.open', { sessionId: a.sessionId });
    assert.equal((await host.client.request('status.get', { sessionId: a.sessionId })).model, 'saved-for-first');
    assert.equal((await host.client.request('session.read', { sessionId: a.sessionId })).header.projectRoot, first);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('DesktopEntry keeps workspace identity separate from a shared permission boundary', async () => {
  const scratch = join(repository, 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'desktop-workspace-boundary-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const boundary = join(root, 'boundary');
  const data = join(root, 'data');
  await Promise.all([first, second, boundary, data].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(data, 'config.toml'), `boundary = ${JSON.stringify(boundary)}\n`, 'utf8');
  let host = startDesktop(first, data);
  try {
    await ready(host.client);
    const a = await deadline(host.client.request('session.create', {}), 'create DesktopEntry first workspace session');
    const aRecord = await deadline(host.client.request('session.read', { sessionId: a.sessionId }), 'read DesktopEntry first session');
    assert.equal(aRecord.header.projectRoot, first, 'the first session header follows DesktopEntry cwd, not the permission boundary');

    const b = await deadline(host.client.request('session.create', { projectRoot: second }), 'create DesktopEntry second workspace session');
    const bRecord = await deadline(host.client.request('session.read', { sessionId: b.sessionId }), 'read DesktopEntry second session');
    assert.equal(bRecord.header.projectRoot, second);
    assert.deepEqual((await host.client.request('sessions.list', { projectRoot: first })).sessions.map((item) => item.id), [a.sessionId]);
    assert.deepEqual((await host.client.request('sessions.list', { projectRoot: second })).sessions.map((item) => item.id), [b.sessionId]);

    for (const projectRoot of [first, second]) {
      const shown = await host.client.request('config.get', { projectRoot });
      const projectLayer = shown.layers.find((layer) => layer.layer === 'projectLocal');
      await host.client.request('config.set', {
        projectRoot, field: 'policy.mode', value: 'never', layer: 'projectLocal', version: projectLayer.version,
      });
      const localConfig = await readFile(join(projectRoot, '.ligule', 'config.local.toml'), 'utf8');
      assert.match(localConfig, /\[policy\]/);
      assert.match(localConfig, /mode = "never"/);
    }
    assert.equal((await host.client.request('config.get', { projectRoot: first })).policyMode, 'never');
    assert.equal((await host.client.request('config.get', { projectRoot: second })).policyMode, 'never');
    await assert.rejects(readFile(join(boundary, '.ligule', 'config.local.toml')), (error) => error.code === 'ENOENT');
    await host.stop();

    host = startDesktop(first, data);
    await ready(host.client);
    const listedFirst = await deadline(host.client.request('sessions.list', {}), 'list default DesktopEntry workspace after restart');
    assert.deepEqual(listedFirst.sessions.map((item) => item.id), [a.sessionId]);
    const listedSecond = await host.client.request('sessions.list', { projectRoot: second });
    assert.deepEqual(listedSecond.sessions.map((item) => item.id), [b.sessionId]);
    await host.client.request('session.open', { sessionId: a.sessionId });
    await host.client.request('session.open', { sessionId: b.sessionId, projectRoot: second });
    assert.equal((await host.client.request('session.read', { sessionId: a.sessionId })).header.projectRoot, first);
    assert.equal((await host.client.request('session.read', { sessionId: b.sessionId })).header.projectRoot, second);
    assert.equal((await host.client.request('config.get', { projectRoot: first })).policyMode, 'never');
    assert.equal((await host.client.request('config.get', { projectRoot: second })).policyMode, 'never');
    assert.match(await readFile(join(first, '.ligule', 'config.local.toml'), 'utf8'), /mode = "never"/);
    assert.match(await readFile(join(second, '.ligule', 'config.local.toml'), 'utf8'), /mode = "never"/);
    await host.stop();
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
