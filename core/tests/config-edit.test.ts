// 验证配置更新保留原有注释、键顺序和换行，并在版本冲突时拒绝写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import lockfile from 'proper-lockfile';
import {
  EDITABLE,
  checkedRule,
  configVersion,
  editRuleTable,
  editTomlValue,
  editableField,
  encodeValue,
  rulesOfLayer,
  writeConfigField,
} from '../dist/kernel/config-edit.js';
import type { PolicyRule } from '../dist/kernel/config-edit.js';

// 解析结果是嵌套表；测试只按表结构读它，收窄集中在这里。
type TomlTable = { readonly [key: string]: TomlTable };
const readToml = (text: string): TomlTable => parse(text) as unknown as TomlTable;

// 逐条改写的场景：标量写值或规则表增删改，两种条目共用一个用例形状。
type Scenario = {
  readonly name: string;
  readonly text: string;
  readonly kind: 'scalar' | 'rule';
  readonly promised: boolean;
  readonly exact?: string;
  readonly action?: 'add' | 'update' | 'remove';
};
type Outcome = {
  readonly name: string;
  readonly promised: boolean;
  readonly error?: string;
  readonly semanticPass?: boolean;
  readonly commentsPass?: boolean;
  readonly exactBytes?: boolean;
};

type RuleDocumentRule = { readonly meta?: TomlTable };
// 场景里要改的字段只到规则表为止；其余字节由原文保留。
type EditableDocument = {
  model: { model?: unknown };
  policy: { rules: Record<string, unknown>[] };
};

const field = (id: string) => EDITABLE[id];
const apply = (text: string, id: string, value: string) => editTomlValue(text, field(id).path, encodeValue(field(id), value).literal).text;

const SAMPLE = `# 使用者默认
[model]
api = "messages" # 线上形状
model = "gpt-4o"

[limits]
contextTokens = 200000
`;

test('a config value changes in place and everything else stays where it was', () => {
  const edited = apply(SAMPLE, 'model.model', '新模型名');
  assert.ok(edited.includes('model = "新模型名"'), edited);
  assert.ok(edited.includes('api = "messages" # 线上形状'), '行尾那句注释留着');
  assert.ok(edited.includes('# 使用者默认'), '整行的注释留着');
  assert.ok(edited.indexOf('[model]') < edited.indexOf('[limits]'), '键的顺序不动');
  assert.equal(readToml(edited).model.model, '新模型名');
  assert.equal(readToml(edited).limits.contextTokens, 200000, '没编辑的字段还是原值');
  assert.notEqual(editTomlValue(SAMPLE, ['model', 'model'], '"gpt-4o"').created, true);
});

test('a missing key is added inside its own table, a missing table at the end', () => {
  const missing = editTomlValue('[model]\napi = "messages"\n\n[policy]\ntier = "ask"\n', ['model', 'model'], '"甲"');
  const added = missing.text;
  assert.equal(missing.created, true, '补入字段时标记创建');
  assert.equal(added, '[model]\napi = "messages"\nmodel = "甲"\n\n[policy]\ntier = "ask"\n');
  const whole = apply('[limits]\ncontextTokens = 1\n', 'model.model', '乙');
  assert.equal(whole, '[limits]\ncontextTokens = 1\n\n[model]\nmodel = "乙"\n');
  assert.equal(editTomlValue('', ['model', 'model'], '"丙"').text, '[model]\nmodel = "丙"\n');
});

test('a root-level dotted key is the same thing as the one inside that table', () => {
  const edited = apply('model.model = "old" # 顶层写法\n\n[limits]\ncontextTokens = 1\n', 'model.model', 'new');
  assert.ok(edited.includes('model.model = "new" # 顶层写法'), edited);
  assert.equal(readToml(edited).model.model, 'new');
});

test('a missing sibling of a root-level dotted key stays in the root table', () => {
  const text = 'model.api = "messages"\n\n[limits]\ncontextTokens = 1\n';
  const edited = editTomlValue(text, ['model', 'model'], '"new"');
  assert.equal(edited.text, 'model.api = "messages"\nmodel.model = "new"\n\n[limits]\ncontextTokens = 1\n');
  assert.equal(readToml(edited.text).model.model, 'new');
});

test('mixed line endings and a CRLF file keep the shape each line already had', () => {
  const crlf = apply('[model]\r\nmodel = "old"\r\n', 'model.model', 'new');
  assert.equal(crlf, '[model]\r\nmodel = "new"\r\n');
  assert.equal(readToml(crlf).model.model, 'new');
  // 文件同时包含 CRLF 和 LF 时，只保留被修改行原有的换行，并保持其他行不变。
  const mixed = apply('[model]\r\nmodel = "old"\napi = "messages"\r\n', 'model.model', 'new');
  assert.equal(mixed, '[model]\r\nmodel = "new"\napi = "messages"\r\n');
  assert.equal(readToml(mixed).model.api, 'messages', '没编辑的那一行连它的换行都没动');
});

