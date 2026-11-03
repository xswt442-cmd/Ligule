// 会话记录首行说明格式版本、所属项目和初始模式清单，
// 而读的时候版本或事件种类读不懂就拒绝重建，不是静默跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionLog } from '../dist/index.js';
import { parseSessionEvents } from '../dist/session/format.js';
import type { SessionEvent } from '../dist/session/format.js';
import { estimateRequest, usageEvent } from '../dist/session/usage.js';

async function withDirectory<TResult>(run: (directory: string) => TResult | Promise<TResult>): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'format-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tool = (seq: number, content: string) => JSON.stringify({ seq, kind: 'tool', tool: 'read', args: {}, result: { content } });

test('a new record starts with a line that names the format, the project and the mode it opened under', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({
      directory,
      id: 'run-1',
      meta: () => ({ projectRoot: '/repo', mode: { name: 'full', layer: 'user' } }),
    });
    const first = await session.append({ kind: 'user', text: 'go' });
    assert.equal(first.seq, 0, '首行不占事件的序号');

    const lines = (await readFile(session.path, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines[0], {
      kind: 'session',
      formatVersion: 2,
      sessionId: 'run-1',
      projectRoot: '/repo',
      createdAt: lines[0].createdAt,
      mode: { name: 'full', layer: 'user' },
    });
    assert.deepEqual(await session.read(), [first], '首行不是一条事件，读回来的仍然只有那一条');
    assert.deepEqual(await session.header(), lines[0]);
  });
});

test('session policy events must be ignorable and contain a valid restore snapshot', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'policy', projectRoot: '' };
  assert.throws(() => parseSessionEvents([
    header,
    { seq: 0, kind: 'sessionPolicy', override: null, consecutive: 0, total: 0, forcedToAsk: false },
  ] as unknown as SessionEvent[]), { code: 'session_policy_ignorable_required' });
  assert.throws(() => parseSessionEvents([
    header,
    { seq: 0, kind: 'sessionPolicy', ignorable: true, override: 'never', consecutive: 3, total: 2, forcedToAsk: true },
  ] as unknown as SessionEvent[]), { code: 'session_policy_event_invalid' });
  const none = { seq: 0, kind: 'sessionPolicy', ignorable: true, override: 'none', consecutive: 0, total: 0, forcedToAsk: false };
  const legacyNever = { seq: 0, kind: 'sessionPolicy', ignorable: true, override: 'never', consecutive: 3, total: 3, forcedToAsk: true };
  assert.equal(parseSessionEvents([header, none] as unknown as SessionEvent[]).events[0].override, 'none');
  assert.equal(parseSessionEvents([header, legacyNever] as unknown as SessionEvent[]).events[0].override, 'never', 'stored legacy never keeps its old identity');
});

test('session MCP trust events are ignorable and validate the server identity', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'mcp-trust', projectRoot: '' };
  const trust = {
    seq: 0, kind: 'sessionMcpTrust', ignorable: true, source: 'trusted-ui', server: 'playwright', identityDigest: 'a'.repeat(64), trusted: true,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(parseSessionEvents([header, trust] as unknown as SessionEvent[]).events[0].kind, 'sessionMcpTrust');
  assert.throws(() => parseSessionEvents([header, { ...trust, identityDigest: 'invalid' }] as unknown as SessionEvent[]), { code: 'session_mcp_trust_event_invalid' });
});

test('compaction events are ignorable and carry the block identity, range and reason', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'compaction', projectRoot: '' };
  const written = { seq: 0, kind: 'compaction', ignorable: true, reason: 'auto', blockId: 1, fromSeq: 0, toSeq: 8, tokensBefore: 3000, tokensAfter: 900 };
  assert.equal(parseSessionEvents([header, written] as unknown as SessionEvent[]).events[0].kind, 'compaction');
  for (const broken of [
    { ...written, ignorable: false },
    { ...written, reason: 'spontaneous' },
    { ...written, blockId: 0 },
    { ...written, toSeq: -1 },
    { ...written, tokensBefore: 'many' },
  ]) {
    assert.throws(() => parseSessionEvents([header, broken] as unknown as SessionEvent[]), { code: 'session_compaction_event_invalid' }, JSON.stringify(broken));
  }
});

