// 覆盖终端界面的渲染、输入和折叠行为。Ink 与 React 未安装时跳过这些测试。
// 显式启用交互渲染，避免 CI 环境变量让 Ink 停止更新画面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { measuredPermissionContext, waitFor, withTuiHost } from './helpers/tui-host.ts';
import { completeFrame } from './helpers/frames.ts';
import { HISTORY_LIMIT, historyPathOf, loadHistory, pushHistory, rememberHistory } from '../../core/dist/kernel/input-history.js';
import { SEARCH_ROWS, searchHistory } from '../dist/tui/history.js';
import { helpEntries, helpTabTitle } from '../dist/tui/help.js';
import type { Locale } from '../../core/dist/tui.js';
import type { TuiClient } from '../dist/tui/app.js';
import type { SavedInput } from '../dist/tui/input-store.js';
import type { StatusLike } from '../dist/tui/status-line.js';
import type { TranscriptItem } from '../dist/tui/transcript.js';

type AppModule = typeof import('../dist/tui/app.js');
type FakeOutput = PassThrough & NodeJS.WriteStream;
type FakeInput = PassThrough & NodeJS.ReadStream;

let rows = {} as AppModule;
let missing = '';
const previousForceColor = process.env.FORCE_COLOR;
process.env.FORCE_COLOR = '1';
try {
  rows = await import('../dist/tui/app.js');
} catch (error) {
  const failure = error as { code?: string; message?: string };
  missing = failure.code === 'ERR_MODULE_NOT_FOUND' ? 'the terminal UI dependencies are not installed' : failure.message as string;
} finally {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
}

const options = { skip: missing === '' ? false : missing };
const editorFixture = fileURLToPath(new URL('./fixtures/editor.mjs', import.meta.url));
const mcpServerFixture = fileURLToPath(new URL('../../tests/fixtures/mcp-minimal.mjs', import.meta.url));
const { foldText, editDraft, buildStatusLine, activeRunBudgetSegment, contextSegment, findRecord, branchOf, detailTitle, routeInput, candidatesOf, describeChange, displayWidth, UI_COMMANDS, markdownLines, changeSummary, capabilityOf, queuedLine, sessionLines, findLines, mentionToken, insertMention, resolveSessionId, SESSION_ROWS, isTypingRun } = rows;
// 界面记录只带界面关心的字段；测试直接写这种不带 `seq` 的投影输入。
const projectRecord = rows.projectRecord as (record: Record<string, unknown>, locale?: Locale) => TranscriptItem[];
const quoted = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
const plainOutput = (value: string) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

function assertInTestplace(path: string) {
  const root = resolve('testplace');
  const absolutePath = resolve(path);
  const relativePath = relative(root, absolutePath);
  assert.ok(relativePath !== '' && !isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  return absolutePath;
}

test('a record becomes the rows the terminal shows, one line each', options, () => {
  assert.deepEqual(projectRecord({ kind: 'user', text: '读一下' }), [{ kind: 'question', text: '读一下' }]);
  assert.deepEqual(projectRecord({ kind: 'user', text: '检查这个项目', origin: 'controller' }), [{ kind: 'question', text: '检查这个项目', source: 'controller' }]);
  assert.deepEqual(projectRecord({ kind: 'reasoning', text: '先看' }), [{ kind: 'reasoning', text: '先看' }]);
  assert.deepEqual(
    projectRecord({ kind: 'assistant', text: '我来读', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'note.txt' } }] }),
    [
      { kind: 'answer', text: '我来读' },
      { kind: 'call', tool: 'read', text: '{"path":"note.txt"}' },
    ],
  );
});

test('an assistant record with only tool calls leaves no empty answer line', options, () => {
  assert.deepEqual(projectRecord({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'exec', args: {} }] }),
    [{ kind: 'call', tool: 'exec', text: '{}' }]);
});

test('a refusal reads as a refusal, a failure as a failure, and structured content is drawn as text', options, () => {
  assert.deepEqual(
    projectRecord({ kind: 'tool', tool: 'exec', result: { kind: 'refusal', failed: true, code: 'ask_declined', reason: 'the user declined', content: '' } }),
    [{ kind: 'refusal', tool: 'exec', text: 'the user declined', code: 'ask_declined' }],
  );
  assert.deepEqual(
    projectRecord({ kind: 'tool', tool: 'exec', result: { kind: 'failure', failed: true, code: 'exec_timeout', reason: undefined, content: '' } }),
    [{ kind: 'failure', tool: 'exec', text: '', code: 'exec_timeout' }],
  );
  const [row] = projectRecord({ kind: 'tool', tool: 'read', result: { kind: 'result', failed: false, code: undefined, content: { text: 'a body' } } });
  assert.equal(row.kind, 'result');
  // 工具结果只显示 `text` 正文，不显示其他元数据。
  assert.equal(row.text, 'a body', '正文画正文');
});

test('a record kind the terminal does not draw yields no rows instead of guessing', options, () => {
  assert.deepEqual(projectRecord({ kind: 'something-new' }), []);
});

// 未知斜杠命令应原样交给 `run.start`，由 Host 展开提示模板。
test('a slash line the UI table does not own goes to the host as one message', options, () => {
  assert.deepEqual(routeInput('  读一下 note.txt  ', false), { kind: 'run', text: '读一下 note.txt' });
  assert.deepEqual(routeInput('/tools', false), { kind: 'command', name: 'tools', argument: '' });
  assert.deepEqual(routeInput('/browser', false), { kind: 'command', name: 'browser', argument: '' });
  assert.deepEqual(routeInput('/rename 我的会话', true), { kind: 'command', name: 'rename', argument: '我的会话' });
  assert.deepEqual(routeInput('/browser stop', true), { kind: 'command', name: 'browser', argument: 'stop' });
  assert.deepEqual(routeInput('/browser resume', true), { kind: 'command', name: 'browser', argument: 'resume' });
  assert.deepEqual(routeInput('/MODE now', false), { kind: 'command', name: 'mode', argument: 'now' });
  // 模板命令不在界面命令表中，仍应由 Host 正常处理。
  assert.deepEqual(routeInput('/git:release:prepare 3', false), { kind: 'run', text: '/git:release:prepare 3' });
  assert.deepEqual(routeInput('/', false), { kind: 'command', name: 'help', argument: '' });
  // 运行中的命令不可用时，应与未知命令返回不同的提示。
  assert.deepEqual(routeInput('/new', true), { kind: 'blocked', usage: '/new' });
  assert.deepEqual(routeInput('/new', false), { kind: 'command', name: 'new', argument: '' });
});

test('the draft edits around a caret instead of only appending', options, () => {
  assert.deepEqual(editDraft('abc', 3, 'd', {}), { draft: 'abcd', caret: 4 });
  assert.deepEqual(editDraft('abcd', 4, '', { leftArrow: true }), { draft: 'abcd', caret: 3 });
  assert.deepEqual(editDraft('abcd', 3, '', { backspace: true }), { draft: 'abd', caret: 2 });
  assert.deepEqual(editDraft('abcd', 4, '', { home: true }), { draft: 'abcd', caret: 0 });
  assert.deepEqual(editDraft('abcd', 0, '', { end: true }), { draft: 'abcd', caret: 4 });
  assert.deepEqual(editDraft('rm -rf  ', 8, 'w', { ctrl: true }), { draft: 'rm ', caret: 3 });
  assert.deepEqual(editDraft('oops', 4, 'u', { ctrl: true }), { draft: '', caret: 0 });
  // 一次粘贴应将全部内容写入草稿，并将光标移到末尾。
  assert.deepEqual(editDraft('> ', 2, 'a\nb', {}), { draft: '> a\nb', caret: 5 });
});

test('long content folds to a few lines and counts what is hidden', options, () => {
  const six = ['1', '2', '3', '4', '5', '6'].join('\n');
  assert.deepEqual(foldText(six, false), { shown: '1\n2\n3', hidden: 6 });
  assert.deepEqual(foldText(six, true), { shown: six, hidden: 0 });
  assert.deepEqual(foldText('one\n two', false, 1), { shown: 'one', hidden: 5 });
  // 无换行的长 JSON 也应折行显示，避免超出终端宽度。
  const long = 'x'.repeat(500);
  assert.deepEqual(foldText(long, false, 3, 400), { shown: 'x'.repeat(400), hidden: 100 });
  // 结构化内容应按文本折行显示，不应出现 `[object Object]`。
  assert.equal(foldText({ text: 'a body' }, false).shown.includes('[object Object]'), false);
});

test('the app paints the session line and the input hint onto the terminal', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 80;
  stdout.isTTY = false;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = new PassThrough() as unknown as FakeInput;
  stdin.isTTY = false;
  const status = await (client as TuiClient).request('status.get', { sessionId });

  const instance = render(
    createElement(App, { client: client as TuiClient, sessionId, info: { model: 'test-model' }, interactive: false }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  // 非交互渲染只在结束时输出一次；等待界面发送 `status.get` 后再检查最终状态。
  await waitFor(() => requests.some((request) => request.method === 'status.get'), { read: () => painted });
  await delay(300);
  instance.unmount();
  await waitFor(() => /工具模式 minimal/.test(painted) && /审批 逐次审批/.test(painted), { read: () => painted });

  assert.match(painted, /欢迎使用 Ligule/);
  assert.match(painted, new RegExp(`会话 ${sessionId.slice(0, 8)}`));
  const configurationLine = plainOutput(painted).split(/\r?\n/u).filter((line) => line.includes('模型 ') && line.includes('工具模式 ')).at(-1);
  assert.ok(configurationLine, '模型、工具模式和审批方式共用一行底部配置');
  assert.equal(configurationLine.split(status.model as string).length - 1, 1, '模型名在底部配置行只显示一次');
  assert.match(painted, /工具模式 minimal/);
  assert.match(painted, /审批 逐次审批/);
  assert.match(painted, /\/ 命令/);
}));

test('the metadata line keeps the session and its workspace, never budgets or counts', options, () => {
  const status = {
    mode: 'minimal', pendingMode: null, policy: 'ask', tools: ['read', 'find'], eventCount: 3,
    usage: { window: 200_000, threshold: 160_000, estimated: 42_000 },
  } as unknown as StatusLike;
  const line = buildStatusLine({ sessionId: 'abcdef0123456789', boundary: 'C:\\workspace\\project', status, running: true, seconds: 12.7, expanded: true, columns: 180 });
  assert.match(line, /会话 abcdef01/);
  assert.match(line, /project/);
  assert.doesNotMatch(line, /ctx:|记录 3 条|次模型调用|输出token/);
  assert.match(line, /12 秒.*Esc.*打断/);
  assert.match(line, /已展开.*收起/);
  assert.doesNotMatch(line, /minimal|policy|test-model|model:/);
  assert.equal(contextSegment(null), '');
  assert.equal(contextSegment(undefined), '');
  const noWindow = buildStatusLine({ sessionId: 'abcdef0123456789', status: { ...status, usage: undefined } as unknown as StatusLike, running: false, seconds: 0, expanded: false });
  assert.doesNotMatch(noWindow, /ctx:/);
  assert.doesNotMatch(noWindow, /minimal|policy|model:/);
});

test('a named session shows its name on the metadata line instead of the short id', options, () => {
  const status = { mode: 'minimal', policy: 'ask', tools: [], eventCount: 1 } as unknown as StatusLike;
  const named = buildStatusLine({ sessionId: 'abcdef0123456789', name: '整理 P7 的界面', boundary: 'C:\workspace\project', status, running: false, seconds: 0, expanded: false, columns: 120 });
  assert.match(named, /会话 整理 P7 的界面/);
  assert.doesNotMatch(named, /abcdef01/);
  const unnamed = buildStatusLine({ sessionId: 'abcdef0123456789', name: '   ', boundary: 'C:\workspace\project', status, running: false, seconds: 0, expanded: false, columns: 120 });
  assert.match(unnamed, /会话 abcdef01/);
  for (const columns of [40, 60, 80]) {
    const line = buildStatusLine({ sessionId: 'abcdef0123456789', name: '整理 P7 的界面', boundary: 'C:\workspace\project', status, running: true, seconds: 5, expanded: false, columns });
    assert.ok(displayWidth(line) <= columns, `named status line exceeds ${columns} columns`);
  }
});

test('the metadata line identifies the Host phase and elapsed time since actual progress', options, () => {
  const status = {
    mode: 'minimal', policy: 'ask', tools: [], eventCount: 1,
    progress: {
      phase: 'model_request', startedAt: 1_000, phaseStartedAt: 2_000, lastProgressAt: 4_000,
      modelCalls: 2, toolCalls: 1, outputTokens: 16_384,
    },
  } as unknown as StatusLike;
  const line = buildStatusLine({ sessionId: 'session-id', status, running: true, seconds: 6, expanded: false, now: 11_000 });
  assert.match(line, /请求模型/);
  assert.match(line, /7 秒无新进展/);
  assert.doesNotMatch(line, /2 次模型调用|1 个工具调用|16384/);
  const english = buildStatusLine({ sessionId: 'session-id', status, running: true, seconds: 6, expanded: false, locale: 'en', now: 11_000 });
  assert.match(english, /Requesting model/);
  assert.match(english, /7s without progress/);
  for (const locale of ['zh', 'en'] as const) {
    for (const columns of [60, 80, 120]) {
      const narrow = buildStatusLine({ sessionId: 'session-id', status, running: true, seconds: 6,
        expanded: false, now: 11_000, locale, columns });
      assert.ok(displayWidth(narrow) <= columns, `${locale} progress exceeds ${columns} columns`);
      assert.match(narrow, locale === 'zh' ? /请求模型/ : /Requesting model/);
      assert.match(narrow, /7/);
    }
  }
});

