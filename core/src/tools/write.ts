// 写操作包括 `create`、`write`、`edit` 和 `delete`。
// 每种操作在工具内部执行语义校验并返回稳定错误码；删除只使用操作系统回收站。
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { ToolContext, ToolDefinition } from '../kernel/kernel.js';
import { assertNoLegacyTrashConfig, boundaryOf, workingDirectoryOf } from '../capability/limits.js';
import { resolveWithin } from '../capability/paths.js';
import { resolveRecycler } from '../capability/recycle.js';
import { versionOf } from '../kernel/observe.js';
import { errorCode, errorMessage, toPosix } from './common.js';

interface CreateArguments { path: string; content: string }
interface WriteArguments { path: string; content: string }
interface EditChange { oldText: string; newText: string }
interface EditArguments { path: string; anchor?: string; replacement?: string; changes?: EditChange[] }
interface DeleteArguments { path: string }
const DELETE_TARGET_SNAPSHOT = Symbol('delete-target-snapshot');
const TEST_FILE_WRITER = Symbol('test-file-writer');
const MAX_EDIT_CHANGES = 32;
const MAX_EDIT_CHANGE_BYTES = 64 * 1024;
const MAX_EDIT_DIFF_CHARACTERS = 8 * 1024;
interface DeleteTargetSnapshot {
  readonly [DELETE_TARGET_SNAPSHOT]: true;
  readonly target: string;
  readonly boundary: string;
  readonly workingDirectory: string;
  readonly name: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
type WriteToolContext = Pick<ToolContext, 'config' | 'observations' | 'signal' | 'preflightResult'> & {
  readonly [TEST_FILE_WRITER]?: FileWriter;
};
type FileWriter = (target: string, content: string, exclusive: boolean) => Promise<void>;

interface MatchedEdit extends EditChange {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 13) {
      line += 1;
      if (text.charCodeAt(index + 1) === 10) index += 1;
    } else if (character === 10) {
      line += 1;
    }
  }
  return line;
}

function matchEdits(text: string, changes: EditChange[], path: string): MatchedEdit[] {
  if (changes.length === 0) throw new KernelError('edit_changes_empty', { detail: 'provide at least one exact change' });
  if (changes.length > MAX_EDIT_CHANGES) {
    throw new KernelError('edit_changes_too_many', { detail: `a single edit call can contain at most ${MAX_EDIT_CHANGES} changes` });
  }
  let inputBytes = 0;
  const matched = changes.map((change, index): MatchedEdit => {
    if (change === null || typeof change !== 'object'
      || typeof change.oldText !== 'string' || typeof change.newText !== 'string'
      || Object.keys(change).some((key) => key !== 'oldText' && key !== 'newText')) {
      throw new KernelError('tool_args_invalid', { detail: `change ${index + 1} must contain only string oldText and newText fields` });
    }
    if (change.oldText === '') {
      throw new KernelError('edit_change_old_text_empty', { detail: `change ${index + 1} must locate nonempty original text` });
    }
    if (change.oldText === change.newText) {
      throw new KernelError('edit_changes_noop', { detail: `change ${index + 1} replaces text with itself` });
    }
    inputBytes += Buffer.byteLength(change.oldText, 'utf8') + Buffer.byteLength(change.newText, 'utf8');
    if (inputBytes > MAX_EDIT_CHANGE_BYTES) {
      throw new KernelError('edit_changes_too_large', { detail: `combined oldText and newText must not exceed ${MAX_EDIT_CHANGE_BYTES} UTF-8 bytes` });
    }
    const start = text.indexOf(change.oldText);
    if (start === -1) {
      throw new KernelError('edit_change_not_found', { detail: `change ${index + 1} original text does not appear in ${path}` });
    }
    if (text.indexOf(change.oldText, start + 1) !== -1) {
      throw new KernelError('edit_change_ambiguous', { detail: `change ${index + 1} original text appears more than once in ${path}` });
    }
    return { ...change, index, start, end: start + change.oldText.length, line: lineAt(text, start) };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < matched.length; index += 1) {
    if (matched[index]!.start < matched[index - 1]!.end) {
      throw new KernelError('edit_changes_overlap', { detail: `changes ${matched[index - 1]!.index + 1} and ${matched[index]!.index + 1} select overlapping original text` });
    }
  }
  return matched;
}

function applyEdits(text: string, matched: MatchedEdit[]): string {
  let cursor = 0;
  const output: string[] = [];
  for (const change of matched) {
    output.push(text.slice(cursor, change.start), change.newText);
    cursor = change.end;
  }
  output.push(text.slice(cursor));
  return output.join('');
}

function editDiff(matched: MatchedEdit[]): { text: string; truncated: boolean } {
  const sections = matched.map((change) => {
    const removed = change.oldText.split(/\r\n|\n|\r/u).map((line) => `- ${line}`);
    const added = change.newText === ''
      ? ['+ (empty)']
      : change.newText.split(/\r\n|\n|\r/u).map((line) => `+ ${line}`);
    return [`@@ edit ${change.index + 1} at line ${change.line} @@`, ...removed, ...added].join('\n');
  }).join('\n');
  if (sections.length <= MAX_EDIT_DIFF_CHARACTERS) return { text: sections, truncated: false };
  const suffix = `\n… diff truncated at ${MAX_EDIT_DIFF_CHARACTERS} characters`;
  return { text: `${sections.slice(0, MAX_EDIT_DIFF_CHARACTERS - suffix.length)}${suffix}`, truncated: true };
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r\n|\n|\r/u).length;
  return /(?:\r\n|\n|\r)$/u.test(text) ? lines - 1 : lines;
}

