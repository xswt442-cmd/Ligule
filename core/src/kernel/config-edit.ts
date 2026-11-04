// TOML 解析器提供语法节点和文本范围；编辑器只修改允许字段和规则表。
// 写入前校验文件版本和完整配置，同时保留其他注释、键顺序和原始字节。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { getStaticTOMLValue, parseTOML, traverseNodes, VisitorKeys, type AST } from 'toml-eslint-parser';
import lockfile from 'proper-lockfile';
import { isDeepStrictEqual } from 'node:util';
import { KernelError, KernelRuntimeError } from './error.js';
import { POLICY_MODES, POLICY_SEMANTICS } from './policy.js';
import { modelSelection, modelServices, selectionLiteral, servicesLiteral } from './model-services.js';

/** `[[policy.rules]]` 中的一条工具规则。 */
export type PolicyRule = {
  tool: string;
  match?: string;
  decision: 'allow' | 'ask' | 'deny';
  reason?: string;
  target?: 'file' | 'workspace';
  path?: string;
  argsHash?: string;
};

/** 配置写入请求：标量字段使用 `value`，规则表使用 `op` 和 `rule`，MCP 服务器表使用 `op` 和 `server`；更新或删除还需提供 `index`。 */
export type WriteRequest = {
  field: string;
  version: string;
  value?: unknown;
  op?: unknown;
  index?: unknown;
  rule?: unknown;
  server?: unknown;
};

/** 可写配置字段及其文件路径和允许的值类型。 */
export type EditableField = {
  readonly path: readonly [string, string];
  readonly kind: 'string' | 'enum' | 'url' | 'envName' | 'rules' | 'services' | 'selection' | 'positiveInteger' | 'boolean' | 'mcpServer';
  readonly oneOf?: readonly string[];
};

// Host 维护可写字段白名单；客户端不能指定其他键或文件路径。
export const EDITABLE: Readonly<Record<string, EditableField>> = {
  'model.api': { path: ['model', 'api'], kind: 'enum', oneOf: ['messages', 'chat-completions'] },
  'model.model': { path: ['model', 'model'], kind: 'string' },
  'model.baseURL': { path: ['model', 'baseURL'], kind: 'url' },
  'model.apiKeyEnv': { path: ['model', 'apiKeyEnv'], kind: 'envName' },
  'model.services': { path: ['model', 'services'], kind: 'services' },
  'model.selection': { path: ['model', 'selection'], kind: 'selection' },
  'model.outputTokens': { path: ['model', 'outputTokens'], kind: 'positiveInteger' },
  'policy.mode': { path: ['policy', 'mode'], kind: 'enum', oneOf: POLICY_MODES },
  'policy.rules': { path: ['policy', 'rules'], kind: 'rules' },
  'mcp.servers': { path: ['mcp', 'servers'], kind: 'mcpServer' },
  // 复审默认关闭；启用后才在 `auto` 无法确定性放行时调用一次模型复审。
  'reviewer.enabled': { path: ['reviewer', 'enabled'], kind: 'boolean' },
  'reviewer.api': { path: ['reviewer', 'api'], kind: 'enum', oneOf: ['messages', 'chat-completions'] },
  'reviewer.model': { path: ['reviewer', 'model'], kind: 'string' },
  'reviewer.baseURL': { path: ['reviewer', 'baseURL'], kind: 'url' },
  'reviewer.apiKeyEnv': { path: ['reviewer', 'apiKeyEnv'], kind: 'envName' },
  'reviewer.maxInputTokens': { path: ['reviewer', 'maxInputTokens'], kind: 'positiveInteger' },
  'reviewer.maxOutputTokens': { path: ['reviewer', 'maxOutputTokens'], kind: 'positiveInteger' },
  'reviewer.timeoutMs': { path: ['reviewer', 'timeoutMs'], kind: 'positiveInteger' },
  'reviewer.maxPerRun': { path: ['reviewer', 'maxPerRun'], kind: 'positiveInteger' },
  'reviewer.maxTotalTokens': { path: ['reviewer', 'maxTotalTokens'], kind: 'positiveInteger' },
};

export function editableField(field: unknown): EditableField {
  if (typeof field !== 'string' || EDITABLE[field] === undefined) {
    throw new KernelError('config_field_unknown', { detail: `writable fields: ${Object.keys(EDITABLE).join(', ')}` });
  }
  return EDITABLE[field];
}

