import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTelemetry } from '../dist/kernel/telemetry.js';
import type { TelemetryEvent } from '../dist/kernel/telemetry.js';

const testRoot = join(process.cwd(), 'testplace', 'telemetry');

async function isolated(t: TestContext) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'case-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}.telemetry.lock`, { recursive: true, force: true });
  });
  return directory;
}

async function segmentFiles(directory: string) {
  return (await readdir(directory)).filter(name => /^segment-[0-9]{8}\.jsonl$/u.test(name));
}

test('telemetry is disabled unless explicitly enabled with a directory', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ directory });
  telemetry.emit({ type: 'run.finished', executionId: 'exec-1', runId: 'run-1', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await telemetry.flush();
  assert.deepEqual(await readdir(directory), []);
});

test('writes only allowlisted fields and drops malformed or sensitive values', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory });
  telemetry.emit({ type: 'model.finished', executionId: 'e1', runId: 'r1', sessionId: 's1', requestId: 'request-1', logicalRequestId: 'logical-1', attempt: 1,
    provider: 'openai', model: 'gpt_4', durationMs: 604_800_000, status: 'completed',
    inputTokens: 4, outputTokens: 2, finishReason: 'stop' });
  telemetry.emit({ type: 'model.finished', executionId: 'e2', runId: 'r2', requestId: 'request-2', logicalRequestId: 'logical-2', attempt: 1,
    provider: 'openai', model: 'secret=abc', durationMs: 1, status: 'completed' });
  telemetry.emit({ type: 'tool.finished', executionId: 'e3', runId: 'r3', callId: 'call-3', tool: 'read', durationMs: 2, outcome: 'success', args: { password: 'nope' } } as unknown as TelemetryEvent);
  telemetry.emit({ type: 'model.finished', executionId: 'e4', runId: 'r4', requestId: 'request-4', logicalRequestId: 'logical-4', attempt: 1,
    provider: 'vendor/provider', model: 'vendor/model',
    durationMs: 23, status: 'completed', inputTokens: 7, outputTokens: 5, finishReason: 'stop' });
  await telemetry.shutdown();
  const text = await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8');
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 3);
  assert.deepEqual(Object.keys(records[0]).sort(), ['attempt', 'component', 'durationMs', 'executionId', 'finishReason', 'inputTokens', 'logicalRequestId',
    'model', 'outputTokens', 'provider', 'requestId', 'runId', 'sessionId', 'severity', 'status', 'timestamp', 'type'].sort());
  assert.equal(records[0].component, 'model');
  assert.equal(records[0].severity, 'info');
  assert.equal(records[0].runId, 'r1');
  assert.equal(records[0].durationMs, 604_800_000);
  assert.equal(records[0].status, 'completed');
  assert.equal(records[1].model, undefined);
  assert.equal(records[2].provider, undefined);
  assert.equal(records[2].model, undefined);
  assert.equal(records[2].inputTokens, 7);
  assert.equal(records[2].outputTokens, 5);
  assert.doesNotMatch(text, /secret|password|args|abc|nope/u);
});

test('queue capacity includes the in-flight write and silently drops excess records', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory, maxQueuedRecords: 1 });
  for (let index = 0; index < 100; index += 1) {
    telemetry.emit({ type: 'run.finished', executionId: `e${index}`, runId: `r${index}`, status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  }
  await assert.doesNotReject(telemetry.flush());
  await assert.doesNotReject(telemetry.shutdown());
  const records = (await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]).runId, 'r0');
});

test('file rotation keeps a bounded number of bounded files', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory, maxFileBytes: 1100 });
  for (let index = 0; index < 40; index += 1) {
    telemetry.emit({ type: 'run.finished', executionId: `exec-${index}`, runId: `run-${index}`, sessionId: 'session', status: 'completed', durationMs: index,
      modelCalls: 1, toolCalls: 0 });
  }
  await telemetry.flush();
  await telemetry.shutdown();
  const files = await segmentFiles(directory);
  assert.ok(files.length <= 4);
  let logBytes = 0;
  for (const name of files) {
    const bytes = (await readFile(join(directory, name))).byteLength;
    assert.ok(bytes <= 1100);
    logBytes += bytes;
  }
  assert.ok(logBytes <= 4 * 1100);
  assert.ok((await readdir(directory)).length <= 5, JSON.stringify(await readdir(directory)));
});

test('filesystem failures do not escape emit or shutdown and flush reports a stable diagnostic', async (t) => {
  const directory = await isolated(t);
  const file = join(directory, 'file');
  await writeFile(file, 'x');
  const failures: string[] = [];
  const telemetry = createTelemetry({ enabled: true, directory: join(file, 'child') }, code => failures.push(code));
  assert.doesNotThrow(() => telemetry.emit({ type: 'run.finished', executionId: 'e1', runId: 'r1', status: 'failed', durationMs: 1, modelCalls: 1, toolCalls: 0 }));
  await assert.rejects(telemetry.flush(), { code: 'telemetry_storage_failed' });
  await assert.doesNotReject(telemetry.shutdown());
  assert.deepEqual(failures, ['telemetry_storage_failed']);
});