type WriteOutcome = 'written' | 'unchanged' | 'unknown';

async function outcomeAfterWriteError(target: string, before: Buffer | undefined, expected: Buffer): Promise<WriteOutcome> {
  let after: Buffer;
  try { after = await readFile(target); }
  catch (error) {
    if (before === undefined && errorCode(error) === 'ENOENT') return 'unchanged';
    return 'unknown';
  }
  if (after.equals(expected)) return 'written';
  if (before !== undefined && after.equals(before)) return 'unchanged';
  return 'unknown';
}

function writeFailure(operation: 'create' | 'write' | 'edit', path: string, cause: unknown, outcome: Exclude<WriteOutcome, 'written'>): KernelError {
  if (outcome === 'unchanged') {
    return new KernelError(`${operation}_failed_unchanged`, {
      cause,
      detail: `${path} is confirmed unchanged after the file operation failed; correct the I/O problem before retrying`,
    });
  }
  return new KernelError(`${operation}_outcome_unknown`, {
    cause,
    detail: `${path} may have changed partially after the file operation failed; read it again before retrying`,
  });
}

async function persistTextFile(
  target: string,
  content: string,
  context: { readonly [TEST_FILE_WRITER]?: FileWriter },
  exclusive = false,
): Promise<void> {
  if (context[TEST_FILE_WRITER] !== undefined) return context[TEST_FILE_WRITER]!(target, content, exclusive);
  if (exclusive) return writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
  return writeFile(target, content, 'utf8');
}

/** Fault-injection adapter for file-write outcome tests; not exposed by the public barrel. */
export function withTestFileWriter<TTool>(tool: TTool, writer: FileWriter): TTool {
  if (typeof tool !== 'object' || tool === null || !('run' in tool) || typeof tool.run !== 'function') {
    throw new TypeError('withTestFileWriter requires a tool definition');
  }
  const definition = tool as unknown as ToolDefinition<unknown>;
  if (!['create', 'write', 'edit'].includes(definition.name)) throw new TypeError('withTestFileWriter requires a built-in file write tool');
  return {
    ...definition,
    run(args: unknown, context: ToolContext) {
      return definition.run(args, { ...context, [TEST_FILE_WRITER]: writer } as ToolContext);
    },
  } as unknown as TTool;
}

async function deleteTargetSnapshot(args: DeleteArguments, config: ToolContext['config']): Promise<DeleteTargetSnapshot> {
  assertNoLegacyTrashConfig(config);
  const boundary = boundaryOf(config);
  const workingDirectory = workingDirectoryOf(config);
  const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectory });
  const name = toPosix(relative(boundary, target));
  if (name === '') throw new KernelError('delete_target_is_boundary', { detail: 'the workspace boundary itself cannot be sent to the recycle bin; name a file or directory inside it' });
  let named;
  let original;
  try {
    named = await lstat(resolve(workingDirectory, args.path));
    original = await lstat(target);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new KernelError('delete_target_missing', { detail: `there is nothing at ${args.path} to send to the recycle bin` });
    throw new KernelError('path_resolve_failed', { cause: error, detail: `checking ${args.path} failed: ${code ?? errorMessage(error)}` });
  }
  if (named.isSymbolicLink() || original.isSymbolicLink()) {
    throw new KernelError('delete_target_is_link', { detail: `${args.path} is a symbolic link or junction; name the actual target explicitly if that is what should be sent to the recycle bin` });
  }
  if (!original.isFile() && !original.isDirectory()) {
    throw new KernelError('delete_target_unsupported', { detail: `${args.path} is not a regular file or directory` });
  }
  return {
    [DELETE_TARGET_SNAPSHOT]: true,
    target,
    boundary,
    workingDirectory,
    name,
    dev: original.dev,
    ino: original.ino,
    mode: original.mode,
    nlink: original.nlink,
    size: original.size,
    mtimeMs: original.mtimeMs,
    ctimeMs: original.ctimeMs,
  };
}

