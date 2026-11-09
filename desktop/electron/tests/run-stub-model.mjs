// 本地 stub 模型的 Desktop 回归：用同一套真实窗口驱动 harness（run-real-model.cjs），
// Host 连接本进程内的固定 SSE 服务，验证外控会话的人类观察、答复、补充、审批、取消与接管。
// 它替代不了真实模型验收：证据目录 `stub-model-*`、报告名 `stub-model.json`、
// 场景名前缀与 provider 字段都写明这是本地 stub。真实模型验收仍走 run-real-model.mjs。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const electronDirectory = dirname(testDirectory);
const desktopDirectory = dirname(electronDirectory);
const repositoryRoot = dirname(desktopDirectory);
const testRoot = resolve(process.env.LIGULE_DESKTOP_TEST_ROOT ?? join(desktopDirectory, 'testplace'));
const temporaryParent = resolve(process.env.LIGULE_DESKTOP_TEST_TEMP ?? join(testRoot, 'tmp'));
const evidenceParent = resolve(process.env.LIGULE_DESKTOP_TEST_EVIDENCE ?? join(testRoot, 'readings'));
const workspaceRegistrationTimeoutMs = Number(process.env.LIGULE_DESKTOP_TEST_STARTUP_TIMEOUT_MS ?? 60_000);
if (!Number.isSafeInteger(workspaceRegistrationTimeoutMs) || workspaceRegistrationTimeoutMs < 1) {
  throw new Error('stub_model_startup_timeout_invalid');
}
const executable = resolve(process.env.LIGULE_DESKTOP_TEST_ELECTRON ?? createRequire(join(desktopDirectory, 'package.json'))('electron'));
const harness = join(testDirectory, 'run-real-model.cjs');
const node = resolve(process.env.LIGULE_DESKTOP_TEST_NODE
  ?? join(desktopDirectory, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
const cli = join(repositoryRoot, 'core', 'dist', 'host', 'desktop-entry.js');
const mcpFixture = join(repositoryRoot, 'tests', 'fixtures', 'mcp-minimal.mjs');
const hostEntry = join(electronDirectory, 'dist', 'host-entry.js');
const frontend = join(desktopDirectory, 'frontend', 'dist', 'index.html');
const electronModules = ['secure-window.js', 'security.js', 'ipc.js', 'host.js', 'runtime.js', 'native.js', 'preload.js', 'host-entry.js']
  .map(name => join(electronDirectory, 'dist', name));
const required = [executable, harness, node, cli, hostEntry, frontend, ...electronModules, join(desktopDirectory, 'assets', 'app-icon.png')];
const missing = required.filter(path => !existsSync(path));
if (missing.length > 0) throw new Error(`stub_model_prerequisite_missing:${missing.map(basename).join(',')}`);

const PROOF_FILES = [
  { name: 'model-denial-proof.txt', content: 'DENIED' },
  { name: 'model-allow-proof.txt', content: 'ALLOWED' },
];
const providerLabel = '本地 stub 模型';
const externalControlGapOnly = process.argv.includes('--external-control-gap-only');
const externalControlOnly = externalControlGapOnly || process.argv.includes('--external-control-only');
const providerRequests = [];
let externalFetchCount = 0;
// 启用后只记录新请求而不返回响应，用于验证界面在请求等待期间的行为。
let hangRequests = false;
const skillMcpProof = { skillToolAvailable: false, skillActivated: false, mcpInspectAvailable: false, mcpCallAvailable: false, mcpInspectRequested: false };
const mcpInspectWireName = wireToolName('mcp.inspect');
const mcpCallWireName = wireToolName('mcp.call');
let workspaceRegistrationMs = null;

function wireToolName(name) {
  if (/^[A-Za-z0-9_-]{1,64}$/u.test(name)) return name;
  return `ligule_${createHash('sha256').update(name).digest('hex').slice(0, 48)}`;
}

function streamChunk(response, chunk) {
  if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

function respondWithTool(response, name, args, id) {
  streamChunk(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  streamChunk(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  response.write('data: [DONE]\n\n');
  response.end();
}

const server = createServer(async (request, response) => {
  const url = request.url ?? '';
  if (url.startsWith('/stub/')) {
    if (request.method === 'GET' && url === '/stub/state') {
      const sessionQuestionFollowups = providerRequests.filter(item => item.sessionQuestionTurn && item.followup);
      jsonResponse(response, 200, {
        requests: providerRequests.length,
        hang: hangRequests,
        skillMcpProof,
        externalFetchCount,
        externalGapRequests: providerRequests.filter(item => item.gapStreamChunks === 180).length,
        sessionQuestionFollowups: sessionQuestionFollowups.length,
        lastSessionQuestionAnswer: sessionQuestionFollowups.at(-1)?.sessionQuestionAnswer ?? null,
      });
      return;
    }
    if (request.method === 'GET' && url === '/stub/external-fetch-target') {
      externalFetchCount += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('EXTERNAL_FETCH_APPROVED');
      return;
    }
    if (request.method === 'POST' && url === '/stub/hang') {
      const parts = [];
      for await (const chunk of request) parts.push(chunk);
      const body = parts.length === 0 ? {} : JSON.parse(Buffer.concat(parts).toString('utf8'));
      hangRequests = body.hang === true;
      jsonResponse(response, 200, { hang: hangRequests });
      return;
    }
    jsonResponse(response, 404, { error: 'stub_control_path_unknown' });
    return;
  }
  if (request.method !== 'POST' || !url.endsWith('/chat/completions')) {
    jsonResponse(response, 404, { error: { message: 'stub_model_path_unknown' } });
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const followup = messages.at(-1)?.role === 'tool';
  const sessionQuestionTurn = messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('desktop-session-question-draft'));
  const sessionQuestionAnswer = sessionQuestionTurn && followup ? String(messages.at(-1)?.content ?? '') : '';
  const externalQuestionTurn = messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('desktop-external-control-question'));
  const externalApprovalTurn = messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('desktop-external-control-approval'));
  const externalGapTurn = prompt.includes('desktop-external-control-gap');
  const workflowMarker = 'desktop-skill-mcp-load-proof';
  const workflowStart = messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(workflowMarker));
  const workflowStep = workflowStart < 0 ? -1 : messages.slice(workflowStart + 1).filter(message => message.role === 'tool').length;
  const target = PROOF_FILES.find(item => prompt.includes(item.name));
  providerRequests.push({
    stream: body.stream === true,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    followup,
    sessionQuestionTurn,
    ...(sessionQuestionAnswer === '' ? {} : {
      sessionQuestionAnswer: {
        includesOption: sessionQuestionAnswer.includes('north'),
        includesDraft: sessionQuestionAnswer.includes('desktop-session-question-draft-answer'),
      },
    }),
    toolCall: followup ? null : target?.name ?? null,
    ...(externalGapTurn ? { gapStreamChunks: 180 } : {}),
    skillMcpStep: workflowStep < 0 ? null : workflowStep,
    ...(workflowStep < 0 ? {} : { skillMcpProof: { ...skillMcpProof } }),
    hung: hangRequests,
  });
  // 保持连接打开但不返回响应，使 Host 持续等待模型结果。
  if (hangRequests) return;
  let closed = false;
  response.on('close', () => { closed = true; });
  const finish = reason => {
    streamChunk(response, { choices: [{ index: 0, finish_reason: reason, delta: {} }] });
    response.write('data: [DONE]\n\n');
    response.end();
  };
  if (prompt.includes('desktop-code-copy-proof')) {
    streamChunk(response, { choices: [{ index: 0, delta: { content: '```js\nconsole.log("原始代码🙂 <img src=x onerror=alert(1)>");\n```' } }] });
    finish('stop');
    return;
  }
  if (followup) {
    if (externalApprovalTurn) {
      streamChunk(response, { choices: [{ index: 0, delta: { content: '外控审批已通过。' } }] });
      finish('stop');
      return;
    }
    if (externalQuestionTurn) {
      streamChunk(response, { choices: [{ index: 0, delta: { content: '外控问题已收到人类答复。' } }] });
      finish('stop');
      return;
    }
    if (sessionQuestionTurn) {
      streamChunk(response, { choices: [{ index: 0, delta: { content: '普通会话问题已收到人类答复。' } }] });
      finish('stop');
      return;
    }
    if (workflowStep === 1) {
      const skill = body.tools?.find(item => item.function?.name === 'skill');
      const inspect = body.tools?.find(item => item.function?.name === mcpInspectWireName);
      const call = body.tools?.find(item => item.function?.name === mcpCallWireName);
      skillMcpProof.skillToolAvailable = skill !== undefined;
      skillMcpProof.skillActivated = String(messages.at(-1)?.content ?? '').includes('SKILL_LOAD_PROOF');
      skillMcpProof.mcpInspectAvailable = inspect !== undefined;
      skillMcpProof.mcpCallAvailable = call !== undefined;
      if (inspect !== undefined && call !== undefined) {
        skillMcpProof.mcpInspectRequested = true;
        respondWithTool(response, mcpInspectWireName, { server: 'fixture', tool: 'echo' }, 'stub-untrusted-mcp-inspect');
      } else {
        streamChunk(response, { choices: [{ index: 0, delta: { content: 'Skill 已激活；当前会话未披露预期的 MCP 工具。' } }] });
        finish('stop');
      }
      return;
    }
    if (workflowStep === 2) {
      streamChunk(response, { choices: [{ index: 0, delta: { content: 'MCP inspect 请求已返回；Host 记录中的结果用于检查 Server 信任拒绝。' } }] });
      finish('stop');
      return;
    }
    streamChunk(response, { choices: [{ index: 0, delta: { content: '已按界面决定停止，目标文件没有被写入。' } }] });
    finish('stop');
    return;
  }
  if (workflowStep === 0) {
    respondWithTool(response, 'skill', { action: 'activate', name: 'desktop-smoke' }, 'stub-skill-mcp-activate');
    return;
  }
  if (prompt.includes('desktop-external-control-question')) {
    respondWithTool(response, 'ask_user_question', {
      questions: JSON.stringify([{ question: 'Choose a route', options: [{ label: 'north' }, { label: 'south' }], multiSelect: false }]),
    }, 'stub-external-human-question');
    return;
  }
  if (externalGapTurn) {
    for (let index = 0; index < 180 && !closed; index += 1) {
      streamChunk(response, { choices: [{ index: 0, delta: { content: `P6 desktop retained stream piece ${String(index).padStart(3, '0')}.` } }] });
    }
    finish('stop');
    return;
  }
  if (prompt.includes('desktop-session-question-draft')) {
    respondWithTool(response, 'ask_user_question', {
      questions: JSON.stringify([{ question: 'Choose a session route', options: [{ label: 'north' }, { label: 'south' }], multiSelect: false }]),
    }, 'stub-session-question-draft');
    return;
  }
  if (prompt.includes('desktop-external-control-approval')) {
    respondWithTool(response, 'fetch', { url: externalFetchTarget }, 'stub-external-human-approval');
    return;
  }
  if (prompt.includes('desktop-human-control-followup')) {
    streamChunk(response, { choices: [{ index: 0, delta: { content: '已收到人类补充消息。' } }] });
    finish('stop');
    return;
  }
  if (target !== undefined) {
    const args = JSON.stringify({ path: target.name, content: target.content });
    const split = Math.ceil(args.length / 2);
    streamChunk(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `stub_call_${target.name}`, type: 'function', function: { name: 'create', arguments: '' } }] } }] });
    streamChunk(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, split) } }] } }] });
    streamChunk(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] } }] });
    finish('tool_calls');
    return;
  }
  for (let index = 0; index < 200 && !closed; index += 1) {
    streamChunk(response, { choices: [{ index: 0, delta: { content: `本地 stub 模型第 ${index + 1} 段文本，用于验证界面流式取消。` } }] });
    await delay(60);
  }
  if (!closed) finish('stop');
});

