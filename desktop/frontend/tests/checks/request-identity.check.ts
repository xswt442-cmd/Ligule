import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIsCurrent } from '../../src/request-identity.ts';

test('request ownership requires both the active scope and its current generation', () => {
  const request = { scope: 'workspace-a', generation: 3 };
  assert.equal(requestIsCurrent(request, 'workspace-a', 3), true);
  assert.equal(requestIsCurrent(request, 'workspace-b', 4), false);
  assert.equal(requestIsCurrent(request, 'workspace-a', 5), false, 'a later request in the same scope supersedes the old one');
});
