import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SPILL_NAME } from '@ligule/core/kernel/result.js';
import { sessionTurnToAtif } from '@ligule/core/session/atif.js';
import { setTrusted } from '@ligule/core/kernel/workspace-trust.js';

import { BENCHMARK_POLICY_MODE, policyModeForCli } from './policy-mode.mjs';

export { BENCHMARK_POLICY_MODE };

const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_SPILL_BYTES = 64 * 1024 * 1024;
const MAX_TASK_TIMEOUT_MS = 86_400_000;
const MAX_REQUEST_TIMEOUT_MS = 3_600_000;
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CLI_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
];

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function editArgumentShape(value) {
  if (!isObject(value)) return 'other';
  const anchor = Object.hasOwn(value, 'anchor');
  const replacement = Object.hasOwn(value, 'replacement');
  const changes = Object.hasOwn(value, 'changes');
  if (changes && (anchor || replacement)) return 'mixed';
  if (changes) return 'changes';
  if (anchor && replacement) return 'legacy_anchor';
  return 'other';
}

function editArgumentShapeSummary(events, userSeq) {
  const userIndex = events.findIndex((event) => event.kind === 'user' && event.seq === userSeq);
  if (userIndex < 0) throw new Error('atif_user_event_not_found');
  const nextUserIndex = events.findIndex((event, index) => index > userIndex && event.kind === 'user');
  const end = nextUserIndex < 0 ? events.length : nextUserIndex;
  const counts = () => ({ total: 0, legacy_anchor: 0, changes: 0, mixed: 0, other: 0 });
  const requested = counts();
  const recorded = counts();
  const add = (target, args) => {
    const shape = editArgumentShape(args);
    target.total += 1;
    target[shape] += 1;
  };
  for (const event of events.slice(userIndex + 1, end)) {
    if (event.kind === 'assistant' && Array.isArray(event.toolCalls)) {
      for (const call of event.toolCalls) {
        if (isObject(call) && call.name === 'edit') add(requested, call.args);
      }
    }
    if (event.kind === 'tool' && event.tool === 'edit') add(recorded, event.args);
  }
  return { version: 1, tool: 'edit', requested, recorded };
}

function safeCode(error) {
  const candidate = typeof error?.message === 'string' ? error.message : '';
  return /^[A-Za-z0-9_:-]{1,128}$/u.test(candidate) ? candidate : 'atif_export_failed';
}

async function readRegularFile(path, parentDirectory, maxBytes) {
  let before;
  try { before = await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('ligule_export_file_missing');
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error('ligule_export_file_invalid');
  }
  const realPath = await realpath(path);
  if (dirname(realPath) !== parentDirectory || basename(realPath) !== basename(path)) {
    throw new Error('ligule_export_file_outside_session');
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error('ligule_export_file_changed');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || bytes.length !== before.size || bytes.length > maxBytes) {
      throw new Error('ligule_export_file_changed');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function parseSession(sessionDirectory, sessionId, homeDirectory) {
  if (!isAbsolute(homeDirectory) || !isAbsolute(sessionDirectory)) throw new Error('ligule_export_paths_must_be_absolute');
  const home = resolve(homeDirectory);
  const sessions = resolve(sessionDirectory);
  if (sessions !== join(home, 'sessions')) throw new Error('ligule_export_session_directory_mismatch');
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error('ligule_export_home_invalid');
  const sessionInfo = await lstat(sessions);
  if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink()) throw new Error('ligule_export_session_directory_invalid');
  const homeReal = await realpath(home);
  const sessionsReal = await realpath(sessions);
  if (homeReal !== home || sessionsReal !== sessions || dirname(sessionsReal) !== homeReal) {
    throw new Error('ligule_export_session_directory_outside_home');
  }
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(sessionId) || /[\\/]/u.test(sessionId)) {
    throw new Error('ligule_export_session_id_invalid');
  }
  const sessionPath = join(sessions, `${sessionId}.jsonl`);
  const bytes = await readRegularFile(sessionPath, sessionsReal, MAX_SESSION_BYTES);
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) throw new Error('ligule_export_session_tail_incomplete');
  const lines = bytes.toString('utf8').split('\n');
  lines.pop();
  const objects = lines.map((line) => {
    let value;
    try { value = JSON.parse(line); }
    catch { throw new Error('ligule_export_session_json_invalid'); }
    if (!isObject(value)) throw new Error('ligule_export_session_record_invalid');
    return value;
  });
  const header = objects[0];
  if (header?.kind !== 'session' || header.sessionId !== sessionId) throw new Error('ligule_export_session_header_mismatch');
  return { events: objects.filter((event) => event.kind !== 'session'), sessionsReal };
}

