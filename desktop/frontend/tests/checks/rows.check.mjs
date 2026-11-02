// 检查 Host 事件如何转换为桌面端转录行和状态提示。
import assert from 'node:assert/strict';
import { capabilityOf, callRowFoldLabel, changeBody, changeOf, metaRow, projectRecord, questionEcho, shownIn } from '../../src/rows.ts';

const call = projectRecord({
  kind: 'assistant',
  text: '',
  toolCalls: [{ id: 'c1', name: 'mcp.call', args: { server: 'demo', tool: 'lookup', input: { key: 'x' } } }],
})[0];
assert.equal(call.tool, 'mcp:demo/lookup');
assert.equal(call.summary, '{"input":{"key":"x"}}');
assert.match(call.text, /"server": "demo"/);
assert.equal(callRowFoldLabel(call.text, (_chinese, english) => english), 'View arguments');
assert.equal(callRowFoldLabel(call.text, (chinese) => chinese), '看参数');

const questionCall = projectRecord({
  kind: 'assistant',
  toolCalls: [{ id: 'q1', name: 'ask_user_question', args: { questions: [
    { header: '验收方式', question: '逐项检查还是整体检查？', options: [{ label: '逐项检查' }] },
    { question: '命名形式' },
  ] } }],
})[0];
assert.equal(questionCall.summary, '验收方式 · 命名形式');
assert.match(questionCall.text, /逐项检查还是整体检查/);
assert.match(questionCall.text, /"options"/);

const encodedQuestions = JSON.stringify([
  { header: '验收方式', question: '逐项检查还是整体检查？', options: [{ label: '逐项检查' }] },
  { question: '命名形式' },
]);
const encodedQuestionCall = projectRecord({
  kind: 'assistant',
  toolCalls: [{ id: 'q2', name: 'ask_user_question', args: { questions: encodedQuestions } }],
})[0];
assert.equal(encodedQuestionCall.summary, '验收方式 · 命名形式');
assert.deepEqual(JSON.parse(encodedQuestionCall.text), { questions: encodedQuestions });
for (const questions of ['[invalid', 'null', '{}']) {
  const invalidCall = projectRecord({
    kind: 'assistant',
    toolCalls: [{ id: 'invalid-question', name: 'ask_user_question', args: { questions } }],
  })[0];
  assert.equal(invalidCall.summary, '');
  assert.deepEqual(JSON.parse(invalidCall.text), { questions });
}

assert.equal(capabilityOf('exec', { command: 'git status' }), 'exec');
for (const status of ['completed', 'cancelled', 'failed', 'interrupted']) {
  const row = projectRecord({ seq: 42, kind: 'turn', status, code: status === 'failed' ? 'provider_http_error' : undefined })[0];
  assert.equal(row.kind, 'round');
  assert.equal(row.status, status);
  assert.equal(row.seq, 42);
}

const write = projectRecord({
  kind: 'tool',
  tool: 'write',
  callId: 'c2',
  args: { path: 'notes/readings.md', content: '# 读数\n\n窗口 200000\n' },
  verdict: { decision: 'allow', via: 'auto', capability: 'write', level: 'auto' },
  result: { content: { text: '写了 3 行' } },
})[0];
assert.equal(write.kind, 'result');
assert.equal(write.summary, 'notes/readings.md：写入 4 行');
assert.equal(write.english.summary, 'notes/readings.md: write 4 lines');
assert.deepEqual(write.english.notes, ['Allowed automatically (auto)']);
assert.deepEqual(write.diff, { removed: 0, added: 4 });
// 写入审批只显示待写入内容；编辑审批同时显示匹配内容和替换内容。
const writeChange = changeOf('write', { path: 'notes/readings.md', content: 'a\nb' });
assert.match(changeBody(writeChange, { content: 'a\nb' }), /^写入完整文件/);
assert.ok(!changeBody(writeChange, { content: 'a\nb' }).includes('原内容:'), '没读过的原文不编造');
assert.equal(
  changeBody(changeOf('edit', { path: 'x.md', anchor: '旧的一行', replacement: '新的一行' }), {}),
  'x.md：替换匹配内容\n原内容:\n- 旧的一行\n新内容:\n+ 新的一行',
);
assert.equal(changeBody(changeOf('delete', { path: 'x.md' }), {}), '若系统回收站不可用或拒绝目标，操作会报错并保留原文件');
assert.deepEqual(write.notes, ['自动允许 (auto)']);
assert.equal(write.text, '写了 3 行');

