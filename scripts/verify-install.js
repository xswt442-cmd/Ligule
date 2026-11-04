// 在空项目中安装打包文件，并通过 CLI、包导出和 MCP 服务检查真实安装结果。
//
// 可传入已构建的 tarball，确保发布验收与后续发布使用同一份文件。
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { releaseManifest } from './pack-release.js';
import { execNpm } from './npm-cli.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
let given;
let workRootArgument;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--work-root') {
    if (workRootArgument !== undefined || typeof args[index + 1] !== 'string') {
      throw new Error('usage: pnpm --filter ligule run verify-install [tarball] [--work-root testplace/tmp/<new-directory>]');
    }
    workRootArgument = args[++index];
  } else if (args[index].startsWith('--') || given !== undefined) {
    throw new Error('usage: pnpm --filter ligule run verify-install [tarball] [--work-root testplace/tmp/<new-directory>]');
  } else {
    given = args[index];
  }
}
const temporaryParent = join(repo, 'testplace', 'tmp');
mkdirSync(temporaryParent, { recursive: true });
const canonicalTestplace = realpathSync(join(repo, 'testplace'));
const resolvedTemporaryParent = realpathSync(temporaryParent);
if (resolvedTemporaryParent !== join(canonicalTestplace, 'tmp')) throw new Error('testplace/tmp must not resolve outside the workspace testplace directory');
const packDir = workRootArgument === undefined ? join(repo, 'testplace', 'pack') : resolve(repo, workRootArgument);
let isolatedWorkRoot = false;
if (workRootArgument !== undefined) {
  const relativeWorkRoot = relative(resolvedTemporaryParent, packDir);
  const actualParent = realpathSync(dirname(packDir));
  const parentMatches = process.platform === 'win32'
    ? actualParent.toLowerCase() === resolvedTemporaryParent.toLowerCase()
    : actualParent === resolvedTemporaryParent;
  if (relativeWorkRoot === '' || relativeWorkRoot === '..' || relativeWorkRoot.startsWith(`..${sep}`) || isAbsolute(relativeWorkRoot)
    || !parentMatches) {
    throw new Error('verify-install work root must be a new direct child of testplace/tmp');
  }
  if (existsSync(packDir)) throw new Error(`verify-install work root already exists: ${packDir}`);
  mkdirSync(packDir);
  isolatedWorkRoot = true;
}
const consumer = join(packDir, 'install', 'consumer');
if (given === undefined && (!existsSync(join(repo, 'tui', 'dist', 'index.js')) || !existsSync(join(repo, 'core', 'dist', 'index.js')))) {
  throw new Error('TUI or Core build output is missing; run `pnpm run build` before verifying a fresh install');
}

