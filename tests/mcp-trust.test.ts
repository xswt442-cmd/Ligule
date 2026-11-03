import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTrusted, isTrusted } from '../core/dist/kernel/workspace-trust.js';
import { connectMcp } from './helpers/mcp-control.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repo, 'tui/dist/cli.js');
const sdkRoot = join(repo, 'core/node_modules/@modelcontextprotocol/sdk');

type FixturePaths = { project: string; home: string };

async function fixture(action: (paths: FixturePaths) => Promise<void>) {
  const parent = join(repo, 'testplace/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'mcp-trust-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.ligule'), { recursive: true }), mkdir(home)]);
  try { await action({ project, home }); }
  finally {
    const inside = relative(parent, root);
    assert.ok(inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`));
    await rm(root, { recursive: true, force: true });
  }
}

function startUntrusted(project: string, home: string) {
  return spawnSync(process.execPath, [cliPath, 'mcp-server', '--project', project], {
    cwd: project,
    env: { PATH: process.env.PATH, LIGULE_HOME: home, HOME: home, USERPROFILE: home, ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }) },
    input: '', encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
}

test('MCP refuses an untrusted project before its policy can be adopted', async () => {
  await fixture(async ({ project, home }) => {
    await writeFile(join(project, '.ligule/config.toml'), '[policy]\nmode = "auto"\n[[policy.rules]]\ntool = "exec"\ndecision = "allow"\n');
    assert.equal(await isTrusted(project, join(home, 'tui-trust.json')), false);
    const result = startUntrusted(project, home);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /control_project_untrusted/u);
    assert.equal(await isTrusted(project, join(home, 'tui-trust.json')), false, 'starting MCP never grants trust');
  });
});

test('MCP refuses trust before even parsing an untrusted project configuration', async () => {
  await fixture(async ({ project, home }) => {
    await writeFile(join(project, '.ligule/config.toml'), '[invalid TOML');
    const result = startUntrusted(project, home);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /control_project_untrusted/u);
    assert.doesNotMatch(result.stderr, /config_file_invalid/u);
  });
});

test('MCP accepts the existing TUI trust document through a real stdio client', async () => {
  await fixture(async ({ project, home }) => {
    await setTrusted(project, true, join(home, 'tui-trust.json'));
    const server = await connectMcp({ cliPath, projectRoot: project, dataRoot: home, sdkRoot, apiKeyName: 'MCP_TRUST_TEST_KEY', apiKey: 'unused' });
    try { assert.equal((await server.client.listTools()).tools.length, 14); }
    finally { await server.close(); }
  });
});
