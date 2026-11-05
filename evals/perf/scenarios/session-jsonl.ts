import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionHeader } from '../../core/dist/session/format.js';
import { listSessions } from '../../core/dist/session/list.js';
import { parseSessionBytes, readSessionRecord } from '../../core/dist/session/record.js';
import type { Scenario, ScenarioResult, Sample } from '../lib.ts';

type Event = Record<string, unknown> & { seq: number };

const CORPORA = [
  { label: '100-text', count: 100, mixed: false },
  { label: '2000-text', count: 2_000, mixed: false },
  { label: '10000-text', count: 10_000, mixed: false },
  { label: '1000-mixed', count: 1_000, mixed: true },
] as const;

function textEvents(count: number): Event[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index,
    kind: index % 2 === 0 ? 'user' : 'assistant',
    text: `benchmark event ${index} `.repeat(4),
  }));
}

// A second corpus shape with the event mix a real session carries, so the benchmark is not
// only a text-round-trip measurement. Production parsers validate every generated line.
function mixedEvents(count: number): Event[] {
  return Array.from({ length: count }, (_, index): Event => {
    switch (index % 6) {
      case 0:
        return { seq: index, kind: 'user', text: `request ${index}` };
      case 1:
        return { seq: index, kind: 'reasoning', text: `considering step ${index}` };
      case 2:
        return { seq: index, kind: 'assistant', text: `answer ${index}`, usage: { inputTokens: 120, outputTokens: 40 } };
      case 3:
        return { seq: index, kind: 'tool', tool: 'read', args: { path: 'src/file.ts' }, result: { text: 'x'.repeat(200) } };
      case 4:
        return { seq: index, kind: 'usage', inputTokens: 200, outputTokens: 80, model: 'benchmark-model' };
      default:
        return {
          seq: index, kind: 'compaction', ignorable: true, reason: 'auto',
          blockId: Math.floor(index / 6) + 1, fromSeq: index - 5, toSeq: index,
          tokensBefore: 1_000, tokensAfter: 500,
        };
    }
  });
}

async function prepareCorpus(root: string, label: string, count: number, mixed: boolean): Promise<{ directory: string; path: string; count: number }> {
  const directory = join(root, `session-${label}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `bench-${label}.jsonl`);
  const header = createSessionHeader({
    id: `bench-${label}`,
    projectRoot: join(root, 'project'),
    workspace: join(root, 'project'),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const events = mixed ? mixedEvents(count) : textEvents(count);
  const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))];
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return { directory, path, count };
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
    const corpora = new Map<string, {
      directory: string; path: string; count: number; identity: { sha256: string; mtimeMs: number; size: number };
    }>();
    for (const corpus of CORPORA) {
      const prepared = await prepareCorpus(root, corpus.label, corpus.count, corpus.mixed);
      corpora.set(corpus.label, { ...prepared, identity: await fileIdentity(prepared.path) });
    }
    const samples: Sample[] = [];
    const read = async (label: string, record: boolean): Promise<void> => {
      const corpus = corpora.get(label);
      if (corpus === undefined) throw new Error('benchmark_corpus_missing');
      const bytes = await readFile(corpus.path);
      const parseStarted = performance.now();
      const parsed = parseSessionBytes(bytes);
      const parseMs = performance.now() - parseStarted;
      if (parsed.events.length !== corpus.count) throw new Error(`session_parse_count_mismatch:${parsed.events.length}:${corpus.count}`);
      const readStarted = performance.now();
      const recordResult = await readSessionRecord(corpus.path);
      const readMs = performance.now() - readStarted;
      if (recordResult.events.length !== corpus.count) throw new Error('session_read_count_mismatch');
      const listStarted = performance.now();
      const listed = await listSessions(corpus.directory, { index: false });
      const listMs = performance.now() - listStarted;
      if (!listed.some((session) => session.id === `bench-${label}`)) throw new Error('session_list_missing_entry');
      if (record) {
        samples.push({ workload: label, readMs, parseMs, listMs, events: corpus.count, bytes: corpus.identity.size,
          readMsPerEvent: readMs / corpus.count, listMsPerEvent: listMs / corpus.count });
      }
    };
    for (let index = 0; index < warmup; index += 1) {
      for (const corpus of CORPORA) await read(corpus.label, false);
    }
    for (let index = 0; index < repeats; index += 1) {
      for (const corpus of CORPORA) await read(corpus.label, true);
    }
    const notes: Record<string, unknown> = {};
    for (const corpus of CORPORA) {
      const prepared = corpora.get(corpus.label);
      if (prepared === undefined) continue;
      const after = await fileIdentity(prepared.path);
      if (after.sha256 !== prepared.identity.sha256 || after.mtimeMs !== prepared.identity.mtimeMs) throw new Error(`session_read_modified_record:${corpus.label}`);
      const locks = await readdir(prepared.directory);
      if (locks.some((name) => name.endsWith('.lock'))) throw new Error(`session_read_took_lock:${corpus.label}`);
      notes[corpus.label] = { bytes: prepared.identity.size, events: prepared.count, unchanged: true, lockCreated: false };
    }
    notes.measurement = 'Synthetic parse/read/list workload; not a full Session resume measurement.';
    return { name: this.name, status: 'ok', samples, notes };
  },
};
