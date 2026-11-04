import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink';
import { completeFrame } from './helpers/frames.ts';
import { App } from '../dist/tui/app.js';
import type { TuiClient } from '../dist/tui/app.js';
import { UI_COMMANDS } from '../dist/tui/commands.js';
import { readInput, rememberInput } from '../dist/tui/input-store.js';
import type { SavedInput } from '../dist/tui/input-store.js';
import type { Connection } from '@ligule/core/tui.js';
import { measuredPermissionContext, waitFor, withTuiHost } from './helpers/tui-host.ts';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): void; unref(): void };
type FakeOutput = PassThrough & { columns: number; rows: number; isTTY: boolean };
type ReadEvent = { kind?: string; result?: { code?: string } };
type InputStore = {
  read(projectRoot: string, sessionId: string): Promise<SavedInput>;
  write(projectRoot: string, sessionId: string, draft: string, queued: readonly string[]): Promise<void>;
};

type AppHandle = {
  frame: () => string;
  output: () => string;
  stdin: FakeInput;
  type: (text: string) => Promise<void>;
  wait: (condition: () => boolean | Promise<boolean>) => Promise<void>;
  stdout: FakeOutput;
};

async function withApp(
  context: { client: Connection; sessionId: string; config: { boundary: string } },
  run: (app: AppHandle) => Promise<void>,
  { columns = 80, rows = 24, inputs }: { columns?: number; rows?: number; inputs?: InputStore } = {},
): Promise<void> {
  const stdout = Object.assign(new PassThrough(), { columns, rows, isTTY: true }) as FakeOutput;
  const stdin: FakeInput = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const frame = () => completeFrame(painted);
  const output = () => painted.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const instance = render(createElement(App, { client: context.client as TuiClient, sessionId: context.sessionId, stdout: stdout as unknown as NodeJS.WriteStream, inputs, info: { boundary: context.config.boundary } }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false, interactive: true });
  const wait = (condition: () => boolean | Promise<boolean>) => waitFor(condition, { read: frame });
  const type = async (text: string) => { stdin.write(text); await delay(50); stdin.write('\r'); };
  try {
    await wait(() => frame().includes('审批 逐次审批'));
    await run({ frame, output, stdin, type, wait, stdout });
  } finally {
    instance.unmount();
  }
}

test('slash discovery scrolls the whole command list and completes without sending', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, stdin, wait }) => {
    stdin.write('/');
    await wait(() => frame().includes(`1/${UI_COMMANDS.length}`));
    stdin.write('\x1b[A');
    await wait(() => frame().includes(`${UI_COMMANDS.length}/${UI_COMMANDS.length}`) && frame().includes('/quit'));
    stdin.write('\t');
    await wait(() => frame().includes('› /quit'));
    assert.equal(context.providerRequests.length, 0);
    assert.ok(frame().split('\n').length <= 24);
  }));
});

test('modal paste preserves the draft and history-search paste edits its own query', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, stdin, wait }) => {
    stdin.write('保留草稿');
    await wait(() => frame().includes('› 保留草稿'));
    stdin.write('\x0f');
    await wait(() => frame().includes('完整历史'));
    stdin.write('\x1b[200~隐藏粘贴\x1b[201~');
    await delay(80);
    stdin.write('\x1b');
    await wait(() => frame().includes('› 保留草稿'));
    assert.ok(!frame().includes('隐藏粘贴'));
    stdin.write('\x12');
    await wait(() => frame().includes('历史搜索'));
    stdin.write('\x1b[200~查询\n文字\x1b[201~');
    await wait(() => frame().includes('历史搜索 查询 文字'));
    stdin.write('\x1b');
    await wait(() => frame().includes('› 保留草稿'));
    assert.ok(!frame().includes('查询 文字'));
    assert.equal(context.providerRequests.length, 0);
  }));
});

