// 将工具路径解析为边界内的绝对路径，拒绝上级路径和符号链接导致的越界。
// 写入现存普通文件时拒绝多重硬链接，避免修改同一内容的其他路径。
// 此模块只判定边界；实际文件和进程约束由能力后端执行。
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { KernelError } from '../errors.js';

type ResolveWithinOptions = { forWrite?: boolean; cwd?: string };

const UP = `..${sep}`;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function errorMessage(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
}

// 词法上的包含判断。用 `..` 加分隔符而不是 `..` 开头，否则边界内一个叫 `..backup` 的目录会被误拒。
export function isWithin(boundary: string, target: string): boolean {
  const relativePath = relative(boundary, target);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(UP) && !isAbsolute(relativePath));
}

// 目标还不存在时（写一个新文件），解析最近一层存在的祖先再拼回去：
// 只判词法的话，一个指向边界之外的符号链接父目录会让写入落在边界之外。
async function resolveReal(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (error) {
    // POSIX 对「穿过一个普通文件」的路径直接报 ENOTDIR，Windows 报 ENOENT：两种都要走进下面那段找祖先的循环，
    // 由那里给出同一个码（循环里两条都认）。在这里就把 ENOTDIR 当解析失败，同一个调用在两个平台会报不同的码。
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new KernelError('path_resolve_failed', { cause: error, detail: `resolving ${absolute} failed: ${code ?? errorMessage(error)}` });
    }
    const missing = [];
    let ancestor = absolute;
    while (true) {
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
      if (ancestor === dirname(ancestor)) throw new KernelError('path_parent_missing', { detail: `cannot find an existing parent directory for ${absolute}` });
      try {
        const realAncestor = await realpath(ancestor);
        // Windows 上对一个普通文件取 realpath 会成功，POSIX 报 ENOTDIR；父段是文件时目标既不存在也建不出来。
        if (!(await stat(realAncestor)).isDirectory()) {
          throw new KernelError('path_parent_not_directory', { detail: `a parent directory of ${absolute} is a file, so nothing can be created under it` });
        }
        return resolve(realAncestor, ...missing);
      } catch (cause) {
        if (cause instanceof KernelError) throw cause;
        const causeCode = errorCode(cause);
        if (causeCode === 'ENOTDIR') {
          throw new KernelError('path_parent_not_directory', { cause, detail: `a parent directory of ${absolute} is a file, so nothing can be created under it` });
        }
        if (causeCode !== 'ENOENT') {
          throw new KernelError('path_resolve_failed', { cause, detail: `resolving ${absolute} failed: ${causeCode ?? errorMessage(cause)}` });
        }
      }
    }
  }
}

// 边界本身不存在是配置错了，报它自己的码：交给上层的话只剩一个看不出来源的 ENOENT。
async function realBoundaryOf(boundary: string): Promise<string> {
  try {
    return await realpath(boundary);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      throw new KernelError('boundary_missing', { detail: `the workspace boundary ${boundary} does not exist` });
    }
    throw new KernelError('path_resolve_failed', { cause: error, detail: `resolving the workspace boundary ${boundary} failed: ${code ?? errorMessage(error)}` });
  }
}

// options.forWrite 为真时，一个有多余链接计数的现有文件也被拒绝：写穿它等于写到边界之外那个同名文件上。
export async function resolveWithin(
  boundary: string,
  path: string,
  { forWrite = false, cwd = boundary }: ResolveWithinOptions = {},
): Promise<string> {
  if (typeof boundary !== 'string' || boundary === '') throw new KernelError('boundary_required', { detail: 'no workspace boundary is configured, so no path can be resolved' });
  if (typeof path !== 'string' || path.trim() === '') throw new KernelError('path_required', { detail: 'a non-empty path is required' });
  if (typeof cwd !== 'string' || cwd === '') throw new KernelError('path_cwd_required', { detail: 'a working directory is required to resolve a relative path' });
  const absoluteCwd = resolve(cwd);
  const realBoundary = await realBoundaryOf(boundary);
  const absolute = resolve(absoluteCwd, path);
  if (!isWithin(boundary, absolute)) throw new KernelError('path_escapes_boundary', { detail: `${path} resolves to ${absolute}, outside the workspace boundary ${boundary}` });

  const real = await resolveReal(absolute);
  if (!isWithin(realBoundary, real)) {
    throw new KernelError('path_escapes_through_link', { detail: `${path} leads to ${real} through a link, outside the workspace boundary ${realBoundary}` });
  }

  if (forWrite) {
    try {
      const info = await stat(real);
      // 链接计数只对普通文件有意义：目录的计数本来就大于 1。
      if (info.isFile() && info.nlink > 1) {
        throw new KernelError('path_hard_linked', { detail: `${path} has ${info.nlink} names pointing at the same content, so writing it changes something outside this request` });
      }
    } catch (error) {
      if (error instanceof KernelError) throw error;
      // 目标还不存在，没有链接计数可查；父段不是目录的情况在 resolveReal 里已经拒过。
      const code = errorCode(error);
      if (code !== 'ENOENT') {
        throw new KernelError('path_resolve_failed', { cause: error, detail: `checking ${real} failed: ${code ?? errorMessage(error)}` });
      }
    }
  }
  return real;
}