/** 校验字段值，并返回用于 TOML 写入和回读比较的表示。 */
export function encodeValue(field: EditableField, value: unknown): { literal: string; value: unknown } {
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new KernelError('config_field_value', { detail: 'takes true or false' });
    }
    return { literal: value ? 'true' : 'false', value };
  }
  if (field.kind === 'positiveInteger') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new KernelError('config_field_value', { detail: 'takes a positive safe integer' });
    }
    return { literal: String(value), value };
  }
  if (field.kind === 'services') {
    const services = modelServices(value);
    return { literal: servicesLiteral(services), value: services };
  }
  if (field.kind === 'selection') {
    const selection = modelSelection(value);
    return { literal: selectionLiteral(selection), value: selection };
  }
  if (field.kind === 'enum') {
    if (typeof value !== 'string' || !field.oneOf!.includes(value)) {
      throw new KernelError('config_field_value', { detail: `takes one of: ${field.oneOf!.join(', ')}` });
    }
    return { literal: JSON.stringify(value), value };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KernelError('config_field_value', { detail: 'takes a non-empty string' });
  }
  const text = value.trim();
  if (field.kind === 'url') {
    let url: URL;
    try {
      url = new URL(text);
    } catch (cause) {
      throw new KernelError('config_field_value', { cause, detail: 'takes a full URL including the scheme' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new KernelError('config_field_value', { detail: 'takes an http or https URL' });
    }
    // 凭据通过环境变量引用；不要将密钥写入 URL 或配置文件。
    if (url.username !== '' || url.password !== '') {
      throw new KernelError('config_field_value', { detail: 'credentials do not belong in the address' });
    }
  }
  if (field.kind === 'envName' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new KernelError('config_field_value', { detail: 'takes one environment variable name, not its value' });
  }
  return { literal: JSON.stringify(text), value: text };
}

// 使用 AST 中的 TOML 结构和键路径，只替换原文中对应的跨度。
type ParsedPair = { node: AST.TOMLKeyValue; path: (string | number)[] };
type ParsedDocument = { root: AST.TOMLProgram; tables: AST.TOMLTable[]; pairs: ParsedPair[] };
type TextEdit = { start: number; end: number; text: string };

function parseDocument(text: string): ParsedDocument {
  let root: AST.TOMLProgram;
  try {
    root = parseTOML(text, { tomlVersion: '1.1.0' });
  } catch (cause) {
    throw new KernelError('config_file_invalid', { cause, detail: 'the TOML document cannot be read' });
  }
  const tables: AST.TOMLTable[] = [];
  const pairs: ParsedPair[] = [];
  traverseNodes(root, {
    visitorKeys: VisitorKeys,
    enterNode(node) {
      if (node.type === 'TOMLTable') tables.push(node);
      if (node.type !== 'TOMLKeyValue') return;
      const parent = node.parent;
      if (parent.type !== 'TOMLTable' && parent.type !== 'TOMLTopLevelTable') return;
      pairs.push({
        node,
        path: [...(parent.type === 'TOMLTable' ? parent.resolvedKey : []), ...getStaticTOMLValue(node.key)],
      });
    },
    leaveNode() {},
  });
  tables.sort((left, right) => left.range[0] - right.range[0]);
  pairs.sort((left, right) => left.node.range[0] - right.node.range[0]);
  return { root, tables, pairs };
}

const sameTomlPath = (left: readonly (string | number)[], right: readonly (string | number)[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const startsWithTomlPath = (path: readonly (string | number)[], prefix: readonly (string | number)[]): boolean =>
  path.length >= prefix.length && prefix.every((part, index) => part === path[index]);

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function lineEnd(text: string, offset: number): number {
  const next = text.indexOf('\n', Math.max(0, offset));
  return next === -1 ? text.length : next + 1;
}

function lineEndingAt(text: string, offset: number): string {
  const start = lineStart(text, Math.min(offset, text.length));
  const next = text.indexOf('\n', start);
  if (next !== -1) return text[next - 1] === '\r' ? '\r\n' : '\n';
  const previous = text.lastIndexOf('\n', Math.max(0, start - 1));
  return previous > 0 && text[previous - 1] === '\r' ? '\r\n' : '\n';
}

function standaloneComment(text: string, comment: AST.Comment): boolean {
  return comment.loc.start.line === comment.loc.end.line
    && text.slice(lineStart(text, comment.range[0]), comment.range[0]).trim() === '';
}

function leadingCommentStart(text: string, root: AST.TOMLProgram, table: AST.TOMLTable): number {
  let line = table.loc.start.line - 1;
  let start = lineStart(text, table.range[0]);
  while (line > 0) {
    const comment = root.comments.find((item) => item.loc.start.line === line && item.loc.end.line === line && standaloneComment(text, item));
    if (comment === undefined) break;
    start = lineStart(text, comment.range[0]);
    line -= 1;
  }
  return start;
}

function trailingCommentStart(text: string, root: AST.TOMLProgram): number | undefined {
  const comment = [...root.comments].reverse().find((item) =>
    standaloneComment(text, item) && text.slice(item.range[1]).trim() === '',
  );
  if (comment === undefined) return undefined;
  let line = comment.loc.start.line;
  let start = lineStart(text, comment.range[0]);
  for (;;) {
    const previous = root.comments.find((item) =>
      item.loc.start.line === line - 1 && item.loc.end.line === line - 1 && standaloneComment(text, item),
    );
    if (previous === undefined) return start;
    line -= 1;
    start = lineStart(text, previous.range[0]);
  }
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
  let boundary = text.length + 1;
  let result = text;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length || edit.end > boundary) {
      throw new KernelError('config_edit_verify_failed', { detail: 'TOML edit ranges overlap or exceed the document' });
    }
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
    boundary = edit.start;
  }
  return result;
}

function valueShape(value: AST.TOMLContentNode): string | undefined {
  if (value.type === 'TOMLArray') return 'an array';
  if (value.type === 'TOMLInlineTable') return 'an inline table';
  if (value.type === 'TOMLValue' && value.kind === 'string' && value.multiline) return 'a multi-line string';
  return undefined;
}

function changeTomlValue(pair: ParsedPair, literal: string): TextEdit {
  const shape = valueShape(pair.node.value);
  if (shape !== undefined) {
    throw new KernelError('config_edit_shape_unsupported', {
      detail: `${pair.path.join('.')} holds ${shape}; only a single scalar value can be changed`,
    });
  }
  return { start: pair.node.value.range[0], end: pair.node.value.range[1], text: literal };
}

function standardTable(tables: AST.TOMLTable[], path: readonly (string | number)[]): AST.TOMLTable | undefined {
  return tables.find((table) => table.kind === 'standard' && sameTomlPath(table.resolvedKey, path));
}

function appendTomlTable(text: string, table: string, key: string, literal: string): string {
  const eol = lineEndingAt(text, text.length);
  const prefix = text === ''
    ? ''
    : text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${text}${prefix}[${table}]${eol}${key} = ${literal}${eol}`;
}

/** 在原文中替换指定值并保留其他字节；键不存在时在对应表中新增一行。 */
export function editTomlValue(text: string, path: readonly [string, string], literal: string, structured = false): { text: string; created: boolean } {
  const parsed = parseDocument(text);
  const existing = parsed.pairs.find((pair) => sameTomlPath(pair.path, path));
  if (existing !== undefined) {
    if (structured) {
      // 受管数组或表包含注释时拒绝整体替换，避免丢失手工编辑内容。
      if (parsed.root.comments.some((comment) => comment.range[0] > existing.node.value.range[0] && comment.range[1] < existing.node.value.range[1])) {
        throw new KernelError('config_edit_shape_unsupported', { detail: 'the managed value contains comments; edit this value in the config file' });
      }
      return { text: applyTextEdits(text, [{ start: existing.node.value.range[0], end: existing.node.value.range[1], text: literal }]), created: false };
    }
    return { text: applyTextEdits(text, [changeTomlValue(existing, literal)]), created: false };
  }

  const [tableName, key] = path;
  const table = standardTable(parsed.tables, [tableName]);
  if (table !== undefined) {
    const directPairs = parsed.pairs.filter((pair) =>
      pair.node.parent === table && pair.path.length === 2 && pair.path[0] === tableName,
    );
    const last = directPairs.filter((pair) => valueShape(pair.node.value) !== 'a multi-line string').at(-1);
    const anchor = last?.node.range[1] ?? table.key.range[0];
    const at = lineEnd(text, anchor);
    const eol = lineEndingAt(text, anchor);
    const prefix = at === text.length && !text.endsWith('\n') ? eol : '';
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `${prefix}${key} = ${literal}${eol}` }]),
      created: true,
    };
  }

  const rootPairs = parsed.pairs.filter((pair) =>
    pair.node.parent.type === 'TOMLTopLevelTable'
      && pair.path.length > 1
      && pair.path[0] === tableName,
  );
  const rootPair = rootPairs.at(-1);
  if (rootPair !== undefined) {
    const anchor = rootPair.node.range[1];
    const at = lineEnd(text, anchor);
    const eol = lineEndingAt(text, anchor);
    const prefix = at === text.length && !text.endsWith('\n') ? eol : '';
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `${prefix}${tableName}.${key} = ${literal}${eol}` }]),
      created: true,
    };
  }

  const descendant = parsed.tables.find((candidate) =>
    startsWithTomlPath(candidate.resolvedKey, [tableName]) && candidate.resolvedKey.length > 1,
  );
  if (descendant !== undefined) {
    const at = leadingCommentStart(text, parsed.root, descendant);
    const eol = lineEndingAt(text, descendant.range[0]);
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `[${tableName}]${eol}${key} = ${literal}${eol}${eol}` }]),
      created: true,
    };
  }
  return { text: appendTomlTable(text, tableName, key, literal), created: true };
}

/** 文件内容版本；客户端写入时必须提交最近读取的版本。 */
export function configVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 一次读取设置文件并返回对应版本；文件不存在时返回空版本和空表。 */
export async function readConfigLayer(file: string): Promise<{ version: string; table: Record<string, unknown> }> {
  let text: string;
  try {
    text = (await readFile(resolve(file))).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: '', table: {} };
    throw new KernelRuntimeError('config_file_read_failed', { cause: error, detail: file });
  }
  try {
    return { version: configVersion(text), table: parse(text) as Record<string, unknown> };
  } catch (error) {
    throw new KernelRuntimeError('config_file_read_failed', { cause: error, detail: file });
  }
}

/** 锁定文件、校验版本、应用修改并回读验证，最后通过临时文件和重命名原子写入。 */
export async function writeConfigField(
  file: string,
  request: WriteRequest,
  validate?: (candidate: Record<string, unknown>) => void | Promise<void>,
): Promise<{ version: string; created: boolean; rules?: PolicyRule[] }> {
  const definition = editableField(request.field);
  if (typeof request.version !== 'string') throw new KernelError('config_field_value', { detail: 'the version read from that file is required' });
  const scalar = definition.kind === 'rules' || definition.kind === 'mcpServer' ? undefined : encodeValue(definition, request.value);
  const op = definition.kind === 'rules' ? checkedOp(request.op)
    : definition.kind === 'mcpServer' ? checkedMcpOp(request.op) : undefined;
  const index = definition.kind === 'rules' ? checkedIndex(request.index) : 0;
  const rule = definition.kind === 'rules' && op !== 'remove' ? checkedRule(request.rule) : undefined;
  const server = definition.kind === 'mcpServer' && op !== 'remove' ? checkedMcpServer(request.server)
    : definition.kind === 'mcpServer' ? checkedMcpServerName(request.server) : undefined;
  const target = resolve(file);
  let release: () => Promise<void>;
  try {
    await mkdir(dirname(target), { recursive: true });
    release = await lockfile.lock(target, { realpath: false, lockfilePath: `${target}.lock`, stale: 10_000, update: 2_000, retries: 0 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') throw new KernelError('config_locked', { detail: `${target} has an active writer` });
    throw new KernelRuntimeError('config_lock_failed', { cause, detail: target });
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    let current = '';
    let exists = true;
    let mode: number | undefined;
    try {
      const bytes = await readFile(target);
      current = bytes.toString('utf8');
      mode = (await stat(target)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new KernelRuntimeError('config_file_read_failed', { cause: error, detail: target });
      }
      exists = false;
    }
    // 版本比较和写入都在同一文件锁内完成，避免覆盖其他进程的更新。
    // 文件不存在时使用空版本；已存在的空文件仍使用其内容哈希。
    if ((exists ? configVersion(current) : '') !== request.version) {
      throw new KernelError('config_version_stale', { detail: `${target} changed since it was read; nothing was written` });
    }
    const read = (text: string, code: 'config_file_invalid' | 'config_edit_verify_failed'): Record<string, unknown> => {
      try {
        return parse(text) as Record<string, unknown>;
      } catch (cause) {
        throw new KernelError(code, { cause, detail: `${code === 'config_file_invalid' ? 'that file' : 'the edited text'} does not read back as TOML` });
      }
    };
    const before = definition.kind === 'rules' ? rulesOfLayer(read(current, 'config_file_invalid')) : [];
    const beforeServers = definition.kind === 'mcpServer' ? mcpServersOfLayer(read(current, 'config_file_invalid')) : {};
    let edited = scalar === undefined
      ? definition.kind === 'mcpServer'
        ? editMcpServerTable(current, op as McpOp, server as McpServerWrite)
        : editRuleTable(current, op as RuleOp, index, rule)
      : editTomlValue(current, definition.path, scalar.literal, definition.kind === 'services' || definition.kind === 'selection');
    // 审批档位写入时同时标记语义版本，读取方据此区分新四档与历史的 none/never 字面值。
    if (definition.path[0] === 'policy' && definition.path[1] === 'mode') {
      edited = editTomlValue(edited.text, ['policy', 'semantics'], String(POLICY_SEMANTICS), false);
    }
    const parsed = read(edited.text, 'config_edit_verify_failed');
    if (scalar === undefined && definition.kind === 'rules') {
      // 比较整个规则表，检测写入期间其他规则是否发生变化。
      const landed = digestRules(rulesOfLayer(parsed));
      const wanted = digestRules(expectedRules(before, op as RuleOp, index, rule));
      if (landed !== wanted) {
        throw new KernelError('config_edit_verify_failed', { detail: `policy.rules reads back as ${landed}` });
      }
    } else if (scalar === undefined) {
      // 比较整个服务器表，检测写入期间其他服务器是否发生变化。
      const landedServers = mcpServersOfLayer(parsed);
      const wantedServers = expectedMcpServers(beforeServers, op as McpOp, server as McpServerWrite);
      if (!isDeepStrictEqual(structuredClone(landedServers), structuredClone(wantedServers))) {
        throw new KernelError('config_edit_verify_failed', { detail: `mcp.servers reads back as ${JSON.stringify(Object.keys(landedServers).sort())}` });
      }
    } else {
      const landed = definition.path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], parsed);
      if (!isDeepStrictEqual(structuredClone(landed), structuredClone(scalar.value))) {
        throw new KernelError('config_edit_verify_failed', { detail: `${definition.path.join('.')} reads back as ${JSON.stringify(landed)}` });
      }
    }
    await validate?.(parsed);
    const handle = await open(temporary, 'wx', mode ?? 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(edited.text, 'utf8');
      await handle.chmod(mode ?? 0o600);
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    temporaryCreated = false;
    return {
      version: configVersion(edited.text),
      created: edited.created,
      ...(definition.kind === 'rules' ? { rules: expectedRules(before, op as RuleOp, index, rule) } : {}),
    };
  } finally {
    try {
      if (temporaryCreated) await rm(temporary, { force: true });
    } finally {
      try {
        await release();
      } catch (cause) {
        throw new KernelRuntimeError('config_unlock_failed', { cause, detail: target });
      }
    }
  }
}

// `[[policy.rules]]` 规则表的增删改。

const RULE_FIELDS = ['tool', 'match', 'decision', 'reason', 'target', 'path', 'argsHash'] as const;
const RULE_OPS = ['add', 'update', 'remove'] as const;
type RuleOp = (typeof RULE_OPS)[number];

function isPortableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/]/u.test(value);
}

function checkedOp(op: unknown): RuleOp {
  if (typeof op !== 'string' || !(RULE_OPS as readonly string[]).includes(op)) {
    throw new KernelError('config_rule_invalid', { detail: `op takes one of: ${RULE_OPS.join(', ')}` });
  }
  return op as RuleOp;
}

function checkedIndex(index: unknown): number {
  if (index === undefined) return 0;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new KernelError('config_rule_invalid', { detail: 'index takes a whole rule position starting at 0' });
  }
  return index;
}

/** 校验规则字段、非空值和动作类型；无效规则不得写入文件。 */
export function checkedRule(input: unknown): PolicyRule {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new KernelError('config_rule_invalid', { detail: `a rule is an object of: ${RULE_FIELDS.join(', ')}` });
  }
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(RULE_FIELDS as readonly string[]).includes(key)) {
      throw new KernelError('config_rule_invalid', { detail: `${key} is not one of: ${RULE_FIELDS.join(', ')}` });
    }
  }
  const text = (key: string): string | undefined => {
    const value = given[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new KernelError('config_rule_invalid', { detail: `${key} takes a non-empty string` });
    }
    return value.trim();
  };
  const tool = text('tool');
  const decision = text('decision');
  if (tool === undefined) throw new KernelError('config_rule_invalid', { detail: 'tool is required' });
  if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') {
    throw new KernelError('config_rule_invalid', { detail: 'decision takes allow, ask, or deny' });
  }
  const match = text('match');
  const reason = text('reason');
  const target = text('target');
  const path = text('path');
  const argsHash = text('argsHash');
  if (target !== undefined && target !== 'file' && target !== 'workspace') {
    throw new KernelError('config_rule_invalid', { detail: 'target takes file or workspace' });
  }
  if ((target === undefined) !== (path === undefined)) {
    throw new KernelError('config_rule_invalid', { detail: 'target and path must be set together' });
  }
  if (target !== undefined && match !== undefined) {
    throw new KernelError('config_rule_invalid', { detail: 'a path-scoped rule cannot also use command match' });
  }
  if (target !== undefined && argsHash !== undefined) {
    throw new KernelError('config_rule_invalid', { detail: 'a path-scoped rule cannot also use argsHash' });
  }
  if (target !== undefined && path !== undefined && !isPortableAbsolutePath(path)) {
    throw new KernelError('config_rule_invalid', { detail: 'path-scoped rules require an absolute path' });
  }
  if (argsHash !== undefined && !/^[a-f0-9]{64}$/u.test(argsHash)) {
    throw new KernelError('config_rule_invalid', { detail: 'argsHash must be a SHA-256 digest' });
  }
  return {
    tool,
    decision,
    ...(match === undefined ? {} : { match }),
    ...(reason === undefined ? {} : { reason }),
    ...(target === undefined ? {} : { target: target as 'file' | 'workspace', path }),
    ...(argsHash === undefined ? {} : { argsHash }),
  };
}

/** 在原文中添加、更新或删除一条规则，并保留规则表之外的字节。 */
const RULES_PATH = ['policy', 'rules'] as const;

function ruleTables(document: ParsedDocument): AST.TOMLTable[] {
  return document.tables.filter((table) =>
    table.kind === 'array'
      && table.resolvedKey.length === 3
      && sameTomlPath(table.resolvedKey.slice(0, 2), RULES_PATH)
      && typeof table.resolvedKey[2] === 'number',
  );
}

function ruleDescendants(document: ParsedDocument, rule: AST.TOMLTable): AST.TOMLTable[] {
  return document.tables.filter((table) => startsWithTomlPath(table.resolvedKey, rule.resolvedKey));
}

function ruleTableEdit(text: string, document: ParsedDocument, table: AST.TOMLTable): TextEdit {
  const next = document.tables.find((candidate) => candidate.range[0] >= table.range[1]);
  const end = next === undefined
    ? trailingCommentStart(text, document.root) ?? text.length
    : leadingCommentStart(text, document.root, next);
  return { start: leadingCommentStart(text, document.root, table), end, text: '' };
}

function ruleBlockText(rule: PolicyRule, eol: string): string {
  const rows = [`[[policy.rules]]`];
  for (const key of RULE_FIELDS) {
    const value = rule[key];
    if (value !== undefined) rows.push(`${key} = ${JSON.stringify(value)}`);
  }
  return `${rows.join(eol)}${eol}`;
}

export function editRuleTable(text: string, op: RuleOp, index: number, rule?: PolicyRule): { text: string; created: boolean } {
  const document = parseDocument(text);
  if (document.pairs.some((pair) => sameTomlPath(pair.path, RULES_PATH))) {
    throw new KernelError('config_edit_shape_unsupported', { detail: 'policy.rules must use array-of-table headers for rule editing' });
  }
  const rules = ruleTables(document);
  if (op === 'add') {
    const last = rules.at(-1);
    if (last === undefined) {
      const eol = lineEndingAt(text, text.length);
      const prefix = text === ''
        ? ''
        : text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`;
      return { text: `${text}${prefix}${ruleBlockText(rule as PolicyRule, eol)}`, created: true };
    }
    const descendants = ruleDescendants(document, last);
    const tail = descendants.at(-1) ?? last;
    const next = document.tables.find((table) =>
      table.range[0] >= tail.range[1] && !startsWithTomlPath(table.resolvedKey, last.resolvedKey),
    );
    const at = next === undefined
      ? trailingCommentStart(text, document.root) ?? text.length
      : leadingCommentStart(text, document.root, next);
    const eol = lineEndingAt(text, Math.max(0, at - 1));
    const prefix = at === text.length && !text.slice(0, at).endsWith('\n') ? eol : '';
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `${prefix}${ruleBlockText(rule as PolicyRule, eol)}` }]),
      created: false,
    };
  }

  const target = rules[index];
  if (target === undefined) {
    throw new KernelError('config_rule_index', { detail: `that file has ${rules.length} rules, so rule ${index} is not one of them` });
  }
  if (op === 'remove') {
    const edits = ruleDescendants(document, target).map((table) => ruleTableEdit(text, document, table));
    return { text: applyTextEdits(text, edits), created: false };
  }

  const wanted = rule as PolicyRule;
  const fields = document.pairs.filter((pair) =>
    startsWithTomlPath(pair.path, target.resolvedKey) && pair.path.length === target.resolvedKey.length + 1,
  );
  const seen = new Set<string>();
  const edits: TextEdit[] = [];
  for (const pair of fields) {
    const name = String(pair.path.at(-1));
    if (!(RULE_FIELDS as readonly string[]).includes(name)) continue;
    seen.add(name);
    const value = wanted[name as keyof PolicyRule];
    if (value === undefined) {
      edits.push({
        start: lineStart(text, pair.node.range[0]),
        end: lineEnd(text, pair.node.range[1] - 1),
        text: '',
      });
    } else {
      edits.push(changeTomlValue(pair, JSON.stringify(value)));
    }
  }
  const toAdd = RULE_FIELDS.filter((key) => wanted[key] !== undefined && !seen.has(key));
  if (toAdd.length > 0) {
    const retained = fields.filter((pair) => {
      const name = String(pair.path.at(-1));
      return valueShape(pair.node.value) !== 'a multi-line string'
        && (!(RULE_FIELDS as readonly string[]).includes(name) || wanted[name as keyof PolicyRule] !== undefined);
    });
    const last = retained.at(-1);
    const anchor = last?.node.range[1] ?? target.key.range[0];
    const at = lineEnd(text, anchor);
    const eol = lineEndingAt(text, anchor);
    const prefix = at === text.length && !text.endsWith('\n') ? eol : '';
    edits.push({ start: at, end: at, text: `${prefix}${toAdd.map((key) => `${key} = ${JSON.stringify(wanted[key])}${eol}`).join('')}` });
  }
  return { text: applyTextEdits(text, edits), created: false };
}