test('English terminal labels preserve model content, paths and command help entries', options, () => {
  const help = [...helpEntries('commands', [], 'en'), ...helpEntries('keys', [], 'en'), ...helpEntries('templates', [], 'en')]
    .map((entry) => `${entry.key} ${entry.description}`).join('\n');
  assert.match(help, /\/model \[service model\]/);
  assert.match(help, /Global/);
  assert.doesNotMatch(help, /[\u3400-\u9fff]/u);
  assert.equal(candidatesOf('/mo', [], 8, 'en').find(command => command.name === 'model')!.hint, '[service model]');
  assert.deepEqual(projectRecord({ kind: 'user', text: '中文问题' }, 'en'), [{ kind: 'question', text: '中文问题' }]);
  assert.equal(projectRecord({ kind: 'turn', status: 'cancelled' }, 'en')[0].text, 'Turn cancelled');
  const changed = describeChange('edit', { path: '中文目录/note.txt', anchor: '原文', replacement: '新文' }, 'en');
  assert.match(changed.summary, /^中文目录\/note.txt: replace/);
  assert.equal(changed.before, '原文');
  assert.equal(changed.after, '新文');
});

test('a mode switch and an expanded template both reach the transcript', options, () => {
  assert.deepEqual(
    projectRecord({ kind: 'mode', name: 'full', layer: 'shipped', tools: ['read', 'skill'] }),
    [{ kind: 'meta', text: '工具模式：full（随包）' }],
  );
  assert.deepEqual(
    projectRecord({ kind: 'user', text: 'Review src/a.ts\n', raw: '/review:security src/a.ts' }),
    [{ kind: 'question', text: '/review:security src/a.ts' }],
  );
});

test('/show takes the number from the record, not the row on screen', options, () => {
  const events = [{ seq: 0, kind: 'mode' }, { seq: 1, kind: 'user', text: 'hi' }];
  assert.deepEqual(findRecord(events, '1'), { record: events[1] });
  // 格式错误的编号和不存在的编号应返回不同提示；空编号用于折叠，不走这条错误路径。
  assert.equal((findRecord(events, 'third') as { code: string }).code, 'tui_show_needs_a_number');
  assert.equal((findRecord(events, '-1') as { code: string }).code, 'tui_show_needs_a_number');
  assert.equal((findRecord(events, '7') as { record: unknown }).record, null);
});

// 派生会话使用父记录中对应结果的编号，并从结果内容读取派生会话 ID。
test('/sub reads the branch reference out of the delegation result', options, () => {
  assert.ok(UI_COMMANDS.some((command) => command.name === 'sub'), 'the command is listed in help');
  const branch = { kind: 'tool', tool: 'subagent', result: { failed: false, content: { sessionId: 'parent.sub-1', text: 'done' } } };
  assert.deepEqual(branchOf({ seq: 4, ...branch }), { sessionId: 'parent.sub-1' });
  assert.equal((branchOf({ seq: 4, kind: 'tool', tool: 'read', result: { content: { sessionId: 'x' } } }) as { code: string }).code, 'tui_sub_needs_a_branch');
  assert.equal((branchOf({ seq: 4, kind: 'user', text: 'hi' }) as { code: string }).code, 'tui_sub_needs_a_branch');
  // 结果过长时内容写入文件，记录中不包含 sessionId。
  const spilled = { seq: 4, kind: 'tool', tool: 'subagent', result: { failed: false, content: 'a truncated string', spilled: 'result-1.json' } };
  assert.deepEqual(branchOf(spilled), { code: 'tui_sub_reference_spilled', spilled: 'result-1.json' });

  // 标题应标明主会话或派生会话，因为两者的记录编号各自独立。
  assert.equal(detailTitle({ seq: 3, kind: 'assistant' }), '记录 3（assistant）的完整内容 · /show 收起');
  assert.match(detailTitle({ seq: 4, kind: 'subagent', branch: 'parent.sub-1' }), /^支线 parent\.sub-1，父记录第 4 那一次派生/);
  assert.match(detailTitle({ seq: 4, kind: 'subagent', branch: 'parent.sub-1' }), /支线自己的 · \/sub 收起$/);
});

// 审批提示应显示命令语法和实际执行的程序，因为不同后端可能对同一命令给出不同结论。
test('the approval box names the shell backend and its executable', options, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async ({ client, sessionId }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const run = client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command: 'git --version' } }) });
    // 等待确认提示渲染后再输入拒绝答案，避免按键进入草稿。
    await waitFor(() => /执行环境：(powershell|bash) · /.test(painted), { read: () => painted });
    stdin.write('n');
    await run;
  } finally {
    instance.unmount();
  }

  assert.match(painted, /允许执行 exec？/);
  assert.match(painted, /git --version/);
  assert.match(painted, /执行环境：(powershell|bash) · /);
  }, { permission });
});

test('the TUI remembers a session-scoped approval and applies it after the next user request', options, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const { createElement } = await import('react');
    const { render } = await import('ink');
    const { PassThrough } = await import('node:stream');
    const { App } = await import('../dist/tui/app.js');
    await writeFile(join(projectDirectory, 'note.txt'), 'TUI approval memory');
    const stdout = new PassThrough() as unknown as FakeOutput;
    stdout.columns = 110;
    stdout.isTTY = true;
    let painted = '';
    stdout.on('data', (chunk) => { painted += chunk; });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
    let approvalCount = 0;
    const onRequest = client.onRequest.bind(client);
    client.onRequest = (handler) => onRequest((message) => {
      if (message.method === 'approval.request') approvalCount += 1;
      return handler(message);
    });
    const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true }), {
      stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true,
    });
    try {
      const first = client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'read', args: { path: 'note.txt' } }) });
      // 记住规则收在第二层：先看到入口，按 m 展开后才出现规则选项。
      await waitFor(() => painted.includes('记住规则'), { read: () => painted });
      stdin.write('m');
      await waitFor(() => painted.includes('2 记住本会话'), { read: () => painted });
      stdin.write('2');
      await first;
      assert.equal(approvalCount, 1);
      const records = await (client as TuiClient).request('session.read', { sessionId });
      assert.ok(records.events.some((event) => event.kind === 'sessionPolicyRule' && (event.rule as { tool: string }).tool === 'read'));

      await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'read', args: { path: 'note.txt' } }) });
      assert.equal(approvalCount, 1);
    } finally {
      instance.unmount();
    }
  });
});

