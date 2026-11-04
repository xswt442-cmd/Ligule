import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createConfig, createDecisionChain, createKernel, createObservationLog, createPermissionContext, createTool, deleteTool, editTool, readTool,
  readOnlyTools, resolveRecycler, writeTool, writeTools,
} from '../dist/index.js';
import { windowsRecycleBin } from '../dist/capability/recycle.js';
import type { PolicyAskResult, PolicyQuestion } from '../dist/kernel/policy.js';
import type { ToolContext } from '../dist/kernel/kernel.js';

import { cleanSystemTrashEntry, findSystemTrashEntry, removeSystemTrashEntry } from './helpers/system-trash.ts';

async function withWorkspace<TResult>(
  run: (workspace: string) => Promise<TResult>,
  { realRecycleBin = false }: { realRecycleBin?: boolean } = {},
): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'write-'));
  const workspace = join(root, 'workspace');
  const previousXdgData = process.env.XDG_DATA_HOME;
  const originalRecycleSend = windowsRecycleBin.send;
  await mkdir(workspace, { recursive: true });
  process.env.XDG_DATA_HOME = join(root, 'xdg-data');
  try {
    if (process.platform === 'win32' && !realRecycleBin) {
      // General tool tests exercise path and observation semantics without depositing fixtures in the user's Recycle Bin.
      windowsRecycleBin.send = async target => { await rm(target, { recursive: true, force: true }); };
    }
    return await run(workspace);
  } finally {
    windowsRecycleBin.send = originalRecycleSend;
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(root, { recursive: true, force: true });
  }
}

// 日志接口与观察记录都由内核注入，这里按内核给的形状自己建一份，直接调工具。
const silentLogger = { debug: () => {}, log: () => {} };
const workspaceWrite = createPermissionContext('workspace-write', 'disabled', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});

function context(workspace: string, limits?: Record<string, number>, extra: Record<string, unknown> = {}): ToolContext {
  return { config: { boundary: workspace, limits, ...extra }, logger: silentLogger } as unknown as ToolContext;
}

test('create writes a new file and creates the missing parent directories', async () => {
  await withWorkspace(async (workspace) => {
    assert.deepEqual(await createTool.run({ path: 'src/deep/new.txt', content: 'hello' }, context(workspace)), {
      text: 'created src/deep/new.txt (5 bytes)',
    });
    assert.equal(await readFile(join(workspace, 'src', 'deep', 'new.txt'), 'utf8'), 'hello');
  });
});

test('create refuses an existing target and leaves its content alone', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'original');
    await assert.rejects(
      () => createTool.run({ path: 'note.txt', content: 'overwritten' }, context(workspace)),
      (error) => (error as { code?: string }).code === 'create_target_exists',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'original');
  });
});

test('two kernels creating one file preserve exactly one complete winner', async () => {
  await withWorkspace(async (workspace) => {
    const kernels = [0, 1].map(() => {
      const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
      kernel.register(createTool);
      return kernel;
    });
    const contents = ['first complete content', 'second complete content'];
    for (let index = 0; index < 10; index += 1) {
      const path = `race-${index}.txt`;
      const outcomes = await Promise.allSettled(kernels.map((kernel, writer) => kernel.call('create', { path, content: contents[writer] })));
      assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
      const failed = outcomes.find((item) => item.status === 'rejected') as PromiseRejectedResult | undefined;
      assert.equal(failed?.reason?.code, 'create_target_exists');
      const winner = outcomes.findIndex((item) => item.status === 'fulfilled');
      assert.equal(await readFile(join(workspace, path), 'utf8'), contents[winner]);
    }
  });
});

test('legacy project trash settings fail with an actionable error and preserve the source', async () => {
  await withWorkspace(async (workspace) => {
    const outside = join(workspace, '..', 'outside');
    await mkdir(outside);
    await writeFile(join(workspace, 'keep.txt'), 'must remain');
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace, trashBackend: 'managed', limits: { trashDirectory: '../outside' } } }),
      permission: workspaceWrite,
    });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'keep.txt' }), { code: 'trash_legacy_config_unsupported' });
    assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'must remain');
    assert.deepEqual(await readdir(outside), []);
  });
});

