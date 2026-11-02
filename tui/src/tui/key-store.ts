// 用户快捷键保存在本地独立文件中，不写入会话记录、模型上下文或项目配置。
// 文件为 JSON 对象，将动作名称映射到按键写法。未知动作或无效按键会返回诊断，不静默恢复默认值。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSpec } from './keymap.js';
import { dataRoot } from '@ligule/core/tui.js';

export function keyPathOf(home = homedir()): string {
  return join(dataRoot(home), 'tui-keys.json');
}

/** 读取快捷键覆盖；返回有效绑定和无法应用的动作名称。 */
export async function readKeys(path = keyPathOf()): Promise<{ overrides: Record<string, string>; refused: string[] }> {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { overrides: {}, refused: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { overrides: {}, refused: ['这份文件读不懂，整份按默认那一份走'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { overrides: {}, refused: ['这份文件写的不是那一张表，整份按默认那一份走'] };
  }
  const overrides: Record<string, string> = {};
  const refused: string[] = [];
  for (const [action, value] of Object.entries(parsed as Record<string, unknown>)) {
    const spec = typeof value === 'string' ? parseSpec(value) : null;
    if (spec === null) { refused.push(`${action}=${String(value)}`); continue; }
    overrides[action] = spec;
  }
  return { overrides, refused };
}

let writing: Promise<void> = Promise.resolve();

/** 串行写入完整文件，先写临时文件再原子替换，避免留下部分内容。 */
export function writeKeys(path: string, overrides: Record<string, string>): Promise<void> {
  writing = writing.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  });
  return writing;
}

export function flushKeys(): Promise<void> {
  return writing;
}
