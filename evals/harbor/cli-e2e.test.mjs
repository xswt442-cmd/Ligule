import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const workspace = dirname(repository);
const tempParent = process.env.LIGULE_EVAL_E2E_TEMP_DIR ?? join(workspace, 'testplace', 'tmp');
const cliPath = process.env.LIGULE_CLI_E2E_PATH === undefined
  ? join(repository, 'tui', 'dist', 'cli.js')
  : resolve(process.env.LIGULE_CLI_E2E_PATH);
const corePackage = process.env.LIGULE_CLI_E2E_CORE_PACKAGE === undefined
  ? join(repository, 'core')
  : resolve(process.env.LIGULE_CLI_E2E_CORE_PACKAGE);
const helperSource = fileURLToPath(new URL('./export_session.mjs', import.meta.url));
const MOCK_CREDENTIAL = 'ligule-local-fixture-key';
const FILE_CONTENT = 'LIGULE_CLI_E2E_FILE_CREATED';

async function copyDependency(name, targetRoot, fromDirectory = corePackage) {
  const resolveFrom = (specifier) => createRequire(join(fromDirectory, 'package.json')).resolve(specifier);
  let source;
  try {
    source = dirname(resolveFrom(`${name}/package.json`));
  } catch {
    // 有的包用 exports 封住 ./package.json，就沿着入口文件向上找包根。
    let directory = dirname(resolveFrom(name));
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
    source = directory;
  }
  await cp(source, join(targetRoot, name), { recursive: true, dereference: true });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@ligule/')) continue;
    await copyDependency(dependency, join(targetRoot, name, 'node_modules'), source);
  }
}

async function installableHelper(root) {
  const packageRoot = join(root, 'node_modules', 'ligule');
  const coreRoot = join(packageRoot, 'node_modules', '@ligule', 'core');
  await mkdir(join(coreRoot, 'dist'), { recursive: true });
  await cp(join(corePackage, 'dist'), join(coreRoot, 'dist'), { recursive: true });
  await writeFile(join(coreRoot, 'package.json'), await readFile(join(corePackage, 'package.json')));
  // 这个 consumer 是手写的：pnpm 不提升依赖，所以 core 的运行时依赖要显式放到它自己的 node_modules 下。
  for (const dependency of ['proper-lockfile', 'smol-toml']) {
    await copyDependency(dependency, join(coreRoot, 'node_modules'));
  }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'ligule', version: '0.1.0' }));
  const helperPath = join(packageRoot, 'export_session.mjs');
  await writeFile(helperPath, await readFile(helperSource));
  // 导出器按同目录的 policy-mode.mjs 读取基准审批档位，手工 consumer 也需要它。
  await writeFile(join(packageRoot, 'policy-mode.mjs'), await readFile(fileURLToPath(new URL('./policy-mode.mjs', import.meta.url))));
  return import(pathToFileURL(helperPath).href);
}

async function mockMessagesProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages' || request.headers['x-api-key'] !== MOCK_CREDENTIAL) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch {
      response.writeHead(400).end();
      return;
    }
    requests.push(body);
    const toolResults = body.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result') : []);
    const createResult = toolResults.find((result) => result.tool_use_id === 'fixture-create');
    const execResult = toolResults.find((result) => result.tool_use_id === 'fixture-exec');
    let content;
    let stopReason;
    if (execResult !== undefined || (createResult !== undefined && createResult.is_error)) {
      content = [{ type: 'text', text: 'The requested local check is complete.' }];
      stopReason = 'end_turn';
    } else if (createResult !== undefined) {
      content = [{
        type: 'tool_use',
        id: 'fixture-exec',
        name: 'exec',
        input: { command: 'whoami' },
      }];
      stopReason = 'tool_use';
    } else {
      content = [{
        type: 'tool_use',
        id: 'fixture-create',
        name: 'create',
        input: { path: 'direct-result.txt', content: FILE_CONTENT },
      }];
      stopReason = 'tool_use';
    }
    const result = {
      id: 'fixture-message', type: 'message', role: 'assistant', model: 'fixture-model',
      content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 },
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function runCli(args, cwd, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    let timer;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid !== undefined) child.kill('SIGKILL');
        else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch { /* The child may have exited as the timeout fired. */ }
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function runArgs({ home, baseUrl, instruction, allowFullAccess }) {
  const config = [
    ['host.sessionDirectory', join(home, 'sessions')],
    ['model.api', 'messages'],
    ['model.baseURL', baseUrl],
    ['model.model', 'fixture-model'],
    ['model.apiKeyEnv', 'LIGULE_E2E_API_KEY'],
    ['model.capabilities.streaming', false],
    ['loop.modelCalls', 5],
    ['loop.totalModelCalls', 5],
    ['loop.taskTimeoutMs', 45_000],
    ['loop.requestTimeoutMs', 10_000],
    ['policy.mode', 'auto'],
  ];
  return [
    'run', '--json', ...(allowFullAccess ? ['--allow-full-access'] : []),
    ...config.flatMap(([key, value]) => ['--config', `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`]),
    instruction,
  ];
}

