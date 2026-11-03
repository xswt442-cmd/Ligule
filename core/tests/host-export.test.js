// 验证宿主能将会话记录导出为 Markdown 并写入用户指定的位置。
// 排版是纯计算；那一次写出走真的协议与真的临时目录，落点由调用方给。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { branchSessionId, exportImageUrl, exportMarkdown, writeExport } from '../dist/host/export.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

const events = [
  { kind: 'session', formatVersion: 1, sessionId: 's-1', projectRoot: '/work', createdAt: '2026-10-05T00:00:00.000Z' },
  { seq: 0, kind: 'user', text: '看一眼 note.txt', raw: '/看看 note' },
  { seq: 1, kind: 'assistant', text: '第一段回答', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'note.txt' } }] },
  { seq: 2, kind: 'tool', tool: 'read', callId: 'c1', result: { content: '第一行原文' } },
  { seq: 3, kind: 'tool', tool: 'exec', callId: 'c2', result: { content: '没了', failed: true, code: 'exec_exit_1' } },
  { seq: 4, kind: 'mode', name: 'full', layer: 'shipped', tools: ['*'] },
  { seq: 5, kind: 'usage', input: 8351, output: 39, estimated: 13 },
];

const imageId = '12345678-1234-4234-8234-123456789abc';
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hOcAAAAASUVORK5CYII=', 'base64');
function imageAsset(id = imageId, data = imageBytes) {
  return {
    reference: {
      kind: 'image', version: 1, id, workspace: 'workspace-hash', sessionId: 'session-1', source: 'browser', mimeType: 'image/png',
      bytes: data.length, width: 1, height: 1, sha256: createHash('sha256').update(data).digest('hex'),
      createdAt: '2026-10-25T10:00:00.000Z',
    },
    data,
  };
}