await new Promise((resolvePromise, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolvePromise);
});
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const externalFetchTarget = new URL('/stub/external-fetch-target', endpoint).href;

const runId = new Date().toISOString().replace(/[:.]/gu, '-');
await mkdir(temporaryParent, { recursive: true });
await mkdir(evidenceParent, { recursive: true });
const temporaryRoot = await mkdtemp(join(temporaryParent, `stub-model-${runId}-`));
const evidenceRoot = join(evidenceParent, `stub-model-${runId}`);
const isolatedHome = join(temporaryRoot, 'ligule-home');
const userData = join(temporaryRoot, 'electron-user-data');
const workspace = join(temporaryRoot, 'workspaces', 'project');
const skillDirectory = join(workspace, '.agents', 'skills', 'desktop-smoke');
const modeDirectory = join(workspace, '.ligule', 'modes');
const schemaPath = join(temporaryRoot, 'mcp-echo-schema.json');
await Promise.all([
  mkdir(isolatedHome, { recursive: true }),
  mkdir(userData, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(skillDirectory, { recursive: true }),
  mkdir(modeDirectory, { recursive: true }),
  mkdir(evidenceRoot, { recursive: true }),
]);
await writeFile(join(modeDirectory, 'minimal.toml'), [
  "tools = ['exec', 'managed_process', 'find', 'search', 'read', 'create', 'write', 'edit', 'delete', 'fetch']",
  'prompt = []',
  '',
].join('\n'), 'utf8');
await writeFile(join(skillDirectory, 'SKILL.md'), [
  '---',
  'name: desktop-smoke',
  'description: Verify that a project skill loads and can use its configured MCP fixture.',
  'metadata:',
  '  ligule-requires: mcp:fixture',
  '---',
  '',
  'SKILL_LOAD_PROOF: this project skill was activated in the isolated Electron acceptance run.',
      'If this session does not expose MCP tools, explain that its permissions keep them unavailable.',
  '',
].join('\n'), 'utf8');
await writeFile(schemaPath, `${JSON.stringify({
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
}, null, 2)}\n`, 'utf8');
await writeFile(join(isolatedHome, 'config.toml'), [
  '[model]',
  'api = "chat-completions"',
  `baseURL = ${JSON.stringify(endpoint)}`,
  'model = "stub-model"',
  'apiKeyEnv = "LIGULE_API_KEY"',
  '',
  '[policy]',
  'mode = "ask"',
  '',
  '[mcp.servers.fixture]',
  `command = ${JSON.stringify(node)}`,
  `args = ${JSON.stringify([mcpFixture, schemaPath])}`,
  `cwd = ${JSON.stringify(workspace)}`,
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 });

const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (/(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_PASSWORD)$/iu.test(name)) delete environment[name];
}
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LIGULE_API_KEY']) delete environment[name];
environment.LIGULE_HOME = isolatedHome;
environment.LIGULE_RUNTIME_NODE = node;
environment.LIGULE_API_KEY = 'stub-model-key';
environment.LIGULE_REAL_MODEL_WORKSPACE = workspace;
environment.LIGULE_REAL_MODEL_EVIDENCE = evidenceRoot;
environment.LIGULE_REAL_MODEL_USER_DATA = userData;
environment.LIGULE_MODEL_PROVIDER_LABEL = providerLabel;
environment.LIGULE_MODEL_EVIDENCE_NAME = 'stub-model';
environment.LIGULE_STUB_CONTROL = `http://127.0.0.1:${server.address().port}/stub`;
environment.LIGULE_STUB_FETCH_TARGET = externalFetchTarget;
environment.LIGULE_EXTERNAL_CONTROL_TEST = '1';
if (externalControlOnly) environment.LIGULE_EXTERNAL_CONTROL_ONLY = '1';
if (externalControlGapOnly) environment.LIGULE_EXTERNAL_CONTROL_GAP_ONLY = '1';

