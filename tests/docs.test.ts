// 检查维护中的文档链接、双语手册结构、README 入口和工程指南装载行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { parse } from '../core/node_modules/smol-toml/dist/index.js';
import { DEFAULT_LIMITS } from '../core/dist/capability/limits.js';
import { loadInstructions } from '../core/dist/index.js';
import { modelServices, resolveModel } from '../core/dist/kernel/model-services.js';
import { releaseNotesForTag } from '../scripts/release-notes.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const zhPath = join(repoRoot, 'docs', 'guide.zh-CN.md');
const enPath = join(repoRoot, 'docs', 'guide.en.md');
const bilingualPairs = [
  [join(repoRoot, 'README.md'), join(repoRoot, 'README.en.md')],
  [join(repoRoot, 'core', 'README.md'), join(repoRoot, 'core', 'README.en.md')],
  [join(repoRoot, 'tui', 'README.md'), join(repoRoot, 'tui', 'README.en.md')],
  [join(repoRoot, 'desktop', 'README.md'), join(repoRoot, 'desktop', 'README.en.md')],
  [zhPath, enPath],
  [join(repoRoot, 'docs', 'agent-control', 'guide.zh-CN.md'), join(repoRoot, 'docs', 'agent-control', 'guide.en.md')],
  [join(repoRoot, 'docs', 'development', 'ARCHITECTURE.zh-cn.md'), join(repoRoot, 'docs', 'development', 'ARCHITECTURE.en.md')],
  [join(repoRoot, 'docs', 'development', 'GLOSSARY.zh-cn.md'), join(repoRoot, 'docs', 'development', 'GLOSSARY.en.md')],
  [join(repoRoot, 'docs', 'development', 'CONTRIBUTING.zh-cn.md'), join(repoRoot, 'docs', 'development', 'CONTRIBUTING.en.md')],
];
const maintainedDocs = [
  ...bilingualPairs.flatMap((pair) => pair),
  join(repoRoot, 'tui', 'CHANGELOG.md'),
  join(repoRoot, 'docs', 'development', 'RELEASE.md'),
  join(repoRoot, 'tui', 'docs', 'guide.zh-CN.md'),
  join(repoRoot, 'tui', 'docs', 'guide.en.md'),
];
// 根指南描述全局规则，局部指南描述各模块和 Desktop 子目录的约定。
const guides = [
  'AGENTS.md',
  join('desktop', 'AGENTS.md'),
  join('desktop', 'frontend', 'AGENTS.md'),
  join('core', 'src', 'kernel', 'AGENTS.md'),
  join('core', 'src', 'tools', 'AGENTS.md'),
  join('core', 'src', 'session', 'AGENTS.md'),
  join('core', 'src', 'host', 'AGENTS.md'),
  join('tui', 'AGENTS.md'),
];
const localGuides = [
  join(repoRoot, 'desktop'),
  join(repoRoot, 'desktop', 'frontend'),
  join(repoRoot, 'core', 'src', 'kernel'),
  join(repoRoot, 'core', 'src', 'tools'),
  join(repoRoot, 'core', 'src', 'session'),
  join(repoRoot, 'core', 'src', 'host'),
  join(repoRoot, 'tui'),
];
const guidePath = (guide: string) => join(repoRoot, guide);

/** 按 GitHub 的标题规则生成锚点。 */
function slug(heading: string) {
  return heading.trim().toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\- ]/gu, '')
    .replace(/ /g, '-');
}