test('long questions page their complete options while keeping an answer editor at 50x14', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, stdin, type, wait }) => {
    await type(JSON.stringify({ tool: 'ask_user_question', args: { questions: JSON.stringify([{
      question: '请阅读完整问题。'.repeat(30),
      options: Array.from({ length: 4 }, (_, index) => ({ label: `选项 ${index + 1}`, description: `说明 ${index + 1}：${'完整说明内容。'.repeat(20)} 结束-${index}` })),
    }]) } }));
    await wait(() => frame().includes('等待回答 1/1'));
    assert.ok(frame().includes('输入回答'));
    assert.ok(!frame().includes('工具模式'));
    const seen = new Set<number>();
    for (let page = 0; page < 80; page += 1) {
      const current = frame();
      assert.ok(current.trimEnd().split('\n').length <= 14, current);
      for (let index = 0; index < 4; index += 1) if (current.includes(`结束-${index}`)) seen.add(index);
      if (seen.size === 4) break;
      stdin.write('\x1b[6~');
      await delay(35);
    }
    assert.deepEqual([...seen], [0, 1, 2, 3]);
    stdin.write('\x1b');
    await wait(() => !frame().includes('等待回答'));
  }, { columns: 50, rows: 14 }), { interactive: true });
});

test('an approval with insufficient room ignores allow keys and paste while deny stays available', async () => {
  await withTuiHost(async (context) => {
    await writeFile(join(context.config.boundary, 'small-window.md'), 'read me');
    await withApp(context, async ({ frame, output, stdin, type, wait }) => {
      await type(JSON.stringify({ tool: 'read', args: { path: 'small-window.md' } }));
      await wait(() => frame().includes('请放大窗口后再审批'));
      stdin.write('y');
      await delay(50);
      stdin.write('1');
      await delay(50);
      stdin.write('\x1b[200~2\x1b[201~');
      await delay(80);
      assert.ok(frame().includes('请放大窗口后再审批'));
      const pending = await context.client.request('session.read', { sessionId: context.sessionId }) as { events: ReadEvent[] };
      assert.ok(!pending.events.some(event => event.kind === 'sessionPolicyRule'));
      stdin.write('n');
      await wait(() => !frame().includes('请放大窗口后再审批'));
      await wait(() => output().includes('本轮已完成'));
      const denied = await context.client.request('session.read', { sessionId: context.sessionId }) as { events: ReadEvent[] };
      assert.ok(denied.events.some(event => event.kind === 'tool' && event.result?.code === 'ask_declined'));
    }, { columns: 50, rows: 4 });
  });
});

test('question PageDown advances the first whole page and PageUp restores it without editing the answer', async () => {
  await withTuiHost(async context => withApp(context, async ({ frame, stdin, type, wait }) => {
    await type(JSON.stringify({ tool: 'ask_user_question', args: { questions: JSON.stringify([{
      question: Array.from({ length: 12 }, (_, index) => `问题行${index}`).join('\n'),
    }]) } }));
    await wait(() => frame().includes('等待回答 1/1') && frame().includes('问题行4'));
    stdin.write('答案草稿');
    await wait(() => frame().includes('› 答案草稿'));
    stdin.write('\x1b[6~');
    await wait(() => frame().includes('6/12'));
    assert.ok(frame().includes('问题行9'), frame());
    assert.ok(!frame().includes('问题行4'), frame());
    assert.ok(frame().includes('› 答案草稿'));
    stdin.write('\x1b[5~');
    await wait(() => frame().includes('1/12'));
    assert.ok(frame().includes('问题行0') && frame().includes('问题行4'), frame());
    assert.ok(!frame().includes('问题行5'), frame());
    assert.ok(frame().includes('› 答案草稿'));
    stdin.write('\x1b');
    await wait(() => !frame().includes('等待回答'));
  }, { columns: 50, rows: 14 }), { interactive: true });
});

