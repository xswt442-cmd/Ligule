import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { createAgentControlRuntime } from '../../core/dist/host/agent-control-runtime.js';
import type { AgentControlRuntime } from '../../core/dist/host/agent-control-runtime.js';
import { createSessionLog } from '../../core/dist/session/session.js';
import { App } from '../dist/tui/app.js';
import { projectRecord, type TuiRecord } from '../dist/tui/transcript.js';
import type { TuiClient } from '../dist/tui/app.js';
import { completeFrame } from './helpers/frames.ts';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';
import type { TuiHostContext } from './helpers/tui-host.ts';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { isTTY: boolean; columns: number; rows: number };

type AppHandle = {
  frame: () => string;
  output: () => string;
  stdin: FakeInput;
  type: (text: string) => Promise<void>;
  wait: (condition: () => boolean) => Promise<void>;
};

type RecordedAction = { readonly action: string; readonly [key: string]: unknown };
type ControlEvent = { readonly cursor: number; readonly kind: string; readonly at: number; readonly sessionId: string; readonly operationId: string; readonly [key: string]: unknown };

async function withApp<T>(context: TuiHostContext, run: (handle: AppHandle) => Promise<T>, rows = 24) {
  const stdout: FakeOutput = Object.assign(new PassThrough(), { columns: 80, rows, isTTY: true });
  const stdin: FakeInput = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  let painted = '';
  stdout.on('data', (chunk: Buffer | string) => { painted += chunk.toString(); });
  const frame = () => completeFrame(painted);
  const output = () => painted.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const instance = render(createElement(App, {
    client: context.client as TuiClient,
    sessionId: context.sessionId,
    stdout: stdout as unknown as NodeJS.WriteStream,
    info: { boundary: context.projectDirectory },
  }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: true,
  });
  const wait = (condition: () => boolean) => waitFor(condition, { within: 15_000, read: frame });
  const type = async (text: string) => { stdin.write(text); await new Promise<void>((resolve) => setTimeout(resolve, 50)); stdin.write('\r'); };
  try {
    await wait(() => frame().includes('审批 逐次审批'));
    await run({ frame, output, stdin, type, wait });
  } finally { instance.unmount(); }
}

