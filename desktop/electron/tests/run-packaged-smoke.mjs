import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { finished } from 'node:stream/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sessionDirectory } from '../../../core/dist/session/list.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = dirname(dirname(scriptDirectory));
const repositoryRoot = dirname(desktopDirectory);
const optionValue = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name}_requires_a_value`);
  return value;
};
const appDirectoryArgument = process.argv.indexOf('--app-dir');
const suppliedAppDirectory = appDirectoryArgument >= 0 ? process.argv[appDirectoryArgument + 1] : undefined;
const suppliedWorkspace = optionValue('--workspace');
const suppliedLiguleHome = optionValue('--ligule-home');
const createAgentControlGrant = process.argv.includes('--create-agent-control-grant');
const suppliedGrantName = optionValue('--grant-name');
const suppliedGrantProfile = optionValue('--grant-profile') ?? 'workspace-write';
const localInterruption = process.argv.includes('--local-request-interruption');
const realInterruption = process.argv.includes('--real-request-interruption');
const interruptionMode = localInterruption ? 'local' : realInterruption ? 'real' : undefined;
if (localInterruption && realInterruption) throw new Error('packaged_interruption_modes_conflict');
const modelApiKeyName = 'LIGULE_PLAN2_OTHERS_API_KEY';
let modelApiKey = process.env[modelApiKeyName];
delete process.env[modelApiKeyName];
if (realInterruption && (typeof modelApiKey !== 'string' || modelApiKey.length < 8)) {
  throw new Error('packaged_real_interruption_credential_missing');
}
if (!realInterruption) modelApiKey = undefined;
if (appDirectoryArgument >= 0 && (suppliedAppDirectory === undefined || !isAbsolute(suppliedAppDirectory))) {
  throw new Error('--app-dir_requires_an_absolute_directory');
}
if (suppliedWorkspace !== undefined && !isAbsolute(suppliedWorkspace)) throw new Error('--workspace_requires_an_absolute_directory');
if (suppliedLiguleHome !== undefined && !isAbsolute(suppliedLiguleHome)) throw new Error('--ligule-home_requires_an_absolute_directory');
if (suppliedGrantProfile !== 'workspace-write' && suppliedGrantProfile !== 'full-access') throw new Error('--grant-profile_must_be_workspace-write_or_full-access');
if (createAgentControlGrant && (suppliedWorkspace === undefined || suppliedLiguleHome === undefined || suppliedGrantName === undefined)) {
  throw new Error('--create-agent-control-grant_requires_workspace_home_and_grant_name');
}
const packagedDirectory = suppliedAppDirectory === undefined
  ? defaultPackagedDirectory()
  : resolve(suppliedAppDirectory);
const applicationBundle = process.platform === 'darwin'
  ? packagedDirectory.toLowerCase().endsWith('.app') ? packagedDirectory : join(packagedDirectory, 'ligule.app')
  : packagedDirectory;
const applicationExecutable = process.platform === 'darwin'
  ? join(applicationBundle, 'Contents', 'MacOS', 'ligule')
  : join(applicationBundle, process.platform === 'win32' ? 'ligule.exe' : 'ligule');
const resourcesDirectory = process.platform === 'darwin'
  ? join(applicationBundle, 'Contents', 'Resources')
  : join(applicationBundle, 'resources');
const hostNode = join(resourcesDirectory, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const hostCli = join(resourcesDirectory, 'app', 'node_modules', '@ligule', 'core', 'dist', 'host', 'desktop-entry.js');
const hostEntry = join(resourcesDirectory, 'host-entry.js');
const testRoot = join(desktopDirectory, 'testplace');
const temporaryParent = join(testRoot, 'tmp');
const evidenceParent = join(testRoot, 'readings');
const requiredFiles = [applicationExecutable, hostNode, hostCli, hostEntry];
const missing = requiredFiles.filter(path => !existsSync(path));
if (missing.length > 0) throw new Error(`packaged_application_resources_missing:${missing.map(path => basename(path)).join(',')}`);

await mkdir(temporaryParent, { recursive: true });
await mkdir(evidenceParent, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const temporaryRoot = await mkdtemp(join(temporaryParent, `packaged-smoke-${runId}-`));
const evidenceRoot = await mkdtemp(join(evidenceParent, `packaged-smoke-${runId}-${process.pid}-`));
const userDataDirectory = join(temporaryRoot, 'user-data');
const liguleHome = suppliedLiguleHome === undefined ? join(temporaryRoot, 'ligule-home') : resolve(suppliedLiguleHome);
const workspace = suppliedWorkspace === undefined ? join(temporaryRoot, 'workspaces', 'project') : resolve(suppliedWorkspace);
process.env.LIGULE_HOME = liguleHome;
const exportDirectory = join(temporaryRoot, 'exports');
const exportPath = join(exportDirectory, 'session.md');
const providerGate = interruptionMode === undefined
  ? undefined
  : await startProviderGate(interruptionMode, modelApiKey);
await Promise.all([
  mkdir(userDataDirectory, { recursive: true }),
  mkdir(liguleHome, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(exportDirectory, { recursive: true }),
  mkdir(evidenceRoot, { recursive: true }),
]);
const sessionRecordDirectory = sessionDirectory({ boundary: workspace, workspaceRoot: workspace });

if (interruptionMode !== undefined) {
  const config = [
    'boundary = "."',
    '',
    '[model]',
    'api = "chat-completions"',
    `baseURL = ${JSON.stringify(`http://127.0.0.1:${providerGate.port}/v1`)}`,
    'model = "deepseek-flash"',
    `apiKeyEnv = ${JSON.stringify(modelApiKeyName)}`,
    'outputTokens = 1024',
    '',
    '[model.retry]',
    'maxAttempts = 1',
    'baseDelayMs = 1',
    'retry429 = false',
    'retry5xx = false',
    'retryTransport = false',
    '',
    '[loop]',
    'iterations = 2',
    'modelCalls = 2',
    '',
    '[policy]',
    'mode = "ask"',
    '',
  ].join('\n');
  await writeFile(join(liguleHome, 'config.toml'), config, { flag: 'wx', mode: 0o600 });
}

const environment = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LIGULE_API_KEY']) delete environment[key];
for (const key of Object.keys(environment)) {
  if (/(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_PASSWORD)$/iu.test(key)) delete environment[key];
}
environment.LIGULE_HOME = liguleHome;
if (interruptionMode !== undefined) {
  environment[modelApiKeyName] = interruptionMode === 'real' ? modelApiKey : 'synthetic-local-provider-key';
}

const results = [];
const processIds = {};
let applicationProcess;
let devTools;
let exitCode = 0;
let processExit;
let timedOut = false;

function defaultPackagedDirectory() {
  if (process.platform === 'win32') return join(desktopDirectory, 'release', 'win-unpacked');
  if (process.platform === 'linux') return join(desktopDirectory, 'release', 'linux-unpacked');
  if (process.platform === 'darwin') {
    const candidates = [
      join(desktopDirectory, 'release', `mac-${process.arch}`),
      join(desktopDirectory, 'release', 'mac'),
    ];
    return candidates.find(directory => existsSync(join(directory, 'ligule.app'))) ?? candidates[0];
  }
  throw new Error(`packaged_smoke_platform_unsupported:${process.platform}`);
}

function record(name, status, detail) {
  const result = { name, status, detail };
  results.push(result);
  console.log(JSON.stringify(result));
}

async function startProviderGate(mode, apiKey) {
  const state = {
    mode,
    requests: 0,
    localActions: [],
    model: undefined,
    maxTokens: undefined,
    upstreamStatus: undefined,
    held: false,
    failure: undefined,
    clientClosed: false,
  };
  let upstreamResponse;
  let upstreamController;
  let upstreamTimer;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/__state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404);
      response.end();
      return;
    }
    state.requests += 1;
    response.on('close', () => {
      state.clientClosed = true;
      upstreamController?.abort();
      if (upstreamResponse?.body !== null && upstreamResponse?.body !== undefined) {
        void upstreamResponse.body.cancel().catch(() => {});
      }
    });
    if (state.requests > (mode === 'local' ? 5 : 1)) {
      state.failure = 'duplicate_provider_request';
      response.writeHead(409);
      response.end();
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', () => { state.failure = 'provider_request_read_failed'; });
    request.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        state.failure = 'provider_request_json_invalid';
        return;
      }
      state.model = body.model;
      state.maxTokens = body.max_tokens;
      if (body.model !== 'deepseek-flash' || body.max_tokens !== 1024 || body.stream !== true) {
        state.failure = 'provider_request_metadata_invalid';
        return;
      }
      if (mode === 'local') {
        const lastUser = Array.isArray(body.messages) ? [...body.messages].reverse().find(item => item.role === 'user') : undefined;
        const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
        const marker = prompt.includes('[LOCAL_APPROVAL_DENY]')
          ? 'deny'
          : prompt.includes('[LOCAL_APPROVAL_ALLOW]')
            ? 'allow'
            : prompt.includes('[LOCAL_PENDING_INTERRUPTION]') ? 'pending' : undefined;
        if (marker === undefined) {
          state.failure = 'local_fixture_prompt_unrecognized';
          return;
        }
        if (marker === 'deny' || marker === 'allow') {
          const lastUserIndex = body.messages.lastIndexOf(lastUser);
          if (body.messages.slice(lastUserIndex + 1).some(item => item.role === 'tool')) {
            const events = [
              { choices: [{ index: 0, delta: { content: '审批处理已完成。' }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
              '[DONE]',
            ];
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
            return;
          }
          state.localActions.push(`approval_${marker}`);
          const arguments_ = marker === 'deny'
            ? { path: 'approval-denied-proof.txt', content: 'DENIED' }
            : { path: 'approval-allowed-proof.txt', content: 'ALLOWED' };
          const events = [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `local-${marker}-call`, type: 'function', function: { name: 'create', arguments: JSON.stringify(arguments_) } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ];
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Controlled pending response.' }, finish_reason: null }] })}\n\n`);
        state.localActions.push('pending_response_held');
        state.held = true;
        return;
      }

      try {
        upstreamController = new AbortController();
        upstreamTimer = setTimeout(() => upstreamController?.abort(), 90_000);
        upstreamResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: upstreamController.signal,
        });
        state.upstreamStatus = upstreamResponse.status;
        if (upstreamResponse.status !== 200) {
          state.failure = 'official_provider_http_error';
          state.held = true;
          return;
        }
        state.held = true;
      } catch {
        state.failure = 'official_provider_transport_error';
      } finally {
        clearTimeout(upstreamTimer);
        upstreamTimer = undefined;
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('provider_gate_listen_failed');
  return {
    port: address.port,
    state,
    containsCredential(text) {
      return typeof apiKey === 'string' && apiKey.length > 0 && text.includes(apiKey);
    },
    async close() {
      clearTimeout(upstreamTimer);
      upstreamController?.abort();
      if (upstreamResponse?.body !== null && upstreamResponse?.body !== undefined) {
        await upstreamResponse.body.cancel().catch(() => {});
      }
      server.closeAllConnections();
      await new Promise(resolvePromise => server.close(resolvePromise));
    },
  };
}

