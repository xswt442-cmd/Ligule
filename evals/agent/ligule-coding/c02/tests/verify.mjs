import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verify(workspace) {
  const tests = spawnSync(process.execPath, ['--test', 'test/server.test.mjs'], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(tests.error, undefined, 'the public test process starts');
  assert.equal(tests.status, 0, 'the public tests pass');

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

    const missing = await fetch(`${baseUrl}/api/items/missing`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'missing' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = process.argv[2];
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c02_workspace_required');
    await verify(workspace);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'c02_verifier_failed'}\n`);
    process.exitCode = 1;
  }
}
