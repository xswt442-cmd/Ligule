import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { delimiter, extname, join, resolve } from 'node:path';
import { KernelError } from '../errors.js';
import { inspectCommand } from './command.js';
import { isWithin } from './paths.js';
import type { PermissionContext } from '../kernel/permission.js';
import type { ShellSelection } from './shell.js';

export interface ScriptBinding {
  readonly path: string;
  readonly sourceKind: 'file' | 'inline';
  readonly inlineSource?: string;
  readonly sha256: string;
  readonly interpreter: string;
  readonly interpreterIdentity: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  };
  readonly interpreterSource: string;
  readonly argumentSource: string;
  readonly workspaceRoot: string;
  readonly permission: {
    readonly profile: string;
    readonly network: string;
    readonly workspaceTrusted: boolean;
    readonly capabilities: PermissionContext['capabilities'];
  };
}

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php']);
const WRAPPERS = new Set(['sudo', 'su', 'doas', 'env', 'command', 'exec', 'source', '.', 'import-module', 'busybox', 'timeout', 'nohup', 'setsid', 'xargs', 'start-process', 'invoke-expression', 'iex', 'eval', 'npm', 'npx', 'pnpm', 'yarn', 'make', 'awk', 'gawk', 'mawk', 'nawk']);
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);
const INSTALL_ACTIONS = new Set(['install', 'i', 'ci', 'add']);
const EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ps1', '.py', '.pyw', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.rb', '.pl', '.php']);

function executableName(value: string): string {
  return (value.replaceAll('\\', '/').split('/').at(-1) ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '');
}

async function interpreterPath(name: string): Promise<{ path: string; identity: ScriptBinding['interpreterIdentity'] }> {
  const path = process.env.PATH ?? process.env.Path ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((extension) => extension !== '')
    : [''];
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (!existsSync(candidate)) continue;
      try {
        const path = await realpath(candidate);
        const identity = await executableIdentity(path);
        return { path, identity };
      } catch (error) {
        throw new KernelError('exec_script_binding_unavailable', { cause: error, detail: `the ${name} interpreter file identity could not be verified` });
      }
    }
  }
  throw new KernelError('exec_script_binding_unavailable', { detail: `the ${name} interpreter could not be resolved to one executable path` });
}

async function executableIdentity(path: string): Promise<ScriptBinding['interpreterIdentity']> {
  const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    const actualPath = await realpath(path);
    const pathInfo = await stat(path, { bigint: true });
    const after = await handle.stat({ bigint: true });
    if (!before.isFile() || actualPath !== path || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new KernelError('exec_script_binding_changed', { detail: 'the interpreter executable changed while its identity was checked' });
    }
    return {
      dev: before.dev.toString(), ino: before.ino.toString(), size: before.size.toString(),
      mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString(),
    };
  } finally {
    await handle.close();
  }
}

export async function resolveNodeRuntime(): Promise<{ path: string; identity: ScriptBinding['interpreterIdentity'] }> {
  return interpreterPath('node');
}

export async function commandUsesNodeRuntime(command: string, shell: ShellSelection): Promise<boolean> {
  const inspected = await inspectCommand(command, shell.kind);
  if (inspected.parsed.kind !== 'segments') return false;
  return inspected.invocations.some((invocation) => ['node', 'npm', 'npx', 'corepack'].includes(executableName(invocation.executable)));
}

export async function assertInterpreterIdentity(
  path: string,
  expected: ScriptBinding['interpreterIdentity'],
): Promise<void> {
  let actual: ScriptBinding['interpreterIdentity'];
  try { actual = await executableIdentity(path); }
  catch (error) { throw new KernelError('exec_script_binding_changed', { cause: error, detail: 'the approved interpreter could not be revalidated before execution' }); }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size
    || actual.mtimeNs !== expected.mtimeNs || actual.ctimeNs !== expected.ctimeNs) {
    throw new KernelError('exec_script_binding_changed', { detail: 'the approved interpreter executable changed before execution' });
  }
}