async function check(name, action) {
  try {
    const detail = await action();
    record(name, '通过', detail ?? '实测符合预期');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interruptionMode === undefined) {
      record(name, '失败', message.split('\n')[0].slice(0, 300));
    } else {
      const code = error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' && /^[a-z][a-z0-9_]{1,80}$/u.test(error.code)
        ? error.code
        : error instanceof Error && /^[a-z][a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : interruptionMode === 'local' && error instanceof Error
            ? error.message.toLowerCase().replace(/[^a-z0-9]+/gu, '_').slice(0, 100)
          : 'packaged_interruption_check_failed';
      record(name, '失败', `隔离验收步骤失败，错误码 ${code}`);
    }
    exitCode = 1;
  }
}

function waitUntil(predicate, timeoutMs = 20_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = async () => {
      try {
        const result = await predicate();
        if (result) {
          resolvePromise(result);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`timeout_waiting_for_${label}`));
          return;
        }
        setTimeout(poll, 150);
      } catch (error) {
        if (Date.now() >= deadline) reject(error);
        else setTimeout(poll, 150);
      }
    };
    void poll();
  });
}

class DevToolsConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (typeof message.id !== 'number') return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'devtools_command_failed'));
      else waiter.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('devtools_connection_closed'));
      }
      this.pending.clear();
    });
    socket.addEventListener('error', () => {
      this.closed = true;
    });
  }

  static async connect(address) {
    const socket = new WebSocket(address);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('devtools_websocket_timeout')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('devtools_websocket_failed')); }, { once: true });
    });
    return new DevToolsConnection(socket);
  }

  call(method, params = {}, timeoutMs = 15_000) {
    if (this.closed) return Promise.reject(new Error('devtools_connection_closed'));
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`devtools_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 15_000) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (response.exceptionDetails !== undefined) {
      const exception = response.exceptionDetails.exception;
      throw new Error(exception?.description ?? response.exceptionDetails.text ?? 'renderer_evaluation_failed');
    }
    return response.result?.value;
  }
}

async function connectDevTools() {
  const activePortPath = join(userDataDirectory, 'DevToolsActivePort');
  await waitUntil(async () => {
    if (applicationProcess.exitCode !== null) throw new Error(`packaged_app_exited:${applicationProcess.exitCode}`);
    const content = await readFile(activePortPath, 'utf8').catch(() => '');
    const port = Number(content.split(/\r?\n/u)[0]);
    return Number.isInteger(port) && port > 0 ? port : false;
  }, 35_000, 'DevToolsActivePort');
  const content = await readFile(activePortPath, 'utf8');
  const port = Number(content.split(/\r?\n/u)[0]);
  const page = await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined);
    if (response === undefined || !response.ok) return false;
    const targets = await response.json();
    return targets.find(target => target.type === 'page' && target.url === 'app://ligule/index.html') ?? false;
  }, 35_000, 'packaged_app_page');
  devTools = await DevToolsConnection.connect(page.webSocketDebuggerUrl);
  await devTools.call('Page.enable');
  await devTools.call('Runtime.enable');
  return page;
}

async function processSnapshot() {
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "$all = Get-CimInstance Win32_Process; $all | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='parentPid';Expression={$_.ParentProcessId}},@{Name='executable';Expression={$_.ExecutablePath}},@{Name='commandLine';Expression={$_.CommandLine}} | ConvertTo-Json -Compress -Depth 3";
    const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    if (output === '') return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const output = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split(/\r?\n/u).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]), commandLine: match[3] }];
  });
}

function descendantOf(processList, childPid, ancestorPid) {
  const byPid = new Map(processList.map(item => [Number(item.pid), item]));
  let current = byPid.get(Number(childPid));
  const seen = new Set();
  while (current !== undefined && !seen.has(Number(current.pid))) {
    const parent = Number(current.parentPid);
    if (parent === Number(ancestorPid)) return true;
    seen.add(Number(current.pid));
    current = byPid.get(parent);
  }
  return false;
}

async function hostProcessFor(mainPid) {
  const expectedNode = resolve(hostNode);
  return waitUntil(async () => {
    const processes = await processSnapshot();
    return processes.find(item => {
      if (Number(item.pid) === Number(mainPid)) return false;
      const commandLine = typeof item.commandLine === 'string' ? item.commandLine.toLowerCase() : '';
      const executable = typeof item.executable === 'string' ? resolve(item.executable) : '';
      const sameRuntime = process.platform === 'win32'
        ? executable.toLowerCase() === expectedNode.toLowerCase()
        : commandLine.includes(expectedNode.toLowerCase());
      return sameRuntime
        && commandLine.includes('host-entry.js')
        && descendantOf(processes, item.pid, mainPid);
    }) ?? false;
  }, 25_000, 'packaged_node_host_process');
}

async function hostProcessGone(pid) {
  return waitUntil(async () => !(await processSnapshot()).some(item => Number(item.pid) === Number(pid)), 15_000, 'old_host_process_exit');
}

function killHostImmediately(pid) {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFileSync(taskkill, ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    });
    return;
  }
  process.kill(pid, 'SIGKILL');
}

async function prepareIsolatedWorkspace() {
  const preflightEnvironment = { ...environment };
  delete preflightEnvironment[modelApiKeyName];
  const preflight = spawn(hostNode, [hostEntry, hostCli], {
    cwd: resolve(resourcesDirectory, 'app'),
    env: preflightEnvironment,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  processIds.preflightHost = preflight.pid;
  const preflightExit = new Promise((resolvePromise, reject) => {
    preflight.once('error', reject);
    preflight.once('exit', (code, signal) => {
      processIds.preflightHostExitCode = code;
      resolvePromise({ code, signal });
    });
  });
  const response = new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('preflight_host_rpc_timeout')), 20_000);
    preflight.stdout.setEncoding('utf8');
    preflight.stdout.on('data', chunk => {
      output += chunk;
      let end = output.indexOf('\n');
      while (end >= 0) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        if (line !== '') {
          try {
            const frame = JSON.parse(line);
            if (frame.id === 'packaged-workspace-default') {
              clearTimeout(timer);
              resolvePromise(frame);
            }
          } catch {}
        }
        end = output.indexOf('\n');
      }
    });
    preflight.once('error', reject);
  });
  preflight.stderr.on('data', () => {
    // 读取并丢弃 Host 的标准错误输出，避免子进程因管道缓冲区已满而阻塞。
  });
  preflight.stdin.write(`${JSON.stringify({
    id: 'packaged-workspace-default',
    method: 'workspace.default.set',
    params: { directory: workspace, name: 'Packaged smoke project' },
  })}\n`);
  const frame = await response;
  if (frame.error !== undefined) throw new Error(`preflight_workspace_failed:${frame.error.code ?? 'host_error'}`);
  preflight.stdin.end();
  preflight.disconnect();
  const { code, signal } = await preflightExit;
  if (code !== 0) throw new Error(`preflight_host_exit:${code}:${signal ?? ''}`);
  return frame.result;
}

let rpcSequence = 0;
async function hostCall(method, params = {}) {
  rpcSequence += 1;
  const id = `packaged-smoke-${rpcSequence}`;
  const frame = JSON.stringify({ id, method, params });
  const expression = `(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(frame)});
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const raw = window.__packagedSmokeFrames.find(value => {
        try { return JSON.parse(value).id === ${JSON.stringify(id)}; } catch { return false; }
      });
      if (raw !== undefined) return JSON.parse(raw);
      const fault = window.__packagedSmokeFaults[0];
      if (fault !== undefined) throw new Error(fault);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    throw new Error('host_rpc_timeout');
  })()`;
  const response = await devTools.evaluate(expression, 25_000);
  if (response?.error !== undefined) throw new Error(`${response.error.code ?? 'host_error'}:${response.error.message ?? ''}`);
  if (response?.id !== id) throw new Error('host_response_id_mismatch');
  return response;
}

async function startLockHoldingHost(sessionId) {
  const child = spawn(hostNode, [hostEntry, hostCli], {
    cwd: resolve(resourcesDirectory, 'app'),
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error('lock_holder_host_spawn_failed');
  processIds.lockHolderHost = child.pid;
  const pending = new Map();
  let requestSequence = 0;
  let buffer = '';
  const exited = new Promise(resolvePromise => child.once('close', resolvePromise));
  const failPending = error => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line !== '') {
        try {
          const frame = JSON.parse(line);
          const request = pending.get(frame.id);
          if (request !== undefined) {
            clearTimeout(request.timer);
            pending.delete(frame.id);
            if (frame.error !== undefined) {
              request.reject(Object.assign(new Error(frame.error.message ?? frame.error.code), { code: frame.error.code }));
            } else request.resolve(frame.result);
          }
        } catch (error) {
          failPending(error);
        }
      }
      end = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', () => {});
  child.once('error', failPending);
  child.once('close', (code, signal) => failPending(new Error(`lock_holder_host_closed:${code ?? signal ?? 'unknown'}`)));
  const call = (method, params) => new Promise((resolvePromise, reject) => {
    const id = `lock-holder-${requestSequence++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('lock_holder_host_rpc_timeout'));
    }, 60_000);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
      if (error === null || error === undefined) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
  const close = async () => {
    try { await call('session.close', { sessionId }); }
    finally {
      child.stdin.end();
      if (child.connected) child.disconnect();
      const stopped = await Promise.race([exited.then(() => true), delay(10_000).then(() => false)]);
      if (!stopped && child.exitCode === null) child.kill();
    }
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await call('session.open', { sessionId, projectRoot: workspace });
        return {
          pid: child.pid,
          observe: () => call('session.observe', { projectRoot: workspace, sessionId, limit: 1 }),
          close,
        };
      } catch (error) {
        if (error?.code !== 'session_locked' || Date.now() >= deadline) throw error;
        await delay(500);
      }
    }
  } catch (error) {
    child.kill();
    await Promise.race([exited, delay(10_000)]);
    throw error;
  }
}