test('the TUI shows the MCP program before trusting it and starts it only after confirmation', options, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const { createElement } = await import('react');
    const { render } = await import('ink');
    const { PassThrough } = await import('node:stream');
    const { App } = await import('../dist/tui/app.js');
    const markerPath = join(projectDirectory, 'mcp-started.pid');
    const stdout = new PassThrough() as unknown as FakeOutput;
    stdout.columns = 110;
    stdout.isTTY = true;
    let painted = '';
    stdout.on('data', (chunk) => { painted += chunk; });
    const shown = () => plainOutput(painted);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
    const instance = render(createElement(App, {
      client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
    }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
    const sendCommand = async (text: string) => {
      const start = painted.length;
      const currentDraft = () => plainOutput(completeFrame(painted.slice(start)));
      stdin.write(text);
      await waitFor(() => currentDraft().includes(`› ${text}`), { within: 5_000, read: currentDraft });
      stdin.write('\r');
    };
    try {
      const trustServer = await (client as TuiClient).request('mcp.trust.list', { projectRoot: projectDirectory });
      const server = trustServer.servers[0];
      assert.equal(server.name, 'probe');
      assert.equal(server.trust, null);
      await sendCommand('/mcp trust missing project');
      await waitFor(() => shown().includes('mcp_server_unknown'), { within: 5_000, read: shown });

      await sendCommand('/mcp trust probe project');
      await waitFor(() => shown().includes('待确认：probe') && shown().includes(mcpServerFixture), { within: 5_000, read: shown });
      await assert.rejects(() => access(markerPath), (error) => (error as { code?: string }).code === 'ENOENT');

      await sendCommand('/mcp confirm');
      await waitFor(() => shown().includes('已在project范围信任 probe'), { within: 5_000, read: shown });
      await sendCommand('/mcp tools probe');
      await waitFor(() => shown().includes('echo one value'), { within: 5_000, read: shown });
      const pid = Number(await readFile(markerPath, 'utf8'));
      assert.ok(pid > 0);
      const trusted = await (client as TuiClient).request('mcp.trust.list', { projectRoot: projectDirectory });
      assert.equal(trusted.servers[0].trust?.trusted, true);

      await sendCommand('/mcp revoke probe project');
      await waitFor(() => shown().includes('已撤销 probe 的 project 信任。'), { within: 5_000, read: shown });
      const revoked = await (client as TuiClient).request('mcp.trust.list', { projectRoot: projectDirectory });
      assert.equal(revoked.servers[0].trust?.trusted, false);
    } finally {
      instance.unmount();
    }
  }, {
    config: { mcp: { servers: { probe: { command: process.execPath, args: [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid'] } } } },
    setup: async ({ projectDirectory }) => {
      await writeFile(join(projectDirectory, 'mcp-schema.json'), JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }));
      await mkdir(join(projectDirectory, '.ligule'), { recursive: true });
      await writeFile(join(projectDirectory, '.ligule', 'config.toml'), [
        '[mcp.servers.probe]',
        'command = ' + JSON.stringify(process.execPath),
        'args = [' + [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid'].map((value) => JSON.stringify(value)).join(', ') + ']',
        '',
      ].join('\n'));
    },
  });
});

test('a delayed MCP trust list cannot move session trust to a newly opened Session', options, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
    const { createElement } = await import('react');
    const { render } = await import('ink');
    const { PassThrough } = await import('node:stream');
    const { App } = await import('../dist/tui/app.js');
    const originalRequest = client.request.bind(client);
    let releaseTrustList: (value?: unknown) => void = () => {};
    let trustListStarted = false;
    let trustListSettled = false;
    let nextSessionId: string | undefined;
    const trustListGate = new Promise((resolve) => { releaseTrustList = resolve; });
    client.request = (method, params) => {
      const pending = originalRequest(method, params);
      if (method === 'mcp.trust.list' && (params as { sessionId?: string }).sessionId === sessionId) {
        trustListStarted = true;
        return pending.then(async (snapshot) => {
          await trustListGate;
          trustListSettled = true;
          return snapshot;
        });
      }
      if (method === 'session.create') {
        return pending.then((created) => {
          nextSessionId = (created as { sessionId: string }).sessionId;
          return created;
        });
      }
      return pending;
    };

    const stdout = new PassThrough() as unknown as FakeOutput;
    stdout.columns = 110;
    stdout.isTTY = true;
    let painted = '';
    stdout.on('data', (chunk) => { painted += chunk; });
    const shown = () => plainOutput(painted);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
    const instance = render(createElement(App, {
      client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
    }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
    const sendCommand = async (text: string) => {
      const start = painted.length;
      const currentDraft = () => plainOutput(painted.slice(start));
      stdin.write(text);
      await waitFor(() => currentDraft().includes(`› ${text}`), { within: 5_000, read: currentDraft });
      stdin.write('\r');
    };

    try {
      await waitFor(() => shown().includes('描述任务'), { read: shown });
      await sendCommand('/mcp trust probe session');
      await waitFor(() => trustListStarted && requests.some((request) =>
        request.method === 'mcp.trust.list' && (request.params as { sessionId?: string }).sessionId === sessionId), { within: 5_000, read: shown });

      await sendCommand('/new');
      await waitFor(() => nextSessionId !== undefined && nextSessionId !== sessionId
        && shown().includes(nextSessionId.slice(0, 8)), { within: 5_000, read: shown });
      releaseTrustList();
      await waitFor(() => trustListSettled, { within: 5_000, read: shown });
      await sendCommand('/mcp confirm');
      await waitFor(() => shown().includes('没有待确认的 MCP Server 信任请求'), { within: 5_000, read: shown });

      assert.equal(requests.some((request) => request.method === 'mcp.trust.set'), false,
        'a trust request started in the prior Session must never be submitted for the new Session');
      const sessionTrust = await originalRequest('mcp.trust.list', { projectRoot: projectDirectory, sessionId: nextSessionId }) as { servers: readonly { trustScopes: { session: unknown } }[] };
      assert.equal(sessionTrust.servers[0]?.trustScopes.session, null);
    } finally {
      releaseTrustList();
      instance.unmount();
    }
  }, {
    config: { mcp: { servers: { probe: { command: process.execPath, args: [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid'] } } } },
    setup: async ({ projectDirectory }) => {
      await writeFile(join(projectDirectory, 'mcp-schema.json'), JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }));
      await mkdir(join(projectDirectory, '.ligule'), { recursive: true });
      await writeFile(join(projectDirectory, '.ligule', 'config.toml'), [
        '[mcp.servers.probe]',
        'command = ' + JSON.stringify(process.execPath),
        'args = [' + [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid'].map((value) => JSON.stringify(value)).join(', ') + ']',
        '',
      ].join('\n'));
    },
  });
});

test('a completed MCP trust confirmation is reported to its originating Session after navigation', options, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
    const { createElement } = await import('react');
    const { render } = await import('ink');
    const { PassThrough } = await import('node:stream');
    const { App } = await import('../dist/tui/app.js');
    const originalRequest = client.request.bind(client);
    let releaseTrustSet: (value?: unknown) => void = () => {};
    let trustSetApplied = false;
    let trustSetSettled = false;
    let newSessionId: string | undefined;
    let thirdSessionId: string | undefined;
    let createdSessions = 0;
    let failNextTrustSet = false;
    let trustFailureApplied = false;
    let trustFailureSettled = false;
    let trustFailureCode: string | undefined;
    let releaseTrustFailure: (value?: unknown) => void = () => {};
    const trustSetGate = new Promise((resolve) => { releaseTrustSet = resolve; });
    const trustFailureGate = new Promise((resolve) => { releaseTrustFailure = resolve; });
    client.request = (method, params) => {
      if (method === 'mcp.trust.set' && (params as { sessionId?: string }).sessionId === newSessionId && failNextTrustSet) {
        failNextTrustSet = false;
        return originalRequest(method, { ...(params as Record<string, unknown>), identityDigest: '0'.repeat(64) }).catch(async (error) => {
          trustFailureCode = error.code ?? String(error);
          trustFailureApplied = true;
          await trustFailureGate;
          trustFailureSettled = true;
          throw error;
        });
      }
      const pending = originalRequest(method, params);
      if (method === 'mcp.trust.set' && (params as { sessionId?: string }).sessionId === sessionId) {
        return pending.then(async (result) => {
          trustSetApplied = true;
          await trustSetGate;
          trustSetSettled = true;
          return result;
        });
      }
      if (method === 'session.create') {
        return pending.then((created) => {
          createdSessions += 1;
          if (createdSessions === 1) newSessionId = (created as { sessionId: string }).sessionId;
          else thirdSessionId = (created as { sessionId: string }).sessionId;
          return created;
        });
      }
      return pending;
    };

    const stdout = new PassThrough() as unknown as FakeOutput;
    stdout.columns = 110;
    stdout.isTTY = true;
    let painted = '';
    stdout.on('data', (chunk) => { painted += chunk; });
    const shown = () => plainOutput(painted);
    const shownSince = (start: number) => plainOutput(painted.slice(start));
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
    const instance = render(createElement(App, {
      client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
    }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
    const sendCommand = async (text: string) => {
      const start = painted.length;
      const currentDraft = () => plainOutput(completeFrame(painted.slice(start)));
      stdin.write(text);
      await waitFor(() => currentDraft().includes(`› ${text}`), { within: 5_000, read: currentDraft });
      stdin.write('\r');
    };

    try {
      await waitFor(() => shown().includes('描述任务'), { read: shown });
      await sendCommand('/mcp trust probe session');
      await waitFor(() => shown().includes('待确认：probe'), { within: 5_000, read: shown });
      await sendCommand('/mcp confirm');
      await waitFor(() => trustSetApplied && requests.some((request) =>
        request.method === 'mcp.trust.set' && (request.params as { sessionId?: string }).sessionId === sessionId), { within: 5_000, read: shown });

      await sendCommand('/new');
      await waitFor(() => newSessionId !== undefined && newSessionId !== sessionId
        && shown().includes(newSessionId.slice(0, 8)), { within: 5_000, read: shown });
      const outputAfterNewSession = painted.length;
      releaseTrustSet();
      await waitFor(() => trustSetSettled, { within: 5_000, read: shown });
      assert.doesNotMatch(plainOutput(painted.slice(outputAfterNewSession)), /probe is trusted at session scope/u,
        'a trust result must not be appended to another Session');

      const originalSessionOutput = painted.length;
      await sendCommand(`/resume ${sessionId.slice(0, 8)}`);
      await waitFor(() => shown().includes(`已恢复会话 ${sessionId.slice(0, 8)}`)
        && plainOutput(painted.slice(originalSessionOutput)).includes('已在session范围信任 probe'), { within: 5_000, read: shown });

      const trusted = await originalRequest('mcp.trust.list', { projectRoot: projectDirectory, sessionId }) as { servers: readonly { trustScopes: { session: unknown } }[] };
      assert.notEqual(trusted.servers[0]?.trustScopes.session, null, 'the confirmed trust must remain bound to the original Session');

      await sendCommand(`/resume ${newSessionId!.slice(0, 8)}`);
      await waitFor(() => shown().includes(`已恢复会话 ${newSessionId!.slice(0, 8)}`), { within: 5_000, read: shown });
      failNextTrustSet = true;
      const failurePromptOutput = painted.length;
      await sendCommand('/mcp trust probe session');
      await waitFor(() => shownSince(failurePromptOutput).includes('待确认：probe'), { within: 5_000, read: () => shownSince(failurePromptOutput) });
      await sendCommand('/mcp confirm');
      await waitFor(() => trustFailureApplied && typeof trustFailureCode === 'string', { within: 5_000, read: shown });

      await sendCommand('/new');
      await waitFor(() => thirdSessionId !== undefined && thirdSessionId !== newSessionId
        && shown().includes(thirdSessionId.slice(0, 8)), { within: 5_000, read: shown });
      const outputAfterThirdSession = painted.length;
      releaseTrustFailure();
      await waitFor(() => trustFailureSettled, { within: 5_000, read: shown });
      assert.doesNotMatch(plainOutput(painted.slice(outputAfterThirdSession)), /MCP Server 未获信任/u,
        'a trust failure must not be appended to another Session');

      const failedSessionOutput = painted.length;
      await sendCommand(`/resume ${newSessionId!.slice(0, 8)}`);
      await waitFor(() => shown().includes(`已恢复会话 ${newSessionId!.slice(0, 8)}`)
        && plainOutput(painted.slice(failedSessionOutput)).includes('MCP Server 未获信任'), { within: 5_000, read: shown });
      const failedSessionTrust = await originalRequest('mcp.trust.list', { projectRoot: projectDirectory, sessionId: newSessionId }) as { servers: readonly { trustScopes: { session: unknown } }[] };
      assert.equal(failedSessionTrust.servers[0]?.trustScopes.session, null, 'a rejected trust change must not be stored');
    } finally {
      releaseTrustSet();
      releaseTrustFailure();
      instance.unmount();
    }
  }, {
    config: { mcp: { servers: { probe: { command: process.execPath, args: [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid'] } } } },
    setup: async ({ projectDirectory }) => {
      await writeFile(join(projectDirectory, 'mcp-schema.json'), JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }));
      await mkdir(join(projectDirectory, '.ligule'), { recursive: true });
      await writeFile(join(projectDirectory, '.ligule', 'config.toml'), [
        '[mcp.servers.probe]',
        'command = ' + JSON.stringify(process.execPath),
        'args = [' + [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid'].map((value) => JSON.stringify(value)).join(', ') + ']',
        '',
      ].join('\n'));
    },
  });
});

// 命令补全按名称和说明筛选，名称前缀优先，参数候选只插入草稿。
test('the candidate list narrows on what is typed and appends host templates', options, () => {
  const templates = [{ command: 'git:release:prepare', description: '准备一次发布', hint: '<序号>' }];
  assert.deepEqual(candidatesOf('读一下', templates), []);
  assert.equal(candidatesOf('/', templates).length, UI_COMMANDS.length + 1);
  // 动态模式名仍由模式选择面板提供。
  assert.deepEqual(candidatesOf('/mode ', templates), []);
  const [only] = candidatesOf('/mo', templates);
  assert.deepEqual([only.name, only.hint, only.source], ['mode', '[名字]', 'ui']);
  assert.deepEqual(
    candidatesOf('/git', templates).map((c) => [c.name, c.source, c.text]),
    [['git:release:prepare', 'template', '准备一次发布']],
  );
  assert.equal(candidatesOf('/', templates, 8).length, 8);
  assert.ok(candidatesOf('/恢复').some(command => command.name === 'resume'));
  assert.ok(candidatesOf('/approval mode', [], undefined, 'en').some(command => command.name === 'policy'));
  assert.ok(candidatesOf('/tool mode', [], undefined, 'en').some(command => command.name === 'mode'));
  assert.ok(candidatesOf('/credentials', [], undefined, 'en').some(command => command.name === 'credentials'));
  assert.deepEqual(candidatesOf('/policy a').map(command => command.name), ['policy always', 'policy ask', 'policy auto']);
  assert.deepEqual(candidatesOf('/permission network d').map(command => command.name), ['permission network disabled']);
  assert.deepEqual(candidatesOf('/permission  n').map(command => command.name), ['permission network']);
  assert.deepEqual(candidatesOf('/permission \t network\t d').map(command => command.name), ['permission network disabled']);
  assert.deepEqual(candidatesOf('/policy\ta').map(command => command.name), ['policy always', 'policy ask', 'policy auto']);
  assert.deepEqual(candidatesOf('/queue drop 2'), []);
  assert.deepEqual(candidatesOf('/queue l').map(command => command.name), ['queue list']);
  assert.deepEqual(candidatesOf('/git:release:prepare ', templates), []);
  assert.equal(candidatesOf('/', [{ command: 'help', description: 'shadowed' }]).filter(command => command.name === 'help').length, 1);
});

// 帮助条目按终端宽度排版，空间不足时整体换行，不截断文本。
// 列宽按终端显示宽度计算，以正确处理汉字等双宽字符。
test('display width counts wide Chinese characters and emoji columns', options, () => {
  assert.equal(displayWidth('a中'), 3);
  assert.equal(displayWidth('🦕'), 2);
});

test('help entries preserve host templates and keep the empty state brief', options, () => {
  assert.equal(helpTabTitle('commands', 'zh'), '命令');
  assert.deepEqual(
    helpEntries('templates', [{ command: 'git:release:prepare', description: '准备一次发布', hint: '' }], 'zh'),
    [{ key: '/git:release:prepare', description: '准备一次发布' }],
  );
  const empty = helpEntries('templates', [], 'zh');
  assert.equal(empty.length, 1);
  assert.match(empty[0].description, /没有可用提示模板/);
  assert.doesNotMatch(`${empty[0].key} ${empty[0].description}`, /\.ligule|prompts|~/u);
});

// 验证终端补全后由 Host 展开模板，并将结果发送到本地 HTTP 模型端点。
test('typing a template command completes it and expands through the host', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    stdin.write('/gi');
    await waitFor(() => /git:release:prepare/.test(plainOutput(painted)), { read: () => plainOutput(painted) });
    stdin.write('\t');
    await waitFor(() => /› \/git:release:prepare/.test(plainOutput(painted)), { read: () => plainOutput(painted) });
    stdin.write('3');
    await delay(200);
    stdin.write('\r');
    await waitFor(() => providerRequests.some((request) => request.messages.some((message) => message.role === 'user' && message.content === 'Prepare release 3.\n')), { read: () => plainOutput(painted) });
  } finally {
    // 无论断言是否通过都卸载 Ink，避免输入监听和计时器阻止测试进程退出。
    instance.unmount();
  }
}, { setup: async ({ projectDirectory }) => {
  const promptDirectory = join(projectDirectory, '.ligule', 'prompts');
  await mkdir(promptDirectory, { recursive: true });
  const templateDirectory = join(promptDirectory, 'git', 'release');
  await mkdir(templateDirectory, { recursive: true });
  await cp(fileURLToPath(new URL('./fixtures/git-release-prepare.md', import.meta.url)), join(templateDirectory, 'prepare.md'));
} }));

// 助手消息应保留代码围栏内容，并为标题、列表、强调和行内代码标注样式范围。
test('markdown text splits into the shapes a terminal can show', options, () => {
  assert.deepEqual(markdownLines('## 要做三件事\n- 读 `note.txt`\n- **改** 一处\n1. 跑一次\n'), [
    { kind: 'heading', text: '要做三件事' },
    { kind: 'list', text: '· 读 note.txt', spans: [{ text: '· 读 ' }, { text: 'note.txt', scope: 'md-codespan' }] },
    { kind: 'list', text: '· 改 一处', spans: [{ text: '· ' }, { text: '改', scope: 'md-strong' }, { text: ' 一处' }] },
    { kind: 'list', text: '1. 跑一次' },
  ]);
  // 代码围栏中的 `#` 不作为标题解析，行尾空格也应保留。
  const shellLines = markdownLines('```sh\n# 注释   \nls -la\n```');
  assert.deepEqual(shellLines.map(({ kind, text }) => ({ kind, text })), [{ kind: 'code', text: '# 注释   ' }, { kind: 'code', text: 'ls -la' }]);
  assert.ok(shellLines[0].spans!.some((span) => span.scope?.startsWith('comment')), '代码注释带高亮范围');
  const jsLines = markdownLines('```js\nconst a = 1\n```');
  assert.equal(jsLines[0].text, 'const a = 1', '高亮不改变代码正文');
  assert.ok(jsLines[0].spans!.some((span) => span.scope?.startsWith('keyword')), 'JavaScript 关键字带高亮范围');
  // 保留链接文字和地址；去掉 Markdown 标记，同时保留斜体的样式范围。
  assert.deepEqual(markdownLines('看 [文档](https://example.com/a) 与 a*b*c'), [
    { kind: 'text', text: '看 文档 (https://example.com/a) 与 abc', spans: [{ text: '看 文档 (https://example.com/a) 与 a' }, { text: 'b', scope: 'md-em' }, { text: 'c' }] },
  ]);
  assert.deepEqual(markdownLines('第一行\n\n第二行'), [{ kind: 'text', text: '第一行' }, { kind: 'text', text: '' }, { kind: 'text', text: '第二行' }]);
});

// 工具调用显示策略检查使用的能力名，而不是通用的 `mcp.call` 工具名。
test('an MCP call shows the capability it actually used', options, () => {
  assert.equal(capabilityOf('mcp.call', { server: 'fs', tool: 'read_file' }), 'mcp:fs/read_file');
  assert.equal(capabilityOf('mcp.call', { server: 'fs' }), 'mcp.call', '参数不完整时不拼一个半截的名字');
  assert.equal(capabilityOf('read', { path: 'a' }), 'read');
  const [call] = projectRecord({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'mcp.call', args: { server: 'fs', tool: 'read_file', args: {} } }] });
  assert.equal(call.tool, 'mcp:fs/read_file');
  const [done] = projectRecord({ kind: 'tool', tool: 'mcp.call', args: { server: 'fs', tool: 'read_file' }, result: { kind: 'result', failed: false, content: { text: 'a body', effectiveCapability: 'mcp:fs/read_file' } } });
  assert.deepEqual([done.tool, done.text], ['mcp:fs/read_file', 'a body']);
  const [nestedTarget] = projectRecord({
    kind: 'tool', tool: 'mcp.call', args: { server: 'fs', tool: 'read_file', arguments: '{"path":"docs/guide.md"}' },
    result: { kind: 'result', failed: false, content: { text: 'a body', effectiveCapability: 'mcp:fs/read_file' } },
  });
  assert.deepEqual([nestedTarget.tool, nestedTarget.target], ['mcp:fs/read_file', 'docs/guide.md']);
});

// 命令结果的标题行应显示退出码，以区分成功和失败。
test('an exec result names its exit code and a spilled one names its file', options, () => {
  const [ok] = projectRecord({ kind: 'tool', tool: 'exec', result: { kind: 'result', failed: false, content: { text: 'done', exitCode: 0 } } });
  assert.deepEqual([ok.tool, ok.text, ok.exitCode], ['exec', 'done', 0]);
  const [spilled] = projectRecord({ kind: 'tool', tool: 'read', result: { kind: 'result', failed: false, content: { text: 'a body' }, spilled: 'result-3.json' } });
  assert.equal(spilled.spilled, 'result-3.json');
  // 拒绝结果没有 content，界面应显示拒绝理由。
  const [refused] = projectRecord({ kind: 'tool', tool: 'write', result: { kind: 'refusal', failed: true, code: 'ask_declined', reason: 'the user declined', content: '' } });
  assert.deepEqual(refused, { kind: 'refusal', tool: 'write', text: 'the user declined', code: 'ask_declined' });
});

// 文件修改审批应说明变更内容，不在界面中显示完整文件正文。
test('the approval box sums the change instead of dumping the payload', options, () => {
  assert.equal(changeSummary('write', { path: 'note.txt', content: 'a\nb\nc' }), 'note.txt：写入 3 行');
  assert.equal(changeSummary('edit', { path: 'note.txt', anchor: 'a\nb', replacement: 'x' }), 'note.txt：替换 2 行，写入 1 行');
  assert.equal(changeSummary('delete', { path: 'note.txt' }), '将 note.txt 移入系统回收站');
  assert.equal(changeSummary('exec', { command: 'ls' }), '', '命令那一行文本由 detail 那一条说，这里不重复');
  assert.equal(changeSummary('write', { content: 'a\nb' }), '', '参数里没有路径就不编造一个对象');
  // 审批详情只展示工具参数提供的内容；未读取的正文和已删除文件的内容不显示。
  const edit = describeChange('edit', { path: 'note.txt', anchor: 'a\nb', replacement: 'x' });
  assert.equal(edit.before, 'a\nb');
  assert.equal(edit.after, 'x');
  assert.equal(describeChange('create', { path: 'note.txt', content: 'a' }).before, '', '整份写入不编造一份没读过的原内容');
  const removed = describeChange('delete', { path: 'note.txt' });
  assert.equal(removed.before, '');
  assert.equal(removed.after, '');
  assert.match(removed.action, /回收站/);
});

// 通过真实渲染路径检查助手消息的结构化显示。
test('an answer with markdown shapes paints a heading, a list and highlighted code from the host', options, async () => withTuiHost(async ({ client, sessionId }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    stdin.write('请原样保留这些内容：\n## 两步\n- 先看\n```js\nconst a = 1\n```\n退出码那行是 **0**');
    await delay(80);
    stdin.write('\r');
    await waitFor(() => /\x1B\[36mconst\x1B\[39m/.test(painted), { read: () => painted });
  } finally {
    instance.unmount();
  }

  const plain = painted.replace(/\x1B\[[0-9;]*m/g, '');
  const response = plain.split('Local response:').at(-1) ?? '';
  assert.match(response, /两步/);
  assert.match(response, /· 先看/);
  assert.match(response, / {2}const a = 1/, '围栏里那一行带缩进画出来');
  assert.doesNotMatch(response, /## 两步/, '井号不留在助手画面上');
  assert.doesNotMatch(response, /\*\*0\*\*/, '加粗的星号也不留在助手画面上');
  assert.match(painted, /\x1B\[36mconst\x1B\[39m/, '代码关键字通过高亮颜色呈现');
}));

// 队列预览最多显示每条消息的前 64 个字符，避免重复展示完整内容。
test('a queued line is clipped to one row', options, () => {
  assert.equal(queuedLine('短的一句'), '短的一句');
  assert.equal(queuedLine('x'.repeat(70)).length, 65);
  assert.match(queuedLine('x'.repeat(70)), /…$/);
});

// 运行期间按 Enter 会将消息加入队列；本轮结束后按顺序发送，空草稿时按退格可收回最后一条。
test('input typed while a round runs queues up and flushes in order', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  // 分开发送文本和回车，模拟键盘的两次独立输入。
  const type = async (text: string) => { stdin.write(text); await delay(80); stdin.write('\r'); await delay(200); };
  // 从完整输出流读取最新一帧，避免旧帧内容干扰断言。
  const lastFrame = () => completeFrame(painted);
  try {
    await waitFor(() => painted.includes('描述任务'), { read: () => painted });
    await type('第一条');
    const started = () => requests.filter((request) => request.method === 'run.start').map((request) => (request.params as { input?: unknown }).input);
    await waitFor(() => started().length === 1, { read: () => painted });
    assert.deepEqual(started(), ['第一条'], '第一句直接进这一轮');
    await type('第二条');
    await type('第三条');
    await waitFor(() => /排队 2 条/.test(lastFrame()), { read: () => lastFrame() });
    assert.deepEqual(started(), ['第一条'], '跑着的时候不再开第二轮');

    // 草稿为空时按退格，将队列最后一条消息移回草稿。
    stdin.write('\x7f');
    await waitFor(() => /第三条/.test(lastFrame()) && /排队 1 条/.test(lastFrame()), { read: () => lastFrame() });

    // 队列在第一轮结束后才自动接上：等 Host 真的结束这一轮，而不是赌一个固定的墙钟预算。
    await waitFor(() => started().length === 2, { read: () => painted });
    assert.deepEqual(started(), ['第一条', '第二条'], '本轮结束后按先后接上');
  } finally {
    // 无论断言是否通过都卸载 Ink，避免输入监听和计时器阻止测试进程退出。
    instance.unmount();
  }
}, { delayMs: 1_800 }));

// 上下文占用属于预算细节：常驻行不显示，只在 /status 里出现。
test('the metadata line never carries context pressure', options, () => {
  assert.equal(contextSegment(null), '');
  assert.equal(contextSegment(undefined), '');
  assert.equal(contextSegment({ window: 200_000, threshold: 160_000, estimated: 42_000 }), 'ctx:~42000/200000');
  assert.equal(contextSegment({ window: 200_000, threshold: 160_000, estimated: 168_000 }), 'ctx:~168000/200000 超限');

  const status = {
    mode: 'full', pendingMode: null, policy: 'ask', tools: ['a', 'b'], eventCount: 4,
    denials: { consecutive: 0, total: 0 }, usage: { window: 200_000, threshold: 160_000, estimated: 42_000 },
  } as unknown as StatusLike;
  const draw = (columns: number) => buildStatusLine({ sessionId: 'x', status, running: false, seconds: 0, expanded: false, columns });
  assert.doesNotMatch(draw(200), /ctx:/);
  assert.doesNotMatch(draw(64), /ctx:/);
  assert.doesNotMatch(draw(200), /mode:|policy:|tools:/);
  assert.ok(UI_COMMANDS.some((command) => command.name === 'compact'), '/compact 在命令表里');
});

test('/status describes only the active run budget and formats it in both languages', options, () => {
  const status = {
    running: true,
    task: {
      modelCalls: 3, maxModelCalls: 64, timeoutMs: 1_800_000, interactionWaitTimeoutMs: 43_200_000,
      interactionWaitMs: 90_000, executionElapsedMs: 31_000, executionPaused: true,
    },
  };
  const chinese = activeRunBudgetSegment(status, 'zh');
  assert.match(chinese, /Run 模型调用 3\/64/);
  assert.match(chinese, /执行剩余 29分29秒/);
  assert.match(chinese, /累计交互等待 1分30秒\/12小时/);
  assert.match(chinese, /执行期限已暂停/);

  const english = activeRunBudgetSegment(status, 'en');
  assert.match(english, /Run model calls 3\/64/);
  assert.match(english, /execution 29m 29s left/);
  assert.match(english, /interaction wait 1m 30s\/12h/);
  assert.match(english, /deadline paused/);
});

test('/status does not present a completed task as active and labels a missing live snapshot', options, () => {
  assert.equal(activeRunBudgetSegment({ running: false, task: {
    modelCalls: 3, maxModelCalls: 64, timeoutMs: 1_800_000, interactionWaitTimeoutMs: 43_200_000,
    interactionWaitMs: 90_000, executionElapsedMs: 31_000, executionPaused: false,
  } }, 'zh'), '');
  assert.match(activeRunBudgetSegment({ running: true, task: null, taskLimits: { maxModelCalls: 64 }, progress: { modelCalls: 2 } } as unknown as StatusLike, 'en'),
    /model calls 2 · run budget initializing/);
  assert.match(activeRunBudgetSegment({ running: true, task: null }, 'zh'), /Run 预算准备中/);
});

test('/status ignores a previous task snapshot until the current progress carries its budget', options, () => {
  const previous = {
    modelCalls: 11, maxModelCalls: 64, timeoutMs: 1_800_000, interactionWaitTimeoutMs: 43_200_000,
    interactionWaitMs: 90_000, executionElapsedMs: 31_000, executionPaused: false, startedAt: '2026-10-30T23:00:00.000Z',
  };
  const startedAt = Date.parse('2026-10-31T00:00:00.000Z');
  const initializing = activeRunBudgetSegment({ running: true, task: previous, taskLimits: { maxModelCalls: 64 }, progress: {
    phase: 'preparing', startedAt, modelCalls: 0,
  } } as unknown as StatusLike, 'en');
  assert.match(initializing, /model calls 0 · run budget initializing/);

  const current = { ...previous, modelCalls: 2, startedAt: '2026-10-31T00:00:00.000Z' };
  const active = activeRunBudgetSegment({ running: true, task: previous, progress: {
    phase: 'model_request', startedAt, modelCalls: 2, task: current,
  } } as unknown as StatusLike, 'en');
  assert.match(active, /model calls 2\/64/);
});

test('the metadata line shortens the workspace path and keeps the interrupt hint when narrow', options, () => {
  const status = {
    mode: 'minimal', pendingMode: null, policy: 'ask', policySource: 'session', tools: ['a', 'b', 'c'], eventCount: 1234,
    denials: { consecutive: 0, total: 0 }, usage: { window: 200_000, threshold: 160_000, estimated: 42_000 },
  } as unknown as StatusLike;
  const args = {
    sessionId: 'abcdef0123456789', status, seconds: 12.7,
    boundary: 'C:\\Users\\20411\\AppData\\Local\\Temp\\ligule-tui-7Rm2Qx\\project',
  };
  const idle = { running: false, expanded: false };
  const busy = { running: true, expanded: false };
  const draw = (columns: number, extra: { running: boolean; expanded: boolean }) => buildStatusLine({ ...args, ...extra, columns });
  // 完整路径只进 /status；常驻行到最窄仍保留会话与工作区叶子名。
  assert.ok(draw(180, idle).endsWith(' · project'), '宽终端也只显示工作区叶子名');
  assert.doesNotMatch(draw(180, idle), /Temp\\/);
  assert.match(draw(60, idle), / · project/);
  assert.match(draw(30, busy), /Esc.*打断/);
  assert.doesNotMatch(draw(180, idle), /minimal|policy|model:|tools:/);
});

test('a mode change during an active turn becomes effective on the next turn', options, async () => withTuiHost(async ({ client, sessionId, providerRequests }) => {
  const running = client.request('run.start', { sessionId, input: 'hold the current mode for this turn' });
  try {
    await waitFor(() => providerRequests.length > 0, { within: 10_000, read: () => `provider requests: ${providerRequests.length}` });
    const switched = await (client as TuiClient).request('mode.set', { sessionId, name: 'full' });
    assert.equal(switched.pending, 'full');
    const during = await (client as TuiClient).request('status.get', { sessionId });
    assert.equal(during.mode, 'minimal');
    assert.equal(during.pendingMode, 'full');
    await running;
    const after = await (client as TuiClient).request('status.get', { sessionId });
    assert.equal(after.mode, 'full');
    assert.equal(after.pendingMode, null);
  } finally {
    await running.catch(() => {});
  }
}, { delayMs: 1_800 }));

// `/sessions` 从 Host 获取会话列表，`/resume` 使用列表中对应的会话 ID。
test('the session listing is one row per record and an id prefix resolves to one of them', options, () => {
  const listed = [
    { id: '5f3c1234-aaaa-bbbb-cccc-dddddddddddd', updatedAt: '2026-10-05T09:12:34.567Z', events: 12, mode: { name: 'full' }, unanswered: 0 },
    { id: '5f3d9999-aaaa-bbbb-cccc-dddddddddddd', updatedAt: '2026-10-04T08:00:00.000Z', events: 3, mode: null, unanswered: 2 },
  ];
  assert.deepEqual(sessionLines(listed, '5f3d9999-aaaa-bbbb-cccc-dddddddddddd'), [
    '2026-10-05 09:12:34  5f3c1234-aaaa-bbbb-cccc-dddddddddddd  12 条  mode:full',
    '2026-10-04 08:00:00  5f3d9999-aaaa-bbbb-cccc-dddddddddddd  3 条  mode:-  未收尾 2 次派发  ← 当前会话',
  ], '时间只到秒、id 整串写出来、没收尾的那几处都画在这一行上');
  assert.deepEqual(sessionLines([]), ['此工作区暂无会话']);
  assert.equal(SESSION_ROWS > 0, true);

  assert.equal((resolveSessionId('5f3c', listed) as { id: string }).id, listed[0].id, '前缀唯一对上就用那一份');
  assert.equal((resolveSessionId('5F3C1234-AAAA-bbbb-cccc-dddddddddddd', listed) as { id: string }).id, listed[0].id, '整串照抄也对得上，大小写不分');
  assert.equal((resolveSessionId('5f3', listed) as { code: string }).code, 'tui_session_ambiguous', '对上两份就不猜，让人多写几段');
  assert.equal((resolveSessionId('nope', listed) as { code: string }).code, 'tui_session_not_listed');
  assert.equal((resolveSessionId('', listed) as { code: string }).code, 'tui_session_ambiguous', '空的那一段对上的是一份都对不上，而不是随便挑一份');

  // 切换会话后不再接收旧会话运行产生的事件，但仍可读取旧会话记录。
  assert.equal(routeInput('/resume 5f3c', true).kind, 'blocked');
  assert.equal(routeInput('/new', true).kind, 'blocked');
  assert.equal(routeInput('/sessions', true).kind, 'command');
});

// 查询结果应同时显示会话 ID 和记录编号。
test('a search hit line names the session and the event to open', options, () => {
  assert.deepEqual(findLines([
    { sessionId: '5f3c1234-aaaa-bbbb-cccc-dddddddddddd', seq: 7, kind: 'tool', text: 'npm run 读数 跑完了', name: '读数那一份', spilled: 'result-7-abcdef12.json' },
    { sessionId: '5f3d9999-aaaa-bbbb-cccc-dddddddddddd', seq: 0, kind: 'label', text: '读数那一份', name: '读数那一份' },
  ], '5f3d9999-aaaa-bbbb-cccc-dddddddddddd'), [
    '5f3c1234  「读数那一份」  工具 第 7 条  npm run 读数 跑完了  整段在 result-7-abcdef12.json',
    '5f3d9999  「读数那一份」  名字 第 0 条  读数那一份  ← 当前会话',
  ], '会话编号写开头八段交给 `/resume`，序号整串写出来交给 `/show`');
  assert.deepEqual(findLines([{ sessionId: 'aaaa1111', seq: 3, kind: 'world', text: 'x' }]), ['aaaa1111  world 第 3 条  x'],
    '认不出的种类原样画出来，不猜它是什么');
  assert.equal(routeInput('/find 读数', true).kind, 'command', '查一份读过的记录不改任何东西，跑着的时候也能查');
});

// 切换会话后，已提交的记录应完整替换为新会话内容。
// 先渲染当前会话，再切换到另一个会话，以验证 `Static` 的 key 会触发正确更新。
test('resuming a session repaints that record as the transcript', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const resumedSession = await (client as TuiClient).request('session.create', {});
  const resumed = resumedSession.sessionId;
  await client.request('run.start', { sessionId: resumed, input: '那一份里问过的事' });
  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    await client.request('run.start', { sessionId, input: '当前这一份里问过的事' });
    await waitFor(() => painted.includes('当前这一份里问过的事'), { read: () => painted });

    stdin.write('/sessions');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => completeFrame(painted).includes('搜索 ·') && completeFrame(painted).includes(resumed.slice(0, 8)), { within: 5000, read: () => completeFrame(painted) });
    assert.doesNotMatch(painted, /项目根下还没有跑过的会话/);

    const beforeResume = painted.length;
    stdin.write(resumed.slice(0, 8));
    await waitFor(() => completeFrame(painted).includes(`${resumed.slice(0, 8)} · 1/2`), { within: 5000, read: () => completeFrame(painted) });
    stdin.write('\r');
    const shown = () => plainOutput(painted.slice(beforeResume));
    await waitFor(() => shown().includes('Local response: 那一份里问过的事'), { read: shown });
    const frame = shown();
    assert.equal((requests.find((request) => request.method === 'session.open')?.params as { sessionId?: string } | undefined)?.sessionId, resumed, '前缀在宿主列出来的那几份里对上了才打开');
    assert.match(frame, /Local response: 那一份里问过的事/, '接上来的那一份记录整份重画在画面上');
    assert.doesNotMatch(frame, /当前这一份里答过的话/, '换过来之后画面上不再是上一份的投影');
    assert.match(frame, new RegExp(`会话 ${resumed.slice(0, 8)}`), '状态行说的是现在这一份会话');
    assert.ok(requests.some((request) => request.method === 'session.close' && (request.params as { sessionId?: string }).sessionId === sessionId),
      '换走的那一份会话在宿主里收了，装配与记录锁交回去');
  } finally {
    instance.unmount();
  }
}));

