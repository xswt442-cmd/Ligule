import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import {
  createKernel, createObservationLog, createPermissionContext, createTool, deleteTool, editTool,
  execTool, findTool, readOnlyTools, readTool, resolveShell, searchTool, withNativeExitCode, writeTool,
} from '../dist/index.js';
import { windowsRecycleBin } from '../dist/capability/recycle.js';
import { bindScript } from '../dist/capability/script-binding.js';
import { boundaryOf, workingDirectoryOf } from '../dist/capability/limits.js';
import { resolveWithin } from '../dist/capability/paths.js';
import type { CapabilityConfig } from '../dist/capability/limits.js';
import type { ToolContext } from '../dist/kernel/kernel.js';

const builtRipgrep = rgPath;

const NEEDLE = 'needle here';

async function withWorkspace<TResult>(
  run: (workspace: string) => Promise<TResult>,
  { realRecycleBin = false }: { realRecycleBin?: boolean } = {},
): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'tools-'));
  const workspace = join(root, 'workspace');
  const previousXdgData = process.env.XDG_DATA_HOME;
  const originalRecycleSend = windowsRecycleBin.send;
  try {
    if (process.platform === 'win32' && !realRecycleBin) {
      // General tool tests exercise path and observation semantics without depositing fixtures in the user's Recycle Bin.
      windowsRecycleBin.send = async target => { await rm(target, { recursive: true, force: true }); };
    }
    process.env.XDG_DATA_HOME = join(root, 'xdg-data');
    await mkdir(join(workspace, 'src'), { recursive: true });
    // node_modules 放两处：搜索根下一层与嵌套一层，两条后端都必须按任意深度跳过它。
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(workspace, 'src', 'node_modules', 'pkg'), { recursive: true });
    // 隐藏目录要搜得到：配置写在 .github/ 这类目录里，跳过整棵子树等于看不见。
    await mkdir(join(workspace, '.github', 'workflows'), { recursive: true });
    // 旧回收目录不会被新的删除操作写入，仍由内部搜索跳过。
    await mkdir(join(workspace, '.ligule-trash'), { recursive: true });
    await writeFile(join(workspace, 'note.txt'), `line one\n${NEEDLE}\nline three`);
    await writeFile(join(workspace, 'src', 'app.js'), `const a = 'unused';\nsecond line ${NEEDLE}`);
    await writeFile(join(workspace, 'src', 'node_modules', 'pkg', 'deep.js'), `${NEEDLE} at depth`);
    await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), `${NEEDLE} but skipped`);
    await writeFile(join(workspace, '.ligule-trash', 'gone.txt'), `${NEEDLE} already deleted`);
    await writeFile(join(workspace, '.github', 'workflows', 'ci.yml'), `name: ${NEEDLE}`);
    return await run(workspace);
  } finally {
    windowsRecycleBin.send = originalRecycleSend;
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(root, { recursive: true, force: true });
  }
}

const silentLogger = { debug: () => {}, log: () => {} };
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
}, { workspaceTrusted: true });

// 工具上下文由内核完整注入；测试只给工具需要的那部分字段。
function context(workspace: string, limits?: Record<string, number>, extra: Record<string, unknown> = {}, signal?: AbortSignal): ToolContext {
  return { config: { boundary: workspace, limits, ...extra }, logger: silentLogger, signal } as unknown as ToolContext;
}

// 收集回落原因的日志接口：检索有两条后端，用不上外部那一条时要说清为什么。
function recordingContext(workspace: string, extra: Record<string, unknown> = {}) {
  const logged: Record<string, unknown>[] = [];
  return {
    logged,
    context: {
      config: { boundary: workspace, ...extra },
      logger: { debug: (message: string, fields: Record<string, unknown> = {}) => logged.push({ message, ...fields }), log: () => {} },
    } as unknown as ToolContext,
  };
}

test('read returns the file content and says nothing about truncation when it fits', async () => {
  await withWorkspace(async (workspace) => {
    assert.deepEqual(await readTool.run({ path: 'note.txt' }, context(workspace)), {
      text: `line one\n${NEEDLE}\nline three`,
    });
  });
});

