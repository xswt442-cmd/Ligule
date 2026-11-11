import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createConfig, createDecisionChain, createKernel, createPermissionContext, createSessionLog, KernelError, minimalTools,
} from '../dist/index.js';
import type { ToolDefinition } from '../dist/kernel/kernel.js';
import type { Logger } from '../dist/kernel/log.js';
import type { ProviderDiagnostic } from '../dist/kernel/error.js';

const toolFailurePermission = createPermissionContext('workspace-write', 'policy', {
  filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
});

type ToolResultRecord = { kind?: string; code?: string; content?: string; failed?: boolean };

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  main: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: string }).code === code;
}

function hasDetail(error: unknown, text: string): boolean {
  return error instanceof Error && ((error as { detail?: string }).detail ?? '').includes(text);
}

function makeTool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `the ${name} tool`,
    access: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async () => 'ok',
    ...overrides,
  };
}

function kernelWith(...names: string[]) {
  const kernel = createKernel();
  for (const name of names) kernel.register(makeTool(name));
  return kernel;
}

test('a fresh kernel provides no tools and an empty model-visible manifest', () => {
  const kernel = createKernel();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(kernel.manifest(), []);
});

test('register shows up in list and returns a dispose action', () => {
  const kernel = createKernel();
  const dispose = kernel.register(makeTool('read'));
  assert.deepEqual(kernel.list(), ['read']);
  dispose();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(kernel.manifest(), []);
});

test('the local tool catalog reports registered metadata without applying mode or permission filters', () => {
  const kernel = createKernel();
  kernel.register(makeTool('read'));
  kernel.register(makeTool('write', { access: 'write' }));

  assert.deepEqual(kernel.catalog(), [
    { name: 'read', description: 'the read tool', access: 'read', disclosure: false },
    { name: 'write', description: 'the write tool', access: 'write', disclosure: false },
  ]);
  assert.deepEqual(kernel.manifest().map(({ name }) => name), ['read'], 'the model manifest still filters writes under the default read-only context');
  const undo = kernel.restrict(['read']);
  assert.deepEqual(kernel.catalog().map(({ name }) => name), ['read', 'write'], 'the inspected registry stays intact while a mode restricts the model manifest');
  assert.deepEqual(kernel.manifest(), []);
  undo();
});

test('a duplicate name throws instead of dropping the second one silently', () => {
  const kernel = createKernel();
  kernel.register(makeTool('read'));
  assert.throws(
    () => kernel.register(makeTool('read')),
    (error: unknown) => error instanceof KernelError && error.code === 'tool_already_registered',
  );
  assert.deepEqual(kernel.list(), ['read']);
});

test('registration rejects a missing or empty required field with a code', () => {
  const kernel = createKernel();
  assert.throws(() => kernel.register(makeTool('')), (error: unknown) => hasCode(error, 'tool_name_required'));
  assert.throws(
    () => kernel.register(makeTool('read', { description: '' })),
    (error: unknown) => hasCode(error, 'tool_description_required'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', { run: 'nope' } as unknown as Partial<ToolDefinition>)),
    (error: unknown) => hasCode(error, 'tool_run_required'),
  );
  assert.deepEqual(kernel.list(), []);
});

test('a parameter schema whose top level is a scalar fails at registration', () => {
  const kernel = createKernel();
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: { type: 'string' } })),
    (error: unknown) => hasCode(error, 'tool_parameters_type_not_object'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: [] } as unknown as Partial<ToolDefinition>)),
    (error: unknown) => hasCode(error, 'tool_parameters_must_be_object'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: undefined })),
    (error: unknown) => hasCode(error, 'tool_parameters_must_be_object'),
  );
});

test('a parameter schema that cannot round-trip as JSON fails at registration', () => {
  const kernel = createKernel();
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: { type: 'object', extra: () => 1 } })),
    (error: unknown) => hasCode(error, 'tool_parameters_not_serializable'),
  );
});