export async function readBoundScript(boundary: string, path: string, allowOutsideBoundary = false): Promise<Buffer> {
  const noFollow = constants.O_NOFOLLOW;
  let realBoundary: string;
  try { realBoundary = await realpath(boundary); }
  catch (error) { throw new KernelError('exec_script_binding_unavailable', { cause: error, detail: 'the workspace boundary could not be resolved while opening the script' }); }
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0)); }
  catch (error) { throw new KernelError('exec_script_binding_unavailable', { cause: error, detail: 'the script could not be opened for identity verification' }); }
  try {
    const openedBefore = await handle.stat({ bigint: true });
    const actualPath = await realpath(path);
    const pathInfo = await stat(path, { bigint: true });
    if (!openedBefore.isFile() || actualPath !== path || (!allowOutsideBoundary && !isWithin(realBoundary, actualPath))
      || openedBefore.dev !== pathInfo.dev || openedBefore.ino !== pathInfo.ino) {
      throw new KernelError('exec_script_binding_changed', { detail: 'the script path or file identity changed while it was opened' });
    }
    const content = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    if (openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino
      || openedBefore.size !== openedAfter.size || openedBefore.mtimeNs !== openedAfter.mtimeNs
      || openedBefore.ctimeNs !== openedAfter.ctimeNs) {
      throw new KernelError('exec_script_binding_changed', { detail: 'the script content changed while it was read for approval' });
    }
    return content;
  } catch (error) {
    if (error instanceof KernelError) throw error;
    throw new KernelError('exec_script_binding_unavailable', { cause: error, detail: 'the script could not be verified through its open file handle' });
  } finally {
    await handle.close();
  }
}

type InspectedInvocation = Awaited<ReturnType<typeof inspectCommand>>['invocations'][number];

function gitProjectExecution(invocation: InspectedInvocation): boolean {
  if (executableName(invocation.executable) !== 'git') return false;
  const values = invocation.arguments.map((argument) => argument.value?.toLowerCase() ?? '');
  return !(values.length === 1 && ['--version', '-v'].includes(values[0] ?? ''));
}

export async function requiresTrustedWorkspaceCommand(command: string, shell: ShellSelection): Promise<boolean> {
  const inspected = await inspectCommand(command, shell.kind);
  if (inspected.parsed.kind !== 'segments') {
    return /(?:^|[;&|\s])(?:npm|npx|pnpm|yarn|make|git|bash|sh|zsh|dash|fish|pwsh|powershell|cmd|python3?|node|deno|bun|perl|ruby|php)\b/iu.test(command)
      || /\.(?:sh|bash|zsh|ps1|psm1|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php)(?:\s|$)/iu.test(command);
  }
  return inspected.invocations.some((invocation) => {
    const name = executableName(invocation.executable);
    const values = invocation.arguments.map((argument) => argument.value ?? '');
    if (PACKAGE_MANAGERS.has(name)) return !packageManagerQuery(values) && !scriptsDisabledInstall(name, values);
    if (name === 'make' || gitProjectExecution(invocation)) return true;
    if (INTERPRETERS.has(name)) {
      return !(values.length === 1 && ['--version', '-V', '-v', '--help', '-h'].includes(values[0] ?? ''));
    }
    return EXTENSIONS.has(extname(invocation.executable).toLowerCase());
  });
}

function scriptsDisabledInstall(name: string, values: readonly string[]): boolean {
  if (values.some((value) => value.toLowerCase() === '--ignore-scripts=false')) return false;
  if (!PACKAGE_MANAGERS.has(name) || !values.some((value) => value === '--ignore-scripts' || value === '--ignore-scripts=true')) return false;
  const action = values.find((value) => INSTALL_ACTIONS.has(value.toLowerCase()))?.toLowerCase();
  if (name === 'npm') return action === 'install' || action === 'ci' || action === 'i';
  if (name === 'pnpm') return action === 'install' || action === 'i';
  return action === 'install' || action === undefined;
}

function packageManagerQuery(values: readonly string[]): boolean {
  return values.length === 1 && ['--version', '-v', '--help', '-h'].includes(values[0]?.toLowerCase() ?? '');
}

