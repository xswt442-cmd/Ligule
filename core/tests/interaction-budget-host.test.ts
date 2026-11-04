import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { SessionEvent } from '../dist/session/format.js';
import { withTuiHost } from './helpers/tui-host.ts';

const input = JSON.stringify({ tool: 'ask_user_question', args: {
  questions: JSON.stringify([{ question: 'Continue?', options: [], multiSelect: false }]),
} });

test('Host rejects a configured parallel tool limit above the bounded maximum', async () => {
  await assert.rejects(
    withTuiHost(async () => {}, { config: { loop: { maxParallelTools: 33 } } }),
    (error) => (error as { code?: string }).code === 'host_loop_limits_invalid',
  );
});

test('Host rejects legacy project trash settings with an actionable configuration error', async () => {
  for (const config of [
    { trashBackend: 'managed' },
    { limits: { trashDirectory: '.old-trash' } },
  ]) {
    await assert.rejects(
      withTuiHost(async () => {}, { config }),
      (error) => (error as { code?: string }).code === 'trash_legacy_config_unsupported',
    );
  }
});

test('Host pauses the execution deadline while a question is the only active work', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    client.onRequest(async (message) => {
      if (message.method !== 'question.request') return undefined;
      await delay(1_200);
      return { answers: [{ id: 'q1', custom: 'yes' }] };
    });
    const result = await client.request('run.start', { sessionId, input }) as { runId?: string };
    assert.ok(result.runId);
    const { events } = await client.request('session.read', { sessionId }) as { events: SessionEvent[] };
    assert.equal(events.findLast((event) => event.kind === 'turn')?.status, 'completed');
  }, { interactive: true, config: { loop: { iterations: 2, modelCalls: 2, taskTimeoutMs: 1_000, requestTimeoutMs: 500, interactionWaitTimeoutMs: 3_000 } } });
});

test('Host ends a pending question with a distinct cumulative interaction timeout', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    client.onRequest((message) => message.method === 'question.request' ? new Promise(() => {}) : undefined);
    await assert.rejects(client.request('run.start', { sessionId, input }), (error) => (error as { code?: string }).code === 'task_interaction_timeout');
    const { events } = await client.request('session.read', { sessionId }) as { events: SessionEvent[] };
    const turn = events.findLast((event) => event.kind === 'turn');
    assert.equal(turn?.status, 'failed');
    assert.equal(turn?.code, 'task_interaction_timeout');
  }, { interactive: true, config: { loop: { iterations: 2, modelCalls: 2, taskTimeoutMs: 3_000, requestTimeoutMs: 1_000, interactionWaitTimeoutMs: 150 } } });
});

test('Host pauses the execution deadline for an actual approval and resumes after the answer', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await writeFile(join(projectDirectory, 'note.txt'), 'approved content');
    let approvals = 0;
    client.onRequest(async (message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals += 1;
      await delay(1_200);
      return { decision: 'allow' };
    });
    const result = await client.request('run.start', { sessionId,
      input: JSON.stringify({ tool: 'read', args: { path: 'note.txt' } }) }) as { runId?: string };
    assert.ok(result.runId);
    assert.equal(approvals, 1);
    const { events } = await client.request('session.read', { sessionId }) as { events: SessionEvent[] };
    assert.equal(events.findLast((event) => event.kind === 'turn')?.status, 'completed');
  }, { config: { loop: { iterations: 2, modelCalls: 2, taskTimeoutMs: 1_000, requestTimeoutMs: 500, interactionWaitTimeoutMs: 3_000 } } });
});

test('Host pauses the execution deadline while parallel approvals are both waiting', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const createPdf = async (path: string, text: string) => {
      const document = await PDFDocument.create();
      const font = await document.embedFont(StandardFonts.Helvetica);
      document.addPage([300, 200]).drawText(text, { font, size: 14, x: 20, y: 150 });
      await writeFile(join(projectDirectory, path), await document.save());
    };
    await Promise.all([
      createPdf('first.pdf', 'First approved document'),
      createPdf('second.pdf', 'Second approved document'),
    ]);

    let approvals = 0;
    let activeApprovals = 0;
    let peakApprovals = 0;
    client.onRequest(async (message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals += 1;
      activeApprovals += 1;
      peakApprovals = Math.max(peakApprovals, activeApprovals);
      await delay(2_000);
      activeApprovals -= 1;
      return { decision: 'allow' };
    });

    // The two approvals wait 2s each, which already exceeds the 1.5s task budget: if approval
    // waiting counted as execution time the task would run out before the approvals returned and
    // interactionWaitMs would stay near zero. Starting and parsing the document worker itself
    // takes 1.1-1.5s here, so "did it still finish inside the budget after resuming" is not the
    // property under test; assert the approval wait and the post-resume execution budget
    // separately, then tell a completed turn from one ended by the deadline.
    let failure: { code?: string; message?: string } | undefined;
    try {
      const result = await client.request('run.start', { sessionId, input: JSON.stringify({ toolCalls: [
        { tool: 'read_document', args: { path: 'first.pdf' } },
        { tool: 'read_document', args: { path: 'second.pdf' } },
      ] }) }) as { runId?: string };
      assert.ok(result.runId);
    } catch (error) { failure = error as { code?: string; message?: string }; }
    assert.equal(approvals, 2);
    assert.equal(peakApprovals, 2);
    const task = (await client.request('status.get', { sessionId }) as {
      task: { interactionWaitMs: number; executionElapsedMs: number } | null;
    }).task;
    assert.ok(task !== null && typeof task === 'object', 'the finished turn keeps its task budget snapshot');
    assert.ok(task.interactionWaitMs >= 1_900, `approval wait was counted as execution: ${task.interactionWaitMs}ms`);
    assert.ok(task.executionElapsedMs <= 1_700, `execution budget was overshot: ${task.executionElapsedMs}ms`);
    const { events } = await client.request('session.read', { sessionId }) as { events: SessionEvent[] };
    const turn = events.findLast((event) => event.kind === 'turn');
    if (turn?.status === 'completed') {
      assert.equal(failure, undefined);
    } else {
      assert.equal(turn?.status, 'failed');
      assert.equal(turn?.code, 'task_deadline_exceeded');
      assert.ok(failure === undefined || failure.code === 'task_deadline_exceeded', String(failure?.message));
    }
  }, {
    modeName: 'full',
    config: { loop: { iterations: 2, modelCalls: 2, maxParallelTools: 2,
      taskTimeoutMs: 1_500, requestTimeoutMs: 1_000, interactionWaitTimeoutMs: 5_000 } },
  });
});
