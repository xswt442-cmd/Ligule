import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { withTuiHost } from '../../core/tests/helpers/tui-host.ts';

test('the TUI host helper runs a real Chat Completions HTTP round and records its files and frames', async () => {
  await withTuiHost(async ({ client, config, directory, sessionDirectory, sessionId, requests, notifications, providerRequests }) => {
    assert.equal(config.boundary.startsWith(join(directory, 'project')), true);
    const input = 'Explain this local harness';
    const result = await client.request('run.start', { sessionId, input });
    assert.equal(result.iterations, 1);
    assert.deepEqual(providerRequests[0].messages.at(-1), { role: 'user', content: input });
    assert.equal(providerRequests[0].stream, true);
    assert.equal(providerRequests[0].stream_options.include_usage, true);
    assert.ok(requests.some((request) => request.method === 'session.create'));
    assert.ok(requests.some((request) => request.method === 'run.start' && request.params.input === input));
    assert.ok(notifications.some((message) => message.event?.kind === 'assistant'));

    const { events } = await client.request('session.read', { sessionId });
    const answer = events.find((event) => event.kind === 'assistant');
    const usage = events.find((event) => event.kind === 'usage');
    assert.equal(answer.text, `Local response: ${input}`);
    assert.equal(usage.input, Buffer.byteLength(JSON.stringify(providerRequests[0])));
    assert.equal(usage.output, Buffer.byteLength(answer.text));
    const recordPath = join(sessionDirectory, `${sessionId}.jsonl`);
    assert.ok((await readdir(sessionDirectory)).includes(`${sessionId}.jsonl`));
    assert.match(await readFile(recordPath, 'utf8'), /"kind":"assistant"/);
  }, { delayMs: 5 });
});
