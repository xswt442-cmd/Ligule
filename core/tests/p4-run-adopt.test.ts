import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createSessionLog } from '../dist/session/session.js';
import { adoptLegacySessions } from '../dist/session/adopt.js';
import { createRunAcceptance, publishRunResult, readRunResult } from '../dist/session/run.js';
import type { RunResultRef } from '../dist/session/run.js';
import type { RunResult } from '../dist/delegation.js';

const fixtureRoot = fileURLToPath(new URL('../../testplace/', import.meta.url));

test('legacy adoption preserves completed run result sidecars and keeps the source', async () => {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'p4-run-adopt-'));
  const project = join(root, 'project');
  const legacy = join(project, '.ligule', 'sessions');
  const target = join(root, 'data', 'workspaces', 'project', 'sessions');
  const sessionId = 'p4-adopt-session';
  const workspace = 'workspace-p4-adopt';
  await mkdir(legacy, { recursive: true });
  const session = createSessionLog({ directory: legacy, id: sessionId, meta: { projectRoot: project } });
  try {
    const acceptance = createRunAcceptance(sessionId, 'create a report', undefined, 'controller:local', 'adopt-key');
    const user = await session.append({ kind: 'user', text: 'create a report', run: acceptance });
    const result: RunResult = {
      runId: acceptance.runId, sessionId, state: 'completed', stopReason: 'assistant_completed',
      output: { text: 'report delivered' }, validation: { status: 'not_requested' },
      artifacts: [{ kind: 'session', sessionId }], usage: { iterations: 1, modelCalls: 1 }, userSeq: user.seq,
    };
    const resultRef = await publishRunResult(legacy, workspace, sessionId, acceptance.runId, result);
    await session.append({ kind: 'turn', userSeq: user.seq, status: 'completed', runId: acceptance.runId, resultRef });
    await session.close();

    const report = await adoptLegacySessions(legacy, target, { projectRoot: project });
    assert.ok(report.copied.includes(`${sessionId}.jsonl`));
    assert.ok(report.copied.includes(resultRef.name), `adoption report omitted run sidecar ${resultRef.name}`);
    assert.equal(report.unknown.includes(resultRef.name), false);
    await access(join(legacy, `${sessionId}.jsonl`));
    await access(join(legacy, resultRef.name));
    const events = await createSessionLog({ directory: target, id: sessionId }).read();
    const adoptedTurn = events.find(event => event.kind === 'turn' && event.runId === acceptance.runId);
    assert.ok(adoptedTurn);
    assert.deepEqual(await readRunResult(target, workspace, sessionId, {
      runId: acceptance.runId, userSeq: user.seq, sessionId, acceptedAt: acceptance.acceptedAt,
      state: 'completed', requestKey: acceptance.requestKey, resultRef: adoptedTurn.resultRef as RunResultRef | undefined,
    }), result);
    const second = await adoptLegacySessions(legacy, target, { projectRoot: project });
    assert.ok(second.already.includes(resultRef.name));
    assert.ok(second.already.includes(`${sessionId}.jsonl`));
    const targetSidecar = join(target, resultRef.name);
    await writeFile(targetSidecar, 'conflicting target');
    const conflict = await adoptLegacySessions(legacy, target, { projectRoot: project });
    assert.ok(conflict.conflicts.includes(resultRef.name));
    assert.ok(conflict.conflicts.includes(`${sessionId}.jsonl`));
    assert.equal(await readFile(targetSidecar, 'utf8'), 'conflicting target');
    await readRunResult(legacy, workspace, sessionId, {
      runId: acceptance.runId, userSeq: user.seq, sessionId, acceptedAt: acceptance.acceptedAt,
      state: 'completed', requestKey: acceptance.requestKey, resultRef,
    });
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