test('TUI observes an externally locked session, answers a question, sends guidance, and takes over', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, stdin, type, wait }) => {
    const sessionId = 'tui-external-control-session';
    const sessionDirectory = context.sessionDirectory;
    await mkdir(sessionDirectory, { recursive: true });
    const session = createSessionLog({
      directory: sessionDirectory,
      id: sessionId,
      meta: { projectRoot: context.projectDirectory },
    });
    const externalUser = await session.append({ kind: 'user', text: 'External task started.', origin: 'controller' });
    await session.append({ kind: 'turnContext', userSeq: externalUser.seq, model: 'deepseek-flash' });
    await session.append({ kind: 'assistant', text: 'The external agent is checking the workspace.', toolCalls: [] });
    await session.acquire();

    const questions = [{ id: 'q1', question: 'Choose a route', options: [{ label: 'north' }, { label: 'south' }], multiSelect: false }];
    let currentOperation = 'external-question-run';
    let currentState = 'running';
    let failFirstQuestionReply = true;
    let pending: { requestId: string; sessionId: string; operationId: string; type: 'question'; createdAt: number; details: { questions: typeof questions } }[] = [];
    let events: ControlEvent[] = [{ cursor: 1, kind: 'run.started', at: Date.now(), sessionId, operationId: currentOperation }];
    const actions: RecordedAction[] = [];
    let runtime: AgentControlRuntime;
    runtime = createAgentControlRuntime(context.projectDirectory, async (requestedSession, request) => {
      assert.equal(requestedSession, sessionId);
      actions.push(request);
      if (request.action === 'status') {
        return {
          operationId: currentOperation,
          sessionId,
          state: currentState,
          ownership: 'external',
          phase: pending.length > 0 ? 'awaiting_input' : null,
          progress: null,
          pendingInteractions: pending,
          events: events.filter((event) => event.cursor > request.after).slice(0, request.limit),
          nextCursor: events.at(-1)?.cursor ?? request.after,
          hasMoreEvents: false,
          eventGap: false,
          firstAvailableCursor: events[0]?.cursor ?? 1,
          queue: [],
          queuePaused: false,
          currentOperationId: currentState === 'running' ? currentOperation : null,
        };
      }
      if (request.action === 'reply') {
        if (failFirstQuestionReply) {
          failFirstQuestionReply = false;
          throw Object.assign(new Error('test_reply_failed'), { code: 'test_reply_failed' });
        }
        pending = [];
        currentState = 'done';
        events = [...events, { cursor: 2, kind: 'interaction.resolved', at: Date.now(), sessionId, operationId: currentOperation, source: 'human' }];
        return { sessionId, requestId: request.requestId, source: 'human', resolved: true };
      }
      if (request.action === 'send') {
        await session.append({ kind: 'user', text: request.input, origin: 'human' });
        await session.append({ kind: 'assistant', text: 'TUI guidance received.', toolCalls: [] });
        currentOperation = 'external-human-guidance-run';
        currentState = 'done';
        events = [{ cursor: 1, kind: 'session.event', at: Date.now(), sessionId, operationId: currentOperation, eventKind: 'assistant', eventSeq: 4 }];
        return { sessionId, accepted: true, queued: false, operationId: currentOperation, state: 'running', queue: [], queuePaused: false, currentOperationId: currentOperation };
      }
      if (request.action === 'takeover') {
        await session.close();
        await runtime.unregister(sessionId);
        return { sessionId, ownership: 'human', released: true, operationId: currentOperation };
      }
      if (request.action === 'cancel') {
        currentState = 'cancelled';
        pending = [];
        return { sessionId, operationId: currentOperation, state: currentState, terminated: true };
      }
      throw Object.assign(new Error('test_action_unknown'), { code: 'test_action_unknown' });
    });

    try {
      await runtime.register(sessionId);
      const listed = await context.client.request('sessions.list', { projectRoot: context.projectDirectory }) as { sessions: { id: string }[] };
      assert.ok(listed.sessions.some((item) => item.id === sessionId), JSON.stringify(listed));
      await type(`/resume ${sessionId}`);
      await wait(() => output().includes('External session connected') || output().includes('外控会话已连接'));
      // The question panel replaces the composer and its settings row. Verify the external model before exposing the question.
      await wait(() => frame().includes('External model deepseek-flash') || frame().includes('外控模型 deepseek-flash'));
      pending = [{ requestId: 'human-question-1', sessionId, operationId: currentOperation, type: 'question', createdAt: Date.now(), details: { questions } }];
      await wait(() => output().includes('Waiting for your answer') || output().includes('等待回答'));
      await wait(() => frame().includes('Choose a route'));
      await wait(() => output().includes('外部 Agent: External task started.'));

      stdin.write('north');
      await wait(() => frame().split('\n').some((line) => line.trim().endsWith('north') && !line.includes('1. north') && !line.includes('2. north')));
      stdin.write('\r');
      await wait(() => output().includes('test_reply_failed'));
      assert.doesNotMatch(output(), /Submitted 1\/1 answers to the external session|已提交 1\/1 个回答/u,
        'the TUI must not report success before the Host accepts the answer');
      await wait(() => frame().includes('Choose a route')
        && frame().split('\n').some((line) => line.trim().endsWith('north') && !line.includes('1. north') && !line.includes('2. north')));
      stdin.write('\r');
      await wait(() => output().includes('answers to the external session') || output().includes('回答（外控会话）'));
      await wait(() => actions.filter((action) => action.action === 'reply').length === 2);
      assert.equal(actions.find((action) => action.action === 'reply')!.type, 'question');
      assert.deepEqual(actions.find((action) => action.action === 'reply')!.answers, [{ id: 'q1', selected: [], custom: 'north' }]);
      await wait(() => output().includes('Submitted 1/1 answers') || output().includes('已提交 1/1 个回答'));
      await wait(() => !frame().includes('Choose a route'));

      await type('Please keep the northern route.');
      await wait(() => actions.some((action) => action.action === 'send' && action.input === 'Please keep the northern route.'));
      let transcript = await session.read();
      const transcriptDeadline = Date.now() + 5_000;
      while (!transcript.some((event) => event.kind === 'assistant' && event.text === 'TUI guidance received.') && Date.now() < transcriptDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        transcript = await session.read();
      }
      assert.ok(transcript.some((event) => event.kind === 'user' && event.text === 'Please keep the northern route.' && event.origin === 'human'));
      assert.ok(transcript.some((event) => event.kind === 'assistant' && event.text === 'TUI guidance received.'));

      await type('/takeover');
      await wait(() => actions.some((action) => action.action === 'takeover')
        && !frame().includes('外控会话已连接') && !frame().includes('External session connected'));
      assert.equal(actions.some((action) => action.action === 'takeover'), true);
      assert.ok(context.requests.some((request) => request.method === 'session.open'
        && (request.params as { projectRoot?: string }).projectRoot === context.projectDirectory && (request.params as { sessionId?: string }).sessionId === sessionId));
      assert.ok(context.requests.some((request) => request.method === 'session.read' && (request.params as { sessionId?: string }).sessionId === sessionId));
    } finally {
      await runtime.close();
      await session.close();
    }
  }));
});

