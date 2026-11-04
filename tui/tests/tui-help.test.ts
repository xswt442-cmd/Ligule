import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOverrides, CURRENT, ENGLISH_VIEWS, KEYMAP } from '../dist/tui/keymap.js';
import { UI_COMMANDS } from '../dist/tui/commands.js';
import { HELP_TABS, helpEntries, helpTabTitle } from '../dist/tui/help.js';

test('help tabs have localized titles', () => {
  assert.deepEqual(HELP_TABS, ['commands', 'keys', 'templates']);
  assert.deepEqual(HELP_TABS.map((tab) => helpTabTitle(tab, 'zh')), ['命令', '按键', '提示模板']);
  assert.deepEqual(HELP_TABS.map((tab) => helpTabTitle(tab, 'en')), ['Commands', 'Keys', 'Prompt templates']);
});

test('command help groups every UI command and keeps the resume usage intact', () => {
  const entries = helpEntries('commands', [], 'zh');
  const commands = entries.filter((entry) => entry.description !== '');
  assert.equal(commands.length, UI_COMMANDS.length);
  assert.deepEqual(
    commands.map((entry) => entry.key).sort(),
    UI_COMMANDS.map((command) => command.usage).sort(),
  );
  assert.ok(commands.some((entry) => entry.key === '/resume <id> [模式名]'));
  assert.deepEqual(entries.filter((entry) => entry.description === '').map((entry) => entry.key), ['会话', '运行与工具', '输入与设置']);
});

test('English command and key help uses English labels', () => {
  const commandEntries = helpEntries('commands', [], 'en');
  assert.ok(commandEntries.some((entry) => entry.key === '/resume <id> [mode]'));
  const keyEntries = helpEntries('keys', [], 'en');
  assert.ok(keyEntries.some((entry) => entry.key === 'Global'));
  assert.ok(keyEntries.some((entry) => entry.description === 'Send, or queue while running'));
  assert.doesNotMatch([...commandEntries, ...keyEntries].map((entry) => `${entry.key} ${entry.description}`).join('\n'), /[\u3400-\u9fff]/u);
});

test('key help covers each action and groups entries by the keymap view', () => {
  const entries = helpEntries('keys', [], 'zh');
  const actions = entries.filter((entry) => entry.description !== '');
  assert.equal(actions.length, Object.keys(KEYMAP).length);
  for (const binding of Object.values(KEYMAP)) {
    assert.ok(actions.some((entry) => entry.description === binding.label), binding.label);
  }
  assert.deepEqual(
    entries.filter((entry) => entry.description === '').map((entry) => entry.key),
    Object.keys(ENGLISH_VIEWS),
  );
});

test('template help shows a short empty state and preserves supplied descriptions', () => {
  assert.deepEqual(helpEntries('templates', [], 'zh'), [{ key: '（无）', description: '没有可用提示模板' }]);
  assert.deepEqual(helpEntries('templates', [], 'en'), [{ key: '(none)', description: 'No prompt templates' }]);
  assert.deepEqual(
    helpEntries('templates', [{ command: 'git:prepare', description: 'Prepare a release' }], 'en'),
    [{ key: '/git:prepare', description: 'Prepare a release' }],
  );
});

test('key help reads the active personal override', () => {
  const previous = CURRENT.complete;
  try {
    const result = applyOverrides({ complete: 'ctrl+x' });
    assert.deepEqual(result.applied, ['complete']);
    const entries = helpEntries('keys', [], 'en');
    assert.ok(entries.some((entry) => entry.key === 'Ctrl+X' && entry.description === 'Complete command'));
    assert.equal(CURRENT.complete, 'ctrl+x');
  } finally {
    CURRENT.complete = previous;
  }
});