test('session approval memory events are ignorable and validate the saved rule', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'policy-rule', projectRoot: '' };
  const saved = { seq: 0, kind: 'sessionPolicyRule', ignorable: true, updatedAt: new Date().toISOString(), rule: { tool: 'mcp:playwright/browser_click', decision: 'allow' } };
  assert.equal(parseSessionEvents([header, saved] as unknown as SessionEvent[]).events[0].kind, 'sessionPolicyRule');
  const fileRule = { ...saved, rule: { tool: 'create', decision: 'allow', target: 'file', path: join(process.cwd(), 'testplace', 'app.js') } };
  assert.equal(parseSessionEvents([header, fileRule] as unknown as SessionEvent[]).events[0].kind, 'sessionPolicyRule');
  assert.throws(() => parseSessionEvents([header, { ...saved, rule: { tool: 'create', decision: 'allow', target: 'file', path: 'app.js' } }] as unknown as SessionEvent[]), { code: 'session_policy_rule_event_invalid' });
  assert.throws(() => parseSessionEvents([header, { ...saved, rule: { tool: '', decision: 'allow' } }] as unknown as SessionEvent[]), { code: 'session_policy_rule_event_invalid' });
});

// 开局还没选过模式时那一格就是不写，而不是写一个空名字或写一份假的默认。
test('a record that never picked a mode says so by leaving the field out', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-2', meta: { projectRoot: '/repo' } });
    await session.append({ kind: 'user', text: 'go' });
    assert.equal('mode' in (await session.header())!, false);
  });
});

// 宿主打开会话时需要读取记录以恢复模式，但这次读取不能阻止缺失的首行正常写入。
test('a record read before its first write still gets its first line', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'read-first', meta: { projectRoot: '/repo' } });
    assert.deepEqual(await session.read(), [], '读一份还不存在的记录不是错误');
    await session.append({ kind: 'user', text: 'go' });
    const lines = (await readFile(session.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines[0].kind, 'session');
    assert.equal(lines[1].seq, 0, '首行不占事件的序号');
  });
});

// 没有首行的现存记录按版本 0 读，读出来还是原来那几条，序号接着最后一条往后走。
test('a record written before the first line existed still reads and continues', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'legacy.jsonl');
    await writeFile(path, `${[tool(0, 'one'), tool(1, 'two')].join('\n')}\n`);
    const session = createSessionLog({ directory, id: 'legacy' });
    assert.equal(await session.header(), undefined);
    assert.deepEqual((await session.read()).map((event) => event.seq), [0, 1]);

    const next = await session.append({ kind: 'user', text: 'three' });
    assert.equal(next.seq, 2, '接在已有记录之后，不重复用号');
// 不为缺少首行的旧记录补写元信息，避免改变原有记录格式。
    assert.equal(await session.header(), undefined);
    assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 3);
  });
});

test('a record from a newer format is refused instead of half read', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'future.jsonl');
    await writeFile(path, `${JSON.stringify({ kind: 'session', formatVersion: 3, sessionId: 'future', projectRoot: '/repo', createdAt: 'x' })}\n${tool(0, 'one')}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'future' }).read(), (error) => {
      const failure = error as { code?: string; detail: string };
      assert.equal(failure.code, 'session_version_unsupported');
      assert.match(failure.detail, /record is version 3/);
      return true;
    });
  });
});

test('an event kind this build does not know is refused unless the record says it may be skipped', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'kind.jsonl');
    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ seq: 1, kind: 'plan/step', text: 'x' })}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'kind' }).read(), (error) => {
      const failure = error as { code?: string; detail: string };
      assert.equal(failure.code, 'session_event_unsupported');
      assert.equal(failure.detail, 'plan/step');
      return true;
    });

    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ seq: 1, kind: 'plan/step', ignorable: true })}\n${tool(2, 'two')}\n`);
    const reopened = createSessionLog({ directory, id: 'kind' });
    assert.deepEqual((await reopened.read()).map((event) => event.tool), ['read', 'read'], '标过的种类可以被略过，剩下的一条不少');
    assert.equal((await reopened.modelView()).length, 2);
    const after = await reopened.append({ kind: 'user', text: 'next' });
    assert.equal(after.seq, 3, '略过一条不认识的事件不影响继续编号');
  });
});