test('read and default searches start at the working directory within the permission boundary', async () => {
  await withWorkspace(async (workspace) => {
    const child = join(workspace, 'src');
    const childConfig = { boundary: workspace, workspaceRoot: child };
    assert.equal((await readTool.run({ path: 'app.js' }, context(workspace, undefined, { workspaceRoot: child }))).text,
      `const a = 'unused';\nsecond line ${NEEDLE}`);
    assert.equal((await findTool.run({ pattern: '*.js' }, context(workspace, undefined, { workspaceRoot: child }))).text, 'app.js');
    assert.equal((await searchTool.run({ pattern: NEEDLE }, context(workspace, undefined, { workspaceRoot: child }))).text,
      `app.js:2:second line ${NEEDLE}`);
    await assert.rejects(readTool.run({ path: '../../outside.txt' }, { config: childConfig } as unknown as ToolContext), { code: 'path_escapes_boundary' });
  });
});

test('a parent working directory can address an explicit child boundary', async () => {
  await withWorkspace(async (workspace) => {
    const boundary = join(workspace, 'src');
    const toolContext = {
      ...context(workspace, undefined, { workspaceRoot: workspace }),
      config: { boundary, workspaceRoot: workspace, ripgrepPath: builtRipgrep },
      observations: createObservationLog(),
    };
    const absoluteFile = join(boundary, 'app.js');
    assert.match((await readTool.run({ path: 'src/app.js' }, toolContext)).text, /second line/);
    assert.match((await readTool.run({ path: absoluteFile }, toolContext)).text, /second line/);
    await assert.rejects(findTool.run({ pattern: '*' }, toolContext), { code: 'path_escapes_boundary' });
    assert.equal((await findTool.run({ pattern: '*.js', path: 'src' }, toolContext)).text, 'app.js');
    await assert.rejects(searchTool.run({ pattern: NEEDLE }, toolContext), { code: 'path_escapes_boundary' });
    const result = await searchTool.run({ pattern: NEEDLE, path: 'src' }, toolContext);
    assert.equal(result.text, `src/app.js:2:second line ${NEEDLE}`);
    assert.match((await readTool.run({ path: result.text.split(':')[0] }, toolContext)).text, /second line/);
    assert.equal((await searchTool.run({ pattern: NEEDLE, path: absoluteFile }, toolContext)).text, `src/app.js:2:second line ${NEEDLE}`);

    await createTool.run({ path: 'src/new.txt', content: 'first' }, toolContext);
    await writeTool.run({ path: 'src/new.txt', content: 'whole' }, toolContext);
    await editTool.run({ path: 'src/new.txt', anchor: 'whole', replacement: 'second' }, toolContext);
    assert.equal((await readTool.run({ path: 'src/new.txt' }, toolContext)).text, 'second');
    await deleteTool.run({ path: 'src/new.txt' }, toolContext);
  });
});

test('search validates absolute paths against the permission boundary', async () => {
  await withWorkspace(async (workspace) => {
    const inside = join(workspace, 'src', 'app.js');
    assert.match((await searchTool.run({ pattern: NEEDLE, path: inside }, context(workspace))).text, /src\/app\.js:2:/);
    const outside = join(dirname(workspace), 'outside.txt');
    await writeFile(outside, NEEDLE);
    await assert.rejects(searchTool.run({ pattern: NEEDLE, path: outside }, context(workspace)), { code: 'path_escapes_boundary' });
  });
});

test('create, edit, and delete resolve relative paths from the working directory', async () => {
  await withWorkspace(async (workspace) => {
    const child = join(workspace, 'src');
    const toolContext = {
      ...context(workspace, undefined, { workspaceRoot: child }),
      observations: createObservationLog(),
    };
    await createTool.run({ path: 'new.txt', content: 'first' }, toolContext);
    await writeTool.run({ path: 'new.txt', content: 'whole' }, toolContext);
    await editTool.run({ path: 'new.txt', anchor: 'whole', replacement: 'second' }, toolContext);
    assert.equal((await readTool.run({ path: 'new.txt' }, toolContext)).text, 'second');
    await deleteTool.run({ path: 'new.txt' }, toolContext);
    await assert.rejects(readTool.run({ path: 'new.txt' }, toolContext), { code: 'path_not_found' });
  });
});