const pkg = releaseManifest();
// Relative tarball paths follow the documented workspace-root convention even though pnpm runs this script from `tui/`.
const tarball = given === undefined ? join(packDir, `${pkg.name}-${pkg.version}.tgz`) : resolve(repo, given);
if (!isolatedWorkRoot) rmSync(join(packDir, 'install'), { recursive: true, force: true });
mkdirSync(consumer, { recursive: true });
// 为隔离的消费者创建独立清单；安装依赖只依据被测 tarball 的声明。
// 这四个依赖需要安装脚本来构建原生绑定。消费者清单显式允许这些脚本，避免沿用调用环境中的 npm 白名单设置。
const consumerManifest = {
  name: 'ligule-consumer',
  version: '0.0.0',
  private: true,
  allowScripts: { koffi: true, 'tree-sitter': true, 'tree-sitter-bash': true, 'tree-sitter-pwsh': true, 'tesseract.js': false },
};
writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(consumerManifest, null, 2)}\n`, 'utf8');
if (given === undefined) {
  execFileSync(process.execPath, [join(repo, 'scripts', 'pack-release.js'), packDir], { cwd: repo, stdio: 'inherit' });
}
if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);

// 清除调用环境中的脚本白名单变量，避免它影响安装策略。
const installEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name.toLowerCase() !== 'npm_config_allow_scripts'));
try {
  execNpm(['install', tarball, '--no-audit', '--no-fund'], {
    cwd: consumer,
    env: installEnvironment,
    encoding: 'utf8',
    timeout: 900_000,
  });
} catch (error) {
  const text = `${error.stdout ?? ''}${error.stderr ?? ''}${(error.output ?? []).join('')}${error.message ?? ''}`;
  process.stdout.write(text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-12).join('\n'));
  // 如果 npm 仍拒绝这些安装脚本，指出可检查的项目配置和拒绝原因。
  if (text.includes('EALLOWSCRIPTS')) {
    throw new Error('npm 拒绝了这一次安装里依赖自带的安装脚本（EALLOWSCRIPTS）。它只认包内那一格白名单（消费者 package.json 的 allowScripts）或项目 .npmrc，'
      + '这一份脚本已经写了那一格仍然被拒，说明这台机器上的 npm 收得比声明更紧。普通 npm 环境（发布流水线那一条）不受这一条影响。');
  }
  throw error;
}

const installedPackageDirectory = join(consumer, 'node_modules', pkg.name);
const installed = JSON.parse(readFileSync(join(installedPackageDirectory, 'package.json'), 'utf8'));
if (installed.version !== pkg.version) throw new Error(`the consumer got ${installed.version}, package.json says ${pkg.version}`);
if (Object.values(installed.dependencies ?? {}).some((specifier) => specifier.startsWith('workspace:'))) {
  throw new Error('the published package manifest retained a pnpm workspace dependency');
}
const bundledCoreDirectory = join(consumer, 'node_modules', pkg.name, 'node_modules', '@ligule', 'core');
if (!existsSync(join(bundledCoreDirectory, 'dist', 'index.js')) || !existsSync(join(bundledCoreDirectory, 'modes', 'minimal.toml'))) {
  throw new Error('the installed npm package does not contain the complete private Core runtime');
}
const installedPackageRoot = realpathSync(installedPackageDirectory);
const installedCoreRoot = realpathSync(bundledCoreDirectory);
const relativeCore = relative(installedPackageRoot, installedCoreRoot);
if (relativeCore === '..' || relativeCore.startsWith(`..${sep}`) || isAbsolute(relativeCore)) {
  throw new Error(`the installed Core package resolved outside the TUI tarball: ${installedCoreRoot}`);
}
const coreManifest = JSON.parse(readFileSync(join(bundledCoreDirectory, 'package.json'), 'utf8'));
if (coreManifest.private !== true) throw new Error('the bundled Core package must remain private');
if (installed.bin?.ligule !== './dist/cli.js') throw new Error('the installed npm package does not declare the ligule CLI entry');
if (JSON.stringify(installed.dependencies) !== JSON.stringify(pkg.dependencies)) {
  throw new Error('the consumer did not receive the release manifest dependencies');
}
if (JSON.stringify(installed.optionalDependencies) !== JSON.stringify(pkg.optionalDependencies)) {
  throw new Error('the consumer did not receive the release manifest optional dependencies');
}
if (existsSync(join(consumer, 'node_modules', 'typescript'))) throw new Error('devDependencies came along into the consumer');

// 确认 npm 生成 CLI 命令 shim，再直接用 Node 启动同一个入口，避免经 shell 拼接参数。
const commandShim = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? `${pkg.name}.cmd` : pkg.name);
if (!existsSync(commandShim)) throw new Error(`${pkg.name}'s installed CLI command shim is missing`);
const cliEntry = join(installedPackageDirectory, 'dist', 'cli.js');
const env = { ...process.env, PATH: `${join(consumer, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}` };
const run = (args) => spawnSync(process.execPath, [cliEntry, ...args], { env, cwd: consumer, encoding: 'utf8', timeout: 60_000 });
const readings = [];

// Generate real documents with development writers, then read them solely through the installed runtime.
const sourceCore = createRequire(join(repo, 'core', 'package.json'));
const { PDFDocument, StandardFonts } = sourceCore('pdf-lib');
const { Document, Packer, Paragraph } = sourceCore('docx');
const PptxGenJS = sourceCore('pptxgenjs');
const ExcelJS = sourceCore('exceljs');
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage([300, 200]).drawText('Installed PDF text', { font, size: 14, x: 20, y: 150 });
writeFileSync(join(consumer, 'sample.pdf'), await pdf.save());
writeFileSync(join(consumer, 'sample.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Installed DOCX text')] }] })));
const workbook = new ExcelJS.Workbook();
workbook.addWorksheet('Values').getCell('A1').value = 'Installed XLSX text';
await workbook.xlsx.writeFile(join(consumer, 'sample.xlsx'));
const slides = new PptxGenJS();
slides.addSlide().addText('Installed PPTX text', { x: 1, y: 1, w: 3, h: 1 });
await slides.writeFile({ fileName: join(consumer, 'sample.pptx') });