async function notifyHost(method, params = {}) {
  rpcSequence += 1;
  const id = `packaged-smoke-${rpcSequence}`;
  const frame = JSON.stringify({ id, method, params });
  const sent = await devTools.evaluate(`(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(frame)});
    return true;
  })()`, 10_000);
  if (sent !== true) throw new Error('host_notification_not_sent');
}

async function providerGateState() {
  if (providerGate === undefined) throw new Error('provider_gate_missing');
  const response = await fetch(`http://127.0.0.1:${providerGate.port}/__state`);
  if (!response.ok) throw new Error('provider_gate_status_unavailable');
  return await response.json();
}

async function captureEvidence(name = 'packaged-smoke.png') {
  if (devTools === undefined || devTools.closed) return;
  const image = await devTools.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(evidenceRoot, name), Buffer.from(image.data, 'base64'), { flag: 'wx' });
}

async function enumerateFiles(root) {
  const results = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else results.push(path);
    }
  };
  await visit(root);
  return results;
}

async function sessionJsonl(sessionId) {
  const files = (await enumerateFiles(sessionRecordDirectory)).filter(path => path.endsWith('.jsonl'));
  for (const path of files) {
    const content = await readFile(path, 'utf8');
    const records = content.split(/\r?\n/u).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    if (records.some(record => record.sessionId === sessionId || record.id === sessionId)) return { path, content, records };
  }
  throw new Error('persisted_interrupted_session_missing');
}

async function startUiSession(input) {
  const target = JSON.stringify(input);
  await devTools.evaluate(`(() => {
    const textarea = document.querySelector('textarea.composer-input');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('composer_controls_missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter === undefined) throw new Error('composer_value_setter_missing');
    setter.call(textarea, ${target});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const textarea = document.querySelector('textarea.composer-input');
    const send = document.querySelector('button.send');
    return textarea instanceof HTMLTextAreaElement
      && send instanceof HTMLButtonElement
      && textarea.value === ${target}
      && !textarea.readOnly
      && !send.disabled;
  })()`), 10_000, 'composer_send_ready');
  await devTools.evaluate(`document.querySelector('button.send').click(); true`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const files = (await enumerateFiles(sessionRecordDirectory)).filter(path => path.endsWith('.jsonl'));
    for (const path of files) {
      const records = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const user = records.find(record => record.kind === 'user' && record.text === input);
      if (user !== undefined) {
        const header = records.find(record => record.kind === 'session');
        if (typeof header?.sessionId === 'string') return header.sessionId;
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  throw new Error('ui_session_start_timeout');
}

async function setInitialPermission(profile, network) {
  await devTools.evaluate(`document.querySelector('button.permission-trigger')?.click(); true`);
  await waitUntil(async () => await devTools.evaluate(`document.querySelector('.permission-panel select') instanceof HTMLSelectElement`), 10_000, 'initial_permission_picker_open');
  const changed = await devTools.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.permission-panel select')];
    if (selects.length !== 2 || selects.some(select => !(select instanceof HTMLSelectElement))) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(selects[0], ${JSON.stringify(profile)});
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    setter.call(selects[1], ${JSON.stringify(network)});
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (changed !== true) throw new Error('initial_permission_controls_missing');
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const apply = document.querySelector('.permission-actions .primary-button');
    return apply instanceof HTMLButtonElement && !apply.disabled;
  })()`), 10_000, 'initial_permission_change_ready');
  await devTools.evaluate(`document.querySelector('.permission-actions .primary-button')?.click(); true`);
  await waitUntil(async () => await devTools.evaluate(`!document.querySelector('.permission-panel')`), 10_000, 'initial_permission_applied');
  await devTools.evaluate(`document.querySelector('button.permission-trigger')?.click(); true`);
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.permission-panel select')];
    return selects.length === 2 && selects[0].value === ${JSON.stringify(profile)} && selects[1].value === ${JSON.stringify(network)};
  })()`), 10_000, 'initial_permission_applied_value');
  await devTools.evaluate(`document.querySelector('.permission-panel button[aria-label="收起权限"], .permission-panel button[aria-label="Close permissions"]')?.click(); true`);
}

async function remainingSessionLocks() {
  const files = await enumerateFiles(sessionRecordDirectory);
  return files.filter(path => /\.jsonl\.lock(?:[\\/]|$)/iu.test(path));
}

async function runInterruptedRequest(sessionId, alreadyStarted = false) {
  if (interruptionMode === undefined || providerGate === undefined) throw new Error('packaged_interruption_not_configured');
  const activeHost = await hostProcessFor(applicationProcess.pid);
  const initialHostPid = Number(activeHost.pid);
  if (typeof initialHostPid !== 'number') throw new Error('packaged_host_pid_missing');
  processIds.interruptedHost = initialHostPid;
  if (!alreadyStarted) {
    await notifyHost('run.start', {
      sessionId,
      input: '[LOCAL_PENDING_INTERRUPTION] 请用中文写一篇较长的说明，至少 800 字，不要调用工具。测试会在模型答复交给 Host 前中断本轮。',
    });
  }

  const gate = await waitUntil(async () => {
    const state = await providerGateState();
    return state.held || state.failure !== undefined ? state : false;
  }, 95_000, 'provider_request_held');
  if (gate.failure !== undefined) throw Object.assign(new Error('provider_gate_failed'), { code: gate.failure });
  const expectedRequests = interruptionMode === 'local' ? 5 : 1;
  if (gate.requests !== expectedRequests || gate.model !== 'deepseek-flash' || gate.maxTokens !== 1024) {
    throw Object.assign(new Error('provider_gate_request_metadata_invalid'), { code: 'provider_gate_request_metadata_invalid' });
  }
  if (interruptionMode === 'real' && gate.upstreamStatus !== 200) {
    throw Object.assign(new Error('official_provider_response_not_accepted'), { code: 'official_provider_response_not_accepted' });
  }
  const active = await hostCall('status.get', { sessionId });
  if (active.result?.running !== true) throw new Error('packaged_run_not_pending_before_host_kill');
  await captureEvidence('packaged-interruption-pending.png');

  killHostImmediately(initialHostPid);
  await hostProcessGone(initialHostPid);
  processIds.interruptedHost = initialHostPid;
  const reconnectSelector = `([...document.querySelectorAll('.banner[role="alert"] button')]
    .find(button => /重新连接|Reconnect/u.test(button.textContent ?? '')) ?? null)`;
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} !== null`), 30_000, 'packaged_disconnect_banner');
  await captureEvidence('packaged-interruption-disconnected.png');
  await devTools.evaluate(`(${reconnectSelector}).click(); true`);
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} === null`), 30_000, 'packaged_reconnect_banner_clear');
  await devTools.evaluate('window.__packagedSmokeFaults.length = 0; true');
  const newHost = await hostProcessFor(applicationProcess.pid);
  processIds.reconnectedHost = Number(newHost.pid);
  if (Number(newHost.pid) === initialHostPid) throw new Error('packaged_host_pid_not_replaced');

  let reconnectReadError;
  await waitUntil(async () => {
    try {
      const ready = await hostCall('session.read', { sessionId, fullResults: true });
      return ready.result?.header?.projectRoot === workspace;
    } catch (error) {
      reconnectReadError = error instanceof Error ? error.message : String(error);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      return false;
    }
  }, 30_000, 'reconnected_host_rpc_ready').catch(() => {
    const safe = reconnectReadError?.toLowerCase().replace(/[^a-z0-9]+/gu, '_').slice(0, 80);
    throw new Error(safe ? `reconnected_host_rpc_${safe}` : 'reconnected_host_rpc_timeout');
  });
  const read = await hostCall('session.read', { sessionId, fullResults: true });
  const status = await hostCall('status.get', { sessionId });
  const events = read.result?.events ?? [];
  const turns = events.filter(event => event.kind === 'turn');
  if (status.result?.running !== false) throw new Error('interrupted_session_still_running_after_reopen');
  const expectedTurns = interruptionMode === 'local' ? 3 : 1;
  if (turns.length !== expectedTurns || turns.at(-1)?.status !== 'interrupted' || turns.at(-1)?.code !== 'host_restarted') {
    const observed = turns.length === expectedTurns ? `${turns.at(-1)?.status}_${turns.at(-1)?.code ?? 'none'}` : `turn_count_${turns.length}`;
    throw Object.assign(new Error('interrupted_session_terminal_record_invalid'), { code: `session_${observed}` });
  }
  if (events.some(event => event.kind === 'tool' && event.seq > turns.at(-1).userSeq)) {
    throw new Error('interrupted_model_call_dispatched_a_tool');
  }
  const persisted = await sessionJsonl(sessionId);
  const persistedTurns = persisted.records.filter(event => event.kind === 'turn');
  if (persistedTurns.length !== expectedTurns || persistedTurns.at(-1)?.status !== 'interrupted' || persistedTurns.at(-1)?.code !== 'host_restarted') {
    throw new Error('persisted_interrupted_turn_invalid');
  }
  if (interruptionMode === 'real' && providerGate.containsCredential(persisted.content)) {
    throw new Error('synthetic_credential_in_session');
  }

  await new Promise(resolvePromise => setTimeout(resolvePromise, 1500));
  const after = await providerGateState();
  if (after.requests !== expectedRequests || after.held !== true) throw new Error('provider_request_replayed_after_host_restart');
  if (interruptionMode === 'real' && after.clientClosed !== true) throw new Error('held_official_response_not_closed_after_host_kill');
  await captureEvidence('packaged-interruption-reconnected.png');
  return `${interruptionMode === 'real' ? '官方模型单次请求 HTTP 200，响应由本地 gate 暂扣' : '本地 HTTP SSE 请求已收到并保持未终止'}；Host ${initialHostPid} 被终止，Session 写入唯一 interrupted/host_restarted，重连后请求数仍为 ${expectedRequests}`;
}

