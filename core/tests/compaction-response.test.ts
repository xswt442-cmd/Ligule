import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCompaction, createSessionLog, providerFromConfig } from '../dist/index.js';
import { listenFetchable } from './helpers/port.ts';

for (const api of ['chat-completions', 'messages']) {
  for (const empty of [false, true]) {
    test(`${api} compaction refuses ${empty ? 'an empty' : 'a truncated'} summary without changing the transcript`, async () => {
      const scratch = join(process.cwd(), 'testplace', 'tmp');
      await mkdir(scratch, { recursive: true });
      const directory = await mkdtemp(join(scratch, 'summary-completion-'));
      const id = 'summary-session';
      const session = createSessionLog({ directory, id });
      for (let round = 0; round < 4; round += 1) {
        await session.append({ kind: 'user', text: 'question '.repeat(200) });
        await session.append({ kind: 'assistant', text: 'answer '.repeat(200), toolCalls: [] });
      }
      const before = await readFile(join(directory, `${id}.jsonl`));
      const server = createServer(async (request, response) => {
        for await (const chunk of request) { /* consume actual HTTP input */ }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const frames = api === 'messages'
          ? [
            { type: 'message_start', message: { usage: {} } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: empty ? '' : 'partial summary' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: empty ? 'end_turn' : 'max_tokens' } },
            { type: 'message_stop' },
          ]
          : [{ choices: [{ delta: { content: empty ? '' : 'partial summary' }, finish_reason: empty ? 'stop' : 'length' }] }];
        response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + (api === 'messages' ? '' : 'data: [DONE]\n\n'));
      });
      const port = await listenFetchable(server);
      const previous = process.env.SUMMARY_TEST_KEY;
      process.env.SUMMARY_TEST_KEY = 'synthetic-summary-key';
      try {
        const provider = providerFromConfig({ model: { api, baseURL: `http://127.0.0.1:${port}/v1`, model: 'local-model', apiKeyEnv: 'SUMMARY_TEST_KEY' } });
        const compaction = createCompaction({ provider, session, directory, id,
          limits: { contextTokens: 2000, compactThresholdRatio: 0.8, compactRetainRatio: 0.16, resultBytes: 16000 } });
        await assert.rejects(compaction.compactNow(), (error: unknown) => error instanceof Error && (error as { code?: string }).code === (empty ? 'provider_empty_response' : 'provider_output_exhausted'));
        const beforeLines = before.toString('utf8').split('\n').filter((line) => line !== '');
        const afterLines = (await readFile(join(directory, `${id}.jsonl`), 'utf8')).split('\n').filter((line) => line !== '');
        assert.deepEqual(afterLines.slice(0, beforeLines.length), beforeLines, 'a refused summary leaves every existing event untouched');
        const appended = afterLines.slice(beforeLines.length).map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(appended.length, 1, 'the refused request is still accounted exactly once');
        assert.equal(appended[0].kind, 'usage');
        assert.equal(appended[0].source, 'summary');
        assert.equal(appended[0].input, null, 'a summary that never reported tokens stays unknown');
        await assert.rejects(readFile(join(directory, `${id}.checkpoint.json`)), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'ENOENT');
      } finally {
        if (previous === undefined) delete process.env.SUMMARY_TEST_KEY; else process.env.SUMMARY_TEST_KEY = previous;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
