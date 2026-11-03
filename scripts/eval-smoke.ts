import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const testplaceTemp = join(repository, '..', 'testplace', 'tmp');
const harborVersion = '0.25.0';

function run(command: string, args: readonly string[], { label, env }: { label: string; env: NodeJS.ProcessEnv }): void {
  process.stdout.write(`\n[eval:smoke] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: repository,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error !== undefined) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} exited with ${result.status ?? result.signal ?? 'unknown status'}`);
  }
}

function runPinnedPnpm(args: readonly string[], options: { label: string; env: NodeJS.ProcessEnv }): void {
  const pnpmCli = process.env.npm_execpath;
  if (typeof pnpmCli !== 'string' || !pnpmCli.toLowerCase().includes('pnpm')) {
    throw new Error('run this smoke check through the pinned `pnpm run eval:smoke` command');
  }
  const isJavaScriptCli = /\.(?:cjs|mjs|js)$/iu.test(pnpmCli);
  run(isJavaScriptCli ? process.execPath : pnpmCli,
    isJavaScriptCli ? [pnpmCli, ...args] : args, options);
}

async function createRunDirectory(): Promise<{ parent: string; path: string }> {
  await mkdir(testplaceTemp, { recursive: true });
  const parent = await realpath(testplaceTemp);
  const path = await mkdtemp(join(parent, 'ligule-eval-smoke-'));
  const realPath = await realpath(path);
  const relativePath = relative(parent, realPath);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('the smoke workspace escaped testplace/tmp');
  }
  return { parent, path: realPath };
}

async function removeRunDirectory(parent: string, path: string): Promise<void> {
  const realParent = await realpath(parent);
  const realPath = await realpath(path);
  const relativePath = relative(realParent, realPath);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('refusing to remove anything outside this eval:smoke directory');
  }
  const info = await stat(realPath);
  if (!info.isDirectory()) throw new Error('the eval:smoke output path is not a directory');
  await rm(realPath, { recursive: true });
}

async function main(): Promise<void> {
  const { parent, path } = await createRunDirectory();
  let failure: unknown;
  try {
    const pythonTemp = join(path, 'python-fixtures');
    const nodeTemp = join(path, 'node-fixtures');
    const cliTemp = join(path, 'cli-fixtures');
    const uvCache = join(path, 'uv-cache');
    const validatorOutput = join(path, 'validator', 'trajectory.json');
    for (const directory of [pythonTemp, nodeTemp, cliTemp, uvCache, dirname(validatorOutput)]) {
      await mkdir(directory, { recursive: true });
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      UV_CACHE_DIR: uvCache,
      LIGULE_EVAL_TEMP_DIR: pythonTemp,
      LIGULE_EVAL_E2E_TEMP_DIR: cliTemp,
      LIGULE_ATIF_OUTPUT_PATH: validatorOutput,
      TEMP: nodeTemp,
      TMP: nodeTemp,
      TMPDIR: nodeTemp,
    };
    delete env.LIGULE_CLI_E2E_PATH;
    delete env.LIGULE_CLI_E2E_CORE_PACKAGE;

    runPinnedPnpm(['run', 'build'], { label: 'full TypeScript build', env });

    run('uv', [
      'run', '--no-project', '--with', `harbor==${harborVersion}`,
      'python', 'evals/harbor/test_adapter.py',
    ], { label: 'Harbor adapter fixtures', env });

    run(process.execPath, ['--test', '--test-concurrency=1', 'evals/harbor/export_session.test.mjs'], {
      label: 'Session/ATIF export fixture', env,
    });
    const atifInfo = await stat(validatorOutput).catch(() => undefined);
    if (atifInfo === undefined || !atifInfo.isFile() || atifInfo.size === 0) {
      throw new Error('the real createSessionLog fixture did not produce a validator input');
    }

    run('uv', [
      'run', '--no-project', '--with', `harbor==${harborVersion}`,
      'python', '-m', 'harbor.utils.trajectory_validator', validatorOutput,
    ], { label: 'Harbor official ATIF validator', env });

    run(process.execPath, ['--test', '--test-concurrency=1', 'evals/harbor/cli-e2e.test.mjs'], {
      label: 'CLI loopback mock-provider end-to-end fixture', env,
    });

    run('uv', [
      'run', '--no-project', '--with', `harbor==${harborVersion}`,
      'python', 'evals/report/test_report.py',
    ], { label: 'deterministic report fixtures', env });

    process.stdout.write('\n[eval:smoke] completed: build, Harbor fixtures, real Session ATIF validation, CLI mock-provider flow, and report fixtures passed.\n');
  } catch (error) {
    failure = error;
  } finally {
    try {
      await removeRunDirectory(parent, path);
    } catch (cleanupError) {
      if (failure === undefined) failure = cleanupError;
      else process.stderr.write(`[eval:smoke] temporary directory cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    }
  }
  if (failure !== undefined) {
    process.stderr.write(`[eval:smoke] failed: ${failure instanceof Error ? failure.message : String(failure)}\n`);
    process.exitCode = 1;
  }
}

await main();
