import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDecisionChain, createKernel, createSessionLog, loadAssembly, parseSessionEvents } from '../dist/index.js';
import { createTodoWritePlugin } from '../dist/tools/todo-write.js';
import { currentTodoSnapshot } from '../dist/session/todo.js';

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-todo-write-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function runtime(directory: string, id: string) {
  const session = createSessionLog({ directory, id });
  const kernel = createKernel({
    session,
    policy: createDecisionChain({ mode: 'auto' }),
  });
  const assembly = loadAssembly(kernel, [createTodoWritePlugin({ session })]);
  return {
    session,
    kernel,
    close: async () => {
      assembly.dispose();
      await session.close();
    },
  };
}

test('todo_write replaces the complete current-turn snapshot and returns status counts', async () => {
  await withDirectory(async (directory) => {
    const instance = runtime(directory, 'todo-replace');
    try {
      const user = await instance.session.append({ kind: 'user', text: 'Complete this task' });
      const first = await instance.kernel.call('todo_write', { items: [
        { content: ' Read the source ', status: 'in_progress' },
        { content: 'Write the report', status: 'pending' },
      ] });
      assert.deepEqual(first, {
        items: [
          { content: 'Read the source', status: 'in_progress' },
          { content: 'Write the report', status: 'pending' },
        ],
        total: 2,
        counts: { pending: 1, in_progress: 1, completed: 0 },
      });

      const replacement = await instance.kernel.call('todo_write', { items: [
        { content: 'Finish the report', status: 'completed' },
      ] });
      assert.deepEqual(replacement, {
        items: [{ content: 'Finish the report', status: 'completed' }],
        total: 1,
        counts: { pending: 0, in_progress: 0, completed: 1 },
      });

      const events = await instance.session.read();
      const writes = events.filter((event) => event.kind === 'todoWrite');
      assert.deepEqual(writes.map((event) => event.items), [
        [
          { content: 'Read the source', status: 'in_progress' },
          { content: 'Write the report', status: 'pending' },
        ],
        [{ content: 'Finish the report', status: 'completed' }],
      ], 'each full snapshot remains in the Session history');
      assert.ok(writes.every((event) => event.ignorable === true && event.userSeq === user.seq));
      assert.deepEqual(currentTodoSnapshot(events), {
        userSeq: user.seq,
        items: [{ content: 'Finish the report', status: 'completed' }],
      }, 'the last snapshot is the current list');
    } finally { await instance.close(); }
  });
});

test('an empty snapshot clears the current turn without deleting prior todo events', async () => {
  await withDirectory(async (directory) => {
    const instance = runtime(directory, 'todo-clear');
    try {
      const user = await instance.session.append({ kind: 'user', text: 'Clear this task list' });
      await instance.kernel.call('todo_write', { items: [{ content: 'Old task', status: 'pending' }] });
      assert.deepEqual(await instance.kernel.call('todo_write', { items: [] }), {
        items: [], total: 0, counts: { pending: 0, in_progress: 0, completed: 0 },
      });
      const events = await instance.session.read();
      assert.equal(events.filter((event) => event.kind === 'todoWrite').length, 2);
      assert.deepEqual(currentTodoSnapshot(events), { userSeq: user.seq, items: [] });
    } finally { await instance.close(); }
  });
});

test('a new user turn starts with an empty active list and old snapshots restore as history', async () => {
  await withDirectory(async (directory) => {
    const instance = runtime(directory, 'todo-turns');
    try {
      const firstUser = await instance.session.append({ kind: 'user', text: 'First turn' });
      await instance.kernel.call('todo_write', { items: [{ content: 'Unfinished from turn one', status: 'in_progress' }] });
      const nextUser = await instance.session.append({ kind: 'user', text: 'Second turn' });
      const events = await instance.session.read();
      assert.deepEqual(currentTodoSnapshot(events), { userSeq: nextUser.seq, items: [] });
      assert.equal(events.filter((event) => event.kind === 'todoWrite' && event.userSeq === firstUser.seq).length, 1,
        'the previous turn remains auditable');

      const reopened = createSessionLog({ directory, id: 'todo-turns' });
      try {
        const restored = await reopened.read();
        assert.deepEqual(currentTodoSnapshot(restored), { userSeq: nextUser.seq, items: [] });
        assert.equal(restored.filter((event) => event.kind === 'todoWrite').length, 1);
      } finally { await reopened.close(); }
    } finally { await instance.close(); }
  });
});

