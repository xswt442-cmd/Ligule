import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createConfig, createDecisionChain, createKernel, createPermissionContext, createSessionLog } from '../dist/index.js';
import { execTool } from '../dist/capability/exec.js';
import { resolveShell } from '../dist/capability/shell.js';
import { bindScript, commandUsesNodeRuntime, readBoundScript, requiresManualApprovalForProjectCommand, requiresTrustedWorkspaceCommand } from '../dist/capability/script-binding.js';
import { boundaryOf, workingDirectoryOf } from '../dist/capability/limits.js';
import type { ScriptBinding } from '../dist/capability/script-binding.js';
import type { PermissionContext } from '../dist/kernel/permission.js';
import type { LoggerBackend } from '../dist/kernel/log.js';
import type { PolicyAsk, PolicyMode, PolicyQuestion } from '../dist/kernel/policy.js';
import { setTrusted } from '../dist/kernel/workspace-trust.js';

const permission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
}, { workspaceTrusted: true });

test('Node and package-manager commands select the pinned sandbox runtime', async () => {
  const shell = resolveShell({});
  assert.equal(await commandUsesNodeRuntime('node --version', shell), true);
  assert.equal(await commandUsesNodeRuntime('npm run dev', shell), true);
  assert.equal(await commandUsesNodeRuntime('corepack pnpm run dev', shell), true);
  assert.equal(await requiresTrustedWorkspaceCommand('corepack pnpm run dev', shell), true);
  assert.equal(await commandUsesNodeRuntime('git status --short', shell), false);
});

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function kernelFor(
  root: string,
  ask: PolicyAsk,
  permissionForCall: () => PermissionContext = () => permission,
  workspaceRoot: string = root,
  log: LoggerBackend = { debug() {}, log() {} },
  mode: PolicyMode = 'ask',
) {
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root, workspaceRoot } }),
    permissionForCall,
    logger: log,
    policy: createDecisionChain({ mode, ask }),
  });
  kernel.register(execTool);
  return kernel;
}