async function registerIsolatedWorkspace() {
  const startedAt = process.hrtime.bigint();
  const preflight = spawn(node, [hostEntry, cli], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let preflightStderr = '';
  preflight.stderr.setEncoding('utf8');
  preflight.stderr.on('data', chunk => { preflightStderr = `${preflightStderr}${chunk}`.slice(-12_000); });
  let output = '';
  let responseTimer;
  const response = new Promise((resolvePromise, reject) => {
    responseTimer = setTimeout(() => {
      preflight.kill();
      reject(new Error(`stub_model_workspace_registration_timeout:stderr=${preflightStderr.slice(-2_000)};stdout=${output.slice(-2_000)}`));
    }, workspaceRegistrationTimeoutMs);
    preflight.once('error', error => { clearTimeout(responseTimer); reject(error); });
    preflight.stdout.setEncoding('utf8');
    preflight.stdout.on('data', chunk => {
      output += chunk;
      let end = output.indexOf('\n');
      while (end >= 0) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.id === 'stub-model-workspace-default') {
            clearTimeout(responseTimer);
            resolvePromise(frame);
          }
        } catch {}
        end = output.indexOf('\n');
      }
    });
  });
  const exit = new Promise(resolvePromise => {
    preflight.once('error', () => resolvePromise({ exitCode: 1, signal: null }));
    preflight.once('exit', (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
  preflight.stdin.write(`${JSON.stringify({
    id: 'stub-model-workspace-default',
    method: 'workspace.default.set',
    params: { directory: workspace, name: 'Stub model verification' },
  })}\n`);
  try {
    const frame = await response;
    if (frame.error !== undefined) throw new Error(`stub_model_workspace_registration_failed:${frame.error.code ?? 'host_error'}`);
    preflight.stdin.end();
    preflight.disconnect();
    const processExit = await exit;
    if (processExit.exitCode !== 0) throw new Error('stub_model_workspace_registration_host_exit');
  } catch (error) {
    clearTimeout(responseTimer);
    if (preflight.exitCode === null) preflight.kill();
    await exit.catch(() => {});
    throw error;
  } finally {
    workspaceRegistrationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  }
}

let childExitCode = null;
let childSignal = null;
let standardOutput = '';
let standardError = '';
try {
  await registerIsolatedWorkspace();
  const child = spawn(executable, [`--user-data-dir=${userData}`, harness], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  delete environment.LIGULE_API_KEY;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { standardOutput += chunk; });
  child.stderr.on('data', chunk => { standardError += chunk; });
  const timeout = setTimeout(() => child.kill(), 240_000);
  const exit = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolvePromise({ exitCode, exitSignal }));
  });
  clearTimeout(timeout);
  childExitCode = exit.exitCode;
  childSignal = exit.exitSignal;
} catch (error) {
  standardError += `${error instanceof Error ? error.message : String(error)}\n`;
  childExitCode = 1;
} finally {
  server.close();
}

