import { KernelError } from '../errors.js';

const RESULT_LIMIT = 10;
const OUTPUT_LIMIT = 24_000;
const MIN_OUTPUT = 1_024;
const FIELD_LIMITS = { title: 256, snippet: 512, summary: 1_024 } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SearchResult = { title: string; url: string; snippet: string; summary: string; date?: string };
type SearchOutput = {
  provider: 'deepseek';
  query: string;
  requested: number;
  received: number;
  returned: number;
  results: SearchResult[];
  truncated: boolean;
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textWithin(value: string, limit: number): { text: string; truncated: boolean } {
  const bytes = new Uint8Array(limit);
  const { read, written } = encoder.encodeInto(value, bytes);
  return { text: decoder.decode(bytes.subarray(0, written)), truncated: read < value.length };
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) return undefined;
  const datePart = value.slice(0, 10);
  const midnight = new Date(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(Date.parse(value)) || midnight.toISOString().slice(0, 10) !== datePart) return undefined;
  return value;
}

function canonicalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === ''
    || url.username !== '' || url.password !== '') return undefined;
  const href = url.href;
  return encoder.encode(href).byteLength <= 2_048 ? href : undefined;
}

function normalizeResult(value: unknown): { result?: SearchResult; truncated: boolean } {
  const item = recordOf(value);
  if (item === undefined || typeof item.title !== 'string' || typeof item.snippet !== 'string' || typeof item.summary !== 'string') {
    throw new KernelError('search_response_invalid');
  }
  const url = canonicalUrl(item.url);
  if (url === undefined) return { truncated: true };
  const title = textWithin(item.title, FIELD_LIMITS.title);
  const snippet = textWithin(item.snippet, FIELD_LIMITS.snippet);
  const summary = textWithin(item.summary, FIELD_LIMITS.summary);
  const hasDate = item.date !== undefined && item.date !== null && item.date !== '';
  const date = hasDate ? isoDate(item.date) : undefined;
  return {
    result: {
      title: title.text,
      url,
      snippet: snippet.text,
      summary: summary.text,
      ...(date === undefined ? {} : { date }),
    },
    truncated: title.truncated || snippet.truncated || summary.truncated || (hasDate && date === undefined),
  };
}

function outputText(output: SearchOutput): string {
  return JSON.stringify(output);
}

function outputBytes(output: SearchOutput): number {
  return encoder.encode(outputText(output)).byteLength;
}

function scaleResult(result: SearchResult, scale: number): SearchResult {
  return {
    title: textWithin(result.title, Math.floor(FIELD_LIMITS.title * scale)).text,
    url: result.url,
    snippet: textWithin(result.snippet, Math.floor(FIELD_LIMITS.snippet * scale)).text,
    summary: textWithin(result.summary, Math.floor(FIELD_LIMITS.summary * scale)).text,
    ...(result.date === undefined ? {} : { date: result.date }),
  };
}

function firstResultWithinBudget(query: string, requested: number, received: number, first: SearchResult, budget: number): SearchResult {
  const candidate = (result: SearchResult): SearchOutput => ({
    provider: 'deepseek', query, requested, received, returned: 1, results: [result], truncated: true,
  });
  if (outputBytes(candidate(first)) <= budget) return first;
  const smallest = scaleResult(first, 0);
  if (outputBytes(candidate(smallest)) > budget) throw new KernelError('search_result_budget_exceeded');
  let lower = 0;
  let upper = 1;
  for (let index = 0; index < 16; index += 1) {
    const middle = (lower + upper) / 2;
    if (outputBytes(candidate(scaleResult(first, middle))) <= budget) lower = middle;
    else upper = middle;
  }
  return scaleResult(first, lower);
}

/** Validate and bound the successful Search API payload before returning it to the model. */
export function searchResultsOf(value: unknown, query: string, count: number, maxBytes: number): SearchOutput {
  if (typeof query !== 'string' || Array.from(query).length < 1 || Array.from(query).length > 128 || query.trim() === '') {
    throw new KernelError('search_query_invalid');
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > RESULT_LIMIT) throw new KernelError('search_count_invalid');
  if (!Number.isSafeInteger(maxBytes)) throw new KernelError('search_result_budget_exceeded');
  const budget = Math.min(maxBytes, OUTPUT_LIMIT);
  if (budget < MIN_OUTPUT) throw new KernelError('search_result_budget_exceeded');
  const response = recordOf(value);
  if (response === undefined || !Array.isArray(response.results)) throw new KernelError('search_response_invalid');
  if (response.results.length > 50) throw new KernelError('search_response_invalid');

  const received = response.results.length;
  const normalized: SearchResult[] = [];
  let truncated = received > count;
  for (const raw of response.results.slice(0, count)) {
    const item = normalizeResult(raw);
    truncated ||= item.truncated;
    if (item.result !== undefined) normalized.push(item.result);
  }

  let results = normalized;
  while (results.length > 0) {
    const candidate: SearchOutput = {
      provider: 'deepseek', query, requested: count, received, returned: results.length, results, truncated,
    };
    if (outputBytes(candidate) <= budget) return candidate;
    if (results.length === 1) {
      results = [firstResultWithinBudget(query, count, received, results[0]!, budget)];
      truncated = true;
      break;
    }
    results = results.slice(0, -1);
    truncated = true;
  }

  const output: SearchOutput = {
    provider: 'deepseek', query, requested: count, received, returned: results.length, results, truncated,
  };
  if (outputBytes(output) > budget) throw new KernelError('search_result_budget_exceeded');
  return output;
}