/** 解析规则表；遇到无效条目时返回错误，不静默丢弃。 */
export function rulesOfLayer(parsed: Record<string, unknown>): PolicyRule[] {
  const policy = parsed.policy;
  if (policy === undefined) return [];
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new KernelError('config_edit_shape_unsupported', { detail: '[policy] is not a table' });
  }
  const rules = (policy as Record<string, unknown>).rules;
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new KernelError('config_edit_shape_unsupported', { detail: 'policy.rules is not a table array' });
  return rules.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new KernelError('config_edit_shape_unsupported', { detail: 'a rule is not a table' });
    }
    const given = item as Record<string, unknown>;
    return Object.fromEntries(RULE_FIELDS.flatMap((key) => {
      const value = given[key];
      return typeof value === 'string' && value !== '' ? [[key, value]] : [];
    })) as unknown as PolicyRule;
  });
}

/** 根据本次修改计算预期的回读结果。 */
export function expectedRules(current: PolicyRule[], op: RuleOp, index: number, rule?: PolicyRule): PolicyRule[] {
  const list = current.map((item) => ({ ...item }));
  if (op === 'add') list.push({ ...(rule as PolicyRule) });
  else if (op === 'remove') list.splice(index, 1);
  else {
    const target: Record<string, unknown> = { ...list[index] };
    for (const key of RULE_FIELDS) {
      const value = (rule as PolicyRule)[key];
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    list[index] = target as unknown as PolicyRule;
  }
  return list;
}

// 统一生成比较用的规则表示；未知字段不参与比较。
export function digestRules(list: PolicyRule[]): string {
  return list
    .map((rule) => RULE_FIELDS.map((key) => `${key}=${JSON.stringify(rule[key] ?? '')}`).join(' '))
    .join('\n');
}

// `[mcp.servers.<name>]` 服务器表的设置与删除。

const MCP_FIELDS = ['command', 'args', 'env', 'cwd'] as const;
const MCP_OPS = ['set', 'remove'] as const;
type McpOp = (typeof MCP_OPS)[number];
const MCP_TABLE_PATH = ['mcp', 'servers'] as const;

// 名称进入表头、工具身份 `mcp:<server>/<tool>` 与界面展示；限定为常用标识符字符。
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// `env` 只接受 `${NAME}` 环境变量引用，明文凭据不写入配置文件。
const MCP_ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

export type McpServerWrite = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

/** 删除操作只需要服务器名；名称约束与完整条目一致。 */
type McpServerRef = Pick<McpServerWrite, 'name'> & Partial<Omit<McpServerWrite, 'name'>>;

export function checkedMcpServerName(input: unknown): McpServerRef {
  const name = (input === null || typeof input !== 'object' || Array.isArray(input) ? undefined : (input as Record<string, unknown>).name);
  if (typeof name !== 'string' || !MCP_NAME.test(name) || name.length > 64) {
    throw new KernelError('config_mcp_invalid', { detail: 'name takes letters, digits, dots, underscores and hyphens, starting with a letter or digit' });
  }
  return { name };
}

export function checkedMcpOp(op: unknown): McpOp {
  if (typeof op !== 'string' || !(MCP_OPS as readonly string[]).includes(op)) {
    throw new KernelError('config_mcp_invalid', { detail: `op takes one of: ${MCP_OPS.join(', ')}` });
  }
  return op as McpOp;
}

/** 校验服务器条目；与读取侧 mcpServerConfigs 的约束一致，无效条目不写入文件。 */
export function checkedMcpServer(input: unknown): McpServerWrite {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new KernelError('config_mcp_invalid', { detail: `a server is an object of name, ${MCP_FIELDS.join(', ')}` });
  }
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (key !== 'name' && !(MCP_FIELDS as readonly string[]).includes(key)) {
      throw new KernelError('config_mcp_invalid', { detail: `${key} is not one of: name, ${MCP_FIELDS.join(', ')}` });
    }
  }
  const name = given.name;
  if (typeof name !== 'string' || !MCP_NAME.test(name) || name.length > 64) {
    throw new KernelError('config_mcp_invalid', { detail: 'name takes letters, digits, dots, underscores and hyphens, starting with a letter or digit' });
  }
  const command = given.command;
  if (typeof command !== 'string' || command.trim() === '' || /[\r\n\u0000]/u.test(command)) {
    throw new KernelError('config_mcp_invalid', { detail: 'command takes the executable path without arguments; put its arguments in args' });
  }
  const args = given.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))) {
    throw new KernelError('config_mcp_invalid', { detail: 'args takes an array of strings' });
  }
  const env = given.env;
  if (env !== undefined) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new KernelError('config_mcp_invalid', { detail: 'env takes a table of ${NAME} references' });
    }
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      // 键进入 TOML 与子进程环境；限制为环境变量名，避免生成无法回读的内联表。
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new KernelError('config_mcp_invalid', { detail: `env.${JSON.stringify(key)} is not an environment variable name` });
      }
      if (typeof value !== 'string' || !MCP_ENV_REF.test(value)) {
        throw new KernelError('config_mcp_invalid', { detail: `env.${key} takes a \${NAME} environment variable reference, not its value` });
      }
    }
  }
  const cwd = given.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
    throw new KernelError('config_mcp_invalid', { detail: 'cwd takes a non-empty path' });
  }
  return {
    name,
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env: env as Record<string, string> }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** 解析一层配置中的服务器表；结构不符合时返回错误，不静默丢弃。 */
export function mcpServersOfLayer(parsed: Record<string, unknown>): Record<string, unknown> {
  const mcp = parsed.mcp;
  if (mcp === undefined) return {};
  if (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp)) {
    throw new KernelError('config_edit_shape_unsupported', { detail: '[mcp] is not a table' });
  }
  const servers = (mcp as Record<string, unknown>).servers;
  if (servers === undefined) return {};
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new KernelError('config_edit_shape_unsupported', { detail: 'mcp.servers is not a table' });
  }
  return { ...(servers as Record<string, unknown>) };
}