function anchors(text: string) {
  return new Set(text.split('\n').filter((line) => /^#{1,6}\s/.test(line)).map((line) => slug(line.replace(/^#+\s/, ''))));
}

/** 提取 Markdown 链接目标，包括可选锚点。 */
function links(text: string) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

// Claude 的入口只指向同目录 AGENTS.md；规则由 AGENTS.md 统一维护。
test('所有受维护 AGENTS.md 都有对应的轻量 CLAUDE.md 入口', () => {
  const agentGuides = [...guides, join('.github', 'engineering', 'templates', 'AGENTS.md')];
  for (const guide of agentGuides) {
    const claude = guidePath(guide.replace(/AGENTS\.md$/, 'CLAUDE.md'));
    assert.ok(existsSync(claude), `${guide} 缺少同目录 CLAUDE.md`);
    const text = readFileSync(claude, 'utf8').trim();
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    assert.equal(lines.length, 2, `${claude} 应只包含标题和 AGENTS.md 引用`);
    assert.match(lines[0], /^# /, `${claude} 缺少标题`);
    assert.match(lines[1], /^Read \[AGENTS\.md\]\(\.\/AGENTS\.md\)/, `${claude} 没有指向同目录 AGENTS.md`);
    assert.deepEqual(links(text), ['./AGENTS.md'], `${claude} 不应引用其他文档`);
  }
});

function codeTokens(text: string) {
  return new Set([...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    .filter((token) => /^[a-z][a-z0-9_.-]{2,}$/.test(token) && /[._]/.test(token)));
}

function tomlExample(text: string) {
  const match = text.match(/```toml\n([\s\S]*?)\n```/);
  assert.ok(match, 'guide must contain a TOML example');
  return parse(match[1]);
}

test('所有受维护文档的相对链接与锚点都落在仓库内', () => {
  for (const file of [...maintainedDocs, ...guides.map(guidePath)]) {
    const base = dirname(file);
    for (const target of links(readFileSync(file, 'utf8'))) {
      if (/^https?:/.test(target)) continue;
      const [pathPart, hash] = target.split('#');
      const resolved = pathPart === '' ? file : join(base, posix.normalize(pathPart));
      assert.ok(existsSync(resolved), `${file} 里的 ${target} 指向读不到的文件`);
      if (hash !== undefined && pathPart !== '') {
        assert.ok(anchors(readFileSync(resolved, 'utf8')).has(hash), `${file} 里的 ${target} 指到没有的锚点`);
      }
      if (hash !== undefined && pathPart === '') {
        assert.ok(anchors(readFileSync(file, 'utf8')).has(hash), `${file} 里的 ${target} 指到本文没有的锚点`);
      }
    }
  }
});

test('所有中英文配对文档的章节数对应', () => {
  const headings = (text: string) => text.split('\n').filter((line) => /^##\s/.test(line)).length;
  for (const [zh, en] of bilingualPairs) {
    assert.equal(headings(readFileSync(zh, 'utf8')), headings(readFileSync(en, 'utf8')), `${zh} 与 ${en} 的章节数不同`);
  }
});

test('所有中英文配对文档包含相同的代码标识符', () => {
  for (const [zh, en] of bilingualPairs) {
    const zhTokens = codeTokens(readFileSync(zh, 'utf8'));
    const enTokens = codeTokens(readFileSync(en, 'utf8'));
    const onlyZh = [...zhTokens].filter((token) => !enTokens.has(token));
    const onlyEn = [...enTokens].filter((token) => !zhTokens.has(token));
    assert.deepEqual({ onlyZh, onlyEn }, { onlyZh: [], onlyEn: [] }, `${zh} 与 ${en} 的标识符不同`);
  }
});

test('the npm package guide copies match the maintained user guides', () => {
  for (const name of ['guide.en.md', 'guide.zh-CN.md']) {
    assert.equal(readFileSync(join(repoRoot, 'tui', 'docs', name), 'utf8'), readFileSync(join(repoRoot, 'docs', name), 'utf8'), name);
  }
});

test('双语手册的多服务 TOML 示例相同且符合实际配置格式', () => {
  const zh = tomlExample(readFileSync(zhPath, 'utf8'));
  const en = tomlExample(readFileSync(enPath, 'utf8'));
  assert.deepEqual(zh, en);
  const zhModel = zh.model as Record<string, unknown>;
  assert.equal(modelServices(zhModel.services).length, 1);
  assert.deepEqual(resolveModel(zhModel), {
    api: 'chat-completions',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    services: zhModel.services,
    selection: zhModel.selection,
    serviceId: 'deepseek',
  });
});

test('workspace and product READMEs present the products and link to maintained documentation', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'tui', 'package.json'), 'utf8')) as { files: string[] };
  const rootReadme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const readme = readFileSync(join(repoRoot, 'tui', 'README.md'), 'utf8');
  const englishReadme = readFileSync(join(repoRoot, 'tui', 'README.en.md'), 'utf8');
  assert.match(rootReadme, /共享 Agent Core/);
  assert.match(rootReadme, /docs\/development\/ARCHITECTURE\.zh-cn\.md/);
  assert.match(readme, /docs\/guide\.zh-CN\.md/);
  assert.match(readme, /\.\.\/docs\/development\/CONTRIBUTING\.zh-cn\.md/);
  assert.match(englishReadme, /\.\.\/docs\/development\/CONTRIBUTING\.en\.md/);
  assert.doesNotMatch(readme, /github\.com\/xswt442-cmd\/ligule\/blob\/main/);
  assert.doesNotMatch(englishReadme, /github\.com\/xswt442-cmd\/ligule\/blob\/main/);
  assert.match(readme, /CHANGELOG\.md/);
  assert.match(englishReadme, /CHANGELOG\.md/);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'desktop', 'README.md'), 'utf8'), /pnpm|desktop\/vendor|testplace\/readings/);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'desktop', 'README.en.md'), 'utf8'), /pnpm|desktop\/vendor|testplace\/readings/);
  assert.ok(manifest.files.includes('README.en.md'), 'the English README must be included in the npm package');
  assert.ok(manifest.files.some((file) => file.includes('CHANGELOG.md')), 'the version history must be included in the npm package');
});