async function restoreSpills(events, userSeq, sessionsReal) {
  const userIndex = events.findIndex((event) => event.kind === 'user' && event.seq === userSeq);
  if (userIndex < 0) throw new Error('atif_user_event_not_found');
  const nextUserIndex = events.findIndex((event, index) => index > userIndex && event.kind === 'user');
  const end = nextUserIndex < 0 ? events.length : nextUserIndex;
  for (const event of events.slice(userIndex + 1, end)) {
    if (event.kind !== 'tool' || !isObject(event.result) || event.result.spilled === undefined) continue;
    const result = event.result;
    const name = result.spilled;
    if (typeof name !== 'string' || !SPILL_NAME.test(name) || basename(name) !== name) {
      throw new Error('ligule_export_spill_name_invalid');
    }
    if ((result.spillFormat !== 'text' && result.spillFormat !== 'json') || typeof result.content !== 'string') {
      throw new Error('ligule_export_spill_metadata_invalid');
    }
    const note = /\[omitted: full output is ([0-9]+) bytes, kept in ([^\]]+)\]/u.exec(result.content);
    if (note === null || note[2] !== name) throw new Error('ligule_export_spill_reference_missing');
    const bytes = await readRegularFile(join(sessionsReal, name), sessionsReal, MAX_SPILL_BYTES);
    if (bytes.length !== Number(note[1])) throw new Error('ligule_export_spill_size_mismatch');
    const fullText = bytes.toString('utf8');
    if (!Buffer.from(fullText, 'utf8').equals(bytes)) throw new Error('ligule_export_spill_encoding_invalid');
    if (result.spillFormat === 'json') {
      try { JSON.parse(fullText); }
      catch { throw new Error('ligule_export_spill_json_invalid'); }
    }
    result.content = fullText;
    delete result.spilled;
    delete result.spillFormat;
  }
}

