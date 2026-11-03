import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { symlink, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfig, createDecisionChain, createKernel, createPermissionContext, createSessionLog } from '../dist/index.js';
import { createPresentPlugin } from '../dist/tools/present.js';
import type { PresentResult } from '../dist/tools/present.js';
import { isFileArtifact } from '../dist/session/artifact.js';
import type { Kernel } from '../dist/kernel/kernel.js';
import type { SessionLog } from '../dist/session/session.js';

const access = createPermissionContext('full-access', 'unrestricted', { filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full' });

type PresentFixture = { root: string; session: SessionLog; kernel: Kernel };

async function fixture(run: (state: PresentFixture) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'present-'));
  const session = createSessionLog({ directory: join(root, 'sessions'), id: 'present-test' });
  const config = createConfig({ user: { workspaceRoot: root, boundary: '.', policy: { mode: 'auto' } } });
  const kernel = createKernel({ config, permission: access, policy: createDecisionChain({ mode: 'auto' }), session });
  createPresentPlugin({ sessionId: 'present-test', workspaceRoot: root, session }).setup(kernel);
  try { await run({ root, session, kernel }); }
  finally { await session.close(); await rm(root, { recursive: true, force: true }); }
}

test('present returns bounded metadata, records an ignorable artifact event, and leaves source unchanged', async () => {
  await fixture(async ({ root, session, kernel }) => {
    const source = Buffer.from('private document bytes');
    const path = join(root, 'report.txt');
    await writeFile(path, source);
    const result = await kernel.call('present', { files: [{ path: 'report.txt', description: 'Report' }] }) as PresentResult;
    assert.equal(result.artifacts[0].sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(result.artifacts[0].mimeType, 'text/plain');
    assert.equal(result.artifacts[0].bytes, source.length);
    assert.equal(result.artifacts[0].path, 'report.txt');
    assert.equal(JSON.stringify(result).includes(source.toString()), false);
    const recorded = (await readFile(session.path, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.kind === 'artifact')!;
    assert.deepEqual(recorded.artifacts, result.artifacts);
    assert.equal(recorded.ignorable, true);
    assert.equal((await readFile(session.path, 'utf8')).includes(source.toString()), false);
    assert.deepEqual(await readFile(path), source);
  });
});

test('present rejects traversal, absolute paths and symlinks', async () => {
  await fixture(async ({ root, kernel }) => {
    const outside = join(root, '..', 'outside-present');
    await writeFile(outside, 'outside');
    try {
      await assert.rejects(kernel.call('present', { files: [{ path: '../outside-present' }] }), { code: 'artifact_path_invalid' });
      await assert.rejects(kernel.call('present', { files: [{ path: outside }] }), { code: 'artifact_path_invalid' });
      await symlink(outside, join(root, 'link.txt'));
      await assert.rejects(kernel.call('present', { files: [{ path: 'link.txt' }] }));
    } finally { await rm(outside, { force: true }); }
  });
});

test('present is classified as a filesystem read tool in the Kernel', async () => {
  await fixture(async ({ root, session }) => {
    await writeFile(join(root, 'x.txt'), 'x');
    const readOnly = createKernel({ config: createConfig({ user: { workspaceRoot: root, boundary: '.' } }), session });
    createPresentPlugin({ sessionId: 'present-test', workspaceRoot: root, session }).setup(readOnly);
    assert.deepEqual(readOnly.selectable(), ['present']);
  });
});

test('present enforces individual file and description limits', async () => {
  await fixture(async ({ root, kernel }) => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'large.bin'), Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(kernel.call('present', { files: [{ path: 'nested/large.bin' }] }), { code: 'artifact_file_too_large' });
    await assert.rejects(kernel.call('present', { files: [{ path: 'nested/large.bin', description: 'x'.repeat(401) }] }), { code: 'tool_args_invalid' });
  });
});

test('present enforces the aggregate byte limit', async () => {
  await fixture(async ({ root, kernel }) => {
    const files: { path: string }[] = [];
    for (let index = 0; index < 4; index += 1) {
      const path = `part-${index}.bin`;
      await writeFile(join(root, path), Buffer.alloc(17 * 1024 * 1024));
      files.push({ path });
    }
    await assert.rejects(kernel.call('present', { files }), { code: 'artifact_total_too_large' });
  });
});

test('file artifact validation rejects unsafe or malformed metadata', () => {
  const valid = { kind: 'file', sessionId: 'session', path: 'dir/file.txt', mimeType: 'text/plain', bytes: 0, sha256: 'a'.repeat(64) };
  assert.equal(isFileArtifact(valid), true);
  for (const invalid of [
    { ...valid, extra: 'field' }, { ...valid, path: '../file.txt' }, { ...valid, path: 'C:/file.txt' },
    { ...valid, path: 'dir\\file.txt' }, { ...valid, bytes: 20 * 1024 * 1024 + 1 },
    { ...valid, sha256: 'invalid' }, { ...valid, description: 'x'.repeat(401) },
  ]) assert.equal(isFileArtifact(invalid), false);
});
