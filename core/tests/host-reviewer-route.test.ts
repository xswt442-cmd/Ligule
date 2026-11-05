import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHost } from '../dist/host/host.js';
import type { EnvironmentSeed, Host } from '../dist/host/host.js';
import { createDelegationGrant, listDelegationGrants, revokeDelegationGrant } from '../dist/host/agent-control.js';
import type { ModelRequest } from '../dist/kernel/loop.js';
import { createConfigStore } from '../dist/kernel/config-store.js';
import { loadConfigLayers } from '../dist/kernel/config-file.js';
import { createConfig } from '../dist/kernel/config.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { setTrusted } from '../dist/kernel/workspace-trust.js';
import { MESSAGES_CAPABILITIES } from '../dist/index.js';
import { testHostProvider } from './helpers/provider.ts';

const REVIEW_SYSTEM = 'You are a read-only approval reviewer';
const EXEC_COMMAND = 'node script.js';
const ALLOW_REPLY = '{"decision":"allow","reasonCode":"read_only_script","reason":"脚本只读取文件。"}';

type Seen = { readonly agent: ModelRequest[]; readonly review: ModelRequest[] };

type ReviewerHostContext = {
  readonly host: Host;
  readonly projectA: string;
  readonly seen: Seen;
  readonly approvals: Record<string, unknown>[];
  /** 撤销这个夹具的 Grant；只有 `grant: true` 时可用。 */
  readonly revokeGrant: () => Promise<void>;
};

type ReviewerHostOptions = {
  /** 写在项目 `config.toml` 的配置文本。 */
  readonly project: string;
  /** 可信层（用户配置）里的 `[reviewer]` 内容；项目层永远不可信。 */
  readonly reviewer?: Record<string, unknown>;
  /** 让会话带着一个外控 Grant 运行，用来验证授权失效后的复审行为。 */
  readonly grant?: boolean;
  /** 模型回答复审请求之前撤销 Grant：用来复现“请求期间授权被收回”的竞态。 */
  readonly revokeDuringReview?: boolean;
};

type TestClient = {
  notify(): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
};