async function writeJson(destination, value) {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('ligule_export_logs_directory_invalid');
  if (await realpath(directory) !== resolve(directory)) throw new Error('ligule_export_logs_directory_invalid');
  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.part`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await lstat(destination).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (existing !== undefined) throw new Error('ligule_export_output_exists');
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function exportSession({
  homeDirectory,
  sessionDirectory,
  sessionId,
  runId,
  agentVersion,
  modelName,
  logsDirectory,
  expectedState,
  includeSensitiveContent = false,
}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('ligule_export_run_id_invalid');
  if (typeof agentVersion !== 'string' || agentVersion === '') throw new Error('ligule_export_agent_version_required');
  if (modelName !== undefined && typeof modelName !== 'string') throw new Error('ligule_export_model_invalid');
  if (!isAbsolute(logsDirectory) || basename(resolve(logsDirectory)) !== 'agent') {
    throw new Error('ligule_export_logs_directory_invalid');
  }
  const { events, sessionsReal } = await parseSession(sessionDirectory, sessionId, homeDirectory);
  const matchingUsers = events.filter((event) => event.kind === 'user' && isObject(event.run) && event.run.runId === runId);
  if (matchingUsers.length !== 1) throw new Error('ligule_export_run_acceptance_missing_or_ambiguous');
  const user = matchingUsers[0];
  const terminals = events.filter((event) => event.kind === 'turn' && event.userSeq === user.seq);
  if (terminals.length !== 1 || terminals[0].runId !== runId
    || !['completed', 'failed', 'cancelled', 'interrupted'].includes(String(terminals[0].status))) {
    throw new Error('ligule_export_run_terminal_missing_or_invalid');
  }
  if (expectedState !== undefined && terminals[0].status !== expectedState) {
    throw new Error('ligule_export_run_terminal_mismatch');
  }
  await restoreSpills(events, user.seq, sessionsReal);
  const trajectory = sessionTurnToAtif(events, {
    sessionId,
    userSeq: user.seq,
    runId,
    agentName: 'ligule',
    agentVersion,
    ...(modelName === undefined ? {} : { modelName }),
  }, { includeSensitiveContent });
  await writeJson(join(resolve(logsDirectory), 'edit-argument-shapes.json'), editArgumentShapeSummary(events, user.seq));
  await writeJson(join(resolve(logsDirectory), 'trajectory.json'), trajectory);
  return trajectory;
}

function takeOption(args, name, required = true) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`ligule_export_option_missing_${name.slice(2).replaceAll('-', '_')}`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`ligule_export_option_value_missing_${name.slice(2).replaceAll('-', '_')}`);
  args.splice(index, 2);
  return value;
}

export function parseCliResult(stdout, returnCode) {
  let value;
  try { value = JSON.parse(stdout.trim()); }
  catch { throw new Error('ligule_cli_result_invalid_json'); }
  if (!isObject(value) || value.version !== 1 || !['completed', 'failed'].includes(value.status)
    || !['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(value.state)) {
    throw new Error('ligule_cli_result_invalid');
  }
  if ((returnCode === 0 && (value.status !== 'completed' || value.state !== 'completed'))
    || (returnCode !== 0 && (value.status !== 'failed' || value.state === 'completed'))) {
    throw new Error('ligule_cli_result_terminal_mismatch');
  }
  const result = { version: 1, status: value.status, state: value.state };
  for (const key of ['sessionId', 'runId']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key] === '' || value[key].length > 256) throw new Error(`ligule_cli_result_${key}_invalid`);
      result[key] = value[key];
    }
  }
  if (value.errorCode !== undefined) {
    if (typeof value.errorCode !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/u.test(value.errorCode)) {
      throw new Error('ligule_cli_result_error_code_invalid');
    }
    result.errorCode = value.errorCode;
  }
  if (isObject(value.usage)) {
    result.usage = Object.fromEntries(['iterations', 'modelCalls'].filter((key) =>
      Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0).map((key) => [key, value.usage[key]]));
  }
  return result;
}

export function runCli(cli, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cli, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const output = [];
    let outputBytes = 0;
    let failure;
    let killTimer;
    const terminate = (signal) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    };
    const stop = (error, signal = 'SIGTERM') => {
      if (failure !== undefined) return;
      failure = error;
      terminate(signal);
      killTimer = setTimeout(() => terminate('SIGKILL'), 5_000);
      killTimer.unref();
    };
    const onSigint = () => stop(Object.assign(new Error('ligule_process_cancelled'), { code: 'ECANCELED' }));
    const onSigterm = () => stop(Object.assign(new Error('ligule_process_cancelled'), { code: 'ECANCELED' }));
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    const timeout = setTimeout(() => stop(Object.assign(new Error('ligule_process_timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    timeout.unref();
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) stop(Object.assign(new Error('ligule_process_output_too_large'), { code: 'EOVERFLOW' }), 'SIGKILL');
      else output.push(chunk);
    });
    child.once('error', (error) => { failure ??= error; });
    child.once('close', (status) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve({ error: failure, status, stdout: Buffer.concat(output).toString('utf8') });
    });
  });
}

export function buildCliArgs({ instruction, sessionDirectory, api, baseUrl, model, apiKeyEnv, modelCalls, timeoutMs, requestTimeoutMs, outputTokens, policyMode }) {
  if (api !== 'messages' && api !== 'chat-completions') throw new Error('ligule_api_unsupported');
  const actualPolicyMode = policyModeForCli(policyMode);
  if (!isAbsolute(sessionDirectory) || typeof model !== 'string' || model.trim() === '' || model.length > 256
    || typeof instruction !== 'string' || instruction.trim() === '') throw new Error('ligule_run_input_invalid');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('ligule_base_url_invalid');
  if (!ENV_NAME.test(apiKeyEnv)) throw new Error('ligule_api_key_env_invalid');
  if (!Number.isSafeInteger(modelCalls) || modelCalls < 1 || modelCalls > 64
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TASK_TIMEOUT_MS
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || requestTimeoutMs > Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS)) throw new Error('ligule_run_budget_invalid');
  if (outputTokens !== undefined && (!Number.isSafeInteger(outputTokens) || outputTokens < 1)) {
    throw new Error('ligule_run_output_tokens_invalid');
  }
  const values = [
    ['host.sessionDirectory', sessionDirectory], ['model.api', api], ['model.baseURL', baseUrl],
    ['model.model', model], ['model.apiKeyEnv', apiKeyEnv], ['loop.modelCalls', modelCalls],
    ['loop.totalModelCalls', modelCalls], ['loop.taskTimeoutMs', timeoutMs], ['loop.requestTimeoutMs', requestTimeoutMs],
    ['policy.mode', actualPolicyMode],
  ];
  if (outputTokens !== undefined) values.push(['model.outputTokens', outputTokens]);
  return [
    'run', '--json', '--allow-full-access',
    ...values.flatMap(([key, value]) => ['--config', `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`]),
    instruction,
  ];
}

export function buildCliEnvironment(source, homeDirectory, apiKeyEnv) {
  if (!isAbsolute(homeDirectory) || !ENV_NAME.test(apiKeyEnv) || apiKeyEnv === 'LIGULE_HOME'
    || CLI_ENV_ALLOWLIST.includes(apiKeyEnv) || /^(NODE_|LD_|DYLD_)/u.test(apiKeyEnv)) {
    throw new Error('ligule_cli_environment_invalid');
  }
  const env = Object.fromEntries(CLI_ENV_ALLOWLIST.filter((name) => typeof source[name] === 'string')
    .map((name) => [name, source[name]]));
  env.LIGULE_HOME = homeDirectory;
  if (typeof source[apiKeyEnv] === 'string' && source[apiKeyEnv] !== '') env[apiKeyEnv] = source[apiKeyEnv];
  return env;
}

async function writeResult(logsDirectory, result) {
  await writeJson(join(resolve(logsDirectory), 'ligule-result.json'), result);
}

// 基准容器里没有交互式信任确认，任务目录必须由评测器显式信任；
// 工作区信任与计划选择的 Policy 模式是独立状态。
export async function ensureWorkspaceTrust(directory) {
  await setTrusted(directory, true);
}

async function runMode(args) {
  const instructionFile = takeOption(args, '--instruction-file');
  const sessionDirectory = takeOption(args, '--session-directory');
  const homeDirectory = takeOption(args, '--home-directory');
  const logsDirectory = takeOption(args, '--logs-directory');
  const cli = takeOption(args, '--cli');
  const agentVersion = takeOption(args, '--agent-version');
  const api = takeOption(args, '--model-api');
  const baseUrl = takeOption(args, '--base-url');
  const model = takeOption(args, '--model');
  const apiKeyEnv = takeOption(args, '--api-key-env');
  const modelCalls = Number(takeOption(args, '--model-calls'));
  const timeoutMs = Number(takeOption(args, '--timeout-ms'));
  const requestTimeoutMs = Number(takeOption(args, '--request-timeout-ms'));
  const policyMode = takeOption(args, '--policy-mode', false);
  const outputTokensValue = takeOption(args, '--output-tokens', false);
  const outputTokens = outputTokensValue === undefined ? undefined : Number(outputTokensValue);
  if (args.length > 0) throw new Error('ligule_export_unexpected_arguments');
  if (!isAbsolute(instructionFile) || !isAbsolute(cli) || !isAbsolute(homeDirectory)
    || process.env.LIGULE_HOME !== homeDirectory) throw new Error('ligule_run_paths_invalid');
  const homeReal = await realpath(homeDirectory);
  const instructionBytes = await readRegularFile(instructionFile, homeReal, 1_000_000);
  const instruction = instructionBytes.toString('utf8');
  if (!Buffer.from(instruction, 'utf8').equals(instructionBytes)) throw new Error('ligule_instruction_encoding_invalid');
  await unlink(instructionFile);
  if (instruction.trim() === '') throw new Error('ligule_instruction_empty');
  await ensureWorkspaceTrust(process.cwd());

  const child = await runCli(cli, buildCliArgs({
    instruction, sessionDirectory, api, baseUrl, model, apiKeyEnv, modelCalls, timeoutMs, requestTimeoutMs, outputTokens, policyMode,
  }), {
    cwd: process.cwd(),
    env: buildCliEnvironment(process.env, homeDirectory, apiKeyEnv),
    timeoutMs: timeoutMs + 30_000,
  });

  let result;
  if (child.error !== undefined) {
    const errorCode = child.error.code === 'ETIMEDOUT' ? 'ligule_process_timeout'
      : child.error.code === 'ECANCELED' ? 'ligule_process_cancelled' : 'ligule_process_error';
    result = { version: 1, status: 'failed', state: 'unknown', errorCode };
  } else {
    try { result = parseCliResult(child.stdout ?? '', child.status ?? 1); }
    catch (error) { result = { version: 1, status: 'failed', state: 'unknown', errorCode: safeCode(error) }; }
  }
  if (typeof result.sessionId !== 'string' || typeof result.runId !== 'string') {
    await writeResult(logsDirectory, result);
    process.exitCode = 1;
    return;
  }
  try {
    await exportSession({
      homeDirectory,
      sessionDirectory,
      sessionId: result.sessionId,
      runId: result.runId,
      agentVersion,
      modelName: model,
      logsDirectory,
      expectedState: result.state,
      includeSensitiveContent: args.includes('--include-sensitive-content'),
    });
  } catch (error) {
    result.atifErrorCode = safeCode(error);
    process.stderr.write(`${result.atifErrorCode}\n`);
    process.exitCode = 1;
  }
  await writeResult(logsDirectory, result);
  if (!isScorableTrial(result)) process.exitCode = 1;
}

// 代理层面的失败（预算耗尽、模型调用失败、被中断）仍是一次可评分的 trial：
// 它跑出了会话，就让 verifier 对它留下的工作区打分，而不是记成 agent error
// 把这一题挤出分母。没有会话说明评测本身没跑起来，那才是基础设施故障。
export function isScorableTrial(result) {
  return isObject(result) && typeof result.sessionId === 'string' && typeof result.runId === 'string';
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  try {
    if (mode === 'run') await runMode(args);
    else if (mode === 'export') {
      const options = {
        homeDirectory: takeOption(args, '--home-directory'),
        sessionDirectory: takeOption(args, '--session-directory'),
        sessionId: takeOption(args, '--session-id'),
        runId: takeOption(args, '--run-id'),
        agentVersion: takeOption(args, '--agent-version'),
        modelName: takeOption(args, '--model-name', false),
        logsDirectory: takeOption(args, '--logs-directory'),
        includeSensitiveContent: args.includes('--include-sensitive-content'),
      };
      args.splice(args.indexOf('--include-sensitive-content') < 0 ? args.length : args.indexOf('--include-sensitive-content'), 1);
      if (args.length > 0) throw new Error('ligule_export_unexpected_arguments');
      await exportSession(options);
    } else throw new Error('ligule_export_mode_invalid');
  } catch (error) {
    process.stderr.write(`${safeCode(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