function scriptArgument(invocation: InspectedInvocation, trustedWorkspace: boolean): { path: string; sourceKind: 'file' | 'inline'; inlineSource?: string; interpreter: string; interpreterSource: string; argumentSource: string } | undefined {
  const name = executableName(invocation.executable);
  if (invocation.executable.includes('/') || invocation.executable.includes('\\')) {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'interpreter paths must resolve through the current command search path' });
  }
  if (EXTENSIONS.has(extname(invocation.executable).toLowerCase())) {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'direct script execution cannot preserve the approved bytes through this shell backend' });
  }
  const values = invocation.arguments.map((argument) => argument.value ?? '');
  if (PACKAGE_MANAGERS.has(name) && packageManagerQuery(values)) return undefined;
  if (scriptsDisabledInstall(name, values)) return undefined;
  if (PACKAGE_MANAGERS.has(name) || name === 'make') {
    if (!trustedWorkspace) throw new KernelError('exec_workspace_untrusted', { detail: 'project scripts require a trusted workspace and approval for each run' });
    return undefined;
  }
  if (gitProjectExecution(invocation)) {
    if (!trustedWorkspace) throw new KernelError('exec_workspace_untrusted', { detail: 'Git can run project hooks, helpers, or configured aliases; a trusted workspace and approval for each operation are required' });
    return undefined;
  }
  if (WRAPPERS.has(name)) {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'wrapper commands cannot bind the exact script interpreter and file for approval' });
  }
  if (invocation.executableDynamic) {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'dynamic command names cannot be bound to one approved interpreter' });
  }
  if (!INTERPRETERS.has(name)) return undefined;
  if (invocation.nested || invocation.pipeline || invocation.arguments.some((arg) => arg.dynamic || arg.value === undefined)) {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'nested or dynamic interpreter calls cannot be bound to one approved script' });
  }
  if (values.length === 1 && ['--version', '-V', '-v', '--help', '-h'].includes(values[0])) return undefined;
  if (['bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd'].includes(name)) {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'shell interpreters may stream script bytes while executing and cannot be bound to an immutable source snapshot' });
  }
  if (['node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php'].includes(name)) {
    const evalIndex = values.findIndex((value) => ['-e', '-c', '-p', '-r', '--eval', '--print'].includes(value));
    if (evalIndex >= 0) {
      if (evalIndex !== 0 || values.length !== 2) {
        throw new KernelError('exec_script_binding_unavailable', { detail: 'inline interpreter calls with additional options or arguments are not supported' });
      }
      const code = values[evalIndex + 1];
      if (code === undefined || invocation.arguments[evalIndex + 1] === undefined) {
        throw new KernelError('exec_script_binding_unavailable', { detail: 'the interpreter inline code argument is missing' });
      }
      if (invocation.executableSource === undefined || invocation.executableSource === '') {
        throw new KernelError('exec_script_binding_unavailable', { detail: 'the interpreter source token could not be identified for execution binding' });
      }
      return {
        path: '[inline code]', sourceKind: 'inline', inlineSource: code, interpreter: name,
        interpreterSource: invocation.executableSource, argumentSource: '',
      };
    }
  }
  const index = values[0] !== undefined && !values[0].startsWith('-') ? 0 : -1;
  const candidate = index < 0 ? undefined : values[index];
  if (candidate === undefined || !EXTENSIONS.has(extname(candidate).toLowerCase())) {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'the interpreter or wrapper does not identify one static script file that can be bound to this approval' });
  }
  if (invocation.executableSource === undefined || invocation.executableSource === '') {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'the interpreter source token could not be identified for execution binding' });
  }
  return { path: candidate, sourceKind: 'file', interpreter: name, interpreterSource: invocation.executableSource, argumentSource: invocation.arguments[index].source };
}