// `/find` 将查询交给 Host，并显示匹配记录所属的会话 ID 和记录编号。
test('finding a phrase shows which session each hit is in', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const other = (await (client as TuiClient).request('session.create', {})).sessionId;
  await client.request('run.start', { sessionId: other, input: '另一份里问过的事' });
  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const before = painted.length;
    stdin.write('/find 问过');
    await delay(100);
    stdin.write('\r');
    const shown = () => plainOutput(painted.slice(before));
    await waitFor(() => shown().includes(other.slice(0, 8)), { read: shown });
    assert.ok(requests.some((request) => request.method === 'sessions.search' && (request.params as { query?: string; projectRoot?: string }).query === '问过'
      && (request.params as { query?: string; projectRoot?: string }).projectRoot === projectDirectory), '查的是这一个项目根跑过的那几份记录');
    assert.ok(requests.some((request) => request.method === 'sessions.search' && (request.params as { sessionId?: string }).sessionId === sessionId),
      '当前这一份另问一次，指名之后连溢出在文件里的那一段一起读');
    assert.match(shown(), /其他会话：/, '两组分开说：这一份与其他');
    assert.match(shown(), /问 第 \d+ 条  另一份里问过的事/, '那一行说出种类、序号与命中那一段');

    const empty = painted.length;
    stdin.write('/find 没有这段文字');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => plainOutput(painted.slice(empty)).includes('没有找到“没有这段文字”'), { read: () => plainOutput(painted.slice(empty)) });
  } finally {
    instance.unmount();
  }
}));

