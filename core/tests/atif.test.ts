import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSessionLog } from '../dist/index.js';
import { sessionTurnToAtif } from '../dist/session/atif.js';
import type { AtifTrajectory } from '../dist/session/atif.js';
import { createRunAcceptance } from '../dist/session/run.js';
import type { RunAcceptance } from '../dist/session/run.js';

type LiguleExtra = {
  outcome?: string;
  failed?: boolean;
  error_code?: string;
  output_truncated?: boolean;
  spill_content_missing?: boolean;
  cache_miss_tokens?: number;
  cache_consistent?: boolean | null;
  source_fields?: { field: string; tokens: number }[];
};

type LiguleMetrics = {
  prompt_tokens?: number;
  cached_tokens?: number;
  extra: { ligule: LiguleExtra };
};

type UsageCache = {
  source: string;
  hitInputTokens: number | null;
  missInputTokens: number | null;
  creationInputTokens: number | null;
  providerInputIncludesCache: boolean;
  consistent: boolean | null;
  sourceFields: { field: string; tokens: number }[];
};

const liguleOf = (extra: Record<string, unknown> | undefined): LiguleExtra => extra?.ligule as LiguleExtra;

const metricsOf = (trajectory: AtifTrajectory): LiguleMetrics =>
  trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls)!.metrics as LiguleMetrics;

async function makeSession({ unknown = false, overflowCompaction = false }: { unknown?: boolean; overflowCompaction?: boolean } = {}) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'ligule-atif-'));
  const session = createSessionLog({ directory, id: 'atif-session' });
  const acceptance = createRunAcceptance('atif-session', 'inspect the private file', null, 'test');
  const user = await session.append({ kind: 'user', text: 'inspect the private file', run: acceptance });
  await session.append({ kind: 'usage', ignorable: true, input: 12, output: null, estimated: 10, measurement: 'request-v1' });
  if (overflowCompaction) await session.append({ kind: 'compaction', ignorable: true, reason: 'overflow',
    blockId: 1, fromSeq: 0, toSeq: 1, tokensBefore: 100, tokensAfter: 20 });
  await session.append({ kind: 'reasoning', text: 'private chain of thought' });
  await session.append({ kind: 'assistant', text: 'I will read it', toolCalls: [
    { id: 'call-1', name: 'read', args: { path: 'C:\\secret\\note.txt' } },
    { id: 'call-2', name: 'write', args: { path: 'result.txt', content: 'private parameter' } },
  ], reasoning: 'private chain of thought' });
  await session.append({ kind: 'tool', tool: 'read', callId: 'call-1', args: { path: 'C:\\secret\\note.txt' },
    result: unknown
      ? { kind: 'failure', failed: true, code: 'tool_outcome_unknown', content: 'external effect unknown' }
      : { kind: 'result', failed: false, content: 'private file contents' } });
  await session.append({ kind: 'tool', tool: 'write', callId: 'call-2', args: { path: 'result.txt', content: 'private parameter' },
    result: { kind: 'refusal', failed: true, code: 'permission_denied', reason: 'private refusal detail', content: '' } });
  await session.append({ kind: 'assistant', text: 'Done with private details.', toolCalls: [] });
  await session.append({ kind: 'turn', ignorable: true, status: 'failed', userSeq: user.seq,
    runId: acceptance.runId, code: 'run_failed' });
  return { directory, session, acceptance, user };
}

const source = (acceptance: RunAcceptance, user: { seq: number }) => ({
  sessionId: 'atif-session',
  userSeq: user.seq,
  runId: acceptance.runId,
  agentName: 'ligule',
  agentVersion: '0.1.1-dev',
  modelName: 'provider/model',
});

