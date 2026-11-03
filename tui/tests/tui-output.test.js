// 覆盖终端标题、剪贴板编码，以及通过 Ink 输入 `/export` 后写出的文件。
// `/export` 的排版和 Host 行为由 `core/tests/host-export.test.js` 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configureTerminalColors, titleEscape, titleText } from '../dist/tui/output.js';
import { clipboardPayload, copyToClipboard, lastAnswer } from '../dist/tui/clipboard.js';
import { routeInput } from '../dist/tui/commands.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

let missing = '';
try {
  await import('../dist/tui/app.js');
} catch (error) {
  missing = error.code === 'ERR_MODULE_NOT_FOUND' ? 'the terminal UI dependencies are not installed' : error.message;
}

const options = { skip: missing === '' ? false : missing };

test('terminal startup honors nonempty NO_COLOR and preserves explicit color overrides', () => {
  for (const value of ['1', 'true', '0']) {
    const environment = { NO_COLOR: value };
    configureTerminalColors(environment);
    assert.equal(environment.FORCE_COLOR, '0');
  }
  for (const environment of [{}, { NO_COLOR: '' }, { NO_COLOR: '1', FORCE_COLOR: '3' }, { NO_COLOR: '1', FORCE_COLOR: '0' }]) {
    const before = { ...environment };
    configureTerminalColors(environment);
    assert.deepEqual(environment, before);
  }
});

test('the terminal title drops the characters that could end its own escape', () => {
  assert.equal(titleText({ model: 'test-model', boundary: '/work', sessionId: '0123456789' }), 'test-model · /work · 01234567');
  assert.equal(titleText({ model: 'm\u001B]0;pwn\u0007', boundary: '/w\nork', sessionId: 'abc' }), 'm]0;pwn · /work · abc');
  assert.equal(titleText({ model: 'x'.repeat(200), boundary: '/work', sessionId: 'abc' }).length, 120, '再长也只写到那么宽');
  const ESC = String.fromCharCode(27);
  assert.equal(titleEscape('abc'), ESC + ']0;abc' + ESC + String.fromCharCode(92), '开头与收尾都是那一个转义引导符，不留 BEL');
});

test('the clipboard payload is the encoding the local program reads back', async () => {
  assert.equal(clipboardPayload('阶段', 'win32').toString('utf16le'), '阶段');
  assert.deepEqual([...clipboardPayload('ab', 'win32')], [0x61, 0x00, 0x62, 0x00], '不带 BOM：那两个字节会留在剪贴板开头');
  assert.equal(clipboardPayload('阶段', 'darwin').toString('utf8'), '阶段');
  assert.deepEqual(await copyToClipboard('这一串不交给任何程序', 'freebsd'), { code: 'tui_clipboard_unavailable' }, '本机没有那一条路就说出来');

  assert.equal(lastAnswer([{ seq: 0, kind: 'assistant', text: '第一段' }, { seq: 1, kind: 'tool' }, { seq: 2, kind: 'assistant', text: '' }, { seq: 3, kind: 'assistant', text: '最新的一段' }]), '最新的一段',
    '取记录里最后那条有正文的回答，流式那半截不在记录里');
  assert.equal(lastAnswer([{ seq: 0, kind: 'user', text: '只有问的' }]), '');

  assert.equal(routeInput('/copy', true).kind, 'command', '复制与导出都不改动这一轮，跑着的时候能用');
  assert.equal(routeInput('/export 笔记/这次运行.md', true).kind, 'command');
});

test('/export writes real host and subagent records as markdown', options, async () => withTuiHost(async ({ client, sessionId, directory, config, requests, providerRequests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const exportDirectory = join(directory, 'export');
  const projectDirectory = config.boundary;
  const path = join(exportDirectory, 'run.md');
  const instance = render(createElement(App, { client, sessionId, info: { boundary: projectDirectory }, interactive: true, stdout }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    await client.request('mode.set', { sessionId, name: 'full' });
    let runFinished = false;
    const run = client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'subagent', args: { task: '支线导出验证' } }) })
      .finally(() => { runFinished = true; });
    // 等审批提示渲染后再输入答案，避免按键先进入草稿而没有完成审批。
    await waitFor(() => runFinished || painted.includes('允许执行 subagent？'), { within: 20_000, read: () => painted });
    if (!runFinished) stdin.write('y');
    await run;
    assert.equal(providerRequests.length, 3,
      '父轮次调用、支线调用和父轮次续调共享三次模型调用预算');
    const parentRead = await client.request('session.read', { sessionId, fullResults: true });
    const branchEvent = parentRead.events.find((event) => event.kind === 'tool' && event.tool === 'subagent');
    const branchId = branchEvent?.result?.content?.sessionId;
    assert.equal(typeof branchId, 'string', '支线 id 来自 Host 记录的真实 subagent 结果');

    stdin.write(`/export ${path}`);
    await delay(100);
    stdin.write('\r');
    await waitFor(() => /已导出 2 个文件/.test(painted), { read: () => painted });
    const branchPath = join(exportDirectory, `run.${branchId}.md`);
    assert.match(painted, /已导出 2 个文件/, '说清写了哪两个文件');
    const mainText = await readFile(path, 'utf8');
    const branchText = await readFile(branchPath, 'utf8');
    assert.match(mainText, new RegExp(`# ligule 会话 ${sessionId}`));
    assert.match(mainText, new RegExp(`- 项目根：${projectDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(mainText, /一次调用 · subagent/);
    assert.ok(mainText.includes('支线导出验证'));
    assert.match(branchText, new RegExp(`# ligule 会话 ${branchId}`));
    assert.match(branchText, new RegExp(`- 项目根：${projectDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(branchText.includes('Local response: 支线导出验证'));
    assert.ok(requests.some((request) => request.method === 'session.export' && request.params.sessionId === sessionId && request.params.path === path),
      '界面只交出那一条目的地，读记录与写出都在宿主那一侧');
  } finally {
    instance.unmount();
  }
}, { config: { loop: { iterations: 2, modelCalls: 2, totalModelCalls: 3 } } }));