test('the exported markdown gives each call and each result its own section', () => {
  const text = exportMarkdown(events, { id: 's-1', projectRoot: '/work', createdAt: '2026-10-05T00:00:00.000Z' });
  assert.match(text, /^# ligule 会话 s-1$/m);
  assert.match(text, /- 项目根：\/work/);
  assert.match(text, /第 0 条 · 你说\n\n\/看看 note/, '写出去的是人原本打的那一行（D54）');
  assert.match(text, /第 1 条的一次调用 · read/);
  assert.match(text, /第 2 条 · read 的结果\n\n第一行原文/);
  assert.match(text, /（这一次没做成）/, '没做成的那一次在段子里说得出来');
  assert.match(text, /第 4 条：模式 full（shipped）生效/);
  assert.doesNotMatch(text, /8351/, '用量那一条不是对话的一段，不写出去');
  assert.equal(text.split('\n## ').length - 1, 2, '问的那一条与答的那一条各成一段');
  assert.equal(text.split('\n### ').length - 1, 3, '那一次调用与两次结果各自一段');
});

test('the exported markdown preserves consecutive blank lines in the original body', () => {
  const text = exportMarkdown([{ seq: 8, kind: 'assistant', text: '第一段\n\n\n第二段' }], { id: 's-8' });
  assert.ok(text.includes('第一段\n\n\n第二段'));
});

test('the branch id comes from that derived result and nothing else', () => {
  assert.equal(branchSessionId({ kind: 'tool', tool: 'subagent', result: { content: { sessionId: 'b-1' } } }), 'b-1');
  assert.equal(branchSessionId({ kind: 'tool', tool: 'read', result: { content: { sessionId: 'b-1' } } }), undefined, '别的工具结果里同名的那一格不算支线');
  assert.equal(branchSessionId({ kind: 'tool', tool: 'subagent', result: { content: '整段溢出了', spilled: 's-1-3.json' } }), undefined,
    '结果内容溢出到文件时记录里就没有这一格');
});

test('session.export writes the record to the path the caller names', async () => withTuiHost(async ({ client, sessionId, directory, requests }) => {
  await client.request('run.start', { sessionId, input: '说一句就好' });
  const path = join(directory, 'note', '这一轮.md');
  const done = await client.request('session.export', { sessionId, path });
  assert.deepEqual(done.skipped, [], '没有派生支线就没有漏写的那一份');
  assert.deepEqual(done.written, [path], '交回的是写出去的那一条路径');
  const text = await readFile(path, 'utf8');
  assert.match(text, new RegExp(`# ligule 会话 ${sessionId}`));
  assert.match(text, /说一句就好/);
  assert.match(text, /Local response: 说一句就好/, '模型那一条也在同一份文件里');
  assert.doesNotMatch(text, /还在跑/, '那一轮已经跑完，这份文件就不是半截的读数');
  assert.ok(requests.some((request) => request.method === 'session.export' && request.params.path === path),
    '界面只交出一个目的地，排版与落盘都在宿主那一侧');
}, { permissionControl: true }));

test('exporting while the round is still running says the tail is unfinished', async () => withTuiHost(async ({ client, sessionId, directory, notifications }) => {
  // 模型服务故意等两秒（`delayMs`）：那一段时间里这一轮还在往下写，导出读到的是中途的末端。
  const round = client.request('run.start', { sessionId, input: '说一句就好' });
  await waitFor(
    () => notifications.some((message) => message.notify === 'event' && message.event.kind === 'user'),
    { read: () => JSON.stringify(notifications) },
  );
  const path = join(directory, 'half.md');
  await client.request('session.export', { sessionId, path });
  assert.match(await readFile(path, 'utf8'), /^> 导出这一刻这一份会话还在跑/m,
    '那一份文件在开头就说出后面还会写，不让人把中途的末端当成整轮');
  await round;
}, { delayMs: 2_000, permissionControl: true }));

test('session.export reports a stable code when the destination cannot be written', async () => withTuiHost(async ({ client, sessionId, directory }) => {
  await client.request('run.start', { sessionId, input: '说一句就好' });
  const blocker = join(directory, 'blocked');
  await writeFile(blocker, '这是一个文件，不是一处目录');
  await assert.rejects(
    client.request('session.export', { sessionId, path: join(blocker, 'run.md') }),
    (error) => error.code === 'host_export_write_failed',
    '对话框返回路径不等于文件已经写成',
  );
}, { permissionControl: true }));

test('session.export needs both a session and a destination', async () => withTuiHost(async ({ client, sessionId }) => {
  await assert.rejects(
    client.request('session.export', { sessionId }),
    (error) => error.code === 'protocol_args_invalid',
    '目的地说不出就落到调用之前，不去猜一个位置');
}));

// 分支文件名由宿主生成；原生文件对话框只询问主会话文件是否覆盖。
// 已经有人占着的那一个位置不盖，报出来；主文件与其余目标各报各的结果。
test('a branch file already sitting at that name is left alone and named', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-export-target-'));
  try {
    const path = join(directory, '这一轮.md');
    const branchPath = join(directory, '这一轮.b-1.md');
    await writeFile(branchPath, '已经有的一份');
    const done = await writeExport(path, '主干那一份', [{ id: 'b-1', text: '新的那一份' }, { id: 'b-2', text: '另一份' }]);
    assert.deepEqual(done.written, [path, join(directory, '这一轮.b-2.md')], '没人占着的那几份照写');
    assert.deepEqual(done.skipped, [{ id: 'b-1', path: branchPath, code: 'export_target_exists' }]);
    assert.deepEqual(done.failed, []);
    assert.equal(await readFile(branchPath, 'utf8'), '已经有的一份', '未经确认的目标不被盖掉');
    assert.equal(await readFile(path, 'utf8'), '主干那一份', '人选定的那一个位置还是写下去了');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 两次导出同时写入同一分支目标时，先检查再覆盖会造成竞争，
// 磁盘上实际留下的只有后落笔那一份的正文。独占创建让其中一次拿到已存在这一条，交回的逐份结果与磁盘一致。
test('two exports racing for one branch target leave one file and one truthful answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-export-race-'));
  try {
    const path = join(directory, '同一处.md');
    const branchPath = join(directory, '同一处.b-1.md');
    const [first, second] = await Promise.all([
      writeExport(path, 'A 的主干', [{ id: 'b-1', text: 'A 的支线' }]),
      writeExport(path, 'B 的主干', [{ id: 'b-1', text: 'B 的支线' }]),
    ]);
    const written = [first, second].filter((done) => done.written.includes(branchPath));
    const skipped = [first, second].filter((done) => done.skipped.some((item) => item.code === 'export_target_exists'));
    assert.equal(written.length, 1, '一次导出写成那一份支线文件');
    assert.equal(skipped.length, 1, '另一次说清它没去盖');
    assert.deepEqual(written[0].failed, []);
    assert.deepEqual(skipped[0].failed, []);
    assert.equal(await readFile(branchPath, 'utf8'), written[0] === first ? 'A 的支线' : 'B 的支线', '交回写成那一份的，磁盘上就是那一份的正文');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 某个文件写入失败时保留其他已成功导出的文件，并逐项返回结果。
// 这里让主文件那一个位置是一个目录（写它必然失败），支线那一份是新的：一份失败与一份写成要各说各的。
test('one target that cannot be written is named while the others stay reported', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-export-partial-'));
  try {
    const path = join(directory, '这一轮.md');
    await mkdir(path);
    const done = await writeExport(path, '主干那一份', [{ id: 'b-1', text: '新的那一份' }]);
    assert.deepEqual(done.written, [join(directory, '这一轮.b-1.md')], '写得成的那一份照写、照报');
    assert.deepEqual(done.skipped, [], '那一条支线的目标本来不在那里，不算「已经有人占着」');
    assert.equal(done.failed.length, 1, '主文件那一份没写成，说的是它自己');
    assert.equal(done.failed[0].path, path);
    assert.ok(done.failed[0].code !== '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('image markdown keeps the reference metadata and emits an encoded relative URL only when supplied', () => {
  const asset = imageAsset();
  const path = join('exports', '说明 + 图.md');
  const url = exportImageUrl(path, imageId);
  const record = { seq: 9, kind: 'tool', tool: 'read_image', result: { content: '图片已读取', images: [asset.reference] } };
  const text = exportMarkdown([record], { id: 'session-1' }, new Map([[imageId, url]]));
  assert.ok(text.includes(`![图片 ${imageId}](${url})`));
  assert.ok(text.includes(`- 图片引用：${imageId}`));
  assert.ok(text.includes('- 尺寸：1 × 1'));
  assert.ok(text.includes('- 来源：browser'));
  assert.ok(url.includes('%E8%AF%B4%E6%98%8E%20%2B%20%E5%9B%BE.assets/'), 'each relative URL path component is encoded');
  const withoutUrl = exportMarkdown([record], { id: 'session-1' });
  assert.ok(withoutUrl.includes('图片文件未随导出包含'));
  assert.ok(withoutUrl.includes(`- 图片引用：${imageId}`));
  assert.ok(withoutUrl.includes('- 来源：browser'));
});

test('image assets are written beside the main file and identical assets can be reused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-export-images-'));
  try {
    const path = join(directory, '说明 + 图.md');
    const asset = imageAsset();
    const assetPath = join(directory, '说明 + 图.assets', `${imageId}.png`);
    const url = exportImageUrl(path, imageId);
    const main = exportMarkdown([{
      seq: 9, kind: 'tool', tool: 'read_image', result: { content: '图片已读取', images: [asset.reference] },
    }], { id: 'session-1' }, new Map([[imageId, url]]));
    const first = await writeExport(path, main, [], [asset, asset]);
    assert.deepEqual(first.written, [assetPath, path], 'a duplicate reference creates one movable image file');
    assert.deepEqual(first.failed, []);
    assert.deepEqual(first.skipped, []);
    assert.deepEqual(await readFile(assetPath), imageBytes);
    assert.ok((await readFile(path, 'utf8')).includes(`![图片 ${imageId}](${url})`));

    const second = await writeExport(path, main, [], [asset]);
    assert.deepEqual(second.written, [assetPath, path], 'an existing file with the matching validated hash is reusable');
    assert.deepEqual(second.failed, []);
    assert.deepEqual(await readFile(assetPath), imageBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an image conflict is reported without overwrite and its Markdown link is disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-export-image-conflict-'));
  try {
    const path = join(directory, 'run.md');
    const asset = imageAsset();
    const assetPath = join(directory, 'run.assets', `${imageId}.png`);
    await mkdir(join(directory, 'run.assets'));
    await writeFile(assetPath, 'different existing image');
    const url = exportImageUrl(path, imageId);
    const main = exportMarkdown([{
      seq: 9, kind: 'tool', tool: 'read_image', result: { images: [asset.reference] },
    }], { id: 'session-1' }, new Map([[imageId, url]]));
    const done = await writeExport(path, main, [], [asset]);
    assert.deepEqual(done.failed, [{ path: assetPath, code: 'export_asset_conflict' }]);
    assert.deepEqual(await readFile(assetPath, 'utf8'), 'different existing image');
    const exported = await readFile(path, 'utf8');
    assert.ok(!exported.includes(`](${url})`), 'the exported Markdown does not point at a conflicting image');
    assert.ok(exported.includes('图片文件未导出'));
    assert.ok(exported.includes(`- 图片引用：${imageId}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an image buffer that does not match its reference hash is rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-export-image-hash-'));
  try {
    const path = join(directory, 'run.md');
    const valid = imageAsset();
    const asset = { ...valid, reference: { ...valid.reference, sha256: '0'.repeat(64) } };
    const assetPath = join(directory, 'run.assets', `${imageId}.png`);
    const done = await writeExport(path, 'image record', [], [asset]);
    assert.deepEqual(done.failed, [{ path: assetPath, code: 'export_asset_invalid' }]);
    await assert.rejects(readFile(assetPath), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an asset directory symlink is rejected without writing outside the export directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-export-image-link-'));
  try {
    const output = join(directory, 'output');
    const outside = join(directory, 'outside');
    await Promise.all([mkdir(output), mkdir(outside)]);
    const path = join(output, 'run.md');
    const assetsDirectory = join(output, 'run.assets');
    await symlink(outside, assetsDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const asset = imageAsset();
    const url = exportImageUrl(path, imageId);
    const main = exportMarkdown([{
      seq: 9, kind: 'tool', tool: 'read_image', result: { images: [asset.reference] },
    }], { id: 'session-1' }, new Map([[imageId, url]]));
    const done = await writeExport(path, main, [], [asset]);
    assert.deepEqual(done.failed, [{ path: join(assetsDirectory, `${imageId}.png`), code: 'export_asset_directory_invalid' }]);
    assert.deepEqual(await (async () => {
      try { return await readFile(join(outside, `${imageId}.png`)); }
      catch (error) { assert.equal(error.code, 'ENOENT'); return null; }
    })(), null, 'no asset was written through the linked directory');
    assert.ok((await readFile(path, 'utf8')).includes('图片文件未导出'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