test('deletion leaves an existing unknown project trash directory untouched', async () => {
  await withWorkspace(async (workspace) => {
    const fileName = `keep-${randomUUID()}.txt`;
    await mkdir(join(workspace, '.ligule-trash'));
    await writeFile(join(workspace, '.ligule-trash', 'old-entry.txt'), 'untouched legacy data');
    await writeFile(join(workspace, fileName), 'must remain');
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(deleteTool);
    // The test process may have a working system trash. In either case the old directory is never adopted or altered.
    await kernel.call('delete', { path: fileName });
    assert.equal(await readFile(join(workspace, '.ligule-trash', 'old-entry.txt'), 'utf8'), 'untouched legacy data');
    assert.deepEqual((await readdir(join(workspace, '.ligule-trash'))).sort(), ['old-entry.txt']);
    if (process.platform === 'linux') {
      await cleanSystemTrashEntry(join(workspace, fileName), { type: 'file', content: 'must remain' }, { allowSuffix: true, required: true });
    }
  });
});

test('edit replaces the one occurrence the anchor locates', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo\nthree');
    assert.deepEqual(await editTool.run({ path: 'note.txt', anchor: 'two', replacement: '2' }, context(workspace)), {
      text: 'edited note.txt',
    });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'one\n2\nthree');
  });
});

test('edit preserves replacement tokens as literal file content through the kernel', async () => {
  await withWorkspace(async (workspace) => {
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(createTool);
    kernel.register(editTool);
    await kernel.call('create', { path: 'literal.txt', content: 'before ANCHOR after' });
    const replacement = "$& $$ $` $'\nconst value = '$&';";
    await kernel.call('edit', { path: 'literal.txt', anchor: 'ANCHOR', replacement });
    assert.equal(await readFile(join(workspace, 'literal.txt'), 'utf8'), `before ${replacement} after`);
  });
});

test('edit rejects an empty or blank anchor before looking at the file', async () => {
  await withWorkspace(async (workspace) => {
    for (const anchor of ['', '   ']) {
      await assert.rejects(
        () => editTool.run({ path: 'missing.txt', anchor, replacement: 'x' }, context(workspace)),
        (error) => (error as { code?: string }).code === 'edit_anchor_empty',
      );
    }
  });
});

test('edit rejects a missing target, an anchor that is not there, and an anchor that matches twice', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      () => editTool.run({ path: 'missing.txt', anchor: 'a', replacement: 'b' }, context(workspace)),
      (error) => (error as { code?: string }).code === 'edit_target_missing',
    );
    await writeFile(join(workspace, 'note.txt'), 'alpha');
    await assert.rejects(
      () => editTool.run({ path: 'note.txt', anchor: 'zzz', replacement: 'b' }, context(workspace)),
      (error) => (error as { code?: string }).code === 'edit_anchor_not_found',
    );
    await writeFile(join(workspace, 'twice.txt'), 'x x');
    await assert.rejects(
      () => editTool.run({ path: 'twice.txt', anchor: 'x', replacement: 'y' }, context(workspace)),
      (error) => (error as { code?: string }).code === 'edit_anchor_ambiguous',
    );
    assert.equal(await readFile(join(workspace, 'twice.txt'), 'utf8'), 'x x');
  });
});

test('delete refuses a final directory link and preserves its target', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'source'));
    await writeFile(join(workspace, 'source', 'keep.txt'), 'keep the source');
    await symlink(join(workspace, 'source'), join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(deleteTool);
    for (const path of ['alias', 'alias/']) {
      await assert.rejects(kernel.call('delete', { path }), { code: 'delete_target_is_link' });
      assert.equal((await lstat(join(workspace, 'alias'))).isSymbolicLink(), true);
      assert.equal(await readFile(join(workspace, 'source', 'keep.txt'), 'utf8'), 'keep the source');
    }
    assert.deepEqual((await readdir(workspace)).sort(), ['alias', 'source']);
  });
});

test('delete refuses a dangling directory link without replacing it', async () => {
  await withWorkspace(async (workspace) => {
    const source = join(workspace, 'source');
    await mkdir(source);
    await symlink(source, join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await rm(source, { recursive: true });
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'alias' }), { code: 'delete_target_is_link' });
    assert.equal((await lstat(join(workspace, 'alias'))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(workspace), ['alias']);
  });
});

