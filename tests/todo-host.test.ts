import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';
import { currentTodoSnapshot } from '../core/dist/session/todo.js';

async function records(directory: string, id: string) {
  return (await readFile(join(directory, `${id}.jsonl`), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
}

test('real Host exposes todo_write only through the selected mode and clears its active list at turn end', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory, providerRequests }) => {
    const input = JSON.stringify({ tool: 'todo_write', args: { items: [{ content: 'Review files', status: 'in_progress' }] } });
    await client.request('run.start', { sessionId, input });
    assert.equal(providerRequests[0].tools!.some(tool => tool.function.name === 'todo_write'), false);
    assert.equal((await records(sessionDirectory, sessionId)).some(event => event.kind === 'todoWrite'), false);
    await client.request('mode.set', { sessionId, name: 'full' });
    await client.request('run.start', { sessionId, input });
    const events = await records(sessionDirectory, sessionId);
    const snapshot = events.find(event => event.kind === 'todoWrite');
    assert.deepEqual(snapshot.items, [{ content: 'Review files', status: 'in_progress' }]);
    assert.equal(snapshot.ignorable, true);
    assert.deepEqual(currentTodoSnapshot(events), { userSeq: null, items: [] });
    assert.equal(events.filter(event => event.kind === 'tool' && event.tool === 'todo_write').length, 1);
  }, { config: { policy: { mode: 'auto' } } });
});

test('real internal subagent todo updates stay in its own Session record', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory, providerRequests }) => {
    await client.request('mode.set', { sessionId, name: 'full' });
    const childTask = JSON.stringify({ tool: 'todo_write', args: { items: [{ content: 'Child task', status: 'completed' }] } });
    await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'subagent', args: { task: childTask } }) });
    const files = await readdir(sessionDirectory);
    const childFile = files.find(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
    assert.ok(childFile, 'a real child Session was created');
    const childEvents = await records(sessionDirectory, childFile.slice(0, -6));
    assert.deepEqual(childEvents.find(event => event.kind === 'todoWrite').items, [{ content: 'Child task', status: 'completed' }]);
    assert.equal((await records(sessionDirectory, sessionId)).some(event => event.kind === 'todoWrite'), false);
    assert.ok(providerRequests.some(request => request.tools!.some(tool => tool.function.name === 'todo_write')));
    assert.equal(providerRequests.length, 4, 'parent and child each make two model calls');
  }, { config: { policy: { mode: 'auto' }, loop: { iterations: 2, modelCalls: 2, totalModelCalls: 4 } } });
});
