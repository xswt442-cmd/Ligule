// 内容搜索使用随包 ripgrep 或配置指定的外部可执行文件。
// 通过运行 `--version` 检查程序是否可用，而不只检查文件是否存在。
// 探测失败时返回原因，由调用方记录并选择 Node 遍历实现。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { KernelError } from '../errors.js';

type RipgrepResolution =
  | { executable: string }
  | { code: string; detail?: string };
type ResolveRipgrepOptions = { path?: string; platform?: NodeJS.Platform; arch?: string };
type SearchOptions = {
  executable: string;
  boundary: string;
  target?: string;
  pattern: string;
  limit: number;
  excludes?: string[];
  signal?: AbortSignal;
};
type SearchResult = { hits: string[]; truncated: boolean };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

// 上游 wrapper 根据当前 Node 平台选择对应的可选二进制。
async function packaged(target: string): Promise<string | undefined> {
  if (target !== `${process.platform}-${process.arch}`) return undefined;
  try {
    return (await import('@vscode/ripgrep')).rgPath;
  } catch {
    return undefined;
  }
}

function probe(executable: string): Promise<RipgrepResolution> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, ['--version'], { windowsHide: true });
    } catch (error) {
      resolve({ code: 'search_backend_failed', detail: errorCode(error) });
      return;
    }
    child.on('error', (error) => resolve({ code: 'search_backend_failed', detail: errorCode(error) }));
    child.on('close', (code: number | null) => {
      resolve(code === 0 ? { executable } : { code: 'search_backend_failed', detail: `ripgrep exited with ${code}` });
    });
  });
}

// 每个进程对每个来源只探测一次，避免每次搜索都启动探测进程。
const probed = new Map<string, RipgrepResolution>();

export async function resolveRipgrep({ path, platform = process.platform, arch = process.arch }: ResolveRipgrepOptions = {}): Promise<RipgrepResolution> {
  const target = `${platform}-${arch}`;
  const key = path === undefined ? target : resolve(process.cwd(), path);
  const cached = probed.get(key);
  if (cached !== undefined) return cached;
  // 相对可执行文件路径以 Host 启动目录解析；搜索子进程的工作目录会设为文件访问边界。
  const candidate = path === undefined ? await packaged(target) : key;
  const result = candidate === undefined ? { code: 'search_backend_missing' } : await probe(candidate);
  probed.set(key, result);
  return result;
}

// 输出格式与 Node 遍历一致：相对边界的正斜杠路径、行号和匹配内容。
// 达到命中上限时终止子进程，避免将完整输出读入内存。
// Windows 输出路径使用反斜杠，目标为当前目录时还会带 `./` 前缀；只规范化路径部分，不修改匹配文本。
const LINE = /^(.+?):(\d+):([\s\S]*)$/;

function normalize(line: string): string {
  const match = LINE.exec(line);
  if (match === null) return line;
  const path = process.platform === 'win32' ? match[1].split('\\').join('/') : match[1];
  return `${path.replace(/^\.\//, '')}:${match[2]}:${match[3]}`;
}

export function searchWithRipgrep({
  executable,
  boundary,
  target = '.',
  pattern,
  limit,
  excludes = [],
  signal,
}: SearchOptions): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    // 已收到取消信号时不启动子进程，直接返回取消结果。
    if (signal?.aborted) {
      reject(new KernelError('search_cancelled', { detail: 'the content search was cancelled before it started' }));
      return;
    }
    // `--no-config` 禁用环境变量和程序旁的配置文件，防止通过 `--pre` 执行未经授权的程序。
    // 每个排除目录配置遍历排除规则和目标文件排除规则，以覆盖任意目录深度。
    // 按路径排序，确保相同输入获得稳定的结果顺序。
    const child = spawn(executable, [
      '--no-config', '--no-ignore', '--hidden', '--no-heading', '--with-filename', '--line-number',
      '--fixed-strings', '--sort', 'path',
      ...excludes.flatMap((name) => ['--glob', `!**/${name}`, '--glob', `!**/${name}/**`]),
      '--', pattern, target,
    ], { cwd: boundary, windowsHide: true });
    const hits: string[] = [];
    let truncated = false;
    let pending = '';
    let stderr = '';
    let settled = false;

    // 取消、达到命中上限和进程退出都可能触发结束；只结算一次。
    // 取消按取消结果返回，结束后移除信号监听器。
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      finish();
    };
    const cancel = () => {
      child.kill();
      settle(() => reject(new KernelError('search_cancelled', { detail: 'the content search was cancelled before it finished' })));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    // 子进程启动与注册监听之间也可能收到取消信号；此时立即终止，不等待搜索完成。
    if (signal?.aborted) cancel();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const consume = (chunk: string): void => {
      // 达到命中上限并终止子进程后，忽略迟到的输出。
      if (truncated) return;
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line === '') continue;
        if (hits.length === limit) {
          truncated = true;
          child.kill();
          return;
        }
        hits.push(normalize(line.replace(/\r$/, '')));
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => settle(() => reject(new KernelError('search_backend_failed', { cause: error, detail: `the search backend could not run: ${errorCode(error) ?? errorMessage(error)}` }))));
    child.on('close', (code: number | null) => {
    // ripgrep 以 1 表示没有匹配，属于正常结果；退出码 2 表示执行错误。
      if (code === 0 || code === 1 || truncated) settle(() => resolve({ hits, truncated }));
      else settle(() => reject(new KernelError('search_backend_failed', { detail: stderr.trim() || `ripgrep exited with ${code}` })));
    });
  });
}