test('delete uses the operating system recycle bin and takes the source out of the workspace', async (t) => {
  if (process.platform !== 'linux' && process.platform !== 'win32') return t.skip('no system recycle backend on this platform');
  if (process.platform === 'win32' && process.env.CI !== 'true' && process.env.LIGULE_TEST_REAL_RECYCLE_BIN !== '1') {
    return t.skip('real Windows recycle-bin coverage runs on disposable CI; set LIGULE_TEST_REAL_RECYCLE_BIN=1 to opt in locally');
  }
  await withWorkspace(async (workspace) => {
    const fileName = `note-${randomUUID()}.txt`;
    const target = join(workspace, fileName);
    await writeFile(target, 'keep me');
    const approvals: PolicyQuestion[] = [];
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async (question) => {
        approvals.push(question);
        return { decision: 'allow', source: 'human' };
      } }),
    });
    kernel.register(deleteTool);
    const result = await kernel.call('delete', { path: fileName }) as { text: string };
    const backend = process.platform === 'win32' ? 'system recycle bin' : 'system trash';
    assert.equal(result.text, `sent ${fileName} to the ${backend}`);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'delete');
    await assert.rejects(() => readFile(target, 'utf8'), (error) => (error as { code?: string }).code === 'ENOENT');
    if (process.platform === 'linux') {
      await cleanSystemTrashEntry(target, { type: 'file', content: 'keep me' }, { allowSuffix: true, required: true });
    }
  }, { realRecycleBin: true });
});

test('Policy denial leaves the delete target in place', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => ({ decision: 'deny', source: 'human' }) }),
    });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'note.txt' }), { code: 'ask_declined' });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'keep me');
  });
});

test('delete refuses a target changed while Policy approval is pending', async () => {
  await withWorkspace(async (workspace) => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'original content');
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => {
        await writeFile(target, 'changed while waiting');
        return { decision: 'allow', source: 'human' };
      } }),
    });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'note.txt' }), { code: 'delete_target_changed' });
    assert.equal(await readFile(target, 'utf8'), 'changed while waiting');
  });
});

test('concurrent delete calls keep per-call snapshots when they share the same argument object', async () => {
  await withWorkspace(async (workspace) => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'original content');
    let signalFirstApproval!: () => void;
    let approveFirst!: (decision: PolicyAskResult) => void;
    const firstApproval = new Promise<void>((resolve) => { signalFirstApproval = resolve; });
    const firstDecision = new Promise<PolicyAskResult>((resolve) => { approveFirst = resolve; });
    const firstKernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => {
        signalFirstApproval();
        return firstDecision;
      } }),
    });
    const secondKernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => ({ decision: 'deny', source: 'human' }) }),
    });
    firstKernel.register(deleteTool);
    secondKernel.register(deleteTool);
    const sharedArguments = { path: 'note.txt' };
    const first = firstKernel.call('delete', sharedArguments);
    await firstApproval;
    await rm(target);
    await writeFile(target, 'replacement during first approval');
    await assert.rejects(secondKernel.call('delete', sharedArguments), { code: 'ask_declined' });
    approveFirst({ decision: 'allow', source: 'human' });
    await assert.rejects(first, { code: 'delete_target_changed' });
    assert.equal(await readFile(target, 'utf8'), 'replacement during first approval');
  });
});

test('legacy trash backend configuration is refused with an actionable code', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    await assert.rejects(
      () => deleteTool.run({ path: 'note.txt' }, context(workspace, undefined, { trashBackend: 'shred' })),
      (error) => (error as { code?: string }).code === 'trash_legacy_config_unsupported',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'keep me');
  });
});

test('a platform without a backend resolves to no recycler and a stable code', async () => {
  assert.deepEqual(await resolveRecycler('darwin'), { recycler: undefined, code: 'recycle_backend_missing' });
});

test('the Linux system trash moves a file to the OS-selected trash location', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux system trash only');
  await withWorkspace(async (workspace) => {
    const fileName = `p5-file-${randomUUID()}.txt`;
    const target = join(workspace, fileName);
    await writeFile(target, 'recoverable payload');
    await deleteTool.run({ path: fileName }, context(workspace));
    await assert.rejects(readFile(target), { code: 'ENOENT' });
    await cleanSystemTrashEntry(target, { type: 'file', content: 'recoverable payload' }, { allowSuffix: true, required: true });
  });
});

