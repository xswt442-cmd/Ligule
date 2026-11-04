import test from 'node:test';
import assert from 'node:assert/strict';
import { controlTargetFromChoice } from '../dist/tui/app.js';

test('a selected grant overrides the previous render target immediately', () => {
  assert.equal(controlTargetFromChoice('grant:new-grant', 'stale-grant'), 'new-grant');
  assert.equal(controlTargetFromChoice('back', 'current-grant'), 'current-grant');
});
