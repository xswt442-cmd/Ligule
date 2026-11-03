import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { withTuiHost } from './helpers/tui-host.ts';

test('complete results are read through the Host without changing the record or model projection', async () => {
  await withTuiHost(async ({ client, config, sessionId, sessionDirectory }) => {
    // 正文自己造，不拿仓库里那份文档当样本：文档会一直长，长过读取那一格的上限时交回的是截断那一份，这条断言就跟文档的字节数绑在了一起。
    const original = Array.from({ length: 600 }, (_, index) => `${index} 这一段正文要长到越过那一格上限`).join('\n');
    await writeFile(join(config.boundary, 'notes.md'), original);
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'read', args: { path: 'notes.md' } }) });
    const recordPath = join(sessionDirectory, `${sessionId}.jsonl`);
    const bytes = await readFile(recordPath);
    const regular = await client.request('session.read', { sessionId });
    const limited = regular.events.find((event) => event.kind === 'tool');
    assert.equal(limited.result.spillFormat, 'json');
    assert.ok(Buffer.byteLength(limited.result.content) <= 200);
    const complete = await client.request('session.read', { sessionId, fullResults: true });
    assert.equal(complete.header.projectRoot, config.boundary);
    assert.equal(complete.events.find((event) => event.kind === 'tool').result.content.text, original);
    assert.deepEqual(await readFile(recordPath), bytes);
    assert.deepEqual((await client.request('session.read', { sessionId })).events, regular.events);

    const objects = bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
    const spilled = objects.find((event) => event.kind === 'tool').result.spilled;
    objects.find((event) => event.kind === 'tool').result.spilled = '../notes.md';
    await writeFile(recordPath, objects.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await assert.rejects(client.request('session.read', { sessionId, fullResults: true }), (error) => error.code === 'session_spill_reference_invalid');

    objects.find((event) => event.kind === 'tool').result.spilled = spilled;
    await writeFile(recordPath, objects.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const outside = join(config.boundary, 'outside');
    await mkdir(outside);
    await rename(join(sessionDirectory, spilled), join(sessionDirectory, `${spilled}.kept`));
    await symlink(outside, join(sessionDirectory, spilled), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(client.request('session.read', { sessionId, fullResults: true }), (error) => error.code === 'session_spill_reference_invalid');
  }, { config: { limits: { contextTokens: 200000, resultBytes: 200 } } });
});
