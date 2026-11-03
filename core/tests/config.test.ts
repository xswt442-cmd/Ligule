import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, KernelError } from '../dist/index.js';

test('the policy semantics marker is taken from the layer that supplies the mode', () => {
  // 上层只写档位、下层写着档位和语义标记：合并后必须按供值那一层的语义解释，
  // 否则新的 `never` 会被旧的 `ask` 读法抹平，或者旧值被当成新语义。
  const inherited = createConfig({
    user: { policy: { mode: 'never', semantics: 2 } },
    project: { policy: { mode: 'ask' } },
  }) as { policy: { mode?: string; semantics?: unknown } };
  assert.equal(inherited.policy.mode, 'ask');
  assert.equal(inherited.policy.semantics, undefined);
  const supplied = createConfig({
    user: { policy: { mode: 'ask' } },
    project: { policy: { mode: 'never', semantics: 2 } },
  }) as { policy: { mode?: string; semantics?: unknown } };
  assert.equal(supplied.policy.mode, 'never');
  assert.equal(supplied.policy.semantics, 2);
});

test('a key written in two layers is taken from the higher-precedence one', () => {
  const config = createConfig({
    user: { mode: 'user', keep: 1 },
    managed: { mode: 'managed' },
  });
  assert.deepEqual(config, { mode: 'managed', keep: 1 });
});

test('the five layers fold in the order user, project, local, flag, managed', () => {
  const config = createConfig({
    user: { mode: 1 },
    project: { mode: 2 },
    local: { mode: 3 },
    flag: { mode: 4 },
    managed: { mode: 5 },
  });
  assert.equal(config.mode, 5);
});

test('policy rules override by exact tool and match while unrelated lower-layer rules remain effective', () => {
  const config = createConfig({
    user: { policy: { rules: [
      { tool: 'mcp:playwright/browser_navigate', decision: 'allow' },
      { tool: 'exec', match: 'git status*', decision: 'deny' },
      { tool: 'read', decision: 'allow' },
    ] } },
    project: { policy: { rules: [
      { tool: 'mcp:playwright/browser_navigate', decision: 'deny' },
      { tool: 'exec', match: 'git status*', decision: 'allow' },
      { tool: 'exec', match: 'pnpm install*', decision: 'deny' },
    ] } },
    local: { policy: { rules: [
      { tool: 'mcp:playwright/browser_navigate', decision: 'allow' },
    ] } },
  });

  assert.deepEqual((config.policy as { rules: unknown }).rules, [
    { tool: 'mcp:playwright/browser_navigate', decision: 'allow' },
    { tool: 'exec', match: 'git status*', decision: 'allow' },
    { tool: 'exec', match: 'pnpm install*', decision: 'deny' },
    { tool: 'read', decision: 'allow' },
  ]);
});

test('a deny wins duplicate policy rules in the same layer regardless of array order', () => {
  const config = createConfig({ user: { policy: { rules: [
    { tool: 'mcp:playwright/browser_navigate', decision: 'allow' },
    { tool: 'mcp:playwright/browser_navigate', decision: 'deny' },
  ] } } });

  assert.deepEqual((config.policy as { rules: unknown }).rules, [
    { tool: 'mcp:playwright/browser_navigate', decision: 'deny' },
  ]);
});

test('nested objects merge key by key while arrays replace the whole list', () => {
  const config = createConfig({
    user: { sandbox: { network: 'on', paths: ['a', 'b'] }, allow: ['read'] },
    project: { sandbox: { network: 'off' } },
    local: { allow: ['read', 'write'] },
  });
  assert.deepEqual(config.sandbox, { network: 'off', paths: ['a', 'b'] });
  assert.deepEqual(config.allow, ['read', 'write']);
});

test('the snapshot is read all the way down', () => {
  const config = createConfig({ user: { sandbox: { network: 'on' } }, project: { allow: ['read'] } });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.sandbox));
  assert.ok(Object.isFrozen(config.allow));
  assert.throws(() => {
    (config as Record<string, unknown>).sandbox = {};
  }, TypeError);
});

// 项目配置是不可信输入。TOML 中的 `["__proto__"]` 是普通键，合并时不能把它写入对象原型。
test('a __proto__ key in a layer is refused instead of polluting every object', () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": 1}}');
  assert.throws(() => createConfig({ user: hostile }), (error: unknown) => error instanceof KernelError && error.code === 'config_key_unsafe');
  assert.equal(({} as { polluted?: unknown }).polluted, undefined, 'nothing reached Object.prototype');
});

// TOML 日期时间会解析为对象而不是普通表；合并配置时必须保留该值，不能递归展开并丢失它。
test('a datetime in a higher layer replaces the lower one instead of merging away', () => {
  const snapshot = createConfig({
    user: { when: new Date('1979-05-27T07:32:00Z'), keep: new Date('2000-01-01T00:00:00Z') },
    project: { when: new Date('2026-10-01T00:00:00Z') },
  });
  assert.equal((snapshot.when as Date).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal((snapshot.keep as Date).toISOString(), '2000-01-01T00:00:00.000Z', 'a lower layer value still survives on its own');
});

test('the snapshot does not share references with the layer objects', () => {
  const layer = { sandbox: { network: 'on' }, allow: ['read'] };
  const config = createConfig({ user: layer });
  layer.sandbox.network = 'off';
  layer.allow.push('write');
  assert.deepEqual(config.sandbox, { network: 'on' });
  assert.deepEqual(config.allow, ['read']);
});

test('an unknown layer name or a layer that is not an object fails at once', () => {
  assert.throws(
    () => createConfig({ managd: { mode: 1 } }),
    (error) => error instanceof KernelError && error.code === 'config_layer_unknown',
  );
  assert.throws(
    () => createConfig({ user: ['mode', 'x'] }),
    (error: unknown) => error instanceof KernelError && error.code === 'config_layer_must_be_object',
  );
  assert.throws(() => createConfig('user'), (error: unknown) => error instanceof KernelError && error.code === 'config_layers_must_be_object');
});
