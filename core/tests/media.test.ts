import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { createMediaStore, imagePreview, IMAGE_LIMITS } from '../dist/capability/media.js';
import type { MediaStore } from '../dist/capability/media.js';
import { sessionDirectory, workspaceDataDirectory } from '../dist/session/list.js';
import type { SessionDirectoryConfig } from '../dist/session/list.js';
import { createSessionLog } from '../dist/session/session.js';

type StoreFixture = { root: string; config: SessionDirectoryConfig; store: MediaStore };

async function withStore(run: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'media-'));
  const config: SessionDirectoryConfig = { boundary: root, workspaceRoot: root, userHome: join(root, 'home') };
  try { await run({ root, config, store: createMediaStore(config, 'parent') }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('real PNG, JPEG, WebP and GIF decode to durable normalized PNG references', async () => {
  await withStore(async ({ config, store }) => {
    assert.equal(dirname(sessionDirectory(config)), dirname(store.directory));
    const overridden = { ...config, host: { sessionDirectory: join(config.boundary, 'custom') } };
    assert.equal(createMediaStore(overridden, 'parent').directory, store.directory);
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const source = await sharp({ create: { width: 2500, height: 10, channels: 3, background: '#12b875' } }).toFormat(format).toBuffer();
      const reference = await store.put(source, 'file');
      assert.equal(reference.width, 2048);
      assert.ok(reference.height <= 10);
      const reopened = createMediaStore(config, 'parent');
      const bytes = await reopened.read(reference);
      assert.equal(reference.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal((await sharp(bytes).metadata()).format, 'png');
      assert.deepEqual(await reopened.reference(reference.id), reference);
      const preview = await imagePreview(reopened, reference);
      assert.equal(preview.mimeType, 'image/webp');
      assert.equal(preview.width, 512);
      assert.ok(preview.height <= 10);
      const display = Buffer.from(preview.base64, 'base64');
      assert.ok(display.length <= 256 * 1024);
      const metadata = await sharp(display).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, preview.width);
      assert.equal(metadata.height, preview.height);
      assert.deepEqual(await reopened.read(reference), bytes);
      assert.ok(!JSON.stringify(reference).includes('base64'));
      assert.equal((await readFile(join(store.directory, `${reference.id}.json`), 'utf8')).includes('data:image'), false);
    }
  });
});

test('image ownership, inherited branch references and stored integrity are enforced', async () => {
  await withStore(async ({ config, root, store }) => {
    const input = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'red' } }).png().toBuffer();
    const reference = await store.put(input, 'desktop');
    await assert.rejects(createMediaStore(config, 'other').read(reference), { code: 'image_owner_mismatch' });
    await assert.rejects(createMediaStore({ ...config, workspaceRoot: join(root, 'different') }, 'parent').read(reference), { code: 'image_owner_mismatch' });
    assert.deepEqual(await createMediaStore(config, 'branch', [reference]).read(reference), await store.read(reference));
    const later = await store.put(input, 'desktop');
    await assert.rejects(createMediaStore(config, 'branch', [reference]).read(later), { code: 'image_owner_mismatch' });
    await assert.rejects(store.read({ ...reference, width: 1 }), { code: 'image_reference_mismatch' });
    await assert.rejects(store.reference('../escape'), { code: 'image_reference_invalid' });
    await writeFile(join(store.directory, `${reference.id}.png`), 'damaged');
    await assert.rejects(store.read(reference), { code: 'image_digest_mismatch' });
  });
});

test('invalid, unsupported, oversized and cancelled images do not become references', async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(store.put(Buffer.from('not an image'), 'file'), { code: 'image_decode_failed' });
    const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).tiff().toBuffer();
    await assert.rejects(store.put(tiff, 'file'), { code: 'image_format_unsupported' });
    await assert.rejects(store.put(Buffer.alloc(IMAGE_LIMITS.inputBytes + 1), 'file'), { code: 'image_bytes_exceeded' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.put(tiff, 'file', controller.signal), { name: 'AbortError' });
  });
});