test('a value this route cannot read is refused, and the shape is named', () => {
  const array = '[model]\nmodel = "a"\nrules = [\n  "one",\n]\n';
  assert.throws(() => editTomlValue(array, ['model', 'rules'], '"x"'), (error: unknown) => {
    const failure = error as { code?: string; detail: string };
    return failure.code === 'config_edit_shape_unsupported' && /an array/.test(failure.detail);
  });
  const multiline = '[model]\nabout = """\n两行\n"""\n';
  assert.throws(() => editTomlValue(multiline, ['model', 'about'], '"x"'), (error: unknown) => {
    const failure = error as { code?: string; detail: string };
    return failure.code === 'config_edit_shape_unsupported' && /a multi-line string/.test(failure.detail);
  });
  const inline = '[model]\nextra = { api = "messages" }\n';
  assert.throws(() => editTomlValue(inline, ['model', 'extra'], '"x"'), (error: unknown) => {
    const failure = error as { code?: string; detail: string };
    return failure.code === 'config_edit_shape_unsupported' && /an inline table/.test(failure.detail);
  });
});

// 多行字符串中的键名和表头样式文本仍是字符串内容；更新应定位到实际配置字段。
test('a multi-line string body is not read as a key line or a table header', () => {
  const body = editTomlValue('[model]\nabout = """\nmodel = "正文里的这一行"\n"""\nmodel = "表里的那一条"\n', ['model', 'model'], '"新值"');
  assert.equal(body.text, '[model]\nabout = """\nmodel = "正文里的这一行"\n"""\nmodel = "新值"\n');
  assert.equal(readToml(body.text).model.about, 'model = "正文里的这一行"\n', '那一段正文一个字没动');

  const header = editTomlValue('[model]\nabout = """\n[limits]\nstill inside\n"""\nmodel = "old"\n', ['model', 'model'], '"new"');
  assert.equal(readToml(header.text).model.model, 'new');
  assert.equal(readToml(header.text).model.about, '[limits]\nstill inside\n', '那一段里的表头形状没有切断这一段');
  assert.ok(header.text.includes('[limits]'), '那一句还留在正文里');

  // 表中缺少目标字段时，将新字段写在完整的键值行后，不插入未结束的多行字符串。
  const added = editTomlValue('[model]\nabout = """\n两行\n"""\n', ['model', 'model'], '"补的"');
  assert.equal(added.text, '[model]\nmodel = "补的"\nabout = """\n两行\n"""\n');
  assert.equal(readToml(added.text).model.model, '补的');
});

// TOML 键名和表名允许周围有空白或使用引号；更新字段时保留原有写法。
test('a quoted key and a spaced or quoted table header are the same key', () => {
  assert.equal(editTomlValue('[model]\n"model" = "old"\n', ['model', 'model'], '"new"').text, '[model]\n"model" = "new"\n');
  assert.equal(editTomlValue('[model]\n\'model\' = "old"\n', ['model', 'model'], '"new"').text, '[model]\n\'model\' = "new"\n');
  assert.equal(readToml(editTomlValue('["model"]\nmodel = "old"\n', ['model', 'model'], '"new"').text).model.model, 'new');
  assert.equal(readToml(editTomlValue('[ model ]\nmodel = "old"\n', ['model', 'model'], '"new"').text).model.model, 'new');
  assert.equal(editTomlValue('[ model ]\nmodel = "old"\n', ['model', 'model'], '"new"').created, false, '那一张表已经在了，不是补一张新的');
  // 顶层点号键周围的空白也应正确解析并保留。
  assert.equal(readToml(editTomlValue('model . model = "old"\n', ['model', 'model'], '"new"').text).model.model, 'new');
});

test('escaped table and key names resolve to the configured path', () => {
  const text = '["mo\\u0064el"]\n"mo\\u0064el" = "old" # 保留这一行\n';
  const edited = editTomlValue(text, ['model', 'model'], '"new"');
  assert.equal(edited.text, '["mo\\u0064el"]\n"mo\\u0064el" = "new" # 保留这一行\n');
  assert.equal(readToml(edited.text).model.model, 'new');
});

test('a key with the same name in another table is not the one being changed', () => {
  const edited = apply('[model]\nmodel = "在这里改"\n\n[other]\nmodel = "这一份不动"\n', 'model.model', '新');
  assert.equal(readToml(edited).model.model, '新');
  assert.equal(readToml(edited).other.model, '这一份不动');
});

test('each field only takes a value of its own shape', () => {
  assert.equal(encodeValue(field('model.api'), 'chat-completions').literal, '"chat-completions"');
  assert.throws(() => encodeValue(field('model.api'), 'openai'), (error: unknown) => (error as { code?: string }).code === 'config_field_value');
  for (const mode of ['always', 'ask', 'auto', 'never']) {
    assert.equal(encodeValue(field('policy.mode'), mode).literal, `"${mode}"`);
  }
  // `none` 与旧 `never` 不再是可写入的档位；历史值只在读取时降级。
  assert.throws(() => encodeValue(field('policy.mode'), 'none'), (error: unknown) => (error as { code?: string }).code === 'config_field_value');
  assert.throws(() => encodeValue(field('policy.mode'), 'yolo'), (error: unknown) => (error as { code?: string }).code === 'config_field_value');
  // 允许端点地址包含查询参数，但不允许在地址中写入凭据。
  assert.equal(encodeValue(field('model.baseURL'), 'https://a.example.com:443/v1?api=k').value, 'https://a.example.com:443/v1?api=k');
  assert.throws(() => encodeValue(field('model.baseURL'), 'https://user:pass@a.example.com/v1'), (error: unknown) => /credentials/.test((error as { detail: string }).detail), '凭据不写进配置（D13）');
  assert.throws(() => encodeValue(field('model.baseURL'), 'a.example.com/v1'), (error: unknown) => (error as { code?: string }).code === 'config_field_value');
  assert.equal(encodeValue(field('model.baseURL'), ' http://127.0.0.1:8080/v1 ').value, 'http://127.0.0.1:8080/v1');
  assert.throws(() => encodeValue(field('model.apiKeyEnv'), 'LIGULE KEY'), (error: unknown) => (error as { code?: string }).code === 'config_field_value');
  assert.throws(() => encodeValue(field('model.model'), '   '), (error: unknown) => (error as { code?: string }).code === 'config_field_value');
  assert.throws(() => editableField('model.unknown'), (error: unknown) => (error as { code?: string }).code === 'config_field_unknown');
  // 引号和反斜杠按 TOML 基本字符串规则转义，且不改变行结构。
  assert.equal(encodeValue(field('model.model'), 'a"b\\c').literal, '"a\\"b\\\\c"');
});

