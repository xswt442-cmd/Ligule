// 技能登记表反映磁盘中发现的技能，与当前模式选择无关。
// 按固定目录顺序搜索，同名技能保留优先级最高的版本，并记录被忽略版本的诊断。
// 含有 `SKILL.md` 的目录就是技能根，不再递归搜索嵌套技能。
// `SKILL.md` 使用 YAML frontmatter，必须包含 `name` 和 `description`；此项目只读取 `metadata.ligule-requires`。
// frontmatter 无效时不加载技能，并将原因写入日志和系统提示摘要。
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { isWithin } from '../capability/paths.js';
import { CONFIG_DIRECTORY, dataRoot } from './config-file.js';
import { splitFrontmatter } from './frontmatter.js';
import { KernelError } from './error.js';

export const SKILL_FILE = 'SKILL.md';
export const SKILLS_DIRECTORY = 'skills';
// 技能名称按 Agent Skills 规范校验字符集和长度；超限时拒绝加载。
const NAME_LIMIT = 64;
const NAME_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_LIMIT = 1024;
// 元数据使用固定字节预算，避免每次请求携带过多重复内容。
export const SKILL_METADATA_BUDGET_BYTES = 8_000;
// 技能搜索目录使用与文件工具相同的排除目录名称。
const SKIPPED_DIRECTORIES = ['node_modules', '.git'];

export interface SkillEntry {
  name: string;
  description: string;
  requires: string[];
  // 技能根目录由 `SKILL.md` 所在目录决定；技能文件读取限制在该目录内，与工作区边界分开。
  root: string;
  file: string;
}

export interface SkillDiagnostic {
  code: string;
  detail: string;
  path: string;
}

export interface SkillRegistry {
  skills: SkillEntry[];
  diagnostics: SkillDiagnostic[];
}

// 按固定顺序搜索四类目录，确保同名技能选择不受文件系统遍历顺序影响。
export function skillDirectories(projectRoot: string, userHome = homedir()): string[] {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('skill_project_root_required');
  return [
    join(projectRoot, CONFIG_DIRECTORY, SKILLS_DIRECTORY),
    join(projectRoot, '.agents', SKILLS_DIRECTORY),
    join(dataRoot(userHome), SKILLS_DIRECTORY),
    join(userHome, '.agents', SKILLS_DIRECTORY),
  ];
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new KernelError('skill_file_read_failed', { cause: error, detail: path });
  }
}

// 由 `frontmatter.ts` 分离元数据和正文；模型只接收正文。

// frontmatter 中的其他 metadata 键保持原样，只解析此项目使用的 `ligule-requires`。
function readRequires(metadata: unknown): string[] {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const declared = (metadata as Record<string, unknown>)['ligule-requires'];
  return typeof declared === 'string' ? declared.split(/\s+/).filter((token) => token !== '') : [];
}

function checkedSkill(text: string, file: string): SkillEntry {
  const { head: source } = splitFrontmatter(text);
  if (source === undefined) throw new KernelError('skill_frontmatter_missing', { detail: `${file} has no YAML frontmatter` });
  let head: unknown;
  try {
    head = parse(source);
  } catch (error) {
    throw new KernelError('skill_frontmatter_invalid', { cause: error, detail: file });
  }
  if (head === null || typeof head !== 'object' || Array.isArray(head)) {
    throw new KernelError('skill_frontmatter_invalid', { detail: `${file} is not a mapping` });
  }
  const fields = head as Record<string, unknown>;
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== 'string' || !NAME_FORM.test(name)) {
    throw new KernelError('skill_name_invalid', { detail: `${name} in ${file} (lowercase letters, digits and single hyphens)` });
  }
  if (name.length > NAME_LIMIT) {
    throw new KernelError('skill_name_invalid', { detail: `${name} in ${file} is longer than ${NAME_LIMIT} characters` });
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new KernelError('skill_description_missing', { detail: file });
  }
  if (description.length > DESCRIPTION_LIMIT) {
    throw new KernelError('skill_description_too_long', { detail: `${file} declares ${description.length} characters, the limit is ${DESCRIPTION_LIMIT}` });
  }
  return { name, description, requires: readRequires(fields.metadata), root: resolve(file, '..'), file };
}

