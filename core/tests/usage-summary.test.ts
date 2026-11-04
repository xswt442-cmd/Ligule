import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage } from '../dist/session/usage-summary.js';

function cache(hit: number) {
  return {
    source: 'chat-completions',
    sourceFields: [{ field: 'prompt_tokens_details.cached_tokens', tokens: hit }],
    hitInputTokens: hit,
    missInputTokens: null,
    creationInputTokens: null,
    uncachedInputTokens: null,
    providerInputIncludesCache: true,
    consistent: true,
  };
}

test('the summary keeps the agent and reviewer accounts apart', () => {
  const summary = summarizeUsage([
    { kind: 'usage', purpose: 'agent', input: 100, output: 10, estimated: 120 },
    // 没有 purpose 的是旧记录，按主 Agent 计，不能因此丢计。
    { kind: 'usage', input: 200, output: 20, estimated: 240 },
    { kind: 'usage', purpose: 'reviewer', input: 50, output: 5, estimated: 60 },
    { kind: 'user', text: 'hi' },
  ]);
  assert.deepEqual(summary.agent, {
    requests: 2, input: 300, output: 30, cachedInput: 0, uncachedInput: null,
    estimatedInput: 360, unknownInputRequests: 0, unknownOutputRequests: 0,
  });
  assert.deepEqual(summary.reviewer, {
    requests: 1, input: 50, output: 5, cachedInput: 0, uncachedInput: null,
    estimatedInput: 60, unknownInputRequests: 0, unknownOutputRequests: 0,
  });
});

test('a cache hit is part of the input total, never an extra charge', () => {
  const summary = summarizeUsage([
    { kind: 'usage', purpose: 'agent', input: 100, output: 4, estimated: 110, cache: cache(60) },
  ]);
  assert.equal(summary.agent.input, 100);
  assert.equal(summary.agent.cachedInput, 60);
  assert.equal(summary.agent.uncachedInput, 40, '缓存是输入的子集，不相加');
});

test('a missing count stays unknown instead of becoming zero', () => {
  const summary = summarizeUsage([
    { kind: 'usage', purpose: 'agent', input: null, output: 4, estimated: 100, cache: cache(30) },
    { kind: 'usage', purpose: 'agent', input: 80, output: null, estimated: 90, cache: cache(20) },
  ]);
  assert.equal(summary.agent.requests, 2);
  assert.equal(summary.agent.unknownInputRequests, 1);
  assert.equal(summary.agent.unknownOutputRequests, 1);
  assert.equal(summary.agent.input, 80, '只有报回的那一次计入总量');
  assert.equal(summary.agent.output, 4);
  assert.equal(summary.agent.cachedInput, 50);
  assert.equal(summary.agent.uncachedInput, null, '还有请求没报输入时不能给出未缓存部分');
});