test('exec uses the workspace root by default and validates an explicit child working directory', async () => {
  await withWorkspace(async (workspace) => {
    const child = join(workspace, 'src');
    const script = join(workspace, 'cwd.js');
    await writeFile(script, 'console.log(process.cwd())');
    const shell = resolveShell({});
    const command = `node "${script.replace(/\\/g, '/')}"`;
    const run = async (config: CapabilityConfig, cwd?: string) => {
      const boundary = boundaryOf(config);
      const workspaceRoot = workingDirectoryOf(config);
      const workingDirectory = await resolveWithin(boundary, cwd ?? '.', { cwd: workspaceRoot });
      const scriptBinding = await bindScript({ command, shell, boundary, workspaceRoot, cwd: workingDirectory, permission: fullAccess });
      return execTool.run(
        { command, ...(cwd === undefined ? {} : { cwd }) },
        { config, permission: fullAccess, shell: withNativeExitCode(shell, command), scriptBinding },
      );
    };
    assert.equal((await run({ boundary: workspace, workspaceRoot: workspace })).text.trim(), workspace);
    assert.equal((await run({ boundary: workspace, workspaceRoot: workspace }, 'src')).text.trim(), child);
    await assert.rejects(run({ boundary: child, workspaceRoot: workspace }), { code: 'path_escapes_boundary' });
    assert.equal((await run({ boundary: child, workspaceRoot: workspace }, 'src')).text.trim(), child);
  });
});

test('read cuts at the byte limit, leaves a visible marker, and the offset continues it', async () => {
  await withWorkspace(async (workspace) => {
    const first = await readTool.run({ path: 'note.txt' }, context(workspace, { readBytes: 10 }));
    assert.equal(first.text.slice(0, 10), 'line one\nn');
    assert.match(first.text, /\[truncated: 10 of 31 bytes shown, continue with offsetBytes=10]/);
    const rest = await readTool.run({ path: 'note.txt', offsetBytes: 10 }, context(workspace, { readBytes: 100 }));
    assert.equal(rest.text, `eedle here\nline three`);
  });
});

test('find returns sorted relative paths and honours the pattern kinds', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal((await findTool.run({ pattern: '*.txt' }, context(workspace))).text, 'note.txt');
    assert.equal((await findTool.run({ pattern: '**/*.js' }, context(workspace))).text, 'src/app.js');
    assert.equal((await findTool.run({ pattern: '*.md' }, context(workspace))).text, '(no matches)');
  });
});

test('find stops at the result limit and says more matches follow', async () => {
  await withWorkspace(async (workspace) => {
    const result = await findTool.run({ pattern: '**' }, context(workspace, { resultCount: 1 }));
    assert.equal(result.text.split('\n')[0], '.github/workflows/ci.yml');
    assert.match(result.text, /\[truncated: 1 matches shown and more follow, narrow the pattern]/);
  });
});

test('a **/ prefix also matches the search root itself', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'top.js'), 'no hit in here');
    assert.equal((await findTool.run({ pattern: '**/*.js' }, context(workspace))).text, 'src/app.js\ntop.js');
    assert.equal((await findTool.run({ pattern: '*/app.js' }, context(workspace))).text, 'src/app.js');
    assert.equal((await findTool.run({ pattern: '*.js' }, context(workspace))).text, 'top.js');
  });
});

test('search skips node_modules at any depth and the trash directory, but not hidden ones', async () => {
  await withWorkspace(async (workspace) => {
    const result = await searchTool.run({ pattern: NEEDLE }, context(workspace));
    assert.deepEqual(result.text.split('\n'), [
      '.github/workflows/ci.yml:1:name: needle here',
      'note.txt:2:needle here',
      'src/app.js:2:second line needle here',
    ]);
  });
});

test('search narrows to one file when a path is given', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(
      (await searchTool.run({ pattern: NEEDLE, path: 'src/app.js' }, context(workspace))).text,
      `src/app.js:2:second line ${NEEDLE}`,
    );
  });
});

test('search walks a subdirectory when the path is one, and names files from the boundary', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(
      (await searchTool.run({ pattern: NEEDLE, path: 'src' }, context(workspace))).text,
      `src/app.js:2:second line ${NEEDLE}`,
    );
  });
});