/** 根据本次修改计算预期的回读结果。 */
export function expectedMcpServers(current: Record<string, unknown>, op: McpOp, server?: McpServerRef): Record<string, unknown> {
  const next = { ...current };
  if (op === 'remove') {
    delete next[server === undefined ? '' : server.name];
    return next;
  }
  const wanted = server as McpServerWrite;
  next[wanted.name] = {
    command: wanted.command,
    ...(wanted.args === undefined ? {} : { args: [...wanted.args] }),
    ...(wanted.env === undefined ? {} : { env: { ...wanted.env } }),
    ...(wanted.cwd === undefined ? {} : { cwd: wanted.cwd }),
  };
  return next;
}

function mcpServerBlock(server: McpServerWrite, eol: string): string {
  const rows = [`[mcp.servers.${JSON.stringify(server.name)}]`, `command = ${JSON.stringify(server.command)}`];
  if (server.args !== undefined) rows.push(`args = [${server.args.map((item) => JSON.stringify(item)).join(', ')}]`);
  if (server.env !== undefined) {
    const entries = Object.entries(server.env);
    if (entries.length > 0) rows.push(`env = { ${entries.map(([name, ref]) => `${JSON.stringify(name)} = ${JSON.stringify(ref)}`).join(', ')} }`);
  }
  if (server.cwd !== undefined) rows.push(`cwd = ${JSON.stringify(server.cwd)}`);
  return `${rows.join(eol)}${eol}`;
}