test('a terminal turn clears the active view while retaining its todo history', async () => {
  await withDirectory(async (directory) => {
    const instance = runtime(directory, 'todo-terminal-turn');
    try {
      const user = await instance.session.append({ kind: 'user', text: 'Finish this turn' });
      await instance.kernel.call('todo_write', { items: [{ content: 'Current work', status: 'in_progress' }] });
      await instance.session.append({
        kind: 'turn', ignorable: true, status: 'completed', userSeq: user.seq, iterations: 1, modelCalls: 1,
      });

      const events = await instance.session.read();
      assert.deepEqual(currentTodoSnapshot(events), { userSeq: null, items: [] });
      assert.equal(events.filter((event) => event.kind === 'todoWrite').length, 1);
      await assert.rejects(
        instance.kernel.call('todo_write', { items: [{ content: 'Late write', status: 'pending' }] }),
        { code: 'todo_turn_missing' },
      );
    } finally { await instance.close(); }
  });
});

test('todoWrite metadata is validated, retained, and does not add a model message', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'todo-projection' });
    try {
      const user = await session.append({ kind: 'user', text: 'Keep this user message' });
      const before = await session.modelView();
      await session.append({
        kind: 'todoWrite', ignorable: true, userSeq: user.seq,
        items: [{ content: 'Internal status', status: 'pending' }],
      });
      assert.deepEqual(await session.modelView(), before);
      assert.equal((await session.read()).filter((event) => event.kind === 'todoWrite').length, 1);
    } finally { await session.close(); }
  });
});

test('invalid snapshots fail through the real Kernel and are never persisted as todo facts', async () => {
  await withDirectory(async (directory) => {
    const instance = runtime(directory, 'todo-invalid');
    try {
      await instance.session.append({ kind: 'user', text: 'Validate the list' });
      const invalid = [
        { items: [{ content: '   ', status: 'pending' }], code: 'todo_item_content_invalid' },
        { items: [
          { content: 'Duplicate', status: 'pending' },
          { content: ' Duplicate ', status: 'completed' },
        ], code: 'todo_item_duplicate' },
        { items: [{ content: 'Wrong state', status: 'blocked' }], code: 'tool_args_invalid' },
        { items: [{ content: 'x'.repeat(401), status: 'pending' }], code: 'tool_args_invalid' },
        { items: Array.from({ length: 41 }, (_, index) => ({ content: `Task ${index}`, status: 'pending' })), code: 'tool_args_invalid' },
        { items: Array.from({ length: 21 }, (_, index) => ({ content: `${String(index).padStart(2, '0')}${'x'.repeat(398)}`, status: 'pending' })), code: 'todo_list_content_too_large' },
        { items: 'not an array', code: 'tool_args_invalid' },
      ];
      for (const example of invalid) {
        const error = await instance.kernel.call('todo_write', { items: example.items }).catch((caught) => caught) as { code: string };
        assert.equal(error.code, example.code);
      }
      assert.equal((await instance.session.read()).filter((event) => event.kind === 'todoWrite').length, 0);
    } finally { await instance.close(); }
  });
});

test('item character limits count Unicode code points while the list byte budget remains enforced', async () => {
  await withDirectory(async (directory) => {
    const instance = runtime(directory, 'todo-unicode');
    try {
      await instance.session.append({ kind: 'user', text: 'Count Unicode characters' });
      const content = '😀'.repeat(400);
      const accepted = await instance.kernel.call('todo_write', { items: [{ content, status: 'pending' }] }) as {
        items: { content: string }[];
      };
      assert.equal(accepted.items[0].content, content, '400 Unicode code points fit the declared character bound');
      const rejected = await instance.kernel.call('todo_write', {
        items: [{ content: '😀'.repeat(401), status: 'pending' }],
      }).catch((error) => error) as { code: string };
      assert.equal(rejected.code, 'tool_args_invalid', 'the Kernel schema rejects 401 Unicode code points');
    } finally { await instance.close(); }
  });
});