test('the Linux system trash preserves an existing same-name entry', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux system trash only');
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'trash-'));
  const previous = process.env.XDG_DATA_HOME;
  const workspace = join(root, 'workspace');
  const probeName = `p5-trash-probe-${randomUUID()}.txt`;
  const collisionName = `p5-collision-${randomUUID()}.txt`;
  let trashRoot!: string;
  let existingPayload!: string;
  let existingInfo!: string;
  let createdExistingPayload = false;
  let createdExistingInfo = false;
  try {
    process.env.XDG_DATA_HOME = join(root, 'xdg-data');
    await mkdir(workspace, { recursive: true });
    const probeTarget = join(workspace, probeName);
    await writeFile(probeTarget, 'trash root probe');
    await deleteTool.run({ path: probeName }, context(workspace));
    await assert.rejects(readFile(probeTarget), { code: 'ENOENT' });
    const probeEntry = await findSystemTrashEntry(probeTarget, { allowSuffix: true });
    assert.ok(probeEntry);
    trashRoot = probeEntry.root;
    await removeSystemTrashEntry(probeEntry, { type: 'file', content: 'trash root probe' });

    const files = join(trashRoot, 'files');
    const info = join(trashRoot, 'info');
    await mkdir(files, { recursive: true });
    await mkdir(info, { recursive: true });
    existingPayload = join(files, collisionName);
    existingInfo = join(info, `${collisionName}.trashinfo`);
    await writeFile(existingPayload, 'existing trash item', { flag: 'wx' });
    createdExistingPayload = true;
    await writeFile(existingInfo, `[Trash Info]\nPath=/p5-fixture/${collisionName}\nDeletionDate=2026-10-29T00:00:00\n`, { flag: 'wx' });
    createdExistingInfo = true;
    const target = join(workspace, collisionName);
    await writeFile(target, 'new item');
    await deleteTool.run({ path: collisionName }, context(workspace));
    await assert.rejects(readFile(target), { code: 'ENOENT' });

    assert.equal(await readFile(existingPayload, 'utf8'), 'existing trash item');
    const newEntry = await findSystemTrashEntry(target, { root: trashRoot, allowSuffix: true });
    assert.ok(newEntry);
    await removeSystemTrashEntry(newEntry, { type: 'file', content: 'new item' });
    await rm(existingPayload);
    await rm(existingInfo);
  } finally {
    if (trashRoot !== undefined) {
      const probeTarget = join(workspace, probeName);
      await cleanSystemTrashEntry(probeTarget, { type: 'file', content: 'trash root probe' }, { allowSuffix: true });
      const target = join(workspace, collisionName);
      await cleanSystemTrashEntry(target, { type: 'file', content: 'new item' }, { allowSuffix: true, root: trashRoot });
      if (createdExistingPayload) {
        try {
          assert.equal(await readFile(existingPayload, 'utf8'), 'existing trash item');
          await rm(existingPayload);
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
      }
      if (createdExistingInfo) {
        await rm(existingInfo, { force: true });
      }
    }
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('the Linux system trash moves directories with their contents', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux system trash only');
  await withWorkspace(async (workspace) => {
    const directoryName = `p5-directory-${randomUUID()}`;
    const target = join(workspace, directoryName);
    await mkdir(join(target, 'nested'), { recursive: true });
    await writeFile(join(target, 'nested', 'note.txt'), 'recoverable directory');
    await deleteTool.run({ path: directoryName }, context(workspace));
    await assert.rejects(readFile(join(target, 'nested', 'note.txt')), { code: 'ENOENT' });
    await cleanSystemTrashEntry(target, {
      type: 'directory', relativePath: ['nested', 'note.txt'], content: 'recoverable directory',
    }, { allowSuffix: true, required: true });
  });
});

test('delete refuses the boundary itself and a target that is not there', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      () => deleteTool.run({ path: '.' }, context(workspace)),
      (error) => (error as { code?: string }).code === 'delete_target_is_boundary',
    );
    await assert.rejects(
      () => deleteTool.run({ path: 'gone.txt' }, context(workspace)),
      (error) => (error as { code?: string }).code === 'delete_target_missing',
    );
  });
});

test('delete refuses a path outside its workspace and preserves the file', async () => {
  await withWorkspace(async (workspace) => {
    const outside = join(workspace, '..', 'outside-delete-target.txt');
    await writeFile(outside, 'keep outside');
    try {
      await assert.rejects(
        () => deleteTool.run({ path: outside }, context(workspace)),
        { code: 'path_escapes_boundary' },
      );
      assert.equal(await readFile(outside, 'utf8'), 'keep outside');
    } finally {
      await rm(outside, { force: true });
    }
  });
});

