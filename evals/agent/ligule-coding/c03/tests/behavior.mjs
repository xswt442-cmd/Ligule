import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c03_workspace_required');

const moduleUrl = `${pathToFileURL(join(workspace, 'src', 'slug.mjs')).href}?verify=${Date.now()}`;
const slug = await import(moduleUrl);
assert.equal(slug.slugify('Issue #42: API Fix'), 'issue-42-api-fix');
assert.equal(slug.slugify('  Résumé / Q&A 03  '), 'resume-q-a-03');
assert.equal(slug.slugify('No Changes'), 'no-changes');
assert.equal(slug.normalizeLabel('  Needs   Review  '), 'Needs Review');
