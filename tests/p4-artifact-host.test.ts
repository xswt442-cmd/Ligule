import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection } from '../core/dist/host/connection.js';
import { withTuiHost } from '../core/tests/helpers/tui-host.ts';

type PresentedFile = { path: string; description?: string };
type ArtifactItem = { artifactKey: string; artifact: { description: string } };
type ArtifactListing = { items: ArtifactItem[] };
type ArtifactPreview = { status?: string; preview: { type?: string; text?: string; base64?: string } };
type SessionReadReply = { events: { kind?: string; run?: { sessionId?: string } }[] };
type RunReceiptListing = { receipts: { sessionId: string }[] };

async function present(client: Connection, sessionId: string, files: PresentedFile[]) {
  await client.request('session.configure', { sessionId, mode: 'full' });
  await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'present', args: { files } }) });
}

test('artifact Host verifies current content, rejects arbitrary identities, and reads closed history', async () => {
  await withTuiHost(async ({ client, projectDirectory, sessionId, sessionDirectory }) => {
    const path = join(projectDirectory, 'report.txt');
    await writeFile(path, 'Verified report');
    await present(client, sessionId, [{ path: 'report.txt' }]);
    const args = { projectRoot: projectDirectory, sessionId };
    const listing = await client.request('artifact.list', args) as ArtifactListing;
    assert.equal(listing.items.length, 1);
    const artifactKey = listing.items[0].artifactKey;
    const identity = { ...args, artifactKey };
    assert.equal((await client.request('artifact.inspect', identity) as { status: string }).status, 'available');
    const preview = await client.request('artifact.preview', identity) as ArtifactPreview;
    assert.equal(preview.preview.type, 'text');
    assert.equal(preview.preview.text, 'Verified report');
    await assert.rejects(client.request('artifact.inspect', { ...args, artifactKey: '0'.repeat(64) }), { code: 'artifact_not_in_session' });
    await assert.rejects(client.request('artifact.resolve', identity), { code: 'artifact_native_control_required' });
    await writeFile(path, 'A revised report');
    assert.equal((await client.request('artifact.inspect', identity) as { status: string }).status, 'modified');
    await unlink(path);
    assert.equal((await client.request('artifact.inspect', identity) as { status: string }).status, 'missing');
    await client.request('session.close', { sessionId });
    const before = await readFile(join(sessionDirectory, `${sessionId}.jsonl`));
    assert.equal((await client.request('artifact.list', args) as ArtifactListing).items.length, 1);
    assert.deepEqual(await readFile(join(sessionDirectory, `${sessionId}.jsonl`)), before);
  }, { config: { policy: { mode: 'auto' } } });
});

test('artifact Host restores successful present metadata when the tool result was spilled', async () => {
  await withTuiHost(async ({ client, projectDirectory, sessionId, sessionDirectory }) => {
    await writeFile(join(projectDirectory, 'long-report.txt'), 'Source content');
    await present(client, sessionId, [{ path: 'long-report.txt', description: 'A'.repeat(300) }]);
    const raw = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8');
    assert.ok(raw.includes('"spilled"'), 'the real Kernel must spill the oversized result');
    const listing = await client.request('artifact.list', { projectRoot: projectDirectory, sessionId }) as ArtifactListing;
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0].artifact.description, 'A'.repeat(300));
    assert.equal((await client.request('artifact.inspect', { projectRoot: projectDirectory, sessionId,
      artifactKey: listing.items[0].artifactKey }) as { status: string }).status, 'available');
  }, { config: { policy: { mode: 'auto' }, limits: { resultBytes: 256 } } });
});

test('artifact preview never treats an HTML delivery as an application page', async () => {
  await withTuiHost(async ({ client, projectDirectory, sessionId }) => {
    await writeFile(join(projectDirectory, 'page.html'), '<script>document.title="unsafe"</script>');
    await present(client, sessionId, [{ path: 'page.html' }]);
    const args = { projectRoot: projectDirectory, sessionId };
    const listing = await client.request('artifact.list', args) as ArtifactListing;
    const result = await client.request('artifact.preview', { ...args, artifactKey: listing.items[0].artifactKey }) as ArtifactPreview;
    assert.equal(result.status, 'unsupported_preview');
    assert.equal(result.preview.type, 'unsupported_preview');
    assert.equal(result.preview.text, undefined);
    assert.equal(result.preview.base64, undefined);
  }, { config: { policy: { mode: 'auto' } } });
});

test('branching a durable run preserves its history without claiming the parent request key', async () => {
  await withTuiHost(async ({ client, projectDirectory, sessionId, sessionDirectory, providerRequests }) => {
    await client.request('run.start', { sessionId, input: 'Original task', requestKey: 'logical-task' });
    const parentPath = join(sessionDirectory, `${sessionId}.jsonl`);
    const before = await readFile(parentPath);
    const branch = await client.request('session.branch', { sessionId }) as { sessionId: string };
    await client.request('session.open', { sessionId: branch.sessionId });
    const history = await client.request('session.read', { sessionId: branch.sessionId, fullResults: true }) as SessionReadReply;
    assert.ok(history.events.some(event => event.kind === 'user' && event.run?.sessionId === sessionId));
    const scope = { projectRoot: projectDirectory, sessionId: branch.sessionId };
    assert.deepEqual((await client.request('run.receipts', scope) as RunReceiptListing).receipts, []);
    await client.request('run.start', { sessionId: branch.sessionId, input: 'Branch task', requestKey: 'logical-task' });
    const receipts = await client.request('run.receipts', scope) as RunReceiptListing;
    assert.equal(receipts.receipts.length, 1);
    assert.equal(receipts.receipts[0].sessionId, branch.sessionId);
    assert.equal(providerRequests.length, 2, 'copying history must not replay a parent task');
    assert.deepEqual(await readFile(parentPath), before);
  }, { permissionControl: true, config: { policy: { mode: 'auto' } } });
});