async function ensureIsolatedWorkspaceSelected() {
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const button = document.querySelector('button.workspace-choice');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`), 30_000, 'workspace_selector_enabled');
  const currentWorkspace = await devTools.evaluate(`document.querySelector('button.workspace-choice')?.title ?? ''`);
  if (currentWorkspace === workspace) return;
  await devTools.evaluate(`document.querySelector('button.workspace-choice')?.click(); true`);
  await waitUntil(async () => await devTools.evaluate(`([...document.querySelectorAll('[role="option"]')].some(option => option.title === ${JSON.stringify(workspace)}))`), 15_000, 'isolated_workspace_option_loaded');
  const selected = await devTools.evaluate(`(() => {
    const option = [...document.querySelectorAll('[role="option"]')].find(item => item.title === ${JSON.stringify(workspace)});
    option?.click();
    return option !== undefined;
  })()`);
  if (selected !== true) throw new Error('isolated_workspace_option_missing');
  await waitUntil(async () => await devTools.evaluate(`document.querySelector('button.workspace-choice')?.title === ${JSON.stringify(workspace)}`), 15_000, 'isolated_workspace_selected');
}

async function runNoSessionReconnect() {
  const initialHost = Number(processIds.initialHost);
  if (!Number.isSafeInteger(initialHost)) throw new Error('initial_host_pid_missing');
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const textarea = document.querySelector('textarea.composer-input');
    const workspace = document.querySelector('button.workspace-choice');
    const model = document.querySelector('button.composer-choice');
    const prefsFailure = [...document.querySelectorAll('.center .banner[role="alert"]')]
      .some(banner => /无法保存更改|Could not save changes/u.test(banner.textContent ?? ''));
    return textarea instanceof HTMLTextAreaElement
      && workspace instanceof HTMLButtonElement
      && model instanceof HTMLButtonElement
      && !textarea.readOnly
      && !workspace.disabled
      && !model.disabled
      && !prefsFailure;
  })()`), 30_000, 'initial_preferences_ready');
  await ensureIsolatedWorkspaceSelected();
  if (interruptionMode !== undefined) {
    await waitUntil(async () => await devTools.evaluate(`(document.querySelector('button.composer-choice')?.textContent ?? '').includes('deepseek-flash')`), 15_000, 'interruption_model_loaded');
  }
  killHostImmediately(initialHost);
  await hostProcessGone(initialHost);
  const reconnectSelector = `([...document.querySelectorAll('.banner[role="alert"] button')]
    .find(button => /重新连接|Reconnect/u.test(button.textContent ?? '')) ?? null)`;
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} !== null`), 30_000, 'empty_session_disconnect_banner');
  await captureEvidence('packaged-empty-session-disconnected.png');
  await devTools.evaluate(`(${reconnectSelector}).click(); true`);
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} === null`), 30_000, 'empty_session_reconnect_banner_clear');
  await devTools.evaluate('window.__packagedSmokeFaults.length = 0; true');
  const newHost = await hostProcessFor(applicationProcess.pid);
  const newPid = Number(newHost.pid);
  if (newPid === initialHost) throw new Error('empty_session_host_pid_not_replaced');
  await waitUntil(async () => {
    try {
      const roster = await hostCall('workspaces.list');
      return Array.isArray(roster.result?.workspaces);
    } catch {
      return false;
    }
  }, 30_000, 'empty_session_host_rpc_ready');
  processIds.emptySessionReconnectHost = newPid;
  await captureEvidence('packaged-empty-session-reconnected.png');
  return `没有选中会话时终止 Host ${initialHost}，UI 重连后横幅清除，Host RPC 可用（新 Host ${newPid}）`;
}

async function runLocalApproval(sessionId, decision, alreadyStarted = false) {
  if (interruptionMode !== 'local' || providerGate === undefined) throw new Error('local_approval_fixture_not_configured');
  const marker = decision === 'deny' ? '[LOCAL_APPROVAL_DENY]' : '[LOCAL_APPROVAL_ALLOW]';
  const expectedRequest = decision === 'deny' ? 1 : 3;
  const proofPath = join(workspace, decision === 'deny' ? 'approval-denied-proof.txt' : 'approval-allowed-proof.txt');
  if (!alreadyStarted) await notifyHost('run.start', { sessionId, input: `${marker} 通过 create 工具写入审批验收文件。` });
  const gate = await waitUntil(async () => {
    const current = await providerGateState();
    return current.requests >= expectedRequest || current.failure !== undefined ? current : false;
  }, 30_000, `local_${decision}_provider_request`);
  if (gate.failure !== undefined || gate.requests !== expectedRequest || gate.localActions.at(-1) !== `approval_${decision}`) {
    throw new Error(`local_${decision}_provider_fixture_failed`);
  }
  await waitUntil(async () => await devTools.evaluate(`document.querySelector('.approval-actions button[data-tone="${decision}"]') !== null`), 30_000, `local_${decision}_approval_card`);
  await devTools.evaluate(`document.querySelector('.approval-actions button[data-tone="${decision}"]').click(); true`);
  await waitUntil(async () => (await hostCall('status.get', { sessionId })).result?.running === false, 30_000, `local_${decision}_run_completion`);
  if (decision === 'deny') {
    if (existsSync(proofPath)) throw new Error('denied_approval_created_file');
  } else if (await readFile(proofPath, 'utf8') !== 'ALLOWED') {
    throw new Error('allowed_approval_file_content_invalid');
  }
  return decision === 'deny'
    ? '通过 packaged 审批卡拒绝后，目标文件不存在'
    : '通过 packaged 审批卡允许后，真实 create 工具写入目标文件且内容正确';
}

async function startApplication() {
  const stdout = interruptionMode === undefined ? createWriteStream(join(evidenceRoot, 'stdout.log')) : undefined;
  const stderr = interruptionMode === undefined ? createWriteStream(join(evidenceRoot, 'stderr.log')) : undefined;
  applicationProcess = spawn(applicationExecutable, [
    `--user-data-dir=${userDataDirectory}`,
    '--remote-debugging-port=0',
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  });
  if (stdout !== undefined) applicationProcess.stdout.pipe(stdout);
  else applicationProcess.stdout.on('data', () => {});
  if (stderr !== undefined) applicationProcess.stderr.pipe(stderr);
  else applicationProcess.stderr.on('data', () => {});
  delete environment[modelApiKeyName];
  modelApiKey = undefined;
  processExit = new Promise(resolvePromise => applicationProcess.once('close', (code, signal) => resolvePromise({ code, signal })));
  processIds.main = applicationProcess.pid;
  return { stdout, stderr };
}

