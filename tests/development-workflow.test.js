// These G01–G04 checks use a deterministic local HTTP model simulator and the real Host tools.
// They exercise the tool workflow; they are not real autonomous-model acceptance runs.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { measuredPermissionContext, withTuiHost } from '../core/tests/helpers/tui-host.ts';

const repositoryFile = (relativePath) => fileURLToPath(new URL(relativePath, import.meta.url));

async function stageReferences({ projectDirectory }) {
  const reference = join(projectDirectory, 'reference');
  await mkdir(reference, { recursive: true });
  await Promise.all([
    copyFile(repositoryFile('../tui/package.json'), join(reference, 'package.json')),
    copyFile(repositoryFile('./fixtures/register-workspace.mjs'), join(reference, 'register-workspace.mjs')),
    copyFile(repositoryFile('../docs/development/ARCHITECTURE.en.md'), join(reference, 'ARCHITECTURE.en.md')),
  ]);
}

async function callTool(context, tool, args) {
  const { client, sessionId } = context;
  const before = (await client.request('session.read', { sessionId, fullResults: true })).events;
  const lastSeq = before.at(-1)?.seq ?? -1;
  await client.request('run.start', { sessionId, input: JSON.stringify({ tool, args }) });
  const { events } = await client.request('session.read', { sessionId, fullResults: true });
  const result = events.findLast((event) => event.kind === 'tool' && event.tool === tool && event.seq > lastSeq);
  assert.ok(result, `the real Host did not record the ${tool} tool result`);
  assert.equal(result.result.failed, false, `${tool} failed: ${JSON.stringify(result.result)}`);
  return result.result.content;
}