test('cancellation during real image normalization rejects without publishing a reference', { timeout: 10_000 }, async () => {
  await withStore(async ({ store }) => {
    const bytes = await sharp({ create: { width: 5000, height: 1000, channels: 3, background: 'green' } }).png().toBuffer();
    const signal = AbortSignal.timeout(1);
    await assert.rejects(store.put(bytes, 'file', signal), { name: 'TimeoutError' });
  });
});

test('linked media directories cannot redirect publication outside the workspace store', async () => {
  await withStore(async ({ config, root, store }) => {
    await mkdir(workspaceDataDirectory(config), { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, store.directory, process.platform === 'win32' ? 'junction' : 'dir');
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(store.put(bytes, 'browser'), { code: 'image_storage_link' });
  });
});

test('concurrent image publications have unique references and enforce the storage quota', async () => {
  await withStore(async ({ config, store }) => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    const references = await Promise.all(Array.from({ length: 4 }, () => createMediaStore(config, 'parent').put(bytes, 'browser')));
    assert.equal(new Set(references.map(item => item.id)).size, 4);
    for (const reference of references) assert.ok((await store.read(reference)).length > 0);
    const oversized = await open(join(store.directory, `${randomUUID()}.png`), 'wx');
    try { await oversized.truncate(IMAGE_LIMITS.storageBytes); }
    finally { await oversized.close(); }
    await assert.rejects(store.put(bytes, 'desktop'), { code: 'image_storage_full' });
  });
});

test('cleanup preserves old referenced images and removes only unreferenced expired images', async () => {
  await withStore(async ({ config, root, store }) => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    const saved = await store.put(bytes, 'desktop');
    const old = new Date(Date.now() - IMAGE_LIMITS.retentionMs - 60_000);
    const reference = { ...saved, createdAt: old.toISOString() };
    const metadataPath = join(store.directory, `${saved.id}.json`);
    const imagePath = join(store.directory, `${saved.id}.png`);
    await writeFile(metadataPath, JSON.stringify(reference));
    await Promise.all([utimes(metadataPath, old, old), utimes(imagePath, old, old)]);
    const overridden = { ...config, host: { sessionDirectory: join(root, 'custom-sessions') } };
    const cleanupStore = createMediaStore(overridden, 'parent');
    const session = createSessionLog({ directory: sessionDirectory(overridden), id: 'retained-image',
      meta: { projectRoot: root, workspace: reference.workspace } });
    await session.append({ kind: 'image', callId: 'image-call' });
    await session.append({ kind: 'tool', callId: 'image-call', tool: 'browser', result: { content: 'image', failed: false, images: [reference] } });
    await session.close();
    const unused = await store.put(bytes, 'desktop');
    const unusedMetadata = join(store.directory, `${unused.id}.json`);
    const unusedImage = join(store.directory, `${unused.id}.png`);
    await Promise.all([utimes(unusedMetadata, old, old), utimes(unusedImage, old, old)]);
    const quotaFile = await open(join(store.directory, `${randomUUID()}.png`), 'wx');
    try { await quotaFile.truncate(IMAGE_LIMITS.storageBytes); }
    finally { await quotaFile.close(); }
    await assert.rejects(store.put(bytes, 'desktop'), { code: 'image_storage_full' });
    await access(imagePath);
    const unrelated = join(store.directory, 'user-note.json');
    await writeFile(unrelated, 'keep');
    await utimes(unrelated, old, old);
    const preview = await cleanupStore.cleanup({ dryRun: true });
    assert.deepEqual(preview.ids, [unused.id]);
    await access(imagePath);
    assert.deepEqual(await createMediaStore(config, 'retained-image', [reference]).read(reference), bytes);
    await cleanupStore.cleanup({ dryRun: false });
    await assert.rejects(access(unusedImage), { code: 'ENOENT' });
    await assert.rejects(access(unusedMetadata), { code: 'ENOENT' });
    await access(imagePath);
    assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  });
});
