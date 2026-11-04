import test from 'node:test';
import assert from 'node:assert/strict';
import type { HostRequest } from '../dist/host/connection.js';
import { withTuiHost, waitFor } from './helpers/tui-host.ts';

type ProgressTask = {
  maxModelCalls?: number;
  modelCalls?: number;
  startedAt?: string;
  executionPaused?: boolean;
  interactionWaitTimeoutMs?: number;
};

type ProgressMessage = {
  notify?: string;
  sessionId?: string;
  progress?: {
    phase?: string;
    modelCalls?: number;
    toolCalls?: number;
    task?: ProgressTask;
  };
};

type StatusView = {
  running?: boolean;
  progress: { phase?: string; modelCalls?: number; toolCalls?: number; task: ProgressTask };
  outputTokens?: number;
};

test('status and notifications expose phase changes, approval waits, counts, and idle cleanup per session', async () => {
  await withTuiHost(async ({ client, sessionId, notifications: rawNotifications }) => {
    const notifications = rawNotifications as unknown as ProgressMessage[];
    const run = client.request('run.start', { sessionId, input: 'wait for the model' });
    await waitFor(() => notifications.some((message) => message.notify === 'progress'
      && message.progress?.phase === 'preparing' && message.progress?.task !== undefined));
    const initializedProgress = notifications.find((message) => message.notify === 'progress'
      && message.progress?.phase === 'preparing' && message.progress?.task !== undefined)!;
    assert.equal(initializedProgress.progress!.task!.maxModelCalls, 2);
    assert.equal(initializedProgress.progress!.task!.modelCalls, 0);
    await waitFor(() => notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'model_request'));
    const activeProgress = notifications.find((message) => message.notify === 'progress' && message.progress?.phase === 'model_request')!;
    const duringRequest = await client.request('status.get', { sessionId }) as StatusView;
    await run;
    assert.equal(typeof activeProgress.progress!.task!.startedAt, 'string');
    assert.equal(activeProgress.progress!.task!.executionPaused, false);
    assert.equal(duringRequest.running, true);
    assert.equal(duringRequest.progress.phase, 'model_request');
    assert.equal(duringRequest.progress.modelCalls, 1);
    assert.equal(duringRequest.progress.task.executionPaused, false);
    assert.equal(duringRequest.outputTokens, 8192);
    const settled = await client.request('status.get', { sessionId }) as StatusView;
    assert.equal(settled.running, false);
    assert.equal(settled.progress, null);

    await client.request('mode.set', { sessionId, name: 'full' });
    let question: HostRequest | undefined;
    client.onRequest((message) => {
      if (message.method === 'question.request') question = message;
    });
    const questions = JSON.stringify([{ question: 'Continue?', options: [], multiSelect: false }]);
    const waiting = client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'ask_user_question', args: { questions } }),
    });
    await waitFor(() => question !== undefined
      && notifications.some((message) => message.notify === 'progress' && message.sessionId === sessionId && message.progress?.phase === 'awaiting_input'));
    const interactionProgress = notifications.find((message) => message.notify === 'progress' && message.progress?.phase === 'awaiting_input')!;
    const awaiting = await client.request('status.get', { sessionId }) as StatusView;
    client.reply(question!.id, { answers: [{ id: 'q1', custom: 'continue' }] });
    await waiting;
    assert.equal(interactionProgress.progress!.task!.executionPaused, true);
    assert.ok(interactionProgress.progress!.task!.interactionWaitTimeoutMs! > 0);
    assert.equal(awaiting.progress.phase, 'awaiting_input');
    assert.equal(awaiting.progress.task.executionPaused, true);
    assert.equal(awaiting.progress.modelCalls, 1);
    assert.equal(awaiting.progress.toolCalls, 1);
    assert.equal((await client.request('status.get', { sessionId }) as StatusView).progress, null);
    assert.ok(notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'tool_execution'));
    assert.ok(notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'settling'));
  }, { delayMs: 250, interactive: true });
});

