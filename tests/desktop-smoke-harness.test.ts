import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'electron', 'tests');
const installerSource = await readFile(process.env.LIGULE_INSTALLER_SMOKE_SOURCE ?? join(testDirectory, 'run-installer-smoke.ps1'), 'utf8');
const packagedSource = await readFile(process.env.LIGULE_PACKAGED_SMOKE_SOURCE ?? join(testDirectory, 'run-packaged-smoke.mjs'), 'utf8');

test('installer cleanup failures are recorded and still reach report writing', () => {
  const cleanupStart = installerSource.indexOf('$remaining = @(Get-ChildItem -LiteralPath $installRoot');
  const cleanupTryStart = installerSource.lastIndexOf('try {', cleanupStart);
  const cleanupEnd = installerSource.indexOf("$report.remainingInstallEntries = 0", cleanupStart);
  const cleanup = installerSource.slice(cleanupTryStart, cleanupEnd);

  assert.notEqual(cleanupStart, -1);
  assert.notEqual(cleanupTryStart, -1);
  assert.match(cleanup, /try\s*\{/u);
  assert.match(cleanup, /catch\s*\{\s*\$report\.cleanupError\s*=\s*\$_.Exception.Message\s*\$exitCode\s*=\s*1/su);
  assert.match(installerSource, /finally\s*\{[\s\S]*?\$report\s*\|\s*ConvertTo-Json[\s\S]*?Set-Content -LiteralPath \(Join-Path \$evidenceRoot 'report\.json'\)/u);
});

test('packaged launch uses the credential-safe launcher and closes standard logs', () => {
  const runStart = packagedSource.indexOf('async function run()');
  const runEnd = packagedSource.indexOf('\ntry {\n  await run();', runStart);
  const runBody = packagedSource.slice(runStart, runEnd);

  assert.match(runBody, /await startApplication\(\)/u);
  assert.match(runBody, /setTimeout\(\(\) => \{ timedOut = true; applicationProcess\.kill\(\); \}, 300_000\)/u);
  assert.match(runBody, /await Promise\.all\(\[stdout, stderr\][\s\S]*?finished\(stream\)/u);
  assert.match(packagedSource, /const stdout = interruptionMode === undefined \? createWriteStream/u);
  assert.match(packagedSource, /const stderr = interruptionMode === undefined \? createWriteStream/u);
  assert.match(packagedSource, /delete environment\[modelApiKeyName\]/u);
  assert.match(packagedSource, /windowsHide: process\.platform === 'win32'/u);
  assert.doesNotMatch(runBody, /windowsHide:\s*false/u);
});
