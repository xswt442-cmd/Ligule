import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repository, 'tui', 'dist', 'cli.js');

type StorageReport = {
  projectRoot: string;
  folders: { kind: string; complete: boolean; bytes: number }[];
};

test('CLI inspects a clean workspace without a model and refuses noninteractive deletion', async () => {
  const fixtures = join(repository, 'testplace');
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'p4-storage-cli-'));
  const project = join(root, '工作区 with spaces');
  const data = join(root, 'data');
  await Promise.all([mkdir(project), mkdir(data)]);
  try {
    const options: SpawnSyncOptionsWithStringEncoding = { cwd: project, env: { ...process.env, LIGULE_HOME: data }, encoding: 'utf8', timeout: 20_000, windowsHide: true };
    const inspection = spawnSync(process.execPath, [cli, 'storage', 'inspect', '--json'], options);
    assert.equal(inspection.status, 0, inspection.stderr);
    const report = JSON.parse(inspection.stdout) as StorageReport;
    assert.equal(report.projectRoot, project);
    assert.deepEqual(report.folders.map(item => item.kind).sort(), ['browser', 'cache', 'screenshots', 'sessions', 'tmp']);
    assert.ok(report.folders.every(item => item.complete === true && item.bytes === 0));
    const deletion = spawnSync(process.execPath, [cli, 'storage', 'cleanup', '--json'], options);
    assert.notEqual(deletion.status, 0);
    assert.match(deletion.stdout + deletion.stderr, /cli_storage_action_invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
