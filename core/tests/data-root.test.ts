// 配置、模式、技能、提示模板、扩展和终端界面都从同一个函数获取应用数据根。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { configPaths, dataRoot } from '../dist/kernel/config-file.js';
import { modeDirectories } from '../dist/kernel/modes.js';
import { historyPathOf } from '../dist/kernel/input-history.js';
import { skillDirectories } from '../dist/kernel/skills.js';

test('the data root is ~/.ligule unless LIGULE_HOME names another directory', () => {
  assert.equal(dataRoot('/home/me', {}), join('/home/me', '.ligule'));
  assert.equal(dataRoot('/home/me', { LIGULE_HOME: '   ' }), join('/home/me', '.ligule'), '空的那一格按没写处理');
  assert.equal(dataRoot('/home/me', { LIGULE_HOME: '/srv/ligule' }), '/srv/ligule');
});

// 相对写法不当成「相对当前目录」：同一份环境从两个目录下起来会写出两份数据。
test('a relative LIGULE_HOME is refused with its own code', () => {
  assert.throws(() => dataRoot('/home/me', { LIGULE_HOME: 'elsewhere' }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'data_root_invalid');
});

test('the user layer, the mode and skill lookups and the terminal history all follow the one root', () => {
  const previous = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = join(process.cwd(), 'testplace', 'data-root-home');
  try {
    const root = dataRoot('/home/me');
    assert.equal(configPaths('/proj', '/home/me').user, join(root, 'config.toml'));
    assert.ok(modeDirectories('/proj', '/shipped', '/home/me').user.startsWith(root), '个人模式那一层没跟着数据根走');
    assert.ok(skillDirectories('/proj', '/home/me').some((one) => one.startsWith(root)), '技能那一层没跟着数据根走');
    assert.equal(historyPathOf('/home/me'), join(root, 'tui-history.jsonl'));
  } finally {
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
  }
});
