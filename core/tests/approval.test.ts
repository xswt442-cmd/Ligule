import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalArgsDigest, containsSensitiveMaterial, sha256, summarizeApproval } from '../dist/host/approval.js';

test('approval summaries keep large content private while reporting its actual byte count and digest', () => {
  for (const length of [20_000, 100_000]) {
    const content = '汉字🙂'.repeat(length / 3);
    const summary = summarizeApproval({
      requestId: 'request-1', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
      tool: 'create', args: { path: 'app.js', content },
    });

    assert.equal(summary.contentBytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(summary.contentSha256, sha256(Buffer.from(content, 'utf8')));
    assert.equal(summary.args.path, 'app.js');
    assert.ok(String(summary.args.content).length < content.length);
    assert.equal(JSON.stringify(summary).includes(content), false);
    assert.equal(summary.detailsRef, summary.requestId);
    assert.equal(summary.callId, 'call-1');
    assert.deepEqual(summary.rememberTargetOptions, ['file', 'workspace']);
  }
});

test('approval summaries bind every argument and do not expose sensitive values', () => {
  const first = summarizeApproval({ requestId: 'r1', sessionId: 's1', tool: 'edit', args: { path: 'a.ts', anchor: 'old', replacement: 'new' } });
  const second = summarizeApproval({ requestId: 'r2', sessionId: 's1', tool: 'edit', args: { path: 'a.ts', anchor: 'old', replacement: 'other' } });
  assert.notEqual(first.argumentSha256, second.argumentSha256);
  assert.throws(() => summarizeApproval({ requestId: 'r3', sessionId: 's1', tool: 'write', args: { path: 'a.ts', content: 'api_key=secret-value' } }), { code: 'control_interaction_sensitive' });
  assert.equal(containsSensitiveMaterial({ content: 'ordinary readable text' }), false);
  assert.equal(containsSensitiveMaterial({ authorization: 'Bearer secret' }), true);
});

test('multi-edit approval previews the requested changes and binds the complete original arguments', () => {
  const args = {
    path: 'src/example.ts',
    changes: [
      { oldText: 'const before = 1;', newText: 'const before = 2;' },
      { oldText: 'return false;', newText: 'return true;' },
    ],
  };
  const summary = summarizeApproval({ requestId: 'r4', sessionId: 's1', tool: 'edit', args });

  assert.equal(summary.argumentSha256, approvalArgsDigest(args));
  assert.equal(summary.args.path, args.path);
  assert.match(summary.preview, /- const before = 1;/u);
  assert.match(summary.preview, /\+ return true;/u);
  assert.deepEqual(summary.rememberTargetOptions, ['file', 'workspace']);
});
