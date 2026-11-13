import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c02_workspace_required');

const serverModule = await import(`${pathToFileURL(join(workspace, 'src', 'server.mjs')).href}?verify=${Date.now()}`);
const server = serverModule.createItemServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const updated = await fetch(`${baseUrl}/api/items/item-1`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '  Black Tea  ' }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { id: 'item-1', name: 'Black Tea' });

  const invalid = await fetch(`${baseUrl}/api/items/item-1`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ' '.repeat(2) }),
  });
  assert.equal(invalid.status, 400);
  const unchanged = await fetch(`${baseUrl}/api/items/item-1`);
  assert.deepEqual(await unchanged.json(), { id: 'item-1', name: 'Black Tea' });

  const invalidNameBodies = [{}, { name: 123 }, { name: null }];
  for (const body of invalidNameBodies) {
    const invalidName = await fetch(`${baseUrl}/api/items/item-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(invalidName.status, 400);
    const unchangedAfterInvalidName = await fetch(`${baseUrl}/api/items/item-1`);
    assert.deepEqual(await unchangedAfterInvalidName.json(), { id: 'item-1', name: 'Black Tea' });
  }

  const malformed = await fetch(`${baseUrl}/api/items/item-1`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  const unchangedAfterMalformed = await fetch(`${baseUrl}/api/items/item-1`);
  assert.deepEqual(await unchangedAfterMalformed.json(), { id: 'item-1', name: 'Black Tea' });

  const overlong = await fetch(`${baseUrl}/api/items/item-1`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(81) }),
  });
  assert.equal(overlong.status, 400);
  const unchangedAfterOverlong = await fetch(`${baseUrl}/api/items/item-1`);
  assert.deepEqual(await unchangedAfterOverlong.json(), { id: 'item-1', name: 'Black Tea' });

  const missing = await fetch(`${baseUrl}/api/items/missing`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'missing' }),
  });
  assert.equal(missing.status, 404);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