test('a parameter schema outside the supported subset fails at registration and lists every violation', () => {
  const kernel = createKernel();
  assert.throws(() => kernel.register(makeTool('read', {
    parameters: { type: 'object', properties: { path: { type: 'string', pattern: '^a' } } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'path.pattern'));
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: 'path' },
    })),
    (error: unknown) => hasDetail(error, 'required must be an array of strings'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: { type: 'object', properties: {}, required: ['path'] } })),
    (error: unknown) => hasDetail(error, 'required names "path" which is not in properties'),
  );
  // 上下界必须是数值；字符串形式无法用于内核校验。
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { path: { type: 'string', minimum: 1 } } },
    })),
    (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'path.minimum needs type integer or number'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { n: { type: 'number', maximum: Number.NaN } } },
    })),
    (error: unknown) => hasDetail(error, 'n.maximum must be a finite number'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 10, maximum: 1 } } },
    })),
    (error: unknown) => hasDetail(error, 'n has minimum above maximum'),
  );
  assert.deepEqual(kernel.list(), []);
});

test('nested parameter schemas validate objects, string arrays, enums, anyOf, and closed objects', async () => {
  const kernel = createKernel();
  kernel.register(makeTool('delegate', {
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        mode: {
          type: 'object',
          properties: {
            strategy: { type: 'string', enum: ['fast', 'safe'] },
            tools: { type: 'array', items: { type: 'string' } },
            limits: {
              type: 'object',
              properties: { depth: { type: 'integer', minimum: 0, maximum: 4 } },
              required: ['depth'],
              additionalProperties: false,
            },
          },
          required: ['strategy', 'tools', 'limits'],
          additionalProperties: false,
        },
        result: {
          anyOf: [
            { type: 'string' },
            { type: 'integer', minimum: 1, maximum: 5 },
          ],
        },
      },
      required: ['task', 'mode', 'result'],
    },
  }));

  const valid = {
    task: 'inspect',
    mode: { strategy: 'safe', tools: ['read', 'search'], limits: { depth: 2 } },
    result: 3,
  };
  assert.equal(await kernel.call('delegate', valid), 'ok');
  await assert.rejects(kernel.call('delegate', { ...valid, mode: { ...valid.mode, strategy: 'unsafe' } }), { code: 'tool_args_invalid' });
  await assert.rejects(kernel.call('delegate', { ...valid, mode: { ...valid.mode, tools: ['read', 3] } }), { code: 'tool_args_invalid' });
  await assert.rejects(kernel.call('delegate', { ...valid, mode: { ...valid.mode, unexpected: true } }), { code: 'tool_args_invalid' });
  await assert.rejects(kernel.call('delegate', { ...valid, mode: { ...valid.mode, limits: {} } }), { code: 'tool_args_invalid' });
  await assert.rejects(kernel.call('delegate', { ...valid, mode: { ...valid.mode, limits: { depth: 5 } } }), { code: 'tool_args_invalid' });
  await assert.rejects(kernel.call('delegate', { ...valid, result: false }), { code: 'tool_args_invalid' });
});

test('root object anyOf validates mutually exclusive tool argument forms before execution', async () => {
  const kernel = createKernel();
  let calls = 0;
  kernel.register(makeTool('edit-form', {
    parameters: {
      type: 'object',
      anyOf: [
        {
          type: 'object',
          properties: {
            path: { type: 'string' },
            anchor: { type: 'string' },
            replacement: { type: 'string' },
          },
          required: ['path', 'anchor', 'replacement'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            path: { type: 'string' },
            changes: { type: 'array', items: { type: 'object', properties: {
              oldText: { type: 'string' }, newText: { type: 'string' },
            }, required: ['oldText', 'newText'], additionalProperties: false } },
          },
          required: ['path', 'changes'],
          additionalProperties: false,
        },
      ],
    },
    run: async () => { calls += 1; return 'accepted'; },
  }));

  assert.equal(await kernel.call('edit-form', { path: 'a.txt', anchor: 'old', replacement: 'new' }), 'accepted');
  assert.equal(await kernel.call('edit-form', { path: 'a.txt', changes: [{ oldText: 'old', newText: 'new' }] }), 'accepted');
  for (const args of [
    { path: 'a.txt' },
    { path: 'a.txt', anchor: 'old' },
    { path: 'a.txt', anchor: 'old', replacement: 'new', changes: [{ oldText: 'old', newText: 'new' }] },
    { path: 'a.txt', changes: [{ oldText: 'old', newText: 'new', extra: true }] },
  ]) await assert.rejects(kernel.call('edit-form', args), { code: 'tool_args_invalid' });
  assert.equal(calls, 2, 'invalid form combinations are rejected before tool execution');
});