test('script approvals bind the canonical path, content digest, interpreter, workspace, and permission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  await writeFile(join(root, 'payload.txt'), 'relative import survived');
  await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, readFileSync(new URL('./payload.txt', import.meta.url), 'utf8'));\n`);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  let approval: PolicyQuestion | undefined;
  const kernel = kernelFor(root, (question) => { approval = question; return true; });
  await kernel.call('exec', { command });
  const binding = approval?.scriptBinding;
  const canonicalRoot = await realpath(root);
  assert.ok(binding);
  assert.equal(binding.path, await realpath(script));
  assert.match(binding.sha256, /^[a-f0-9]{64}$/u);
  assert.match(binding.interpreter, /node(?:\.exe)?$/iu);
  assert.equal(binding.workspaceRoot, canonicalRoot);
  assert.deepEqual(binding.permission, { profile: 'full-access', network: 'unrestricted', workspaceTrusted: true, capabilities: permission.capabilities });

  assert.equal(binding.interpreterSource, 'node');
  assert.equal(await readFile(target, 'utf8'), 'relative import survived');
  assert.equal((await readdir(root)).some((name) => name.startsWith('.ligule-approved-')), false);
});

test('full-access approval can bind a script outside the workspace while keeping cwd inside', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-full-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const external = join(root, 'external');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(external, { recursive: true })]);
  await setTrusted(workspace, true);
  const marker = join(external, 'marker');
  const script = join(external, 'approved.js');
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  let binding: ScriptBinding | undefined;
  const kernel = kernelFor(workspace, (question) => { binding = question.scriptBinding; return true; });
  await kernel.call('exec', { command });
  assert.ok(binding);
  assert.equal(binding.path, await realpath(script));
  assert.equal(await readFile(marker, 'utf8'), 'ran');
});

test('inline interpreter code is bound to its exact text and interpreter executable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-inline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const command = 'node -e "console.log(42)"';
  let approval: PolicyQuestion | undefined;
  const kernel = kernelFor(root, (question) => { approval = question; return true; });
  const result = await kernel.call('exec', { command });
  const binding = approval?.scriptBinding;
  assert.ok(binding);
  assert.equal(binding.sourceKind, 'inline');
  assert.equal(binding.path, '[inline code]');
  assert.equal(binding.inlineSource, 'console.log(42)');
  assert.match((result as { text: string }).text, /42/u);
});

test('script content changes after approval are refused before the target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`;
  await writeFile(script, source);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, async () => {
    await writeFile(script, `${source}// changed while approval was pending\n`);
    return true;
  });
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('a permission change while approval is pending is refused before the target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-permission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  let current = permission;
  const changed = createPermissionContext('full-access', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'full', network: 'full', process: 'full',
  }, { workspaceTrusted: true });
  const kernel = kernelFor(root, () => { current = changed; return true; }, () => current);
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('replacing the interpreter at the same path after approval is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-interpreter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const executableDirectory = join(root, 'bin');
  await mkdir(executableDirectory, { recursive: true });
  const executable = join(executableDirectory, process.platform === 'win32' ? 'node.EXE' : 'node');
  await writeFile(executable, 'approved interpreter identity');
  const previousPath = process.env.PATH;
  process.env.PATH = [executableDirectory, previousPath ?? ''].filter(Boolean).join(delimiter);
  try {
    const target = join(root, 'marker');
    const script = join(root, 'approved.js');
    await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`);
    const command = `node "${script.replaceAll('\\', '/')}"`;
    const kernel = kernelFor(root, async () => {
      await writeFile(executable, 'changed interpreter identity');
      return true;
    });
    await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
    await assert.rejects(readFile(target), { code: 'ENOENT' });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('replacing a script path symlink after approval is refused before either target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const first = join(root, 'first');
  const second = join(root, 'second');
  const alias = join(root, 'selected');
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
  const firstMarker = join(root, 'first-marker');
  const secondMarker = join(root, 'second-marker');
  await writeFile(join(first, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(firstMarker)}, 'ran');\n`);
  await writeFile(join(second, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(secondMarker)}, 'ran');\n`);
  try {
    await symlink(first, alias, 'junction');
  } catch (error) {
    if (hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) return t.skip('the platform does not permit creating a temporary directory link');
    throw error;
  }
  const command = `node "${join(alias, 'approved.js').replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, async () => {
    await unlink(alias);
    await symlink(second, alias, 'junction');
    return true;
  });
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
  await assert.rejects(readFile(firstMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(secondMarker), { code: 'ENOENT' });
});

test('replacing the resolved script file with an outside link is refused before reading it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const boundary = join(root, 'workspace');
  const outside = join(root, 'outside.js');
  const script = join(boundary, 'approved.js');
  await mkdir(boundary, { recursive: true });
  await writeFile(script, 'console.log("inside")\n');
  await writeFile(outside, 'console.log("outside")\n');
  const canonical = await realpath(script);
  await rename(script, join(boundary, 'original.js'));
  try { await symlink(outside, script, 'file'); }
  catch (error) {
    if (hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) return t.skip('the platform does not permit creating a temporary file link');
    throw error;
  }
  await assert.rejects(readBoundScript(boundary, canonical), (error) =>
    hasCode(error, 'exec_script_binding_changed') || hasCode(error, 'exec_script_binding_unavailable'));
});

test('changing the workspace target while approval is pending refuses execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
  const firstMarker = join(root, 'first-marker');
  const secondMarker = join(root, 'second-marker');
  await writeFile(join(first, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(firstMarker)}, 'ran');\n`);
  await writeFile(join(second, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(secondMarker)}, 'ran');\n`);
  try { await symlink(first, workspace, 'junction'); }
  catch (error) {
    if (hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) return t.skip('the platform does not permit creating a temporary directory link');
    throw error;
  }
  await setTrusted(workspace, true);
  const command = 'node "approved.js"';
  const config = createConfig({ user: { boundary: workspace, workspaceRoot: workspace } });
  const boundary = boundaryOf(config);
  const workspaceRoot = workingDirectoryOf(config);
  assert.ok(await bindScript({ command, shell: resolveShell({}), boundary, workspaceRoot, cwd: workspaceRoot, permission }));
  let asked = false;
  const denied: string[] = [];
  const log: LoggerBackend = { debug() {}, log(_message, fields) { if (typeof fields?.reason === 'string') denied.push(fields.reason as string); } };
  const kernel = kernelFor(workspace, async () => {
    asked = true;
    await unlink(workspace);
    await symlink(second, workspace, 'junction');
    return true;
  }, () => permission, workspace, log);
  let failure: { code?: string } | undefined;
  try { await kernel.call('exec', { command }); } catch (error) { failure = error as { code?: string }; }
  assert.equal(asked, true, `the call failed before approval with ${failure?.code ?? 'no error'}: ${denied.at(-1) ?? ''}`);
  assert.ok(['exec_script_binding_changed', 'exec_workspace_untrusted'].includes(failure?.code as string), failure?.code);
  assert.equal(asked, true);
  await assert.rejects(readFile(firstMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(secondMarker), { code: 'ENOENT' });
});

