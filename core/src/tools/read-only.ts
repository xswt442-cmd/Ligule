// 只读工具包括 `read`、`find` 和 `search`。
// 返回内容受字节数和条目数限制；超出限制时在结果中说明。
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { ToolContext, ToolDefinition } from '../kernel/kernel.js';
import { matchesName } from '../kernel/match.js';
import { boundaryOf, limitsOf, skippedDirectories, workingDirectoryOf } from '../capability/limits.js';
import { resolveWithin } from '../capability/paths.js';
import { resolveRipgrep, searchWithRipgrep } from '../capability/ripgrep.js';
import { versionOf } from '../kernel/observe.js';
import { kindOfTarget, marker, readExisting, toPosix, walkFiles } from './common.js';

interface ReadArguments { path: string; offsetBytes?: number }
interface FindArguments { pattern: string; path?: string }
interface SearchArguments { pattern: string; path?: string }
type FileToolContext = Pick<ToolContext, 'config' | 'observations' | 'signal' | 'logger'>;

export const readTool = {
  name: 'read',
  access: 'read',
  readOnly: true,
  description: 'Read a text file relative to the working directory, within the workspace boundary, up to a byte limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
      offsetBytes: { type: 'integer', minimum: 0, description: 'Byte offset to continue from after a truncation.' },
    },
    required: ['path'],
  },
  async run(args: ReadArguments, { config, observations }: FileToolContext) {
    const { readBytes } = limitsOf(config);
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { cwd: workingDirectoryOf(config) });
    const bytes = await readExisting(target);
    const offset = args.offsetBytes ?? 0;
    const slice = bytes.subarray(offset, offset + readBytes);
    const left = bytes.length - offset - slice.length;
    // 只有完整读取文件后才记录观察版本；截断读取不能作为覆盖文件的依据。
    if (offset === 0 && left <= 0) observations?.observe(target, versionOf(bytes));
    const text = slice.toString('utf8')
      + (left > 0 ? marker(`truncated: ${slice.length} of ${bytes.length - offset} bytes shown, continue with offsetBytes=${offset + slice.length}`) : '');
    return { text };
  },
} satisfies ToolDefinition<ReadArguments>;

export const findTool = {
  name: 'find',
  access: 'read',
  readOnly: true,
  description: 'Find files by name pattern from the working directory, within the workspace boundary.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Name pattern: * and ? stop at a path separator, ** crosses it, and **/ may match no directory at all.' },
      path: { type: 'string', description: 'Subdirectory to search from, relative to the working directory.' },
    },
    required: ['pattern'],
  },
  async run(args: FindArguments, { config, signal }: FileToolContext) {
    // 开始搜索前和读取每个文件前都检查取消信号，两个检查点返回相同错误码。
    if (signal?.aborted) throw new KernelError('find_cancelled', { detail: 'the file listing was cancelled before it finished' });
    const { resultCount } = limitsOf(config);
    const boundary = boundaryOf(config);
    const cwd = workingDirectoryOf(config);
    const root = await resolveWithin(boundary, args.path ?? '.', { cwd });
    // 遍历起点必须是目录。先检查类型并返回稳定错误，避免 `walkFiles` 抛出原始 ENOTDIR。
    if (await kindOfTarget(root) !== 'directory') {
      throw new KernelError('find_path_not_directory', { detail: `find starts from a directory, but ${args.path} is a file` });
    }
    const names: string[] = [];
    for await (const name of walkFiles(root, skippedDirectories(config))) {
      if (signal?.aborted) throw new KernelError('find_cancelled', { detail: 'the file listing was cancelled before it finished' });
      if (!matchesName(name, args.pattern)) continue;
      if (names.length === resultCount) {
        return { text: `${names.join('\n')}${marker(`truncated: ${resultCount} matches shown and more follow, narrow the pattern`)}` };
      }
      names.push(name);
    }
    return { text: names.join('\n') + (names.length === 0 ? '(no matches)' : '') };
  },
} satisfies ToolDefinition<FindArguments>;

