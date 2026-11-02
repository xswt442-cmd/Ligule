// 扩展启停登记：数据根下的持久状态，记录用户显式停用的已安装扩展。
// 登记只过滤安装目录的发现结果；配置层显式声明的路径不受其约束。
// 读取失败时已安装扩展全部停用，同时把原因交回环境装载器报告。
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { dataRoot } from './config-file.js';
import { KernelError } from './error.js';

const STATE_VERSION = 1;

export function extensionStatePath(home = homedir()): string {
  return join(dataRoot(home), 'extensions-state.json');
}

export interface ExtensionStateRead {
  disabled: string[];
  // 登记存在但读不懂时给出原因；不影响按空登记继续。
  invalid?: string;
  // 登记存在但读不出来：停用名单不可信，已安装扩展全部排除在活动路径之外，
  // extensions.set 也必须中止写入，避免以空名单覆盖真实停用记录。
  unavailable?: string;
}

export async function readExtensionState(home = homedir()): Promise<ExtensionStateRead> {
  let text: string;
  try {
    text = await readFile(extensionStatePath(home), 'utf8');
  } catch (error) {
    // 缺失是正常状态（从未停用过）。存在但读不出来（无权限、损坏、版本不符）时
    // 不能按空登记放行全部扩展：停用名单可能包含用户刻意挡下的代码。
    // 返回 `unavailable`，由环境装载把已安装扩展全部排除在活动路径之外，并在诊断中说明。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { disabled: [] };
    return { disabled: [], unavailable: `${(error as NodeJS.ErrnoException).code ?? 'read_failed'}: ${(error as Error).message}` };
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; disabled?: unknown };
    if (parsed.version !== STATE_VERSION
      || !Array.isArray(parsed.disabled)
      || parsed.disabled.some((item) => typeof item !== 'string' || item === '')) {
      // 停用名单不可信：与读取失败同样处理，全部已安装扩展退出活动路径。
      return { disabled: [], invalid: 'the extension state document is invalid', unavailable: 'invalid document' };
    }
    return { disabled: [...new Set(parsed.disabled as string[])].sort() };
  } catch (cause) {
    return { disabled: [], invalid: (cause as Error).message, unavailable: (cause as Error).message };
  }
}

// 读取-合并-写入在同一文件锁内完成；临时文件加原子替换落盘。
export async function writeExtensionState(home = homedir(), disabled: readonly string[] = []): Promise<void> {
  const target = extensionStatePath(home);
  await mkdir(dirname(target), { recursive: true });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, { realpath: false, lockfilePath: `${target}.lock`, stale: 10_000, update: 2_000, retries: 0 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new KernelError('extension_state_locked', { detail: `${target} has an active writer` });
    }
    throw cause;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const document = JSON.stringify({ version: STATE_VERSION, disabled: [...new Set(disabled)].sort() }, null, 2);
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(document, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    created = false;
  } finally {
    try {
      if (created) await rm(temporary, { force: true });
    } finally {
      await release();
    }
  }
}
