import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanSystemTrashEntry } from './helpers/system-trash.ts';
import type { SystemTrashExpected } from './helpers/system-trash.ts';
import { createObservationLog, deleteTool, resolveRecycler } from '../dist/index.js';

type DeleteCase = { path: string; target: string; type: 'file' | 'directory'; content: string };

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

// 删除工具按真实上下文读取配置和本轮的观测日志。
const deleteContext = (config: { boundary: string; workspaceRoot: string }) =>
  ({ config, observations: createObservationLog() });

test('delete reports real system trash failures or verifies successful Linux trash entries', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'recycle-failure-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const fileName = `keep-${randomUUID()}.txt`;
  const directoryName = `keep-directory-${randomUUID()}`;
  const target = join(workspace, fileName);
  await writeFile(target, 'keep me');
  const directory = join(workspace, directoryName);
  await mkdir(join(directory, 'nested'), { recursive: true });
  await writeFile(join(directory, 'nested', 'keep.txt'), 'keep directory contents');
  const cases: DeleteCase[] = [
    { path: fileName, target, type: 'file', content: 'keep me' },
    { path: directoryName, target: directory, type: 'directory', content: 'keep directory contents' },
  ];
  const config = { boundary: workspace, workspaceRoot: workspace };
  const previousXdgData = process.env.XDG_DATA_HOME;
  try {
    if (process.platform === 'linux') {
      assert.ok((await resolveRecycler()).recycler, 'GIO is available before the send operation starts');
      const blockedXdgData = join(root, 'xdg-data-is-a-file');
      await writeFile(blockedXdgData, 'not a directory');
      process.env.XDG_DATA_HOME = blockedXdgData;
      for (const item of cases) {
        let failure: { code: string } | undefined;
        try { await deleteTool.run({ path: item.path }, deleteContext(config)); }
        catch (error) { failure = error as { code: string }; }
        if (failure !== undefined) {
          assert.equal(failure.code, 'recycle_backend_failed');
          if (item.type === 'file') assert.equal(await readFile(item.target, 'utf8'), item.content);
          else assert.equal(await readFile(join(item.target, 'nested', 'keep.txt'), 'utf8'), item.content);
        } else {
          await assert.rejects(lstat(item.target), { code: 'ENOENT' });
          await cleanSystemTrashEntry(item.target, item as unknown as SystemTrashExpected, { required: true });
        }
      }
    } else if (process.platform === 'win32') {
      const koffi = (await import('koffi')).default;
      const kernel = koffi.load('kernel32.dll');
      const createFile = kernel.func('__stdcall', 'CreateFileW', 'intptr', [
        'str16', 'uint32_t', 'uint32_t', 'intptr', 'uint32_t', 'uint32_t', 'intptr',
      ]);
      const closeHandle = kernel.func('__stdcall', 'CloseHandle', 'int32_t', ['intptr']);
      for (const [path, nativePath, flags] of [
        [fileName, target, 0x00000080],
        [directoryName, directory, 0x02000000],
      ] as [string, string, number][]) {
        const handle = createFile(nativePath, 0x80000000, 0x00000003, 0, 3, flags, 0);
        assert.notEqual(handle, -1);
        assert.notEqual(handle, -1n);
        try {
          await assert.rejects(deleteTool.run({ path }, deleteContext(config)), { code: 'recycle_backend_failed' });
        } finally {
          assert.equal(closeHandle(handle), 1);
        }
      }
      for (const item of cases) {
        assert.equal(await exists(item.target), true, `${item.path} remains at its original path after recycle failure`);
        if (item.type === 'file') assert.equal(await readFile(item.target, 'utf8'), item.content);
        else assert.equal(await readFile(join(item.target, 'nested', 'keep.txt'), 'utf8'), item.content);
      }
    } else {
      for (const item of cases) {
        await assert.rejects(deleteTool.run({ path: item.path }, deleteContext(config)), { code: 'recycle_backend_missing' });
      }
    }
    if (await exists(target)) {
      assert.equal(await readFile(target, 'utf8'), 'keep me');
    }
    if (await exists(directory)) {
      assert.equal(await readFile(join(directory, 'nested', 'keep.txt'), 'utf8'), 'keep directory contents');
    }
    await assert.rejects(lstat(join(workspace, '.ligule-trash')), { code: 'ENOENT' });
  } finally {
    if (process.platform === 'linux') {
      await cleanSystemTrashEntry(target, cases[0] as unknown as SystemTrashExpected);
      await cleanSystemTrashEntry(directory, cases[1] as unknown as SystemTrashExpected);
    }
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(root, { recursive: true, force: true });
  }
});