// 创建分支时，不带编号从当前末尾分支；指定编号时从该轮完整结束的记录分支。
test('branching copies the record and switches onto the new session', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  assert.ok(UI_COMMANDS.some((command) => command.name === 'branch'), '/branch 在命令表里');
  assert.equal(routeInput('/branch', true).kind, 'blocked', '分支会把人从跑着的这一轮带走，那一轮落下来的事件就没人在看');
  await client.request('run.start', { sessionId, input: '先问过一句' });
  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const before = painted.length;
    stdin.write('/branch');
    await delay(100);
    stdin.write('\r');
    const shown = () => plainOutput(painted.slice(before));
    await waitFor(() => shown().includes('已创建分支会话'), { read: shown });
    // 通过 `/resume` 恢复会话，并等待命令的实际输出后再检查。
    await waitFor(() => shown().includes('已恢复会话'), { read: shown });
    const branched = requests.filter((request) => request.method === 'session.branch');
    assert.equal(branched.length, 1);
    assert.equal((branched[0].params as { at?: number }).at, undefined, '不带序号不发 `at`：复制到哪儿由宿主固定那一刻的末端');
    const opened = requests.filter((request) => request.method === 'session.open').at(-1)!;
    const openedSession = (opened.params as { sessionId: string }).sessionId;
    assert.notEqual(openedSession, sessionId, '接上去的是复制出来的那一份，不是原来那一份');
    assert.match(shown(), new RegExp(`会话 ${openedSession.slice(0, 8)}`), '状态行说的是现在这一份会话');

    const unreadable = painted.length;
    stdin.write('/branch 第三');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => plainOutput(painted.slice(unreadable)).includes('分支点须为完整轮次的记录序号'), { read: () => plainOutput(painted.slice(unreadable)) });
    const unavailable = painted.length;
    stdin.write('/branch 0');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => plainOutput(painted.slice(unavailable)).includes('session_branch_point_unavailable'),
      { read: () => plainOutput(painted.slice(unavailable)) });
    assert.equal(requests.filter((request) => request.method === 'session.branch').length, 2, '读不出序号那一次没发给宿主');
  } finally {
    instance.unmount();
  }
}));

// 输入历史按会话持久保存；相关检查不依赖 Ink，因此单独运行。
test('the history keeps the newest sentence first and one place per sentence', () => {
  assert.deepEqual(pushHistory([], '  把 note.txt 读一遍 '), ['把 note.txt 读一遍'], '首尾空白不算内容');
  assert.deepEqual(pushHistory(['a', 'b'], 'a'), ['a', 'b'], '同一句再说一次不占两个位置');
  assert.deepEqual(pushHistory(['a', 'b'], '   '), ['a', 'b'], '空的那一句不进历史');
  const long = pushHistory(Array.from({ length: HISTORY_LIMIT }, (_, index) => `第 ${index} 条`), '最新的一条');
  assert.deepEqual([long[0], long.length, long.at(-1)], ['最新的一条', HISTORY_LIMIT, '第 198 条'], '攒到上限就把最旧的那几条挤出去');

  assert.deepEqual(searchHistory(['改 README 的第一段', '改 note.txt', '改 README 的第二段'], 'readme'), ['改 README 的第一段', '改 README 的第二段'],
    '从新到旧，大小写不分');
  assert.deepEqual(searchHistory(['a'], ''), [], '空的查询串不猜一份');
  assert.deepEqual(searchHistory(['ab', 'cd', 'ab'], 'a'), ['ab'], '同一句只报一次');
  assert.equal(searchHistory(Array.from({ length: 40 }, (_, index) => `第 ${index} 条`), '第').length, SEARCH_ROWS, '一次最多报那么几条');
  assert.deepEqual(searchHistory(['a', 'b'], 'zzz'), []);
});

test('the history file reads valid entries and reports a malformed line', async () => {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const root = await mkdtemp(join(testplace, 'tui-history-'));
  const absoluteRoot = assertInTestplace(root);
  const path = historyPathOf(root);
  try {
    assert.deepEqual(await loadHistory(path), [], '还没有过任何一次输入不是错误');
    await rememberHistory(path, ['最新的一条', '旧的一条']);
    assert.deepEqual(await loadHistory(path), ['最新的一条', '旧的一条'], '先后与文件里一致，最新的排在第一个');
    await appendFile(path, '这一行不是 JSON\n');
    await assert.rejects(loadHistory(path), (error) => (error as { code?: string }).code === 'input_history_invalid' && (error as { detail?: string }).detail!.includes('line 3'));
  } finally {
    await rm(assertInTestplace(absoluteRoot), { recursive: true, force: true });
  }
});