const version = run(['--version']);
if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
  throw new Error(`${pkg.name} --version inside the consumer said "${version.stdout?.trim()}" with status ${version.status}`);
}
readings.push(`--version: ${version.stdout.trim()}`);

const tools = run(['tools']);
const counted = tools.stdout.split('\n').filter((line) => line.trim() !== '').length;
if (tools.status !== 0 || counted !== 9) throw new Error(`${pkg.name} tools listed ${counted}, expected 9`);
readings.push(`tools: ${counted}`);

// 非交互终端启动 TUI 时应返回稳定错误码；这也会加载并检查 TUI 入口依赖。
const tui = run(['tui']);
if (!`${tui.stdout}${tui.stderr}`.includes('tui_terminal_required')) {
  throw new Error(`${pkg.name} tui on a non-interactive terminal did not report tui_terminal_required: ${(tui.stdout + tui.stderr).slice(0, 200)}`);
}
readings.push('tui: refuses with tui_terminal_required on a non-interactive terminal');

// 从已安装包加载 Core，检查配置解析、命令解析、工具执行、MCP 和搜索后端。
writeFileSync(join(consumer, 'probe.mjs'), `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createConfig, createKernel, createMcpPlugin, createMcpRegistry, createReadImagePlugin, createReadDocumentPlugin, createWebSearchPlugin, createScreenshotPlugin, createSessionLog, execTool, flagLayer, KernelError, mcpServerConfigs, parseCommand, resolveRipgrep, resolveShell, searchWithRipgrep, withNativeExitCode, VERSION } from 'ligule';
import { pathToFileURL } from 'node:url';

const coreRoot = ${JSON.stringify(bundledCoreDirectory)};
const requireCore = createRequire(pathToFileURL(join(coreRoot, 'package.json')));
requireCore('@napi-rs/keyring');
requireCore('koffi');
console.log('native bindings: keyring and koffi loaded for the consumer platform');
const sharp = requireCore('sharp');
const { createMediaStore } = await import(pathToFileURL(join(coreRoot, 'dist', 'capability', 'media.js')).href);
const previousMediaHome = process.env.LIGULE_HOME;
try {
  process.env.LIGULE_HOME = join(process.cwd(), 'media-home');
  const store = createMediaStore({ boundary: process.cwd() }, 'install-probe');
  const image = await sharp({ create: { width: 6, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
  const reference = await store.put(image, 'file');
  const reread = await store.read(reference);
  if (reference.width !== 6 || reference.height !== 4 || (await sharp(reread).metadata()).format !== 'png') {
    throw new Error('the installed image backend did not preserve the decoded image');
  }
  console.log('image backend: decoded, archived and reread through the installed Core');
  const imageSession = createSessionLog({ directory: join(process.cwd(), 'image-sessions'), id: 'install-probe' });
  const imageKernel = createKernel({ session: imageSession });
  const unregisterImage = createReadImagePlugin({ media: store, supportsImages: () => true }).setup(imageKernel);
  try {
    const result = await imageKernel.call('read_image', { shotId: reference.id });
    const events = await imageSession.read();
    if (result.images?.[0]?.id !== reference.id || !events.some(event => event.kind === 'tool' && event.result.images?.[0]?.id === reference.id)) {
      throw new Error('the installed read_image tool did not preserve its persistent image reference');
    }
    console.log('read_image: real Kernel result and durable Session reference');
    const unregisterCapture = createScreenshotPlugin({ supportsImages: () => true }).setup(imageKernel);
    try {
      let rejected = false;
      try { await imageKernel.call('screenshot', {}); }
      catch (error) { if (error.code !== 'screen_capture_not_authorized') throw error; rejected = true; }
      if (!rejected) throw new Error('the installed screenshot tool accepted missing consent');
      if (process.platform === 'win32' && typeof requireCore('node-screenshots').Monitor.all !== 'function') throw new Error('the installed capture backend is unavailable');
      console.log('screenshot: consent required; native Windows module checked without a capture');
    } finally { unregisterCapture(); }
  } finally {
    unregisterImage();
    await imageSession.close();
  }
  const documentSession = createSessionLog({ directory: join(process.cwd(), 'document-sessions'), id: 'document-install-probe' });
  const documentMedia = createMediaStore({ boundary: process.cwd() }, 'document-install-probe');
  const documentKernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }), session: documentSession });
  const unregisterDocument = createReadDocumentPlugin({ media: documentMedia, supportsImages: () => true }).setup(documentKernel);
  const readDocumentStep = async (step, options) => {
    console.log('read_document: ' + step + ': start');
    const result = await documentKernel.call('read_document', options);
    console.log('read_document: ' + step + ': complete');
    return result;
  };
  try {
    for (const format of ['pdf', 'docx', 'xlsx', 'pptx']) {
      const response = await readDocumentStep(format, { path: 'sample.' + format });
      const parsed = JSON.parse(response);
      if (parsed.format !== format || !parsed.chunks.some(chunk => chunk.text.includes('Installed ' + format.toUpperCase() + ' text'))) {
        throw new Error('the installed read_document parser failed for ' + format);
      }
    }
    const rendered = await readDocumentStep('pdf renderPage 1', { path: 'sample.pdf', renderPage: 1 });
    const image = rendered.images?.[0];
    if (image?.source !== 'document' || (await sharp(await documentMedia.read(image)).metadata()).format !== 'png') {
      throw new Error('the installed PDF renderer did not return a persistent page image');
    }
    console.log('read_document: PDF/DOCX/XLSX/PPTX parsed and PDF rendered through isolated installed workers');
  } finally { unregisterDocument(); await documentSession.close(); }
} finally {
  if (previousMediaHome === undefined) delete process.env.LIGULE_HOME;
  else process.env.LIGULE_HOME = previousMediaHome;
}
const { detectPermissionCapabilities } = await import(pathToFileURL(join(coreRoot, 'dist', 'capability', 'permission-capabilities.js')).href);
const { createPermissionContext } = await import(pathToFileURL(join(coreRoot, 'dist', 'kernel', 'permission.js')).href);

const searchPlugin = createWebSearchPlugin({ provider: 'deepseek', serviceId: 'install-probe', apiKeyEnv: 'LIGULE_INSTALL_SEARCH_DISABLED_KEY' });
const searchCatalog = createKernel();
const unregisterSearchCatalog = searchPlugin.setup(searchCatalog);
try {
  const declared = searchCatalog.manifest().find(tool => tool.name === 'web_search');
  if (JSON.stringify(Object.keys(declared?.parameters.properties ?? {}).sort()) !== JSON.stringify(['count', 'query'])) {
    throw new Error('the installed search declaration exposes an unexpected argument');
  }
} finally { unregisterSearchCatalog(); }
const searchDenied = createKernel({ permission: createPermissionContext('read-only', 'disabled', {
  filesystemRead: 'full', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
}) });
const unregisterSearchDenied = searchPlugin.setup(searchDenied);
try {
  let blocked = false;
  try { await searchDenied.call('web_search', { query: 'installed permission check' }); }
  catch (error) { if (!error.code?.startsWith('permission_')) throw error; blocked = true; }
  if (!blocked) throw new Error('the installed search tool bypassed disabled network permission');
  console.log('web_search: exported schema and network denial checked without credentials or a service request');
} finally { unregisterSearchDenied(); }

if (typeof KernelError !== 'function') throw new Error('KernelError is missing from the installed package');
if (VERSION !== '${pkg.version}') throw new Error('the TUI compatibility entry did not preserve VERSION');
if (flagLayer(['limits.readBytes = 100']).limits?.readBytes !== 100) {
  throw new Error('the installed package cannot parse a dotted override, its TOML dependency did not come along');
}
console.log('TOML override: parsed');

const mcpKernel = createKernel();
const mcpDispose = createMcpPlugin(createMcpRegistry(mcpServerConfigs({}))).setup(mcpKernel);
if (typeof mcpDispose !== 'function' || mcpKernel.manifest().length !== 0) {
  throw new Error('an empty MCP registry registered tools or omitted its disposer');
}
mcpDispose();
console.log('MCP registry: initialized without servers');

const kernel = createKernel();
if (kernel.manifest().length !== 0) throw new Error('the installed kernel ships tools');
const dispose = kernel.register({
  name: 'smoke',
  description: 'installed package smoke test',
  parameters: { type: 'object', properties: {} },
  access: 'read',
  readOnly: true,
  run: async () => 'ok',
});
const [tool] = kernel.manifest();
if (!tool || tool.name !== 'smoke' || Object.keys(tool).length !== 3) {
  throw new Error(\`unexpected manifest entry: \${JSON.stringify(tool)}\`);
}
dispose();
if (kernel.manifest().length !== 0) throw new Error('dispose did not remove the tool');
console.log('kernel registry: add and dispose');

const detected = await detectPermissionCapabilities();
const permission = createPermissionContext('full-access', 'unrestricted', detected.capabilities);
try {
  const command = await execTool.run(
    { command: 'node --version' },
    { config: { boundary: process.cwd() }, permission, shell: withNativeExitCode(resolveShell({}), 'node --version') },
  );
  if (command.exitCode !== 0 || !command.text.includes(process.version)) {
    throw new Error('the installed package cannot execute a real command');
  }
  console.log('command execution: node --version');
} catch (error) {
  if (detected.capabilities.process === 'full'
    || error?.code !== 'permission_process_isolation_unavailable') throw error;
  console.log('command execution: refused without process ownership');
}

const bash = await parseCommand('git status');
const pwsh = await parseCommand('Get-ChildItem -Recurse | Select-Object -First 3');
if (bash.kind !== 'segments' || pwsh.kind !== 'segments') {
  throw new Error(\`grammar did not load: bash \${bash.kind}, pwsh \${pwsh.kind}\`);
}
console.log(\`grammar: bash \${bash.segments.length} segments, pwsh \${pwsh.segments.length} segments\`);

const backend = await resolveRipgrep({});
const found = typeof backend?.executable === 'string' && existsSync(backend.executable);
if (!found) {
  throw new Error(\`search backend is missing for the supported target: \${JSON.stringify(backend)}\`);
}
console.log(\`search backend: @vscode/ripgrep@${pkg.dependencies['@vscode/ripgrep']}; \${backend.executable}\`);
mkdirSync('fixture', { recursive: true });
writeFileSync('fixture/needle.txt', 'LIGULE-INSTALL-NEEDLE\\n');
const hits = await searchWithRipgrep({ executable: backend.executable, boundary: process.cwd(), target: 'fixture', pattern: 'LIGULE-INSTALL-NEEDLE', limit: 5 });
console.log(\`search results: \${JSON.stringify(hits).slice(0, 200)}\`);
if (JSON.stringify(hits).includes('LIGULE-INSTALL-NEEDLE') === false) throw new Error('the packaged search backend ran but did not find the needle');
`, 'utf8');