const edit = projectRecord({
  kind: 'tool',
  tool: 'edit',
  callId: 'c7',
  args: { path: 'notes/readings.md', anchor: '旧的一行\n第二行', replacement: '新的一句话\n第二行\n第三行' },
  result: { content: { text: '换好了' } },
})[0];
assert.equal(edit.summary, 'notes/readings.md：替换 2 行，写入 3 行');
assert.deepEqual(edit.diff, { removed: 2, added: 3 });

const failure = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c3',
  args: { command: 'node -e 1' },
  verdict: { decision: 'allow', via: 'ask', capability: 'exec', level: 'ask', rule: '命令逐次询问' },
  result: { failed: true, code: 'exec_exit_1', content: { text: '命令没找到', exitCode: 1 }, spilled: 'result-3-1a2b3c4d.json' },
}, { startedAt: Date.now() - 2500 })[0];
assert.equal(failure.kind, 'failure');
assert.equal(failure.code, 'exec_exit_1');
assert.equal(failure.text, '命令没找到');
assert.equal(failure.notes.length, 4);
assert.deepEqual(failure.notes.slice(0, 3), ['退出码 1', '完整结果：result-3-1a2b3c4d.json', '审批通过 (ask) · 规则：命令逐次询问']);
assert.match(failure.notes[3], /^用时 2\.\d 秒$/);

// 工具耗时来自会话记录，因此重新打开会话后仍可显示。
const recorded = projectRecord({
  kind: 'tool', tool: 'exec', callId: 'c5', args: { command: 'npm test' }, durationMs: 640,
  result: { failed: false, content: { text: 'ok' } },
}, { startedAt: Date.now() - 2500 })[0];
assert.deepEqual(recorded.notes, ['用时 0.6 秒']);

const refusal = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c4',
  args: { command: 'rm -rf .' },
  verdict: { decision: 'deny', via: 'ask', capability: 'exec', level: 'auto', forced: true },
  result: { failed: true, kind: 'refusal', code: 'policy_denied', reason: '这一条没被允许。' },
})[0];
assert.equal(refusal.kind, 'refusal');
assert.equal(refusal.text, '这一条没被允许。');
assert.deepEqual(refusal.notes, ['已拒绝 (auto→ask)']);

const noneRefusal = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c4b',
  args: { command: 'rm -rf .' },
  verdict: { decision: 'deny', via: 'ask', capability: 'exec', level: 'none', forced: true },
  result: { failed: true, kind: 'refusal', code: 'policy_denied', reason: '这一条没被允许。' },
})[0];
// 不提示档本来就不问，连续拒绝也不该被写成档位变化。
assert.deepEqual(noneRefusal.notes, ['已拒绝 (none)']);

const hardRefusal = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c4c',
  args: { command: 'rm -rf .' },
  verdict: { decision: 'deny', via: 'hard-deny', capability: 'exec', level: 'auto', forced: true },
  result: { failed: true, kind: 'refusal', code: 'policy_hard_denied', reason: '这一条被策略直接拒绝。' },
})[0];
assert.deepEqual(hardRefusal.notes, ['已拒绝 (auto)']);
assert.deepEqual(hardRefusal.english.notes, ['Denied (auto)']);

const repaired = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c5',
  args: { command: 'git status --short' },
  recovery: { assistantSeq: 14, safeToRedo: false },
  result: { failed: true, code: 'tool_outcome_unknown', content: { text: '那一次派发没留下结果。' } },
})[0];
assert.equal(repaired.code, 'tool_outcome_unknown');
assert.deepEqual(repaired.notes, ['中断恢复 · 外部操作结果未知']);

// 没有参数的那一次调用不该在正文里留一个空对象；读不认识的种类不产行。
assert.equal(projectRecord({ kind: 'assistant', text: '', toolCalls: [{ id: 'c6', name: 'skill' }] })[0].text, '');
assert.deepEqual(projectRecord({ kind: 'usage', input: 1 }), []);

