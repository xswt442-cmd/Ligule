import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('c01_workspace_required');

const moduleUrl = `${pathToFileURL(join(workspace, 'src', 'contact.mjs')).href}?verify=${Date.now()}`;
const contact = await import(moduleUrl);
assert.equal(contact.displayName({ nickname: '  Ada  ', firstName: 'Ada', lastName: 'Lovelace' }), 'Ada');
assert.equal(contact.displayName({ firstName: ' Ada ', lastName: ' Lovelace ' }), 'Ada Lovelace');
assert.equal(contact.displayName({ firstName: ' ', lastName: '' }), '');
assert.equal(contact.normalizePhone('(415) 555-0123'), '+14155550123');
assert.equal(contact.normalizePhone('1 (415) 555-0123'), '+14155550123');
assert.equal(contact.normalizePhone('+44 (20) 7946-0958'), '+442079460958');
assert.equal(contact.normalizePhone('12345'), null);
assert.equal(contact.priorityLabel(' Needs Review '), 'NEEDS REVIEW');