test('the write needs the version it read, lands atomically and reports the new one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-config-'));
  const file = join(directory, 'config.toml');
  try {
    await writeFile(file, SAMPLE, 'utf8');
    const first = await writeConfigField(file, { field: 'model.model', value: '第一次', version: configVersion(SAMPLE) });
    assert.equal(first.created, false);
    assert.equal(readToml(await readFile(file, 'utf8')).model.model, '第一次');
    await assert.rejects(readFile(`${file}.tmp`), (error: unknown) => (error as { code?: string }).code === 'ENOENT', '临时文件改名走了，不留在原地');

    // 文件被其他进程或编辑器修改后应报告冲突，并保留对方的修改。
    const outside = SAMPLE.replace('gpt-4o', '别人写的');
    await writeFile(file, outside, 'utf8');
    await assert.rejects(
      () => writeConfigField(file, { field: 'model.model', value: '我要写的', version: first.version }),
      (error: unknown) => (error as { code?: string }).code === 'config_version_stale',
    );
    assert.equal(readToml(await readFile(file, 'utf8')).model.model, '别人写的', '冲突那一次一个字都没写');

    const again = await writeConfigField(file, { field: 'model.api', value: 'chat-completions', version: configVersion(outside) });
    assert.equal(again.version, configVersion(await readFile(file, 'utf8')));
    assert.equal(readToml(await readFile(file, 'utf8')).model.api, 'chat-completions');

    // 文件不存在时使用空版本创建配置，并同时创建所需目录。
    const fresh = join(directory, 'new', 'config.toml');
    const createdFile = await writeConfigField(fresh, { field: 'model.model', value: '新建里的', version: '' });
    assert.equal(createdFile.created, true);
    assert.equal(readToml(await readFile(fresh, 'utf8')).model.model, '新建里的');

    // 审批档位作为标量字段使用相同的写入流程。
    const tier = await writeConfigField(file, { field: 'policy.mode', value: 'auto', version: configVersion(await readFile(file, 'utf8')) });
    assert.equal(tier.created, true, '那一份文件里原来没有 [policy]，补一张表');
    assert.equal(readToml(await readFile(file, 'utf8')).policy.mode, 'auto');
    // 新四档写入时必须带上语义标记，读取方才能把新 `never` 和旧 `never` 分开。
    assert.equal(readToml(await readFile(file, 'utf8')).policy.semantics, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const RULES = `# 使用者默认
[policy]
mode = "ask" # 逐次问人

# 读文件不用问
[[policy.rules]]
tool = "read"
decision = "allow"

# 这一条只放行看状态
[[policy.rules]]
tool = "exec"
match = "git status*"
decision = "allow"
reason = "只读的那一条"

[limits]
contextTokens = 200000
`;

const readRules = (text: string) => rulesOfLayer(parse(text));

test('adding a rule lands at the end of that table, before the comment belonging to the next one', () => {
  const edited = editRuleTable(RULES, 'add', 0, { tool: 'find', decision: 'allow' });
  assert.equal(edited.created, false);
  const rules = readRules(edited.text);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[2], { tool: 'find', decision: 'allow' });
  // 目标表之外的内容保持不变，包括整行注释、行尾注释和后续表的顺序。
  assert.ok(edited.text.includes('# 使用者默认\n'), '文件头上那句注释留着');
  assert.ok(edited.text.includes('mode = "ask" # 逐次问人'), '行尾注释留着');
  assert.ok(edited.text.indexOf('[limits]') > edited.text.indexOf('tool = "find"'), '新块落在下一张表之前');
  assert.equal(readToml(edited.text).limits.contextTokens, 200000);
});

test('adding the first rule to a populated document keeps a section break', () => {
  const edited = editRuleTable('[policy]\nmode = "ask"\n', 'add', 0, { tool: 'read', decision: 'allow' });
  assert.equal(edited.created, true);
  assert.equal(edited.text, '[policy]\nmode = "ask"\n\n[[policy.rules]]\ntool = "read"\ndecision = "allow"\n');
  assert.deepEqual(readRules(edited.text), [{ tool: 'read', decision: 'allow' }]);
});

test('changing one key of a rule keeps the other lines and drops the key the new rule does not carry', () => {
  const edited = editRuleTable(RULES, 'update', 1, { tool: 'exec', decision: 'deny', reason: '写之前先问' });
  const rules = readRules(edited.text);
  assert.deepEqual(rules[1], { tool: 'exec', decision: 'deny', reason: '写之前先问' }, 'match 这一行跟着新规则去掉');
  assert.deepEqual(rules[0], { tool: 'read', decision: 'allow' }, '别的那一项不动');
  assert.ok(edited.text.includes('# 读文件不用问'), '别的那一项头上的注释留着');
  assert.ok(edited.text.includes('decision = "deny"'), edited.text);
});

test('adding a key that the rule did not have appends it after the last key line', () => {
  const edited = editRuleTable(RULES, 'update', 0, { tool: 'read', decision: 'allow', match: 'src/**', reason: '读源码' });
  const rules = readRules(edited.text);
  assert.deepEqual(rules[0], { tool: 'read', match: 'src/**', decision: 'allow', reason: '读源码' });
  assert.ok(/# 这一条只放行看状态/.test(edited.text), '下一项的注释仍在');
});

test('removing a rule takes the comment attached to it and leaves the one attached to its neighbour', () => {
  const edited = editRuleTable(RULES, 'remove', 1);
  assert.equal(readRules(edited.text).length, 1);
  assert.ok(!edited.text.includes('这一条只放行看状态'), '贴着自己头上的那句注释一起删掉');
  assert.ok(edited.text.includes('# 读文件不用问'), '邻居的注释留着');
  assert.ok(edited.text.includes('[limits]'), edited.text);
});

// 删除多行字符串字段时必须同时删除其正文，否则剩余内容将无法解析为 TOML。
test('a rule statement whose value is a multi-line string is dropped whole', () => {
  const text = '[[policy.rules]]\ntool = "read"\nreason = """\ndecision = "deny"\n"""\n';
  const edited = editRuleTable(text, 'update', 0, { tool: 'read', decision: 'allow' });
  assert.equal(edited.text, '[[policy.rules]]\ntool = "read"\ndecision = "allow"\n');
  assert.deepEqual(readRules(edited.text), [{ tool: 'read', decision: 'allow' }]);
  // 将多行字符串改为单行值时，若当前更新方式无法闭合字符串，应报告错误且不写入。
  assert.throws(() => editRuleTable(text, 'update', 0, { tool: 'read', decision: 'allow', reason: '一句' }),
    (error: unknown) => {
      const failure = error as { code?: string; detail: string };
      return failure.code === 'config_edit_shape_unsupported' && /a multi-line string/.test(failure.detail);
    });
  // 未由 Host 管理的多行字段保持原样，新字段插入在该字段之前。
  const owned = editRuleTable('[[policy.rules]]\ntool = "read"\ndecision = "allow"\nowner = """\n两句\n"""\n', 'update', 0, { tool: 'read', decision: 'allow', match: 'git *' });
  assert.equal(owned.text, '[[policy.rules]]\ntool = "read"\ndecision = "allow"\nmatch = "git *"\nowner = """\n两句\n"""\n');
  assert.equal(readToml(owned.text).policy.rules[0].owner, '两句\n');
});

test('a key the host does not own inside a rule is left where it is', () => {
  const edited = editRuleTable('[[policy.rules]]\ntool = "read"\ndecision = "allow"\nowner = "另一个人写的"\n', 'update', 0, { tool: 'read', decision: 'deny' });
  assert.ok(edited.text.includes('owner = "另一个人写的"'), edited.text);
  assert.deepEqual({ ...readToml(edited.text).policy.rules[0] }, { tool: 'read', decision: 'deny', owner: '另一个人写的' });
});

// 仅含数组表的配置中，新增标量字段必须放在数组表之前，避免生成无效 TOML。
test('a scalar added while the table exists only as an array of tables lands above those blocks', () => {
  const edited = editTomlValue('[[policy.rules]]\ntool = "read"\ndecision = "allow"\n', ['policy', 'mode'], '"ask"');
  assert.equal(edited.text, '[policy]\nmode = "ask"\n\n[[policy.rules]]\ntool = "read"\ndecision = "allow"\n');
  assert.equal(readToml(edited.text).policy.mode, 'ask');
  assert.equal(readToml(edited.text).policy.rules.length, 1);
  const commented = editTomlValue('# 让模型自己读\n[[policy.rules]]\ntool = "read"\ndecision = "allow"\n', ['policy', 'mode'], '"auto"');
  assert.ok(commented.text.startsWith('[policy]\nmode = "auto"\n\n# 让模型自己读\n[[policy.rules]]'), '那句注释仍说的是下面那一段：' + commented.text);
});

test('a missing parent table is inserted before a commented descendant with its local line ending', () => {
  const text = '# 子表说明\r\n[model.service]\r\nname = "one"\r\n';
  const edited = editTomlValue(text, ['model', 'model'], '"new"');
  assert.equal(edited.text, '[model]\r\nmodel = "new"\r\n\r\n# 子表说明\r\n[model.service]\r\nname = "one"\r\n');
  assert.equal(readToml(edited.text).model.model, 'new');
  assert.equal(readToml(edited.text).model.service.name, 'one');
});

test('a missing key uses the line ending of its own table row', () => {
  const text = '[model]\r\napi = "messages"\n';
  assert.equal(editTomlValue(text, ['model', 'model'], '"new"').text, '[model]\r\napi = "messages"\nmodel = "new"\n');
});

test('a rule index this file does not have is said plainly, and an empty file gets the table', () => {
  assert.throws(() => editRuleTable(RULES, 'update', 9, { tool: 'read', decision: 'allow' }), (error: unknown) => (error as { code?: string }).code === 'config_rule_index');
  assert.equal(editRuleTable('', 'add', 0, { tool: 'read', decision: 'allow' }).text, '[[policy.rules]]\ntool = "read"\ndecision = "allow"\n');
});

test('the rule shape is owned by the host: unknown keys, empty values and a wrong decision are refused', () => {
  assert.deepEqual(checkedRule({ tool: 'read', decision: 'allow', match: 'a*' }), { tool: 'read', decision: 'allow', match: 'a*' });
  assert.deepEqual(checkedRule({ tool: 'mcp:playwright/browser_navigate', decision: 'ask' }), {
    tool: 'mcp:playwright/browser_navigate', decision: 'ask',
  });
  for (const bad of [
    { tool: 'read' },
    { tool: 'read', decision: 'maybe' },
    { tool: ' ', decision: 'allow' },
    { tool: 'read', decision: 'allow', pattern: 'a*' },
    { tool: 'read', decision: 'allow', match: '' },
    'read',
  ]) {
    assert.throws(() => checkedRule(bad), (error: unknown) => (error as { code?: string }).code === 'config_rule_invalid', JSON.stringify(bad));
  }
});

test('remembered file and MCP scopes validate, serialize and round-trip without becoming generic rules', () => {
  const fileRule = checkedRule({ tool: 'create', decision: 'allow', target: 'file', path: join(tmpdir(), 'app.js') });
  assert.deepEqual(fileRule, { tool: 'create', decision: 'allow', target: 'file', path: join(tmpdir(), 'app.js') });
  const fileText = editRuleTable('', 'add', 0, fileRule).text;
  assert.match(fileText, /target = "file"/u);
  assert.deepEqual(rulesOfLayer(parse(fileText)), [fileRule]);

  const argsHash = 'a'.repeat(64);
  const mcpRule = checkedRule({ tool: 'mcp:browser/click', decision: 'allow', argsHash });
  assert.deepEqual(rulesOfLayer(parse(editRuleTable('', 'add', 0, mcpRule).text)), [mcpRule]);
  assert.throws(() => checkedRule({ tool: 'create', decision: 'allow', target: 'file', path: 'app.js' }), { code: 'config_rule_invalid' });
  assert.throws(() => checkedRule({ tool: 'create', decision: 'allow', target: 'workspace', path: join(tmpdir(), 'project'), match: 'x' }), { code: 'config_rule_invalid' });
  assert.throws(() => checkedRule({ tool: 'mcp:browser/click', decision: 'allow', argsHash: 'short' }), { code: 'config_rule_invalid' });
});

test('the rule table writes through the same lock, version check and read-back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-rules-'));
  const file = join(directory, 'config.local.toml');
  try {
    await writeFile(file, RULES, 'utf8');
    const version = configVersion(RULES);
    const added = await writeConfigField(file, {
      field: 'policy.rules',
      op: 'add',
      rule: { tool: 'search', decision: 'deny', reason: '这一台机器上不让搜' },
      version,
    });
    assert.equal(added.rules!.length, 3);
    assert.deepEqual(readRules(await readFile(file, 'utf8'))[2], { tool: 'search', decision: 'deny', reason: '这一台机器上不让搜' });

    await assert.rejects(
      () => writeConfigField(file, { field: 'policy.rules', op: 'remove', index: 0, version }),
      (error: unknown) => (error as { code?: string }).code === 'config_version_stale',
      '旧版本那一次不落笔',
    );
    const removed = await writeConfigField(file, {
      field: 'policy.rules',
      op: 'remove',
      index: 0,
      version: added.version,
    });
    assert.equal(removed.rules!.length, 2);
    assert.deepEqual(removed.rules![0], { tool: 'exec', match: 'git status*', decision: 'allow', reason: '只读的那一条' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 不同但合法的 TOML 写法使用相同的保存流程；保留引号键和每行原有的换行形式。
test('a quoted key lands in place through the write route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-quoted-'));
  const file = join(directory, 'config.toml');
  const original = '[ model ]\n"model" = "gpt-4o" # 那一家的名字\napi = "messages"\r\napiKeyEnv = \'LIGULE_KEY\'\r\n';
  try {
    await writeFile(file, original, 'utf8');
    const first = await writeConfigField(file, { field: 'model.model', value: '新模型名', version: configVersion(original) });
    assert.equal(first.created, false, '那一张表已经在了');
    assert.equal(first.version, configVersion(await readFile(file, 'utf8')));
    const onDisk = await readFile(file, 'utf8');
    assert.equal(onDisk, '[ model ]\n"model" = "新模型名" # 那一家的名字\napi = "messages"\r\napiKeyEnv = \'LIGULE_KEY\'\r\n');
    assert.equal(readToml(onDisk).model.api, 'messages', '没编辑的那几行连换行都没动');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 并发写入时，后到的请求不等待也不覆盖文件，而是报告锁冲突。
test('a file another writer holds is refused while that lock is active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-lock-'));
  const file = join(directory, 'config.toml');
  try {
    await writeFile(file, SAMPLE, 'utf8');
    const held = await lockfile.lock(file, { realpath: false, lockfilePath: `${file}.lock`, stale: 10_000, update: 2_000, retries: 0 });
    try {
      await assert.rejects(
        () => writeConfigField(file, { field: 'model.model', value: '第二个写入者', version: configVersion(SAMPLE) }),
        (error: unknown) => (error as { code?: string }).code === 'config_locked',
      );
      assert.equal(readToml(await readFile(file, 'utf8')).model.model, 'gpt-4o', '锁在那里的那一次一个字都没写');
    } finally {
      await held();
    }
    const after = await writeConfigField(file, { field: 'model.model', value: '锁放了才写', version: configVersion(SAMPLE) });
    assert.equal(after.created, false);
    assert.equal(readToml(await readFile(file, 'utf8')).model.model, '锁放了才写');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 更新只替换字段值；等号与值之间的 Tab 或多个空格应保持原样。
test('a scalar write leaves the whitespace between the equal sign and the value alone', () => {
  const text = '[model]\nmodel\t = \t"gpt-4o"\napi = "messages"\n';
  assert.equal(editTomlValue(text, ['model', 'model'], '"glm-4"').text, '[model]\nmodel\t = \t"glm-4"\napi = "messages"\n');
});

// 删除规则时，只删除属于该规则的注释，不影响下一张规则表之前的注释。
test('removing a rule keeps the comments sitting on the next rule', () => {
  const text = '[[policy.rules]]\ntool = "read"\ndecision = "allow"\n\n# 只读的 diff\n[[policy.rules]]\ntool = "exec"\nmatch = "git diff*"\ndecision = "allow"\n';
  const edited = editRuleTable(text, 'remove', 0);
  assert.equal(edited.text, '# 只读的 diff\n[[policy.rules]]\ntool = "exec"\nmatch = "git diff*"\ndecision = "allow"\n');
  assert.equal(readToml(edited.text).policy.rules.length, 1, '留下的那一条一个字没动');
});

test('removing a rule removes its nested tables and preserves the next rule comments', () => {
  const text = '# 第一项\n[[policy.rules]]\ntool = "first"\ndecision = "deny"\n[policy.rules.meta]\nnote = "discard"\n\n# 第二项\n[[policy.rules]]\ntool = "second"\ndecision = "allow"\n[policy.rules.meta]\nnote = "keep"\n';
  const edited = editRuleTable(text, 'remove', 0);
  assert.equal(edited.text, '# 第二项\n[[policy.rules]]\ntool = "second"\ndecision = "allow"\n[policy.rules.meta]\nnote = "keep"\n');
  const parsed = readToml(edited.text).policy.rules[0];
  assert.deepEqual({ ...parsed, meta: { ...parsed.meta } }, { tool: 'second', decision: 'allow', meta: { note: 'keep' } });
});

test('updating a rule inserts fields before its nested table and preserves that table', () => {
  const text = '[[policy.rules]]\ntool = "read"\ndecision = "allow"\n[policy.rules.meta]\nnote = "keep"\n';
  const edited = editRuleTable(text, 'update', 0, { tool: 'read', decision: 'deny', match: 'src/**' });
  assert.equal(edited.text, '[[policy.rules]]\ntool = "read"\ndecision = "deny"\nmatch = "src/**"\n[policy.rules.meta]\nnote = "keep"\n');
  assert.equal(readToml(edited.text).policy.rules[0].meta.note, 'keep');
});

test('removing or appending around an interleaved unrelated table keeps its bytes and table ownership', () => {
  const text = '# 目标规则\n[[policy.rules]]\ntool = "read"\ndecision = "allow"\n\n# 独立表\n[unrelated]\nvalue = 1\n\n# 规则子表\n[policy.rules.meta]\nnote = "属于规则"\n\n# 后续表\n[after]\nvalue = 2\n';
  const removed = editRuleTable(text, 'remove', 0).text;
  const removedValue = readToml(removed);
  assert.deepEqual({ unrelated: { ...removedValue.unrelated }, after: { ...removedValue.after } }, { unrelated: { value: 1 }, after: { value: 2 } });
  assert.ok(!removed.includes('# 目标规则'));
  assert.ok(!removed.includes('# 规则子表'));
  assert.ok(removed.includes('# 独立表\n[unrelated]\nvalue = 1\n'));
  assert.ok(removed.includes('# 后续表\n[after]\nvalue = 2\n'));

  const added = editRuleTable(text, 'add', 1, { tool: 'find', decision: 'allow' }).text;
  const addedValue = readToml(added);
  const addedRules = addedValue.policy.rules as unknown as RuleDocumentRule[];
  assert.deepEqual(addedRules.map((rule) => ({
    ...rule,
    ...(rule.meta === undefined ? {} : { meta: { ...rule.meta } }),
  })), [
    { tool: 'read', decision: 'allow', meta: { note: '属于规则' } },
    { tool: 'find', decision: 'allow' },
  ]);
  assert.deepEqual({ ...addedValue.unrelated }, { value: 1 });
  assert.deepEqual({ ...addedValue.after }, { value: 2 });
  assert.ok(added.includes('# 独立表\n[unrelated]\nvalue = 1\n'));
  assert.ok(added.includes('# 规则子表\n[policy.rules.meta]\nnote = "属于规则"\n'));
  assert.ok(added.includes('# 后续表\n[after]\nvalue = 2\n'));
});

test('the 37 R2 span scenarios run against the built editor', () => {
  const fields = ['tool', 'match', 'decision', 'reason'];
  const nextRule: PolicyRule = { tool: 'find', decision: 'allow' };
  const updateRule: Record<string, string> = { tool: 'read', decision: 'deny' };
  const cases: Scenario[] = [];
  const addScalar = (name: string, text: string, literal = '"old-model"', promised = true) => {
    cases.push({ name, text, kind: 'scalar', exact: text.replace(literal, '"new-model"'), promised });
  };

  addScalar('scalar-basic', '[model]\nmodel = "old-model" # 模型\n[future]\nvalue = 42\n');
  addScalar('scalar-spacing', '[model]\n  model\t=\t\t"old-model"  # 模型\n[future]\nvalue = 42\n');
  addScalar('scalar-mixed-eol', '[model]\r\nmodel = "old-model"\napi = "messages"\r\n');
  addScalar('scalar-spaced-header', '[ "model" ]\nmodel = "old-model"\n');
  addScalar('scalar-escaped-table', '["mo\\u0064el"]\nmodel = "old-model"\n', '"old-model"', false);
  addScalar('scalar-escaped-key', '[model]\n"mo\\u0064el" = "old-model"\n', '"old-model"', false);
  addScalar('scalar-root-dotted', 'model.model = "old-model" # 说明\n[future]\nvalue = 42\n');
  addScalar('scalar-quoted-dotted', '"model" . "model" = "old-model"\n[future]\nvalue = 42\n');
  addScalar('scalar-unicode-prefix', 'title = "🌿中文"\n[model]\nmodel = "old-model"\n[future]\nvalue = "另一个值"\n');
  addScalar('scalar-no-final-newline', '[model]\nmodel = "old-model"');
  addScalar('scalar-string-body', '[model]\nabout = """\n[future]\nmodel = "正文"\n"""\nmodel = "old-model"\n');
  addScalar('scalar-four-quote-ending', '[model]\nabout = """正文末尾一个引号""""\nmodel = "old-model"\n');
  addScalar('scalar-rich-unknown', '[model]\nmodel = "old-model"\n[future]\nnumber = 0xDEAD_BEEF\nfloating = 1_000.50\nnegativeZero = -0.0\ninfinite = inf\nnotANumber = nan\nwhen = 2026-10-10T10:11:12.123456789+08:00\nlocal = 2026-10-10\nvalues = [{ dotted = { key = "值" } }, { dotted = { key = "其他" } }]\n');

  const canonical = '# 文件说明\n[policy]\nmode = "ask"\n\n# REMOVE-ME\n[[policy.rules]]\ntool = "read"\ndecision = "allow"\n\n# KEEP-ME\n[[policy.rules]]\ntool = "exec"\ndecision = "allow"\n\n# INDEPENDENT\n\n[future]\nvalue = 42\n';
  const ruleDocuments: [string, string, boolean][] = [
    ['rules-basic', canonical, true],
    ['rules-crlf', canonical.replaceAll('\n', '\r\n'), true],
    ['rules-escaped-table', canonical.replaceAll('[[policy.rules]]', '[["po\\u006cicy".rules]]'), false],
    ['rules-nested-unknown', canonical.replace('decision = "allow"\n\n# KEEP-ME', 'decision = "allow"\n[policy.rules.extra]\nvalue = 7\n\n# KEEP-ME'), true],
    ['rules-multiline-reason', canonical.replace('tool = "read"', 'tool = "read"\nreason = """\n[[policy.rules]]\ndecision = "deny"\n"""'), true],
    ['rules-quoted-dot-unknown', '["policy.rules"]\nvalue = "不要编辑"\n\n' + canonical, true],
    ['rules-inline-array', '[policy]\nmode = "ask"\nrules = [{ tool = "read", decision = "allow" }, { tool = "exec", decision = "allow" }]\n[future]\nvalue = 42\n', false],
    ['rules-unknown-rule-field', canonical.replace('tool = "read"', 'tool = "read"\ncustom = { nested = [1, 2, 3] }'), true],
  ];
  for (const [name, text, promised] of ruleDocuments) {
    for (const action of ['add', 'update', 'remove'] as const) cases.push({ name: `${name}-${action}`, text, kind: 'rule', action, promised });
  }

  const expectedValues = (item: Scenario) => {
    const value = readToml(item.text) as unknown as EditableDocument;
    if (item.kind === 'scalar') value.model.model = 'new-model';
    else if (item.action === 'add') value.policy.rules.push(nextRule);
    else if (item.action === 'remove') value.policy.rules.splice(0, 1);
    else {
      for (const field of fields) {
        if (updateRule[field] === undefined) delete value.policy.rules[0][field];
        else value.policy.rules[0][field] = updateRule[field];
      }
    }
    return value;
  };
  const results: Outcome[] = [];
  for (const item of cases) {
    try {
      const output = item.kind === 'scalar'
        ? editTomlValue(item.text, ['model', 'model'], '"new-model"').text
        : editRuleTable(item.text, item.action!, 0, item.action === 'add' ? nextRule : updateRule as PolicyRule).text;
      // TOML 解析表使用空原型；新增项是普通对象，两者的原型不属于配置语义。
      const semanticPass = isDeepStrictEqual(structuredClone(readToml(output)), structuredClone(expectedValues(item)));
      const commentsPass = ['# KEEP-ME', '# INDEPENDENT'].every(value => !item.text.includes(value) || output.includes(value))
        && (!item.text.includes('# REMOVE-ME') || output.includes('# REMOVE-ME') === (item.action !== 'remove'));
      const exactBytes = item.exact === undefined ? undefined : output === item.exact;
      const result = { name: item.name, promised: item.promised, semanticPass, commentsPass, ...(exactBytes === undefined ? {} : { exactBytes }) };
      results.push(result);
    } catch (error) {
      const failure = error as { code?: string; name?: string };
      const result = { name: item.name, promised: item.promised, error: failure.code ?? failure.name };
      results.push(result);
    }
  }
  assert.equal(results.length, 37);
  for (const item of results) {
    if (item.name.startsWith('rules-inline-array-')) assert.equal(item.error, 'config_edit_shape_unsupported', item.name);
    else assert.equal(item.error === undefined && item.semanticPass && item.commentsPass && item.exactBytes !== false, true, item.name);
  }
});

test('atomic config writes preserve permissions and do not touch another temporary file', async () => {
  const scratch = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'config-permissions-'));
  const file = join(directory, 'config.toml');
  try {
    await writeFile(`${file}.tmp`, 'another writer owns these bytes', 'utf8');
    const first = await writeConfigField(file, { field: 'model.model', value: 'first', version: '' });
    assert.equal(await readFile(`${file}.tmp`, 'utf8'), 'another writer owns these bytes');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      await chmod(file, 0o640);
    }
    await writeConfigField(file, { field: 'model.model', value: 'second', version: first.version });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o640);
    await assert.rejects(writeConfigField(file, { field: 'model.model', value: 'stale', version: first.version }), (error: unknown) => (error as { code?: string }).code === 'config_version_stale');
    assert.equal(readToml(await readFile(file, 'utf8')).model.model, 'second');
    assert.deepEqual((await readdir(directory)).sort(), ['config.toml', 'config.toml.tmp']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// MCP 服务器表：set 落成独立表、remove 只删目标、非法条目拒绝，写出的配置能被读取侧解析。
const MCP_SAMPLE = `# 使用者默认
[model]
model = "gpt-4o"

[mcp.servers.runner]
command = "npx" # 启动命令
args = ["-y", "old-server"]
`;

test('mcp.servers set appends a per-server table and keeps the rest byte for byte', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-mcp-edit-'));
  try {
    const file = join(directory, 'config.toml');
    await writeFile(file, MCP_SAMPLE, 'utf8');
    const version = configVersion(await readFile(file, 'utf8'));
    const done = await writeConfigField(file, {
      field: 'mcp.servers', version, op: 'set',
      server: { name: 'weather', command: 'npx', args: ['-y', 'weather-mcp'], env: { KEY: '${WEATHER_KEY}' } },
    });
    assert.equal(done.created, true);
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes('[mcp.servers.runner]'), '已有服务器不动');
    assert.ok(text.includes('command = "npx" # 启动命令'), '已有服务器的注释留着');
    const parsed = readToml(text);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.mcp.servers.weather)), { command: 'npx', args: ['-y', 'weather-mcp'], env: { KEY: '${WEATHER_KEY}' } });
    assert.deepEqual((await import('../dist/capability/mcp.js')).mcpServerConfigs(parsed).map((entry) => entry.name), ['runner', 'weather'], '读取侧认得写出的配置');

    // 同名 set 整表替换；其他服务器保持原字节。
    const second = await writeConfigField(file, {
      field: 'mcp.servers', version: done.version, op: 'set',
      server: { name: 'runner', command: 'node', args: ['server.js'], cwd: 'tools' },
    });
    assert.equal(second.created, false);
    const after = readToml(await readFile(file, 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(after.mcp.servers.runner)), { command: 'node', args: ['server.js'], cwd: 'tools' });
    assert.deepEqual(after.mcp.servers.weather.command, 'npx', '其他服务器不受影响');

    // remove 只需要名字。
    const third = await writeConfigField(file, { field: 'mcp.servers', version: second.version, op: 'remove', server: { name: 'weather' } });
    assert.equal(third.created, false);
    const final = readToml(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(final.mcp.servers))), ['runner']);
    assert.ok((await readFile(file, 'utf8')).includes('# 使用者默认'), '文件其余部分不动');

    await assert.rejects(
      writeConfigField(file, { field: 'mcp.servers', version: third.version, op: 'remove', server: { name: 'weather' } }),
      (error: unknown) => (error as { code?: string }).code === 'config_mcp_unknown', '删除不存在的服务器要说清',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid mcp server entries are refused before anything is written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-mcp-edit-'));
  try {
    const file = join(directory, 'config.toml');
    await writeFile(file, MCP_SAMPLE, 'utf8');
    const version = configVersion(await readFile(file, 'utf8'));
    for (const server of [
      { name: 'bad name', command: 'npx' },
      { name: 'x', command: '' },
      { name: 'x', command: 'npx', args: ['-y', 3] },
      { name: 'x', command: 'npx', env: { KEY: 'literal-secret' } },
      { name: 'x', command: 'npx', extra: true },
      { command: 'npx' },
    ]) {
      await assert.rejects(
        writeConfigField(file, { field: 'mcp.servers', version, op: 'set', server }),
        (error: unknown) => (error as { code?: string }).code === 'config_mcp_invalid', JSON.stringify(server),
      );
    }
    assert.equal(await readFile(file, 'utf8'), MCP_SAMPLE, '拒绝的写入不落盘');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