test('empty legacy Sessions remain readable and a malformed todoWrite event is rejected', async () => {
  const legacy = parseSessionEvents([{ seq: 0, kind: 'user', text: 'Legacy record' }]);
  assert.equal(legacy.formatVersion, 0);
  assert.equal(legacy.events[0].text, 'Legacy record');

  assert.throws(() => parseSessionEvents([
    { seq: 0, kind: 'user', text: 'A turn' },
    { seq: 1, kind: 'todoWrite', ignorable: false, userSeq: 0, items: [] },
  ]), { code: 'session_todo_event_invalid' });
  assert.throws(() => parseSessionEvents([
    { seq: 0, kind: 'user', text: 'A turn' },
    { seq: 1, kind: 'turn', ignorable: true, status: 'completed', userSeq: 0, iterations: 1, modelCalls: 1 },
    { seq: 2, kind: 'todoWrite', ignorable: true, userSeq: 0, items: [] },
  ]), { code: 'session_todo_event_invalid' }, 'a completed turn cannot gain another todo snapshot');
});

test('without a Session plugin registration exposes only catalog metadata and execution fails explicitly', async () => {
  const kernel = createKernel({ policy: createDecisionChain({ mode: 'auto' }) });
  const assembly = loadAssembly(kernel, [createTodoWritePlugin()]);
  try {
    assert.equal(kernel.catalog().find((entry) => entry.name === 'todo_write')?.access, 'read');
    const error = await kernel.call('todo_write', { items: [] }).catch((caught) => caught) as { code: string };
    assert.equal(error.code, 'todo_session_unavailable');
  } finally { assembly.dispose(); }
});

test('separate parent and child Session kernels keep todo snapshots in their own records', async () => {
  await withDirectory(async (directory) => {
    const parent = runtime(directory, 'todo-parent');
    const child = runtime(directory, 'todo-parent.sub-1');
    try {
      const parentUser = await parent.session.append({ kind: 'user', text: 'Parent task' });
      const childUser = await child.session.append({ kind: 'user', text: 'Child task' });
      await parent.kernel.call('todo_write', { items: [{ content: 'Parent item', status: 'pending' }] });
      await child.kernel.call('todo_write', { items: [{ content: 'Child item', status: 'in_progress' }] });

      const parentEvents = await parent.session.read();
      const childEvents = await child.session.read();
      assert.deepEqual(currentTodoSnapshot(parentEvents), {
        userSeq: parentUser.seq, items: [{ content: 'Parent item', status: 'pending' }],
      });
      assert.deepEqual(currentTodoSnapshot(childEvents), {
        userSeq: childUser.seq, items: [{ content: 'Child item', status: 'in_progress' }],
      });
      assert.equal(parentEvents.some((event) => event.kind === 'todoWrite' && (event.items as { content: string }[])[0]?.content === 'Child item'), false);
      assert.equal(childEvents.some((event) => event.kind === 'todoWrite' && (event.items as { content: string }[])[0]?.content === 'Parent item'), false);
    } finally {
      await child.close();
      await parent.close();
    }
  });
});

test('a cancelled call does not persist a todo snapshot', async () => {
  await withDirectory(async (directory) => {
    const instance = runtime(directory, 'todo-cancel');
    try {
      await instance.session.append({ kind: 'user', text: 'Cancelled turn' });
      const controller = new AbortController();
      controller.abort();
      const error = await instance.kernel.call('todo_write', {
        items: [{ content: 'Do not write', status: 'pending' }],
      }, { signal: controller.signal }).catch((caught) => caught) as { code: string };
      assert.equal(error.code, 'loop_cancelled');
      assert.equal((await instance.session.read()).filter((event) => event.kind === 'todoWrite').length, 0);
    } finally { await instance.close(); }
  });
});