// 只有直接包含 `SKILL.md` 的子目录才算技能；没有该文件的目录整棵跳过，不向下递归。
async function childrenOf(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // 搜索目录可以不存在；其他读取错误应返回诊断。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new KernelError('skill_directory_read_failed', { cause: error, detail: directory });
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function discoverSkills(directories: string[]): Promise<SkillRegistry> {
  const loaded = new Map<string, SkillEntry>();
  const diagnostics: SkillDiagnostic[] = [];
  for (const directory of directories) {
    for (const child of await childrenOf(directory)) {
      const file = join(directory, child, SKILL_FILE);
      let text: string | undefined;
      try {
        text = await readIfExists(file);
      } catch (error) {
        const failure = error as KernelError;
        diagnostics.push({ code: failure.code ?? 'skill_file_read_failed', detail: failure.detail ?? failure.message, path: file });
        continue;
      }
      if (text === undefined) continue;
      let skill: SkillEntry;
      try {
        skill = checkedSkill(text, file);
      } catch (error) {
        const failure = error as KernelError;
        diagnostics.push({ code: failure.code ?? 'skill_file_read_failed', detail: failure.detail ?? failure.message, path: file });
        continue;
      }
      const kept = loaded.get(skill.name);
      if (kept !== undefined) {
        diagnostics.push({
          code: 'skill_name_conflict',
          detail: `${skill.name} at ${skill.root} is ignored; the loaded one is ${kept.root}`,
          path: file,
        });
        continue;
      }
      loaded.set(skill.name, skill);
    }
  }
  const skills = [...loaded.values()].sort((left, right) => left.name.localeCompare(right.name));
  return { skills, diagnostics };
}

// 元数据预算包含标题、技能说明和诊断摘要。
// 超出预算时不内联部分元数据，改为提示模型使用搜索工具查找技能。
const CATALOG_HEADING = 'Skills are packaged instructions kept on disk. Each line is `name: description`. '
  + 'Call skill with action "activate" and the name to load one; its supporting files come back with action "read".';
const CATALOG_FALLBACK = 'Skills are packaged instructions kept on disk, and there are too many to list here. '
  + 'Call skill with action "search" and a query to find one, then action "activate" with its name; supporting files come with action "read".';

export function formatSkillCatalog(registry: SkillRegistry, budgetBytes = SKILL_METADATA_BUDGET_BYTES): string {
  const note = registry.diagnostics.length === 0
    ? ''
    : `\n[${registry.diagnostics.length} skill file(s) were not loaded, the host log names them]`;
  const listed = `${CATALOG_HEADING}\n${registry.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`;
  if (Buffer.byteLength(`${listed}${note}`, 'utf8') <= budgetBytes) return `${listed}${note}`;
  return `${CATALOG_FALLBACK}${note}`;
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '');

// 使用词法相关度排序，不依赖额外检索库。技能名称精确或前缀匹配优先，其余结果按名称和说明的 BM25 分数排序。
export function searchSkills(skills: SkillEntry[], query: string, limit = 5): SkillEntry[] {
  const wanted = [...new Set(wordsOf(query))];
  if (skills.length === 0 || wanted.length === 0) return [];
  const needle = query.trim().toLowerCase();
  // 技能名称比说明更能区分技能，因此名称词项在 BM25 评分中加倍。
  const documents = skills.map((skill) => ({ skill, words: wordsOf(`${skill.name} ${skill.name} ${skill.description}`) }));
  const average = documents.reduce((total, document) => total + document.words.length, 0) / documents.length;
  const scored = documents.map((document) => {
    const name = document.skill.name.toLowerCase();
    // 名称匹配优先于全文相关度评分。
    const direct = name === needle ? 4 : name.startsWith(needle) ? 2 : 0;
    let lexical = 0;
    for (const word of wanted) {
      const frequency = document.words.filter((item) => item === word).length;
      if (frequency === 0) continue;
      const containing = documents.filter((other) => other.words.includes(word)).length;
      const inverse = Math.log(1 + (documents.length - containing) / containing);
      lexical += (inverse * frequency * 2.2) / (frequency + 1.2 * (0.75 + 0.25 * (document.words.length / average)));
    }
    return { skill: document.skill, score: direct + lexical };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit)
    .map((item) => item.skill);
}

// 一次读取正文和摘要；摘要基于原始字节，文件更改后会更新。
// 交给模型的内容不包含 frontmatter，避免重复注入已解析的元数据。
export async function readSkillBody(skill: SkillEntry): Promise<{ body: string; bytes: number; digest: string }> {
  const bytes = await readFile(skill.file).catch((error: NodeJS.ErrnoException) => {
    throw new KernelError('skill_file_read_failed', { cause: error, detail: skill.file });
  });
  const text = bytes.toString('utf8');
  return {
    body: splitFrontmatter(text).body,
    bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
  };
}

// 技能资源列举和读取都限制在所属技能目录内，不使用工作区文件工具的边界。
// 同时检查路径文本和解析后的真实路径，拦截 `../` 和越界符号链接，并返回稳定错误码。
async function withinRoot(skill: SkillEntry, path: string): Promise<string> {
  const absolute = resolve(skill.root, path);
  if (!isWithin(skill.root, absolute)) {
    throw new KernelError('skill_path_escapes_root', { detail: `${path} resolves to ${absolute}, outside ${skill.root}` });
  }
  const realRoot = await realpath(skill.root).catch((error: NodeJS.ErrnoException) => {
    throw new KernelError('skill_file_read_failed', { cause: error, detail: skill.root });
  });
  const real = await realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new KernelError('skill_file_not_found', { detail: `${path} in ${skill.name}` });
    throw new KernelError('skill_file_read_failed', { cause: error, detail: absolute });
  });
  if (!isWithin(realRoot, real)) {
    throw new KernelError('skill_path_escapes_root', { detail: `${path} leads to ${real} through a link, outside ${realRoot}` });
  }
  return real;
}

export async function listSkillFiles(skill: SkillEntry, limit: number): Promise<{ files: string[]; more: boolean }> {
  const found: string[] = [];
  let more = false;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && full !== skill.file) {
        if (found.length === limit) {
          more = true;
          return;
        }
        found.push(toPosix(relative(skill.root, full)));
      }
    }
  };
  await walk(skill.root);
  return { files: found, more };
}

export async function readSkillFile(skill: SkillEntry, path: string): Promise<Buffer> {
  const target = await withinRoot(skill, path);
  try {
    return await readFile(target);
  } catch (error) {
    throw new KernelError('skill_file_read_failed', { cause: error, detail: target });
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}