// 转录行保留来源事件序号，供搜索结果定位到对应记录。
const stamped = projectRecord({ seq: 12, kind: 'assistant', text: '两句', toolCalls: [{ id: 'c9', name: 'read', args: {} }] });
assert.deepEqual(stamped.map((row) => row.seq), [12, 12], '一条记录出来的每一行都认得自己是哪一条事件');
assert.equal(metaRow('meta', '界面自己写的一行').seq, undefined, '界面自己写的那几行没有序号可对');
assert.equal(metaRow('meta', '界面自己写的一行', 'A system notice').english.text, 'A system notice', '系统行保留可切换的英文文本');

// 展示级别决定哪些转录行进入虚拟列表。
const answered = projectRecord({ kind: 'assistant', text: '一句' })[0];
const reasoned = projectRecord({ kind: 'reasoning', text: '一段' })[0];
const resulted = projectRecord({ kind: 'tool', tool: 'read', callId: 'c7', args: {}, result: { content: { text: 'x' } } })[0];
const imageReference = { kind: 'image', version: 1, id: '123e4567-e89b-42d3-a456-426614174000', workspace: 'workspace', sessionId: 'session', source: 'desktop', mimeType: 'image/png', bytes: 32, width: 8, height: 4, sha256: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' };
const imageResult = projectRecord({ kind: 'tool', tool: 'screenshot', callId: 'c8', args: {}, result: { failed: false, content: { text: 'Captured' }, images: [imageReference] } })[0];
assert.deepEqual(imageResult.images, [imageReference], '成功工具结果的持久图片引用保留在对应结果行');
assert.equal(projectRecord({ kind: 'tool', tool: 'screenshot', args: {}, result: { failed: true, images: [imageReference] } })[0].images, undefined, '失败结果不提供图片预览');
assert.ok(shownIn('detailed', reasoned) && shownIn('detailed', resulted), '全量档什么都画');
assert.ok(shownIn('standard', resulted) && !shownIn('standard', reasoned), '标准档藏推理段');
assert.ok(shownIn('brief', answered) && !shownIn('brief', reasoned) && !shownIn('brief', resulted), '简略档只留问答');

// 仅在会话记录包含回合参数事件时生成参数摘要行。
const ctx = projectRecord({ seq: 3, kind: 'turnContext', model: 'gpt-x', mode: 'full', policy: 'auto', policySource: 'session' })[0];
assert.equal(ctx.kind, 'context');
assert.equal(ctx.text, '本轮参数：gpt-x · full · auto');
assert.equal(ctx.english.text, 'Turn settings: gpt-x · full · auto');
assert.ok(!shownIn('standard', ctx) && !shownIn('brief', ctx));
assert.ok(shownIn('detailed', ctx) && shownIn('full', ctx));
assert.equal(projectRecord({ seq: 4, kind: 'turnContext', policy: 'ask', policySource: 'config' })[0].text, '本轮参数：ask', '缺少的参数不编造');
assert.equal(projectRecord({ kind: 'turnContext', model: null })[0], undefined);
assert.equal(projectRecord({ seq: 5, kind: 'turnContext' })[0], undefined, '几个读数都没有时这一行整个不画');
// 会话状态摘要应保留参数值及其来源。
// 提问卡关闭后，转录应记录题目和用户已填写的答案；未回答的题目应明确标记。
const echoAsk = { questions: [{ id: 'q1', question: '用哪一种格式' }, { id: 'q2', question: '要不要带表头' }] };
assert.equal(
  questionEcho(echoAsk, { q1: { picked: ['CSV'], extra: ' 压缩一份 ' }, q2: { picked: [], extra: '' } }),
  '第 1 题「用哪一种格式」：CSV、压缩一份；第 2 题「要不要带表头」：没有作答',
);
assert.equal(questionEcho({ questions: [{ id: 'q1', question: '一个问题' }] }), '第 1 题「一个问题」：没有作答', '一格草稿都没有时不谎称答过');
assert.equal(questionEcho({ questions: [{ id: 'q1', question: 'Which format?' }] }, {}, 'en'), 'Question 1: “Which format?” — No answer entered', '英语提示翻译标签并保留题面原文');
console.log('桌面前端的投影检查通过');