for (const source of ['grant wizard', 'ordinary composer']) {
  for (const finish of ['answer', 'cancel', 'exit']) {
    test(`a Host question isolates a partial ${source} draft and preserves it through ${finish}`, async () => {
      await withTuiHost(async context => {
        const inputFile = join(context.directory, 'question-input.jsonl');
        const writes: string[] = [];
        const inputs: InputStore = {
          read: (root, id) => readInput(inputFile, root, id),
          write: async (root, id, text, queued) => {
            await rememberInput(inputFile, { projectRoot: root, sessionId: id, draft: text, queued: queued as string[] });
            writes.push(text);
          },
        };
        await withApp(context, async ({ frame, stdin, type }) => {
          const wait = (condition: () => boolean | Promise<boolean>) => waitFor(condition, { within: 5000, read: frame });
          if (source === 'grant wizard') {
            await type('/control create');
            await wait(() => frame().includes('授权名称'));
          }
          stdin.write('keepAB');
          await wait(() => frame().includes('› keepAB'));
          stdin.write('\x1b[D');
          await delay(40);
          const execution = context.client.request('run.start', { sessionId: context.sessionId, input: JSON.stringify({
            tool: 'ask_user_question', args: { questions: JSON.stringify([{ question: '请回答当前问题' }]) },
          }) });
          execution.catch(() => undefined);
          try {
            await wait(() => frame().includes('等待回答 1/1'));
            assert.ok(!frame().includes('创建外控授权'), frame());
            assert.ok(frame().includes('输入回答'), frame());
            assert.ok(!frame().includes('keepAB'), frame());
            stdin.write('真实问答答案');
            await wait(() => frame().includes('› 真实问答答案'));
            await wait(() => writes.includes('keepAB'));
            assert.equal((await readInput(inputFile, context.projectDirectory, context.sessionId)).draft, 'keepAB');
            if (finish === 'exit') {
              const saved = writes.length;
              stdin.write('\x03');
              await wait(() => writes.length > saved);
              assert.equal((await readInput(inputFile, context.projectDirectory, context.sessionId)).draft, 'keepAB');
              return;
            }
            if (finish === 'answer') stdin.write('\r');
            else await context.client.request('run.cancel', { sessionId: context.sessionId });
            if (finish === 'answer') await execution;
            else await assert.rejects(execution, error => (error as { code?: string }).code === 'loop_cancelled');
            const read = await context.client.request('session.read', { sessionId: context.sessionId }) as { events: ReadEvent[] };
            if (finish === 'answer') assert.ok(JSON.stringify(read.events).includes('真实问答答案'));
            else assert.ok(read.events.some(event => event.result?.code === 'ask_user_cancelled'));
            assert.ok(!JSON.stringify(read.events).includes('keepAB'));
            assert.ok(!context.requests.some(request => request.method === 'agent-control.create'));
            await wait(() => frame().includes('› keepAB'));
            stdin.write('X');
            await wait(() => frame().includes('› keepAXB'));
          } finally {
            await context.client.request('run.cancel', { sessionId: context.sessionId }).catch(error => {
              if (error.code !== 'run_not_running') throw error;
            });
            await execution.catch(() => undefined);
          }
        }, { inputs });
      }, { interactive: true, permissionControl: source === 'grant wizard' });
    });
  }
}

test('queue recovery during a question preserves the ordinary draft and leaves the answer separate', async () => {
  await withTuiHost(async context => {
    const inputFile = join(context.directory, 'queue-question.jsonl');
    await rememberInput(inputFile, { projectRoot: context.projectDirectory, sessionId: context.sessionId, draft: 'kept-task', queued: ['queued-task'] });
    const inputs: InputStore = {
      read: (root, id) => readInput(inputFile, root, id),
      write: (root, id, text, queued) => rememberInput(inputFile, { projectRoot: root, sessionId: id, draft: text, queued: queued as string[] }),
    };
    await withApp(context, async ({ frame, output, stdin, type }) => {
      const wait = (condition: () => boolean | Promise<boolean>) => waitFor(condition, { within: 5000, read: frame });
      await wait(() => frame().includes('› kept-task') && frame().includes('队列已暂停：1 条'));
      const execution = context.client.request('run.start', { sessionId: context.sessionId, input: JSON.stringify({
        tool: 'ask_user_question', args: { questions: JSON.stringify([{ question: '确认继续？' }]) },
      }) });
      execution.catch(() => undefined);
      try {
        await wait(() => frame().includes('等待回答 1/1'));
        stdin.write('\x7f');
        await delay(60);
        assert.ok(!frame().includes('queued-task'), frame());
        await type('/queue drop 1');
        await wait(() => output().includes('消息 1 已移回草稿'));
        assert.ok(!frame().includes('queued-task'), frame());
        await type('yes');
        await execution;
        await wait(() => frame().includes('kept-task') && frame().includes('queued-task'));
        const read = await context.client.request('session.read', { sessionId: context.sessionId }) as { events: ReadEvent[] };
        assert.ok(!JSON.stringify(read.events).includes('queued-task'));
      } finally {
        await context.client.request('run.cancel', { sessionId: context.sessionId }).catch(error => {
          if (error.code !== 'run_not_running') throw error;
        });
        await execution.catch(() => undefined);
      }
    }, { inputs });
  }, { interactive: true });
});