test('read-only approval refuses file scripts without writing a snapshot into the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-readonly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`);
  const readonly = createPermissionContext('read-only', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  }, { workspaceTrusted: true });
  const command = `node "${script.replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, () => true, () => readonly);
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_unavailable' });
  assert.equal((await readdir(root)).some((name) => name.startsWith('.ligule-approved-')), false);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('simple interpreter version queries remain ordinary approval-gated commands', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let asked: PolicyQuestion | undefined;
  const kernel = kernelFor(root, (question) => { asked = question; return false; });
  await assert.rejects(kernel.call('exec', { command: 'node --version' }), { code: 'ask_declined' });
  assert.equal(asked?.scriptBinding, undefined);
  assert.equal(asked?.command, 'node --version');
});

test('project scripts and package hooks require a trusted workspace while ignored-script installs remain available', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = resolveShell({});
  const untrusted = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  });

  await assert.rejects(bindScript({
    command: 'node -e "console.log(1)"', shell, boundary: root, workspaceRoot: root, cwd: root, permission: untrusted,
  }), { code: 'exec_workspace_untrusted' });
  await assert.rejects(bindScript({
    command: 'npm run build', shell, boundary: root, workspaceRoot: root, cwd: root, permission: untrusted,
  }), { code: 'exec_workspace_untrusted' });
  await assert.rejects(bindScript({
    command: 'corepack pnpm run build', shell, boundary: root, workspaceRoot: root, cwd: root, permission: untrusted,
  }), { code: 'exec_workspace_untrusted' });
  assert.equal(await bindScript({
    command: 'npm install --ignore-scripts', shell, boundary: root, workspaceRoot: root, cwd: root, permission: untrusted,
  }), undefined);

  const trusted = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, { workspaceTrusted: true });
  assert.equal(await bindScript({
    command: 'npm run build', shell, boundary: root, workspaceRoot: root, cwd: root, permission: trusted,
  }), undefined);
  assert.equal(await bindScript({
    command: 'corepack pnpm run build', shell, boundary: root, workspaceRoot: root, cwd: root, permission: trusted,
  }), undefined);
  assert.equal(await requiresManualApprovalForProjectCommand('git add result.txt', shell), true);
  assert.equal(await requiresManualApprovalForProjectCommand('git status --short', shell), true);
  assert.equal(await requiresManualApprovalForProjectCommand('git --version', shell), false);
  assert.equal(await requiresTrustedWorkspaceCommand('git custom-project-alias', shell), true);
  assert.equal(await requiresManualApprovalForProjectCommand('git custom-project-alias', shell), true);
});

test('untrusted project code is rejected while ignored-script installs still require a per-call decision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-trust-kernel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const untrusted = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  });
  const asked: (string | undefined)[] = [];
  const kernel = kernelFor(root, (question) => { asked.push(question.command); return false; }, () => untrusted, root, undefined, 'auto');

  await assert.rejects(kernel.call('exec', { command: 'node -e "console.log(1)"' }), { code: 'exec_workspace_untrusted' });
  assert.deepEqual(asked, []);

  await assert.rejects(kernel.call('exec', { command: 'npm install --ignore-scripts' }), { code: 'ask_declined' });
  assert.deepEqual(asked, ['npm install --ignore-scripts']);

  await assert.rejects(kernel.call('exec', { command: 'git add file.txt' }), { code: 'exec_workspace_untrusted' });
  assert.deepEqual(asked, ['npm install --ignore-scripts']);
  await assert.rejects(kernel.call('exec', { command: 'git custom-project-alias' }), { code: 'exec_workspace_untrusted' });
  assert.deepEqual(asked, ['npm install --ignore-scripts']);
  await assert.rejects(kernel.call('exec', { command: 'git status --short' }), { code: 'exec_workspace_untrusted' });
  assert.deepEqual(asked, ['npm install --ignore-scripts']);
});

test('external workspace trust is checked separately from the Session permission snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-trust-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const target = join(root, 'marker');
  const staleSessionPermission = createPermissionContext('full-access', 'unrestricted', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  }, { workspaceTrusted: false });
  const script = join(root, 'approved.js');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'ran');\n`);
  const kernel = kernelFor(root, () => true, () => staleSessionPermission);

  await kernel.call('exec', { command: `node "${script.replaceAll('\\', '/')}"` });

  assert.equal(await readFile(target, 'utf8'), 'ran');
});