// 上下键浏览跨会话输入历史，Ctrl+R 搜索历史；这些操作只修改草稿，发送仍通过 `run.start`。
test('the arrow keys recall the last sentence and Ctrl+R searches the history', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const remembered: string[] = [];
  const fileEntries = ['改 note.txt 的第一行', '上一次会话里说过的话'];
  const instance = render(createElement(App, {
    client: client as TuiClient,
    sessionId,
    info: {},
    interactive: true,
    stdout,
    // 测试客户端返回已修改的审批内容，界面应显示客户端返回的结果。
    history: { entries: fileEntries, remember: async (text: string) => { remembered.push(text); return pushHistory(fileEntries, text); } },
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);
  try {
    stdin.write('把这条记进历史');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => remembered.length === 1, { read: () => painted });
    assert.deepEqual(requests.filter((request) => request.method === 'run.start').map((request) => (request.params as { input?: unknown }).input), ['把这条记进历史']);
    assert.deepEqual(remembered, ['把这条记进历史'], '发出去的那一句才交给那一份文件');

    // 按上键后，最近发送的消息应成为草稿历史中的第一项。
    stdin.write('\x1B[A');
    await waitFor(() => lastFrame().includes('把这条记进历史'), { read: lastFrame });

    stdin.write('\x12');
    await delay(200);
    stdin.write('note');
    await waitFor(() => lastFrame().includes('历史搜索 note') && lastFrame().includes('改 note.txt 的第一行'), { read: lastFrame });

    stdin.write('\r');
    await waitFor(() => lastFrame().includes('› 改 note.txt 的第一行'), { read: lastFrame });
    assert.doesNotMatch(lastFrame(), /反查 note/, '选完就退出反查');
    assert.equal(requests.filter((request) => request.method === 'run.start').length, 1, '反查本身不发任何东西');
  } finally {
    instance.unmount();
  }
}));

// Ctrl+G 将草稿交给外部编辑器，并在编辑器保存后读回修改内容。
test('Ctrl+G hands the draft to the editor and reads back what it wrote', options, async () => withTuiHost(async ({ client, sessionId }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const editor = `${quoted(process.execPath)} ${quoted(editorFixture)} append-crlf - - -`;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { editor }, interactive: true, stdout,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);
  try {
    stdin.write('草稿里的一半');
    await delay(200);
    stdin.write('\x07');
    // 等待编辑器子进程写回内容，并确认更新后的草稿出现在终端中。
    await waitFor(() => /草稿里的一半 edited/.test(lastFrame()), { read: lastFrame });
    const frame = lastFrame();
    assert.match(frame, /草稿里的一半 edited/, '编辑器写回的那一份回到草稿里');
    assert.doesNotMatch(frame, /编辑没成/);
  } finally {
    instance.unmount();
  }
}));

test('Ctrl+G says the editor is not configured instead of guessing one', options, async () => withTuiHost(async ({ client, sessionId }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: {}, interactive: true, stdout }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    stdin.write('\x07');
    await waitFor(() => /请先设置 VISUAL 或 EDITOR/.test(painted), { read: () => painted });
  } finally {
    instance.unmount();
  }
}));

// 外部编辑器失败时也要清理当前测试创建的临时目录。
// 只检查当前测试的目录，避免并行测试创建或删除临时文件影响断言。
test('a failed editor run leaves no temporary directory behind', async () => {
  const { editInExternalEditor } = await import('../dist/tui/editor.js');
  const sandbox = await mkdtemp(join(tmpdir(), 'ligule-editor-sandbox-'));
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = sandbox;
  process.env.TMP = sandbox;
  process.env.TEMP = sandbox;
  try {
    const leftovers = async () => (await readdir(sandbox, { recursive: true })).map(String).filter((name) => name.includes('ligule-editor-'));
    const failed = await editInExternalEditor(`${quoted(process.execPath)} ${quoted(join(resolve('tests'), 'fixtures', 'editor.mjs'))} exit - - 17`, '草稿的一半') as { code: string; detail: string };
    assert.equal(failed.code, 'tui_editor_failed');
    assert.match(failed.detail, /17/);
    assert.deepEqual(await leftovers(), [], '退出码不是 0 那一条路径上临时目录也删掉了');
    const empty = await editInExternalEditor('   ', '草稿的一半');
    assert.deepEqual(empty, { code: 'tui_editor_command_invalid', detail: 'EDITOR must contain a program name' });
    assert.deepEqual(await leftovers(), [], '命令名为空时连目录都不建');
  } finally {
    Object.assign(process.env, previous);
    await rm(sandbox, { recursive: true, force: true });
  }
});

// 多行粘贴作为一整段写入草稿，其中的换行不会提交消息。
test('a pasted block lands in the draft without sending it', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const esc = String.fromCharCode(27);
    const line = String.fromCharCode(10);
    const before = painted.length;
    // bracketed paste 标记包住的多行文本应作为粘贴内容处理；标记外的换行表示 Enter。
    stdin.write(`${esc}[200~把这段读一遍${line}注意第三行${esc}[201~`);
    const shown = () => plainOutput(painted.slice(before));
    await waitFor(() => shown().includes('注意第三行'), { read: shown });
    assert.equal(requests.filter((request) => request.method === 'run.start').length, 0, '粘进来的那一段不发起一轮');
    stdin.write('\r');
    await waitFor(() => requests.some((request) => request.method === 'run.start'), { read: shown });
    const sent = (requests.find((request) => request.method === 'run.start')!.params as { input?: unknown }).input;
    assert.equal(sent, `把这段读一遍${line}注意第三行`, '两条都在草稿里：按 Enter 发出去的就是这一整段');
  } finally {
    instance.unmount();
  }
}));

// 取消当前轮次后，队列应暂停，直到用户收回消息或明确继续。
test('cancelling a round leaves the queued sentences paused', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const type = async (text: string) => { stdin.write(text); await delay(80); stdin.write('\r'); await delay(200); };
  const lastFrame = () => completeFrame(painted);
  const started = () => requests.filter((request) => request.method === 'run.start').map((request) => (request.params as { input?: unknown }).input);
  try {
    await waitFor(() => painted.includes('描述任务'), { read: () => painted });
    await type('第一条');
    await waitFor(() => started().length === 1, { read: () => painted });
    await type('第二条');
    await type('第三条');
    await waitFor(() => /排队 2 条/.test(lastFrame()), { read: lastFrame });

    stdin.write('\x1b');
    await waitFor(() => /队列已暂停/.test(painted), { read: () => painted });
    // 等待取消结果出现后再继续检查队列状态。
    await waitFor(() => /本轮已取消/.test(painted), { read: () => painted });
    assert.deepEqual(started(), ['第一条'], '暂停中的队列在这一轮结束后不自己发');

    await type('/queue drop 2');
    await waitFor(() => /消息 2 已移回草稿/.test(painted), { read: () => painted });
    assert.match(lastFrame(), /队列已暂停：1 条/, '剩下那一条还排着');
    assert.match(lastFrame(), /第三条/, '收回的那一条在草稿上，没丢');

    // 收回的消息可正常发送；暂停队列中的其他消息不会随当前轮次结束而自动发送。
    stdin.write('\r');
    await waitFor(() => started().includes('第三条'), { read: () => painted });
    await waitFor(() => /本轮已完成/.test(painted), { read: () => painted });
    assert.deepEqual(started(), ['第一条', '第三条'], '暂停留着：这一轮结束不替人发还排着的那条');

    await type('/queue continue');
    await waitFor(() => started().length === 3, { within: 20_000, read: () => painted });
    assert.deepEqual(started(), ['第一条', '第三条', '第二条'], '单独一次继续才把还排着的那条发出去');
  } finally {
    instance.unmount();
  }
}, { delayMs: 1_800 }));

// 草稿和待发送队列按会话保存；再次保存会替换旧内容，全部清空后删除该会话的存储记录。
test('the input file keeps one line per session and drops emptied ones', async () => {
  const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { parseInputs, readInput, rememberInput } = await import('../dist/tui/input-store.js');

  await mkdir(resolve('testplace'), { recursive: true });
  const directory = await mkdtemp(join(resolve('testplace'), 'input-store-'));
  const path = join(directory, 'tui-input.jsonl');
  try {
    await rememberInput(path, { projectRoot: 'E:/a', sessionId: 'one', draft: '第一份的半句', queued: ['排着的那句'] });
    await rememberInput(path, { projectRoot: 'E:/b', sessionId: 'one', draft: '另一个项目里的同号', queued: [] });
    await rememberInput(path, { projectRoot: 'E:/a', sessionId: 'two', draft: '', queued: ['第二份排着的'] });
    assert.deepEqual(await readInput(path, 'E:/a', 'one'), { projectRoot: 'E:/a', sessionId: 'one', draft: '第一份的半句', queued: ['排着的那句'] },
      '同一个编号在不同项目根下是两份会话');
    assert.deepEqual(await readInput(path, 'E:/a', 'never'), { projectRoot: 'E:/a', sessionId: 'never', draft: '', queued: [] }, '没留过就是空的');
    assert.deepEqual(parseInputs('不是 JSON\n{"sessionId":"ok","draft":"坏行旁边那句还在"}\n').map((item) => item.sessionId), ['ok'],
      '读不懂的一行跳过，不带走整份，也不让会话开不了');
    await rememberInput(path, { projectRoot: 'E:/a', sessionId: 'one', draft: '', queued: [] });
    assert.deepEqual(await readInput(path, 'E:/a', 'one'), { projectRoot: 'E:/a', sessionId: 'one', draft: '', queued: [] },
      '两句都收回来了就不留这一行');
    assert.deepEqual(await readInput(path, 'E:/b', 'one'), { projectRoot: 'E:/b', sessionId: 'one', draft: '另一个项目里的同号', queued: [] },
      '另一项目根下的同号不受影响');
    assert.deepEqual(parseInputs(await readFile(path, 'utf8')).map((item) => item.projectRoot).sort(), ['E:/a', 'E:/b']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 恢复会话时读取该会话的草稿和队列；恢复的队列保持暂停，不自动发送。
test('a reopened session takes back its own draft and a paused queue', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const saved = new Map([[sessionId, { draft: '上次没写完的那一句', queued: ['上次排着的那一句'] }]]);
  const written: { projectRoot: string; sessionId: string; draft: string; queued: readonly string[] }[] = [];
  const inputs = {
    read: async (projectRoot: string, own: string) => (saved.get(own) as SavedInput | undefined) ?? { projectRoot, sessionId: own, draft: '', queued: [] },
    write: async (projectRoot: string, own: string, draft: string, queued: readonly string[]) => { written.push({ projectRoot, sessionId: own, draft, queued }); },
  };

  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true, inputs, stdout,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    await waitFor(() => plainOutput(painted).includes('上次没写完的那一句'), { read: () => plainOutput(painted) });
    const frame = plainOutput(painted);
    assert.match(frame, /队列已暂停：1 条/, '恢复的待发送消息计入队列摘要');
    assert.match(frame, /队列已暂停/, '恢复时是暂停的：那几句当时还没发出去');
    assert.equal(requests.filter((request) => request.method === 'run.start').length, 0, '恢复不自己发');
    await waitFor(() => written.length > 0, { read: () => JSON.stringify(written) });
    assert.deepEqual(written.at(-1), { projectRoot: projectDirectory, sessionId, draft: '上次没写完的那一句', queued: ['上次排着的那一句'] },
      '写回去的是那一份会话自己的两格');
  } finally {
    instance.unmount();
  }
}));

// 只识别句首或空白后的 `@`；选择候选后在引用文本后继续输入。
test('an @ fragment is recognised at a word boundary and inserts a path', () => {
  assert.deepEqual(mentionToken('看一下 @notes/rea', 14), { start: 4, text: 'notes/rea' });
  assert.deepEqual(mentionToken('@a', 2), { start: 0, text: 'a' }, '句首的 @ 也算');
  assert.equal(mentionToken('邮箱是me@li', 9), null, '紧贴在字后面的 @ 不是路径引用');
  assert.equal(mentionToken('@notes/rea 后面还有字', 8), null, '笔落在一段中间时不替换：那会截断人已写好的那一段');
  assert.deepEqual(insertMention('看一下 @rea', 8, 4, 'notes/readings-3.md'),
    { draft: '看一下 @notes/readings-3.md ', caret: 25 }, '换掉那一段并留一个空格，后面的字不动');
});

// 文件候选由 Host 提供；候选列表打开时，Enter 选择候选而不发送消息。
test('an @ fragment asks the host for project files and Enter picks one', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  await mkdir(join(projectDirectory, 'notes'), { recursive: true });
  await appendFile(join(projectDirectory, 'notes', 'readings-3.md'), '一段读数');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;

  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);
  const started = () => requests.filter((request) => request.method === 'run.start').length;
  try {
    await waitFor(() => painted.includes('描述任务'), { read: () => painted });
    stdin.write('先看 @readings');
    await waitFor(() => lastFrame().includes('notes/readings-3.md'), { read: lastFrame });
    assert.ok(lastFrame().includes('工作区 '), '候选清单标明工作区；完整根路径通过 Host 请求核验');
    const asked = requests.filter((request) => request.method === 'paths.list');
    assert.equal(asked.length, 1, '这一段问一次，不是每个字问一次');
    assert.deepEqual(asked[0].params, { projectRoot: projectDirectory, query: 'readings', limit: 8 }, '问的是那一个项目根里含这一段文字的文件');
    assert.equal(started(), 0, '清单开着不发送');

    stdin.write('\r');
    await waitFor(() => lastFrame().includes('@notes/readings-3.md'), { read: lastFrame });
    assert.equal(started(), 0, 'Enter 选中的是那一条候选，不是把这一句发出去');
    assert.doesNotMatch(lastFrame(), /Tab 或 Enter 选中/, '选中之后清单收起');

    stdin.write(' 还有 @notes');
    await waitFor(() => lastFrame().includes('Esc 收起'), { read: lastFrame });
    const askedAgain = requests.filter((request) => request.method === 'paths.list');
    assert.equal(askedAgain.length, 2, '改了这个词就重新问一次');
    assert.equal((askedAgain.at(-1)!.params as { query?: string }).query, 'notes', '问的是新那一段文字');

    stdin.write('\x1b');
    await waitFor(() => !lastFrame().includes('Esc 收起'), { read: lastFrame });

    // 候选尚未返回时，Enter 不选择候选，也不发送当前消息。
    stdin.write(' @x');
    await delay(60);
    stdin.write('\r');
    await delay(120);
    assert.equal(started(), 0, '查询在路上时 Enter 既不选中也不发送');
    assert.match(lastFrame(), /@x/, '那一句还在草稿上');
  } finally {
    instance.unmount();
  }
}));