async function recordReport() {
  const report = {
    platform: process.platform,
    release: (await import('node:os')).release(),
    command: `${relative(repositoryRoot, applicationExecutable)} --user-data-dir=<isolated desktop/testplace/tmp> --remote-debugging-port=0`,
    applicationPid: processIds.main,
    hostNodeVersion: execFileSync(hostNode, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
    applicationPage: 'app://ligule/index.html',
    processIds,
    providerGate: providerGate === undefined ? undefined : {
      mode: providerGate.state.mode,
      requests: providerGate.state.requests,
      model: providerGate.state.model,
      maxTokens: providerGate.state.maxTokens,
      upstreamStatus: providerGate.state.upstreamStatus,
      held: providerGate.state.held,
      localActions: providerGate.state.localActions,
      failure: providerGate.state.failure,
      clientClosed: providerGate.state.clientClosed,
    },
    results,
    exitCode,
    timedOut,
  };
  await writeFile(join(evidenceRoot, 'packaged-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(evidenceRoot, 'packaged-smoke.log'), `${results.map(result => `${result.name} ${result.status}: ${result.detail}`).join('\n')}\n`, 'utf8');
}

async function runChecks() {
  await check('packaged application and pinned Host', async () => {
    const page = await connectDevTools();
    const appInfo = await devTools.evaluate(`({
      href: location.href,
      origin: location.origin,
      secure: isSecureContext,
      api: typeof window.liguleDesktop,
      methods: Object.keys(window.liguleDesktop ?? {}).sort(),
    })`);
    if (appInfo.href !== 'app://ligule/index.html') throw new Error(`unexpected_application_page:${appInfo.href}`);
    if (appInfo.origin !== 'app://ligule') throw new Error(`unexpected_application_origin:${appInfo.origin}`);
    if (appInfo.secure !== true || appInfo.api !== 'object') throw new Error('packaged_preload_api_unavailable');
    const requiredMethods = ['appInfo', 'sendHostFrame', 'restartHost', 'onHostFrame', 'onHostFault', 'requestQuit'];
    for (const method of requiredMethods) if (!appInfo.methods.includes(method)) throw new Error(`preload_api_missing:${method}`);
    const installedApp = await devTools.evaluate('window.liguleDesktop.appInfo()');
    if (typeof installedApp.version !== 'string' || installedApp.version === '' || installedApp.packaged !== true) {
      throw new Error('packaged_application_info_invalid');
    }
    await devTools.evaluate(`(() => {
      window.__packagedSmokeFrames = [];
      window.__packagedSmokeFaults = [];
      window.liguleDesktop.onHostFrame(frame => window.__packagedSmokeFrames.push(frame));
      window.liguleDesktop.onHostFault(fault => window.__packagedSmokeFaults.push(fault));
      return true;
    })()`);
    const host = await hostProcessFor(applicationProcess.pid);
    processIds.initialHost = Number(host.pid);
    processIds.hostExecutable = host.executable;
    processIds.hostCommandLine = host.commandLine;
    return `来源 ${appInfo.origin}，Ligule ${installedApp.version}；Host PID ${host.pid} 使用 ${reportVersion(hostNode)}`;
  });

  await check('open Model services in the installed application', async () => {
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('aside.sidebar button.entry') !== null`), 30_000, 'packaged_settings_entry_ready');
    const opened = await devTools.evaluate(`(() => {
      const button = [...document.querySelectorAll('aside.sidebar button.entry')]
        .find(item => /设置|Settings/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    if (opened !== true) throw new Error('packaged_settings_entry_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.sheet .sheet-nav button[role="tab"]') !== null`), 10_000, 'packaged_settings_open');
    const selected = await devTools.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.sheet-nav button[role="tab"]')]
        .find(item => /模型服务|Model services/u.test(item.textContent ?? ''));
      tab?.click();
      return tab !== undefined;
    })()`);
    if (selected !== true) throw new Error('packaged_model_services_tab_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.model-settings .settings-intro h2') !== null`), 10_000, 'packaged_model_settings_panel');
    const details = await devTools.evaluate(`(() => ({
      title: document.querySelector('.model-settings .settings-intro h2')?.textContent?.trim() ?? '',
      error: document.querySelector('.model-settings [role="alert"]')?.textContent ?? '',
    }))()`);
    if (!/模型服务|Model services/u.test(details.title)) throw new Error('packaged_model_settings_title_missing');
    if (details.error !== '') throw new Error('packaged_model_settings_load_failed');
    await devTools.evaluate(`document.querySelector('button[aria-label="关闭设置"], button[aria-label="Close settings"]')?.click(); true`);
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.sheet') === null`), 5_000, 'packaged_settings_close');
    return `真实 BrowserWindow 已打开模型服务设置：${details.title}；没有读取或显示凭据`;
  });

  await check('trust the exact isolated workspace through the packaged UI', async () => {
    await ensureIsolatedWorkspaceSelected();
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('button.permission-trigger') !== null`), 10_000, 'packaged_permission_trigger');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('button.permission-trigger')?.disabled === false`), 60_000, 'packaged_permission_trigger_enabled');
    const trigger = await devTools.evaluate(`(() => {
      const button = document.querySelector('button.permission-trigger');
      if (button === null) return { exists: false };
      const state = { exists: true, disabled: button.disabled, expanded: button.getAttribute('aria-expanded'), text: button.textContent?.trim() ?? '' };
      button.click();
      return state;
    })()`);
    if (!trigger.exists || trigger.disabled) throw new Error(`packaged_permission_trigger_unavailable:${JSON.stringify(trigger)}`);
    try {
      await waitUntil(async () => await devTools.evaluate(`document.querySelector('.permission-panel') !== null`), 5_000, 'packaged_permission_panel');
    } catch {
      const state = await devTools.evaluate(`({
        expanded: document.querySelector('button.permission-trigger')?.getAttribute('aria-expanded') ?? null,
        popovers: [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].map(item => item.textContent?.slice(0, 120) ?? ''),
        bodyTail: document.body.innerText.slice(-500),
      })`);
      throw new Error(`packaged_permission_panel_unavailable:${JSON.stringify(state)}`);
    }
    const untrustedNotice = await devTools.evaluate(`[...document.querySelectorAll('.permission-note')]
      .some(item => /项目代码尚未信任|Project code is not trusted yet/u.test(item.textContent ?? ''))`);
    const link = await devTools.evaluate(`(() => {
      const button = document.querySelector('.permission-details-link');
      button?.click();
      return button !== null && button !== undefined;
    })()`);
    if (link !== true) throw new Error('packaged_permission_details_link_missing');
    await waitUntil(async () => await devTools.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.sheet-nav button[role="tab"][aria-selected="true"]')]
        .find(item => /^(权限与安全|Permissions and security)$/u.test(item.textContent?.trim() ?? ''));
      return tab !== undefined && document.querySelector('.security-settings') !== null;
    })()`), 10_000, 'packaged_security_settings_open');
    const readWorkspaceTrust = () => devTools.evaluate(`(() => {
      const section = [...document.querySelectorAll('.security-settings .region-group')]
        .find(item => /^(工作区信任|Workspace trust)$/u.test(item.querySelector('h3')?.textContent?.trim() ?? ''));
      const rows = [...(section?.querySelectorAll('.sheet-row') ?? [])];
      const project = rows.find(item => /^(当前项目|Current project)$/u.test(item.querySelector('.sheet-label')?.textContent?.trim() ?? ''));
      const trust = rows.find(item => /^(信任状态|Trust status)$/u.test(item.querySelector('.sheet-label')?.textContent?.trim() ?? ''));
      return {
        project: project?.querySelector('.catalog-path')?.textContent?.trim() ?? '',
        state: trust?.querySelector('.sheet-value > span')?.textContent?.trim() ?? '',
      };
    })()`);
    await waitUntil(async () => {
      const current = await readWorkspaceTrust();
      return current.project !== '' && current.state !== '' && !/正在读取|Loading/u.test(current.state);
    }, 15_000, 'packaged_workspace_trust_loaded');
    const workspaceTrust = await readWorkspaceTrust();
    if (workspaceTrust.project !== workspace) throw new Error(`packaged_workspace_trust_project_mismatch:${JSON.stringify(workspaceTrust)}`);
    if (!/^(未信任|Not trusted)$/u.test(workspaceTrust.state)) {
      throw new Error(`packaged_isolated_workspace_not_initially_untrusted:${JSON.stringify(workspaceTrust)}`);
    }
    if (!untrustedNotice) throw new Error('packaged_untrusted_workspace_notice_missing');
    const trustButton = await devTools.evaluate(`(() => {
      const section = [...document.querySelectorAll('.security-settings .region-group')]
        .find(item => /工作区信任|Workspace trust/u.test(item.querySelector('h3')?.textContent ?? ''));
      const button = [...(section?.querySelectorAll('.sheet-row button') ?? [])]
        .find(item => /信任此工作区|Trust this workspace/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    if (trustButton !== true) throw new Error('packaged_workspace_trust_action_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.confirm') !== null`), 5_000, 'packaged_workspace_trust_confirmation');
    const confirmation = await devTools.evaluate(`({
      text: document.querySelector('.confirm')?.textContent ?? '',
      project: document.querySelector('.confirm .catalog-path')?.textContent?.trim() ?? '',
    })`);
    if (confirmation.project !== workspace) throw new Error(`packaged_workspace_trust_confirmation_project_mismatch:${JSON.stringify(confirmation)}`);
    if (!/信任以下项目中的脚本|trusts scripts/u.test(confirmation.text)) throw new Error('packaged_workspace_trust_confirmation_mismatch');
    const trustConfirmed = await devTools.evaluate(`(() => {
      const button = [...document.querySelectorAll('.confirm button')]
        .find(item => /确认信任|Trust project/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    if (trustConfirmed !== true) throw new Error('packaged_workspace_trust_confirm_button_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.confirm') === null`), 5_000, 'packaged_workspace_trust_confirmation_close');
    await waitUntil(async () => {
      const current = await readWorkspaceTrust();
      return current.project === workspace && /^(已信任|Trusted)$/u.test(current.state);
    }, 10_000, 'packaged_workspace_trust_saved');
    const catalog = await hostCall('settings.catalog', { projectRoot: workspace });
    if (catalog.result?.projectTrusted !== true) throw new Error('packaged_workspace_trust_not_persisted_in_host');
    await devTools.evaluate(`document.querySelector('button[aria-label="关闭设置"], button[aria-label="Close settings"]')?.click(); true`);
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.sheet') === null`), 5_000, 'packaged_settings_close_after_trust');
    return '权限弹窗提示准确，设置页显示精确工作区，确认后 UI 与 Host 均报告已信任';
  });

  await check('open local Agent Control and MCP settings in the installed application', async () => {
    const opened = await devTools.evaluate(`(() => {
      const button = [...document.querySelectorAll('aside.sidebar button.entry')]
        .find(item => /设置|Settings/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    if (opened !== true) throw new Error('packaged_settings_entry_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.sheet .sheet-nav button[role="tab"]') !== null`), 5_000, 'packaged_control_settings_open');
    const selected = await devTools.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.sheet-nav button[role="tab"]')]
        .find(item => /外部控制|Agent Control/u.test(item.textContent ?? ''));
      tab?.click();
      return tab !== undefined;
    })()`);
    if (selected !== true) throw new Error('packaged_agent_control_tab_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.agent-control-panel .agent-control-notice') !== null`), 10_000, 'packaged_agent_control_panel');
    const notice = await devTools.evaluate(`document.querySelector('.agent-control-panel .agent-control-notice')?.textContent ?? ''`);
    if (!/本机 stdio MCP|local stdio MCP/u.test(notice)) throw new Error('packaged_mcp_location_notice_missing');
    if (createAgentControlGrant) {
      await check('create a workspace-scoped Agent Control grant through the installed UI', async () => {
        const draft = await devTools.evaluate(`(async () => {
          const panel = document.querySelector('.agent-control-panel');
          if (panel === null) return { error: 'panel_missing' };
          const createDetails = panel.querySelector('.grant-create-fold');
          if (createDetails === null) return { error: 'create_section_missing' };
          createDetails.open = true;
          const name = panel.querySelector('.grant-basic-grid input:not([readonly])');
          const project = panel.querySelector('.grant-basic-grid input[readonly]');
          if (!(name instanceof HTMLInputElement) || !(project instanceof HTMLInputElement)) return { error: 'basic_fields_missing' };
          const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          valueSetter.call(name, ${JSON.stringify(suppliedGrantName)});
          name.dispatchEvent(new Event('input', { bubbles: true }));
          name.dispatchEvent(new Event('change', { bubbles: true }));
          const nextBasics = [...panel.querySelectorAll('.grant-actions button')]
            .find(button => /继续：能力与上限|Continue: capabilities and limits/u.test(button.textContent ?? ''));
          if (nextBasics === undefined || nextBasics.disabled) return { error: 'capabilities_step_unavailable' };
          nextBasics.click();
          const stepDeadline = Date.now() + 5_000;
          while (Date.now() < stepDeadline && panel.querySelector('.grant-config-grid') === null) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const cards = [...panel.querySelectorAll('.grant-config-card')];
          const files = cards.find(card => /文件与命令权限|Files and commands/u.test(card.querySelector('h4')?.textContent ?? ''));
          const network = cards.find(card => /网络访问|Network access/u.test(card.querySelector('h4')?.textContent ?? ''));
          const policy = cards.find(card => /审批方式|Approval behavior/u.test(card.querySelector('h4')?.textContent ?? ''));
          if (files === undefined || network === undefined || policy === undefined) return { error: 'grant_limit_fields_missing' };
          const setSelect = (select, value) => {
            if (!(select instanceof HTMLSelectElement)) return false;
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return select.value === value;
          };
          const fileSelects = [...files.querySelectorAll('select')];
          const networkSelects = [...network.querySelectorAll('select')];
          const policySelect = policy.querySelector('select');
          const selections = [
            setSelect(fileSelects[0], ${JSON.stringify(suppliedGrantProfile)}),
            setSelect(fileSelects[1], ${JSON.stringify(suppliedGrantProfile)}),
            setSelect(networkSelects[0], 'unrestricted'),
            setSelect(networkSelects[1], 'unrestricted'),
            setSelect(policySelect, 'ask'),
          ];
          const checkLabel = (container, pattern) => {
            const label = [...container.querySelectorAll('label')]
              .find(item => pattern.test(item.textContent ?? ''));
            const checkbox = label?.querySelector('input[type="checkbox"]');
            if (!(checkbox instanceof HTMLInputElement)) return false;
            if (!checkbox.checked) checkbox.click();
            return checkbox.checked;
          };
          const confirmations = [];
          if (${JSON.stringify(suppliedGrantProfile)} !== 'read-only') {
            confirmations.push(checkLabel(files, /部分隔离限制|partial-isolation limits/u));
          }
          if (${JSON.stringify(suppliedGrantProfile)} === 'full-access') {
            confirmations.push(checkLabel(files, /确认允许访问当前 OS 账户|Allow access to everything/u));
          }
          confirmations.push(checkLabel(network, /不受限网络访问|unrestricted network access/u));
          const operatorAllowed = checkLabel(policy, /--operator|ordinary approvals/u);
          return {
            project: project?.value ?? '', name: name.value,
            selections, confirmations, operatorAllowed,
          };
        })()`);
        if (draft.error !== undefined) throw new Error(`grant_form_${draft.error}`);
        if (draft.project.toLowerCase() !== workspace.toLowerCase()) throw new Error('grant_project_does_not_match_requested_workspace');
        if (draft.name !== suppliedGrantName || !draft.selections.every(Boolean) || !draft.confirmations.every(Boolean) || !draft.operatorAllowed) {
          throw new Error(`grant_form_not_ready:${JSON.stringify(draft)}`);
        }
        const advanced = await devTools.evaluate(`(() => {
          const panel = document.querySelector('.agent-control-panel');
          return [...panel.querySelectorAll('.grant-actions button')]
            .find(button => /继续：风险确认|Continue: risk review/u.test(button.textContent ?? ''))?.disabled === false;
        })()`);
        if (advanced !== true) throw new Error('grant_risk_review_step_unavailable');
        await devTools.evaluate(`(() => {
          const panel = document.querySelector('.agent-control-panel');
          [...panel.querySelectorAll('.grant-actions button')]
            .find(button => /继续：风险确认|Continue: risk review/u.test(button.textContent ?? ''))?.click();
          return true;
        })()`);
        await waitUntil(async () => await devTools.evaluate(`document.querySelector('.agent-control-panel .grant-lifetime-card') !== null`), 5_000, 'packaged_agent_control_risk_review');
        const workspaceConfirmation = await devTools.evaluate(`(() => {
          const panel = document.querySelector('.agent-control-panel');
          const label = [...panel.querySelectorAll('.grant-lifetime-card label')]
            .find(item => /我信任上方项目目录|I trust project code/u.test(item.textContent ?? ''));
          const checkbox = label?.querySelector('input[type="checkbox"]');
          if (!(checkbox instanceof HTMLInputElement)) return false;
          if (!checkbox.checked) checkbox.click();
          return checkbox.checked;
        })()`);
        if (workspaceConfirmation !== true) throw new Error('grant_workspace_confirmation_missing');
        await waitUntil(async () => await devTools.evaluate(`(() => {
          const panel = document.querySelector('.agent-control-panel');
          const button = [...panel.querySelectorAll('.grant-actions button')]
            .find(item => /创建授权|Create grant/u.test(item.textContent ?? ''));
          return button !== undefined && !button.disabled;
        })()`), 5_000, 'packaged_agent_control_grant_enabled');
        const submitted = await devTools.evaluate(`(() => {
          const panel = document.querySelector('.agent-control-panel');
          const button = [...panel.querySelectorAll('.grant-actions button')]
            .find(item => /创建授权|Create grant/u.test(item.textContent ?? ''));
          button?.click();
          return button !== undefined && !button.disabled;
        })()`);
        if (submitted !== true) throw new Error('grant_create_button_unavailable');
        await waitUntil(async () => await devTools.evaluate(`(() => {
          return [...document.querySelectorAll('.agent-control-panel .grant-inspector')]
            .some(item => item.querySelector(':scope > summary')?.textContent?.includes(${JSON.stringify(suppliedGrantName)}));
        })()`), 20_000, 'packaged_agent_control_grant_saved');
        const grant = await devTools.evaluate(`(() => {
          const row = [...document.querySelectorAll('.agent-control-panel .grant-inspector')]
            .find(item => item.querySelector(':scope > summary')?.textContent?.includes(${JSON.stringify(suppliedGrantName)}));
          const details = row?.querySelector('details.catalog-fold');
          if (details !== undefined && details !== null) details.open = true;
          return {
            id: details?.querySelector('code')?.textContent?.trim() ?? '',
            project: row?.querySelector('.catalog-current')?.textContent?.trim() ?? '',
            details: [...(details?.querySelectorAll('p') ?? [])].map(item => item.textContent ?? '').join(' '),
            summary: row?.textContent ?? '',
            operator: [...(row?.querySelectorAll('.sheet-row') ?? [])]
              .find(item => /Operator replies|普通审批代答/u.test(item.querySelector('.sheet-label')?.textContent ?? ''))
              ?.querySelector('.sheet-value')?.textContent ?? '',
          };
        })()`);
        if (grant.id === '' || grant.project.toLowerCase() !== workspace.toLowerCase()) throw new Error('saved_grant_identity_mismatch');
        if (!grant.details.includes('可信界面创建') && !grant.details.includes('Trusted UI')) throw new Error('saved_grant_source_not_trusted_ui');
        const expectedPermission = `${suppliedGrantProfile} / ${suppliedGrantProfile}`;
        if (!grant.summary.includes(expectedPermission) || !grant.summary.includes('unrestricted / unrestricted')
          || !grant.summary.includes('ask') || (!grant.operator.includes('Allowed') && !grant.operator.includes('允许'))) {
          throw new Error('saved_grant_limits_invalid');
        }
        return `可信 Desktop UI 为准确工作区创建 ${grant.id}；${expectedPermission}，unrestricted / unrestricted，Policy ask，允许 --operator`;
      });
    }
    await devTools.evaluate(`document.querySelector('button[aria-label="关闭设置"], button[aria-label="Close settings"]')?.click(); true`);
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('.sheet') === null`), 5_000, 'packaged_control_settings_close');
    return 'Agent Control 页面报告使用本机 stdio MCP；CLI 的已安装路径由独立 npm 消费者检查确认';
  });

  let sessionId;
  await check('reconnect the packaged Host with no selected session', async () => {
    return await runNoSessionReconnect();
  });
  await check('create session through the packaged Preload and Host', async () => {
    const created = await hostCall('session.create', { projectRoot: workspace, workspaceOrigin: 'explicit' });
    sessionId = created.result?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('host_session_create_missing_id');
    const label = await hostCall('session.label', { sessionId, name: 'Packaged smoke record' });
    if (label.result?.name !== 'Packaged smoke record') throw new Error('host_session_label_not_saved');
    const roster = await hostCall('workspaces.list');
    if (!roster.result?.workspaces?.some(item => resolve(item.directory).toLowerCase() === resolve(workspace).toLowerCase())) {
      throw new Error('isolated_workspace_not_registered_by_host');
    }
    const refreshed = await devTools.evaluate(`(() => {
      const button = [...document.querySelectorAll('.sessions button[aria-label]')]
        .find(item => /刷新会话列表|Refresh conversations/u.test(item.getAttribute('aria-label') ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    if (refreshed !== true) throw new Error('packaged_session_rail_refresh_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('button.session-item[title$=" · ${sessionId}"]') !== null`), 15_000, 'packaged_session_rail_entry');
    const selected = await devTools.evaluate(`(() => {
      const item = document.querySelector('button.session-item[title$=" · ${sessionId}"]');
      item?.click();
      return item !== null;
    })()`);
    if (selected !== true) throw new Error('packaged_session_rail_entry_missing');
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('#session-title')?.textContent?.trim() === 'Packaged smoke record'`), 15_000, 'packaged_session_selected_in_ui');
    return `Host 创建会话 ${sessionId} 并登记隔离工作区`;
  });

  await check('read session and query status through the packaged Host', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const read = await hostCall('session.read', { sessionId, fullResults: true });
    if (read.result?.header?.projectRoot === undefined) throw new Error('session_read_missing_header');
    const status = await hostCall('status.get', { sessionId });
    if (status.result?.sessionId !== sessionId || status.result?.running !== false) throw new Error('session_status_invalid');
    return `读取会话头和状态，事件数 ${status.result.eventCount}`;
  });

  await check('export through Host RPC to the isolated test path', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const exported = await hostCall('session.export', { sessionId, path: exportPath });
    const content = await readFile(exportPath, 'utf8');
    if (!exported.result?.written?.includes(exportPath)) throw new Error('host_export_path_not_reported');
    if (!content.includes(sessionId) || !content.includes(workspace)) throw new Error('host_export_content_invalid');
    return `仅通过 Host session.export 写入隔离路径，字节数 ${(await stat(exportPath)).size}`;
  });

  await check('export over an existing target through Host RPC', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const before = await stat(exportPath).then(item => item.size, () => 0);
    const twice = await hostCall('session.export', { sessionId, path: exportPath });
    const content = await readFile(exportPath, 'utf8');
    if (!twice.result?.written?.includes(exportPath)) throw new Error('host_export_path_not_reported');
    if (!content.includes(sessionId) || !content.includes(workspace)) throw new Error('host_export_content_invalid');
    const after = Buffer.byteLength(content, 'utf8');
    if (after !== before) throw new Error(`host_export_existing_target_length_drift:${before}->${after}`);
    return `同一路径第二次导出由 Host 覆盖而非追加，长度保持 ${after} 字节`;
  });

  await check('restart the real packaged Host and recover the session', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const oldHost = await hostProcessFor(applicationProcess.pid);
    const oldPid = Number(oldHost.pid);
    await devTools.evaluate('window.liguleDesktop.restartHost()');
    await hostProcessGone(oldPid);
    const newHost = await hostProcessFor(applicationProcess.pid);
    const newPid = Number(newHost.pid);
    processIds.restartedHost = newPid;
    if (newPid === oldPid) throw new Error('host_pid_did_not_change_after_restart');
    await hostCall('session.open', { sessionId, projectRoot: workspace });
    const read = await hostCall('session.read', { sessionId, fullResults: true });
    const status = await hostCall('status.get', { sessionId });
    if (read.result?.header?.projectRoot === undefined || status.result?.sessionId !== sessionId) {
      throw new Error('old_session_record_not_recovered');
    }
    return `Host PID ${oldPid} 已结束；新 PID ${newPid} 接回旧会话并读回记录`;
  });

  await check('explain a session still held after the lock retry budget', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const oldHost = await hostProcessFor(applicationProcess.pid);
    const oldPid = Number(oldHost.pid);
    killHostImmediately(oldPid);
    await hostProcessGone(oldPid);
    const reconnectSelector = `([...document.querySelectorAll('.banner[role="alert"] button')]
      .find(button => /重新连接|Reconnect/u.test(button.textContent ?? '')) ?? null)`;
    await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} !== null`), 30_000, 'locked_session_disconnect_banner');
    const killedHostFaults = await devTools.evaluate('window.__packagedSmokeFaults.splice(0)');
    const unexpectedFaults = Array.isArray(killedHostFaults)
      ? killedHostFaults.filter(fault => !['host_closed:process-exit', 'host_closed:write-failed'].includes(fault))
      : ['host_fault_list_invalid'];
    if (unexpectedFaults.length > 0) throw new Error(`locked_session_unexpected_pre_reconnect_faults:${JSON.stringify(unexpectedFaults)}`);
    const lockHolder = await startLockHoldingHost(sessionId);
    let lockHolderClosed = false;
    try {
      const holderSnapshot = await lockHolder.observe();
      if (holderSnapshot.writerActive !== true) throw new Error('external_lock_holder_not_active');
      await devTools.evaluate(`(${reconnectSelector}).click(); true`);
      const newHostPid = Number((await hostProcessFor(applicationProcess.pid)).pid);
      if (newHostPid === oldPid || newHostPid === lockHolder.pid) throw new Error('locked_session_host_pid_invalid');
      const observationReady = () => devTools.evaluate(`(() => ({
        title: document.querySelector('#session-title')?.textContent?.trim() ?? '',
        mainComposerExists: document.querySelector('footer.composer:not(.external-session-composer) textarea.composer-input') !== null,
        statusBanners: [...document.querySelectorAll('.banner[role="status"]')].map(item => item.textContent?.trim() ?? ''),
      }))()`);
      try {
        await waitUntil(async () => (await observationReady()).statusBanners.some(text =>
          /外控 Agent 正在运行|另一个 Host 正在写入此会话|此会话当前没有活动写入者|An external agent is controlling this session|Another Host is writing to this conversation|This session has no active writer/u.test(text)),
        90_000, 'locked_session_observation_ready');
      } catch (error) {
        throw new Error(`locked_session_observation_state:${JSON.stringify(await observationReady())}`, { cause: error });
      }
      let appLockFailure;
      try { await hostCall('session.open', { sessionId, projectRoot: workspace }); }
      catch (error) { appLockFailure = error; }
      if (!(appLockFailure instanceof Error) || !appLockFailure.message.startsWith('session_locked:')) {
        throw new Error(`packaged_host_did_not_report_session_lock:${appLockFailure instanceof Error ? appLockFailure.message : 'opened'}`);
      }
      const observed = await devTools.evaluate(`(() => {
        const mainComposer = document.querySelector('footer.composer:not(.external-session-composer)');
        const mainInput = mainComposer?.querySelector('textarea.composer-input');
        const mainSend = mainComposer?.querySelector('button.send');
        return {
          title: document.querySelector('#session-title')?.textContent?.trim() ?? '',
          mainComposerExists: mainInput instanceof HTMLTextAreaElement,
          mainComposerReadOnly: mainInput instanceof HTMLTextAreaElement && mainInput.readOnly,
          mainSendDisabled: mainSend instanceof HTMLButtonElement && mainSend.disabled,
          externalComposerExists: document.querySelector('footer.external-session-composer textarea.composer-input') !== null,
          externalControlPanelExists: document.querySelector('.external-control') !== null,
          statusBanners: [...document.querySelectorAll('.banner[role="status"]')].map(item => item.textContent?.trim() ?? ''),
        };
      })()`);
      const problems = [];
      if (observed.title !== 'Packaged smoke record') problems.push('selected_session_changed');
      if (!observed.mainComposerExists || !observed.mainComposerReadOnly || !observed.mainSendDisabled) {
        problems.push('ordinary_session_composer_not_read_only');
      }
      if (observed.externalComposerExists || observed.externalControlPanelExists) problems.push('external_controls_shown_without_runtime');
      if (!observed.statusBanners.some(text => /另一个 Host 正在写入此会话|Another Host is writing to this conversation/u.test(text))) {
        problems.push('ordinary_host_misidentified_as_external_agent');
      }
      const lockNoticeVisible = observed.statusBanners.some(text =>
        /会话写入锁仍被占用|session writer lock is still held/u.test(text));
      if (!lockNoticeVisible) problems.push('readonly_lock_notice_missing');

      const lockedAppHost = await hostProcessFor(applicationProcess.pid);
      const lockedAppHostPid = Number(lockedAppHost.pid);
      killHostImmediately(lockedAppHostPid);
      await hostProcessGone(lockedAppHostPid);
      await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} !== null`), 10_000, 'readonly_host_disconnect_banner');
      const persistenceDeadline = Date.now() + 7_000;
      await waitUntil(async () => Date.now() >= persistenceDeadline, 8_000, 'readonly_disconnect_heartbeat_window');
      const disconnectBannerRemains = await devTools.evaluate(`${reconnectSelector} !== null`);
      if (disconnectBannerRemains !== true) problems.push('readonly_heartbeat_cleared_host_disconnect');
      if (problems.length > 0) throw new Error(`packaged_locked_session_ui:${JSON.stringify({ problems, observed, disconnectBannerRemains })}`);
      await lockHolder.close();
      lockHolderClosed = true;
      const disconnectedHostFaults = await devTools.evaluate('window.__packagedSmokeFaults.splice(0)');
      const unexpectedHostFaults = Array.isArray(disconnectedHostFaults)
        ? disconnectedHostFaults.filter(fault => !['host_closed:process-exit', 'host_closed:write-failed'].includes(fault))
        : ['host_fault_list_invalid'];
      if (unexpectedHostFaults.length > 0) throw new Error(`locked_session_unexpected_recovery_faults:${JSON.stringify(unexpectedHostFaults)}`);
      await devTools.evaluate(`(${reconnectSelector}).click(); true`);
      await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} === null`), 60_000, 'locked_session_host_reconnect');
      await waitUntil(async () => await devTools.evaluate(`(() => {
        const input = document.querySelector('footer.composer:not(.external-session-composer) textarea.composer-input');
        return document.querySelector('#session-title')?.textContent?.trim() === 'Packaged smoke record'
          && input instanceof HTMLTextAreaElement && !input.readOnly;
      })()`), 60_000, 'locked_session_reopened_with_write_access');
      return `Host PID ${oldPid} 与锁恢复 Host PID ${lockedAppHostPid} 均终止；外部 Host PID ${lockHolder.pid} 持锁时以只读观察，释放后重连并恢复写入；断连横幅跨过心跳周期保留`;
    } finally {
      if (!lockHolderClosed) await lockHolder.close();
    }
  });

  if (interruptionMode === undefined) {
    await check('clipboard write permission from the packaged secure page', async () => {
      await devTools.call('Page.bringToFront');
      await waitUntil(async () => await devTools.evaluate('document.hasFocus()'), 5_000, 'packaged_window_focus');
      const value = `Ligule packaged smoke ${Date.now()}`;
      const result = await devTools.evaluate(`(async () => {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return { available: false };
        await navigator.clipboard.writeText(${JSON.stringify(value)});
        return { available: true };
      })()`);
      if (result.available !== true) throw new Error('clipboard_writeText_unavailable');
      return 'navigator.clipboard.writeText 接受测试文本；没有读取系统剪贴板';
    });
  } else {
    record('clipboard write permission from the packaged secure page', '未执行', '请求中断验收不触碰系统剪贴板');
  }

  if (interruptionMode === undefined) {
    record(
      'unanswered Host promise across restart',
      '未执行',
      '隔离环境没有真实模型服务，无法建立可复现的未答 run.start；没有伪造模型或 Host 响应',
    );
  } else {
    if (interruptionMode === 'local') {
      await check('local model tool approval denial and allowance', async () => {
        if (sessionId === undefined) throw new Error('session_not_created');
        await setInitialPermission('workspace-write', 'policy');
        sessionId = await startUiSession('[LOCAL_APPROVAL_DENY] 通过 create 工具写入审批验收文件。');
        const denied = await runLocalApproval(sessionId, 'deny', true);
        const allowed = await runLocalApproval(sessionId, 'allow');
        return `以工作区可写、网络按 Policy 限制创建会话；${denied}；${allowed}`;
      });
    } else if (interruptionMode === 'real') {
      await check('start the official model request from the selected UI session', async () => {
        sessionId = await startUiSession('请用中文写一段较长的说明，不要调用工具。测试会在模型完整答复交给 Host 前中断本轮。');
        return `通过 packaged UI composer 创建并选中 Session ${sessionId}，由真实 UI 发送唯一官方模型请求`;
      });
    }
    await check('pending provider request, Host interruption, and session recovery', async () => {
      if (sessionId === undefined) throw new Error('session_not_created');
      return await runInterruptedRequest(sessionId, interruptionMode === 'real');
    });
  }

  await check('capture packaged window evidence', async () => {
    await captureEvidence();
    return '保存实际 packaged BrowserWindow 截图';
  });
}