test('the CLI bilingual changelog section generates CLI release notes without Desktop assets', () => {
  const changelog = readFileSync(join(repoRoot, 'tui', 'CHANGELOG.md'), 'utf8');
  const notes = releaseNotesForTag(repoRoot, 'cli-v0.0.1');
  assert.match(changelog, /^## \[Unreleased\]/m);
  assert.match(notes, /初始公开版本/);
  assert.match(notes, /Initial public release/);
  assert.doesNotMatch(notes, /SHA-256|Downloads/);
  assert.match(notes, /运行 `ligule`/);
  assert.match(notes, /npm install -g ligule@0\.0\.1/);
  assert.doesNotMatch(notes, /desktop-release-manifest\.json|\.AppImage|\.deb/);
});

test('docs 根目录只放双语使用手册，且都有正文', () => {
  const files = readdirSync(join(repoRoot, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.deepEqual(files, ['guide.en.md', 'guide.zh-CN.md']);
  for (const name of files) {
    assert.ok(readFileSync(join(repoRoot, 'docs', name), 'utf8').startsWith('# '), `${name} 的第一行不是一级标题`);
  }
});

test('development 文档文件名使用大写主体与小写语言标记', () => {
  const files = readdirSync(join(repoRoot, 'docs', 'development'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.deepEqual(files, [
    'ARCHITECTURE.en.md',
    'ARCHITECTURE.zh-cn.md',
    'CONTRIBUTING.en.md',
    'CONTRIBUTING.zh-cn.md',
    'GLOSSARY.en.md',
    'GLOSSARY.zh-cn.md',
    'RELEASE.md',
  ]);
});

// 检查每份工程指南都能在默认读取预算内完整加载，并验证真实目录布局的加载顺序。
test('每份工程指南都在默认读入上限之内，且每一处都以默认预算完整装载', async () => {
  for (const guide of guides) {
    const bytes = Buffer.byteLength(readFileSync(guidePath(guide), 'utf8'), 'utf8');
    assert.ok(bytes < DEFAULT_LIMITS.readBytes, `${guide} 有 ${bytes} 字节，超过默认读入的 ${DEFAULT_LIMITS.readBytes} 字节`);
  }
  const rootGuide = readFileSync(guidePath(guides[0]), 'utf8');
  for (const guide of guides.slice(1)) {
    // 根指南必须通过目录路径提及每份局部指南。
    assert.ok(rootGuide.includes(posix.dirname(guide.split(sep).join('/')) + '/'), `AGENTS.md 没有指向 ${guide} 所在的那个目录`);
  }
  const atRoot = await loadInstructions({ boundary: repoRoot, current: repoRoot });
  assert.deepEqual(atRoot.files.map((file) => file.layer), ['project'], '只从项目根装载时只有根那一份');
  assert.ok(!atRoot.text.includes('[Instruction budget'), '默认预算下根那一份被截断了');
  for (const directory of localGuides) {
    const loaded = await loadInstructions({ boundary: repoRoot, current: directory });
    // 嵌套目录可能加载多份局部指南；根指南应先加载，当前目录的指南应最后加载。
    assert.equal(loaded.files[0].layer, 'project', `${directory} 处没有先装载根那一份`);
    assert.ok(loaded.files.slice(1).every((file) => file.layer === 'directory'), `${directory} 处的目录级层标错了`);
    assert.equal(resolve(loaded.files[loaded.files.length - 1].path), resolve(directory, 'AGENTS.md'), `${directory} 那一份没有连根那一份一起装载`);
    assert.ok(!loaded.text.includes('[Instruction budget'), `${directory} 处按默认预算装载时被截断了`);
  }
});
