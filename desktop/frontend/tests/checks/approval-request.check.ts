// 审批请求适配：会话归属、摘要选择、脚本绑定与记忆范围都要原样到达审批卡。
import assert from 'node:assert/strict';
import { approvalSession, toApprovalAsk } from '../../src/approval-request.ts';

assert.equal(approvalSession({ sessionId: 'abc' }), 'abc');
assert.equal(approvalSession({ sessionId: '' }), null);
assert.equal(approvalSession(undefined), null);

const command = toApprovalAsk('req-1', {
  sessionId: 'abc',
  projectRoot: '/project',
  tool: 'exec',
  command: 'npm test',
  args: { command: 'npm test' },
  reason: 'runs tests',
  shell: 'powershell',
  executable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  policy: 'ask',
  policySource: 'config',
  rememberable: true,
  rememberScopes: ['session', 'project'],
  rememberHintKey: 'command',
  rememberTargetOptions: ['command', 'workspace'],
});
assert.equal(command.id, 'req-1');
assert.equal(command.detail, 'npm test');
assert.equal(command.backend, 'powershell · C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
assert.equal(command.policyForced, false);
assert.equal(command.rememberable, true);
assert.deepEqual(command.rememberScopes, ['session', 'project']);
assert.deepEqual(command.rememberTargetOptions, ['command', 'workspace']);
assert.equal(command.detailsLoaded, false);
assert.match(command.content, /npm test/u);

// 没有 command/path/url 时回退到能力摘要，避免审批卡出现空描述。
const capability = toApprovalAsk('req-2', {
  sessionId: 'abc',
  tool: 'fetch',
  args: { url: 'https://example.com/a' },
});
assert.equal(capability.detail, 'https://example.com/a');

// 脚本审批必须带上路径、解释器、工作区与权限绑定。
const script = toApprovalAsk('req-3', {
  sessionId: 'abc',
  tool: 'exec',
  command: 'node build.mjs',
  args: { command: 'node build.mjs' },
  scriptBinding: {
    path: '/project/build.mjs',
    sha256: 'abc123',
    interpreter: 'node',
    workspaceRoot: '/project',
    permission: { profile: 'workspace-write', network: 'disabled', capabilities: { write: 'workspace-write' } },
  },
});
assert.match(script.detailsSuffix?.chinese ?? '', /脚本审批绑定/u);
assert.match(script.detailsSuffix?.chinese ?? '', /\/project\/build\.mjs/u);
assert.match(script.content, /SHA-256: abc123/u);
assert.match(script.detailsSuffix?.english ?? '', /Script approval binding/u);

// 内容型审批先给出字节数与摘要，再列变更正文。
const content = toApprovalAsk('req-4', {
  sessionId: 'abc',
  tool: 'write',
  args: { path: 'note.txt', content: 'hello' },
  contentBytes: 5,
  contentSha256: 'deadbeef',
  argumentBytes: 5,
  argumentSha256: 'deadbeef',
  identityDigest: 'id-1',
  detailsRef: 'details-1',
});
assert.match(content.content, /内容 5 字节 · SHA-256 deadbeef/u);
assert.equal(content.argumentBytes, 5);
assert.equal(content.argumentSha256, 'deadbeef');
assert.equal(content.identityDigest, 'id-1');
assert.equal(content.detailsRef, 'details-1');

// 英文正文与中文正文使用同一份参数，只是换语言。
assert.ok(typeof content.english?.content === 'string' && content.english.content.includes('Write the entire file'));
assert.match(content.english?.content ?? '', /Content 5 bytes · SHA-256 deadbeef/u);
assert.doesNotMatch(content.english?.content ?? '', /内容 5 字节/u);
assert.ok(content.english?.change.includes('note.txt'));

const multiEdit = toApprovalAsk('req-5', {
  sessionId: 'abc',
  tool: 'edit',
  args: { path: 'src/example.ts', changes: [
    { oldText: 'return false;', newText: 'return true;' },
    { oldText: 'const old = 1;', newText: 'const current = 2;' },
  ] },
});
assert.match(multiEdit.change, /替换 2 处/u);
assert.match(multiEdit.content, /- return false;/u);
assert.match(multiEdit.content, /\+ return true;/u);
assert.match(multiEdit.content, /- const old = 1;/u);
assert.match(multiEdit.english?.content ?? '', /\+ const current = 2;/u);