function reportVersion(nodePath) {
  return execFileSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
}

async function closeApplication() {
  if (applicationProcess === undefined || applicationProcess.exitCode !== null) return;
  if (devTools !== undefined && !devTools.closed) {
    try { await devTools.evaluate('window.liguleDesktop.requestQuit()', 10_000); } catch {}
  }
  let gracefulTimer;
  const graceful = await Promise.race([
    processExit.then(() => true),
    new Promise(resolvePromise => { gracefulTimer = setTimeout(() => resolvePromise(false), 25_000); }),
  ]);
  clearTimeout(gracefulTimer);
  if (!graceful && applicationProcess.exitCode === null) {
    timedOut = true;
    applicationProcess.kill();
    let killTimer;
    await Promise.race([processExit, new Promise(resolvePromise => { killTimer = setTimeout(resolvePromise, 15_000); })]);
    clearTimeout(killTimer);
  }
}

async function run() {
  await check('isolate default workspace through a real Node 24 Host RPC', async () => {
    const result = await prepareIsolatedWorkspace();
    const registered = result.workspaces?.find(item => resolve(item.directory).toLowerCase() === resolve(workspace).toLowerCase());
    if (registered === undefined || result.default !== registered.identity) throw new Error('host_default_workspace_mismatch');
    return `预检 Host PID ${processIds.preflightHost} 通过 workspace.default.set 登记隔离工作区并正常退出`;
  });
  if (exitCode !== 0) {
    record('packaged application launch', '未执行', '隔离工作区预检失败；未启动 packaged application');
    await recordReport();
    return;
  }

  const { stdout, stderr } = await startApplication();
  // The Host-lock case has sequential bounded startup, lease, observe, and post-release reopen stages.
  // Keep this run-wide watchdog above those stage limits; each wait still reports its own failure label.
  const deadline = setTimeout(() => { timedOut = true; applicationProcess.kill(); }, 300_000);
  try {
    await runChecks();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interruptionMode === undefined) {
      record('packaged smoke harness', '失败', message.split('\n')[0].slice(0, 300));
    } else {
      const code = error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' && /^[a-z][a-z0-9_]{1,80}$/u.test(error.code)
        ? error.code
        : error instanceof Error && /^[a-z][a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : 'packaged_interruption_harness_failed';
      record('packaged smoke harness', '失败', `隔离验收步骤失败，错误码 ${code}`);
    }
    exitCode = 1;
  } finally {
    await closeApplication();
    clearTimeout(deadline);
    if (applicationProcess.exitCode !== null) processIds.applicationExitCode = applicationProcess.exitCode;
    try {
      const locks = await remainingSessionLocks();
      if (applicationProcess.exitCode === 0 && locks.length === 0) {
        record('Host session lock cleanup', '通过', '退出后隔离数据根中没有遗留 .jsonl.lock');
      } else {
        record('Host session lock cleanup', applicationProcess.exitCode === null || locks.length > 0 ? '失败' : '未执行', `exit=${applicationProcess.exitCode}; locks=${locks.length}`);
        if (applicationProcess.exitCode !== 0) exitCode = 1;
      }
    } catch (error) {
      record('Host session lock cleanup', '失败', error instanceof Error ? error.message : String(error));
      exitCode = 1;
    }
    if (timedOut || applicationProcess.exitCode !== 0) exitCode = 1;
    try { await recordReport(); } catch { exitCode = 1; }
    devTools?.socket.close();
    stdout?.end();
    stderr?.end();
    try {
      await Promise.all([stdout, stderr].filter(stream => stream !== undefined).map(stream => finished(stream)));
    } catch {
      exitCode = 1;
    }
  }
}

try {
  await run();
} finally {
  await providerGate?.close();
}

const relativeTemporary = relative(testRoot, temporaryRoot);
if (relativeTemporary === '' || relativeTemporary === '..' || relativeTemporary.startsWith(`..${sep}`) || resolve(testRoot, relativeTemporary) !== temporaryRoot) {
  throw new Error('packaged_smoke_temp_path_escaped_testplace');
}
if (exitCode === 0 && applicationProcess?.exitCode === 0) {
  await rm(temporaryRoot, { recursive: true, force: true });
} else {
  console.error(`packaged smoke temporary data retained at ${relative(testRoot, temporaryRoot)}`);
}

console.log(`${exitCode === 0 ? 'packaged smoke completed' : 'packaged smoke failed'}; evidence: ${relative(repositoryRoot, evidenceRoot)}`);
process.exitCode = exitCode;
