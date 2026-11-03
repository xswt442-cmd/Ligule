import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse, parseAllDocuments } from '../core/node_modules/yaml/dist/index.js';
import { releaseManifest } from '../scripts/pack-release.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

type NodePin = { version: string; targets: Record<string, { file: string; sha256: string }> };

function firstGroup(text: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(text);
  assert.ok(match, `no ${pattern} match in ${label}`);
  return match[1];
}

const workflows = ['ci.yml', 'tag.yml', 'npm-publish.yml', 'desktop-publish.yml'];

test('the runtime floor is one value across package metadata, README and workflows', () => {
  const pkg = JSON.parse(read('../tui/package.json'));
  const engines = firstGroup(pkg.engines.node, /^>=(\d+)$/, 'package.json engines.node');
  const badge = firstGroup(read('../tui/README.md'), /message=%3E%3D(\d+)/, 'README badge');

  assert.equal(badge, engines, 'the README badge and engines.node disagree');
  for (const file of workflows) {
    const declared = firstGroup(read(`../.github/workflows/${file}`), /PRIMARY_NODE_VERSION: '(\d+)'/, file);
    assert.equal(declared, engines, `${file} and engines.node disagree`);
  }
  // 保持 Node 与类型定义的主版本一致，避免本地类型检查通过但目标运行时缺少接口。
  const types = firstGroup(pkg.devDependencies['@types/node'], /^\^?(\d+)\./, 'devDependencies @types/node');
  assert.equal(types, engines, '@types/node describes a different Node major version than engines.node');
});

test('the package description carries both languages', () => {
  const description = JSON.parse(read('../tui/package.json')).description;
  assert.match(description, /[\u4e00-\u9fff]/, 'the Chinese part of the description is missing');
  assert.match(description, /[A-Za-z]{4,}\s+[A-Za-z]{4,}/, 'the English part of the description is missing');
});

test('Core workspace metadata is private, documented, and licensed without a product version', () => {
  const core = JSON.parse(read('../core/package.json'));
  assert.equal(core.name, '@ligule/core');
  assert.equal(core.private, true);
  assert.equal(Object.hasOwn(core, 'version'), false);
  assert.ok(core.files.includes('README.md'));
  assert.ok(core.files.includes('LICENSE'));
  const coreReadme = read('../core/README.md');
  const coreReadmeEnglish = read('../core/README.en.md');
  assert.match(coreReadme, /不单独发布 npm、版本号、Changelog 或 Tag/);
  assert.match(coreReadmeEnglish, /no standalone npm publication, version, changelog, or release tag/);
  assert.match(coreReadme, /tui → core ← desktop/);
  assert.match(coreReadmeEnglish, /tui → core ← desktop/);
  assert.match(read('../core/LICENSE'), /MIT License/);
});

test('fixtures have one owner: Core, TUI, or shared cross-module tests', () => {
  const owners = new Map();
  for (const directory of ['core/tests/fixtures', 'tui/tests/fixtures', 'tests/fixtures']) {
    for (const name of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
      const previous = owners.get(name);
      assert.equal(previous, undefined, `${name} is duplicated in ${previous} and ${directory}`);
      owners.set(name, directory);
    }
  }
  assert.equal(owners.get('mcp-minimal.mjs'), 'tests/fixtures');
  assert.equal(owners.get('register-workspace.mjs'), 'tests/fixtures');
  assert.equal(owners.get('editor.mjs'), 'tui/tests/fixtures');
  assert.equal(owners.get('credential-read.mjs'), 'core/tests/fixtures');
});

test('the ripgrep runtime uses the upstream platform-selecting dependency', () => {
  const pkg = JSON.parse(read('../core/package.json'));
  const release = releaseManifest();
  const provider = JSON.parse(read('../core/node_modules/@vscode/ripgrep/package.json'));
  assert.equal(pkg.dependencies['@vscode/ripgrep'], '1.18.0');
  assert.equal(release.dependencies['@ligule/core'], '*');
  assert.ok(release.bundledDependencies.includes('@ligule/core'));
  assert.deepEqual(
    ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'].map((target) => provider.optionalDependencies[`@vscode/ripgrep-${target}`]),
    ['1.18.0', '1.18.0', '1.18.0', '1.18.0'],
  );
  assert.equal(Object.keys(release.optionalDependencies).some((name) => name.startsWith('ligule-rg-')), false);
});

test('the public CLI separates its bundled JavaScript parser from consumer-platform dependencies', () => {
  const core = JSON.parse(read('../core/package.json'));
  const release = releaseManifest();
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(core[field] ?? {})) {
      if (release.bundledDependencies.includes(name)) {
        assert.equal(name, 'xlsx', 'native runtime dependencies must remain consumer-installed');
        const fromCore = createRequire(new URL('../core/package.json', import.meta.url));
        assert.equal(release[field]?.[name], fromCore(name).version);
      } else {
        assert.equal(release[field]?.[name], version, `${name} must be installed by the consumer for its own platform`);
      }
    }
  }
});