test('G01–G04: isolated Node project, defect repair, repository README, design note, and session recovery', async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async (context) => {
    const { client, projectDirectory, sessionDirectory, sessionId, providerRequests } = context;
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    assert.equal((await client.request('status.get', { sessionId })).permission.workspaceTrusted, true);
    // 只回应 Host 实际提出的命令审批；Permission 仍由本测试使用平台实测能力显式设置。
    client.onRequest(async (message) => {
      assert.equal(message.method, 'approval.request');
      return { decision: 'allow' };
    });

    // G01: create a small runnable project and test it through the Host's exec tool.
    await callTool(context, 'create', {
      path: 'package.json',
      content: JSON.stringify({
        name: 'isolated-workflow',
        private: true,
        type: 'module',
        scripts: { test: 'node run-tests.mjs', start: 'node app.mjs' },
      }, null, 2) + '\n',
    });
    await callTool(context, 'create', {
      path: 'src/sum.mjs',
      content: 'export function sum(left, right) { return left + right; }\n',
    });
    await callTool(context, 'create', {
      path: 'test/smoke.test.mjs',
      content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\n\ntest('sum adds two numbers', () => assert.equal(sum(2, 3), 5));\n",
    });
    await callTool(context, 'create', {
      path: 'run-tests.mjs',
      content: "import { spawnSync } from 'node:child_process';\nimport { readdir } from 'node:fs/promises';\nimport { join } from 'node:path';\nconst env = { ...process.env };\ndelete env.NODE_TEST_CONTEXT;\nconst files = (await readdir('test')).filter((name) => name.endsWith('.test.mjs')).map((name) => join('test', name));\nconst child = spawnSync(process.execPath, ['--test', ...files], { env, stdio: 'inherit' });\nif (child.error) throw child.error;\nprocess.exitCode = child.status ?? 1;\n",
    });
    await callTool(context, 'create', {
      path: 'app.mjs',
      content: "import { appendFile } from 'node:fs/promises';\nawait appendFile(new URL('./run-count.txt', import.meta.url), 'ran\\n');\nconsole.log('project-ran');\n",
    });
    const projectTest = await callTool(context, 'exec', { command: 'node run-tests.mjs' });
    assert.equal(projectTest.exitCode, 0, `G01 test command failed: ${projectTest.text}`);
    assert.match(projectTest.text, /pass 1/);
    const projectRun = await callTool(context, 'exec', { command: 'node app.mjs' });
    assert.equal(projectRun.exitCode, 0, `G01 app command failed: ${projectRun.text}`);
    assert.match(projectRun.text, /project-ran/);

    // G02: observe the real failing Node test, read its source, edit the unique defect, and rerun it.
    await callTool(context, 'create', {
      path: 'src/normalize.mjs',
      content: 'export function normalizeName(value) { return value.trim().toLowerCase(); }\n',
    });
    await callTool(context, 'create', {
      path: 'test/normalize.test.mjs',
      content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { normalizeName } from '../src/normalize.mjs';\n\ntest('normalizes a project name', () => assert.equal(normalizeName(' New Project '), 'new-project'));\n",
    });
    const failingRun = await callTool(context, 'exec', { command: 'node run-tests.mjs' });
    assert.notEqual(failingRun.exitCode, 0, 'G02 fixture must fail before the repair');
    assert.match(failingRun.text, /new project/);
    assert.match(failingRun.text, /new-project/);
    const defectSource = await callTool(context, 'read', { path: 'src/normalize.mjs' });
    assert.match(defectSource.text, /trim\(\)\.toLowerCase\(\)/);
    await callTool(context, 'edit', {
      path: 'src/normalize.mjs',
      anchor: 'value.trim().toLowerCase()',
      replacement: "value.trim().toLowerCase().replace(/\\s+/g, '-')",
    });
    const repairedRun = await callTool(context, 'exec', { command: 'node run-tests.mjs' });
    assert.equal(repairedRun.exitCode, 0, `G02 repaired test command failed: ${repairedRun.text}`);
    assert.match(repairedRun.text, /pass 2/);

    // G03: read staged copies of the actual repository package and fixture before writing README facts.
    const packageRead = await callTool(context, 'read', { path: 'reference/package.json' });
    const packageInfo = JSON.parse(packageRead.text);
    const workspaceInfo = JSON.parse(await readFile(repositoryFile('../package.json'), 'utf8'));
    const fixtureRead = await callTool(context, 'read', { path: 'reference/register-workspace.mjs' });
    assert.match(fixtureRead.text, /registerWorkspace/);
    assert.match(fixtureRead.text, /process\.exitCode = 1/);
    const readme = [
      '# Repository development reference',
      '',
      `The package is \`${packageInfo.name}\` version \`${packageInfo.version}\` and requires Node.js \`${packageInfo.engines.node}\`.`,
      `The repository pins \`${workspaceInfo.packageManager}\`. Use \`pnpm run build\` for the build and \`pnpm test\` for the test command.`,
      '',
      'The `register-workspace.mjs` fixture reads a registry path and workspace directory from its command-line arguments. It calls `registerWorkspace`, prints the registration outcome and workspace identities as JSON, and exits with status 1 when registration fails.',
      '',
    ].join('\n');
    await callTool(context, 'create', { path: 'README.md', content: readme });
    const readmeRead = await callTool(context, 'read', { path: 'README.md' });
    assert.match(readmeRead.text, new RegExp(packageInfo.name));
    assert.match(readmeRead.text, new RegExp(packageInfo.version.replaceAll('.', '\\.')));
    assert.match(readmeRead.text, /pnpm test/);
    assert.match(readmeRead.text, /workspace identities/);

    // G04: use the local architecture guide as the factual source for a short technical note.
    const designRead = await callTool(context, 'read', { path: 'reference/ARCHITECTURE.en.md' });
    assert.match(designRead.text, /three source modules/);
    assert.match(designRead.text, /The Host owns sessions/);
    assert.match(designRead.text, /Session records and recovery/);
    const note = [
      '# Runtime ownership',
      '',
      'The architecture guide describes three source modules: a shared Agent Core, a CLI/TUI product, and an Electron Desktop product. The Host owns sessions, project state, policy, and model requests; user interfaces send protocol messages through adapters.',
      '',
      'The kernel executes registered tools and applies the decision chain. Session records are the durable history used during recovery. The repository architecture guide is the source for the component map and detailed request flow.',
      '',
    ].join('\n');
    await callTool(context, 'create', { path: 'docs/runtime-ownership.md', content: note });
    const noteRead = await callTool(context, 'read', { path: 'docs/runtime-ownership.md' });
    assert.match(noteRead.text, /shared Agent Core/);
    assert.match(noteRead.text, /decision chain/);
    assert.match(noteRead.text, /Session records/);

    // Close and reopen the completed session. Recovery must not call the provider or repeat the app side effect.
    const beforeClose = await client.request('session.read', { sessionId });
    const requestsBeforeClose = providerRequests.length;
    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    const afterOpen = await client.request('session.read', { sessionId });
    assert.equal(providerRequests.length, requestsBeforeClose, 'opening a completed session must not ask the model to replay work');
    assert.deepEqual(afterOpen.events, beforeClose.events, 'opening a completed session must not append recovery events');
    assert.equal((await readFile(join(projectDirectory, 'run-count.txt'), 'utf8')), 'ran\n', 'the exec side effect happened once');
    assert.ok((await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).includes('tool_outcome_unknown') === false,
      'the completed session has no unresolved tool outcome to repair');
  }, {
    setup: stageReferences,
    config: { policy: { mode: 'auto' } },
    interactive: true,
    permissionControl: true,
    permission,
  });
});