test('session Permission events require format 2 and remain in the canonical record', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'permission.jsonl');
    await writeFile(path, `${JSON.stringify({ kind: 'session', formatVersion: 2, sessionId: 'permission', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' })}\n${JSON.stringify({ seq: 0, kind: 'sessionPermission', profile: 'workspace-write', network: 'policy' })}\n`);
    const record = await createSessionLog({ directory, id: 'permission' }).read();
    assert.equal(record[0].kind, 'sessionPermission');

    await writeFile(path, `${JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: 'permission', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' })}\n${JSON.stringify({ seq: 0, kind: 'sessionPermission', profile: 'full-access', network: 'unrestricted' })}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'permission' }).read(), (error) => {
      const failure = error as { code?: string; detail: string };
      assert.equal(failure.code, 'session_event_version_unsupported');
      assert.match(failure.detail, /format version 2/);
      return true;
    });
  });
});

// 首行之外再出现一份会话元信息，说明这份记录被拼接过；读下去只会读出错误的装配。
test('a second header line is a refusal, not a second session', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'spliced.jsonl');
    const header = JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: 'spliced', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' });
    await writeFile(path, `${header}\n${tool(0, 'one')}\n${header}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'spliced' }).read(), (error) => {
      const failure = error as { code?: string };
      assert.equal(failure.code, 'session_header_position');
      return true;
    });
  });
});

// 用量事件会写入并从记录中读回。它不参与模型投影，但保留连续的事件序号，避免检查点范围出现空缺。
test('the usage event this build writes comes back out of a record', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'usage-kept' });
    await session.append({ kind: 'user', text: 'one' });
    await session.append({ kind: 'usage', ignorable: true, input: 400, output: 5, estimated: 120 });
    await session.append({ kind: 'usage', ignorable: true, input: null, output: 7, estimated: 140, measurement: 'request-v1',
      cache: { source: 'chat-completions', sourceFields: [{ field: 'prompt_cache_hit_tokens', tokens: 20 }, { field: 'prompt_cache_miss_tokens', tokens: 30 }],
        hitInputTokens: 20, missInputTokens: 30, creationInputTokens: null, uncachedInputTokens: null,
        providerInputIncludesCache: true, consistent: null } });
    const events = await createSessionLog({ directory, id: 'usage-kept' }).read();
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
    assert.equal(events[1].kind, 'usage');
    assert.deepEqual(events[2], {
      seq: 2, kind: 'usage', ignorable: true, input: null, output: 7, estimated: 140, measurement: 'request-v1',
      cache: { source: 'chat-completions', sourceFields: [{ field: 'prompt_cache_hit_tokens', tokens: 20 }, { field: 'prompt_cache_miss_tokens', tokens: 30 }],
        hitInputTokens: 20, missInputTokens: 30, creationInputTokens: null, uncachedInputTokens: null,
        providerInputIncludesCache: true, consistent: null },
    }, 'nullable cache-aware records survive while old usage rows remain readable');
    assert.deepEqual((await session.modelView() as { role?: string }[]).map((entry) => entry.role), ['user'], '用量那一格不进投影');
  });
});

test('a usage event keeps unknown totals null instead of coercing null or absence to zero', () => {
  const request = { system: '', tools: [], messages: [{ role: 'user', text: 'one' }] };
  assert.deepEqual(usageEvent(request, [{ type: 'usage', input: null, output: null, cache: {
    source: 'anthropic-messages', sourceFields: [{ field: 'cache_read_input_tokens', tokens: 12 }],
    hitInputTokens: 12, missInputTokens: null, creationInputTokens: null,
    uncachedInputTokens: null, providerInputIncludesCache: false, consistent: null,
  } }]), {
    kind: 'usage', ignorable: true, input: null, output: null,
    estimated: estimateRequest(request),
    measurement: 'request-v1', cache: {
      source: 'anthropic-messages', sourceFields: [{ field: 'cache_read_input_tokens', tokens: 12 }],
      hitInputTokens: 12, missInputTokens: null, creationInputTokens: null,
      uncachedInputTokens: null, providerInputIncludesCache: false, consistent: null,
    },
  });
  assert.equal(usageEvent(request, [{ type: 'usage', input: null, output: null }]), null);
  assert.equal(usageEvent(request, [{ type: 'usage', input: 0, output: 0 }])!.input, 0, 'an explicitly reported zero remains distinct from missing usage');
});