// 搜索优先使用 ripgrep，可使用随包版本或配置指定的可执行文件；不可用时由 Node 遍历文件。
// Node 回退实现逐行匹配，并受扫描文件数和扫描字节数限制；ripgrep 使用结果数上限。
export const searchTool = {
  name: 'search',
  access: 'read',
  readOnly: true,
  description: 'Search file contents from the working directory, within the workspace boundary.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Literal text to look for, matched case sensitively per line.' },
      path: { type: 'string', description: 'File or subdirectory to search, relative to the working directory.' },
    },
    required: ['pattern'],
  },
  async run(args: SearchArguments, { config, logger, signal }: FileToolContext) {
    // 将同一取消信号传给 ripgrep 子进程；Node 遍历则在读取每个文件前检查。
    if (signal?.aborted) throw new KernelError('search_cancelled', { detail: 'the content search was cancelled before it finished' });
    const { resultCount, scanBytes, scanFiles } = limitsOf(config);
    const boundary = boundaryOf(config);
    const cwd = workingDirectoryOf(config);

    // ripgrep 可用时优先使用；不可用时改由 Node 遍历，并在日志中记录回退原因。
    const configuredRipgrepPath = config.ripgrepPath;
    if (configuredRipgrepPath !== undefined && typeof configuredRipgrepPath !== 'string') {
      throw new KernelError('search_backend_failed', { detail: 'ripgrepPath must be a string' });
    }
    const backend = await resolveRipgrep({ path: configuredRipgrepPath });
    if ('executable' in backend) {
      // 先检查目标路径，确保 ripgrep 和 Node 回退实现都返回一致的路径错误。
      const root = await resolveWithin(boundary, args.path ?? '.', { cwd });
      if (args.path !== undefined) await kindOfTarget(root);
      const found = await searchWithRipgrep({
        executable: backend.executable,
        boundary: cwd,
        target: toPosix(relative(cwd, root)) || '.',
        pattern: args.pattern,
        limit: resultCount,
        excludes: skippedDirectories(config),
        signal,
      });
      return {
        text: (found.hits.length === 0 ? '(no matches)' : found.hits.join('\n'))
          + (found.truncated ? marker(`truncated: ${resultCount} matches shown and more follow, narrow the pattern`) : ''),
      };
    }
    logger.debug('ripgrep is not available, walking the tree instead', { tool: 'search', code: backend.code, detail: backend.detail });

    const hits: string[] = [];
    let scannedBytes = 0;
    let scannedFiles = 0;
    let binaries = 0;
    let stopped = '';

    // 返回 false 表示已达到结果数或扫描预算上限，应停止本次搜索。
    async function scan(target: string): Promise<boolean> {
      const file = toPosix(relative(cwd, target));
      const bytes = await readFile(target);
      // 含零字节的文件视为二进制文件并跳过，与 ripgrep 的行为保持一致。
      if (bytes.includes(0)) {
        binaries += 1;
        return true;
      }
      // 扫描预算按累计字节计算。达到上限后停止读取，避免继续把不会处理的文件载入内存。
      if (scannedBytes + bytes.length > scanBytes) {
        stopped = `incomplete: ${scanBytes} bytes scanned, the rest of the tree was not read`;
        return false;
      }
      scannedBytes += bytes.length;
      // 移除 CRLF 中的回车符，与外部搜索后端返回的行内容保持一致。
      const lines = bytes.toString('utf8').split('\n').map((line) => line.replace(/\r$/, ''));
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(args.pattern)) continue;
        if (hits.length === resultCount) {
          stopped = `truncated: ${resultCount} matches shown and more follow, narrow the pattern`;
          return false;
        }
        hits.push(`${file}:${index + 1}:${lines[index]}`);
      }
      return true;
    }

    // `path` 可以指定文件或目录；先区分目标类型，避免把目录作为文件读取并产生原始 EISDIR。
    async function* candidates(): AsyncGenerator<string> {
      const skipped = skippedDirectories(config);
      if (args.path === undefined) {
        const root = await resolveWithin(boundary, '.', { cwd });
        for await (const file of walkFiles(root, skipped)) yield join(root, file);
        return;
      }
      const root = await resolveWithin(boundary, args.path, { cwd });
      if (await kindOfTarget(root) === 'file') {
        // 显式指定文件时只搜索该文件，不应用目录遍历时的排除项，与 ripgrep 行为保持一致。
        yield root;
        return;
      }
      // 指定目录位于排除目录内时不搜索，与 ripgrep 按相对路径应用排除项的行为一致。
      // 如需读取被排除目录中的文件，请使用 `read`。
      if (toPosix(relative(boundary, root)).split('/').some((part) => skipped.includes(part))) return;
      for await (const file of walkFiles(root, skipped)) yield join(root, file);
    }

    for await (const target of candidates()) {
      if (signal?.aborted) throw new KernelError('search_cancelled', { detail: 'the content search was cancelled before it finished' });
      scannedFiles += 1;
      if (scannedFiles > scanFiles) {
        // 尚未遍历的文件数量未知，因此只标记扫描未完成，不猜测剩余数量。
        stopped = `incomplete: ${scanFiles} file(s) scanned, the rest of the tree was not read`;
        break;
      }
      if (!(await scan(target))) break;
    }

    // 分别说明是否达到结果上限、扫描预算上限，以及跳过的二进制文件数量。
    const notes = stopped === '' ? [] : [stopped];
    if (binaries > 0) notes.push(`${binaries} binary file(s) skipped`);
    return { text: (hits.length === 0 ? '(no matches)' : hits.join('\n')) + (notes.length === 0 ? '' : marker(notes.join('; '))) };
  },
} satisfies ToolDefinition<SearchArguments>;

export const readOnlyTools = Object.freeze([readTool, findTool, searchTool]);
