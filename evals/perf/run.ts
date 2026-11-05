import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentInformation, markdownReport, summaryOf, writeJson } from './lib.ts';
import type { Scenario, ScenarioResult } from './lib.ts';
import { cliStartup } from './scenarios/cli-startup.ts';
import { mcpLifecycle } from './scenarios/mcp-lifecycle.ts';
import { sessionJsonl } from './scenarios/session-jsonl.ts';
import { shellOutput } from './scenarios/shell-output.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const SCENARIOS: Scenario[] = [cliStartup, sessionJsonl, shellOutput, mcpLifecycle];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function integerOption(name: string, fallback: number, minimum: number): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid --${name}: ${value}; minimum is ${minimum}`);
  return parsed;
}

const repeats = integerOption('repeats', 5, 1);
const warmup = integerOption('warmup', 1, 0);
const allowBlocked = process.argv.includes('--allow-blocked');
const force = process.argv.includes('--force');
const selected = option('scenario')?.split(',').map((name) => name.trim()).filter(Boolean);
const unknownScenarios = selected?.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name)) ?? [];
if (unknownScenarios.length > 0) throw new Error(`unknown benchmark scenario: ${unknownScenarios.join(', ')}; available: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}`);
const scenarios = selected === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => selected.includes(scenario.name));
if (scenarios.length === 0) throw new Error('no benchmark scenario selected');

const generatedAt = new Date().toISOString();
const environment = environmentInformation(repository);
const stamp = generatedAt.replace(/[:.]/g, '-');
const requestedOutput = option('output');
let runDirectory: string;
if (requestedOutput === undefined) {
  runDirectory = join(repository, 'testplace', 'benchmarks', `${stamp}-${String(environment.gitSha ?? 'nogit').slice(0, 7)}`);
} else {
  runDirectory = resolve(requestedOutput);
  if (existsSync(runDirectory)) {
    if (!force) throw new Error(`output_directory_exists:${runDirectory}; pass --force to preserve it as a previous run`);
    if (!existsSync(join(runDirectory, 'summary.json')) || !existsSync(join(runDirectory, 'raw.jsonl'))) {
      throw new Error(`output_directory_not_benchmark_run:${runDirectory}`);
    }
    const previous = `${runDirectory}.previous-${stamp}`;
    await rename(runDirectory, previous);
    process.stdout.write(`Preserved existing output at ${previous}\n`);
  }
}
const workRoot = join(runDirectory, 'tmp');
await mkdir(workRoot, { recursive: true });
await writeFile(join(runDirectory, 'benchmark.json'), `${JSON.stringify({
  kind: 'ligule-harness-performance', version: 1, gitSha: environment.gitSha, createdAt: generatedAt,
}, null, 2)}\n`, 'utf8');

const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  process.stdout.write(`Running ${scenario.name} (${repeats} samples, ${warmup} warmup)...\n`);
  const started = performance.now();
  try {
    results.push(await scenario.run({ repeats, warmup, workRoot }));
  } catch (error) {
    results.push({
      name: scenario.name,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      samples: [],
    });
  }
  process.stdout.write(`${scenario.name}: ${results[results.length - 1].status} (${Math.round(performance.now() - started)} ms)\n`);
}

const blockedScenarios = results.filter((result) => result.status === 'blocked').map((result) => result.name);
const summary = {
  generatedAt,
  repeats,
  warmup,
  allowBlocked,
  blockedScenarios,
  environment,
  scenarios: results.map((result) => ({
    name: result.name,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    metrics: summaryOf(result),
    ...(result.notes === undefined ? {} : { notes: result.notes }),
  })),
};
await writeJson(join(runDirectory, 'summary.json'), summary);
await writeFile(join(runDirectory, 'summary.md'), markdownReport(summary), 'utf8');
const raw = results.flatMap((result) => result.samples.map((sample) => JSON.stringify({ scenario: result.name, ...sample })));
await writeFile(join(runDirectory, 'raw.jsonl'), raw.length === 0 ? '' : `${raw.join('\n')}\n`, 'utf8');

process.stdout.write('\n');
for (const scenario of summary.scenarios) {
  process.stdout.write(`${scenario.status.toUpperCase()} ${scenario.name}${scenario.reason === undefined ? '' : `: ${scenario.reason}`}\n`);
  for (const [workload, metrics] of Object.entries(scenario.metrics)) {
    process.stdout.write(`  [${workload}]\n`);
    for (const [metric, values] of Object.entries(metrics)) {
      process.stdout.write(`    ${metric}: p50=${values.p50.toFixed(2)} p95=${values.p95.toFixed(2)} min=${values.min.toFixed(2)} max=${values.max.toFixed(2)}\n`);
    }
  }
}
process.stdout.write(`\nArtifacts: ${runDirectory}\n`);

if (blockedScenarios.length > 0 && !allowBlocked) {
  process.stdout.write(`Blocked scenarios: ${blockedScenarios.join(', ')}. Pass --allow-blocked for a partial diagnostic run.\n`);
}
if (results.some((result) => result.status === 'error') || (blockedScenarios.length > 0 && !allowBlocked)) process.exitCode = 1;
