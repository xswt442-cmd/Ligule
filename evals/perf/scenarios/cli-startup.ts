import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Scenario, ScenarioResult, Sample } from '../lib.ts';
import { MOCK_CREDENTIAL, startMockMessagesProvider } from '../provider.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));

function childEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.LIGULE_HOME = home;
  environment.LIGULE_BENCH_API_KEY = MOCK_CREDENTIAL;
  return environment;
}

function runCommand(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{
  code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number; startedAt: number;
}> {
  return new Promise((resolveRun, rejectRun) => {
    const started = performance.now();
    const child = spawn(process.execPath, [...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid !== undefined) child.kill('SIGKILL');
        else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch { /* The child may have exited as the timer fired. */ }
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code, signal, durationMs: performance.now() - started, startedAt: started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function runArguments(baseUrl: string, home: string): string[] {
  const config: [string, string | number | boolean][] = [
    ['host.sessionDirectory', join(home, 'sessions')],
    ['model.api', 'messages'],
    ['model.baseURL', baseUrl],
    ['model.model', 'benchmark-model'],
    ['model.apiKeyEnv', 'LIGULE_BENCH_API_KEY'],
    ['model.capabilities.streaming', false],
    ['loop.modelCalls', 1],
    ['loop.totalModelCalls', 1],
    ['loop.taskTimeoutMs', 60_000],
    ['loop.requestTimeoutMs', 30_000],
    ['policy.mode', 'auto'],
  ];
  return [
    'run', '--json',
    ...config.flatMap(([key, value]) => ['--config', `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`]),
    'Reply with the single word benchmark.',
  ];
}

export const cliStartup: Scenario = {
  name: 'cli-startup',
  async run({ repeats, warmup, workRoot }): Promise<ScenarioResult> {
    const cli = process.env.LIGULE_BENCH_CLI === undefined
      ? join(repository, 'tui', 'dist', 'cli.js')
      : resolve(process.env.LIGULE_BENCH_CLI);
    const provider = await startMockMessagesProvider();
    const samples: Sample[] = [];
    try {
      const execute = async (index: number, record: boolean): Promise<void> => {
        const directory = join(workRoot, `cli-${index}`);
        const home = join(directory, 'home');
        const workspace = join(directory, 'workspace');
        await mkdir(home, { recursive: true });
        await mkdir(workspace, { recursive: true });
        const nodeBaseline = await runCommand(['-e', ''], workRoot, process.env, 30_000);
        const versionBaseline = await runCommand([cli, '--version'], workRoot, process.env, 60_000);
        provider.reset();
        const result = await runCommand([cli, ...runArguments(provider.baseUrl, home)], workspace, childEnvironment(home), 120_000);
        if (result.code !== 0) throw new Error(`cli_startup_failed:${result.code ?? result.signal}:${result.stdout.slice(-1_000)}:${result.stderr.slice(-2_000)}`);
        const parsed = JSON.parse(result.stdout.trim()) as { version?: unknown; status?: unknown; sessionId?: unknown; runId?: unknown };
        if (parsed.version !== 1 || parsed.status !== 'completed' || typeof parsed.sessionId !== 'string') {
          throw new Error(`cli_startup_result_invalid:${result.stdout.slice(-2_000)}`);
        }
        const firstRequest = provider.firstRequestAt();
        if (record) {
          samples.push({
            workload: 'single-round',
            fullRunMs: result.durationMs,
            ...(firstRequest === undefined ? {} : { spawnToFirstModelRequestMs: firstRequest - result.startedAt }),
            resultBytes: Buffer.byteLength(result.stdout, 'utf8'),
            nodeProcessMs: nodeBaseline.durationMs,
            cliVersionMs: versionBaseline.durationMs,
          });
        }
        await delay(10);
      };
      for (let index = 0; index < warmup; index += 1) await execute(index, false);
      for (let index = 0; index < repeats; index += 1) await execute(warmup + index, true);
      return {
        name: this.name,
        status: 'ok',
        samples,
        notes: {
          cli,
          note: 'fullRunMs is one complete single-round task: spawn, CLI/Host/Session startup, one loopback model call, persistence, and exit. spawnToFirstModelRequestMs covers spawn through the model request arriving. nodeProcessMs and cliVersionMs are independent baselines, not a module-load subtraction.',
        },
      };
    } finally {
      await provider.close();
    }
  },
};