async function recheckDeleteTarget(args: DeleteArguments, config: ToolContext['config'], snapshot: DeleteTargetSnapshot): Promise<void> {
  if (boundaryOf(config) !== snapshot.boundary || workingDirectoryOf(config) !== snapshot.workingDirectory) {
    throw new KernelError('delete_target_changed', { detail: `${args.path} changed while approval was pending` });
  }
  const currentPath = await resolveWithin(snapshot.boundary, args.path, { forWrite: true, cwd: snapshot.workingDirectory });
  if (currentPath !== snapshot.target) throw new KernelError('delete_target_changed', { detail: `${args.path} changed while approval was pending` });
  let named;
  let current;
  try {
    named = await lstat(resolve(snapshot.workingDirectory, args.path));
    current = await lstat(snapshot.target);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new KernelError('delete_target_changed', { detail: `${args.path} changed while approval was pending` });
    throw new KernelError('path_resolve_failed', { cause: error, detail: `rechecking ${args.path} failed: ${code ?? errorMessage(error)}` });
  }
  if (named.isSymbolicLink() || current.isSymbolicLink() || current.dev !== snapshot.dev || current.ino !== snapshot.ino
    || current.mode !== snapshot.mode || current.nlink !== snapshot.nlink || current.size !== snapshot.size
    || current.mtimeMs !== snapshot.mtimeMs || current.ctimeMs !== snapshot.ctimeMs) {
    throw new KernelError('delete_target_changed', { detail: `${args.path} changed while approval was pending` });
  }
}

export const createTool = {
  name: 'create',
  access: 'write',
  description: 'Create a new text file relative to the working directory, within the workspace boundary. Fails when the file already exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
      content: { type: 'string', description: 'The whole file content.' },
    },
    required: ['path', 'content'],
  },
  async run(args: CreateArguments, { config, observations, ...context }: WriteToolContext) {
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
    await mkdir(dirname(target), { recursive: true });
    try {
      await persistTextFile(target, args.content, context, true);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new KernelError('create_target_exists', { detail: `${args.path} already exists; use write to replace its whole content or edit to change one part of it` });
      }
      const expected = Buffer.from(args.content, 'utf8');
      const outcome = await outcomeAfterWriteError(target, undefined, expected);
      if (outcome !== 'written') throw writeFailure('create', args.path, error, outcome);
    }
    observations?.observe(target, versionOf(Buffer.from(args.content, 'utf8')));
    return { text: `created ${toPosix(relative(boundary, target))} (${Buffer.byteLength(args.content, 'utf8')} bytes)` };
  },
} satisfies ToolDefinition<CreateArguments>;