test('workflows take the Node version from their own env instead of repeating it', () => {
  for (const file of workflows) {
    assert.doesNotMatch(read(`../.github/workflows/${file}`), /node-version:\s*['"]?\d/, `${file} hardcodes a Node version`);
  }
});

test('the pinned pnpm workspace lock covers all manifests and dependency specifiers', () => {
  const root = JSON.parse(read('../package.json'));
  assert.equal(root.packageManager, 'pnpm@12.9.1');
  assert.equal(releaseManifest().packageManager, undefined, 'the npm release manifest must not pin the workspace package manager');
  const workspace = parse(read('../pnpm-workspace.yaml'));
  assert.deepEqual(workspace.packages, ['core', 'tui', 'desktop', 'desktop/frontend']);
  const documents = parseAllDocuments(read('../pnpm-lock.yaml'));
  assert.ok(documents.length >= 2, 'the pinned package manager must be recorded in the environment lock document');
  for (const document of documents) assert.deepEqual(document.errors, [], 'pnpm-lock.yaml must parse as multi-document YAML');
  const environment = documents[0].toJSON();
  assert.equal(environment.lockfileVersion, '9.0');
  assert.equal(environment.importers['.'].packageManagerDependencies.pnpm.version, '12.9.1');
  const lock = documents.at(-1)!.toJSON();
  assert.equal(lock.lockfileVersion, '9.0');
  const packages = [
    ['.', '../package.json'],
    ['core', '../core/package.json'],
    ['tui', '../tui/package.json'],
    ['desktop', '../desktop/package.json'],
    ['desktop/frontend', '../desktop/frontend/package.json'],
  ];
  assert.deepEqual(Object.keys(lock.importers).sort(), packages.map(([path]) => path).sort());
  for (const [path, manifestPath] of packages) {
    const manifest = JSON.parse(read(manifestPath));
    const importer = lock.importers[path];
    for (const type of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      assert.deepEqual(Object.keys(importer[type] ?? {}).sort(), Object.keys(manifest[type] ?? {}).sort(), `${path} ${type} entries disagree`);
      for (const [name, specifier] of Object.entries(manifest[type] ?? {})) {
        assert.equal(importer[type][name].specifier, specifier, `${path} ${type}.${name} specifier disagrees`);
      }
    }
  }
});

// Node 运行时的版本与校验值由 desktop/node-pin.json 统一维护，发行文档链接到该文件。
test('the vendored Node targets use the documented pin file', () => {
  const pin = JSON.parse(read('../desktop/node-pin.json')) as NodePin;
  const releaseGuide = read('../docs/development/RELEASE.md');
  const suffixes: Record<string, string> = { 'win32-x64': 'zip', 'linux-x64': 'tar.xz', 'darwin-arm64': 'tar.gz', 'darwin-x64': 'tar.gz' };
  assert.deepEqual(Object.keys(pin.targets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  for (const [target, archived] of Object.entries(pin.targets)) {
    const expected = `node-${pin.version}-${target.replace('win32', 'win')}.${suffixes[target]}`;
    assert.equal(archived.file, expected, `${target} pins ${archived.file}, upstream calls it ${expected}`);
    assert.match(archived.sha256, /^[0-9a-f]{64}$/, `${target} sha256 is not a lowercase hex digest`);
  }
  assert.match(releaseGuide, /desktop\/node-pin\.json/);
});

test('Electron excludes Core native dependencies from the Electron ABI bundle', () => {
  const builder = read('../desktop/electron-builder.cjs');
  assert.match(builder, /npmRebuild:\s*false/);
  assert.match(builder, /'!node_modules\/\*\*'/);
  assert.match(builder, /from: 'vendor\/app', to: 'app'/);
});

test('the Desktop runtime deploy contains only its manifest and production dependencies', () => {
  const desktop = JSON.parse(read('../desktop/package.json'));
  const fetchRuntime = read('../desktop/fetch-runtime.mjs');
  const checker = read('../desktop/check-runtime.mjs');
  const builder = read('../desktop/electron-builder.cjs');
  const metadataCleanup = fetchRuntime.indexOf('for (const metadataPath of [');
  const deployValidation = fetchRuntime.indexOf('await assertDeploySourceShape(stagedApp);');
  const packageProjection = fetchRuntime.indexOf("await rename(join(stagedApp, 'package.json'), join(projectedApp, 'package.json'));");
  const moduleProjection = fetchRuntime.indexOf("await rename(join(stagedApp, 'node_modules'), join(projectedApp, 'node_modules'));");
  const runtimeCheck = checker.slice(checker.indexOf('async function assertRuntimeAppContents'));

  assert.deepEqual(desktop.files, ['package.json']);
  assert.ok(metadataCleanup >= 0 && metadataCleanup < deployValidation, 'pnpm deploy metadata is removed before validating the staging package');
  assert.ok(deployValidation < packageProjection && packageProjection < moduleProjection, 'the validated deploy is explicitly projected to only its manifest and dependencies');
  assert.match(fetchRuntime, /const stagedApp = join\(stagingRoot, 'package'\)/);
  assert.match(fetchRuntime, /const projectedApp = join\(stagingRoot, 'runtime-app'\)/);
  assert.match(fetchRuntime, /README\.en\.md/);
  assert.match(fetchRuntime, /electron\/dist\/\*/);
  assert.match(fetchRuntime, /assertInsideRuntimeStaging\(stagingRoot, scratchRoot\)/);
  assert.match(builder, /\{ from: 'vendor\/app', to: 'app', filter: \['package\.json'\] \}/);
  assert.match(builder, /\{ from: 'vendor\/app\/node_modules', to: 'app\/node_modules' \}/);
  assert.match(checker, /await assertRuntimeAppContents\(app\)/);
  assert.match(checker, /the Desktop runtime app root has unexpected or missing entries/);
  assert.match(runtimeCheck, /\['node_modules', 'directory'\]/);
  assert.match(runtimeCheck, /\['package.json', 'file'\]/);
  assert.doesNotMatch(runtimeCheck, /README\.md|LICENSE/);
});