export async function bindScript({ command, shell, boundary, workspaceRoot, cwd, permission }: {
  readonly command: string;
  readonly shell: ShellSelection;
  readonly boundary: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly permission: PermissionContext;
}): Promise<ScriptBinding | undefined> {
  const inspected = await inspectCommand(command, shell.kind);
  if (inspected.parsed.kind !== 'segments') {
    if (/(?:^|[;&|]\s*)(?:bash|sh|zsh|dash|fish|pwsh|powershell|cmd|python3?|node|deno|bun|perl|ruby|php|sudo|su|doas|env|command|exec|source|import-module|busybox|timeout|nohup|setsid|xargs|start-process|invoke-expression|iex|eval|npm|npx|pnpm|yarn|make|awk|gawk|mawk|nawk)\b/iu.test(command)
      || /^\s*\.\s+\S/iu.test(command)
      || /^\s*using\s+module\b/iu.test(command)
      || /\.(?:sh|bash|zsh|ps1|psm1|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php)(?:\s|$)/iu.test(command)) {
      throw new KernelError('exec_script_binding_unavailable', { detail: 'the parsed command is incomplete and may invoke an interpreter or wrapper' });
    }
    return undefined;
  }
  const selectedInvocations = inspected.invocations.map((invocation) => scriptArgument(invocation, permission.workspaceTrusted));
  const bound = selectedInvocations.filter((value) => value !== undefined);
  if (inspected.parsed.segments.length !== 1 || inspected.invocations.length !== 1) {
    if (bound.length > 0) throw new KernelError('exec_script_binding_unavailable', { detail: 'compound commands with interpreter or script invocations cannot be bound as one approval' });
    return undefined;
  }
  const selected = selectedInvocations[0];
  if (selected === undefined) return undefined;
  if (!permission.workspaceTrusted) {
    throw new KernelError('exec_workspace_untrusted', { detail: 'project scripts require a trusted workspace and approval for each run' });
  }
  if (selected.sourceKind === 'file' && permission.profile === 'read-only') {
    throw new KernelError('exec_script_binding_unavailable', { detail: 'read-only execution cannot create a source-directory snapshot without writing to the workspace' });
  }
  let content: Buffer;
  let path = '[inline code]';
  if (selected.sourceKind === 'inline') {
    content = Buffer.from(selected.inlineSource ?? '', 'utf8');
  } else {
    let realBoundary: string;
    let realCwd: string;
    try {
      [realBoundary, realCwd] = await Promise.all([realpath(boundary), realpath(cwd)]);
      if (!isWithin(realBoundary, realCwd)) throw new KernelError('path_escapes_boundary');
      path = await realpath(resolve(realCwd, selected.path));
      if (permission.profile !== 'full-access' && !isWithin(realBoundary, path)) throw new KernelError('path_escapes_boundary');
    } catch {
      throw new KernelError('exec_script_binding_unavailable', { detail: 'the script path could not be resolved for the current permission and workspace' });
    }
    try { content = await readBoundScript(boundary, path, permission.profile === 'full-access'); }
    catch (error) { throw new KernelError('exec_script_binding_unavailable', { cause: error, detail: 'the script content could not be read for approval' }); }
  }
  let canonicalWorkspace: string;
  try { canonicalWorkspace = await realpath(workspaceRoot); }
  catch (error) { throw new KernelError('exec_script_binding_unavailable', { cause: error, detail: 'the workspace identity could not be resolved' }); }
  const interpreter = await interpreterPath(selected.interpreter);
  return Object.freeze({
    path,
    sourceKind: selected.sourceKind,
    ...(selected.inlineSource === undefined ? {} : { inlineSource: selected.inlineSource }),
    sha256: createHash('sha256').update(content).digest('hex'),
    interpreter: interpreter.path,
    interpreterIdentity: interpreter.identity,
    interpreterSource: selected.interpreterSource,
    argumentSource: selected.argumentSource,
    workspaceRoot: canonicalWorkspace,
    permission: Object.freeze({ profile: permission.profile, network: permission.network, workspaceTrusted: permission.workspaceTrusted, capabilities: permission.capabilities }),
  });
}

export async function requiresManualApprovalForProjectCommand(command: string, shell: ShellSelection): Promise<boolean> {
  const inspected = await inspectCommand(command, shell.kind);
  if (inspected.parsed.kind !== 'segments') return false;
  return inspected.invocations.some(gitProjectExecution);
}

export function assertScriptBinding(expected: ScriptBinding | undefined, actual: ScriptBinding | undefined): void {
  if (expected === undefined || actual === undefined
    || expected.path !== actual.path
    || expected.sourceKind !== actual.sourceKind
    || expected.sha256 !== actual.sha256
    || expected.interpreter !== actual.interpreter
    || expected.interpreterIdentity.dev !== actual.interpreterIdentity.dev
    || expected.interpreterIdentity.ino !== actual.interpreterIdentity.ino
    || expected.interpreterIdentity.size !== actual.interpreterIdentity.size
    || expected.interpreterIdentity.mtimeNs !== actual.interpreterIdentity.mtimeNs
    || expected.interpreterIdentity.ctimeNs !== actual.interpreterIdentity.ctimeNs
    || expected.interpreterSource !== actual.interpreterSource
    || expected.argumentSource !== actual.argumentSource
    || expected.workspaceRoot !== actual.workspaceRoot
    || expected.permission.profile !== actual.permission.profile
    || expected.permission.network !== actual.permission.network
    || expected.permission.workspaceTrusted !== actual.permission.workspaceTrusted
    || expected.permission.capabilities.filesystemRead !== actual.permission.capabilities.filesystemRead
    || expected.permission.capabilities.filesystemWrite !== actual.permission.capabilities.filesystemWrite
    || expected.permission.capabilities.network !== actual.permission.capabilities.network
    || expected.permission.capabilities.process !== actual.permission.capabilities.process) {
    throw new KernelError('exec_script_binding_changed', { detail: 'the approved script path, content, interpreter, workspace, or permission changed before execution' });
  }
}
