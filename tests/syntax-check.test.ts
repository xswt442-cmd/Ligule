import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { checkJavaScriptFiles, collectJavaScriptFiles } from '../scripts/check-js-syntax.ts';

test('the repository syntax checker scans tests/ and rejects invalid JavaScript', async () => {
  const parent = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'syntax-check-'));
  const invalid = join(root, 'tests', 'broken.mjs');
  try {
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(invalid, 'export const = ;\n', 'utf8');
    const files = collectJavaScriptFiles(root, ['tests']);
    assert.deepEqual(files, [invalid]);
    const failures = checkJavaScriptFiles(files);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].file, invalid);
    assert.match(failures[0].output, /SyntaxError/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