// 连续追加的文本作为一个撤销单元；空格、插入到中间的文本和粘贴内容各自单独成组。
test('one undo unit is a typing run, not one keystroke', options, () => {
  assert.equal(isTypingRun({ draft: 'ab', caret: 2 }, { draft: 'abc', caret: 3 }), true);
  assert.equal(isTypingRun({ draft: 'ab', caret: 2 }, { draft: 'ab ', caret: 3 }), false, '打下的那个空格自己成一段');
  assert.equal(isTypingRun({ draft: 'ab', caret: 2 }, { draft: 'acb', caret: 2 }), false, '盖掉中间一个字符的不是往后打');
  assert.equal(isTypingRun({ draft: 'ab', caret: 1 }, { draft: 'abc', caret: 2 }), false, '光标不在末尾时不并段');
  assert.equal(isTypingRun({ draft: '甲', caret: 1 }, { draft: '甲乙丙', caret: 3 }), false, '一次粘进来三个字的是一段而不是三键');
  assert.equal(isTypingRun({ draft: '👍', caret: 2 }, { draft: '👍👍', caret: 4 }), true, '一个字素算一个单位，成对的那一种不算两个');
});

// 通过真实按键事件验证 Ctrl+Z 和 Ctrl+Y；撤销与重做只修改草稿，不发送消息。
test('the frame reader waits for the closing marker before reading', () => {
  // 等待同步输出结束标记，避免把尚未完成的画面当作当前状态。
  assert.equal(completeFrame('\x1B[?2026h› 第一段草稿\x1B[?2026l\x1B[?2026h› 第一段').includes('草稿'), true, '写完的那一帧读得到');
  assert.equal(completeFrame('\x1B[?2026h› 只有开头').includes('只有开头'), false, '还没写完的那一帧不算画面');
  assert.equal(completeFrame('\x1B[?2026h› 旧的一帧\x1B[?2026l\x1B[?2026h› 新的一帧\x1B[?2026l'), '› 新的一帧', '读的是最后写完的那一帧');
});

test('Ctrl+Z walks the draft back a unit at a time and Ctrl+Y takes it back', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);
  const started = () => requests.filter((request) => request.method === 'run.start').length;
  // 去除光标反色对应的 ANSI 样式码后，再检查草稿文本。
  const shown = () => plainOutput(lastFrame());
  // 只从完整输出帧读取草稿，避免将分段到达的输出误判为空。
  const paintedText = async (text: string, note: string) => {
    await waitFor(() => shown().includes(text), { read: shown });
    assert.ok(shown().includes(text), note);
  };
  try {
    await waitFor(() => shown().includes('描述任务'), { read: shown });

    // 连续输入的文本作为一组撤销，再次重做后应完整恢复。
    stdin.write('第一段草稿');
    await waitFor(() => shown().includes('第一段草稿'), { read: shown });
    stdin.write('\x1a');
    await waitFor(() => !shown().includes('第一段草稿'), { read: shown });
    stdin.write('\x19');
    await waitFor(() => shown().includes('第一段草稿'), { read: shown });

    // 撤销后继续输入会形成新的撤销组，不影响之前的文本。
    // 使用较长的文本断言，避免短文本与状态行中的会话 ID 偶然匹配。
    stdin.write('第二段');
    await delay(60);
    stdin.write('\x1a');
    await waitFor(() => !shown().includes('第二段'), { read: shown });
    await paintedText('第一段草稿', '退掉后打的那一段时，原来那一段还在');

    // 移动光标后输入会形成新的撤销组，撤销时只删除新输入的字符。
    stdin.write('甲');
    await delay(60);
    stdin.write('\x1b[D');
    await delay(60);
    stdin.write('乙');
    await delay(60);
    await paintedText('第一段草稿乙甲', '光标挪到中间再打的字落在那一个字前面');
    stdin.write('\x1a');
    await waitFor(() => !shown().includes('乙'), { read: shown });
    await paintedText('第一段草稿甲', '退的是刚才那一段，不是整份草稿');
    assert.equal(started(), 0, '撤销不发任何东西出去，也不起一轮');
  } finally {
    instance.unmount();
  }
}));

// `/policy` 更新后状态行应同步变化；会话级配置在退出会话后恢复。
test('/policy changes the session setting and updates the bottom configuration line', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  // 终端可能折行；比较前去除控制序列和换行，按完整文本检查提示。
  const strip = (text: string) => text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\n]+/g, '');
  const lastFrame = () => completeFrame(painted);
  const spoken = (text: string) => strip(painted).includes(text);
  const type = async (line: string) => {
    stdin.write(line);
    await waitFor(() => lastFrame().includes(`› ${line}`), { within: 10_000, read: lastFrame });
    stdin.write('\r');
  };
  const configDefault = (await (client as TuiClient).request('status.get', { sessionId })).policy;
  const other = configDefault === 'ask' ? 'auto' : 'ask';
  const policyLabel = (policy: string) => policy === 'auto' ? '自动判定' : '逐次审批';
  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    await type(`/policy ${other}`);
    await waitFor(() => requests.some((request) => request.method === 'policy.set'), { read: () => strip(painted).slice(-700) });
    await waitFor(() => spoken(`当前会话审批方式：${other}`), { read: () => strip(painted).slice(-700) });
    assert.equal((await (client as TuiClient).request('status.get', { sessionId })).policySource, 'session');
    await waitFor(() => lastFrame().includes(`审批 ${policyLabel(other)}`), { read: lastFrame });

    await type('/policy sometimes');
    await waitFor(() => spoken('用法：/policy always|ask|auto|never|reset（旧 none 等同 ask）'), { read: () => painted });

    await type('/policy reset');
    await waitFor(() => spoken(`已恢复默认审批方式：${configDefault}`), { read: () => painted });
    assert.equal((await (client as TuiClient).request('status.get', { sessionId })).policySource, 'config');
    await waitFor(() => lastFrame().includes(`审批 ${policyLabel(configDefault)}`), { read: lastFrame });
  } finally {
    instance.unmount();
  }
}));

test('/control creates a project-bound grant through the interactive wizard', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);
  const strip = (text: string) => plainOutput(text).replace(/[\r\n]+/g, '');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const answer = async (value: string, nextPrompt?: string) => {
    stdin.write(value);
    await waitFor(() => lastFrame().includes(`› ${value}`), { within: 10_000, read: lastFrame });
    stdin.write('\r');
    if (nextPrompt !== undefined) await waitFor(() => strip(lastFrame()).includes(nextPrompt), { read: () => strip(lastFrame()) });
  };
  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    await answer('/control create', '授权名称');
    await answer('Codex test grant', '默认权限');
    await answer('full-access', '最大权限');
    await answer('full-access', '默认网络');
    await answer('unrestricted', '网络上限');
    await answer('unrestricted', '默认 Policy');
    await answer('auto', '允许的 Policy');
    await answer('ask,auto', '允许 --operator');
    await answer('yes', '允许外控启动哪些已信任的 MCP Server');
    await answer('none', '允许外控调用哪些工具');
    await answer('none', '到期时间');
    await answer(expiresAt, '确认信任此项目');
    await answer('yes', '接受 workspace-write 可能存在的部分隔离限制');
    await answer('yes', '单独确认 full-access');
    await answer('yes', '单独确认 unrestricted network');
    await answer('yes');
    await waitFor(() => requests.some((request) => request.method === 'agent-control.create'), { within: 10_000, read: () => strip(painted).slice(-1_000) });
    await waitFor(() => {
      const output = strip(painted);
      return output.includes('外控授权 Codex test grant 已创建') || output.includes('Grant Codex test grant created');
    }, { within: 10_000, read: () => strip(painted).slice(-1_000) });
    const saved = await (client as TuiClient).request('agent-control.list', {});
    assert.equal(saved.grants.length, 1);
    assert.equal(saved.grants[0].name, 'Codex test grant');
    assert.equal(saved.grants[0].projectRoot, projectDirectory);
    assert.equal(saved.grants[0].defaultPermissionProfile, 'full-access');
    assert.equal(saved.grants[0].maxPermissionProfile, 'full-access');
    assert.equal(saved.grants[0].defaultNetwork, 'unrestricted');
    assert.equal(saved.grants[0].maxNetwork, 'unrestricted');
    assert.equal(saved.grants[0].defaultPolicy, 'auto');
    assert.equal(saved.grants[0].allowedPolicies.includes('auto'), true);
    assert.equal(saved.grants[0].allowOperator, true);
    assert.deepEqual(saved.grants[0].allowedMcpServers, []);
    assert.deepEqual(saved.grants[0].allowedMcpTools, []);
    assert.equal(saved.grants[0].confirmedPartialWorkspaceWrite, true);
    assert.equal((saved.grants[0] as unknown as { confirmedFullAccess: boolean }).confirmedFullAccess, true);
    assert.equal((saved.grants[0] as unknown as { confirmedUnrestrictedNetwork: boolean }).confirmedUnrestrictedNetwork, true);
    assert.equal(saved.grants[0].expiresAt, expiresAt);
    assert.match(strip(painted), new RegExp(saved.grants[0].id));

    await answer('/control list');
    await waitFor(() => {
      const output = strip(painted);
      return output.includes('权限 full-access / full-access')
        && output.includes('网络 unrestricted / unrestricted')
        && output.includes('到期')
        && (output.includes('来源 可信界面创建') || output.includes('source Trusted UI'))
        && output.includes(projectDirectory);
    }, { within: 10_000, read: () => strip(painted).slice(-1_200) });

    const listed = await (client as TuiClient).request('agent-control.list', {});
    await client.request('agent-control.revoke', { grantId: saved.grants[0].id, version: listed.version });
    await answer('/control list');
    await waitFor(() => {
      const output = strip(painted);
      return (output.includes('1 张已失效') || output.includes('1 grant(s) are no longer valid'))
        && (output.includes('重新创建授权') || output.includes('Create a new grant'));
    }, { within: 10_000, read: () => strip(painted).slice(-1_200) });
  } finally {
    instance.unmount();
  }
}, { permissionControl: true }));