const probe = spawnSync(process.execPath, ['probe.mjs'], { cwd: consumer, env, encoding: 'utf8' });
if (probe.status !== 0) {
  const documentSteps = (probe.stdout ?? '').split(/\r?\n/u).filter(line => line.startsWith('read_document:')).slice(-8).join('\n');
  const diagnosticTail = (probe.stderr ?? '').slice(-500);
  throw new Error(`the installed package failed its own probe (status ${probe.status}):\n${[documentSteps, diagnosticTail].filter(Boolean).join('\n')}`);
}
for (const line of probe.stdout.trim().split('\n')) readings.push(line);

const mcpProject = join(consumer, 'mcp-project');
const mcpHome = join(consumer, 'mcp-home');
mkdirSync(mcpProject, { recursive: true });
mkdirSync(mcpHome, { recursive: true });
writeFileSync(join(consumer, 'mcp-probe.mjs'), `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const corePackage = join(${JSON.stringify(bundledCoreDirectory)}, 'package.json');
const coreRequire = createRequire(corePackage);
const { Client } = coreRequire('@modelcontextprotocol/sdk/client');
const { StdioClientTransport, getDefaultEnvironment } = coreRequire('@modelcontextprotocol/sdk/client/stdio.js');
const expected = [
  'ligule_interaction_reply', 'ligule_run', 'ligule_run_await', 'ligule_run_cancel', 'ligule_run_get', 'ligule_run_start', 'ligule_run_status', 'ligule_session_close', 'ligule_session_configure',
  'ligule_session_create', 'ligule_session_list', 'ligule_session_open', 'ligule_session_read', 'ligule_session_send', 'ligule_usage_get',
].sort();
const projectRoot = ${JSON.stringify(mcpProject)};
const { setTrusted } = await import(pathToFileURL(join(${JSON.stringify(bundledCoreDirectory)}, 'dist', 'kernel', 'workspace-trust.js')).href);
await setTrusted(projectRoot, true, join(${JSON.stringify(mcpHome)}, 'tui-trust.json'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(${JSON.stringify(installedPackageRoot)}, 'dist', 'cli.js'), 'mcp-server', '--project', projectRoot],
  cwd: ${JSON.stringify(consumer)},
  env: { ...getDefaultEnvironment(), LIGULE_HOME: ${JSON.stringify(mcpHome)} },
  stderr: 'pipe',
});
const client = new Client({ name: 'ligule-install-probe', version: '0.0.0' });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, name + ' returned an MCP tool error');
  assert.equal(typeof result.structuredContent, 'object', name + ' structured result');
  return result.structuredContent;
}
let timeout;
try {
  const probe = (async () => {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), expected, 'published MCP tool names');
    for (const tool of tools) {
      assert.equal(tool.inputSchema?.type, 'object', tool.name + ' input schema');
      assert.equal(typeof tool.description, 'string', tool.name + ' description');
    }
    const existingSession = process.argv[2];
    if (existingSession === undefined) {
      const created = await call('ligule_session_create', { projectRoot });
      assert.equal(typeof created.sessionId, 'string', 'created session ID');
      const listed = await call('ligule_session_list', { projectRoot, limit: 50 });
      assert.ok(listed.sessions.some(({ sessionId }) => sessionId === created.sessionId), 'created session appears in project list');
      await call('ligule_session_open', { projectRoot, sessionId: created.sessionId });
      const history = await call('ligule_session_read', { sessionId: created.sessionId, limit: 10 });
      assert.equal(history.sessionId, created.sessionId);
      assert.ok(Array.isArray(history.records));
      writeFileSync(join(process.cwd(), 'mcp-session-id'), created.sessionId + '\\n');
      console.log('stdio MCP: initialize, tools/list, create/list/open/read passed');
    } else {
      await call('ligule_session_open', { projectRoot, sessionId: existingSession });
      const history = await call('ligule_session_read', { sessionId: existingSession, limit: 10 });
      assert.equal(history.sessionId, existingSession);
      assert.ok(Array.isArray(history.records));
      console.log('stdio MCP: reopened the session after client disconnect; record lock was released');
    }
  })();
  await Promise.race([probe, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('MCP client operation timed out')), 30_000);
  })]);
} finally {
  if (timeout !== undefined) clearTimeout(timeout);
  await client.close();
}
`, 'utf8');

