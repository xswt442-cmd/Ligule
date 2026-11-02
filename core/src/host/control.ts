import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { ProviderDiagnostic } from '../kernel/error.js';
import { completedRunResult, failedRunResult, type DelegationSpec, type RunResult, type RunValidation } from '../delegation.js';
import { checkedRunSummary, runSummary } from '../kernel/run-summary.js';
import { runPayloadDigest } from '../session/run.js';
import { checkedAnswers, type AskQuestion } from '../tools/ask-user.js';
import { APPROVAL_METHOD, QUESTION_METHOD } from './protocol.js';
import type { Host } from './host.js';
import type { LoopResult } from '../kernel/loop.js';
import { createAgentControlRuntime, TRUSTED_AGENT_CONTROL_ORIGIN, type AgentControlRequest } from './agent-control-runtime.js';
import { containsSensitiveMaterial } from './approval.js';

export type OperationState = 'running' | 'done' | 'failed' | 'cancelled';
export type InteractionType = 'approval' | 'question';

interface ControlEvent extends Record<string, unknown> {
  readonly cursor: number;
  readonly kind: string;
  readonly at: number;
  readonly sessionId: string;
  readonly operationId: string;
}

interface Operation {
  readonly operationId: string;
  readonly sessionId: string;
  readonly source: 'human' | 'controller';
  state: OperationState;
  code?: string;
  diagnostics?: ProviderDiagnostic;
  summary?: string;
  phase?: string;
  progress?: Record<string, unknown> | null;
  result?: RunResult;
  updatedAt: number;
  nextCursor: number;
  readonly events: ControlEvent[];
  readonly waiters: Set<() => void>;
  settled: Promise<void>;
  accepted?: Promise<Record<string, unknown>>;
  receipt?: Record<string, unknown>;
}