test('find and search fail with a stable code when the path does not exist or is not a directory', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(findTool.run({ pattern: '*', path: 'missing' }, context(workspace)), { code: 'path_not_found' });
    await assert.rejects(searchTool.run({ pattern: NEEDLE, path: 'missing' }, context(workspace)), { code: 'path_not_found' });
    await assert.rejects(findTool.run({ pattern: '*', path: 'note.txt' }, context(workspace)), { code: 'find_path_not_directory' });
  });
});

test('search walks the tree itself when no external backend is there, and says why', async () => {
  await withWorkspace(async (workspace) => {
    const { logged, context: searchContext } = recordingContext(workspace, { ripgrepPath: join(workspace, 'missing-rg') });
    const result = await searchTool.run({ pattern: NEEDLE }, searchContext);
    assert.deepEqual(result.text.split('\n'), [
      '.github/workflows/ci.yml:1:name: needle here',
      'note.txt:2:needle here',
      'src/app.js:2:second line needle here',
    ]);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].code, 'search_backend_failed');
  });
});

test('search with no hit says so instead of returning empty text', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal((await searchTool.run({ pattern: 'absent string' }, context(workspace))).text, '(no matches)');
  });
});

test('search of an explicit file inside a skipped directory still reads that file', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(
      (await searchTool.run({ pattern: NEEDLE, path: '.ligule-trash/gone.txt' }, context(workspace))).text,
      '.ligule-trash/gone.txt:1:needle here already deleted',
    );
  });
});

// 两种搜索后端应返回相同的命中行和顺序。测试目录没有二进制文件，因此两种后端都不应出现
// 跳过标记都不该出现——那条标记只属于自己遍历那一条，它知道自己跳过了什么，外部后端不交这个数。
test('the external backend and our own walk return the same hits in the same order', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'crlf.txt'), `windows line endings ${NEEDLE}\r\ntail`);
    const both = async (args: { pattern: string; path?: string }, limits?: Record<string, number>): Promise<string[]> => [
      (await searchTool.run(args, context(workspace, limits, { ripgrepPath: builtRipgrep }))).text,
      (await searchTool.run(args, context(workspace, limits))).text,
    ];
    const [external, own] = await both({ pattern: NEEDLE });
    assert.equal(external, own);
    assert.deepEqual(external.split('\n'), [
      '.github/workflows/ci.yml:1:name: needle here',
      'crlf.txt:1:windows line endings needle here',
      'note.txt:2:needle here',
      'src/app.js:2:second line needle here',
    ]);
    // 命中数到上限时两边留下的标记同形，终止的方式却不一样：外部那条杀进程，遍历那条停在这一份文件里。
    const [cappedExternal, cappedOwn] = await both({ pattern: NEEDLE }, { resultCount: 2 });
    assert.equal(cappedExternal, cappedOwn);
    assert.match(cappedExternal, /\[truncated: 2 matches shown and more follow, narrow the pattern]/);
    // 点名到回收站里的一个文件：那种路径外部后端不套排除项，两边都得搜到。
    const [fromTrash, walkedFromTrash] = await both({ pattern: NEEDLE, path: '.ligule-trash/gone.txt' });
    assert.equal(fromTrash, walkedFromTrash);
    assert.match(fromTrash, /gone\.txt:1:/);
  });
});

test('the external backend gives the same text twice over', async () => {
  await withWorkspace(async (workspace) => {
    const run = async () => (await searchTool.run({ pattern: NEEDLE }, context(workspace, undefined, { ripgrepPath: builtRipgrep }))).text;
    assert.equal(await run(), await run());
  });
});

test('the real external backend preserves UTF-8 across pipe chunks', async () => {
  await withWorkspace(async (workspace) => {
    const line = `needle ${'汉字🙂'.repeat(250)}`;
    await writeFile(join(workspace, 'unicode.txt'), Array.from({ length: 500 }, () => line).join('\n'));
    const result = await searchTool.run({ pattern: 'needle', path: 'unicode.txt' }, context(workspace, { resultCount: 1000 }, { ripgrepPath: builtRipgrep }));
    assert.deepEqual(result.text.split('\n'), Array.from({ length: 500 }, (_, index) => `unicode.txt:${index + 1}:${line}`));
  });
});