const mcpProbe = spawnSync(process.execPath, ['mcp-probe.mjs'], { cwd: consumer, env, encoding: 'utf8', timeout: 45_000 });
if (mcpProbe.status !== 0) {
  throw new Error(`the installed package failed its stdio MCP probe (status=${mcpProbe.status}, signal=${mcpProbe.signal}, error=${mcpProbe.error?.message ?? 'none'}): ${(mcpProbe.stderr ?? '').slice(0, 1200)}`);
}
for (const line of mcpProbe.stdout.trim().split('\n')) readings.push(line);
const createdSessionId = readFileSync(join(consumer, 'mcp-session-id'), 'utf8').trim();
const reopenProbe = spawnSync(process.execPath, ['mcp-probe.mjs', createdSessionId], { cwd: consumer, env, encoding: 'utf8', timeout: 45_000 });
if (reopenProbe.status !== 0) {
  throw new Error(`the installed MCP server could not reopen its session after disconnect (status=${reopenProbe.status}, signal=${reopenProbe.signal}, error=${reopenProbe.error?.message ?? 'none'}): ${(reopenProbe.stderr ?? '').slice(0, 1200)}`);
}
for (const line of reopenProbe.stdout.trim().split('\n')) readings.push(line);

for (const line of readings) process.stdout.write(`${line}\n`);
process.stdout.write(`fresh install ok: ${pkg.name}-${pkg.version}.tgz\n`);