interface PendingInteraction {
  readonly requestId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly type: InteractionType;
  readonly createdAt: number;
  readonly details: Record<string, unknown>;
  readonly questions?: readonly AskQuestion[];
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface QueueItem {
  readonly queueItemId: string;
  readonly input: string;
  readonly acceptedAt: number;
  readonly sourceOperationId: string;
  readonly source: 'human' | 'controller';
}

interface SessionQueue {
  readonly items: QueueItem[];
  paused: boolean;
}

interface CloseProgress {
  readonly kind: 'controller' | 'takeover';
  hostClosed: boolean;
  runtimeUnregistered: boolean;
}

interface ControlOptions {
  readonly operator?: boolean;
  readonly onEvent?: (event: ControlEvent) => void;
}

export interface McpInitialSettings {
  readonly mode?: string;
  readonly policy?: 'ask' | 'auto' | 'none' | 'never';
  readonly model?: { readonly provider: string; readonly model: string };
  readonly thinking?: { readonly effort: 'none' | 'low' | 'high' | 'max' | 'default' } | null;
  readonly outputTokens?: number | null;
  readonly loopIterations?: number;
  readonly permission?: { readonly profile: 'read-only' | 'workspace-write' | 'full-access'; readonly network: 'policy' | 'unrestricted' | 'disabled' };
}

export interface McpSessionChanges {
  readonly mode?: string;
  readonly policy?: 'ask' | 'auto' | 'none' | 'never' | 'default';
  readonly model?: { readonly provider: string; readonly model: string } | null;
  readonly thinking?: { readonly effort: 'none' | 'low' | 'high' | 'max' | 'default' } | null;
  readonly outputTokens?: number | null;
  readonly loopIterations?: number;
  readonly permission?: {
    readonly profile?: 'read-only' | 'workspace-write' | 'full-access';
    readonly network?: 'policy' | 'unrestricted' | 'disabled';
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('host_response_invalid');
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 对外错误不包含 Host 内部信息、路径、凭据或原始错误原因。 */
export function controlErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'control_failed';
}

/** 每个本地控制器独立拥有一个 Host；操作 ID 仅在该控制器存续期间有效。 */
export function createControl(host: Host, projectRoot: string, options: ControlOptions = {}) {
  const sessions = new Set<string>();
  const operations = new Map<string, Operation>();
  const keyedOperations = new Map<string, { digest: string; operation: Operation }>();
  const active = new Map<string, Operation>();
  const interactions = new Map<string, PendingInteraction>();
  const queues = new Map<string, SessionQueue>();
  const takenOver = new Set<string>();
  const takingOver = new Set<string>();
  const openingSessions = new Set<string>();
  const closingSessions = new Set<string>();
  const closeProgress = new Map<string, CloseProgress>();
  const closingOperations = new Map<string, Promise<{ sessionId: string }>>();
  const operator = options.operator === true;
  let closing: Promise<void> | undefined;
  let closingCode = 'control_closed';
  let opening = 0;
  const pending = new Set<Promise<unknown>>();
  const localRuntime = createAgentControlRuntime(projectRoot, (sessionId, request) => handleHumanControl(sessionId, request));

  function publish(found: Operation, kind: string, fields: Record<string, unknown> = {}): ControlEvent {
    const event: ControlEvent = {
      cursor: found.nextCursor++, kind, at: Date.now(), sessionId: found.sessionId, operationId: found.operationId, ...fields,
    };
    found.updatedAt = event.at;
    found.events.push(event);
    if (found.events.length > 128) found.events.shift();
    for (const wake of [...found.waiters]) wake();
    try { options.onEvent?.(event); } catch { /* Notification failure does not alter the Host operation. */ }
    return event;
  }

  function currentQueue(sessionId: string): SessionQueue {
    let found = queues.get(sessionId);
    if (found === undefined) {
      found = { items: [], paused: false };
      queues.set(sessionId, found);
    }
    return found;
  }

  function pendingFor(found: Operation): PendingInteraction[] {
    return [...interactions.values()].filter((one) => one.operationId === found.operationId);
  }

  function interactionRequest(method: string, params: unknown): Promise<unknown> {
    const input = record(params);
    if (method !== APPROVAL_METHOD && method !== QUESTION_METHOD) {
      return Promise.reject(new KernelError('control_interaction_unknown'));
    }
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const found = active.get(sessionId);
    if (found === undefined || found.state !== 'running' || closing !== undefined) {
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'unavailable', code: 'control_interaction_stale' })
        : Promise.reject(new KernelError('control_interaction_stale'));
    }
    if (pendingFor(found).length >= 8) {
      publish(found, 'interaction.rejected', { interactionType: method === APPROVAL_METHOD ? 'approval' : 'question', code: 'control_interaction_limit' });
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'unavailable', code: 'control_interaction_limit' })
        : Promise.reject(new KernelError('control_interaction_limit'));
    }

    const type: InteractionType = method === APPROVAL_METHOD ? 'approval' : 'question';
    const requestedId = typeof input.requestId === 'string' ? input.requestId : undefined;
    const requestId = type === 'approval' && requestedId !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(requestedId)
      ? requestedId
      : randomUUID();
    if (interactions.has(requestId)) return method === APPROVAL_METHOD
      ? Promise.resolve({ decision: 'unavailable', code: 'control_interaction_duplicate' })
      : Promise.reject(new KernelError('control_interaction_duplicate'));
    const details = type === 'approval'
      ? {
          tool: input.tool,
          args: input.args,
          ...(input.detailsRef === undefined ? {} : { detailsRef: input.detailsRef }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.callId === undefined ? {} : { callId: input.callId }),
          ...(input.identityDigest === undefined ? {} : { identityDigest: input.identityDigest }),
          ...(input.argumentBytes === undefined ? {} : { argumentBytes: input.argumentBytes }),
          ...(input.argumentSha256 === undefined ? {} : { argumentSha256: input.argumentSha256 }),
          ...(input.contentBytes === undefined ? {} : { contentBytes: input.contentBytes }),
          ...(input.contentSha256 === undefined ? {} : { contentSha256: input.contentSha256 }),
          ...(input.preview === undefined ? {} : { preview: input.preview }),
          ...(input.rememberable === undefined ? {} : { rememberable: input.rememberable }),
          ...(input.rememberScopes === undefined ? {} : { rememberScopes: input.rememberScopes }),
          ...(input.rememberHintKey === undefined ? {} : { rememberHintKey: input.rememberHintKey }),
          ...(input.rememberTargetOptions === undefined ? {} : { rememberTargetOptions: input.rememberTargetOptions }),
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.policy === undefined ? {} : { policy: input.policy }),
          ...(input.policySource === undefined ? {} : { policySource: input.policySource }),
          ...(input.policyForced === undefined ? {} : { policyForced: input.policyForced }),
          ...(input.shell === undefined ? {} : { shell: input.shell }),
          ...(input.executable === undefined ? {} : { executable: input.executable }),
        }
      : { questions: input.questions };
    let serialized: string;
    try { serialized = JSON.stringify(details); }
    catch { serialized = ''; }
    if (serialized === '' || serialized.length > 16_384) {
      publish(found, 'interaction.rejected', { requestId, interactionType: type, code: 'control_interaction_unreviewable' });
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'unavailable', code: 'control_interaction_unreviewable' })
        : Promise.reject(new KernelError('control_interaction_unreviewable'));
    }
    if (containsSensitiveMaterial(details)) {
      publish(found, 'interaction.rejected', { requestId, interactionType: type, code: 'control_interaction_sensitive' });
      return method === APPROVAL_METHOD
        ? Promise.resolve({ decision: 'unavailable', code: 'control_interaction_sensitive' })
        : Promise.reject(new KernelError('control_interaction_sensitive'));
    }

    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<unknown>((accept, decline) => { resolve = accept; reject = decline; });
    const questionList = type === 'question' && Array.isArray(input.questions)
      ? input.questions as AskQuestion[]
      : undefined;
    if (type === 'question' && questionList === undefined) return Promise.reject(new KernelError('control_question_invalid'));
    interactions.set(requestId, {
      requestId, sessionId, operationId: found.operationId, type, createdAt: Date.now(), details,
      ...(questionList === undefined ? {} : { questions: questionList }), resolve, reject,
    });
    publish(found, 'interaction.required', { requestId, interactionType: type });
    return response;
  }

  const notifications = {
    notify(message: Record<string, unknown>) {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      if (sessionId === undefined) return;
      const found = active.get(sessionId);
      if (found === undefined || found.state !== 'running') return;
      if (message.notify === 'progress' && isPlainRecord(message.progress)) {
        found.progress = message.progress;
        found.phase = typeof message.progress.phase === 'string' ? message.progress.phase : undefined;
        publish(found, 'run.progress', { phase: found.phase ?? null, progress: message.progress });
      } else if (message.notify === 'event' && isPlainRecord(message.event)) {
        publish(found, 'session.event', {
          eventSeq: typeof message.event.seq === 'number' ? message.event.seq : null,
          eventKind: typeof message.event.kind === 'string' ? message.event.kind : 'unknown',
        });
      } else if (message.notify === 'delta' && isPlainRecord(message.event)
        && (message.event.type === 'text' || message.event.type === 'reasoning')
        && typeof message.event.text === 'string') {
        const text = message.event.text;
        for (let offset = 0; offset < text.length; offset += 8192) {
          publish(found, 'model.delta', { type: message.event.type, text: text.slice(offset, offset + 8192) });
        }
      } else if (message.notify === 'fault') {
        publish(found, 'run.fault', { code: typeof message.code === 'string' ? message.code : 'host_fault' });
      }
    },
    request(method: string, params?: unknown) { return interactionRequest(method, params); },
  };
  // 本地控制面（MCP stdio、进程内调用方）不带 human capability；只有经 authenticated
  // Agent Control socket 送达的请求用 bridgeConnection，才允许写/读 human origin。
  const connection = notifications;
  const bridgeConnection = { ...notifications, [TRUSTED_AGENT_CONTROL_ORIGIN]: true as const };
  const humanDeliveries = new Set<string>();

  async function tracked<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    try { return await work; }
    finally { pending.delete(work); }
  }

  function ready(): void {
    if (closing !== undefined) throw new KernelError(closingCode);
  }

  function owned(sessionId: string): void {
    ready();
    if (!sessions.has(sessionId)) throw new KernelError('session_not_open');
  }

  function writable(sessionId: string): void {
    ready();
    if (takenOver.has(sessionId) || takingOver.has(sessionId)) throw new KernelError('control_session_taken_over');
    owned(sessionId);
    if (closingSessions.has(sessionId)) throw new KernelError('control_session_closing');
  }

  async function authorized(root: string): Promise<void> {
    if (!isAbsolute(root)) throw new KernelError('control_project_forbidden');
    let actual: string;
    let expected: string;
    try {
      [actual, expected] = await Promise.all([realpath(resolve(root)), realpath(resolve(projectRoot))]);
    }
    catch { throw new KernelError('control_project_forbidden'); }
    const identity = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    if (identity(actual) !== identity(expected)) throw new KernelError('control_project_forbidden');
  }

  async function session(method: 'session.create' | 'session.open', root: string, sessionId?: string, initial?: McpInitialSettings) {
    ready();
    if (initial !== undefined && Object.keys(initial).length > 0 && !operator) throw new KernelError('control_operator_required');
    if (sessionId !== undefined && closingSessions.has(sessionId)) throw new KernelError('control_session_closing');
    if (sessionId !== undefined && (takenOver.has(sessionId) || takingOver.has(sessionId))) throw new KernelError('control_session_taken_over');
    if (sessionId !== undefined && openingSessions.has(sessionId)) throw new KernelError('control_session_opening');
    if ((sessionId === undefined || !sessions.has(sessionId)) && sessions.size + opening >= 64) throw new KernelError('control_session_limit');
    if (sessionId !== undefined) openingSessions.add(sessionId);
    opening += 1;
    const work = (async () => {
      await authorized(root);
      ready();
      const initialModel = initial?.model;
      const initialThinking = initial?.thinking;
      const initialPermission = initial?.permission;
      const result = record(await host.handle({ method, params: {
        projectRoot,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(method !== 'session.create' || initial === undefined ? {} : {
          ...(initial.mode === undefined ? {} : { initialMode: initial.mode }),
          ...(initial.policy === undefined ? {} : { initialPolicy: initial.policy }),
          ...(initialModel === undefined ? {} : { initialProvider: initialModel.provider, initialModel: initialModel.model }),
          ...(initialThinking === undefined || initialThinking === null || initialThinking.effort === 'default'
            ? {} : { initialThinkingEffort: initialThinking.effort }),
          ...(initial.outputTokens === undefined || initial.outputTokens === null ? {} : { initialOutputTokens: initial.outputTokens }),
          ...(initial.loopIterations === undefined ? {} : { initialLoopIterations: initial.loopIterations }),
          ...(initialPermission === undefined ? {} : {
            initialPermissionProfile: initialPermission.profile,
            initialPermissionNetwork: initialPermission.network,
          }),
        }),
      } }, connection));
      if (typeof result.sessionId !== 'string') throw new KernelError('host_response_invalid');
      try {
        await localRuntime.register(result.sessionId);
        sessions.add(result.sessionId);
      } catch (error) {
        await host.handle({ method: 'session.close', params: { sessionId: result.sessionId } }, connection).catch(() => undefined);
        throw error;
      }
      return { sessionId: result.sessionId, ...(result.settingsApplied === true ? { settingsApplied: true } : {}) };
    })();
    pending.add(work);
    try { return await work; }
    finally {
      opening -= 1;
      pending.delete(work);
      if (sessionId !== undefined) openingSessions.delete(sessionId);
    }
  }

  function sessionHasPendingWork(sessionId: string): boolean {
    const queue = queues.get(sessionId);
    return active.has(sessionId)
      || (queue !== undefined && (queue.items.length > 0 || queue.paused))
      || [...interactions.values()].some((interaction) => interaction.sessionId === sessionId);
  }

  async function releaseSession(sessionId: string, progress: CloseProgress): Promise<void> {
    if (!progress.hostClosed) {
      const result = record(await tracked(host.handle({ method: 'session.close', params: { sessionId } }, connection)));
      if (result.sessionId !== sessionId) throw new KernelError('host_response_invalid');
      progress.hostClosed = true;
    }
    if (!progress.runtimeUnregistered) {
      await localRuntime.unregister(sessionId);
      progress.runtimeUnregistered = true;
    }
    sessions.delete(sessionId);
    queues.delete(sessionId);
  }

  async function closeSession(sessionId: string): Promise<{ sessionId: string }> {
    ready();
    if (!sessions.has(sessionId)) throw new KernelError('session_not_open');
    if (takenOver.has(sessionId) || takingOver.has(sessionId)) throw new KernelError('control_session_taken_over');
    if (openingSessions.has(sessionId)) throw new KernelError('control_session_busy');
    const inFlight = closingOperations.get(sessionId);
    if (inFlight !== undefined) return await inFlight;
    let progress = closeProgress.get(sessionId);
    if (progress?.kind === 'takeover') throw new KernelError('control_session_taken_over');
    if (progress === undefined) {
      if (sessionHasPendingWork(sessionId)) throw new KernelError('control_session_busy');
      progress = { kind: 'controller', hostClosed: false, runtimeUnregistered: false };
      closeProgress.set(sessionId, progress);
    }
    closingSessions.add(sessionId);
    const work = (async (): Promise<{ sessionId: string }> => {
      await releaseSession(sessionId, progress!);
      closeProgress.delete(sessionId);
      closingSessions.delete(sessionId);
      return { sessionId };
    })();
    closingOperations.set(sessionId, work);
    pending.add(work);
    try { return await work; }
    finally {
      pending.delete(work);
      if (closingOperations.get(sessionId) === work) closingOperations.delete(sessionId);
    }
  }

  function operation(operationId: string): Operation {
    ready();
    const found = operations.get(operationId);
    if (found === undefined) throw new KernelError('operation_not_found');
    return found;
  }

  function queueSummary(sessionId: string) {
    const queue = currentQueue(sessionId);
    return {
    queue: queue.items.map(({ queueItemId, acceptedAt, input, source }) => ({ queueItemId, acceptedAt, inputCharacters: input.length, source })),
      queuePaused: queue.paused,
      currentOperationId: active.get(sessionId)?.operationId ?? null,
    };
  }

  function status(found: Operation, after = 0, limit = 20) {
    const firstAvailableCursor = found.events[0]?.cursor ?? found.nextCursor;
    const eventGap = after < firstAvailableCursor - 1;
    const availableEvents = found.events.filter((event) => event.cursor > after);
    const events = availableEvents.slice(0, limit);
    return {
      operationId: found.operationId, sessionId: found.sessionId, state: found.state,
      source: found.source,
      ...(found.code === undefined ? {} : { code: found.code }),
      ...(found.diagnostics === undefined ? {} : { diagnostics: found.diagnostics }),
      ...(found.summary === undefined ? {} : { summary: found.summary }),
      result: found.result ?? null,
      phase: found.phase ?? null,
      waitingFor: found.phase === 'awaiting_approval' ? 'approval' : found.phase === 'awaiting_input' ? 'input' : null,
      progress: found.progress ?? null,
      updatedAt: found.updatedAt,
      pendingInteractions: pendingFor(found).map((interaction) => ({
        requestId: interaction.requestId,
        sessionId: interaction.sessionId,
        operationId: interaction.operationId,
        type: interaction.type,
        createdAt: interaction.createdAt,
        details: interaction.details,
      })),
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
      hasMoreEvents: availableEvents.length > events.length,
      eventGap,
      firstAvailableCursor,
      ...queueSummary(found.sessionId),
    };
  }

  function latestSessionOperation(sessionId: string): Operation | undefined {
    return active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
  }

  async function waitForUpdate(found: Operation, after: number, waitMs: number): Promise<void> {
    if (found.state !== 'running' || found.nextCursor - 1 > after || waitMs === 0) return;
    await new Promise<void>((resolveWait) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        found.waiters.delete(wake);
        resolveWait();
      };
      const wake = () => {
        if (found.state !== 'running' || found.nextCursor - 1 > after) finish();
      };
      found.waiters.add(wake);
      timer = setTimeout(finish, waitMs);
      wake();
    });
  }

  async function observeSession(sessionId: string, after = 0, limit = 50, waitMs = 0) {
    owned(sessionId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
      throw new KernelError('control_cursor_invalid');
    }
    const found = latestSessionOperation(sessionId);
    if (found === undefined) {
      return {
        sessionId,
        state: 'idle',
        ownership: takenOver.has(sessionId) ? 'human' : 'external',
        events: [], nextCursor: after, hasMoreEvents: false, eventGap: false, firstAvailableCursor: 1,
        pendingInteractions: [], ...queueSummary(sessionId),
      };
    }
    await waitForUpdate(found, after, waitMs);
    return { ...status(found, after, limit), ownership: takenOver.has(sessionId) ? 'human' : 'external' };
  }

  function settleInteractions(found: Operation, errorCode = 'control_interaction_stale'): void {
    for (const interaction of pendingFor(found)) {
      interactions.delete(interaction.requestId);
      if (interaction.type === 'approval') interaction.resolve({ decision: 'cancelled', code: errorCode });
      else interaction.reject(new KernelError(errorCode));
    }
  }

  function publishFinished(found: Operation): void {
    const kind = found.state === 'done' ? 'run.completed' : found.state === 'cancelled' ? 'run.cancelled' : 'run.failed';
    publish(found, kind, {
      ...(found.code === undefined ? {} : { code: found.code }),
      ...(found.diagnostics === undefined ? {} : { diagnostics: found.diagnostics }),
    });
  }

  function startOne(sessionId: string, input: string, queueItemId?: string, delegation?: DelegationSpec, source: 'human' | 'controller' = 'controller', requestKey?: string, durable = false, channel = connection) {
    writable(sessionId);
    if (active.has(sessionId)) throw new KernelError('run_already_running');
    if (operations.size >= 256) {
      const oldest = [...operations.values()].find((entry) => entry.state !== 'running');
      if (oldest === undefined) throw new KernelError('control_operation_limit');
      operations.delete(oldest.operationId);
      for (const [key, value] of keyedOperations) if (value.operation === oldest) keyedOperations.delete(key);
    }
    const found: Operation = {
      operationId: randomUUID(), sessionId, source, state: 'running', updatedAt: Date.now(), nextCursor: 1, events: [], waiters: new Set(), settled: Promise.resolve(),
    };
    operations.set(found.operationId, found);
    active.set(sessionId, found);
    publish(found, 'run.started', { source, ...(queueItemId === undefined ? {} : { queueItemId }) });
    const submit = Promise.resolve().then(async () => {
      if (!durable) return undefined;
      return record(await host.handle({ method: 'run.submit', params: {
        sessionId, input, origin: source,
        ...(delegation === undefined ? {} : { delegation }), ...(requestKey === undefined ? {} : { requestKey }),
      } }, channel));
    });
    if (durable) found.accepted = submit.then(value => {
      if (value === undefined) throw new KernelError('host_response_invalid');
      found.receipt = value;
      return value;
    });
    const work = durable
      ? found.accepted!.then(receipt => host.handle({ method: 'run.wait', params: {
        sessionId, runId: receipt.runId, origin: source,
      } }, channel))
      : Promise.resolve().then(() => host.handle({ method: 'run.start', params: {
        sessionId, input, origin: source,
        ...(delegation === undefined ? {} : { delegation }), ...(requestKey === undefined ? {} : { requestKey }),
      } }, channel));
    found.settled = work.then(
      (result) => {
        const completed = record(result);
        if (typeof completed.text !== 'string' || !Number.isSafeInteger(completed.iterations)
          || !Number.isSafeInteger(completed.modelCalls)
          || (completed.completedBy !== undefined && typeof completed.completedBy !== 'string')) {
          throw new KernelError('host_response_invalid');
        }
        let validation: RunValidation | undefined;
        if (completed.validation !== undefined) {
          const value = record(completed.validation);
          if (value.status !== 'not_requested' && value.status !== 'valid' && value.status !== 'invalid') {
            throw new KernelError('host_response_invalid');
          }
          const schemaDigest = value.schemaDigest;
          const errors = value.errors;
          if ((schemaDigest !== undefined && typeof schemaDigest !== 'string')
            || (errors !== undefined && (!Array.isArray(errors) || errors.some((entry) => typeof entry !== 'string')))) {
            throw new KernelError('host_response_invalid');
          }
          validation = {
            status: value.status,
            ...(schemaDigest === undefined ? {} : { schemaDigest }),
            ...(errors === undefined ? {} : { errors }),
          };
        }
        found.result = completedRunResult(typeof completed.runId === 'string' ? completed.runId : found.operationId, sessionId, {
          ...checkedRunSummary(completed),
          ...(typeof completed.completedBy === 'string' ? { completedBy: completed.completedBy } : {}),
        } satisfies LoopResult, {
          ...(Object.hasOwn(completed, 'structured') ? { structured: completed.structured } : {}),
          ...(validation === undefined ? {} : { validation }),
        });
        found.state = 'done';
        found.summary = 'Run completed.';
        // 经 Human Control bridge 在本控制实例内投递的 human run，本实例可以读它的 receipt；
        // 别的 Host 建立的 human run 仍然留在 human scope 里，不可见。
        if (source === 'human' && typeof completed.runId === 'string') humanDeliveries.add(completed.runId);
      },
    ).catch((error: unknown) => {
      const code = controlErrorCode(error);
      found.code = code;
      if (error instanceof KernelError && error.diagnostics !== undefined) found.diagnostics = error.diagnostics;
      found.state = ['provider_cancelled', 'loop_cancelled', 'ask_user_cancelled', 'task_cancelled'].includes(found.code) ? 'cancelled' : 'failed';
      const validation = delegation?.outputSchema === undefined ? undefined : {
        status: 'invalid' as const,
        errors: [`Run ended with ${code} before a valid structured result was submitted.`],
      };
      found.result = failedRunResult(typeof found.receipt?.runId === 'string' ? found.receipt.runId : found.operationId,
        sessionId, code, found.diagnostics, validation, runSummary(error));
    }).then(() => {
      settleInteractions(found);
      if (active.get(sessionId) === found) active.delete(sessionId);
      publishFinished(found);
      const queue = currentQueue(sessionId);
      if (found.state === 'done' && !queue.paused) drainQueue(sessionId);
      else if (found.state !== 'done' && queue.items.length > 0) queue.paused = true;
    });
    return found;
  }

  function drainQueue(sessionId: string): void {
    const queue = queues.get(sessionId);
    if (queue === undefined || queue.paused || queue.items.length === 0 || active.has(sessionId) || closing !== undefined) return;
    const item = queue.items.shift()!;
    try {
      const next = startOne(sessionId, item.input, item.queueItemId, undefined, item.source, undefined, false,
        item.source === 'human' ? bridgeConnection : connection);
      const source = operations.get(item.sourceOperationId);
      if (source !== undefined) publish(source, 'queue.started', { queueItemId: item.queueItemId, newOperationId: next.operationId, source: item.source });
    }
    catch (error) {
      queue.items.unshift(item);
      queue.paused = true;
      const latest = [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
      if (latest !== undefined) publish(latest, 'queue.paused', { queueItemId: item.queueItemId, code: controlErrorCode(error) });
    }
  }

  function replyInteraction({ sessionId, requestId, type, decision, answers, rememberScope, rememberTarget }: {
    sessionId: string; requestId: string; type: InteractionType; decision?: 'allow' | 'deny'; answers?: unknown;
    rememberScope?: 'session' | 'project' | 'user';
    rememberTarget?: 'file' | 'workspace' | 'tool' | 'command';
  }, source: 'human' | 'controller' = 'controller') {
    ready();
    if (source === 'controller' && !operator) throw new KernelError('control_operator_required');
    writable(sessionId);
    const interaction = interactions.get(requestId);
    if (interaction === undefined) throw new KernelError('control_interaction_stale');
    if (interaction.sessionId !== sessionId) throw new KernelError('control_interaction_session_mismatch');
    if (interaction.type !== type) throw new KernelError('control_interaction_type_mismatch');
    const found = operations.get(interaction.operationId);
    if (found === undefined || found.state !== 'running' || active.get(sessionId) !== found) {
      throw new KernelError('control_interaction_stale');
    }
    if (type === 'approval') {
      if (decision !== 'allow' && decision !== 'deny') throw new KernelError('control_interaction_decision_invalid');
      if ((rememberScope !== undefined || rememberTarget !== undefined) && source !== 'human') {
        throw new KernelError('policy_memory_trusted_user_required');
      }
      if (rememberScope !== undefined && rememberScope !== 'session' && rememberScope !== 'project' && rememberScope !== 'user') {
        throw new KernelError('policy_memory_scope_invalid');
      }
      if (rememberTarget !== undefined && rememberTarget !== 'file' && rememberTarget !== 'workspace'
        && rememberTarget !== 'tool' && rememberTarget !== 'command') {
        throw new KernelError('policy_memory_target_invalid');
      }
      interactions.delete(requestId);
      publish(found, 'interaction.resolved', { requestId, interactionType: type, decision, source, ...(rememberScope === undefined ? {} : { rememberScope }) });
      interaction.resolve({ decision, source, ...(rememberScope === undefined ? {} : { rememberScope }), ...(rememberTarget === undefined ? {} : { rememberTarget }) });
      return { requestId, sessionId, operationId: found.operationId, type, decision, source, ...(rememberScope === undefined ? {} : { rememberScope }), ...(rememberTarget === undefined ? {} : { rememberTarget }), resolved: true };
    }
    const questions = interaction.questions;
    if (questions === undefined) throw new KernelError('control_question_invalid');
    const checked = checkedAnswers(questions, { answers });
    interactions.delete(requestId);
    publish(found, 'interaction.resolved', { requestId, interactionType: type, answered: checked.length, source });
    interaction.resolve({ answers: checked, source });
    return { requestId, sessionId, operationId: found.operationId, type, answered: checked.length, source, resolved: true };
  }

  async function configure(sessionId: string, changes?: McpSessionChanges) {
    ready();
    owned(sessionId);
    const hasChanges = changes !== undefined && Object.keys(changes).length > 0;
    if (hasChanges) writable(sessionId);
    if (hasChanges && !operator) throw new KernelError('control_operator_required');
    const params: Record<string, unknown> = { sessionId };
    if (changes?.mode !== undefined) params.mode = changes.mode;
    if (changes?.policy !== undefined) params.policy = changes.policy;
    if (changes?.model === null) params.resetModel = true;
    else if (changes?.model !== undefined) { params.provider = changes.model.provider; params.model = changes.model.model; }
    if (changes?.thinking === null) params.resetThinking = true;
    else if (changes?.thinking !== undefined) params.thinkingEffort = changes.thinking.effort;
    if (changes?.outputTokens === null) params.resetOutputTokens = true;
    else if (changes?.outputTokens !== undefined) params.outputTokens = changes.outputTokens;
    if (changes?.loopIterations !== undefined) params.loopIterations = changes.loopIterations;
    if (changes?.permission?.profile !== undefined) params.permissionProfile = changes.permission.profile;
    if (changes?.permission?.network !== undefined) params.permissionNetwork = changes.permission.network;
    const result = record(await tracked(host.handle({ method: 'session.configure', params }, connection)));
    if (changes?.permission === undefined) return { ...result, requested: changes ?? null };
    const effective = record(await tracked(host.handle({ method: 'session.configure', params: { sessionId } }, connection)));
    return { ...effective, requested: changes };
  }

  function send(sessionId: string, action: 'send' | 'continue' | 'cancel_queued' | 'clear_queue', input?: string, queueItemId?: string, source: 'human' | 'controller' = 'controller', channel = connection) {
    writable(sessionId);
    const queue = currentQueue(sessionId);
    if (action === 'continue') {
      if (input !== undefined || queueItemId !== undefined) throw new KernelError('session_send_arguments_invalid');
      if (queue.items.length === 0) throw new KernelError('session_queue_empty');
      queue.paused = false;
      drainQueue(sessionId);
      return { sessionId, action, ...queueSummary(sessionId) };
    }
    if (action === 'cancel_queued') {
      if (input !== undefined) throw new KernelError('session_send_arguments_invalid');
      if (typeof queueItemId !== 'string' || queueItemId === '') throw new KernelError('session_queue_item_required');
      const index = queue.items.findIndex((item) => item.queueItemId === queueItemId);
      if (index < 0) throw new KernelError('session_queue_item_not_found');
      queue.items.splice(index, 1);
      if (queue.items.length === 0) queue.paused = false;
      const latest = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
      if (latest !== undefined) publish(latest, 'queue.item_cancelled', { queueItemId, source });
      return { sessionId, action, queueItemId, ...queueSummary(sessionId) };
    }
    if (action === 'clear_queue') {
      if (input !== undefined || queueItemId !== undefined) throw new KernelError('session_send_arguments_invalid');
      const cleared = queue.items.length;
      queue.items.length = 0;
      queue.paused = false;
      const latest = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
      if (latest !== undefined && cleared > 0) publish(latest, 'queue.cleared', { cleared, source });
      return { sessionId, action, cleared, ...queueSummary(sessionId) };
    }
    if (queueItemId !== undefined) throw new KernelError('session_send_arguments_invalid');
    if (typeof input !== 'string' || input.trim() === '' || input.length > 65_536) throw new KernelError('session_input_invalid');
    if (!active.has(sessionId) && queue.items.length === 0 && !queue.paused) {
      const found = startOne(sessionId, input, undefined, undefined, source, undefined, false, channel);
      return {
        sessionId, accepted: true, queued: false, operationId: found.operationId, state: found.state,
        ...queueSummary(sessionId),
      };
    }
    if (queue.items.length >= 16) throw new KernelError('session_queue_full');
    const sourceOperation = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
    if (sourceOperation === undefined) throw new KernelError('session_queue_source_missing');
    const item: QueueItem = { queueItemId: randomUUID(), input, acceptedAt: Date.now(), sourceOperationId: sourceOperation.operationId, source };
    queue.items.push(item);
    const activeOperation = active.get(sessionId) ?? [...operations.values()].reverse().find((operation) => operation.sessionId === sessionId);
    if (activeOperation !== undefined) publish(activeOperation, 'message.queued', { queueItemId: item.queueItemId, inputCharacters: input.length, source });
    return { sessionId, accepted: true, queued: true, queueItemId: item.queueItemId, ...queueSummary(sessionId) };
  }

  async function cancelOperation(operationId: string, source: 'human' | 'controller' = 'controller', channel = connection) {
    const found = operation(operationId);
    if (source === 'controller') writable(found.sessionId);
    else owned(found.sessionId);
    if (found.state === 'running') {
      try { await host.handle({ method: 'run.cancel', params: { sessionId: found.sessionId } }, channel); }
      catch (error) { if (controlErrorCode(error) !== 'run_not_running') throw error; }
      await found.settled;
    }
    return { ...status(found), terminated: found.state !== 'running' };
  }

  async function takeOverSession(sessionId: string) {
    ready();
    if (takenOver.has(sessionId)) throw new KernelError('control_session_taken_over');
    if (takingOver.has(sessionId)) throw new KernelError('control_session_closing');
    if (!sessions.has(sessionId)) throw new KernelError('session_not_open');
    if (openingSessions.has(sessionId)) throw new KernelError('control_session_busy');
    let progress = closeProgress.get(sessionId);
    if (progress?.kind === 'controller') throw new KernelError('control_session_closing');
    if (progress === undefined) {
      progress = { kind: 'takeover', hostClosed: false, runtimeUnregistered: false };
      closeProgress.set(sessionId, progress);
    }
    closingSessions.add(sessionId);
    takingOver.add(sessionId);
    try {
      const found = active.get(sessionId);
      if (found !== undefined) await cancelOperation(found.operationId, 'human', bridgeConnection);
      const queue = queues.get(sessionId);
      if (queue !== undefined) {
        queue.items.length = 0;
        queue.paused = false;
      }
      await releaseSession(sessionId, progress);
      const latest = latestSessionOperation(sessionId);
      takenOver.add(sessionId);
      if (latest !== undefined) publish(latest, 'ownership.transferred', { from: 'external', to: 'human' });
      closeProgress.delete(sessionId);
      closingSessions.delete(sessionId);
      return { sessionId, ownership: 'human', released: true, operationId: latest?.operationId ?? null };
    } finally {
      takingOver.delete(sessionId);
    }
  }

  async function handleHumanControl(sessionId: string, request: AgentControlRequest): Promise<unknown> {
    owned(sessionId);
    switch (request.action) {
      case 'status': return await observeSession(sessionId, request.after, request.limit, request.waitMs);
      case 'configuration': return await host.handle({ method: 'status.get', params: { sessionId } }, bridgeConnection);
      case 'details': return await host.handle({ method: 'approval.details', params: { sessionId, requestId: request.requestId } }, bridgeConnection);
      case 'send': return send(sessionId, 'send', request.input, undefined, 'human', bridgeConnection);
      case 'reply': return replyInteraction({
        sessionId,
        requestId: request.requestId,
        type: request.type,
        ...(request.type === 'approval'
          ? {
              decision: request.decision,
              ...(request.rememberScope === undefined ? {} : { rememberScope: request.rememberScope }),
              ...(request.rememberTarget === undefined ? {} : { rememberTarget: request.rememberTarget }),
            }
          : { answers: request.answers }),
      }, 'human');
      case 'permission': return await host.handle({ method: 'permission.set', params: {
        sessionId,
        permissionProfile: request.permissionProfile,
        ...(request.permissionNetwork === undefined ? {} : { permissionNetwork: request.permissionNetwork }),
        ...(request.confirmFullAccess === undefined ? {} : { confirmFullAccess: request.confirmFullAccess }),
        ...(request.confirmNetwork === undefined ? {} : { confirmNetwork: request.confirmNetwork }),
        ...(request.confirmPartialWorkspaceWrite === undefined ? {} : { confirmPartialWorkspaceWrite: request.confirmPartialWorkspaceWrite }),
        ...(request.confirmWorkspaceTrust === undefined ? {} : { confirmWorkspaceTrust: request.confirmWorkspaceTrust }),
      } }, bridgeConnection);
      case 'cancel': {
        const found = active.get(sessionId);
        return found === undefined
          ? { sessionId, state: 'idle', terminated: true }
          : await cancelOperation(found.operationId, 'human', bridgeConnection);
      }
      case 'takeover': return await takeOverSession(sessionId);
    }
  }

  return {
    create: (root: string, initial?: McpInitialSettings) => session('session.create', root, undefined, initial),
    open: (root: string, sessionId: string) => session('session.open', root, sessionId),
    close: (sessionId: string) => closeSession(sessionId),
    configure,
    replyInteraction,
    send,
    async list(root: string, limit: number) {
      ready();
      await authorized(root);
      ready();
      const result = record(await tracked(host.handle({ method: 'sessions.list', params: { projectRoot, limit } }, connection)));
      if (!Array.isArray(result.sessions)) throw new KernelError('host_response_invalid');
      return { sessions: result.sessions.map((item: unknown) => {
        const entry = record(item);
        if (typeof entry.name !== 'string' || (entry.createdAt !== null && typeof entry.createdAt !== 'string')) {
          throw new KernelError('host_response_invalid');
        }
        return { sessionId: entry.id, name: entry.name.slice(0, 120), archived: entry.archived,
          createdAt: entry.createdAt === null ? null : entry.createdAt.slice(0, 128) };
      }) };
    },
    start(sessionId: string, input: string, delegation?: DelegationSpec, requestKey?: string) {
      writable(sessionId);
      const key = requestKey === undefined ? undefined : sessionId + ':' + requestKey;
      if (key !== undefined) {
        if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(requestKey!)) throw new KernelError('run_request_key_invalid');
        const digest = runPayloadDigest(input, delegation);
        const previous = keyedOperations.get(key);
        if (previous !== undefined) {
          if (previous.digest !== digest) throw new KernelError('run_request_conflict');
          return { ...status(previous.operation), reused: true };
        }
      }
      const queue = currentQueue(sessionId);
      if (queue.items.length > 0) throw new KernelError('session_queue_pending');
      queue.paused = false;
      const started = startOne(sessionId, input, undefined, delegation, 'controller', requestKey);
      if (key !== undefined) keyedOperations.set(key, { digest: runPayloadDigest(input, delegation), operation: started });
      return status(started);
    },
    async submit(sessionId: string, input: string, delegation?: DelegationSpec, requestKey?: string) {
      writable(sessionId);
      const queue = currentQueue(sessionId);
      if (queue.items.length > 0) throw new KernelError('session_queue_pending');
      const key = requestKey === undefined ? undefined : sessionId + ':' + requestKey;
      if (requestKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(requestKey)) throw new KernelError('run_request_key_invalid');
      const digest = runPayloadDigest(input, delegation);
      const previous = key === undefined ? undefined : keyedOperations.get(key);
      if (previous !== undefined) {
        if (previous.digest !== digest) throw new KernelError('run_request_conflict');
        if (previous.operation.accepted === undefined) throw new KernelError('run_already_running');
        const receipt = await previous.operation.accepted;
        return { ...status(previous.operation), receipt, reused: true };
      }
      queue.paused = false;
      const started = startOne(sessionId, input, undefined, delegation, 'controller', requestKey, true);
      if (key !== undefined) keyedOperations.set(key, { digest, operation: started });
      const receipt = await started.accepted!;
      return { ...status(started), receipt, reused: receipt.reused === true };
    },
    status(operationId: string, after = 0, limit = 20) {
      if (!Number.isSafeInteger(after) || after < 0) throw new KernelError('control_cursor_invalid');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new KernelError('control_event_limit_invalid');
      return status(operation(operationId), after, limit);
    },
    async await(operationId: string, timeoutMs = 60_000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
        throw new KernelError('control_wait_timeout_invalid');
      }
      const found = operation(operationId);
      if (found.state === 'running' && timeoutMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            found.settled,
            new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      return { ...status(found), timedOut: found.state === 'running' };
    },
    async getRun(sessionId: string, reference: { runId?: string; requestKey?: string }, offset?: number) {
      ready();
      await authorized(projectRoot);
      const channel = typeof reference.runId === 'string' && humanDeliveries.has(reference.runId)
        ? bridgeConnection : connection;
      const receipt = record(await tracked(host.handle({ method: 'run.receipt', params: {
        projectRoot, sessionId, ...reference,
      } }, channel)));
      if (offset === undefined) return { receipt };
      const page = record(await tracked(host.handle({ method: 'run.result', params: {
        projectRoot, sessionId, runId: receipt.runId, offset,
      } }, channel)));
      return { receipt, result: page };
    },
    cancel: (operationId: string) => cancelOperation(operationId),
    invalidate(code: string): Promise<void> {
      if (closing !== undefined) return closing;
      if (!/^[a-z][a-z0-9_]{0,79}$/.test(code)) throw new KernelError('control_error_code_invalid');
      closingCode = code;
      return this.release();
    },
    async read(sessionId: string, before: number | undefined, limit: number, at?: number, offset = 0) {
      owned(sessionId);
      if (offset > 0 && at === undefined) throw new KernelError('session_cursor_invalid');
      const result = record(await tracked(host.handle({ method: 'session.read', params: {
        sessionId, limit, fullResults: true,
        ...(before === undefined ? {} : { before }), ...(at === undefined ? {} : { at }),
      } }, connection)));
      if (!Array.isArray(result.events)) throw new KernelError('host_response_invalid');
      const entries: { seq: number; kind: unknown; json: string; offset: number; nextOffset: number | null; totalCharacters: number }[] = [];
      let characters = 0;
      for (const value of result.events.toReversed()) {
        const event = record(value);
        if (typeof event.seq !== 'number') throw new KernelError('host_response_invalid');
        const serialized = JSON.stringify(event);
        if (offset > serialized.length) throw new KernelError('session_cursor_invalid');
        const chunk = serialized.slice(offset, offset + 8192);
        if (entries.length > 0 && (characters + chunk.length > 16384 || chunk.length < serialized.length)) break;
        entries.unshift({ seq: event.seq, kind: event.kind, json: chunk, offset,
          nextOffset: offset + chunk.length < serialized.length ? offset + chunk.length : null,
          totalCharacters: serialized.length });
        characters += chunk.length;
        if (chunk.length < serialized.length) break;
      }
      return {
        sessionId, records: entries, nextBefore: entries[0]?.seq ?? null,
        hasMore: result.hasMore === true || entries.length < result.events.length,
        provisionalOutput: result.provisionalOutput ?? null,
        provisionalOutputError: result.provisionalOutputError ?? null,
      };
    },
    release(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        for (const operation of operations.values()) settleInteractions(operation, 'control_closed');
        for (const queue of queues.values()) queue.items.length = 0;
        // 在 Host 取消活动任务前先处理已完成任务的错误。
        const settled = Promise.allSettled([...operations.values()].map((found) => found.settled));
        try { await host.release(); }
        catch (error) { failures.push(error); }
        try { await localRuntime.close(); }
        catch (error) { failures.push(error); }
        try {
          await Promise.allSettled([...pending]);
          const results = await settled;
          for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
        } catch (error) {
          failures.push(error);
        } finally {
          sessions.clear();
        }
        if (failures.length > 0) throw failures[0];
      })();
      return closing;
    },
  };
}
