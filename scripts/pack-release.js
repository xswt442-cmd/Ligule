import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertCoreRuntimeMatches } from './core-runtime.js';
import { assertSymlinksInside } from './runtime-tree.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export const BUNDLED_SPREADSHEET = 'xlsx';

function spreadsheetPayload() {
  const fromCore = createRequire(join(root, 'core', 'package.json'));
  const path = join(dirname(fromCore.resolve(BUNDLED_SPREADSHEET)), 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.name !== BUNDLED_SPREADSHEET || typeof manifest.version !== 'string'
    || Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).length !== 0) {
    throw new Error('the bundled spreadsheet parser must be a dependency-free JavaScript package');
  }
  return { directory: dirname(path), version: manifest.version };
}

export function releaseManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'tui', 'package.json'), 'utf8'));
  delete manifest.packageManager;
  const core = JSON.parse(readFileSync(join(root, 'core', 'package.json'), 'utf8'));
  if (typeof core.dependencies?.['@vscode/ripgrep'] !== 'string') {
    throw new Error('core/package.json must declare @vscode/ripgrep as a runtime dependency');
  }
  const declaredSearchPackages = Object.keys(manifest.optionalDependencies ?? {}).filter((name) => name.startsWith('ligule-rg-'));
  if (declaredSearchPackages.length > 0) {
    throw new Error(`package.json must not declare local search platform packages: ${declaredSearchPackages.join(', ')}`);
  }
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(core[field] ?? {})) {
      if (manifest[field]?.[name] !== undefined && manifest[field][name] !== version) {
        throw new Error(`TUI and Core declare different ${field} versions for ${name}`);
      }
    }
    manifest[field] = { ...core[field], ...manifest[field] };
  }
  manifest.dependencies['@ligule/core'] = '*';
  manifest.dependencies[BUNDLED_SPREADSHEET] = spreadsheetPayload().version;
  manifest.bundledDependencies = [...new Set([...manifest.bundledDependencies, BUNDLED_SPREADSHEET])];
  return manifest;
}

function deployTui(target) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined || !pnpmCli.toLowerCase().includes('pnpm')) throw new Error('run package packing through the pinned pnpm workspace command');
  const args = ['--filter=ligule', 'deploy', '--prod', target];
  const isJavaScriptCli = /\.(?:cjs|mjs|js)$/i.test(pnpmCli);
  execFileSync(isJavaScriptCli ? process.execPath : pnpmCli, isJavaScriptCli ? [pnpmCli, ...args] : args, { cwd: root, stdio: 'inherit' });
}

function execPnpm(args, options) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined || !pnpmCli.toLowerCase().includes('pnpm')) throw new Error('run package packing through the pinned pnpm workspace command');
  const isJavaScriptCli = /\.(?:cjs|mjs|js)$/i.test(pnpmCli);
  return execFileSync(isJavaScriptCli ? process.execPath : pnpmCli, isJavaScriptCli ? [pnpmCli, ...args] : args, options);
}

function packInfo(output, label) {
  const parsed = JSON.parse(output);
  const info = Array.isArray(parsed) && parsed.length === 1 ? parsed[0]
    : Array.isArray(parsed?.files) ? parsed
      : parsed?.[releaseManifest().name];
  if (!Array.isArray(info?.files) || typeof info.filename !== 'string') {
    throw new Error(`npm pack ${label} did not return its file list and archive name`);
  }
  return info;
}

export async function packRelease(destination) {
  const finalManifest = releaseManifest();
  const destinationDirectory = resolve(root, destination);
  await mkdir(join(root, 'testplace', 'tmp'), { recursive: true });
  const temporaryRoot = await mkdtemp(join(root, 'testplace', 'tmp', 'release-pack-'));
  const stagedPackage = join(temporaryRoot, 'package');
  try {
    deployTui(stagedPackage);
    await assertSymlinksInside(stagedPackage);
    await assertCoreRuntimeMatches(join(root, 'core'), join(stagedPackage, 'node_modules', '@ligule', 'core'));
    // The public manifest installs external dependencies for the consumer's platform.
    // Bundle Core and the dependency-free spreadsheet parser; native modules remain consumer-installed.
    const spreadsheet = spreadsheetPayload();
    const spreadsheetDirectory = join(stagedPackage, 'node_modules', BUNDLED_SPREADSHEET);
    if (!existsSync(spreadsheetDirectory)) {
      await cp(spreadsheet.directory, spreadsheetDirectory, { recursive: true, dereference: true,
        errorOnExist: true, force: false, filter: path => basename(path) !== 'node_modules' });
    }
    const installedSpreadsheet = JSON.parse(readFileSync(join(spreadsheetDirectory, 'package.json'), 'utf8'));
    if (installedSpreadsheet.version !== spreadsheet.version) throw new Error('the bundled spreadsheet version differs from the source runtime');
    await assertSymlinksInside(spreadsheetDirectory);
    const coreManifestPath = join(stagedPackage, 'node_modules', '@ligule', 'core', 'package.json');
    const coreManifest = JSON.parse(readFileSync(coreManifestPath, 'utf8'));
    delete coreManifest.dependencies;
    delete coreManifest.optionalDependencies;
    await writeFile(coreManifestPath, `${JSON.stringify(coreManifest, null, 2)}\n`, 'utf8');
    await writeFile(join(stagedPackage, 'package.json'), `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');
    const dryRun = execPnpm(['--dir', stagedPackage, 'pack', '--dry-run', '--json', '--ignore-workspace'], { cwd: root, encoding: 'utf8' });
    const sourceInfo = packInfo(dryRun, 'deployed dry run');
    const included = new Set(sourceInfo.files.map(({ path }) => path));
    if (!included.has('package.json')) throw new Error('deployed package is missing package.json');
    if (sourceInfo.files.some(({ path }) => path.startsWith(`node_modules/${BUNDLED_SPREADSHEET}/`)
      && /\.(?:node|dll|exe|so|dylib)$/iu.test(path))) throw new Error('the bundled spreadsheet parser must not contain platform-native binaries');
    await mkdir(destinationDirectory, { recursive: true });
    const finalOutput = execPnpm(['--dir', stagedPackage, 'pack', '--json', '--pack-destination', destinationDirectory, '--ignore-workspace'], { cwd: root, encoding: 'utf8' });
    const finalInfo = packInfo(finalOutput, 'staged package');
    const tarball = isAbsolute(finalInfo.filename) ? finalInfo.filename : join(destinationDirectory, finalInfo.filename);
    if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);
    const stagedPaths = finalInfo.files.map(({ path }) => path).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify([...included].sort())) throw new Error('the staged tarball file list differs from npm pack --dry-run');
    const sourceGitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (!/^[0-9a-f]{40}$/u.test(sourceGitSha)) throw new Error(`Git HEAD is not a full SHA: ${sourceGitSha}`);
    const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
    const tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    await writeFile(`${tarball}.source.json`, `${JSON.stringify({
      schemaVersion: 1,
      package: finalManifest.name,
      version: finalManifest.version,
      tarball: basename(tarball),
      tarballSha256,
      sourceGitSha,
      sourceDirty,
      buildNodeVersion: process.version,
      buildTimestamp: new Date().toISOString(),
      builder: 'scripts/pack-release.js',
    }, null, 2)}\n`, 'utf8');
    process.stdout.write(`${tarball}\n`);
    return tarball;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ?? 'testplace/pack';
  if (process.argv.length > 3) throw new Error('usage: pnpm --filter ligule run pack-release [destination]');
  await packRelease(destination);
}