test('cancelling the grant wizard while it lists trusted MCP tools keeps it closed', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  const serverTrust = await (client as TuiClient).request('mcp.trust.list', { projectRoot: projectDirectory });
  const server = serverTrust.servers.find((item) => item.name === 'probe');
  assert.ok(server, 'the project config exposes the real local MCP fixture');
  await client.request('mcp.trust.set', {
    projectRoot: projectDirectory,
    server: server.name,
    identityDigest: server.identityDigest,
    scope: 'project',
    trusted: true,
    confirmTrust: true,
    confirmExternalAccess: true,
    version: serverTrust.version,
  });

  let toolsRequestStarted = false;
  let toolsRequestSettled = false;
  let toolsRequestFailure: unknown;
  let toolsRequestResult: { tools: { name: string }[] } | undefined;
  const request = client.request.bind(client);
  client.request = (method, params) => {
    const pending = request(method, params);
    if (method !== 'mcp.trust.tools') return pending;
    toolsRequestStarted = true;
    return pending.then((result) => {
      toolsRequestResult = result as { tools: { name: string }[] };
      toolsRequestSettled = true;
      return result;
    }, (error) => {
      toolsRequestFailure = error;
      toolsRequestSettled = true;
      throw error;
    });
  };

  const toolsStartedPath = join(projectDirectory, 'mcp-started.pid');
  const toolsReturnedPath = join(projectDirectory, 'mcp-tools-returned');
  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);
  const answer = async (value: string, nextPrompt?: string) => {
    stdin.write(value);
    await waitFor(() => lastFrame().includes(`› ${value}`), { within: 10_000, read: lastFrame });
    stdin.write('\r');
    if (nextPrompt !== undefined) await waitFor(() => lastFrame().includes(nextPrompt), { read: lastFrame });
  };

  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    await answer('/control create', '授权名称');
    await answer('pending grant', '默认权限');
    await answer('read-only', '最大权限');
    await answer('read-only', '默认网络');
    await answer('disabled', '网络上限');
    await answer('disabled', '默认 Policy');
    await answer('ask', '允许的 Policy');
    await answer('ask', '允许 --operator');
    await answer('no', '允许外控启动哪些已信任的 MCP Server');
    await answer('probe');
    await waitFor(() => toolsRequestStarted && requests.some((item) => item.method === 'mcp.trust.tools'), {
      within: 5_000,
      read: () => lastFrame(),
    });
    await waitFor(() => access(toolsStartedPath).then(() => true, () => false), { within: 5_000, read: lastFrame });

    await answer('cancel');
    await waitFor(() => lastFrame().includes('已取消外控授权创建'), { read: lastFrame });
    await waitFor(() => access(toolsReturnedPath).then(() => true, () => false), { within: 5_000, read: lastFrame });
    await waitFor(() => toolsRequestSettled, { within: 5_000, read: lastFrame });
    stdin.write('after-cancel');
    await waitFor(() => lastFrame().includes('› after-cancel'), { within: 5_000, read: lastFrame });

    assert.equal(toolsRequestFailure, undefined);
    assert.deepEqual(toolsRequestResult!.tools.map((tool) => tool.name), ['echo']);
    assert.match(plainOutput(painted), /已取消外控授权创建/);
    assert.doesNotMatch(lastFrame(), /允许外控调用哪些工具|可授权的 MCP 工具|Which tools may the controller call/u);
  } finally {
    instance.unmount();
  }
}, {
  config: { mcp: { servers: { probe: { command: process.execPath, args: [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid', '1500', 'mcp-tools-returned'] } } } },
  setup: async ({ projectDirectory }) => {
    await writeFile(join(projectDirectory, 'mcp-schema.json'), JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }));
    await mkdir(join(projectDirectory, '.ligule'), { recursive: true });
    await writeFile(join(projectDirectory, '.ligule', 'config.toml'), [
      '[mcp.servers.probe]',
      'command = ' + JSON.stringify(process.execPath),
      'args = [' + [mcpServerFixture, 'mcp-schema.json', 'mcp-started.pid', '1500', 'mcp-tools-returned'].map((value) => JSON.stringify(value)).join(', ') + ']',
      '',
    ].join('\n'));
  },
}));

test('a submitted grant cannot be canceled or submitted again while the Host response is pending', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  let releaseCreateResponse: (value?: unknown) => void = () => {};
  const createResponseGate = new Promise((resolve) => { releaseCreateResponse = resolve; });
  let createResponseReceived = false;
  const originalRequest = client.request.bind(client);
  client.request = (method, params) => {
    const pending = originalRequest(method, params);
    if (method !== 'agent-control.create') return pending;
    return pending.then(async (result) => {
      createResponseReceived = true;
      await createResponseGate;
      return result;
    });
  };

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);
  const inputLine = () => lastFrame().split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith('›')) ?? '';
  const answer = async (value: string, nextPrompt?: string) => {
    stdin.write(value);
    await waitFor(() => lastFrame().includes(`› ${value}`), { within: 10_000, read: lastFrame });
    stdin.write('\r');
    if (nextPrompt !== undefined) await waitFor(() => lastFrame().includes(nextPrompt), { read: lastFrame });
  };
  const createRequests = () => requests.filter((item) => item.method === 'agent-control.create');

  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    await answer('/control create', '授权名称');
    await answer('pending grant', '默认权限');
    await answer('read-only', '最大权限');
    await answer('read-only', '默认网络');
    await answer('disabled', '网络上限');
    await answer('disabled', '默认 Policy');
    await answer('ask', '允许的 Policy');
    await answer('ask', '允许 --operator');
    await answer('no', '允许外控启动哪些已信任的 MCP Server');
    await answer('none', '允许外控调用哪些工具');
    await answer('none', '到期时间');
    await answer('none', '确认信任此项目');
    await answer('yes');
    await waitFor(() => createRequests().length === 1, { within: 5_000, read: lastFrame });
    await waitFor(() => createResponseReceived, { within: 5_000, read: lastFrame });

    await answer('cancel');
    await waitFor(() => lastFrame().includes('授权请求已提交') && inputLine() === '› cancel', { read: lastFrame });
    assert.doesNotMatch(plainOutput(painted), /已取消外控授权创建/u, 'a submitted Host request is not reported as canceled');
    assert.match(lastFrame(), /授权请求已提交|请求已提交/u, 'the UI reports that the Host is saving the grant');
    assert.equal(inputLine(), '› cancel', 'the input entered during submission is preserved as a draft');
    for (let length = 'cancel'.length - 1; length >= 0; length -= 1) {
      stdin.write('\x7f');
      const expected = length === 0 ? '› 等待授权保存' : `› ${'cancel'.slice(0, length)}`;
      await waitFor(() => inputLine() === expected, { within: 1_000, read: lastFrame });
    }

    await answer('yes');
    // The draft alone proves nothing: wait until the Enter was actually handled and the guard spoke twice.
    await waitFor(() => (plainOutput(painted).match(/此时不能取消或重复提交/gu) ?? []).length >= 2, { within: 15_000, read: lastFrame });
    assert.equal(inputLine(), '› yes', 'the second attempt is preserved as a draft');
    assert.equal(createRequests().length, 1, 'a pending grant submission cannot create another request');

    releaseCreateResponse();
    await waitFor(() => lastFrame().includes('外控授权 pending grant 已创建'), { within: 5_000, read: lastFrame });
    const saved = await originalRequest('agent-control.list', {}) as { grants: readonly { name: string }[]; version: string };
    assert.equal(saved.grants.length, 1);
    assert.equal(saved.grants[0].name, 'pending grant');
  } finally {
    releaseCreateResponse();
    instance.unmount();
  }
}));

test('a pending grant setup does not open after the user starts a new conversation', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  let releaseTrustResponse: (value?: unknown) => void = () => {};
  const trustResponseGate = new Promise((resolve) => { releaseTrustResponse = resolve; });
  let trustResponseReceived = false;
  let trustResponseDelivered = false;
  const originalRequest = client.request.bind(client);
  client.request = (method, params) => {
    const pending = originalRequest(method, params);
    if (method !== 'mcp.trust.list') return pending;
    return pending.then(async (result) => {
      trustResponseReceived = true;
      await trustResponseGate;
      trustResponseDelivered = true;
      return result;
    });
  };

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);

  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    const sessionCreations = requests.filter((item) => item.method === 'session.create').length;

    stdin.write('/control create');
    await waitFor(() => lastFrame().includes('› /control create'), { within: 5_000, read: lastFrame });
    stdin.write('\r');
    await waitFor(() => trustResponseReceived && requests.some((item) => item.method === 'mcp.trust.list'), {
      within: 5_000,
      read: lastFrame,
    });

    stdin.write('/new');
    await waitFor(() => lastFrame().includes('› /new'), { within: 5_000, read: lastFrame });
    stdin.write('\r');
    await waitFor(() => requests.filter((item) => item.method === 'session.create').length > sessionCreations, {
      within: 5_000,
      read: lastFrame,
    });
    await waitFor(() => plainOutput(painted).includes('新会话 '), { within: 5_000, read: lastFrame });
    releaseTrustResponse();
    await waitFor(() => trustResponseDelivered, { within: 5_000, read: lastFrame });
    stdin.write('after-new');
    await waitFor(() => lastFrame().includes('› after-new'), { within: 5_000, read: lastFrame });

    assert.doesNotMatch(lastFrame(), /创建外控授权|授权名称|默认权限|Grant name|Default permission/u);
    assert.doesNotMatch(plainOutput(painted), /开始创建授权/u);
  } finally {
    releaseTrustResponse();
    instance.unmount();
  }
}));

test('opening a settings picker supersedes a pending grant setup request', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  let releaseTrustResponse: (value?: unknown) => void = () => {};
  const trustResponseGate = new Promise((resolve) => { releaseTrustResponse = resolve; });
  let trustResponseReceived = false;
  let trustResponseDelivered = false;
  const originalRequest = client.request.bind(client);
  client.request = (method, params) => {
    const pending = originalRequest(method, params);
    if (method !== 'mcp.trust.list') return pending;
    return pending.then(async (result) => {
      trustResponseReceived = true;
      await trustResponseGate;
      trustResponseDelivered = true;
      return result;
    });
  };

  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => completeFrame(painted);

  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    stdin.write('/control create');
    await waitFor(() => lastFrame().includes('› /control create'), { within: 5_000, read: lastFrame });
    stdin.write('\r');
    await waitFor(() => trustResponseReceived, { within: 5_000, read: lastFrame });

    stdin.write('\u0010');
    await waitFor(() => lastFrame().includes('Alpha / first-model'), { within: 5_000, read: lastFrame });
    releaseTrustResponse();
    await waitFor(() => trustResponseDelivered, { within: 5_000, read: lastFrame });
    stdin.write('\u001b[B');
    await waitFor(() => lastFrame().includes('› Alpha / second-model'), { within: 5_000, read: lastFrame });

    assert.match(lastFrame(), /Alpha \/ second-model/u);
    assert.doesNotMatch(lastFrame(), /创建外控授权/u);
    assert.doesNotMatch(plainOutput(painted), /开始创建授权/u);
  } finally {
    releaseTrustResponse();
    instance.unmount();
  }
}, {
  config: { model: {
    services: [{
      id: 'alpha', name: 'Alpha', api: 'chat-completions', baseURL: 'http://127.0.0.1',
      apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY', models: ['first-model', 'second-model'],
    }],
    selection: { provider: 'alpha', model: 'first-model' },
  } },
}));

// `/think` 只列出模型声明的档位；应用后状态行显示覆盖值，恢复默认后隐藏。
test('/think applies a thinking level the model declares and resets to the model default', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const strip = (text: string) => text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\n]+/g, '');
  const lastFrame = () => completeFrame(painted);
  const spoken = (text: string) => strip(painted).includes(text);
  const type = async (line: string) => {
    stdin.write(line);
    await waitFor(() => lastFrame().includes(`› ${line}`), { within: 10_000, read: lastFrame });
    stdin.write('\r');
  };
  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    await type('/think');
    await waitFor(() => lastFrame().includes('选择思考档'), { read: lastFrame });
    for (const label of ['模型默认', '无', '低', '高', '最高']) {
      await waitFor(() => lastFrame().includes(label), { read: lastFrame });
    }
    // 关闭列表后再用命令应用档位，避免输入被面板吃掉。
    stdin.write('');
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    await type('/think high');
    await waitFor(() => requests.some((request) => request.method === 'session.configure'
      && (request.params as { thinkingEffort?: string } | undefined)?.thinkingEffort === 'high'), { read: () => strip(painted).slice(-700) });
    await waitFor(() => spoken('思考档：高'), { read: () => strip(painted).slice(-700) });
    assert.equal((await (client as TuiClient).request('status.get', { sessionId })).thinking!.effective, 'high');
    await waitFor(() => lastFrame().includes('思考 高'), { read: lastFrame });

    await type('/think default');
    await waitFor(() => requests.some((request) => request.method === 'session.configure'
      && (request.params as { resetThinking?: boolean } | undefined)?.resetThinking === true), { read: () => strip(painted).slice(-700) });
    await waitFor(async () => (await (client as TuiClient).request('status.get', { sessionId })).thinking!.effective === 'default', { read: () => strip(painted).slice(-700) });
  } finally {
    instance.unmount();
  }
}, {
  config: {
    model: {
      api: 'chat-completions', baseURL: 'http://127.0.0.1:9/v1', model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY',
      services: [{ id: 'deepseek', name: 'DeepSeek', api: 'chat-completions', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', models: ['deepseek-flash'] }],
      selection: { provider: 'deepseek', model: 'deepseek-flash' },
    },
  },
}));

// 没有声明思考能力的模型不弹出空列表，也不发送配置请求。
test('/think explains when the selected model declares no thinking levels', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');
  const stdout = new PassThrough() as unknown as FakeOutput;
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
  const instance = render(createElement(App, {
    client: client as TuiClient, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const strip = (text: string) => text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\n]+/g, '');
  const lastFrame = () => completeFrame(painted);
  const type = async (line: string) => {
    stdin.write(line);
    await waitFor(() => lastFrame().includes(`› ${line}`), { within: 10_000, read: lastFrame });
    stdin.write('\r');
  };
  try {
    await waitFor(() => lastFrame().includes('描述任务'), { read: lastFrame });
    await type('/think');
    await waitFor(() => strip(painted).includes('当前模型没有声明思考档'), { read: () => strip(painted).slice(-900) });
    assert.deepEqual(requests.filter((request) => request.method === 'session.configure'), []);
  } finally {
    instance.unmount();
  }
}));

test('a narrow terminal keeps a pending approval operable when the settings line is already covered', options, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async ({ client, sessionId }) => {
    const { createElement } = await import('react');
    const { render } = await import('ink');
    const { PassThrough } = await import('node:stream');
    const { App } = await import('../dist/tui/app.js');

    const stdout = new PassThrough() as unknown as FakeOutput;
    // 80x12 比 80x24 更紧：设置行与欢迎区都放不下，审批卡必须自己撑住可用性。
    stdout.columns = 80;
    stdout.rows = 12;
    stdout.isTTY = true;
    let painted = '';
    stdout.on('data', (chunk) => { painted += chunk; });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} }) as unknown as FakeInput;
    const instance = render(createElement(App, { client: client as TuiClient, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
    let decision: { text: string } | undefined;
    try {
      const run = (client as TuiClient).request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command: 'git --version' } }) });
      await waitFor(() => /允许执行 exec？/.test(painted), { read: () => painted });
      stdin.write('1');
      decision = await run;
    } finally {
      instance.unmount();
    }
    assert.match(painted, /允许执行 exec？/);
    assert.match(painted, /git --version/);
    // 允许一次后命令应真的执行：decision.text 是工具结果，而不是取消标记。
    assert.match(decision!.text, /git version/);
  }, { permission });
});
