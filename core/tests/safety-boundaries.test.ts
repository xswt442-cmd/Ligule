import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, createDecisionChain, createKernel, createPermissionContext, createSessionLog } from '../dist/index.js';
import { execTool } from '../dist/capability/exec.js';
import { setTrusted } from '../dist/kernel/workspace-trust.js';
import type { PermissionContext } from '../dist/kernel/permission.js';
import type { PolicyQuestion } from '../dist/kernel/policy.js';

// P9.5 W2：审批档位可以被跳过，执行前置校验不能。
// 每条用例都在 `never` 下真实执行（或真实失败），确认被跳过的是用户审批层，
// 而参数校验、工作区边界、工作区信任、脚本绑定、Permission 与硬拒绝仍然生效。
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
}, { workspaceTrusted: true });

const readOnly = createPermissionContext('read-only', 'policy', {
  filesystemRead: 'full', filesystemWrite: 'unavailable', network: 'full', process: 'unavailable',
}, { workspaceTrusted: true });

type Guard = (call: { tool: string; input: unknown; command?: string }) => string | undefined;

type Harness = {
  readonly root: string;
  readonly kernel: ReturnType<typeof createKernel>;
  readonly session: ReturnType<typeof createSessionLog>;
  readonly asked: PolicyQuestion[];
  readonly marker: string;
};

async function harness(
  t: { after(fn: () => Promise<void> | void): void },
  options: { readonly permission?: PermissionContext; readonly guard?: Guard; readonly trusted?: boolean } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ligule-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, options.trusted ?? true);
  const session = createSessionLog({ directory: root, id: 'safety' });
  const asked: PolicyQuestion[] = [];
  const chain = createDecisionChain({
    mode: 'never',
    ask: (question) => { asked.push(question); return true; },
  });
  if (options.guard !== undefined) chain.guard(options.guard);
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root, workspaceRoot: root } }),
    permission: options.permission ?? fullAccess,
    policy: chain,
    session,
  });
  kernel.register(execTool);
  return { root, kernel, session, asked, marker: join(root, 'marker') };
}

async function script(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, source);
  return path.split('\\').join('/');
}

function writing(marker: string, text: string): string {
  return `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, ${JSON.stringify(text)});\n`;
}

async function verdictOf(session: ReturnType<typeof createSessionLog>) {
  const event = (await session.read()).find((item) => item.kind === 'tool');
  return event?.verdict as Record<string, unknown> | undefined;
}

test('never executes a bound Node script without asking and records the skip', async (t) => {
  const { root, kernel, session, asked, marker } = await harness(t);
  const path = await script(root, 'run.js', writing(marker, 'ran'));
  const result = await kernel.call('exec', { command: `node "${path}"` });
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.equal(await readFile(marker, 'utf8'), 'ran');
  assert.deepEqual(asked, [], 'the skip tier must not ask about anything');
  const verdict = await verdictOf(session);
  assert.equal(verdict?.decision, 'allow');
  assert.equal(verdict?.via, 'never');
});

test('never runs a real Git command in a trusted workspace without asking', async (t) => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { t.skip('git is not available here'); return; }
  const { root, kernel, asked } = await harness(t);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const result = await kernel.call('exec', { command: 'git status --short' });
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.deepEqual(asked, []);
});

test('never still refuses malformed arguments before anything runs', async (t) => {
  const { kernel, marker } = await harness(t);
  await assert.rejects(kernel.call('exec', { command: 42 }), { code: 'tool_args_invalid' });
  assert.equal(existsSync(marker), false);
});

test('never still refuses a working directory outside the workspace boundary', async (t) => {
  const { kernel, root, asked, marker } = await harness(t);
  const path = await script(root, 'run.js', writing(marker, 'ran'));
  await assert.rejects(kernel.call('exec', { command: `node "${path}"`, cwd: '..' }), { code: 'path_escapes_boundary' });
  assert.equal(existsSync(marker), false);
  assert.deepEqual(asked, [], 'a boundary refusal is not an approval question');
});

test('never still refuses project code in an untrusted workspace', async (t) => {
  const { kernel, root, marker } = await harness(t, { trusted: false });
  const path = await script(root, 'run.js', writing(marker, 'ran'));
  await assert.rejects(kernel.call('exec', { command: `node "${path}"` }), { code: 'exec_workspace_untrusted' });
  assert.equal(existsSync(marker), false);
});

test('never still refuses a script whose content changed after the decision', async (t) => {
  let path = '';
  const { kernel, root, marker } = await harness(t, {
    guard: () => {
      // 判定已经看过旧内容，执行前再改一次，重绑定校验必须拦住它。
      if (path !== '') writeFileSync(path, `${writing(marker, 'ran')}// changed after the decision\n`);
      return undefined;
    },
  });
  path = await script(root, 'run.js', writing(marker, 'ran'));
  await assert.rejects(kernel.call('exec', { command: `node "${path}"` }), { code: 'exec_script_binding_changed' });
  assert.equal(existsSync(marker), false);
});

test('never still refuses a command a hard guard rejects', async (t) => {
  const { kernel, root, marker } = await harness(t, { guard: () => 'the guard forbids this command' });
  const path = await script(root, 'run.js', writing(marker, 'ran'));
  await assert.rejects(kernel.call('exec', { command: `node "${path}"` }), { code: 'guard_denied' });
  assert.equal(existsSync(marker), false);
});

test('never cannot outrun a Permission the session does not hold', async (t) => {
  const { kernel, root, marker } = await harness(t, { permission: readOnly });
  const path = await script(root, 'run.js', writing(marker, 'ran'));
  // 只读档位在平台上会先报哪一条由沙箱能力决定，但都必须在启动前拒绝。
  await assert.rejects(kernel.call('exec', { command: `node "${path}"` }), (error: unknown) => {
    const code = (error as { code?: string }).code ?? '';
    return code === 'permission_read_only' || code.startsWith('permission_');
  });
  assert.equal(existsSync(marker), false);
});

test('a cancelled call never starts, whatever the tier says', async (t) => {
  const { kernel, root, marker } = await harness(t);
  const path = await script(root, 'run.js', writing(marker, 'ran'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(kernel.call('exec', { command: `node "${path}"` }, { signal: controller.signal }));
  assert.equal(existsSync(marker), false);
});
