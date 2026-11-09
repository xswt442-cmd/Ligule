import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verify(workspace) {
  const tests = spawnSync(process.execPath, ['--test', 'test/slug.test.mjs'], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(tests.error, undefined, 'the public test process starts');
  assert.equal(tests.status, 0, 'the public regression tests pass');

  const moduleUrl = `${pathToFileURL(join(workspace, 'src', 'slug.mjs')).href}?verify=${Date.now()}`;
  const slug = await import(moduleUrl);
  assert.equal(slug.slugify('Issue #42: API Fix'), 'issue-42-api-fix');
  assert.equal(slug.slugify('  Résumé / Q&A 03  '), 'resume-q-a-03');
  assert.equal(slug.slugify('No Changes'), 'no-changes');
  assert.equal(slug.normalizeLabel('  Needs   Review  '), 'Needs Review');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = process.argv[2];
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c03_workspace_required');
    await verify(workspace);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'c03_verifier_failed'}\n`);
    process.exitCode = 1;
  }
}
