import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { createAgentControlRuntime } from '../../core/dist/host/agent-control-runtime.js';
import { createSessionLog } from '../../core/dist/session/session.js';
import { App } from '../dist/tui/app.js';
import { completeFrame } from './helpers/frames.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

async function withApp(context, run) {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const frame = () => completeFrame(painted);
  const output = () => painted.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const instance = render(createElement(App, {
    client: context.client,
    sessionId: context.sessionId,
    stdout,
    info: { boundary: context.projectDirectory },
  }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true });
  const wait = (condition) => waitFor(condition, { within: 15_000, read: frame });
  const type = async (text) => { stdin.write(text); await new Promise((resolve) => setTimeout(resolve, 50)); stdin.write('\r'); };
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
    let pending = [];
    let events = [{ cursor: 1, kind: 'run.started', at: Date.now(), sessionId, operationId: currentOperation }];
    const actions = [];
    let runtime;
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
      const listed = await context.client.request('sessions.list', { projectRoot: context.projectDirectory });
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
      assert.equal(actions.find((action) => action.action === 'reply').type, 'question');
      assert.deepEqual(actions.find((action) => action.action === 'reply').answers, [{ id: 'q1', selected: [], custom: 'north' }]);
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
        && request.params.projectRoot === context.projectDirectory && request.params.sessionId === sessionId));
      assert.ok(context.requests.some((request) => request.method === 'session.read' && request.params.sessionId === sessionId));
    } finally {
      await runtime.close();
      await session.close();
    }
  }));
});
