// 外控 Composer 可卸载重挂；未发送指导草稿必须由 Session 身份持有。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearExternalSessionDraftIfCurrent,
  externalSessionDraftFor,
  externalSessionDraftRevisionFor,
  updateExternalSessionDrafts,
  type ExternalSessionDrafts,
} from '../../src/external-session-drafts.ts';

test('external guidance drafts survive composer remounts and remain isolated by session', () => {
  let drafts: ExternalSessionDrafts = new Map();
  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'unsent guidance');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'unsent guidance');

  drafts = updateExternalSessionDrafts(drafts, 'session-b', 'another draft');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'unsent guidance');
  assert.equal(externalSessionDraftFor(drafts, 'session-b'), 'another draft');

  drafts = updateExternalSessionDrafts(drafts, 'session-a', '');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), '');
  assert.equal(externalSessionDraftFor(drafts, 'session-b'), 'another draft');
});

test('a send completion clears only the exact draft revision it submitted', () => {
  let drafts: ExternalSessionDrafts = new Map();
  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'message A');
  const sentRevision = externalSessionDraftRevisionFor(drafts, 'session-a');

  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'message B');
  const newerRevision = externalSessionDraftRevisionFor(drafts, 'session-a');
  drafts = clearExternalSessionDraftIfCurrent(drafts, 'session-a', sentRevision);
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'message B');
  assert.equal(externalSessionDraftRevisionFor(drafts, 'session-a'), newerRevision);

  drafts = updateExternalSessionDrafts(drafts, 'session-a', '');
  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'message A');
  const reenteredRevision = externalSessionDraftRevisionFor(drafts, 'session-a');
  assert.notEqual(reenteredRevision, sentRevision);
  drafts = clearExternalSessionDraftIfCurrent(drafts, 'session-a', sentRevision);
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'message A');

  drafts = clearExternalSessionDraftIfCurrent(drafts, 'session-a', reenteredRevision);
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), '');
  assert.equal(externalSessionDraftRevisionFor(drafts, 'session-a'), reenteredRevision + 1);
});
