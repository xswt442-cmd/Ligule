import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerFromConfig } from '../core/dist/host/host.js';
import { createConfig } from '../core/dist/kernel/config.js';
import { createMediaStore, IMAGE_LIMITS } from '../core/dist/capability/media.js';
import { workspaceIdentity } from '../core/dist/kernel/workspace.js';
import { sessionDirectory, workspaceDataDirectory } from '../core/dist/session/list.js';
import { claimStorageOwner, storageGcParent } from '../core/dist/capability/storage-gc.js';
import { createSessionLog } from '../core/dist/session/session.js';
import { createHost } from '../core/dist/host/host.js';
import type { Host } from '../core/dist/host/host.js';
import type { Connection } from '../core/dist/host/connection.js';
import type { ImageReference } from '../core/dist/media.js';

const repository = join(process.cwd());
const fixtureRoot = join(repository, 'testplace', 'v0.1.1');
const requireCore = createRequire(join(repository, 'core', 'package.json'));
const sharp = requireCore('sharp');

type StorageReply = {
  expiresInMs: number;
  planId: string;
  ids: string[];
  complete: boolean;
  scannedSessions: number;
  nextCursor?: string;
  removed: number;
  garbageRemoved: number;
  skipped: { reason: string }[];
  folders: { kind: string; bytes: number }[];
  garbage: { id: string }[];
};
type WorkspaceContext = {
  root: string;
  project: string;
  otherProject: string;
  data: string;
  host: Host;
  connection: Pick<Connection, 'notify' | 'request'>;
};

async function withWorkspace(run: (context: WorkspaceContext) => Promise<void>, { secondWorkspace = false, permissionControl = true } = {}) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'p4-storage-host-'));
  const project = join(root, 'project');
  const otherProject = join(root, 'other-project');
  const data = join(root, 'data');
  await Promise.all([project, otherProject, data].map(path => mkdir(path, { recursive: true })));
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = data;
  const environment = (projectRoot: string) => {
    const config = createConfig({ user: { boundary: projectRoot, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'storage-test' } } });
    return { config, provider: providerFromConfig(config), policy: { mode: 'auto' as const } };
  };
  const initialEnvironment = environment(project);
  const host = createHost({ ...initialEnvironment, permissionControl,
    ...(secondWorkspace ? { loadEnvironment: async projectRoot => environment(projectRoot) } : {}) });
  const connection: Pick<Connection, 'notify' | 'request'> = { notify() {}, async request() { throw new Error('storage calls do not request user approval'); } };
  try { await run({ root, project, otherProject, data, host, connection }); }
  finally {
    await host.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

async function expiredImage(project: string, sessionId: string) {
  const config = { boundary: project, workspaceRoot: project };
  const store = createMediaStore(config, sessionId);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#e05030' } }).png().toBuffer();
  const reference = await store.put(png, 'file');
  const old = new Date(Date.now() - IMAGE_LIMITS.retentionMs - 60_000);
  const saved = { ...reference, sessionId };
  const metadata = join(store.directory, `${reference.id}.json`);
  const image = join(store.directory, `${reference.id}.png`);
  await writeFile(metadata, JSON.stringify(saved));
  await Promise.all([utimes(metadata, old, old), utimes(image, old, old)]);
  return { reference: saved, image, metadata };
}

async function addSessionImage(project: string, reference: ImageReference, sessionId: string) {
  const config = { boundary: project, workspaceRoot: project };
  const log = createSessionLog({ directory: sessionDirectory(config), id: sessionId,
    meta: { projectRoot: project, workspace: workspaceIdentity(project) } });
  await log.append({ kind: 'image', callId: `image-${sessionId}` });
  await log.append({ kind: 'tool', callId: `image-${sessionId}`, tool: 'browser',
    result: { content: 'image', failed: false, images: [reference] } });
  await log.close();
}

async function request(host: Host, connection: Pick<Connection, 'notify' | 'request'>, method: string, params: unknown) {
  return await host.handle({ method, params }, connection) as StorageReply;
}

test('Host rejects a cleanup plan after its real five-minute lifetime', {
  skip: process.env.LIGULE_P4_SLOW_TESTS !== '1', timeout: 320_000,
}, async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    const image = await expiredImage(project, 'expired-plan');
    const preview = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    assert.equal(preview.expiresInMs, 300_000);
    await new Promise(resolve => setTimeout(resolve, preview.expiresInMs + 50));
    await assert.rejects(request(host, connection, 'storage.cleanup.apply', {
      projectRoot: project, planId: preview.planId, confirm: true,
    }), { code: 'storage_cleanup_plan_invalid' });
    await readFile(image.image);
  });
});