export const writeTool = {
  name: 'write',
  access: 'write',
  description: 'Replace the whole content of an existing text file relative to the working directory, within the workspace boundary. The file must have been read in this run and must still match that version when validated; the final version check and write are not atomic against external writers. Use create for a file that does not exist yet.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
      content: { type: 'string', description: 'The whole new file content.' },
    },
    required: ['path', 'content'],
  },
  // `write` 仅修改已存在文件；新建由 `create` 处理。
  // 覆盖前必须匹配此前完整读取时记录的版本，拒绝使用过时内容覆盖文件。
  // 版本检查与写入不是底层原子操作，不能防止并发写入之间的竞态。
  async run(args: WriteArguments, { config, observations, ...context }: WriteToolContext) {
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
    let before;
    try {
      before = await readFile(target);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') throw new KernelError('write_target_missing', { detail: `${args.path} does not exist; create is the tool for a file that is not there yet` });
      throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${args.path} failed: ${code ?? errorMessage(error)}` });
    }
    const observed = observations?.versionAt(target);
    if (observed === undefined) {
      throw new KernelError('write_not_observed', { detail: `${args.path} has not been read in this run; read it in full first, then write` });
    }
    if (observed !== versionOf(before)) {
      throw new KernelError('write_version_stale', { detail: `${args.path} changed since it was read; read it again before replacing its content` });
    }
    const expected = Buffer.from(args.content, 'utf8');
    try { await persistTextFile(target, args.content, context); }
    catch (error) {
      const outcome = await outcomeAfterWriteError(target, before, expected);
      if (outcome !== 'written') throw writeFailure('write', args.path, error, outcome);
    }
    observations?.observe(target, versionOf(expected));
    return { text: `wrote ${toPosix(relative(boundary, target))} (${Buffer.byteLength(args.content, 'utf8')} bytes)` };
  },
} satisfies ToolDefinition<WriteArguments>;

export const editTool = {
  name: 'edit',
  access: 'write',
  description: 'Replace either one unique anchor or several exact, unique, non-overlapping text ranges in an existing file relative to the working directory, within the workspace boundary. Multi-change calls do not require a prior read; the file is read at call time. The match check and write are separate filesystem operations, so this is not an atomic compare-and-swap against external writers.',
  parameters: {
    type: 'object',
    description: 'Provide exactly one edit form: a legacy anchor/replacement pair or an array of exact text changes.',
    anyOf: [
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
          anchor: { type: 'string', description: 'Text to locate; it must appear exactly once in the file.' },
          replacement: { type: 'string', description: 'Text to put in place of the anchor.' },
        },
        required: ['path', 'anchor', 'replacement'],
      },
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
          changes: {
            type: 'array',
            maxItems: MAX_EDIT_CHANGES,
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', maxLength: MAX_EDIT_CHANGE_BYTES },
                newText: { type: 'string', maxLength: MAX_EDIT_CHANGE_BYTES },
              },
              required: ['oldText', 'newText'],
              additionalProperties: false,
            },
            description: `Up to ${MAX_EDIT_CHANGES} exact changes; combined UTF-8 oldText and newText size is limited to ${MAX_EDIT_CHANGE_BYTES} bytes. Each oldText must occur once, and selected ranges must not overlap.`,
          },
        },
        required: ['path', 'changes'],
        additionalProperties: false,
      },
    ],
  },
  preflight(args: EditArguments) {
    const hasLegacyArguments = Object.hasOwn(args, 'anchor') || Object.hasOwn(args, 'replacement');
    if (hasLegacyArguments && Object.hasOwn(args, 'changes')) {
      throw new KernelError('edit_arguments_conflict', { detail: 'provide either anchor and replacement or changes, but not both' });
    }
  },
  async run(args: EditArguments, { config, observations, ...context }: WriteToolContext) {
    const boundary = boundaryOf(config);
    const hasLegacyArguments = Object.hasOwn(args, 'anchor') || Object.hasOwn(args, 'replacement');
    const hasChanges = Object.hasOwn(args, 'changes');
    if (hasLegacyArguments && hasChanges) {
      throw new KernelError('edit_arguments_conflict', { detail: 'provide either anchor and replacement or changes, but not both' });
    }
    if (!hasLegacyArguments && !hasChanges) {
      throw new KernelError('tool_args_invalid', { detail: 'provide either anchor and replacement or changes' });
    }
    if (hasLegacyArguments && (typeof args.anchor !== 'string' || typeof args.replacement !== 'string')) {
      throw new KernelError('tool_args_invalid', { detail: 'the legacy edit form requires both anchor and replacement strings' });
    }
    if (hasChanges && !Array.isArray(args.changes)) {
      throw new KernelError('tool_args_invalid', { detail: 'changes must be an array' });
    }
    if (hasChanges && Object.keys(args).some((key) => key !== 'path' && key !== 'changes')) {
      throw new KernelError('tool_args_invalid', { detail: 'multi-edit accepts only path and changes' });
    }
    if (hasLegacyArguments && args.anchor!.trim() === '') {
      throw new KernelError('edit_anchor_empty', { detail: 'an anchor of only whitespace would match anywhere; give the text to locate' });
    }
    const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
    let text: string;
    let before: Buffer;
    try {
      before = await readFile(target);
      text = before.toString('utf8');
    } catch (error) {
      // 目标不存在时应使用 `create`。
      const code = errorCode(error);
      if (code === 'ENOENT') throw new KernelError('edit_target_missing', { detail: `${args.path} does not exist; create is the tool for a file that is not there yet` });
      throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${args.path} failed: ${code ?? errorMessage(error)}` });
    }
    if (hasLegacyArguments) {
      const hits = text.split(args.anchor!).length - 1;
      if (hits === 0) throw new KernelError('edit_anchor_not_found', { detail: `the anchor does not appear in ${args.path}` });
      // 定位字符串必须唯一匹配，避免模型在多个位置中任意选择修改目标。
      if (hits > 1) {
        throw new KernelError('edit_anchor_ambiguous', { detail: `the anchor appears ${hits} times in ${args.path}; widen it until one occurrence is left` });
      }
      const updated = text.replace(args.anchor!, () => args.replacement!);
      const expected = Buffer.from(updated, 'utf8');
      try { await persistTextFile(target, updated, context); }
      catch (error) {
        const outcome = await outcomeAfterWriteError(target, before, expected);
        if (outcome !== 'written') throw writeFailure('edit', args.path, error, outcome);
      }
      observations?.observe(target, versionOf(expected));
      return { text: `edited ${toPosix(relative(boundary, target))}` };
    }

    const matched = matchEdits(text, args.changes!, args.path);
    const updated = applyEdits(text, matched);
    const diff = editDiff(matched);
    const removed = matched.reduce((total, change) => total + lineCount(change.oldText), 0);
    const added = matched.reduce((total, change) => total + lineCount(change.newText), 0);
    const result = {
      text: `edited ${toPosix(relative(boundary, target))} (${matched.length} changes; first changed line ${matched[0]!.line}; ${removed} removed/${added} added lines)\nDiff${diff.truncated ? ' (truncated)' : ''}:\n${diff.text}`,
    };
    const expected = Buffer.from(updated, 'utf8');
    try { await persistTextFile(target, updated, context); }
    catch (error) {
      const outcome = await outcomeAfterWriteError(target, before, expected);
      if (outcome !== 'written') throw writeFailure('edit', args.path, error, outcome);
    }
    observations?.observe(target, versionOf(expected));
    return result;
  },
} satisfies ToolDefinition<EditArguments>;