test('an outer object type remains enforced before nested anyOf alternatives', async () => {
  const kernel = createKernel();
  let calls = 0;
  kernel.register(makeTool('typed-union', {
    parameters: {
      type: 'object',
      properties: {
        value: {
          type: 'object',
          anyOf: [
            { type: 'string' },
            { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          ],
        },
      },
      required: ['value'],
    },
    run: async () => { calls += 1; return 'accepted'; },
  }));

  await assert.rejects(kernel.call('typed-union', { value: 'must remain an object' }), { code: 'tool_args_invalid' });
  assert.equal(await kernel.call('typed-union', { value: { ok: true } }), 'accepted');
  assert.equal(calls, 1, 'the outer type constraint is enforced before anyOf can accept another type');
});

test('bounded object arrays validate every item before tool execution', async () => {
  const kernel = createKernel();
  let calls = 0;
  kernel.register(makeTool('array-input', {
    parameters: { type: 'object', properties: {
      items: { type: 'array', minItems: 1, maxItems: 2, items: {
        type: 'object', additionalProperties: false, required: ['content', 'status'], properties: {
          content: { type: 'string', minLength: 1, maxLength: 10 },
          status: { type: 'string', enum: ['pending', 'completed'] },
        },
      } },
    }, required: ['items'] },
    run: async () => { calls += 1; return 'accepted'; },
  }));
  assert.equal(await kernel.call('array-input', { items: [{ content: 'task', status: 'pending' }] }), 'accepted');
  for (const items of [[], Array(3).fill({ content: 'task', status: 'pending' }), [null],
    [{ content: 'task' }], [{ content: 'task', status: 'invalid' }],
    [{ content: 'task', status: 'pending', extra: true }]]) {
    await assert.rejects(kernel.call('array-input', { items }), { code: 'tool_args_invalid' });
  }
  assert.equal(calls, 1);
  for (const array of [
    { type: 'string', maxItems: 1 }, { type: 'array', maxItems: -1, items: { type: 'object' } },
    { type: 'array', minItems: 3, maxItems: 2, items: { type: 'string' } },
  ]) {
    assert.throws(() => kernel.register(makeTool('invalid-array', {
      parameters: { type: 'object', properties: { items: array } },
    })), { code: 'tool_parameters_unsupported_construct' });
  }
});

test('nested schemas reject unsupported constructs and nesting beyond the supported depth', () => {
  const kernel = createKernel();
  assert.throws(() => kernel.register(makeTool('delegate', {
    parameters: { type: 'object', properties: { tags: { type: 'array', items: { type: 'null' } } } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'tags.items.type'));
  assert.throws(() => kernel.register(makeTool('delegate', {
    parameters: { type: 'object', properties: { value: { anyOf: [] } } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'value.anyOf'));
  assert.throws(() => kernel.register(makeTool('delegate', {
    parameters: { type: 'object', properties: { value: { type: 'string', anyOf: [{ type: 'string' }] } } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'value.anyOf cannot be combined'));
  assert.throws(() => kernel.register(makeTool('delegate', {
    parameters: { type: 'object', properties: { value: { type: 'object', additionalProperties: true } } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'value.additionalProperties'));

  let schema: Record<string, unknown> = { type: 'string' };
  for (let depth = 0; depth < 9; depth += 1) {
    schema = { type: 'object', properties: { nested: schema } };
  }
  assert.throws(() => kernel.register(makeTool('delegate', {
    parameters: { type: 'object', properties: { value: schema } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'maximum schema depth'));
});

test('string length bounds are checked as Unicode characters and invalid bounds fail registration', async () => {
  const kernel = createKernel();
  kernel.register(makeTool('label', {
    parameters: { type: 'object', properties: { value: { type: 'string', minLength: 2, maxLength: 3 } }, required: ['value'] },
  }));
  assert.equal(await kernel.call('label', { value: '猫a' }), 'ok');
  await assert.rejects(kernel.call('label', { value: 'a' }), { code: 'tool_args_invalid' });
  await assert.rejects(kernel.call('label', { value: '猫猫猫猫' }), { code: 'tool_args_invalid' });

  assert.throws(() => createKernel().register(makeTool('label', {
    parameters: { type: 'object', properties: { value: { type: 'integer', maxLength: 3 } } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'maxLength needs type string'));
  assert.throws(() => createKernel().register(makeTool('label', {
    parameters: { type: 'object', properties: { value: { type: 'string', minLength: 4, maxLength: 3 } } },
  })), (error: unknown) => hasCode(error, 'tool_parameters_unsupported_construct') && hasDetail(error, 'minLength above maxLength'));
});

test('a numeric bound on a numeric parameter registers and is enforced per call', async () => {
  const kernel = createKernel();
  kernel.register(makeTool('read', { parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['n'] } }));
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
  await assert.rejects(() => kernel.call('read', { n: 0 }), (error: unknown) => hasCode(error, 'tool_args_invalid'));
  await assert.rejects(() => kernel.call('read', { n: 4 }), (error: unknown) => hasCode(error, 'tool_args_invalid'));
  assert.equal(await kernel.call('read', { n: 2 }), 'ok');
});

test('the default read-only permission denies writes and tools without a classified access', async () => {
  const kernel = createKernel();
  kernel.register(makeTool('write', { access: 'write', parameters: { type: 'object', properties: {} } }));
  kernel.register(makeTool('unclassified', { access: undefined, parameters: { type: 'object', properties: {} } }));

  assert.deepEqual(kernel.manifest(), []);
  await assert.rejects(
    kernel.call('write', {}),
    (error: unknown) => hasCode(error, 'permission_read_only'),
  );
  await assert.rejects(
    kernel.call('unclassified', {}),
    (error: unknown) => hasCode(error, 'permission_external_access_requires_full_access'),
  );
});

test('a call whose arguments do not match the schema fails before the decision chain and is recorded', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    const session = createSessionLog({ directory: root, id: 'args' });
    const asked: unknown[] = [];
    const kernel = createKernel({
      policy: createDecisionChain({ ask: async (call) => { asked.push(call); return true; } }),
      session,
    });
    kernel.register(makeTool('read'));
    await assert.rejects(kernel.call('read', { path: 7 }), (error: unknown) => hasCode(error, 'tool_args_invalid'));
    await assert.rejects(kernel.call('read', {}), (error: unknown) => hasCode(error, 'tool_args_invalid'));
    assert.equal(asked.length, 0, 'a malformed call never reaches the user');
    const events = await session.read();
    assert.deepEqual(events.map((event) => [(event.result as ToolResultRecord).kind, (event.result as ToolResultRecord).code]), [
      ['failure', 'tool_args_invalid'],
      ['failure', 'tool_args_invalid'],
    ]);
    assert.deepEqual(events.map((event) => (event.result as ToolResultRecord).content), [
      '"path" must be a string',
      'missing required property "path"',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 工具执行耗时写在事件外层，并从策略允许执行后开始计时，不包含等待用户审批的时间。
test('a tool record carries how long the tool ran, and approval waiting is not in it', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    const wait = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const session = createSessionLog({ directory: root, id: 'timed' });
    const kernel = createKernel({
      // 答复之前先等 250 毫秒，而工具自己什么都不做：那一段等待不该进这一格。
      policy: createDecisionChain({ mode: 'ask', ask: async () => { await wait(250); return true; } }),
      session,
    });
    kernel.register(makeTool('read'));
    assert.equal(await kernel.call('read', { path: 'note.txt' }), 'ok');
    const [ran] = await session.read();
    const durationMs = ran.durationMs as number;
    assert.ok(Number.isInteger(durationMs), `那一格是整数毫秒，读到的是 ${durationMs}`);
    assert.ok(durationMs >= 0 && durationMs < 200, `只算这一次执行，读到的是 ${durationMs}`);
    // 该字段不进入模型可见投影；投影只包含事件类型对应的固定字段。
    assert.ok(!(JSON.stringify(await session.modelView())).includes('durationMs'));

    // 没执行的调用没有这一格：规则拒绝的那一条根本没跑起来。
    const refusedSession = createSessionLog({ directory: root, id: 'refused' });
    const strict = createKernel({
      policy: createDecisionChain({ mode: 'ask', rules: [{ tool: 'read', decision: 'deny' }], ask: async () => true }),
      session: refusedSession,
    });
    strict.register(makeTool('read'));
    await assert.rejects(strict.call('read', { path: 'note.txt' }), (error: unknown) => hasCode(error, 'policy_denied'));
    const [refused] = await refusedSession.read();
    assert.equal(refused.durationMs, undefined, '拒绝的那一条不记执行耗时');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a numeric bound in the schema is enforced on every call', async () => {
  const kernel = createKernel();
  kernel.register(makeTool('read', {
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offsetBytes: { type: 'integer', minimum: 0 } },
      required: ['path'],
    },
  }));
  assert.equal(await kernel.call('read', { path: 'note.txt', offsetBytes: 0 }), 'ok');
  await assert.rejects(
    kernel.call('read', { path: 'note.txt', offsetBytes: -1 }),
    (error: unknown) => hasCode(error, 'tool_args_invalid') && (error as { detail?: string }).detail === '"offsetBytes" must be at least 0',
  );
});

test('an unwrapped error from a tool becomes a stable code, keeps its cause, and is recorded as a failure', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    const session = createSessionLog({ directory: root, id: 'raw' });
    const kernel = createKernel({ session });
    const original = new TypeError('cannot read properties of undefined');
    kernel.register(makeTool('half-baked', {
      parameters: { type: 'object', properties: {} },
      run: async () => {
        throw original;
      },
    }));
    await assert.rejects(
      kernel.call('half-baked', {}),
      (error: unknown) => error instanceof KernelError && hasCode(error, 'tool_failed') && error.cause === original,
    );
    const [event] = await session.read();
    assert.deepEqual([(event.result as ToolResultRecord).kind, (event.result as ToolResultRecord).code, (event.result as ToolResultRecord).content], [
      'failure',
      'tool_failed',
      'cannot read properties of undefined',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the manifest carries exactly the three model-visible fields', () => {
  const kernel = createKernel();
  kernel.register(makeTool('read', { timeoutMs: 5000, output: { render: () => '' } } as unknown as Partial<ToolDefinition>));
  assert.deepEqual(kernel.manifest(), [
    {
      name: 'read',
      description: 'the read tool',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ]);
});

test('the manifest is detached from the object the plugin registered', () => {
  const kernel = createKernel();
  const parameters = { type: 'object', properties: {} as Record<string, { type: string }> };
  kernel.register(makeTool('read', { parameters }));
  parameters.properties.suffix = { type: 'string' };
  assert.deepEqual(kernel.manifest()[0].parameters.properties, {});
  (kernel.manifest()[0] as { description: string }).description = 'edited by the caller';
  assert.equal(kernel.manifest()[0].description, 'the read tool');
});

test('a restricted tool leaves the manifest but stays registered, and calling it is denied', async () => {
  const kernel = kernelWith('read', 'search');
  const lift = kernel.restrict(['read']);
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['search']);
  assert.deepEqual(kernel.list(), ['read', 'search']);
  await assert.rejects(
    kernel.call('read', {}),
    (error: unknown) => hasCode(error, 'tool_denied'),
  );
  lift();
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read', 'search']);
});

test('a restriction applies by name, including to a tool registered after it', () => {
  const kernel = kernelWith('read');
  kernel.restrict(['web_fetch']);
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
  kernel.register(makeTool('web_fetch'));
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
});

test('disposing one restriction leaves an overlapping one in force', () => {
  const kernel = kernelWith('read');
  const first = kernel.restrict(['read']);
  const second = kernel.restrict(['read', 'search']);
  first();
  assert.deepEqual(kernel.manifest(), []);
  second();
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
});

test('a stale dispose action leaves a tool registered again under the same name', () => {
  const kernel = createKernel();
  const first = kernel.register(makeTool('read'));
  first();
  kernel.register(makeTool('read'));
  first();
  assert.deepEqual(kernel.list(), ['read']);
});

test('calling a restriction disposer twice does not lift another restriction', () => {
  const kernel = kernelWith('read', 'search');
  kernel.restrict(['read']);
  const liftSearch = kernel.restrict(['search']);
  liftSearch();
  liftSearch();
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['search']);
});

test('calling an unregistered tool rejects with a code', async () => {
  await assert.rejects(
    createKernel().call('nope'),
    (error: unknown) => hasCode(error, 'tool_not_found'),
  );
});

// 助手那一轮已经带着这次调用，记录里必须有一条结果跟它的 id 对上，否则下一次请求体里那个调用悬空。
// 错误码是给宿主分支的，`content` 才是模型看见的那一份：一个空的失败结果等于什么也没告诉它。
test('every tool failure leaves the model a sentence to act on', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    await writeFile(join(root, 'note.txt'), 'seed content\n');
    const session = createSessionLog({ directory: root, id: 'messages' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), permission: toolFailurePermission, session });
    for (const tool of minimalTools) kernel.register(tool);
    const failures: [string, Record<string, unknown>][] = [
      ['read', { path: 'missing.txt' }],
      ['find', { pattern: '*', path: 'missing.txt' }],
      ['search', { pattern: 'x', path: 'missing.txt' }],
      ['create', { path: 'note.txt', content: 'a' }],
      ['write', { path: 'note.txt', content: 'b' }],
      ['edit', { path: 'note.txt', anchor: '   ', replacement: 'x' }],
      ['edit', { path: 'note.txt', anchor: 'absent anchor', replacement: 'x' }],
      ['delete', { path: '.' }],
      ['exec', { command: '   ' }],
    ];
    for (const [name, args] of failures) {
      await assert.rejects(() => kernel.call(name, args), `${name} should have refused ${JSON.stringify(args)}`);
    }
    const refused = (await session.read()).filter((event) => (event.result as ToolResultRecord | undefined)?.failed);
    assert.equal(refused.length, failures.length, 'each refusal left exactly one failure event');
    for (const event of refused) {
      const result = event.result as ToolResultRecord;
      assert.ok(typeof result.content === 'string' && result.content !== '', `${event.tool} / ${result.code} says nothing to the model`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a call naming a tool that is not registered is recorded against its call id', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    const session = createSessionLog({ directory: root, id: 'missing' });
    const kernel = createKernel({ session });
    await assert.rejects(kernel.call('nope', {}, { callId: 'call_9' }), (error: unknown) => hasCode(error, 'tool_not_found'));
    const events = await session.read();
    assert.deepEqual(events.map((event) => [event.kind, event.callId, (event.result as ToolResultRecord).kind, (event.result as ToolResultRecord).code]), [
      ['tool', 'call_9', 'failure', 'tool_not_found'],
    ]);
    assert.deepEqual(await session.modelView(), [
      { role: 'tool', id: 'call_9', tool: 'nope', content: 'no tool named "nope" is registered for this run', failed: true, code: 'tool_not_found' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tool reads the configuration snapshot and the logger from the context it is called with', async () => {
  const seen: unknown[] = [];
  const kernel = createKernel({
    config: createConfig({ user: { sandbox: { network: 'on' } } }),
    logger: {
      debug: () => {},
      log: (message) => seen.push(message),
    },
  });
  kernel.register(makeTool('read', {
    run: async (args, context) => {
      context.logger.log('reading');
      return (context.config.sandbox as Record<string, unknown>).network;
    },
  }));
  assert.equal(await kernel.call('read', { path: 'note.txt' }), 'on');
  assert.deepEqual(seen, ['reading']);
});

test('a fresh kernel hands tools an empty read-only snapshot and a silent logger', async () => {
  let snapshot!: unknown;
  let logger!: Logger;
  const kernel = createKernel();
  kernel.register(makeTool('read', {
    run: async (args, context) => {
      snapshot = context.config;
      logger = context.logger;
      return 'ok';
    },
  }));
  await kernel.call('read', { path: 'note.txt' });
  assert.deepEqual(snapshot, {});
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(Object.keys(logger).sort(), ['debug', 'error', 'log']);
});

test('a configuration object that is not a folded snapshot is rejected', () => {
  assert.throws(
    () => createKernel({ config: { mode: 'x' } }),
    (error: unknown) => hasCode(error, 'config_snapshot_must_be_frozen'),
  );
});

test('product manifests carry independent release versions while Core stays private', () => {
  const tui = JSON.parse(readFileSync(new URL('../../tui/package.json', import.meta.url), 'utf8')) as PackageManifest;
  const core = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest;
  const desktop = JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8')) as PackageManifest;
  const frontend = JSON.parse(readFileSync(new URL('../../desktop/frontend/package.json', import.meta.url), 'utf8')) as PackageManifest;
  assert.equal(core.name, '@ligule/core');
  assert.equal(core.private, true);
  assert.equal(Object.hasOwn(core, 'version'), false);
  for (const [name, manifest] of [['tui', tui], ['desktop', desktop], ['frontend', frontend]] as [string, PackageManifest][]) {
    assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, `${name} version must be stable X.Y.Z`);
  }
  assert.equal(tui.name, 'ligule');
  assert.equal(desktop.name, 'ligule-desktop');
  assert.equal(desktop.private, true);
  assert.equal(frontend.private, true);
  assert.equal(desktop.main, 'electron/dist/main.js');
  assert.equal(desktop.scripts.build, 'node ./build.mjs');
  assert.equal(core.dependencies['@vscode/ripgrep'], '1.18.0');
});

// 诊断文案是 Desktop/TUI/Host 共用的一份，分类、校验和一行摘要都在这里钉住。
test('provider diagnostics share one category table and one summary', async () => {
  const { parseProviderDiagnostic, providerDiagnosticText, PROVIDER_DIAGNOSTIC_CATEGORIES } = await import('../dist/kernel/error.js');
  assert.deepEqual(PROVIDER_DIAGNOSTIC_CATEGORIES.server, ['服务端故障', 'server failure']);

  const parsed = parseProviderDiagnostic({
    category: 'server', status: 503, attempts: 3, responseReceived: true, streamReceived: false, recoverable: true,
  });
  assert.deepEqual(parsed, {
    category: 'server', status: 503, attempts: 3, responseReceived: true, streamReceived: false, recoverable: true,
  });
  assert.deepEqual(providerDiagnosticText(parsed as ProviderDiagnostic), {
    zh: 'HTTP 503 · 服务端故障 · 尝试 3 次 · 收到响应 · 未收到响应流 · 可恢复',
    en: 'HTTP 503 · server failure · 3 attempts · response received · no stream data · recoverable',
  });

  assert.equal(parseProviderDiagnostic({ category: 'unknown', attempts: 1, responseReceived: true, streamReceived: true, recoverable: true }), undefined);
  assert.equal(parseProviderDiagnostic({ category: 'server', status: 99, attempts: 1, responseReceived: true, streamReceived: true, recoverable: true }), undefined);
  assert.equal(parseProviderDiagnostic(null), undefined);

  const withoutStatus = parseProviderDiagnostic({ category: 'transport', attempts: 1, responseReceived: false, streamReceived: false, recoverable: false });
  assert.equal(providerDiagnosticText(withoutStatus as ProviderDiagnostic).zh, 'HTTP 状态未知 · 传输故障 · 尝试 1 次 · 未收到响应 · 未收到响应流 · 不可安全重试');
});