const results = [];
for (const line of standardOutput.split(/\r?\n/u)) {
  const text = line.trim();
  if (!text.startsWith('{')) continue;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.name === 'string' && typeof parsed?.status === 'string') {
      results.push({ name: parsed.name, status: parsed.status, ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}), ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}) });
    }
  } catch {}
}

const report = {
  command: `${process.env.LIGULE_DESKTOP_TEST_NODE === undefined ? relative(repositoryRoot, node) : 'LIGULE_DESKTOP_TEST_NODE'} desktop/electron/tests/run-stub-model.mjs${externalControlGapOnly ? ' --external-control-gap-only' : externalControlOnly ? ' --external-control-only' : ''}`,
  workspaceRegistrationMs,
  provider: 'local-stub',
  providerNote: '本地 stub 模型：只验证 Desktop 窗口、审批与取消联动，不构成真实模型验收。',
  platform: process.platform,
  endpoint,
  providerRequests,
  skillMcpProof,
  childExitCode,
  childSignal,
  results,
};
const evidenceFile = join(evidenceRoot, 'run.json');
await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const passed = childExitCode === 0 && results.length > 0 && results.every(item => item.status === '通过' || item.status === '未执行');
if (!passed) {
  await writeFile(join(evidenceRoot, 'stdout.log'), standardOutput, 'utf8');
  await writeFile(join(evidenceRoot, 'stderr.log'), standardError, 'utf8');
  console.error(`stub model verification did not pass; evidence: ${relative(desktopDirectory, evidenceRoot).split(sep).join('/')}`);
  process.exitCode = 1;
} else {
  await rm(temporaryRoot, { recursive: true, force: true });
  console.log(`stub model verification passed; evidence: ${relative(desktopDirectory, evidenceRoot).split(sep).join('/')}`);
}