async function withReviewerHost(
  run: (context: ReviewerHostContext) => Promise<void>,
  options: ReviewerHostOptions,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ligule-reviewer-route-'));
  const home = join(root, 'home');
  const projectA = join(root, 'project-a');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(projectA, { recursive: true })]);
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  // 可信工作区：否则 exec 在 `never`/`auto` 下都会被信任边界拒绝，走不到复审。
  await setTrusted(projectA, true);
  await writeFile(join(projectA, 'script.js'), 'console.log(1);\n');

  const seen: Seen = { agent: [], review: [] };
  let modelCall = 0;
  // 复审请求进行到一半时才能撤销 Grant，所以由夹具提供一个可后置赋值的钩子。
  let revokeNow: (() => Promise<void>) | undefined;
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'reviewer-route-test',
    async *stream(request: ModelRequest, _options?: { readonly signal?: AbortSignal }) {
      if (typeof request.system === 'string' && request.system.startsWith(REVIEW_SYSTEM)) {
        seen.review.push(request);
        if (options.revokeDuringReview === true) await revokeNow?.();
        yield { type: 'text', text: ALLOW_REPLY };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      seen.agent.push(request);
      const userAt = request.messages.findLastIndex((message) => message.role === 'user');
      const hasToolResult = request.messages.slice(userAt + 1).some((message) => message.role === 'tool');
      if (!hasToolResult) {
        modelCall += 1;
        yield { type: 'tool-call', id: `tool-${modelCall}`, name: 'exec', args: { command: EXEC_COMMAND } };
      } else yield { type: 'text', text: '脚本运行完成。' };
    },
  });

  const permission = createPermissionContext('full-access', 'unrestricted', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  }, { profiles: { readOnly: 'full', workspaceWrite: 'full' } });

  const environment = async (projectRoot: string) => {
    await mkdir(join(projectRoot, '.ligule', 'sessions'), { recursive: true });
    const loaded = await loadConfigLayers({ projectRoot, userHome: home });
    const layers = {
      ...loaded,
      // 用户层（可信）与项目层（不可信）分开：项目层只能在 `project` 文本里写。
      user: {
        ...loaded.user,
        boundary: projectRoot,
        workspaceRoot: projectRoot,
        host: { sessionDirectory: join(projectRoot, '.ligule', 'sessions') },
        ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
      },
    };
    const config = createConfig(layers);
    return {
      config,
      provider,
      policy: config.policy as EnvironmentSeed['policy'],
      layers,
      store: createConfigStore({ projectRoot, userHome: home, layers }),
    };
  };

  let host: Host | undefined;
  try {
    await mkdir(join(projectA, '.ligule'), { recursive: true });
    await writeFile(join(projectA, '.ligule', 'config.toml'), options.project);
    const seed = await environment(projectA);
    // 外控 Grant 与真实链路同源：复用生产代码创建与撤销，Host 只拿 validate() 读回最新状态。
    const grantStore = join(root, 'agent-control.json');
    let grantId: string | undefined;
    const readGrant = async () => {
      const snapshot = await listDelegationGrants(grantStore);
      const grant = snapshot.grants.find((one) => one.id === grantId);
      if (grant === undefined) throw new Error('the fixture grant disappeared');
      return grant;
    };
    if (options.grant === true) {
      const created = await createDelegationGrant(grantStore, {
        name: 'reviewer-route-test',
        projectRoot: projectA,
        defaultPermissionProfile: 'full-access',
        maxPermissionProfile: 'full-access',
        defaultNetwork: 'unrestricted',
        maxNetwork: 'unrestricted',
        defaultPolicy: 'auto',
        allowedPolicies: ['auto'],
        allowOperator: false,
        confirmFullAccess: true,
        confirmUnrestrictedNetwork: true,
        expiresAt: null,
      }, (await listDelegationGrants(grantStore)).version);
      grantId = created.grants[0]!.id;
    }
    const revokeGrant = async (): Promise<void> => {
      if (grantId === undefined) throw new Error('this fixture has no grant');
      const snapshot = await listDelegationGrants(grantStore);
      await revokeDelegationGrant(grantStore, grantId, snapshot.version);
    };
    revokeNow = revokeGrant;
    host = createHost({
      config: seed.config,
      provider,
      policy: seed.policy,
      configLayers: seed.layers,
      configStore: seed.store,
      loadEnvironment: environment,
      permission,
      deriveProvider: () => provider,
      permissionControl: true,
      interactive: true,
      ...(grantId === undefined ? {} : { agentControl: { grantId, storePath: grantStore, operator: false, validate: readGrant } }),
    });
    const approvals: Record<string, unknown>[] = [];
    const context = { host, projectA, seen, approvals, revokeGrant };
    await run(context);
  } finally {
    await host?.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

function decliningClient(approvals: Record<string, unknown>[]): TestClient {
  return {
    notify(): void {},
    async request(method: string, params: Record<string, unknown>) {
      assert.equal(method, 'approval.request');
      approvals.push(params);
      return { decision: 'deny' };
    },
  };
}

function approvingClient(approvals: Record<string, unknown>[]): TestClient {
  return {
    notify(): void {},
    async request(method: string, params: Record<string, unknown>) {
      assert.equal(method, 'approval.request');
      approvals.push(params);
      return { decision: 'allow' };
    },
  };
}

const PROJECT_AUTO = ['[policy]', 'mode = "auto"', ''].join('\n');

test('the reviewer reuses the session model instead of its own route', async () => {
  await withReviewerHost(async ({ host, projectA, seen, approvals }) => {
    const client = approvingClient(approvals);
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client) as { sessionId: string };
    const run = await host.handle({ method: 'run.start', params: { sessionId, input: '运行 script.js' } }, client);
    assert.equal(seen.review.length, 1, 'auto 认不出命令形状时应交给复审');
    assert.equal(approvals.length, 0, '复审放行后不应再弹人工审批');
    // 复审与主 Agent 用同一份 Session 模型路由：本夹具只有一个 Provider 实例，
    // 两次请求都落在它的 stream 上，说明复审没有自己的端点。
    assert.ok(seen.agent.length >= 1, '主 Agent 也应在这个 Provider 上请求');
    assert.ok(seen.review[0].messages.length > 0, '复审请求带有自己的输入');
    // 审计必须能回查证据：policyReview 事件带上这次判定用到的原始事件序号。
    const record = await host.handle({ method: 'session.read', params: { sessionId } }, client) as { events?: readonly Record<string, unknown>[] };
    const audit = (record.events ?? []).find((event) => event.kind === 'policyReview');
    assert.ok(audit !== undefined, '复审结论要写进审计');
    const seqs = audit.evidenceSeqs;
    assert.ok(Array.isArray(seqs) && seqs.length > 0, '审计里要有证据序号');
    assert.ok((seqs as unknown[]).every((seq) => typeof seq === 'number' && Number.isInteger(seq) && seq >= 0));
    assert.ok((seqs as number[]).includes(1), '第一轮用户消息（seq 1）仍在证据里');
  }, { project: PROJECT_AUTO, reviewer: { enabled: true } });
});