async function runFixture({ root, provider, allowFullAccess }) {
  const workspacePath = join(root, 'workspace');
  const home = join(root, 'ligule-home');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(home, { recursive: true });
  const env = Object.fromEntries([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]).concat([
    ['LIGULE_HOME', home], ['LIGULE_E2E_API_KEY', MOCK_CREDENTIAL],
  ]));
  const result = await runCli(runArgs({
    home,
    baseUrl: provider.baseUrl,
    instruction: 'Create direct-result.txt with the required marker, then run whoami.',
    allowFullAccess,
  }), workspacePath, env);
  assert.equal(result.code, 0, `CLI exited ${result.code ?? result.signal}: ${result.stderr}`);
  let machineResult;
  try { machineResult = JSON.parse(result.stdout.trim()); }
  catch { assert.fail(`CLI did not return machine JSON: ${result.stdout}\n${result.stderr}`); }
  assert.equal(machineResult.version, 1);
  assert.equal(typeof machineResult.sessionId, 'string');
  assert.equal(typeof machineResult.runId, 'string');
  const sessionDirectory = join(home, 'sessions');
  const sessionFiles = (await readdir(sessionDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(sessionFiles.length, 1);
  const events = (await readFile(join(sessionDirectory, sessionFiles[0]), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  const runUser = events.find((event) => event.kind === 'user' && event.run?.runId === machineResult.runId);
  assert.ok(runUser, 'the machine result runId must match the Session acceptance event');
  const terminal = events.find((event) => event.kind === 'turn' && event.userSeq === runUser.seq);
  assert.ok(terminal, 'the Session must contain a terminal event for the run');
  return { machineResult, events, terminal, workspacePath, home };
}

test('real run CLI enforces default read-only and exports a full-access mock-provider run', async (t) => {
  assert.ok(await access(cliPath).then(() => true, () => false), 'build the CLI before this test');
  assert.ok(await access(join(repository, 'core', 'dist', 'index.js')).then(() => true, () => false), 'build Core before this test');
  await access(tempParent);
  const testRoot = await mkdtemp(join(tempParent, 'ligule-cli-e2e-'));
  const resolvedRoot = await realpath(testRoot);
  const resolvedParent = await realpath(tempParent);
  const relativeRoot = relative(resolvedParent, resolvedRoot);
  assert.ok(relativeRoot !== '' && relativeRoot !== '..' && !relativeRoot.startsWith(`..${sep}`) && !isAbsolute(relativeRoot));
  const provider = await mockMessagesProvider();
  try {
    const defaultRun = await runFixture({ root: join(testRoot, 'read-only'), provider, allowFullAccess: false });
    assert.equal(defaultRun.terminal.status, 'completed');
    await assert.rejects(readFile(join(defaultRun.workspacePath, 'direct-result.txt')), { code: 'ENOENT' });
    const deniedCreate = defaultRun.events.find((event) => event.kind === 'tool' && event.tool === 'create');
    assert.ok(deniedCreate?.result?.failed);
    assert.equal(deniedCreate.result.code, 'permission_read_only');
    assert.equal(defaultRun.events.some((event) => event.kind === 'tool' && event.tool === 'exec'), false);

    const fullRun = await runFixture({ root: join(testRoot, 'full-access'), provider, allowFullAccess: true });
    assert.equal(fullRun.machineResult.status, 'completed');
    assert.equal(fullRun.machineResult.state, 'completed');
    assert.equal(fullRun.terminal.status, 'completed');
    assert.equal(await readFile(join(fullRun.workspacePath, 'direct-result.txt'), 'utf8'), FILE_CONTENT);
    const created = fullRun.events.find((event) => event.kind === 'tool' && event.tool === 'create');
    const executed = fullRun.events.find((event) => event.kind === 'tool' && event.tool === 'exec');
    assert.equal(created?.result?.failed, false);
    assert.equal(executed?.result?.failed, false);
    assert.match(String(executed?.result?.content), /\S/u);

    const helper = await installableHelper(join(testRoot, 'consumer'));
    const logsDirectory = join(testRoot, 'logs', 'agent');
    const trajectory = await helper.exportSession({
      homeDirectory: fullRun.home,
      sessionDirectory: join(fullRun.home, 'sessions'),
      sessionId: fullRun.machineResult.sessionId,
      runId: fullRun.machineResult.runId,
      agentVersion: JSON.parse(await readFile(join(repository, 'tui', 'package.json'), 'utf8')).version,
      modelName: 'fixture-model',
      logsDirectory,
      expectedState: 'completed',
    });
    const calls = trajectory.steps.flatMap((step) => step.tool_calls ?? []);
    assert.ok(calls.some((call) => call.function_name === 'create'));
    assert.ok(calls.some((call) => call.function_name === 'exec'));
    assert.equal(trajectory.steps.at(-1).extra.ligule.turn_status, 'completed');
    assert.equal(JSON.stringify(trajectory).includes(MOCK_CREDENTIAL), false);
    assert.ok(provider.requests.length >= 4);
  } finally {
    await provider.close();
    await rm(resolvedRoot, { recursive: true, force: true });
  }
});
