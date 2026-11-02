// 外控 Composer 可卸载重挂；未发送指导草稿必须由 Session 身份持有。
import assert from 'node:assert/strict';
import test from 'node:test';
import { externalSessionDraftFor, updateExternalSessionDrafts, type ExternalSessionDrafts } from '../../src/external-session-drafts.ts';

test('external guidance drafts survive composer remounts and remain isolated by session', () => {
  let drafts: ExternalSessionDrafts = new Map<string, string>();
  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'unsent guidance');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'unsent guidance');

  drafts = updateExternalSessionDrafts(drafts, 'session-b', 'another draft');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'unsent guidance');
  assert.equal(externalSessionDraftFor(drafts, 'session-b'), 'another draft');

  drafts = updateExternalSessionDrafts(drafts, 'session-a', '');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), '');
  assert.equal(externalSessionDraftFor(drafts, 'session-b'), 'another draft');
});