test('Host storage preview is read-only and apply requires confirmation', async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    const image = await expiredImage(project, 'confirm-target');
    const preview = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    assert.deepEqual(preview.ids, [image.reference.id]);
    assert.equal(preview.complete, true);
    await readFile(image.image);
    await assert.rejects(request(host, connection, 'storage.cleanup.apply', {
      projectRoot: project, planId: preview.planId, confirm: false,
    }), { code: 'storage_cleanup_confirmation_required' });
    await readFile(image.image);
    const inspected = await request(host, connection, 'storage.inspect', { projectRoot: project });
    assert.deepEqual(inspected.folders.map(folder => folder.kind), ['sessions', 'screenshots', 'browser', 'cache', 'tmp']);
    assert.ok(inspected.folders.find(folder => folder.kind === 'screenshots')!.bytes > 0);
  });
});

test('Host cleanup plans reject invalid IDs and reuse from another workspace', async () => {
  await withWorkspace(async ({ project, otherProject, host, connection }) => {
    const image = await expiredImage(project, 'plan-target');
    const crossWorkspace = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    await assert.rejects(request(host, connection, 'storage.cleanup.apply', {
      projectRoot: otherProject, planId: crossWorkspace.planId, confirm: true,
    }), { code: 'storage_cleanup_plan_invalid' });
    await readFile(image.image);

    await assert.rejects(request(host, connection, 'storage.cleanup.apply', {
      projectRoot: project, planId: 'invalid-plan-id', confirm: true,
    }), { code: 'storage_cleanup_plan_invalid' });
    await readFile(image.image);
  }, { secondWorkspace: true });
});

test('Host apply rechecks actual Session references and image identity', async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    const newlyReferenced = await expiredImage(project, 'late-session');
    const changed = await expiredImage(project, 'changed-before-apply');
    const preview = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    assert.deepEqual(new Set(preview.ids), new Set([newlyReferenced.reference.id, changed.reference.id]));

    await addSessionImage(project, newlyReferenced.reference, newlyReferenced.reference.sessionId);
    await writeFile(changed.image, Buffer.concat([await readFile(changed.image), Buffer.from([0])]));
    const old = new Date(Date.now() - IMAGE_LIMITS.retentionMs - 60_000);
    await utimes(changed.image, old, old);
    const applied = await request(host, connection, 'storage.cleanup.apply', {
      projectRoot: project, planId: preview.planId, confirm: true,
    });
    assert.equal(applied.removed, 0);
    assert.deepEqual(new Set(applied.skipped.map(item => item.reason)), new Set(['referenced', 'changed']));
    await readFile(newlyReferenced.image);
    await readFile(changed.image);
  });
});

test('Host refuses storage management without trusted permission control', async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    await assert.rejects(request(host, connection, 'storage.inspect', { projectRoot: project }), {
      code: 'storage_control_trusted_ui_required',
    });
  }, { permissionControl: false });
});

