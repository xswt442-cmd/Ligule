// 每个测试进程使用独立的临时主目录，避免读写开发者机器上的个人配置、会话、按键、技能和模式。
// `npm test` 通过 Node 的 `--import` 加载本文件，因此每个测试进程都会先设置隔离环境。
// 清除 `LIGULE_HOME`，让依赖 HOME 的代码使用这个临时目录；显式验证 `LIGULE_HOME` 的测试自行设置该变量。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ligule-test-home-'));
// CI 检出后可能还没有临时目录，因此由测试进程创建它。
mkdirSync(join(process.cwd(), 'testplace'), { recursive: true });
delete process.env.LIGULE_HOME;
// Node 在 Windows 上读取 `USERPROFILE`，在 POSIX 系统上读取 `HOME`。
process.env.HOME = home;
process.env.USERPROFILE = home;

// 进程退出时清理临时主目录。若系统仍有进程占用文件，清理失败不应覆盖原测试结果。
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* 子进程仍占用目录时可能无法立即删除；这不应覆盖测试结果。 */
  }
});
