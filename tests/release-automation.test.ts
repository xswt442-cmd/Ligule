import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse as parseYaml } from '../core/node_modules/yaml/dist/index.js';
import { changelogSection, desktopDownloadTable, releaseNotesForTag } from '../scripts/release-notes.js';
import { createDesktopReleaseManifest, verifyDesktopReleaseManifests } from '../scripts/desktop-release-manifest.ts';
import { githubAssetName, verifyDesktopDraft } from '../scripts/verify-desktop-draft.js';
import { prepareRelease, requestedVersionAtRoot, resolveVersion } from '../scripts/release-version.js';

const CHANGELOG = `# 更新记录 / Changelog

## [Unreleased]

### 简体中文

#### 修复

- 修复待发布的缺陷。

### English

#### Fixed

- Fixed an unreleased bug.

## [0.0.1] - 2026-09-29

### 简体中文

初始公开版本。

### English

Initial public release.
`;

type WorkflowStep = { name?: string; run?: string; uses?: string; shell?: string; with?: Record<string, any> };
type WorkflowJob = {
  steps: WorkflowStep[];
  strategy: any;
  needs: any;
  permissions: any;
  [key: string]: any;
};
type Workflow = { on: any; jobs: Record<string, WorkflowJob>; permissions: any };

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture() {
  const parent = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'release-automation-'));
  const version = '0.0.1';
  const desktopVersion = '2.4.1';
  const packageManifest = { name: 'ligule', version, dependencies: { '@ligule/core': 'workspace:*' }, optionalDependencies: {} };
  await writeJson(join(directory, 'tui', 'package.json'), packageManifest);
  await writeJson(join(directory, 'desktop', 'package.json'), { name: 'ligule-desktop', version: desktopVersion });
  await writeJson(join(directory, 'desktop', 'frontend', 'package.json'), { name: 'ligule-desktop-frontend', private: true, version: '7.6.5' });
  const lock = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  tui: {}\n  desktop: {}\n  desktop/frontend: {}\n";
  await writeFile(join(directory, 'pnpm-lock.yaml'), lock, 'utf8');
  await mkdir(join(directory, 'tui', 'src'), { recursive: true });
  await writeFile(join(directory, 'tui', 'src', 'version.ts'), `// Keep this comment.\nexport const VERSION = '${version}';\n`, 'utf8');
  await writeFile(join(directory, 'tui', 'CHANGELOG.md'), CHANGELOG, 'utf8');
  await writeFile(join(directory, 'desktop', 'CHANGELOG.md'), CHANGELOG.replace('0.0.1', desktopVersion), 'utf8');
  return directory;
}

test('version requests resolve supported bump types and reject invalid or older versions', () => {
  assert.equal(resolveVersion('0.0.2', 'patch'), '0.0.3');
  assert.equal(resolveVersion('0.0.2', 'minor'), '0.1.0');
  assert.equal(resolveVersion('0.0.2', 'major'), '1.0.0');
  assert.throws(() => resolveVersion('0.0.2', '0.0.2'), /must be newer than current/);
  assert.throws(() => resolveVersion('0.0.2', '0.0.1'), /must be newer than current/);
  assert.throws(() => resolveVersion('0.0.2', 'v0.0.3'), /stable X\.Y\.Z/);
});