test('Host pages more than 100 historical Session records before authorizing cleanup', async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    const retained = await expiredImage(project, 'no-source');
    for (let i = 0; i < 110; i += 1) {
      const log = createSessionLog({ directory: sessionDirectory({ boundary: project, workspaceRoot: project }),
        id: `scan-${String(i).padStart(3, '0')}`, meta: { projectRoot: project, workspace: workspaceIdentity(project) } });
      await log.append({ kind: 'user', text: 'historical fixture' });
      await log.close();
    }
    await addSessionImage(project, retained.reference, 'scan-999');
    const first = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    assert.equal(first.complete, false);
    assert.equal(first.scannedSessions, 100);
    assert.equal(typeof first.nextCursor, 'string');
    const final = await request(host, connection, 'storage.cleanup.preview', {
      projectRoot: project, cursor: first.nextCursor,
    });
    assert.equal(final.complete, true);
    assert.equal(final.scannedSessions, 111);
    assert.deepEqual(final.ids, []);
    await readFile(retained.image);
  });
});

test('Host invalidates multi-page cleanup when an earlier Session changes mid-scan', async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    const target = await expiredImage(project, 'orphan-large-history');
    const directory = sessionDirectory({ boundary: project, workspaceRoot: project });
    for (let i = 0; i < 101; i += 1) {
      const log = createSessionLog({ directory, id: `history-${String(i).padStart(3, '0')}`,
        meta: { projectRoot: project, workspace: workspaceIdentity(project) } });
      await log.append({ kind: 'user', text: 'original' });
      await log.close();
    }
    const first = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    assert.equal(first.complete, false);
    const changed = createSessionLog({ directory, id: 'history-000' });
    await changed.append({ kind: 'user', text: 'late append' });
    await changed.close();
    await assert.rejects(request(host, connection, 'storage.cleanup.preview', {
      projectRoot: project, cursor: first.nextCursor,
    }), { code: 'image_cleanup_scan_incomplete' });
    await readFile(target.image);
  });
});

test('Host applies a completed multi-page plan to an actually orphaned image', async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    const target = await expiredImage(project, 'removed-source');
    const directory = sessionDirectory({ boundary: project, workspaceRoot: project });
    for (let i = 0; i < 105; i += 1) {
      const log = createSessionLog({ directory, id: `orphan-history-${String(i).padStart(3, '0')}`,
        meta: { projectRoot: project, workspace: workspaceIdentity(project) } });
      await log.append({ kind: 'user', text: 'unrelated historical record' });
      await log.close();
    }
    const first = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    assert.equal(first.complete, false);
    const final = await request(host, connection, 'storage.cleanup.preview', {
      projectRoot: project, cursor: first.nextCursor,
    });
    assert.deepEqual(final.ids, [target.reference.id]);
    const applied = await request(host, connection, 'storage.cleanup.apply', {
      projectRoot: project, planId: final.planId, confirm: true,
    });
    assert.equal(applied.removed, 1);
    await assert.rejects(readFile(target.image), { code: 'ENOENT' });
  });
});

test('Host includes versioned managed tmp residue in the same confirmed cleanup plan', async () => {
  await withWorkspace(async ({ project, host, connection }) => {
    const config = { boundary: project, workspaceRoot: project };
    const root = workspaceDataDirectory(config);
    await mkdir(root, { recursive: true });
    const release = await claimStorageOwner(root, workspaceIdentity(project), 'tmp', 'old-managed-output', 'removed-source');
    const directory = join(storageGcParent(root, 'tmp'), 'old-managed-output');
    const marker = join(directory, '.ligule-owner.json');
    const payload = join(directory, 'output.txt');
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await writeFile(payload, 'derived fixture');
    await writeFile(marker, JSON.stringify({ version: 1, workspace: workspaceIdentity(project),
      kind: 'tmp', id: 'old-managed-output', sessionId: 'removed-source', createdAt: old.toISOString() }));
    await Promise.all([utimes(payload, old, old), utimes(marker, old, old)]);
    await release();
    const preview = await request(host, connection, 'storage.cleanup.preview', { projectRoot: project });
    assert.equal(preview.complete, true);
    assert.deepEqual(preview.garbage.map(item => item.id), ['tmp:old-managed-output']);
    const applied = await request(host, connection, 'storage.cleanup.apply', {
      projectRoot: project, planId: preview.planId, confirm: true,
    });
    assert.equal(applied.garbageRemoved, 1);
    await assert.rejects(readFile(payload), { code: 'ENOENT' });
  });
});