test('permission completion leaves the existing explicit confirmation intact', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, stdin, wait }) => {
    stdin.write('/permission network u');
    await wait(() => frame().includes('/permission network unrestricted'));
    stdin.write('\t');
    await wait(() => frame().includes('› /permission network unrestricted'));
    assert.ok(!context.requests.some(request => request.method === 'permission.set'));
    stdin.write('\r');
    await wait(() => frame().includes('确认不受限网络'));
    stdin.write('\x1b');
    await wait(() => !frame().includes('确认不受限网络'));
    assert.ok(!context.requests.some(request => request.method === 'permission.set'));
    assert.equal(context.providerRequests.length, 0);
  }), { permissionControl: true });
});

test('terminal Delete and Backspace edit opposite sides of a whole emoji', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, stdin, wait }) => {
    stdin.write('A👩‍💻B');
    await wait(() => frame().includes('A👩‍💻B'));
    stdin.write('\x1b[H');
    await delay(40);
    stdin.write('\x1b[C');
    await delay(40);
    stdin.write('\x1b[3~');
    await wait(() => frame().includes('AB') && !frame().includes('👩‍💻'));
    stdin.write('\x7f');
    await wait(() => frame().includes('› B'));
    stdin.write('\r');
    await wait(() => context.providerRequests.some(request => request.messages.some(message => message.role === 'user' && message.content === 'B')));
  }));
});

test('pasting a regional indicator moves beyond the merged flag before Backspace', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, stdin, wait }) => {
    stdin.write('🇸');
    await wait(() => frame().includes('🇸'));
    stdin.write('\x1b[H');
    await delay(40);
    stdin.write('\x1b[200~🇺\x1b[201~');
    await wait(() => frame().includes('🇺🇸'));
    stdin.write('\x7f');
    await wait(() => frame().includes('› 描述任务') && !frame().includes('🇸') && !frame().includes('🇺'));
    assert.equal(context.providerRequests.length, 0);
  }));
});

test('session filtering stays out of the draft and resumes the selected Host session', async () => {
  await withTuiHost(async (context) => {
    const other = await context.client.request('session.create', {}) as { sessionId: string };
    await context.client.request('session.label', { sessionId: other.sessionId, name: '西藏行程' });
    await withApp(context, async ({ frame, stdin, type, wait }) => {
      await type('/sessions');
      await wait(() => frame().includes('西藏行程'));
      stdin.write('找不到');
      await wait(() => frame().includes('没有匹配的会话'));
      stdin.write('\r');
      await delay(40);
      assert.ok(!context.requests.some(request => request.method === 'session.open'));
      stdin.write('\x1b');
      await wait(() => frame().includes('› 描述任务') && !frame().includes('找不到'));
      await type('/resume');
      await wait(() => frame().includes('西藏行程'));
      stdin.write('西藏');
      await wait(() => frame().includes('西藏 · 1/2'));
      stdin.write('\r');
      await wait(() => context.requests.some(request => request.method === 'session.open' && (request.params as { sessionId?: string }).sessionId === other.sessionId)
        && frame().includes('会话 西藏行程 · project'));
      assert.ok(context.requests.some(request => request.method === 'session.close' && (request.params as { sessionId?: string }).sessionId === context.sessionId));
      assert.equal(context.providerRequests.length, 0);
    });
  });
});

