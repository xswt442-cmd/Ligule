// 设置读取通过配置文件和不可写的项目层核对有效审批规则的来源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfigStore } from '../dist/kernel/config-store.js';
import { loadConfigLayers } from '../dist/kernel/config-file.js';

test('configuration reads merge policy rules by exact identity and allow editing an overriding local rule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-config-store-'));
  const projectRoot = join(root, 'project');
  const userHome = join(root, 'home');
  await mkdir(join(projectRoot, '.ligule'), { recursive: true });
  await mkdir(join(userHome, '.ligule'), { recursive: true });
  await writeFile(join(userHome, '.ligule', 'config.toml'), [
    '[[policy.rules]]',
    'tool = "exec"',
    'match = "git status*"',
    'decision = "deny"',
    '',
    '[[policy.rules]]',
    'tool = "read"',
    'decision = "allow"',
    '',
  ].join('\n'));
  await writeFile(join(projectRoot, '.ligule', 'config.toml'), [
    '[[policy.rules]]',
    'tool = "exec"',
    'match = "git status*"',
    'decision = "allow"',
    '',
    '[[policy.rules]]',
    'tool = "exec"',
    'match = "pnpm install*"',
    'decision = "deny"',
    '',
  ].join('\n'));
  await writeFile(join(projectRoot, '.ligule', 'config.local.toml'), [
    '[[policy.rules]]',
    'tool = "mcp:playwright/browser_navigate"',
    'decision = "allow"',
    '',
  ].join('\n'));

  try {
    const layers = await loadConfigLayers({ projectRoot, userHome });
    const store = createConfigStore({ projectRoot, userHome, layers: {
      ...layers,
      flag: { policy: { rules: [{ tool: 'mcp:filesystem/read_file', decision: 'deny' }] } },
    } });
    const shown = await store.read();

    assert.deepEqual(JSON.parse(JSON.stringify(shown.rules)), [
      { tool: 'mcp:filesystem/read_file', decision: 'deny' },
      { tool: 'mcp:playwright/browser_navigate', decision: 'allow' },
      { tool: 'exec', match: 'git status*', decision: 'allow' },
      { tool: 'exec', match: 'pnpm install*', decision: 'deny' },
      { tool: 'read', decision: 'allow' },
    ]);
    assert.deepEqual(shown.ruleSources, ['flag', 'local', 'project', 'project', 'user']);
    assert.equal(shown.rulesSource, 'merged');
    assert.deepEqual(JSON.parse(JSON.stringify(shown.ruleLayers.user)), [
      { tool: 'exec', match: 'git status*', decision: 'deny' },
      { tool: 'read', decision: 'allow' },
    ]);

    const saved = await store.write({
      field: 'policy.rules', layer: 'projectLocal', version: shown.layers.find((item) => item.layer === 'projectLocal')!.version,
      op: 'add', rule: { tool: 'write', decision: 'deny' },
    });
    assert.equal(saved.shadowed, false);
    assert.ok((saved.effective as { tool: string; decision: string }[]).some((rule) => rule.tool === 'write' && rule.decision === 'deny'));
    assert.ok((await readFile(join(projectRoot, '.ligule', 'config.local.toml'), 'utf8')).includes('tool = "write"'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