function observed(workspace: string, limits?: Record<string, number>): ToolContext {
  const observations = createObservationLog();
  return { config: { boundary: workspace, limits }, logger: silentLogger, observations } as unknown as ToolContext;
}

test('write replaces the whole content of a file observed in this run', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo');
    const context = observed(workspace);
    await readTool.run({ path: 'note.txt' }, context);
    assert.deepEqual(await writeTool.run({ path: 'note.txt', content: 'replaced' }, context), {
      text: 'wrote note.txt (8 bytes)',
    });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'replaced');
    // 写成功之后重新登记，紧接着再覆盖一次不要求重新读。
    assert.deepEqual(await writeTool.run({ path: 'note.txt', content: 'again' }, context), {
      text: 'wrote note.txt (5 bytes)',
    });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'again');
  });
});

test('write refuses an unobserved target, one that changed since, and one that is not there', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo');
    const context = observed(workspace);
    await assert.rejects(
      () => writeTool.run({ path: 'note.txt', content: 'x' }, context),
      (error) => (error as { code?: string }).code === 'write_not_observed',
    );
    await readTool.run({ path: 'note.txt' }, context);
    await writeFile(join(workspace, 'note.txt'), 'changed behind our back');
    await assert.rejects(
      () => writeTool.run({ path: 'note.txt', content: 'x' }, context),
      (error) => (error as { code?: string }).code === 'write_version_stale',
    );
    await assert.rejects(
      () => writeTool.run({ path: 'missing.txt', content: 'x' }, context),
      (error) => (error as { code?: string }).code === 'write_target_missing',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'changed behind our back');
  });
});

test('a truncated read is not an observation, so it cannot authorise an overwrite', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'a'.repeat(40));
    const context = observed(workspace, { readBytes: 10 });
    assert.match((await readTool.run({ path: 'note.txt' }, context)).text, /truncated/);
    await assert.rejects(
      () => writeTool.run({ path: 'note.txt', content: 'x' }, context),
      (error) => (error as { code?: string }).code === 'write_not_observed',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'a'.repeat(40));
  });
});

test('a successful edit refreshes the observation and a delete drops it', async () => {
  await withWorkspace(async (workspace) => {
    const fileName = `note-${randomUUID()}.txt`;
    const target = join(workspace, fileName);
    await writeFile(target, 'one\ntwo');
    const context = observed(workspace);
    await readTool.run({ path: fileName }, context);
    await editTool.run({ path: fileName, anchor: 'two', replacement: '2' }, context);
    assert.deepEqual(await writeTool.run({ path: fileName, content: 'after edit' }, context), {
      text: `wrote ${fileName} (10 bytes)`,
    });

    await deleteTool.run({ path: fileName }, context);
    if (process.platform === 'linux') {
      await cleanSystemTrashEntry(target, { type: 'file', content: 'after edit' }, { allowSuffix: true, required: true });
    }
    await createTool.run({ path: fileName, content: 'after edit' }, context);
    // create 自己登记了这一次的内容，所以紧接着覆盖成立；换成别的进程写的文件就不成立。
    assert.deepEqual(await writeTool.run({ path: fileName, content: 'x' }, context), { text: `wrote ${fileName} (1 bytes)` });
  });
});

test('write goes through the kernel and its failures reach the session log', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one');
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(readTool);
    kernel.register(writeTool);
    await assert.rejects(
      () => kernel.call('write', { path: 'note.txt', content: 'x' }),
      (error) => (error as { code?: string }).code === 'write_not_observed',
    );
    await kernel.call('read', { path: 'note.txt' });
    assert.deepEqual(await kernel.call('write', { path: 'note.txt', content: 'two' }), { text: 'wrote note.txt (3 bytes)' });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'two');
  });
});

test('the seven tools satisfy the registration contract and all reach the manifest', () => {
  const kernel = createKernel();
  for (const tool of [...readOnlyTools, ...writeTools]) kernel.register(tool);
  assert.deepEqual(kernel.list(), ['create', 'delete', 'edit', 'find', 'read', 'search', 'write']);
  for (const entry of kernel.manifest()) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'name', 'parameters']);
  }
});