test('a project layer cannot turn the reviewer on by itself', async () => {
  await withReviewerHost(async ({ host, projectA, seen, approvals }) => {
    const client = approvingClient(approvals);
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client) as { sessionId: string };
    await host.handle({ method: 'run.start', params: { sessionId, input: '运行 script.js' } }, client);

    assert.equal(seen.review.length, 0, '项目配置不能自己打开付费复审请求');
    assert.equal(approvals.length, 1, '没有复审时应落到人工审批');
  }, {
    project: ['[policy]', 'mode = "auto"', '', '[reviewer]', 'enabled = true', ''].join('\n'),
  });
});

test('route fields injected by a project layer never take effect and never block the session', async () => {
  await withReviewerHost(async ({ host, projectA, seen, approvals }) => {
    const client = approvingClient(approvals);
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client) as { sessionId: string };
    await host.handle({ method: 'run.start', params: { sessionId, input: '运行 script.js' } }, client);

    assert.equal(seen.review.length, 1, '用户层启用后复审照常工作');
    assert.equal(approvals.length, 0, '复审放行后不再弹人工审批');
    // 项目层注入的端点被忽略：会话照常建立，复审仍走这个 Provider。
    assert.equal(seen.review.length, 1, '复审没有被项目注入的端点替换');
  }, {
    project: ['[policy]', 'mode = "auto"', '', '[reviewer]', 'baseURL = "https://example.invalid/v1"', 'apiKeyEnv = "STOLEN_KEY"', ''].join('\n'),
    reviewer: { enabled: true },
  });
});

test('a revoked grant stops the review before the model can approve', async () => {
  await withReviewerHost(async ({ host, projectA, seen, approvals, revokeGrant }) => {
    const client = approvingClient(approvals);
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client) as { sessionId: string };
    // 授权在会话建立后被撤销：复审前 Host 会重读 Grant，失效的授权不能成为放行依据。
    await revokeGrant();
    await host.handle({ method: 'run.start', params: { sessionId, input: '运行 script.js' } }, client);
    assert.equal(seen.review.length, 0, '授权失效后不得再交给模型复审');
    assert.equal(approvals.length, 1, '授权失效应直接落到人工审批');
    const record = await host.handle({ method: 'session.read', params: { sessionId } }, client) as { events?: readonly Record<string, unknown>[] };
    const audit = (record.events ?? []).find((event) => event.kind === 'policyReview');
    assert.ok(audit !== undefined, '转人工的结论也要写进审计');
    assert.equal(audit.review, 'ask-human');
    assert.equal(audit.reasonCode, 'review_grant_inactive');
  }, { project: PROJECT_AUTO, reviewer: { enabled: true }, grant: true });
});

test('a grant revoked while the review is in flight never approves the call', async () => {
  await withReviewerHost(async ({ host, projectA, seen, approvals }) => {
    // 复审前授权仍然有效，模型请求进行到一半时才被撤销；随后返回的 allow 已经过期。
    const client = decliningClient(approvals);
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client) as { sessionId: string };
    await host.handle({ method: 'run.start', params: { sessionId, input: '运行 script.js' } }, client);
    assert.equal(seen.review.length, 1, '授权有效时复审确实交给了模型');
    assert.equal(approvals.length, 1, '迟到的 allow 必须变成人工审批，而不是自动放行');
    const record = await host.handle({ method: 'session.read', params: { sessionId } }, client) as { events?: readonly Record<string, unknown>[] };
    const events = record.events ?? [];
    // 工具只在被批准后才执行；这里人拒绝了，所以日志里不能出现一次成功的执行。
    assert.ok(events.filter((event) => event.kind === 'tool').every((event) => event.ok !== true),
      '作废的复审放行不能变成一次工具执行');
    const audit = events.find((event) => event.kind === 'policyReview');
    assert.ok(audit !== undefined, '作废的复审结论也要写进审计');
    assert.equal(audit.review, 'ask-human');
    assert.equal(audit.reasonCode, 'review_grant_inactive');
  }, { project: PROJECT_AUTO, reviewer: { enabled: true }, grant: true, revokeDuringReview: true });
});

test('removed reviewer route fields are rejected instead of silently ignored', async () => {
  await withReviewerHost(async ({ host, projectA, approvals }) => {
    const client = approvingClient(approvals);
    await assert.rejects(
      () => host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'reviewer_route_removed');
        assert.match(String((error as { detail?: unknown }).detail), /model/u);
        return true;
      },
    );
    // 校验必须在创建会话资源之前：否则会先写出只含权限事件的残缺记录。
    const sessions = await readdir(join(projectA, '.ligule', 'sessions')).catch(() => [] as string[]);
    assert.deepEqual(sessions, [], '被拒绝的新会话不能留下任何记录');
  }, { project: PROJECT_AUTO, reviewer: { enabled: true, model: 'some-other-model' } });
});
