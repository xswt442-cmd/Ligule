import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionHeader } from '../../core/dist/session/format.js';
import { listSessions } from '../../core/dist/session/list.js';
import { parseSessionBytes, readSessionRecord } from '../../core/dist/session/record.js';
import type { Scenario, ScenarioResult, Sample } from '../lib.ts';

const CORPORA = [100, 2_000, 10_000] as const;

function eventsFor(count: number): { seq: number; kind: string; text: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index,
    kind: index % 2 === 0 ? 'user' : 'assistant',
    text: `benchmark event ${index} `.repeat(4),
  }));
}

async function prepareCorpus(root: string, count: number): Promise<{ directory: string; path: string }> {
  const directory = join(root, `session-${count}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `bench-${count}.jsonl`);
  const header = createSessionHeader({
    id: `bench-${count}`,
    projectRoot: join(root, 'project'),
    workspace: join(root, 'project'),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const lines = [JSON.stringify(header), ...eventsFor(count).map((event) => JSON.stringify(event))];
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return { directory, path };
}

async function fileIdentity(path: string): Promise<{ sha256: string; mtimeMs: number; size: number }> {
  const bytes = await readFile(path);
  const info = await stat(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: info.mtimeMs, size: info.size };
}

export const sessionJsonl: Scenario = {
  name: 'session-jsonl',
  async run({ repeats, warmup, workRoot }): Promise<ScenarioResult> {
    const root = join(workRoot, 'session-corpus');
    const corpora = new Map<number, { directory: string; path: string; identity: { sha256: string; mtimeMs: number; size: number } }>();
    for (const count of CORPORA) {
      const corpus = await prepareCorpus(root, count);
      corpora.set(count, { ...corpus, identity: await fileIdentity(corpus.path) });
    }
    const samples: Sample[] = [];
    const read = async (count: number, record: boolean): Promise<void> => {
      const corpus = corpora.get(count);
      if (corpus === undefined) throw new Error('benchmark_corpus_missing');
      const bytes = await readFile(corpus.path);
      const parseStarted = performance.now();
      const parsed = parseSessionBytes(bytes);
      const parseMs = performance.now() - parseStarted;
      if (parsed.events.length !== count) throw new Error(`session_parse_count_mismatch:${parsed.events.length}:${count}`);
      const readStarted = performance.now();
      const recordResult = await readSessionRecord(corpus.path);
      const readMs = performance.now() - readStarted;
      if (recordResult.events.length !== count) throw new Error('session_read_count_mismatch');
      const listStarted = performance.now();
      const listed = await listSessions(corpus.directory, { index: false });
      const listMs = performance.now() - listStarted;
      if (!listed.some((session) => session.id === `bench-${count}`)) throw new Error('session_list_missing_entry');
      if (record) {
        samples.push({ events: count, readMs, parseMs, listMs, bytes: corpus.identity.size,
          readMsPerEvent: readMs / count, listMsPerEvent: listMs / count });
      }
    };
    for (let index = 0; index < warmup; index += 1) {
      for (const count of CORPORA) await read(count, false);
    }
    for (let index = 0; index < repeats; index += 1) {
      for (const count of CORPORA) await read(count, true);
    }
    const notes: Record<string, unknown> = {};
    for (const count of CORPORA) {
      const corpus = corpora.get(count);
      if (corpus === undefined) continue;
      const after = await fileIdentity(corpus.path);
      if (after.sha256 !== corpus.identity.sha256 || after.mtimeMs !== corpus.identity.mtimeMs) throw new Error(`session_read_modified_record:${count}`);
      const locks = await import('node:fs/promises').then(({ readdir }) => readdir(corpus.directory));
      if (locks.some((name) => name.endsWith('.lock'))) throw new Error(`session_read_took_lock:${count}`);
      notes[`events${count}`] = { bytes: corpus.identity.size, unchanged: true, lockCreated: false };
    }
    return { name: this.name, status: 'ok', samples, notes };
  },
};