test('trusted Git hook operations still need a per-call approval under automatic policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-trust-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const trusted = createPermissionContext('workspace-write', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
  }, { workspaceTrusted: true });
  const asked: (string | undefined)[] = [];
  const kernel = kernelFor(root, (question) => { asked.push(question.command); return false; }, () => trusted, root, undefined, 'auto');
  await assert.rejects(kernel.call('exec', { command: 'git add file.txt' }), { code: 'ask_declined' });
  assert.deepEqual(asked, ['git add file.txt']);
});

test('revoking partial-sandbox confirmation while approval is pending prevents execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-partial-confirmation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const target = join(root, 'marker');
  const capabilities = { filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full' };
  const permissionWithConfirmation = (confirmed: boolean) => createPermissionContext('workspace-write', 'unrestricted', capabilities, {
    profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
    partialWorkspaceWriteConfirmationRequired: true,
    partialWorkspaceWriteConfirmed: confirmed,
    workspaceTrusted: true,
  });
  let currentPermission = permissionWithConfirmation(true);
  let asked = false;
  const logs: (Readonly<Record<string, unknown>> | undefined)[] = [];
  const source = `require('fs').writeFileSync('${target.replaceAll('\\', '/').replaceAll("'", "\\'")}', 'ran');`;
  const kernel = kernelFor(root, async () => {
    asked = true;
    currentPermission = permissionWithConfirmation(false);
    return true;
  }, () => currentPermission, root, { debug() {}, log(_message: string, fields?: Readonly<Record<string, unknown>>) { logs.push(fields); } });

  let failure: { code?: string; detail?: unknown } | undefined;
  try { await kernel.call('exec', { command: `node -e "${source}"` }); }
  catch (error) { failure = error as { code?: string; detail?: unknown }; }
  assert.equal(failure?.code, 'exec_script_binding_changed', JSON.stringify({ failureCode: failure?.code, detail: failure?.detail, logs }));
  assert.equal(asked, true);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('a workspace cwd escape keeps its Kernel error and records failure before approval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-exec-cwd-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let asked = false;
  const session = createSessionLog({ directory: root, id: 'cwd-escape' });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root, workspaceRoot: root } }),
    permission,
    policy: createDecisionChain({ mode: 'ask', ask: () => { asked = true; return true; } }),
    session,
  });
  kernel.register(execTool);
  await assert.rejects(kernel.call('exec', { command: 'node --version', cwd: '..' }), { code: 'path_escapes_boundary' });
  assert.equal(asked, false);
  const event = (await session.read()).find((item) => item.kind === 'tool')!;
  assert.equal((event.result as { kind?: string }).kind, 'failure');
  assert.equal((event.result as { code?: string }).code, 'path_escapes_boundary');
});

test('shell scripts that stream their source are refused before the target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setTrusted(root, true);
  const marker = join(root, 'marker');
  const script = join(root, 'approved.sh');
  await writeFile(script, `printf ran > '${marker.replaceAll("'", "'\\''")}'\n`);
  const command = `bash "${script.replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, () => true);
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_unavailable' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