test('progress snapshots stay attached to their own session when runs overlap', async () => {
  let releaseSessionA: (value?: unknown) => void;
  let releaseSessionB: (value?: unknown) => void;
  const receivedUsers: string[] = [];
  const sessionAResponse = new Promise((resolve) => { releaseSessionA = resolve; });
  const sessionBResponse = new Promise((resolve) => { releaseSessionB = resolve; });
  await withTuiHost(async ({ client, sessionId: sessionA, notifications: rawNotifications }) => {
    const notifications = rawNotifications as unknown as ProgressMessage[];
    let runA: Promise<unknown>;
    let runB: Promise<unknown>;
    try {
      const { sessionId: sessionB } = await client.request('session.create', {}) as { sessionId: string };
      runA = client.request('run.start', { sessionId: sessionA, input: 'session A' });
      void runA.catch(() => undefined);
      await waitFor(() => notifications.some((message) => message.notify === 'progress' && message.sessionId === sessionA && message.progress?.phase === 'model_request'), {
        read: () => JSON.stringify({ receivedUsers, progress: notifications.filter((message) => message.notify === 'progress') }),
      });
      runB = client.request('run.start', { sessionId: sessionB, input: 'session B' });
      void runB.catch(() => undefined);
      await waitFor(
        () => notifications.some((message) => message.notify === 'progress' && message.sessionId === sessionB && message.progress?.phase === 'model_request'),
        { read: () => JSON.stringify({ receivedUsers, progress: notifications.filter((message) => message.notify === 'progress') }) },
      );
      await waitFor(
        () => receivedUsers.some((content) => content.includes('session A')) && receivedUsers.some((content) => content.includes('session B')),
        { read: () => JSON.stringify({ receivedUsers }) },
      );

      const duringA = await client.request('status.get', { sessionId: sessionA }) as StatusView;
      const duringB = await client.request('status.get', { sessionId: sessionB }) as StatusView;
      assert.equal(duringA.running, true);
      assert.equal(duringB.running, true);
      assert.equal(duringA.progress.modelCalls, 1);
      assert.equal(duringB.progress.modelCalls, 1);

      releaseSessionA();
      await runA;
      const afterA = await client.request('status.get', { sessionId: sessionA }) as StatusView;
      const stillRunningB = await client.request('status.get', { sessionId: sessionB }) as StatusView;
      assert.equal(afterA.progress, null);
      assert.equal(stillRunningB.running, true);
      assert.equal(stillRunningB.progress.phase, 'model_request');
      releaseSessionB();
      await runB;
      assert.equal((await client.request('status.get', { sessionId: sessionB }) as StatusView).progress, null);
    } finally {
      releaseSessionA();
      releaseSessionB();
    }
  }, {
    beforeResponse: async (body) => {
      const lastUser = [...body.messages].reverse().find((message) => message.role === 'user')!;
      const content = lastUser.content as string;
      receivedUsers.push(content);
      if (content.includes('session A')) await sessionAResponse;
      if (content.includes('session B')) await sessionBResponse;
    },
  });
});

test('cancellation clears the active phase after the single terminal is persisted', async () => {
  await withTuiHost(async ({ client, sessionId, notifications: rawNotifications }) => {
    const notifications = rawNotifications as unknown as ProgressMessage[];
    const running = client.request('run.start', { sessionId, input: 'cancel during model request' });
    await waitFor(() => notifications.some((message) => message.notify === 'progress' && message.progress?.phase === 'model_request'));
    await client.request('run.cancel', { sessionId });
    await assert.rejects(running, (error) => error instanceof Error && ['provider_cancelled', 'loop_cancelled'].includes((error as { code?: string }).code ?? ''));
    const status = await client.request('status.get', { sessionId }) as StatusView;
    assert.equal(status.running, false);
    assert.equal(status.progress, null);
    const events = await client.request('session.read', { sessionId }) as { events: { kind?: string; status?: string }[] };
    assert.equal(events.events.filter((event) => event.kind === 'turn').length, 1);
    assert.equal(events.events.find((event) => event.kind === 'turn')!.status, 'cancelled');
  }, { delayMs: 1000 });
});