// 搜索子进程必须在项目边界内运行；相对配置路径按项目根解析，不受子进程工作目录影响。
test('a relative ripgrepPath is read against the process directory, not the boundary', async () => {
  await withWorkspace(async (workspace) => {
    const { logged, context: searchContext } = recordingContext(workspace, { ripgrepPath: relative(process.cwd(), builtRipgrep) });
    const result = await searchTool.run({ pattern: NEEDLE }, searchContext);
    assert.deepEqual(logged, []);
    assert.match(result.text, /note\.txt:2:/);
  });
});

test('a ripgrepPath that is not text is refused before probing a backend', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      searchTool.run({ pattern: NEEDLE }, context(workspace, undefined, { ripgrepPath: 17 })),
      (error) => {
        const failure = error as { code?: string; detail?: string };
        return failure.code === 'search_backend_failed' && failure.detail === 'ripgrepPath must be a string';
      },
    );
  });
});

test('a configured ripgrep that cannot run is reported and search still returns hits', async () => {
  await withWorkspace(async (workspace) => {
    const { logged, context: searchContext } = recordingContext(workspace, { ripgrepPath: join(workspace, 'no-such-rg') });
    const result = await searchTool.run({ pattern: NEEDLE }, searchContext);
    assert.match(result.text, /note\.txt:2:needle here/);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].code, 'search_backend_failed');
    assert.ok(logged[0].detail !== undefined);
  });
});

test('a cancelled search and find report their own code on the walk backend', async () => {
  await withWorkspace(async (workspace) => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = context(workspace, undefined, { ripgrepPath: join(workspace, 'missing-rg') }, controller.signal);
    await assert.rejects(searchTool.run({ pattern: NEEDLE }, cancelled), { code: 'search_cancelled' });
    await assert.rejects(findTool.run({ pattern: '**' }, cancelled), { code: 'find_cancelled' });
  });
});

// 取消落在遍历中途：abort 在第一个 await 之前发生，所以这条不靠时序运气。
test('a search cancelled while it is walking stops walking', async () => {
  await withWorkspace(async (workspace) => {
    const controller = new AbortController();
    const running = searchTool.run({ pattern: NEEDLE }, context(workspace, undefined, { ripgrepPath: join(workspace, 'missing-rg') }, controller.signal));
    controller.abort();
    await assert.rejects(running, { code: 'search_cancelled' });
  });
});

test('a pre-cancelled call never starts the external backend', async () => {
  await withWorkspace(async (workspace) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      searchTool.run({ pattern: NEEDLE }, context(workspace, undefined, { ripgrepPath: builtRipgrep }, controller.signal)),
      { code: 'search_cancelled' },
    );
  });
});

test('an exhausted scan budget stops the walk instead of reading every remaining file', async () => {
  await withWorkspace(async (workspace) => {
    const result = await searchTool.run({ pattern: NEEDLE }, context(workspace, { scanBytes: 12 }, { ripgrepPath: join(workspace, 'missing-rg') }));
    assert.equal(result.text, `(no matches)\n[incomplete: 12 bytes scanned, the rest of the tree was not read]`);
  });
});

test('the file limit stops the walk and says the rest of the tree was not read', async () => {
  await withWorkspace(async (workspace) => {
    assert.match((await searchTool.run({ pattern: NEEDLE }, context(workspace, { scanFiles: 1 }, { ripgrepPath: join(workspace, 'missing-rg') }))).text,
      /\[incomplete: 1 file\(s\) scanned, the rest of the tree was not read]/);
  });
});

test('a binary file is counted on its own and does not make the scan incomplete', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'data.bin'), Buffer.from(`head ${NEEDLE}\0tail`, 'utf8'));
    const result = await searchTool.run({ pattern: NEEDLE }, context(workspace, undefined, { ripgrepPath: join(workspace, 'missing-rg') }));
    assert.doesNotMatch(result.text, /incomplete/);
    assert.match(result.text, /\[1 binary file\(s\) skipped]/);
  });
});

test('the three read-only tools satisfy the registration contract and reach the manifest', async () => {
  const kernel = createKernel();
  for (const tool of readOnlyTools) kernel.register(tool);
  assert.deepEqual(kernel.list(), ['find', 'read', 'search']);
  assert.deepEqual(kernel.manifest().map((entry) => entry.name), ['find', 'read', 'search']);
  for (const entry of kernel.manifest()) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'name', 'parameters']);
  }
});