/** 在原文中设置或删除一个服务器表，并保留其他服务器的字节和注释。 */
export function editMcpServerTable(text: string, op: McpOp, server: McpServerRef): { text: string; created: boolean } {
  const document = parseDocument(text);
  if (document.pairs.some((pair) => sameTomlPath(pair.path, [...MCP_TABLE_PATH]))) {
    throw new KernelError('config_edit_shape_unsupported', { detail: 'mcp.servers must use one table per server for server editing' });
  }
  // 手写配置可能把 env 等字段拆成子表；替换与删除都要覆盖主表及其全部子表。
  const own = document.tables.filter((table) =>
    table.kind === 'standard' && startsWithTomlPath(table.resolvedKey, [...MCP_TABLE_PATH, server.name]),
  );
  if (op === 'remove') {
    if (own.length === 0) {
      throw new KernelError('config_mcp_unknown', { detail: `${server.name} is not configured in that file` });
    }
    const edits = own.map((table) => ruleTableEdit(text, document, table));
    return { text: applyTextEdits(text, edits), created: false };
  }
  const wanted = server as McpServerWrite;
  if (own.length > 0) {
    // 整表替换：删除旧表（含前导注释）后在原位置插入新表。
    const edits = own.map((table) => ruleTableEdit(text, document, table));
    const removed = applyTextEdits(text, edits);
    const at = Math.min(...edits.map((edit) => edit.start));
    const eol = lineEndingAt(text, Math.min(Math.max(0, at - 1), Math.max(0, text.length - 1)));
    return { text: applyTextEdits(removed, [{ start: at, end: at, text: mcpServerBlock(wanted, eol) }]), created: false };
  }
  // 新服务器追加在最后一个 mcp 表之后；没有 mcp 表时追加到文件末尾。
  const mcpTables = document.tables.filter((table) => startsWithTomlPath(table.resolvedKey, ['mcp']));
  const last = mcpTables.at(-1);
  if (last === undefined) {
    const eol = lineEndingAt(text, text.length);
    const prefix = text === ''
      ? ''
      : text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`;
    return { text: `${text}${prefix}${mcpServerBlock(wanted, eol)}`, created: true };
  }
  const descendants = document.tables.filter((table) => startsWithTomlPath(table.resolvedKey, last.resolvedKey) && table !== last);
  const tail = descendants.at(-1) ?? last;
  const next = document.tables.find((table) =>
    table.range[0] >= tail.range[1] && !startsWithTomlPath(table.resolvedKey, last.resolvedKey),
  );
  const at = next === undefined
    ? trailingCommentStart(text, document.root) ?? text.length
    : leadingCommentStart(text, document.root, next);
  const eol = lineEndingAt(text, Math.max(0, at - 1));
  const prefix = at === text.length && !text.slice(0, at).endsWith('\n') ? eol : '';
  return {
    text: applyTextEdits(text, [{ start: at, end: at, text: `${prefix}${mcpServerBlock(wanted, eol)}` }]),
    created: true,
  };
}
