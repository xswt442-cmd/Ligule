import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../errors.js';
import type { RunResult } from '../delegation.js';
import type { SessionEvent } from './format.js';

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{1,128}$/u;
const PROVENANCE = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

/** Run 来源证据由 Host 的通道判定写入；请求参数不能指定。 */
export interface RunProvenance {
  /** 请求到达 Host 的通道。 */
  readonly via: string;
  /** 来源判定依据：permission-control、agent-control-bridge 等。 */
  readonly resolvedBy: string;
}

export interface RunAcceptance {
  readonly version: 1 | 2;
  readonly sessionId: string;
  readonly runId: string;
  readonly payloadDigest: string;
  readonly callerScope: string;
  readonly requestKey?: string;
  readonly acceptedAt: string;
  /** 版本 2 起存在。 */
  readonly via?: string;
  /** 版本 2 起存在。 */
  readonly resolvedBy?: string;
}
export interface RunResultRef { readonly version: 1; readonly name: string; readonly bytes: number; readonly sha256: string }
export interface DurableRunReceipt {
  readonly runId: string;
  readonly userSeq: number;
  readonly sessionId: string;
  readonly acceptedAt: string;
  readonly state: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly requestKey?: string;
  readonly via?: string;
  readonly resolvedBy?: string;
  readonly resultRef?: RunResultRef;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value ?? null);
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
export function runPayloadDigest(input: string, delegation: unknown): string {
  return digest(Buffer.from(canonical({ version: 1, input, delegation: delegation ?? null })));
}
export function createRunAcceptance(sessionId: string, input: string, delegation: unknown, callerScope: string, requestKey?: string,
  provenance?: RunProvenance): RunAcceptance {
  if (sessionId.length < 1 || sessionId.length > 160 || /[\\/]/u.test(sessionId)) throw new KernelError('run_session_invalid');
  if (requestKey !== undefined && !REQUEST_KEY.test(requestKey)) throw new KernelError('run_request_key_invalid');
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(callerScope)) throw new KernelError('run_caller_scope_invalid');
  if (provenance !== undefined && (!PROVENANCE.test(provenance.via) || !PROVENANCE.test(provenance.resolvedBy))) {
    throw new KernelError('run_provenance_invalid');
  }
  return { version: provenance === undefined ? 1 : 2, sessionId, runId: randomUUID(), callerScope,
    payloadDigest: runPayloadDigest(input, delegation),
    ...(requestKey === undefined ? {} : { requestKey }), acceptedAt: new Date().toISOString(),
    ...(provenance === undefined ? {} : { via: provenance.via, resolvedBy: provenance.resolvedBy }) };
}
export function isRunAcceptance(value: unknown): value is RunAcceptance {
  if (!record(value)) return false;
  return Object.keys(value).every(key => ['version', 'sessionId', 'runId', 'payloadDigest', 'callerScope', 'requestKey', 'acceptedAt', 'via', 'resolvedBy'].includes(key))
    && (value.version === 1 || value.version === 2)
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && value.sessionId.length <= 160 && !/[\\/]/u.test(value.sessionId)
    && typeof value.runId === 'string' && RUN_ID.test(value.runId)
    && typeof value.payloadDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.payloadDigest)
    && typeof value.callerScope === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(value.callerScope)
    && (value.requestKey === undefined || (typeof value.requestKey === 'string' && REQUEST_KEY.test(value.requestKey)))
    && typeof value.acceptedAt === 'string' && Number.isFinite(Date.parse(value.acceptedAt))
    && (value.version === 1
      ? value.via === undefined && value.resolvedBy === undefined
      : typeof value.via === 'string' && PROVENANCE.test(value.via)
        && typeof value.resolvedBy === 'string' && PROVENANCE.test(value.resolvedBy));
}
export function isRunResultRef(value: unknown, runId: string): value is RunResultRef {
  return record(value) && Object.keys(value).every(key => ['version', 'name', 'bytes', 'sha256'].includes(key))
    && value.version === 1 && value.name === 'run-' + runId + '.result.json'
    && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes)
    && value.bytes > 0 && value.bytes <= MAX_RESULT_BYTES
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256);
}
export function runReceipts(events: readonly SessionEvent[], sessionId: string, callerScope?: string): DurableRunReceipt[] {
  const terminals = new Map<number, SessionEvent>();
  for (const event of events) {
    if (event.kind === 'turn' && typeof event.userSeq === 'number'
      && ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(event.status))) terminals.set(event.userSeq, event);
  }
  const runs: DurableRunReceipt[] = [];
  for (const event of events) {
    if (event.kind !== 'user' || !isRunAcceptance(event.run)) continue;
    const run = event.run;
    if (run.sessionId !== sessionId) continue;
    if (callerScope !== undefined && run.callerScope !== callerScope) continue;
    const terminal = terminals.get(event.seq);
    const state = terminal === undefined ? 'accepted' : terminal.status as DurableRunReceipt['state'];
    runs.push({ runId: run.runId, userSeq: event.seq, sessionId, acceptedAt: run.acceptedAt, state,
      ...(run.requestKey === undefined ? {} : { requestKey: run.requestKey }),
      ...(run.via === undefined ? {} : { via: run.via }),
      ...(run.resolvedBy === undefined ? {} : { resolvedBy: run.resolvedBy }),
      ...(isRunResultRef(terminal?.resultRef, run.runId) ? { resultRef: terminal!.resultRef as RunResultRef } : {}) });
  }
  return runs;
}
export function findRunReceipt(events: readonly SessionEvent[], sessionId: string, callerScope: string,
  reference: { runId?: string; requestKey?: string }): DurableRunReceipt | undefined {
  if ((reference.runId === undefined) === (reference.requestKey === undefined)) throw new KernelError('run_reference_invalid');
  if (reference.runId !== undefined && !RUN_ID.test(reference.runId)) throw new KernelError('run_reference_invalid');
  if (reference.requestKey !== undefined && !REQUEST_KEY.test(reference.requestKey)) throw new KernelError('run_request_key_invalid');
  return runReceipts(events, sessionId, callerScope).find(item =>
    reference.runId !== undefined ? item.runId === reference.runId : item.requestKey === reference.requestKey);
}
export async function publishRunResult(directory: string, workspace: string, sessionId: string, runId: string, result: RunResult): Promise<RunResultRef> {
  if (!RUN_ID.test(runId) || result.runId !== runId || result.sessionId !== sessionId) throw new KernelError('run_result_invalid');
  const name = 'run-' + runId + '.result.json';
  const bytes = Buffer.from(JSON.stringify({ version: 1, workspace, sessionId, runId, result }), 'utf8');
  if (bytes.length > MAX_RESULT_BYTES) throw new KernelError('run_result_too_large');
  const temp = join(directory, name + '.' + randomUUID() + '.part');
  const destination = join(directory, name);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await link(temp, destination);
  } catch (cause) {
    throw new KernelError('run_result_write_failed', { cause });
  } finally {
    try { await unlink(temp); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  }
  return { version: 1, name, bytes: bytes.length, sha256: digest(bytes) };
}
export async function readRunResult(directory: string, workspace: string, sessionId: string, receipt: DurableRunReceipt): Promise<RunResult> {
  const ref = receipt.resultRef;
  if (ref === undefined || !isRunResultRef(ref, receipt.runId)) throw new KernelError('run_result_unavailable');
  const path = join(directory, ref.name);
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== ref.bytes) throw new KernelError('run_result_unavailable');
    const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== ref.bytes) throw new KernelError('run_result_unavailable');
      const bytes = Buffer.allocUnsafe(ref.bytes);
      let filled = 0;
      while (filled < bytes.length) {
        const { bytesRead } = await file.read(bytes, filled, Math.min(64 * 1024, bytes.length - filled), filled);
        if (bytesRead === 0) throw new KernelError('run_result_unavailable');
        filled += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || digest(bytes) !== ref.sha256) throw new KernelError('run_result_unavailable');
      const envelope: unknown = JSON.parse(bytes.toString('utf8'));
      if (!record(envelope) || envelope.version !== 1 || envelope.workspace !== workspace
        || envelope.sessionId !== sessionId || envelope.runId !== receipt.runId
        || !record(envelope.result) || envelope.result.runId !== receipt.runId || envelope.result.sessionId !== sessionId
        || !['completed', 'failed', 'cancelled'].includes(String(envelope.result.state))) throw new KernelError('run_result_unavailable');
      return envelope.result as unknown as RunResult;
    } finally { await file.close(); }
  } catch (cause) {
    if (cause instanceof KernelError) throw cause;
    throw new KernelError('run_result_unavailable', { cause });
  }
}
export function runResultPage(result: RunResult, offset = 0) {
  const json = JSON.stringify(result);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > json.length) throw new KernelError('run_result_offset_invalid');
  const end = Math.min(offset + 8192, json.length);
  return { json: json.slice(offset, end), offset, nextOffset: end < json.length ? end : null, totalCharacters: json.length };
}