test('complete history opens in a bounded viewport and keyboard navigation reaches both ends', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, stdin, type, wait }) => {
    const text = Array.from({ length: 60 }, (_, index) => `历史行 ${index}`).join('\n');
    await type(text);
    await wait(() => context.notifications.some((notice) => (notice.event as { kind?: string } | undefined)?.kind === 'assistant'));
    await delay(80);
    stdin.write('\x0f');
    await wait(() => frame().includes('完整历史'));
    stdin.write('\x1b[H');
    await wait(() => frame().includes('历史行 0') && /\b1\/[1-9]\d* 行 ·/.test(frame()));
    assert.ok(frame().split('\n').length <= 24, '动态历史视图受终端高度约束');
    stdin.write('\x1b[6~');
    await wait(() => !/\b1\/\d+ 行/.test(frame()));
    stdin.write('\x1b[F');
    await wait(() => frame().includes('历史行 59'));
    stdin.write('\x1b');
    await wait(() => !frame().includes('完整历史'));
  }));
});

test('an approval exposes its entire change through pages and Escape cancels without writing', async () => {
  const permission = await measuredPermissionContext('full-access', 'policy');
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, stdin, type, wait }) => {
    const content = Array.from({ length: 40 }, (_, index) => `待审批内容 ${index}`).join('\n');
    await type(JSON.stringify({ tool: 'create', args: { path: 'approval.md', content } }));
    await wait(() => frame().includes('允许执行 create？'));
    stdin.write('\x0f');
    await wait(() => frame().includes('新内容:'));
    await wait(() => /改动 1\/\d+ 行/.test(frame()));
    stdin.write('\x1b[F');
    await wait(() => frame().includes('待审批内容 39'));
    stdin.write('\x1b');
    await wait(() => output().includes('本轮已取消'));
    await assert.rejects(access(join(context.config.boundary, 'approval.md')), (error) => (error as { code?: string }).code === 'ENOENT');
    assert.ok(context.requests.some((request) => request.method === 'run.cancel'));
  }), { permission });
});

// 提问面板逐题收集答案，并在最后一题提交后一次性返回；非选项输入作为自由回答。
const askFrame = () => JSON.stringify({
  tool: 'ask_user_question',
  args: {
    questions: JSON.stringify([
      { question: '要装哪一份依赖管理器？', header: '依赖', options: [{ label: 'npm' }, { label: 'pnpm', description: '装得更快' }] },
      { question: '还有别的要一起改吗？', multiSelect: true },
    ]),
  },
});

test('a question answers one item per Enter, lets an unsubmitted answer be changed and sends them together', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, stdin, type, wait }) => {
    await type(askFrame());
    await wait(() => frame().includes('等待回答 1/2'));
    assert.ok(frame().includes('2. pnpm —— 装得更快'), '题面画出那几条选项与它们的说明');
    assert.ok(frame().includes('没有回答时限'), '画面说明回答不会超时');

    await type('2');
    await wait(() => frame().includes('等待回答 2/2'));
    await wait(() => frame().includes('1. pnpm'));

    // 尚未提交的答案可以修改：草稿为空时按左键返回上一题，并恢复之前输入的内容。
    stdin.write('\x1b[D');
    await wait(() => frame().includes('等待回答 1/2'));
    stdin.write('\x7f');
    // 分开发送退格和后续字符，避免假终端将它们合并后漏掉退格输入。
    await delay(150);
    await type('1');
    await wait(() => frame().includes('等待回答 2/2') && frame().includes('1. npm'));

    await type('顺手把 README 也改一下');
    await wait(() => output().includes('本轮已完成'));
    const sent = JSON.stringify(context.providerRequests.at(-1));
    assert.ok(sent.includes('答：npm'), '交回模型的是改过那一份，不是第一次写的');
    assert.ok(sent.includes('答：顺手把 README 也改一下'));
  }), { interactive: true });
});

// 取消提问后应终止当前等待，并从画面中移除未回答的问题。
test('interrupting the round takes the pending question away with it', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, type, wait }) => {
    await type(askFrame());
    await wait(() => frame().includes('等待回答 1/2'));
    await context.client.request('run.cancel', { sessionId: context.sessionId });
    await wait(() => output().includes('本轮已取消'));
    await delay(120);
    assert.ok(!frame().includes('等待回答'), '取消后提问卡已关闭');
    const { events } = await context.client.request('session.read', { sessionId: context.sessionId }) as { events: ReadEvent[] };
    assert.ok(events.some((event) => event.result?.code === 'ask_user_cancelled'), '记录里说的是这一题被取消，不是超时');
  }), { interactive: true });
});
