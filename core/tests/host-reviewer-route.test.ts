import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHost } from '../dist/host/host.js';
import type { EnvironmentSeed, Host } from '../dist/host/host.js';
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
};

type ReviewerHostOptions = {
  /** 写在项目 `config.toml` 的配置文本。 */
  readonly project: string;
  /** 可信层（用户配置）里的 `[reviewer]` 内容；项目层永远不可信。 */
  readonly reviewer?: Record<string, unknown>;
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
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'reviewer-route-test',
    async *stream(request: ModelRequest, _options?: { readonly signal?: AbortSignal }) {
      if (typeof request.system === 'string' && request.system.startsWith(REVIEW_SYSTEM)) {
        seen.review.push(request);
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
    });
    const approvals: Record<string, unknown>[] = [];
    const context = { host, projectA, seen, approvals };
    await run(context);
  } finally {
    await host?.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
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
  }, { project: PROJECT_AUTO, reviewer: { enabled: true, model: 'some-other-model' } });
});