export const deleteTool = {
  name: 'delete',
  access: 'write',
  description: 'Move a file or directory relative to the working directory, within the workspace boundary, into the operating system recycle bin. If the backend is unavailable, the tool returns an error and leaves the source in place. After a backend error, it compares the target object identity and top-level metadata at the original path; it does not verify file contents or recursively inspect directory contents. If it cannot confirm a match, it returns delete_outcome_unknown. Final symbolic links and junctions are refused; name the actual target explicitly to delete it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory, within the workspace boundary.' },
    },
    required: ['path'],
  },
  async preflight(args: DeleteArguments, { config }: ToolContext): Promise<DeleteTargetSnapshot> {
    return deleteTargetSnapshot(args, config);
  },
  async run(args: DeleteArguments, { config, observations, signal, preflightResult }: WriteToolContext) {
    const snapshot = isDeleteTargetSnapshot(preflightResult) ? preflightResult : await deleteTargetSnapshot(args, config);
    signal?.throwIfAborted();
    const resolution = await resolveRecycler();
    if (resolution.recycler === undefined) {
      throw new KernelError('recycle_backend_missing', {
        detail: `the operating system recycle bin is unavailable (${resolution.code}); ${args.path} remains unchanged`,
      });
    }
    await recheckDeleteTarget(args, config, snapshot);
    try {
      await resolution.recycler.send(snapshot.target);
    } catch (error) {
      try {
        await recheckDeleteTarget(args, config, snapshot);
      } catch (verificationError) {
        throw new KernelError('delete_outcome_unknown', {
          cause: error,
          detail: `${args.path} could not be verified unchanged after the system recycle bin reported an error (${errorCode(verificationError) ?? errorMessage(verificationError)}); check both the workspace and system trash before retrying`,
        });
      }
      throw error;
    }
    observations?.forget(snapshot.target);
    return { text: `sent ${snapshot.name} to the ${resolution.recycler.name}` };
  },
} satisfies ToolDefinition<DeleteArguments>;

function isDeleteTargetSnapshot(value: unknown): value is DeleteTargetSnapshot {
  return typeof value === 'object' && value !== null && DELETE_TARGET_SNAPSHOT in value
    && value[DELETE_TARGET_SNAPSHOT] === true;
}

export const writeTools = Object.freeze([createTool, writeTool, editTool, deleteTool]);
