import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createMediaStore, IMAGE_LIMITS } from '../dist/capability/media.js';
import type { ImageReference, MediaStore } from '../dist/capability/media.js';
import { sessionDirectory } from '../dist/session/list.js';
import type { SessionDirectoryConfig } from '../dist/session/list.js';
import { createSessionLog } from '../dist/session/session.js';

const fixtureRoot = fileURLToPath(new URL('../../testplace/v0.1.1/', import.meta.url));

type StoreFixture = { root: string; config: SessionDirectoryConfig; store: MediaStore };

async function withStore(run: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'p4-storage-'));
  const config: SessionDirectoryConfig = { boundary: root, workspaceRoot: root, userHome: join(root, 'home') };
  try { await run({ root, config, store: createMediaStore(config, 'owner') }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function expired(store: MediaStore, sessionId: string): Promise<{ reference: ImageReference; metadata: string; image: string }> {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#e05030' } }).png().toBuffer();
  const reference = await store.put(png, 'file');
  const old = new Date(Date.now() - IMAGE_LIMITS.retentionMs - 60_000);
  const saved = { ...reference, sessionId };
  const metadata = join(store.directory, `${reference.id}.json`);
  await writeFile(metadata, JSON.stringify(saved));
  await Promise.all([utimes(metadata, old, old), utimes(join(store.directory, `${reference.id}.png`), old, old)]);
  return { reference: saved, metadata, image: join(store.directory, `${reference.id}.png`) };
}

async function appendImage(config: SessionDirectoryConfig, reference: ImageReference, id: string): Promise<void> {
  const session = createSessionLog({ directory: sessionDirectory(config), id,
    meta: { projectRoot: config.workspaceRoot, workspace: reference.workspace } });
  await session.append({ kind: 'image', callId: `image-${id}` });
  await session.append({ kind: 'tool', callId: `image-${id}`, tool: 'browser',
    result: { content: 'image', failed: false, images: [reference] } });
  await session.close();
}

test('cleanup keeps references in real session records and source sessions', async () => {
  await withStore(async ({ config, store }) => {
    const referenced = await expired(store, 'referenced-source');
    await appendImage(config, referenced.reference, referenced.reference.sessionId);
    const fromExistingSource = await expired(store, 'retained-source');
    const source = createSessionLog({ directory: sessionDirectory(config), id: 'retained-source',
      meta: { projectRoot: config.workspaceRoot, workspace: referenced.reference.workspace } });
    await source.append({ kind: 'user', text: 'source session remains' });
    await source.close();

    const preview = await store.cleanup({ withFingerprints: true });
    assert.deepEqual(preview.ids, []);
    assert.ok((await store.cleanup({ allowedIds: [referenced.reference.id, fromExistingSource.reference.id] })).candidates === 0);
    await access(referenced.image);
    await access(fromExistingSource.image);
  });
});

test('cleanup apply rechecks a changed image and a newly appended session reference', async () => {
  await withStore(async ({ config, store }) => {
    const changed = await expired(store, 'gone-changed');
    const newlyReferenced = await expired(store, 'gone-referenced');
    const preview = await store.cleanup({ withFingerprints: true });
    assert.deepEqual(new Set(preview.ids), new Set([changed.reference.id, newlyReferenced.reference.id]));

    await appendImage(config, newlyReferenced.reference, newlyReferenced.reference.sessionId);
    await writeFile(changed.image, Buffer.concat([await readFile(changed.image), Buffer.from([0])]));
    const old = new Date(Date.now() - IMAGE_LIMITS.retentionMs - 60_000);
    await utimes(changed.image, old, old);
    const applied = await store.cleanup({ dryRun: false, allowedIds: preview.ids,
      expectedFingerprints: preview.fingerprints, withFingerprints: true });
    assert.equal(applied.removed, 0);
    assert.deepEqual(new Set((applied.skipped ?? []).map(item => item.reason)), new Set(['changed', 'referenced']));
    await access(changed.image);
    await access(newlyReferenced.image);
  });
});

test('cleanup fails closed for over-budget session scans and linked media targets', async () => {
  await withStore(async ({ config, root, store }) => {
    await mkdir(store.directory, { recursive: true });
    const directory = sessionDirectory(config);
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 101; index += 1) {
      const id = `budget-${String(index).padStart(3, '0')}`;
      const session = createSessionLog({ directory, id, meta: { projectRoot: root } });
      await session.append({ kind: 'user', text: 'budget record' });
      await session.close();
    }
    await assert.rejects(store.cleanup(), { code: 'image_cleanup_scan_incomplete' });

    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const large = createSessionLog({ directory, id: 'large-record', meta: { projectRoot: root } });
    await large.append({ kind: 'user', text: 'x'.repeat(16 * 1024 * 1024) });
    await large.close();
    await assert.rejects(store.cleanup(), { code: 'image_cleanup_scan_incomplete' });

    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'broken.jsonl'), '{bad json}\n');
    await assert.rejects(store.cleanup(), { code: 'session_line_invalid' });

    await rm(store.directory, { recursive: true, force: true });
    const outside = join(root, 'outside-media');
    await mkdir(outside);
    await symlink(outside, store.directory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.cleanup(), { code: 'image_storage_link' });
  });
});
