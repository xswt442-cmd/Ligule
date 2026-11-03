// 外控授权草稿：默认值、逐项校验、阶段可继续条件与 create 请求映射。
import assert from 'node:assert/strict';
import {
  createGrantRequest,
  emptyGrantDraft,
  grantDraftFlags,
  grantReady,
  grantState,
  limitsReady,
  sameProjectPath,
  type GrantDraft,
} from '../../src/agent-control-draft.ts';

const draft: GrantDraft = emptyGrantDraft(Date.UTC(2026, 0, 1, 0, 0, 0));
assert.equal(draft.defaultPermissionProfile, 'read-only');
assert.equal(draft.maxPermissionProfile, 'read-only');
assert.equal(draft.maxNetwork, 'disabled');
assert.deepEqual(draft.allowedPolicies, ['ask']);
// 默认 24 小时后到期，格式可直接填进 datetime-local。
assert.ok(!Number.isNaN(Date.parse(draft.expiresAt)));

const base: GrantDraft = { ...draft, name: 'grant', confirmWorkspaceTrust: true };
const now = Date.UTC(2026, 0, 1, 0, 0, 0);
assert.equal(grantReady(base, '/project', now), true, '只读且已确认信任时可创建');
assert.equal(grantReady(base, '', now), false, '没有项目不能创建');
assert.equal(grantReady({ ...base, name: '  ' }, '/project', now), false, '没有名称不能创建');
assert.equal(grantReady({ ...base, expiresAt: 'not-a-date' }, '/project', now), false, '到期时间无效不能创建');
assert.equal(grantReady({ ...base, confirmWorkspaceTrust: false }, '/project', now), false, '未确认工作区信任不能创建');
assert.equal(grantReady({ ...base, expiresAt: '2025-12-31T23:59:59.999Z' }, '/project', now), false, '已过期的授权不能创建');
assert.equal(grantReady({ ...base, expiresAt: '2026-01-01T00:00:00.000Z' }, '/project', now), false, '当前时间到期的授权不能创建');
assert.equal(grantReady({ ...base, expiresAt: '2026-01-01T00:00:00.001Z' }, '/project', now), true, '未来到期的授权可以创建');

// 上限低于默认值属于本步错误，且即使其它确认齐全也不能继续。
const exceeds: GrantDraft = { ...base, defaultPermissionProfile: 'full-access', defaultNetwork: 'unrestricted' };
const flags = grantDraftFlags(exceeds);
assert.equal(flags.profileExceeds, true);
assert.equal(flags.networkExceeds, true);
assert.equal(limitsReady(exceeds), false);

// 提升上限时要求逐项风险确认。
const widened: GrantDraft = { ...base, maxPermissionProfile: 'full-access', maxNetwork: 'unrestricted', defaultNetwork: 'policy' };
assert.equal(limitsReady(widened), false);
assert.equal(limitsReady({ ...widened, confirmFullAccess: true, confirmUnrestrictedNetwork: true }), false, '完整访问还要接受部分隔离限制');
assert.equal(limitsReady({ ...widened, confirmFullAccess: true, confirmUnrestrictedNetwork: true, confirmPartialWorkspaceWrite: true }), true);
assert.equal(limitsReady({ ...widened, confirmFullAccess: true, confirmUnrestrictedNetwork: true, confirmPartialWorkspaceWrite: false }), false,
  '工作区写入需要接受部分隔离限制');

// Policy 默认值必须留在允许列表里。
assert.equal(grantDraftFlags({ ...base, defaultPolicy: 'auto' }).policyMissing, true);
assert.equal(limitsReady({ ...base, defaultPolicy: 'auto' }), false);
assert.equal(limitsReady({ ...base, allowedPolicies: ['ask', 'auto'], defaultPolicy: 'auto' }), true);

// 截图授权要求单独确认。
assert.equal(limitsReady({ ...base, allowScreenCapture: true }), false);
assert.equal(limitsReady({ ...base, allowScreenCapture: true, confirmScreenCapture: true }), true);

// MCP 工具必须属于允许启动的 Server。
assert.equal(grantDraftFlags({ ...base, allowedMcpTools: ['mcp:notes/read'] }).mcpLimitInvalid, true);
assert.equal(grantDraftFlags({ ...base, allowedMcpServers: ['notes'], allowedMcpTools: ['mcp:notes/read'] }).mcpLimitInvalid, false);

const request = createGrantRequest(
  { ...base, allowedMcpServers: ['notes'], allowedMcpTools: ['mcp:notes/read'], allowOperator: true, allowedPolicies: ['ask', 'auto'] },
  '/project',
  'v7',
);
assert.equal(request.version, 'v7');
assert.equal(request.grantName, 'grant');
assert.equal(request.projectRoot, '/project');
assert.equal(request.allowedPolicyAlways, false);
assert.equal(request.allowedPolicyAsk, true);
assert.equal(request.allowedPolicyAuto, true);
assert.equal(request.allowedPolicyNever, false);
assert.equal(request.allowOperator, true);
assert.deepEqual(request.allowedMcpTools, ['mcp:notes/read']);
assert.ok(typeof request.expiresAt === 'string' && (request.expiresAt as string).includes('T'));

// 撤销与到期优先于可用，路径比较忽略结尾分隔符。
const t = (chinese: string) => chinese;
assert.equal(grantState({ revokedAt: 'x', expiresAt: null } as never, t), '已撤销');
assert.equal(grantState({ revokedAt: null, expiresAt: '2000-01-01T00:00:00.000Z' } as never, t), '已到期');
assert.equal(grantState({ revokedAt: null, expiresAt: null } as never, t), '可用');
assert.equal(sameProjectPath('E:\\codes\\project\\', 'E:\\codes\\project'), true);
assert.equal(sameProjectPath('/project/one', '/project/two'), false);
