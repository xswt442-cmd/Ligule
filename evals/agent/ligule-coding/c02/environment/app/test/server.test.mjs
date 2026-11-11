import test from 'node:test';
import assert from 'node:assert/strict';
import { createItemServer } from '../src/server.mjs';

async function withServer(run) {
  const server = createItemServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('GET returns the existing item', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/item-1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'item-1', name: 'Tea' });
  });
});

test('PATCH trims and updates an existing item', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/item-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Black Tea  ' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'item-1', name: 'Black Tea' });
  });
});

test('PATCH rejects invalid names without changing the item', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/item-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(response.status, 400);
    const unchanged = await fetch(`${baseUrl}/api/items/item-1`);
    assert.deepEqual(await unchanged.json(), { id: 'item-1', name: 'Tea' });
  });
});

test('PATCH remains unsupported under the current route contract', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/item-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Black Tea' }),
    });
    assert.equal(response.status, 405);
  });
});