test('TUI restores persisted records once when overlapping gap refreshes return out of order', async () => {
  await withTuiHost(async (context) => {
    const sessionId = 'tui-external-control-gap-session';
    const session = createSessionLog({
      directory: context.sessionDirectory,
      id: sessionId,
      meta: { projectRoot: context.projectDirectory },
    });
    await session.append({ kind: 'user', text: 'The external task is already running.', origin: 'controller' });
    await session.append({ kind: 'assistant', text: 'Earlier persisted assistant record.', toolCalls: [] });
    await session.acquire();

    let gapReady = false;
    let gapDelivered = false;
    let followUpReady = false;
    let followUpDelivered = false;
    let lateReadReady = false;
    let lateReadDelivered = false;
    let statusCalls = 0;
    let transcriptReads = 0;
    let resolveFirstRead: () => void = () => {};
    let releaseOlderResponse: () => void = () => {};
    let resolveFirstResponse: () => void = () => {};
    let releaseLateResponse: () => void = () => {};
    let lateSnapshotCaptured = false;
    let resolveLateResponseReturned: () => void = () => {};
    let olderReadIncludedMarker = false;
    let latestReadIncludedMarker = false;
    let latestEventIncludedMarker = false;
    let latestProjectedRowCount = 0;
    const firstReadReady = new Promise<void>((resolve) => { resolveFirstRead = resolve; });
    const olderResponseReleased = new Promise<void>((resolve) => { releaseOlderResponse = resolve; });
    const firstResponseReturned = new Promise<void>((resolve) => { resolveFirstResponse = resolve; });
    const lateResponseReleased = new Promise<void>((resolve) => { releaseLateResponse = resolve; });
    const lateResponseReturned = new Promise<void>((resolve) => { resolveLateResponseReturned = resolve; });
    const actions: RecordedAction[] = [];
    const runtime: AgentControlRuntime = createAgentControlRuntime(context.projectDirectory, async (requestedSession, request) => {
      assert.equal(requestedSession, sessionId);
      actions.push(request);
      if (request.action === 'status') {
        statusCalls += 1;
        const eventGap = gapReady && !gapDelivered;
        const followUp = followUpReady && !followUpDelivered;
        const lateRead = lateReadReady && !lateReadDelivered;
        if (eventGap) gapDelivered = true;
        if (followUp) followUpDelivered = true;
        if (lateRead) lateReadDelivered = true;
        return {
          operationId: 'external-gap-operation',
          sessionId,
          state: 'done',
          ownership: 'external',
          phase: null,
          progress: null,
          pendingInteractions: [],
          events: eventGap ? [{ cursor: 130, kind: 'session.event', at: Date.now(), sessionId,
            operationId: 'external-gap-operation', eventKind: 'assistant', eventSeq: 3 }]
            : followUp ? [{ cursor: 131, kind: 'session.event', at: Date.now(), sessionId,
              operationId: 'external-gap-operation', eventKind: 'assistant', eventSeq: 5 }]
              : lateRead ? [{ cursor: 132, kind: 'session.event', at: Date.now(), sessionId,
                operationId: 'external-gap-operation', eventKind: 'assistant', eventSeq: 6 }] : [],
          nextCursor: eventGap ? 130 : followUp ? 131 : lateRead ? 132 : 1,
          hasMoreEvents: false,
          eventGap,
          firstAvailableCursor: eventGap ? 130 : 1,
          queue: [],
          queuePaused: false,
          currentOperationId: 'external-gap-operation',
        };
      }
      if (request.action === 'takeover') {
        await session.close();
        await runtime.unregister(sessionId);
        return { sessionId, ownership: 'human', released: true, operationId: 'external-gap-operation' };
      }
      throw Object.assign(new Error('test_action_unknown'), { code: 'test_action_unknown' });
    });
    const originalRequest = context.client.request.bind(context.client);
    context.client.request = async (method, params) => {
      if (method !== 'session.observe' || !gapReady) return await originalRequest(method, params);
      transcriptReads += 1;
      const readNumber = transcriptReads;
      if (readNumber === 1) {
        const older = await originalRequest(method, params);
        await session.append({ kind: 'assistant', text: 'P6 newest persisted assistant record.', toolCalls: [] });
        olderReadIncludedMarker = JSON.stringify(older).includes('P6 newest persisted assistant record');
        resolveFirstRead();
        await olderResponseReleased;
        resolveFirstResponse();
        return older;
      }
      if (readNumber === 2) {
        await firstReadReady;
        const latest = await originalRequest(method, params);
        latestReadIncludedMarker = JSON.stringify(latest).includes('P6 newest persisted assistant record');
        const latestEvents = (latest as { events: { kind: string; text?: string }[] }).events;
        latestEventIncludedMarker = latestEvents.some((event) => event.kind === 'assistant' && event.text === 'P6 newest persisted assistant record.');
        latestProjectedRowCount = latestEvents.flatMap((event) => projectRecord(event as unknown as TuiRecord)).length;
        return latest;
      }
      if (readNumber === 4) {
        const late = await originalRequest(method, params);
        lateSnapshotCaptured = true;
        await lateResponseReleased;
        resolveLateResponseReturned();
        return late;
      }
      return await originalRequest(method, params);
    };

    try {
      await runtime.register(sessionId);
      await withApp(context, async ({ frame, output, type, wait }) => {
        await type(`/resume ${sessionId}`);
        await wait(() => output().includes('External session connected') || output().includes('外控会话已连接'));
        assert.ok(context.requests.some((request) => request.method === 'session.open'
          && (request.params as { sessionId?: string }).sessionId === sessionId), 'TUI opened the intended persisted Session');
        await wait(() => statusCalls >= 2);
        await session.append({ kind: 'assistant', text: 'P6 first overlapping persisted assistant record.', toolCalls: [] });
        gapReady = true;
        await wait(() => transcriptReads === 2);
        await wait(() => output().includes('P6 newest persisted assistant record'));
        assert.equal(olderReadIncludedMarker, false, 'the first transcript snapshot was captured before the new record was appended');
        assert.equal(latestReadIncludedMarker, true, 'the later transcript snapshot contains the new record');
        assert.equal(latestEventIncludedMarker, true, 'the later Host read contains the persisted assistant event');
        assert.ok(latestProjectedRowCount > 0, 'the persisted event has a transcript projection');
        assert.ok(output().includes('外控实时事件出现缺口'), 'the TUI clearly marks that some live events are missing');
        const outputCount = (marker: string) => output().split(marker).length - 1;
        assert.equal(outputCount('P6 first overlapping persisted assistant record'), 1,
          'the newer snapshot emits the first persisted record once');
        assert.equal(outputCount('P6 newest persisted assistant record'), 1,
          'the newer snapshot emits the second persisted record once');
        releaseOlderResponse();
        await firstResponseReturned;
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.ok(output().includes('P6 newest persisted assistant record'),
          `a delayed old session.observe result must not overwrite the latest record; older=${olderReadIncludedMarker}, latest=${latestReadIncludedMarker}, event=${latestEventIncludedMarker}, projected=${latestProjectedRowCount}, reads=${transcriptReads}\n${frame()}\n${output().slice(-1_200)}`);
        assert.equal(outputCount('P6 newest persisted assistant record'), 1,
          'the persisted record must appear once after transcript recovery');
        assert.equal(outputCount('P6 first overlapping persisted assistant record'), 1,
          'the delayed older snapshot must not emit the first record again');
        await session.append({ kind: 'assistant', text: 'P6 follow-up persisted assistant record.', toolCalls: [] });
        followUpReady = true;
        await wait(() => transcriptReads >= 3 && frame().includes('P6 follow-up persisted assistant record'));
        assert.equal(outputCount('P6 first overlapping persisted assistant record'), 1,
          'the next refresh must not repeat records below the committed cursor');
        assert.equal(outputCount('P6 newest persisted assistant record'), 1,
          'the next refresh must not repeat records from the newer snapshot');
        assert.equal(outputCount('P6 follow-up persisted assistant record'), 1,
          'the next refresh appends only the newly persisted record');
        assert.ok(output().indexOf('P6 first overlapping persisted assistant record')
          < output().indexOf('P6 newest persisted assistant record')
          && output().indexOf('P6 newest persisted assistant record')
            < output().indexOf('P6 follow-up persisted assistant record'),
        'persisted assistant records remain in sequence order');
        await session.append({ kind: 'assistant', text: 'P6 stale-session response record.', toolCalls: [] });
        lateReadReady = true;
        await wait(() => transcriptReads >= 4 && lateSnapshotCaptured);
        await type(`/resume ${context.sessionId.slice(0, 8)}`);
        await wait(() => frame().includes(`会话 ${context.sessionId.slice(0, 8)}`));
        assert.equal(outputCount('P6 stale-session response record'), 0,
          'a pending snapshot from the previous Session has not been applied');
        releaseLateResponse();
        await lateResponseReturned;
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(outputCount('P6 stale-session response record'), 0,
          'a delayed snapshot from the previous Session must not enter the selected Session view');
        assert.ok(actions.some((action) => action.action === 'status'));
      }, 60);
    } finally {
      releaseOlderResponse();
      releaseLateResponse();
      await runtime.close();
      await session.close();
    }
  });
});