test('CLI preparation changes only CLI files and leaves Desktop files byte-for-byte unchanged', async () => {
  const directory = await fixture();
  try {
    const desktopFiles = ['desktop/package.json', 'desktop/frontend/package.json', 'desktop/CHANGELOG.md'];
    const before = await Promise.all(desktopFiles.map(async (path): Promise<[string, Buffer]> => [path, await readFile(join(directory, path))]));
    const manifestBefore = await readFile(join(directory, 'tui', 'package.json'), 'utf8');
    const expectedManifest = manifestBefore.replace(/^  ("version"\s*:\s*)"0\.0\.1"/m, '  $1"0.0.2"');
    const result = prepareRelease(`${directory}${sep}`, 'cli', 'patch');
    assert.equal(result.version, '0.0.2');
    assert.equal(result.tag, 'cli-v0.0.2');
    assert.deepEqual(result.files.map((path) => path.replaceAll('\\', '/')), ['tui/CHANGELOG.md', 'tui/package.json', 'tui/src/version.ts']);
    for (const [path, contents] of before) assert.deepEqual(await readFile(join(directory, path)), contents, path);
    assert.equal(await readFile(join(directory, 'tui', 'package.json'), 'utf8'), expectedManifest);
    assert.equal(JSON.parse(await readFile(join(directory, 'tui', 'package.json'), 'utf8')).version, '0.0.2');
    assert.equal(await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8'), "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  tui: {}\n  desktop: {}\n  desktop/frontend: {}\n");
    assert.match(await readFile(join(directory, 'tui', 'src', 'version.ts'), 'utf8'), /Keep this comment/);
    assert.match(await readFile(join(directory, 'tui', 'src', 'version.ts'), 'utf8'), /VERSION = '0\.0\.2'/);
    const changelog = await readFile(join(directory, 'tui', 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /## \[Unreleased\]\n\n## \[0\.0\.2\]/);
    assert.match(changelog, /## \[0\.0\.2\][\s\S]*### 简体中文[\s\S]*修复待发布的缺陷[\s\S]*### English[\s\S]*Fixed an unreleased bug/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preparation updates the root version when nested manifests also have a version', async () => {
  const directory = await fixture();
  try {
    const manifestPath = join(directory, 'tui', 'package.json');
    const manifest = await readFile(manifestPath, 'utf8');
    const nestedFirst = manifest.replace(
      /\{\n  "name": "ligule",\n  "version": "0\.0\.1",/,
      '{\n  "metadata": { "version": "9.8.7" },\n  "name": "ligule",\n  "version": "0.0.1",',
    );
    await writeFile(manifestPath, nestedFirst, 'utf8');
    prepareRelease(directory, 'cli', 'patch');
    const updated = await readFile(manifestPath, 'utf8');
    assert.deepEqual(JSON.parse(updated), { ...JSON.parse(nestedFirst), version: '0.0.2' });
    assert.match(updated, /"metadata": \{ "version": "9\.8\.7" \}/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preparation accepts top-level version keys with no indentation', async () => {
  const directory = await fixture();
  try {
    const cliManifestPath = join(directory, 'tui', 'package.json');
    const cliManifest = (await readFile(cliManifestPath, 'utf8')).replace(/^  ("version"\s*:)/m, '$1');
    await writeFile(cliManifestPath, cliManifest, 'utf8');
    prepareRelease(directory, 'cli', 'patch');
    assert.equal(JSON.parse(await readFile(cliManifestPath, 'utf8')).version, '0.0.2');
    assert.match(await readFile(cliManifestPath, 'utf8'), /^("version"\s*:\s*"0\.0\.2"),?$/m);

    const desktopManifestPath = join(directory, 'desktop', 'package.json');
    const desktopManifest = (await readFile(desktopManifestPath, 'utf8')).replace(/^  ("version"\s*:)/m, '$1');
    await writeFile(desktopManifestPath, desktopManifest, 'utf8');
    prepareRelease(directory, 'desktop', 'patch');
    assert.equal(JSON.parse(await readFile(desktopManifestPath, 'utf8')).version, '2.4.2');
    assert.match(await readFile(desktopManifestPath, 'utf8'), /^("version"\s*:\s*"2\.4\.2"),?$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Desktop preparation changes only Desktop installer metadata and its changelog', async () => {
  const directory = await fixture();
  try {
    const cliFiles = ['tui/package.json', 'tui/src/version.ts', 'tui/CHANGELOG.md', 'desktop/frontend/package.json'];
    const before = await Promise.all(cliFiles.map(async (path): Promise<[string, Buffer]> => [path, await readFile(join(directory, path))]));
    const lock = await readFile(join(directory, 'pnpm-lock.yaml'));
    const result = prepareRelease(directory, 'desktop', 'patch');
    assert.equal(result.version, '2.4.2');
    assert.equal(result.tag, 'desktop-v2.4.2');
    assert.deepEqual(result.files.map((path) => path.replaceAll('\\', '/')), ['desktop/CHANGELOG.md', 'desktop/package.json']);
    for (const [path, contents] of before) assert.deepEqual(await readFile(join(directory, path)), contents, path);
    assert.deepEqual(await readFile(join(directory, 'pnpm-lock.yaml')), lock);
    assert.equal(JSON.parse(await readFile(join(directory, 'desktop/package.json'), 'utf8')).version, '2.4.2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preparation rejects an incomplete bilingual entry before writing version files', async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, 'tui', 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### 简体中文\n\n只有中文。\n', 'utf8');
    await assert.rejects(async () => prepareRelease(directory, 'cli', 'patch'), /needs content under ### English/);
    const manifest = JSON.parse(await readFile(join(directory, 'tui', 'package.json'), 'utf8'));
    assert.equal(manifest.version, '0.0.1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release notes select each product changelog and matching bilingual version section', async () => {
  const directory = await fixture();
  try {
    const cliNotes = releaseNotesForTag(directory, 'cli-v0.0.1');
    assert.match(cliNotes, /^## CLI \/ TUI v0\.0\.1$/m);
    assert.doesNotMatch(cliNotes, /更新说明|Release highlights|CLI\/TUI 通过 npm|This GitHub Release contains bilingual notes/);
    assert.match(cliNotes, /初始公开版本/);
    assert.match(cliNotes, /Initial public release/);
    assert.doesNotMatch(cliNotes, /下载|Downloads/);
    assert.match(cliNotes, /npm install -g ligule@0\.0\.1/);
    assert.match(cliNotes, /npmjs\.com\/package\/ligule\/v\/0\.0\.1/);
    const cliChinese = cliNotes.indexOf('### 简体中文');
    const cliEnglish = cliNotes.indexOf('### English');
    assert.ok(cliChinese < cliNotes.indexOf('#### 安装与启动') && cliNotes.indexOf('#### 安装与启动') < cliEnglish);
    assert.ok(cliEnglish < cliNotes.indexOf('#### Install and run'));
    const desktopPreview = releaseNotesForTag(directory, 'desktop-v2.4.1');
    assert.match(desktopPreview, /^## Desktop v2\.4\.1$/m);
    assert.doesNotMatch(desktopPreview, /更新说明|Release highlights|macOS|## 下载 \/ Downloads/);
    assert.match(desktopPreview, /SHA-256/);
    assert.match(desktopPreview, /\| Windows x64 \| NSIS/);
    assert.match(desktopPreview, /\| Linux x64 \| AppImage/);
    assert.match(desktopPreview, /\| Linux x64 \| deb/);
    assert.match(desktopPreview, /releases\/tag\/desktop-v2\.4\.1#assets/);
    const desktopChinese = desktopPreview.indexOf('### 简体中文');
    const desktopEnglish = desktopPreview.indexOf('### English');
    assert.ok(desktopChinese < desktopPreview.indexOf('#### 下载') && desktopPreview.indexOf('#### 下载') < desktopEnglish);
    assert.ok(desktopEnglish < desktopPreview.indexOf('#### Downloads'));
    assert.match(desktopPreview, /\| 操作系统 \| 格式 \| 用途 \| 下载 \|/);
    assert.match(desktopPreview, /\| OS \| Package \| Use \| Download \|/);
    assert.doesNotMatch(desktopPreview, /draft Release after platform validation|草稿 Release/);
    const historicalDesktopNotes = releaseNotesForTag(process.cwd(), 'desktop-v0.0.4');
    assert.doesNotMatch(historicalDesktopNotes, /macOS|更新说明|Release highlights/);
    const commit = 'a'.repeat(40);
    const manifest = {
      schemaVersion: 1,
      product: 'desktop',
      tag: 'desktop-v2.4.1',
      version: '2.4.1',
      sourceCommit: commit,
      assets: [
        { target: 'windows-x64', architecture: 'x64', name: `ligule-desktop-v2.4.1-windows-x64-${commit.slice(0, 12)}-ligule Setup 2.4.1.exe`, sha256: 'b'.repeat(64) },
        { target: 'linux-x64', architecture: 'x64', name: `ligule-desktop-v2.4.1-linux-x64-${commit.slice(0, 12)}-ligule-2.4.1.AppImage`, sha256: 'c'.repeat(64) },
        { target: 'linux-x64', architecture: 'x64', name: `ligule-desktop-v2.4.1-linux-x64-${commit.slice(0, 12)}-ligule-desktop_2.4.1_amd64.deb`, sha256: 'd'.repeat(64) },
      ],
    };
    const downloadableNotes = releaseNotesForTag(directory, 'desktop-v2.4.1', { manifest });
    assert.match(downloadableNotes, /releases\/download\/desktop-v2\.4\.1\/.*-ligule\.Setup\.2\.4\.1\.exe/);
    assert.match(downloadableNotes, /releases\/download\/desktop-v2\.4\.1\/.*\.AppImage/);
    assert.match(downloadableNotes, /releases\/download\/desktop-v2\.4\.1\/.*\.deb/);
    assert.match(downloadableNotes, /desktop-release-manifest\.json/);
    assert.doesNotMatch(downloadableNotes, /%20|草稿 Release/);
    assert.doesNotMatch(downloadableNotes, /macOS|更新说明|Release highlights|## 下载 \/ Downloads/);
    assert.throws(() => desktopDownloadTable('cli-v2.4.1'), /Desktop tag/);
    assert.throws(() => releaseNotesForTag(directory, 'cli-v0.0.1', { manifest }), /do not accept/);
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1', { manifest: { ...manifest, tag: 'desktop-v2.4.2' } }), /verified manifest/);
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1', {
      manifest: { ...manifest, assets: manifest.assets.slice(0, 2) },
    }), /verified manifest/);
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1', {
      manifest: { ...manifest, assets: manifest.assets.map((asset, i) => i === 0 ? { ...asset, name: '../unsafe.exe' } : asset) },
    }), /missing or duplicate Desktop asset|invalid asset identity/);
    assert.throws(() => requestedVersionAtRoot(directory, 'unknown', 'patch'), /product must be cli or desktop/);
    assert.throws(() => requestedVersionAtRoot(directory, '__proto__', 'patch'), /product must be cli or desktop/);
    assert.throws(() => changelogSection(CHANGELOG, '0.0.2'), /exactly one/);
    assert.throws(() => releaseNotesForTag(directory, 'v0.0.1'), /cli-vX\.Y\.Z/);
    await writeFile(join(directory, 'desktop', 'CHANGELOG.md'), CHANGELOG, 'utf8');
    assert.throws(() => releaseNotesForTag(directory, 'desktop-v2.4.1'), /exactly one/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Desktop release manifests require Windows and Linux installers and bind them to the tagged source', async () => {
  const directory = await fixture();
  const output = join(directory, 'artifacts');
  const commit = 'a'.repeat(40);
  const runId = '12345';
  try {
    await mkdir(output, { recursive: true });
    for (const [target, names] of Object.entries({
      'windows-x64': ['Ligule Setup 2.4.2.exe'],
      'linux-x64': ['Ligule-2.4.2.AppImage', 'ligule_2.4.2_amd64.deb'],
    })) {
      const targetDirectory = join(output, target);
      await mkdir(targetDirectory);
      const sourceDirectory = join(directory, `${target}-source`);
      await mkdir(sourceDirectory);
      for (const name of names) await writeFile(join(sourceDirectory, name), `${target}:${name}`);
      createDesktopReleaseManifest({ directory: sourceDirectory, outputDirectory: targetDirectory, version: '2.4.2', target, commit, runId });
    }
    const result = verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId });
    assert.deepEqual(result.targets, ['linux-x64', 'windows-x64']);
    assert.equal(result.assets.length, 3);
    const stableManifestPath = join(output, 'desktop-release-manifest.json');
    const stableManifest = await readFile(stableManifestPath);
    assert.doesNotMatch(stableManifest.toString(), /workflowRunId/);
    assert.throws(() => createDesktopReleaseManifest({ directory: output, version: '2.4.2', target: 'macos-arm64', commit, runId }), /unsupported desktop target/);

    const incompleteLinux = join(directory, 'incomplete-linux');
    await mkdir(incompleteLinux);
    await writeFile(join(incompleteLinux, 'ligule_2.4.2.AppImage'), 'AppImage');
    await writeFile(join(incompleteLinux, 'ligule_2.4.2_amd64.deb'), 'first Debian package');
    await writeFile(join(incompleteLinux, 'ligule_2.4.2_arm64.deb'), 'second Debian package');
    assert.throws(() => createDesktopReleaseManifest({ directory: incompleteLinux, version: '2.4.2', target: 'linux-x64', commit, runId }), /exactly one \.deb installer; found 2/);
    const missingLinux = join(directory, 'missing-linux');
    await mkdir(missingLinux);
    await writeFile(join(missingLinux, 'ligule_2.4.2.AppImage'), 'AppImage');
    assert.throws(() => createDesktopReleaseManifest({ directory: missingLinux, version: '2.4.2', target: 'linux-x64', commit, runId }), /exactly one \.deb installer; found 0/);

    for (const target of result.targets) {
      createDesktopReleaseManifest({
        directory: join(directory, `${target}-source`),
        outputDirectory: join(output, target),
        version: '2.4.2',
        target,
        commit,
        runId: '67890',
      });
    }
    verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' });
    assert.deepEqual(await readFile(stableManifestPath), stableManifest,
      'rebuilding identical installers in a different workflow run must keep the public manifest byte-for-byte stable');

    const optionalMacDirectory = join(output, 'macos-arm64');
    await mkdir(optionalMacDirectory);
    await writeFile(join(optionalMacDirectory, 'Ligule-2.4.2.dmg'), 'optional, unverified DMG');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected Desktop release target: macos-arm64/);
    await rm(optionalMacDirectory, { recursive: true });

    const unexpectedRootAsset = join(output, 'unexpected.dmg');
    await writeFile(unexpectedRootAsset, 'unverified DMG');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected file in Desktop release set: unexpected\.dmg/);
    await rm(unexpectedRootAsset);

    const unexpectedTargetAsset = join(output, 'linux-x64', 'unexpected.dmg');
    await writeFile(unexpectedTargetAsset, 'unverified DMG');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected file for linux-x64: unexpected\.dmg/);
    await rm(unexpectedTargetAsset);

    const windowsManifestPath = join(output, 'windows-x64', 'desktop-release-manifest-windows-x64.json');
    const windowsManifestBytes = await readFile(windowsManifestPath);
    await rm(windowsManifestPath);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /missing or invalid manifest for windows-x64/);
    await writeFile(windowsManifestPath, windowsManifestBytes);

    const linuxManifestPath = join(output, 'linux-x64', 'desktop-release-manifest-linux-x64.json');
    const linuxManifestBytes = await readFile(linuxManifestPath);
    const extraAssetManifest = JSON.parse(linuxManifestBytes.toString('utf8'));
    extraAssetManifest.assets.push({ name: 'unexpected.dmg', sha256: '0'.repeat(64) });
    await writeFile(linuxManifestPath, `${JSON.stringify(extraAssetManifest, null, 2)}\n`);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /unexpected installer count/);
    await writeFile(linuxManifestPath, linuxManifestBytes);

    const malformedLinux = JSON.parse(linuxManifestBytes.toString('utf8'));
    malformedLinux.assets[0].name = malformedLinux.assets[1].name;
    await writeFile(linuxManifestPath, `${JSON.stringify(malformedLinux, null, 2)}\n`);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /exactly one \.AppImage installer/);
    await writeFile(linuxManifestPath, linuxManifestBytes);

    const manifest = JSON.parse(await readFile(windowsManifestPath, 'utf8'));
    await writeFile(join(output, 'windows-x64', manifest.assets[0].name), 'altered installer');
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '67890' }), /checksum mismatch/);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit: 'b'.repeat(40), runId: '67890' }), /does not match/);
    assert.throws(() => verifyDesktopReleaseManifests({ directory: output, version: '2.4.2', commit, runId: '99999' }), /does not match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('published Desktop draft verification accepts GitHub-normalized names but rejects tampering', async () => {
  const directory = await fixture();
  const artifacts = join(directory, 'artifacts');
  const draft = join(directory, 'draft');
  const commit = 'a'.repeat(40);
  const version = '2.4.2';
  const tag = 'desktop-v2.4.2';
  try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(draft);
    for (const [target, names] of Object.entries({
      'windows-x64': ['Ligule Setup 2.4.2.exe'],
      'linux-x64': ['Ligule-2.4.2.AppImage', 'ligule_2.4.2_amd64.deb'],
    })) {
      const source = join(directory, `${target}-source`);
      const output = join(artifacts, target);
      await mkdir(source);
      await mkdir(output);
      for (const name of names) await writeFile(join(source, name), `${target}:${name}`);
      createDesktopReleaseManifest({ directory: source, outputDirectory: output, version, target, commit, runId: '100' });
    }
    verifyDesktopReleaseManifests({ directory: artifacts, version, commit, runId: '100' });
    for (const file of ['SHA256SUMS', 'desktop-release-manifest.json']) {
      await copyFile(join(artifacts, file), join(draft, file));
    }
    const manifest = JSON.parse(await readFile(join(artifacts, 'desktop-release-manifest.json'), 'utf8')) as {
      assets: { target: string; name: string }[];
    };
    const checksums = await readFile(join(artifacts, 'SHA256SUMS'), 'utf8');
    const windowsAsset = manifest.assets.find((asset) => asset.target === 'windows-x64');
    assert.ok(windowsAsset);
    assert.match(checksums, new RegExp(`${windowsAsset.name.replaceAll(' ', '\\.')}\\n`));
    assert.doesNotMatch(checksums, /Ligule Setup 2\.4\.2\.exe/,
      'SHA256SUMS must name the Windows file as GitHub downloads it');
    for (const asset of manifest.assets) {
      await copyFile(join(artifacts, asset.target, asset.name), join(draft, githubAssetName(asset.name)));
    }

    assert.equal(githubAssetName('Ligule Setup 2.4.2.exe'), 'Ligule.Setup.2.4.2.exe');
    assert.equal(verifyDesktopDraft(draft, tag, commit).assets, 3);
    assert.throws(() => verifyDesktopDraft(draft, tag, 'b'.repeat(40)), /source commit/);

    const win = manifest.assets.find((asset) => asset.target === 'windows-x64');
    assert.ok(win);
    const winName = githubAssetName(win.name);
    await writeFile(join(draft, winName), 'tampered installer');
    assert.throws(() => verifyDesktopDraft(draft, tag, commit), /SHA-256 mismatch/);
    await copyFile(join(artifacts, win.target, win.name), join(draft, winName));

    await writeFile(join(draft, 'unverified.dmg'), 'untrusted asset');
    assert.throws(() => verifyDesktopDraft(draft, tag, commit), /missing or unexpected assets/);
    await rm(join(draft, 'unverified.dmg'));

    await writeFile(join(draft, 'SHA256SUMS'), 'incorrect checksums\n');
    assert.throws(() => verifyDesktopDraft(draft, tag, commit), /SHA256SUMS does not match/);
    await copyFile(join(artifacts, 'SHA256SUMS'), join(draft, 'SHA256SUMS'));
    assert.equal(verifyDesktopDraft(draft, tag, commit).assets, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release workflows split CI, tagging, and product publication and keep process tests after compilation', () => {
  const workflow = (name: string): Workflow => parseYaml(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as Workflow;
  const tag = workflow('tag');
  const npmPublish = workflow('npm-publish');
  const desktopPublish = workflow('desktop-publish');
  const ci = workflow('ci');

  assert.equal(tag.on.workflow_dispatch.inputs.action, undefined,
    'version preparation must be handled in normal development, not by a release-specific PR');
  assert.equal(tag.permissions.contents, 'read');
  assert.deepEqual(tag.jobs['create-tag'].permissions, { actions: 'read', contents: 'write' });
  assert.deepEqual(tag.on.workflow_dispatch.inputs.product.options, ['cli', 'desktop']);
  const setupJobs: [Workflow, string][] = [[npmPublish, 'npm'], [npmPublish, 'github-notes'], [desktopPublish, 'preflight'], [desktopPublish, 'draft'], [desktopPublish, 'publish']];
  for (const [workflowConfig, jobName] of setupJobs) {
    const setup = workflowConfig.jobs[jobName].steps.find((step) => step.uses === 'actions/setup-node@v7');
    assert.equal(setup?.with?.['package-manager-cache'], false,
      `${jobName} must disable pnpm auto-caching when pnpm is not installed`);
  }
  const createTag = tag.jobs['create-tag'].steps.map((step) => step.run ?? '').join('\n');
  assert.doesNotMatch(JSON.stringify(tag), /gh pr create|release\/\$\{tag\}|release\/\$\{TAG\}|pull-requests: write|git push origin "\$BRANCH"/i,
    'Tag workflow must not create product-specific PRs or version branches');
  assert.equal(tag.jobs['create-tag'].steps[0].with?.ref, '${{ github.sha }}');
  // Tags are cut from the main head only; dev merges back through normal review.
  assert.match(createTag, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(createTag, /package\.json; else manifest=desktop\/package\.json/);
  assert.match(createTag, /node scripts\/release-notes\.js "\$TAG"/);
  assert.match(createTag, /\$commit" != "\$main_head/);
  assert.match(createTag, /\$\{PRODUCT\}-v\$\{VERSION\}/);
  assert.match(createTag, /gh run list --workflow ci\.yml --branch main --event push --commit/);
  assert.match(createTag, /git ls-remote --exit-code --tags/);
  // A GITHUB_TOKEN tag push does not trigger push workflows; the workflow_dispatch
  // API call does, so the tag workflow hands publication over explicitly.
  assert.deepEqual(Object.keys(tag.jobs), ['create-tag', 'dispatch']);
  assert.equal(tag.jobs.dispatch.permissions.actions, 'write');
  const dispatchScript = tag.jobs.dispatch.steps.map((step) => step.run ?? '').join('\n');
  assert.match(dispatchScript, /gh workflow run npm-publish\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f tag="\$TAG"/);
  assert.match(dispatchScript, /gh workflow run desktop-publish\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f tag="\$TAG" -f publish=false/);
  assert.match(JSON.stringify(tag.jobs['create-tag']), /"outputs"/);
  assert.doesNotMatch(JSON.stringify(tag), /pull-requests: write/);

  assert.ok(npmPublish.on.workflow_dispatch);
  assert.equal(npmPublish.on.push, undefined);
  const cliNotesJob = npmPublish.jobs['github-notes'];
  assert.deepEqual(cliNotesJob.needs, ['preflight', 'npm']);
  assert.equal(cliNotesJob.permissions.contents, 'write');
  assert.equal(cliNotesJob.steps[0].with?.ref, '${{ needs.preflight.outputs.commit }}');
  const cliNotesScript = cliNotesJob.steps.map((step) => step.run ?? '').join('\n');
  assert.match(cliNotesScript, /npm view "ligule@\$\{VERSION\}" version/);
  assert.match(cliNotesScript, /release-notes\.js "\$TAG"/);
  assert.match(cliNotesScript, /gh release create "\$TAG"/);
  assert.match(cliNotesScript, /--latest=false/);
  assert.match(cliNotesScript, /if existing=\$\(gh release view/);
  assert.match(cliNotesScript, /\[ "\$existing" != false \]/);
  assert.doesNotMatch(cliNotesScript, /npm publish/);
  assert.match(JSON.stringify(npmPublish.jobs.preflight), /npm-publish must have at least one required reviewer/);
  assert.match(JSON.stringify(npmPublish.jobs.preflight), /required_reviewers/);
  assert.match(JSON.stringify(npmPublish.jobs.preflight), /merge-base --is-ancestor/,
    'publication accepts only tags that are part of the main history');
  // Approval is bound to the publishing job itself: the environment gate holds the
  // job until a required reviewer approves, then the job receives the OIDC token.
  assert.equal(Object.keys(npmPublish.jobs).includes('approval'), false);
  assert.equal(npmPublish.jobs.npm.environment, 'npm-publish');
  assert.deepEqual(npmPublish.jobs.npm.needs, ['preflight', 'checks', 'registry-check', 'verify']);
  assert.deepEqual(npmPublish.jobs.verify.needs, ['preflight', 'checks']);
  assert.equal(npmPublish.jobs.npm.permissions['id-token'], 'write');
  assert.doesNotMatch(JSON.stringify(npmPublish.jobs.npm), /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.match(JSON.stringify(npmPublish.jobs.preflight), /cli-v/);
  assert.ok(JSON.stringify(npmPublish).includes('pnpm install --frozen-lockfile'));
  assert.ok(npmPublish.jobs.npm.steps.some((step) => step.run?.includes('npm publish --provenance --access public')));
  assert.ok(npmPublish.jobs.checks.steps.some((step) => step.run?.includes('pnpm --filter ligule run pack-release dist-tarball')));
  // The tagged commit already passed the full suite on its branch; the publication
  // workflow must not re-run the whole test suite, only re-check the shipped bits.
  assert.doesNotMatch(JSON.stringify(npmPublish.jobs.checks), /pnpm test/);
  const releaseVerify = npmPublish.jobs.verify;
  assert.deepEqual(releaseVerify.strategy.matrix.os, ['ubuntu-24.04', 'windows-latest']);
  assert.ok(npmPublish.jobs.checks.steps.some((step) => step.uses === 'actions/upload-artifact@v7'
    && step.with?.name === 'npm-tarball'));
  assert.equal(releaseVerify.steps.filter((step) => step.uses === 'actions/download-artifact@v8')[0]?.with?.name, 'npm-tarball');
  assert.ok(releaseVerify.steps.some((step) => step.run?.includes('verify-install') && step.run.includes('realpath')),
    'Linux release verification must pass an absolute tarball path');
  assert.ok(releaseVerify.steps.some((step) => step.shell === 'pwsh' && step.run?.includes('verify-install') && step.run.includes('Resolve-Path')),
    'Windows release verification must pass a resolved absolute tarball path');
  for (const [label, steps] of [['shared CI', ci.jobs.test.steps]] as const) {
    const installBubblewrap = steps.findIndex((step) => step.name === 'install bubblewrap for Linux sandbox tests');
    const allowUserNamespaces = steps.findIndex((step) => step.name === 'allow bubblewrap user namespaces');
    const coreBuild = steps.findIndex((step) => step.name === 'build Core for required Linux sandbox probe');
    const requiredProbe = steps.findIndex((step) => step.name === 'require the Linux sandbox isolation probe');
    const fullTest = steps.findIndex((step) => step.name === 'test');
    assert.ok(installBubblewrap >= 0 && allowUserNamespaces > installBubblewrap && coreBuild > allowUserNamespaces
      && requiredProbe > coreBuild && fullTest > requiredProbe,
    `${label} must require the full sandbox probe before its test suite`);
    assert.match(steps[installBubblewrap].run ?? '', /sudo apt-get install -y bubblewrap/);
    const probeCommand = steps[requiredProbe].run ?? '';
    assert.match(probeCommand, /probeLinuxSandboxIsolation/);
    assert.match(probeCommand, /if \(!result\.available\)/);
  }
  assert.ok(ci.jobs['cli-package'].steps.some((step) => step.uses === 'actions/upload-artifact@v7'
    && step.with?.name === 'ligule-cli-tarball-${{ github.run_id }}'
    && step.with?.path === 'testplace/pack/*.tgz'
    && step.with?.overwrite === true));
  const ciConsumer = ci.jobs['cli-consumer'];
  assert.deepEqual(ciConsumer.needs, 'cli-package');
  assert.deepEqual(ciConsumer.strategy.matrix.os, ['ubuntu-24.04', 'windows-latest']);
  assert.equal(ciConsumer.steps.filter((step) => step.uses === 'actions/download-artifact@v8')[0]?.with?.name,
    'ligule-cli-tarball-${{ github.run_id }}');
  assert.ok(ciConsumer.steps.some((step) => step.run?.includes('verify-install') && step.run.includes('realpath')),
    'Linux CI verification must pass an absolute tarball path');
  assert.ok(ciConsumer.steps.some((step) => step.shell === 'pwsh' && step.run?.includes('verify-install') && step.run.includes('Resolve-Path')),
    'Windows CI verification must pass a resolved absolute tarball path');
  assert.doesNotMatch(JSON.stringify(npmPublish.jobs.npm), /pnpm|registry-version/,
    'the OIDC publication job consumes the already checked registry result and does not depend on an uninstalled helper');
  assert.equal(npmPublish.jobs.npm.needs.includes('registry-check'), true);
  const registrySteps = npmPublish.jobs['registry-check'].steps;
  const registryCommand = registrySteps.find((step) => step.name === 'compare the package tarball with the registry')?.run;
  assert.ok(registryCommand);
  assert.match(registryCommand, /pnpm --filter ligule run --silent registry-version "ligule@/);
  assert.match(registryCommand, /"\$GITHUB_WORKSPACE\/dist-tarball\/ligule-\$\{version\}\.tgz"/);
  assert.doesNotMatch(registryCommand, /registry-version --/);
  assert.ok(registrySteps.some((step) => step.run === 'pnpm install --frozen-lockfile'));
  const pnpmSetup = registrySteps.findIndex((step) => step.uses === 'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413');
  assert.ok(pnpmSetup >= 0 && pnpmSetup < registrySteps.findIndex((step) => step.uses === 'actions/setup-node@v7'),
  'pnpm must exist before setup-node configures pnpm caching');

  assert.ok(desktopPublish.on.workflow_dispatch);
  assert.equal(desktopPublish.on.push, undefined);
  assert.equal(desktopPublish.on.workflow_call, undefined);
  assert.equal(desktopPublish.on.workflow_dispatch.inputs.publish.default, false);
  assert.match(JSON.stringify(desktopPublish.jobs.preflight), /desktop-v/);
  assert.match(JSON.stringify(desktopPublish.jobs.preflight), /git merge-base --is-ancestor/);
  assert.equal(desktopPublish.jobs.build.steps[0].with?.ref, '${{ needs.preflight.outputs.commit }}');
  assert.deepEqual(desktopPublish.jobs.build.strategy.matrix.include.map(({ target }: { target: string }) => target), [
    'windows-x64', 'linux-x64',
  ]);
  assert.equal(ci.jobs.desktop['continue-on-error'], "${{ startsWith(matrix.id, 'macos-') }}");
  assert.equal(ci.jobs.credentials['continue-on-error'], "${{ startsWith(matrix.os, 'macos-') }}");
  assert.equal(ci.on.workflow_dispatch.inputs.include_macos.default, false);
  const matrixVariants = (expression: string): ({ id?: string } | string)[][] => [...expression.matchAll(/'(\[[\s\S]*?\])'/g)]
    .map(([, json]) => JSON.parse(json) as ({ id?: string } | string)[]);
  assert.match(ci.jobs.credentials.strategy.matrix.os, /github\.event_name == 'workflow_dispatch' && inputs\.include_macos/);
  assert.deepEqual(matrixVariants(ci.jobs.credentials.strategy.matrix.os), [
    ['windows-latest', 'ubuntu-22.04', 'macos-15', 'macos-15-intel'],
    ['windows-latest', 'ubuntu-22.04'],
  ]);
  assert.match(ci.jobs.desktop.strategy.matrix.include, /github\.event_name == 'workflow_dispatch' && inputs\.include_macos/);
  assert.deepEqual(matrixVariants(ci.jobs.desktop.strategy.matrix.include).map((matrix) => matrix.map((item) => typeof item === 'string' ? item : item.id)), [
    ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64'],
    ['windows-x64', 'linux-x64'],
  ]);
  assert.doesNotMatch(JSON.stringify(desktopPublish.jobs.draft), /macos|\.dmg/i,
    'unverified macOS installers must not enter the formal Desktop release asset set');
  const draft = desktopPublish.jobs.draft.steps.map((step) => step.run ?? '').join('\n');
  assert.match(draft, /desktop-release-manifest\.ts verify/);
  assert.match(draft, /release-notes\.js "\$TAG" --manifest dist-release\/desktop-release-manifest\.json/);
  assert.match(draft, /gh release create "\$TAG" --verify-tag[^\n]*--draft/);
  assert.match(draft, /refusing to modify published Release/);
  assert.match(draft, /gh release upload "\$TAG"/);
  assert.match(draft, /comm -13/);
  assert.match(draft, /draft Release contains assets outside the verified set/);
  assert.doesNotMatch(draft, /--clobber|gh release edit/);
  assert.equal(desktopPublish.jobs.publish.environment, 'desktop-publish');
  assert.match(JSON.stringify(desktopPublish.jobs['publish-preflight']), /desktop-publish must have at least one required reviewer/);
  const publishDesktop = desktopPublish.jobs.publish.steps.map((step) => step.run ?? '').join('\n');
  assert.match(publishDesktop, /verify-desktop-draft\.js/);
  assert.match(publishDesktop, /releases\/\$\{release_id\}\/assets\?per_page=100/);
  assert.match(publishDesktop, /application\/octet-stream/);
  assert.doesNotMatch(publishDesktop, /gh release download/,
    'draft assets must be fetched by release and asset IDs because the tag endpoint hides drafts');
  assert.match(publishDesktop, /--workflow desktop-publish\.yml --event workflow_dispatch --commit/);
  assert.equal(desktopPublish.jobs.build.if, '${{ !inputs.publish }}');
  assert.equal(desktopPublish.jobs.draft.if, '${{ !inputs.publish }}');
  assert.deepEqual(desktopPublish.jobs.publish.needs, ['preflight', 'publish-preflight']);
  assert.equal(desktopPublish.jobs.publish.steps[0].with?.ref, '${{ github.sha }}');
  assert.doesNotMatch(JSON.stringify(desktopPublish.jobs.publish), /actions\/download-artifact/);
  assert.match(publishDesktop, /PATCH .*releases\/\$\{release_id\}.*draft=false/);

  for (const [label, config] of [['npm-publish', npmPublish], ['desktop-publish', desktopPublish]] as const) {
    // Publication workflows never modify sources, commit versions, or create PRs:
    // version files are prepared in normal development PRs; tags are pushed by tag.yml.
    assert.doesNotMatch(JSON.stringify(config.jobs), /git commit|git push origin "\$\{?TAG|gh pr create|pull-requests: write/,
      `${label} must not modify sources, commit versions, or create pull requests`);
  }

  const desktopSteps = ci.jobs.desktop.steps;
  // The CI desktop job verifies behavior only; installer building and installer
  // smoke tests belong to the desktop-publish workflow.
  assert.doesNotMatch(JSON.stringify(ci.jobs.desktop), /build:win|build:linux|install-electron|run-installer-smoke|desktop\/release\//);
  assert.deepEqual(matrixVariants(ci.jobs.desktop.strategy.matrix.include).map((matrix) => matrix.map((item) => typeof item === 'string' ? item : Object.keys(item).sort())), [
    [['id', 'node', 'os'], ['id', 'node', 'os'], ['id', 'node', 'os'], ['id', 'node', 'os']],
    [['id', 'node', 'os'], ['id', 'node', 'os']],
  ]);
  const electronCompiled = desktopSteps.findIndex((step) => step.name === 'compile the Electron main process');
  const runtimePrepared = desktopSteps.findIndex((step) => step.name === 'prepare the target Node runtime and Host resources');
  const windowsTree = desktopSteps.findIndex((step) => step.name === 'test Windows Host Job Object process-tree cleanup');
  const posixTree = desktopSteps.findIndex((step) => step.name === 'test POSIX Host process-group cleanup and orphan watchdog');
  assert.ok(electronCompiled >= 0 && runtimePrepared > electronCompiled && windowsTree > runtimePrepared && posixTree > runtimePrepared,
    'process-tree tests require the compiled Electron main process and the vendored Node runtime');
  for (const steps of [desktopSteps, desktopPublish.jobs.build.steps]) {
    const hostBuild = steps.findIndex((step) => step.name === 'build the Host runtime tree');
    const hostTests = steps.findIndex((step) => step.name === 'test Electron Host and security contracts');
    assert.ok(hostBuild >= 0 && hostTests > hostBuild,
      'real Host tests require tui/dist/cli.js from the workspace build in a fresh checkout');
  }
});
