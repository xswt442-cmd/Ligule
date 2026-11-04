// 历史审批档位（`none` / 旧 `never`）必须按旧语义读取：它们不会变成新的“跳过审批”。
// 只有写入方显式带上语义标记的记录，才按新四档解释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { POLICY_SEMANTICS, readPersistedPolicyMode } from '../dist/kernel/policy.js';
import { parseSessionEvents, readPolicyOverride } from '../dist/session/format.js';
import { configVersion, writeConfigField } from '../dist/kernel/config-edit.js';

const policyEvent = (override: unknown, extra: Record<string, unknown> = {}) => ({
  seq: 1, kind: 'sessionPolicy', ignorable: true, override, consecutive: 0, total: 0, forcedToAsk: false, ...extra,
});

function record(events: unknown[]): unknown[] {
  return [{ kind: 'session', formatVersion: 2, sessionId: 'legacy', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' }, ...events];
}

test('legacy policy values are read as ask and never turn into the new skip approval tier', () => {
  assert.equal(POLICY_SEMANTICS, 2);
  // 没有语义标记：历史 `none` 与历史 `never` 都只降级到 `ask`。
  assert.equal(readPersistedPolicyMode('none', undefined), 'ask');
  assert.equal(readPersistedPolicyMode('never', undefined), 'ask');
  assert.equal(readPersistedPolicyMode('ask', undefined), 'ask');
  assert.equal(readPersistedPolicyMode('auto', undefined), 'auto');
  // 带标记：只有新四档合法，历史字面值被拒绝而不是猜测。
  assert.equal(readPersistedPolicyMode('never', POLICY_SEMANTICS), 'never');
  assert.equal(readPersistedPolicyMode('always', POLICY_SEMANTICS), 'always');
  assert.equal(readPersistedPolicyMode('none', POLICY_SEMANTICS), undefined);
  assert.equal(readPersistedPolicyMode('yolo', POLICY_SEMANTICS), undefined);
  // 其他语义版本不认识就拒绝，不按当前版本猜。
  assert.equal(readPersistedPolicyMode('never', 3), undefined);
  assert.equal(readPersistedPolicyMode('ask', '2'), undefined);
});

test('the session record reader keeps old events in their old meaning and reads marked events as the new tiers', () => {
  assert.equal(readPolicyOverride(null, undefined), null);
  assert.equal(readPolicyOverride('none', undefined), 'ask');
  assert.equal(readPolicyOverride('never', undefined), 'ask');
  assert.equal(readPolicyOverride('always', undefined), 'unknown', '没有标记的 always 不是历史值，必须拒绝');
  assert.equal(readPolicyOverride('never', POLICY_SEMANTICS), 'never');
  assert.equal(readPolicyOverride('none', POLICY_SEMANTICS), 'unknown');

  // 读取整份记录时同样按事件自己的语义标记解释。
  const legacy = parseSessionEvents(record([policyEvent('never')]) as never);
  const oldEvent = legacy.events.find((event) => event.kind === 'sessionPolicy')!;
  assert.equal(readPolicyOverride(oldEvent.override, oldEvent.semantics), 'ask');

  const marked = parseSessionEvents(record([policyEvent('never', { semantics: POLICY_SEMANTICS })]) as never);
  const newEvent = marked.events.find((event) => event.kind === 'sessionPolicy')!;
  assert.equal(readPolicyOverride(newEvent.override, newEvent.semantics), 'never');

  assert.throws(() => parseSessionEvents(record([policyEvent('none', { semantics: POLICY_SEMANTICS })]) as never),
    (error: unknown) => (error as { code?: string }).code === 'session_policy_event_invalid');
  assert.throws(() => parseSessionEvents(record([policyEvent('never', { semantics: 3 })]) as never),
    (error: unknown) => (error as { code?: string }).code === 'session_policy_event_invalid');
  assert.throws(() => parseSessionEvents(record([policyEvent('always')]) as never),
    (error: unknown) => (error as { code?: string }).code === 'session_policy_event_invalid');
});

test('config keeps the legacy meaning of an unmarked mode and marks what it writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-policy-migration-'));
  const file = join(directory, 'config.toml');
  try {
    // 旧文件：只有 mode，没有语义标记。读取侧按旧语义解释。
    await writeFile(file, '[policy]\nmode = "never"\n', 'utf8');
    const legacy = parse(await readFile(file, 'utf8')) as { policy: { mode: string; semantics?: number } };
    assert.equal(readPersistedPolicyMode(legacy.policy.mode, legacy.policy.semantics), 'ask');

    // 新写入：同时写出四档值和语义标记，回读后按新语义解释。
    const before = await readFile(file, 'utf8');
    await writeConfigField(file, { field: 'policy.mode', value: 'never', version: configVersion(before) });
    const written = parse(await readFile(file, 'utf8')) as { policy: { mode: string; semantics?: number } };
    assert.equal(written.policy.mode, 'never');
    assert.equal(written.policy.semantics, POLICY_SEMANTICS);
    assert.equal(readPersistedPolicyMode(written.policy.mode, written.policy.semantics), 'never');

    // 历史的 `none` 也不接受再写入。
    const current = configVersion(await readFile(file, 'utf8'));
    await assert.rejects(
      () => writeConfigField(file, { field: 'policy.mode', value: 'none', version: current }),
      (error: unknown) => (error as { code?: string }).code === 'config_field_value',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