test('exports one real Session turn as ATIF v1.8 with private content redacted', async () => {
  const fixture = await makeSession();
  try {
    const trajectory = sessionTurnToAtif(await fixture.session.read(), source(fixture.acceptance, fixture.user));
    if (process.env.LIGULE_ATIF_OUTPUT_PATH) {
      await writeFile(process.env.LIGULE_ATIF_OUTPUT_PATH, `${JSON.stringify(trajectory, null, 2)}\n`, 'utf8');
    }
    assert.equal(trajectory.schema_version, 'ATIF-v1.8');
    assert.equal(trajectory.session_id, fixture.acceptance.runId);
    assert.equal(trajectory.steps[0].message, '[redacted]');
    const agent = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls)!;
    assert.equal(agent.message, '[redacted]');
    assert.equal(agent.llm_call_count, 1);
    assert.deepEqual(agent.metrics, { prompt_tokens: 12 }, 'unknown completion usage is omitted, not zero');
    assert.deepEqual(agent.tool_calls!.map((call) => [call.tool_call_id, call.arguments]), [
      ['call-1', {}], ['call-2', {}],
    ]);
    assert.deepEqual(agent.observation!.results.map((result) => result.source_call_id), ['call-1', 'call-2']);
    assert.equal(liguleOf(agent.observation!.results[0].extra).outcome, 'completed');
    assert.equal(liguleOf(agent.observation!.results[1].extra).outcome, 'failed');
    assert.equal(liguleOf(agent.observation!.results[1].extra).error_code, 'permission_denied');
    assert.equal(JSON.stringify(trajectory).includes('private'), false);
    assert.equal(JSON.stringify(trajectory).includes('C:\\secret'), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('ATIF counts persisted agent responses once and keeps overflow compaction separate', async () => {
  const fixture = await makeSession({ overflowCompaction: true });
  try {
    const trajectory = sessionTurnToAtif(await fixture.session.read(), source(fixture.acceptance, fixture.user));
    const agentSteps = trajectory.steps.filter((step) => step.source === 'agent');
    assert.deepEqual(agentSteps.map((step) => step.llm_call_count), [1, 1]);
    assert.equal(trajectory.steps.filter((step) => step.source === 'system'
      && (step.extra?.context_management as { type?: string } | undefined)?.type === 'compaction').length, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('explicit local sensitive-content option includes message, arguments, and tool output', async () => {
  const fixture = await makeSession();
  try {
    const trajectory = sessionTurnToAtif(await fixture.session.read(), source(fixture.acceptance, fixture.user), {
      includeSensitiveContent: true,
    });
    const agent = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls)!;
    assert.equal(trajectory.steps[0].message, 'inspect the private file');
    assert.equal(agent.message, 'I will read it');
    assert.equal(agent.tool_calls![0].arguments.path, 'C:\\secret\\note.txt');
    assert.equal(agent.observation!.results[0].content, 'private file contents');
    assert.equal('reasoning_content' in agent, false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('unknown tool outcome remains unknown and an unresolved call is rejected', async () => {
  const fixture = await makeSession({ unknown: true });
  try {
    const events = await fixture.session.read();
    const trajectory = sessionTurnToAtif(events, source(fixture.acceptance, fixture.user));
    const agent = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls)!;
    assert.equal(liguleOf(agent.observation!.results[0].extra).outcome, 'unknown');
    assert.equal(liguleOf(agent.observation!.results[0].extra).failed, true);

    const unresolved = events.filter((event) => !(event.kind === 'tool' && event.callId === 'call-1'));
    assert.throws(() => sessionTurnToAtif(unresolved, source(fixture.acceptance, fixture.user)), /atif_tool_result_missing/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects duplicate tool outcomes instead of choosing one', async () => {
  const fixture = await makeSession();
  try {
    const events = await fixture.session.read();
    const original = events.find((event) => event.kind === 'tool' && event.callId === 'call-1');
    assert.ok(original);
    const duplicate = { ...original, seq: Math.max(...events.map((event) => event.seq)) + 1 };
    assert.throws(() => sessionTurnToAtif([...events, duplicate], source(fixture.acceptance, fixture.user)), /atif_tool_result_duplicate/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('marks spilled output as incomplete instead of presenting the preview as full content', async () => {
  const fixture = await makeSession();
  try {
    const events = await fixture.session.read();
    const tool = events.find((event) => event.kind === 'tool' && event.callId === 'call-1')!;
    (tool.result as { content: string }).content = 'start\n[omitted: full output is 100 bytes, kept in result-3-deadbeef.json]\nend';
    const trajectory = sessionTurnToAtif(events, source(fixture.acceptance, fixture.user), { includeSensitiveContent: true });
    const result = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls)!.observation!.results[0];
    assert.equal(liguleOf(result.extra).output_truncated, true);
    assert.equal(liguleOf(result.extra).spill_content_missing, true);
    assert.ok((trajectory.extra.ligule as { missing_features: string[] }).missing_features.includes('spill_content'));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('ATIF preserves known cache usage and does not report a conflicting hit count as reliable', async () => {
  const fixture = await makeSession();
  try {
    const events = await fixture.session.read();
    const usage = events.find((event) => event.kind === 'usage') as unknown as { cache: UsageCache };
    usage.cache = { source: 'chat-completions', hitInputTokens: 5, missInputTokens: 7,
      creationInputTokens: null, providerInputIncludesCache: true, consistent: true,
      sourceFields: [{ field: 'prompt_cache_hit_tokens', tokens: 5 }, { field: 'prompt_cache_miss_tokens', tokens: 7 }] };
    const trajectory = sessionTurnToAtif(events, source(fixture.acceptance, fixture.user));
    if (process.env.LIGULE_ATIF_OUTPUT_PATH) {
      await writeFile(process.env.LIGULE_ATIF_OUTPUT_PATH, `${JSON.stringify(trajectory, null, 2)}\n`, 'utf8');
    }
    const metrics = metricsOf(trajectory);
    assert.equal(metrics.cached_tokens, 5);
    assert.equal(metrics.extra.ligule.cache_miss_tokens, 7);
    assert.equal(metrics.extra.ligule.source_fields![0].field, 'prompt_cache_hit_tokens');
    usage.cache.consistent = false;
    const conflicting = sessionTurnToAtif(events, source(fixture.acceptance, fixture.user));
    const conflictMetrics = metricsOf(conflicting);
    assert.equal(conflictMetrics.cached_tokens, undefined);
    assert.equal(conflictMetrics.extra.ligule.cache_consistent, false);
    usage.cache.consistent = null;
    usage.cache.hitInputTokens = 13;
    const excessive = sessionTurnToAtif(events, source(fixture.acceptance, fixture.user));
    assert.equal(metricsOf(excessive).cached_tokens, undefined);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