test('preserves pre-existing unknown files and refuses a symlink output directory', async (t) => {
  const directory = await isolated(t);
  const marker = join(directory, 'telemetry.jsonl.1');
  await writeFile(marker, 'keep this user file');
  const linkPath = join(directory, 'directory-link');
  try { await symlink(directory, linkPath, 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as { code?: string }).code as string)) return t.skip('directory symlinks are unavailable');
    throw error;
  }
  const telemetry = createTelemetry({ enabled: true, directory: linkPath });
  telemetry.emit({ type: 'run.finished', executionId: 'e1', runId: 'r1', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await assert.rejects(telemetry.flush(), { code: 'telemetry_storage_failed' });
  await telemetry.shutdown();
  assert.equal(await readFile(marker, 'utf8'), 'keep this user file');
  assert.deepEqual((await readdir(directory)).sort(), ['directory-link', 'telemetry.jsonl.1']);
});

test('a corrupt manifest fails closed without replacing or deleting its contents', async (t) => {
  const directory = await isolated(t);
  const initial = createTelemetry({ enabled: true, directory });
  initial.emit({ type: 'run.finished', executionId: 'exec-before', runId: 'run-before', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await initial.shutdown();
  const segmentBefore = await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8');
  const manifest = join(directory, 'telemetry.manifest.json');
  await writeFile(manifest, '{ damaged marker');
  const telemetry = createTelemetry({ enabled: true, directory });
  telemetry.emit({ type: 'run.finished', executionId: 'exec-after', runId: 'run-after', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await assert.rejects(telemetry.flush(), { code: 'telemetry_manifest_invalid' });
  await telemetry.shutdown();
  assert.equal(await readFile(manifest, 'utf8'), '{ damaged marker');
  assert.equal(await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8'), segmentBefore);
  assert.deepEqual(await segmentFiles(directory), ['segment-00000000.jsonl']);
});

test('failed atomic manifest replacement preserves a competing temporary-path file', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory });
  telemetry.emit({ type: 'run.finished', executionId: 'exec-before', runId: 'run-before', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await telemetry.flush();
  const manifest = join(directory, 'telemetry.manifest.json');
  const before = await readFile(manifest, 'utf8');
  let competingPath: string | undefined;
  t.mock.method(fs, 'rename', async (source: string, destination: string) => {
    competingPath = source;
    await fs.unlink(source);
    await fs.writeFile(source, 'competing file');
    throw new Error(`injected rename failure for ${destination}`);
  });

  telemetry.emit({ type: 'run.finished', executionId: 'exec-after', runId: 'run-after', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await assert.rejects(telemetry.flush(), { code: 'telemetry_storage_failed' });
  await telemetry.shutdown();
  assert.equal(await readFile(manifest, 'utf8'), before);
  assert.equal(await readFile(competingPath as string, 'utf8'), 'competing file');
  assert.match(competingPath as string, /telemetry\.manifest\.[0-9a-f-]+\.tmp$/u);
});

test('fails closed instead of rotating a segment after it gains a hard link', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory, maxFileBytes: 1050, retainedFiles: 1 });
  telemetry.emit({ type: 'run.finished', executionId: 'e-first', runId: 'first', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await telemetry.flush();
  const segment = join(directory, 'segment-00000000.jsonl');
  const preservedLink = join(testRoot, `preserved-hard-link-${randomUUID()}`);
  t.after(async () => rm(preservedLink, { force: true }));
  await link(segment, preservedLink);
  for (let index = 0; index < 20; index += 1) {
    telemetry.emit({ type: 'run.finished', executionId: `e-next-${index}`, runId: `next-${index}`, status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  }
  await assert.rejects(telemetry.flush(), { code: 'telemetry_storage_failed' });
  await telemetry.shutdown();
  assert.match(await readFile(preservedLink, 'utf8'), /first/u);
  assert.ok((await readdir(directory)).includes('segment-00000000.jsonl'));
});

test('multiple writers serialize through one manifest and obey aggregate file and byte limits', async (t) => {
  const directory = await isolated(t);
  const first = createTelemetry({ enabled: true, directory, maxFileBytes: 8192, retainedFiles: 2 });
  const second = createTelemetry({ enabled: true, directory, maxFileBytes: 8192, retainedFiles: 2 });
  for (let index = 0; index < 10; index += 1) {
    const event: TelemetryEvent = { type: 'run.finished', executionId: `exec-${index}`, runId: `run-${index}`, status: 'completed', durationMs: index, modelCalls: 1, toolCalls: 0 };
    first.emit(event);
    second.emit({ ...event, runId: `second-${index}` });
  }
  await Promise.all([first.flush(), second.flush()]);
  await Promise.all([first.shutdown(), second.shutdown()]);
  const files = await segmentFiles(directory);
  assert.ok(files.length <= 2);
  assert.ok((await readdir(directory)).length <= 3, JSON.stringify(await readdir(directory)));
  let totalBytes = (await readFile(join(directory, 'telemetry.manifest.json'))).byteLength;
  const runIds = new Set<string>();
  for (const file of files) {
    const bytes = await readFile(join(directory, file));
    assert.ok(bytes.byteLength <= 8192);
    totalBytes += bytes.byteLength;
    for (const line of bytes.toString('utf8').trim().split('\n')) {
      const event = JSON.parse(line);
      assert.equal(event.type, 'run.finished');
      runIds.add(event.runId);
    }
  }
  assert.ok(totalBytes <= 2 * 8192 + 4096);
  assert.ok([...runIds].some(id => id.startsWith('run-')));
  assert.ok([...runIds].some(id => id.startsWith('second-')));
});

test('restart writers reuse one capped directory without accumulating log sets', async (t) => {
  const directory = await isolated(t);
  for (let writer = 0; writer < 5; writer += 1) {
    const telemetry = createTelemetry({ enabled: true, directory, maxFileBytes: 4096, retainedFiles: 2 });
    for (let index = 0; index < 25; index += 1) {
      telemetry.emit({ type: 'run.finished', executionId: `exec-${writer}-${index}`, runId: `run-${writer}-${index}`,
        status: 'completed', durationMs: index, modelCalls: 1, toolCalls: 0 });
    }
    await telemetry.flush();
    await telemetry.shutdown();
  }
  const files = await readdir(directory);
  const segments = await segmentFiles(directory);
  assert.ok(segments.length <= 2);
  assert.deepEqual(files.sort(), ['telemetry.manifest.json', ...segments].sort());
  const totalBytes = (await Promise.all(files.map(name => readFile(join(directory, name)))))
    .reduce((total, content) => total + content.byteLength, 0);
  assert.ok(totalBytes <= 2 * 4096 + 4096);
});

test('a new writer preserves an unknown atomic-manifest temporary file and fails closed', async (t) => {
  const directory = await isolated(t);
  const orphan = `telemetry.manifest.${randomUUID()}.tmp`;
  await writeFile(join(directory, orphan), 'review-unique-not-from-telemetry');
  const failures: string[] = [];
  const telemetry = createTelemetry({ enabled: true, directory }, code => failures.push(code));
  telemetry.emit({ type: 'run.finished', executionId: 'recover', runId: 'recover', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });

  await assert.rejects(telemetry.flush(), { code: 'telemetry_manifest_temp_unknown' });
  await telemetry.shutdown();

  const files = await readdir(directory);
  assert.deepEqual(files, [orphan]);
  assert.equal(await readFile(join(directory, orphan), 'utf8'), 'review-unique-not-from-telemetry');
  assert.deepEqual(failures, ['telemetry_manifest_temp_unknown']);
});

test('a manifest-temp name with a hard link is preserved and disables the writer', async (t) => {
  const directory = await isolated(t);
  const orphan = `telemetry.manifest.${randomUUID()}.tmp`;
  const linked = join(directory, 'preserve-this-file');
  await writeFile(join(directory, orphan), 'unknown user data');
  await link(join(directory, orphan), linked);
  const failures: string[] = [];
  const telemetry = createTelemetry({ enabled: true, directory }, code => failures.push(code));
  telemetry.emit({ type: 'run.finished', executionId: 'must-not-write', runId: 'must-not-write', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });

  await assert.rejects(telemetry.flush(), { code: 'telemetry_manifest_temp_unknown' });
  await telemetry.shutdown();

  assert.deepEqual((await readdir(directory)).sort(), [orphan, 'preserve-this-file'].sort());
  assert.equal(await readFile(join(directory, orphan), 'utf8'), 'unknown user data');
  assert.deepEqual(failures, ['telemetry_manifest_temp_unknown']);
});

test('a manifest-temp symlink is preserved and its target is never removed', async (t) => {
  const directory = await isolated(t);
  const target = join(directory, 'preserve-this-file');
  const orphan = `telemetry.manifest.${randomUUID()}.tmp`;
  await writeFile(target, 'unknown user data');
  await symlink(target, join(directory, orphan));
  const failures: string[] = [];
  const telemetry = createTelemetry({ enabled: true, directory }, code => failures.push(code));
  telemetry.emit({ type: 'run.finished', executionId: 'must-not-write', runId: 'must-not-write', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });

  await assert.rejects(telemetry.flush(), { code: 'telemetry_manifest_temp_unknown' });
  await telemetry.shutdown();

  assert.deepEqual((await readdir(directory)).sort(), [orphan, 'preserve-this-file'].sort());
  assert.equal(await readFile(target, 'utf8'), 'unknown user data');
  assert.deepEqual(failures, ['telemetry_manifest_temp_unknown']);
});

test('shutdown returns within its bound when a file flush never settles', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory });
  telemetry.emit({ type: 'run.finished', executionId: 'e1', runId: 'r1', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  const probe = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  prototype.sync = () => new Promise(() => {});
  try {
    const started = Date.now();
    await telemetry.shutdown();
    assert.ok(Date.now() - started < 1_000);
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
});
