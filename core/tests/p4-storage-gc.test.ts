import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimStorageOwner, previewStorageGarbage, applyStorageGarbage, storageGcParent } from '../dist/capability/storage-gc.js';
import type { StorageGcKind } from '../dist/capability/storage-gc.js';

const fixtureRoot = fileURLToPath(new URL('../../testplace/v0.1.1/', import.meta.url));
const workspace = 'fixture-workspace';
const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

async function fixture(run: (root: string) => Promise<void>) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'p4-gc-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function owned(root: string, kind: StorageGcKind, id: string, { hold = false }: { hold?: boolean } = {}) {
  const release = await claimStorageOwner(root, workspace, kind, id, id);
  const directory = join(storageGcParent(root, kind), id);
  const marker = join(directory, '.ligule-owner.json');
  const payload = join(directory, 'generated.txt');
  await writeFile(payload, 'generated-only');
  await writeFile(marker, JSON.stringify({ version: 1, workspace, kind, id, sessionId: id, createdAt: old.toISOString() }));
  await Promise.all([utimes(payload, old, old), utimes(marker, old, old)]);
  if (!hold) await release();
  return { directory, marker, payload, release };
}

test('GC reclaims only old explicitly-owned cache/tmp/browser directories; unknown folders remain', async () => {
  await fixture(async root => {
    const browser = await owned(root, 'browser', 'orphan-browser');
    const cache = await owned(root, 'cache', 'orphan-cache');
    const tmp = await owned(root, 'tmp', 'orphan-tmp');
    const unknown = join(storageGcParent(root, 'tmp'), 'legacy-user-data');
    await mkdir(unknown);
    await writeFile(join(unknown, 'keep.txt'), 'unknown');
    const legacyFile = join(storageGcParent(root, 'tmp'), 'legacy-file.txt');
    await writeFile(legacyFile, 'also unknown');
    const preview = await previewStorageGarbage(root, workspace, new Set());
    assert.deepEqual(new Set(preview.candidates.map(item => item.id)),
      new Set(['browser:orphan-browser', 'cache:orphan-cache', 'tmp:orphan-tmp']));
    const applied = await applyStorageGarbage(root, workspace, new Set(), preview.candidates);
    assert.equal(applied.removed, 3);
    for (const item of [browser, cache, tmp]) {
      await assert.rejects(access(item.directory), { code: 'ENOENT' });
    }
    assert.equal(await readFile(join(unknown, 'keep.txt'), 'utf8'), 'unknown');
    assert.equal(await readFile(legacyFile, 'utf8'), 'also unknown');
  });
});

test('GC protects active leases and source sessions, even when marker and files are old', async () => {
  await fixture(async root => {
    const active = await owned(root, 'tmp', 'active-tmp', { hold: true });
    const source = await owned(root, 'browser', 'retained-browser');
    const sourceTmp = await owned(root, 'tmp', 'retained-tmp');
    const preview = await previewStorageGarbage(root, workspace, new Set(['retained-browser', 'retained-tmp']));
    assert.deepEqual(preview.candidates, []);
    await access(active.payload);
    await access(source.payload);
    await access(sourceTmp.payload);
    await active.release();
  });
});

test('claim does not adopt a legacy directory with the same managed ID', async () => {
  await fixture(async root => {
    const parent = storageGcParent(root, 'tmp');
    await mkdir(parent, { recursive: true });
    const legacy = join(parent, 'reused-id');
    await mkdir(legacy);
    await writeFile(join(legacy, 'user.txt'), 'keep me');
    await assert.rejects(claimStorageOwner(root, workspace, 'tmp', 'reused-id', 'source'),
      { code: 'storage_owner_invalid' });
    assert.equal(await readFile(join(legacy, 'user.txt'), 'utf8'), 'keep me');
    await assert.rejects(access(join(legacy, '.ligule-owner.json')), { code: 'ENOENT' });
  });
});

test('GC skips a candidate changed after preview without deleting unknown files', async () => {
  await fixture(async root => {
    const item = await owned(root, 'cache', 'changed-cache');
    const preview = await previewStorageGarbage(root, workspace, new Set());
    assert.equal(preview.candidates.length, 1);
    await writeFile(item.payload, 'replaced after preview');
    const applied = await applyStorageGarbage(root, workspace, new Set(), preview.candidates);
    assert.equal(applied.removed, 0);
    assert.deepEqual(applied.skipped.map(value => value.reason), ['storage_candidate_changed']);
    assert.equal(await readFile(item.payload, 'utf8'), 'replaced after preview');
  });
});