test('delete reports an unknown outcome when the target disappears, changes, or cannot be rechecked after backend failure', async (t) => {
  if (process.platform !== 'linux' && process.platform !== 'win32') return t.skip('no system recycle backend on this platform');
  const resolution = await resolveRecycler();
  assert.ok(resolution.recycler, 'the system recycle backend is available before the injected failure');
  const originalSend = resolution.recycler.send;
  type ScenarioPaths = { root: string; workspace: string; target: string };
  const cases: { name: string; mutate: (paths: ScenarioPaths) => Promise<void>; verify: (paths: ScenarioPaths) => Promise<void> }[] = [
    {
      name: 'target disappears',
      mutate: async ({ target }) => { await rm(target); },
      verify: async ({ target }) => assert.equal(await exists(target), false),
    },
    {
      name: 'target identity changes',
      mutate: async ({ target, workspace }) => {
        const replacement = join(workspace, 'replacement.txt');
        await writeFile(replacement, 'original');
        await rm(target);
        await rename(replacement, target);
      },
      verify: async ({ target }) => assert.equal(await readFile(target, 'utf8'), 'original'),
    },
    {
      name: 'top-level metadata changes',
      mutate: async ({ target }) => { await writeFile(target, 'changed-content'); },
      verify: async ({ target }) => assert.equal(await readFile(target, 'utf8'), 'changed-content'),
    },
    {
      name: 'the target cannot be rechecked',
      mutate: async ({ root, workspace }) => {
        await rename(workspace, join(root, 'workspace-moved'));
        await writeFile(workspace, 'blocks path traversal');
      },
      verify: async ({ root, workspace }) => {
        assert.equal(await readFile(workspace, 'utf8'), 'blocks path traversal');
        assert.equal(await readFile(join(root, 'workspace-moved', 'target.txt'), 'utf8'), 'original');
      },
    },
  ];

  try {
    const failureRoot = await mkdtemp(join(process.cwd(), 'testplace', 'recycle-backend-error-'));
    const failureWorkspace = join(failureRoot, 'workspace');
    const failureTarget = join(failureWorkspace, 'target.txt');
    await mkdir(failureWorkspace);
    await writeFile(failureTarget, 'original');
    resolution.recycler.send = async path => {
      assert.equal(path, failureTarget);
      throw Object.assign(new Error('injected system recycle failure'), { code: 'recycle_backend_failed' });
    };
    try {
      await assert.rejects(deleteTool.run({ path: 'target.txt' }, deleteContext({
        boundary: failureWorkspace, workspaceRoot: failureWorkspace,
      })), { code: 'recycle_backend_failed' });
      assert.equal(await readFile(failureTarget, 'utf8'), 'original');
    } finally {
      await rm(failureRoot, { recursive: true, force: true });
    }

    for (const scenario of cases) {
      const root = await mkdtemp(join(process.cwd(), 'testplace', 'recycle-uncertain-'));
      const workspace = join(root, 'workspace');
      const target = join(workspace, 'target.txt');
      await mkdir(workspace);
      await writeFile(target, 'original');
      const context = deleteContext({ boundary: workspace, workspaceRoot: workspace });
      resolution.recycler.send = async path => {
        assert.equal(path, target);
        await scenario.mutate({ root, workspace, target });
        throw Object.assign(new Error(`injected recycle failure after ${scenario.name}`), { code: 'recycle_backend_failed' });
      };
      try {
        await assert.rejects(deleteTool.run({ path: 'target.txt' }, context), { code: 'delete_outcome_unknown' }, scenario.name);
        await scenario.verify({ root, workspace, target });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    resolution.recycler.send = originalSend;
  }
});
