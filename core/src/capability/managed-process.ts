import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelError } from '../errors.js';
import type { Plugin } from '../kernel/assembly.js';
import type { Kernel, ToolDefinition } from '../kernel/kernel.js';
import { runManagedExec, type ExecRunContext, type ManagedExecLease } from './exec.js';

const MAX_LOG_BYTES = 16_384;
const STARTUP_TIMEOUT_MS = 20_000;
const READY_RETRY_DELAY_MS = 100;
const READY_REQUEST_TIMEOUT_MS = 750;
const STOP_ATTEMPT_TIMEOUT_MS = 5_000;
const STOP_RETRY_DELAY_MS = 100;
// A stop call retries settled failures; a timed-out request remains in-flight and is reused by later calls.
const MAX_SETTLED_STOP_FAILURES = 2;
const MAX_RETAINED_TERMINAL_ENTRIES = 128;

type ManagedProcessAction = 'start' | 'status' | 'logs' | 'stop';
type ManagedProcessArguments = {
  readonly action?: unknown;
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly id?: unknown;
  readonly readyUrl?: unknown;
};
type ProcessStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'stopped' | 'failed';

interface ProcessFailure {
  readonly code: string | null;
  readonly detail: string;
}

interface ManagedProcessEntry {
  readonly id: string;
  readonly port: number;
  readonly readyUrl: string;
  readonly lease: ManagedExecLease;
  readonly workspaceTrustedAtStart: boolean;
  status: ProcessStatus;
  stopping?: Promise<void>;
  stopRequest?: Promise<void>;
  stopOnAbort?: () => void;
  stopSignal?: AbortSignal;
  exitCode?: number;
  failure?: string;
  startupFailure?: ProcessFailure;
  terminationFailure?: ProcessFailure;
  terminationPending?: boolean;
  cleanupPending?: boolean;
  cleanupFailureCode?: string;
  terminalOrder?: number;
}

function errorCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function failureDetail(error: unknown): ProcessFailure {
  const code = errorCodeOf(error);
  return {
    code: typeof code === 'string' ? code : null,
    detail: error instanceof KernelError && error.detail !== undefined
      ? error.detail : error instanceof Error ? error.message : String(error),
  };
}

function formatFailure(error: ProcessFailure): string {
  return error.code === null ? error.detail : `${error.code}: ${error.detail}`;
}

function combinedStartFailure(entry: ManagedProcessEntry, startupError: unknown, terminationError: unknown): KernelError {
  const startup = failureDetail(startupError);
  const termination = failureDetail(terminationError);
  const stopState = failureState(terminationError);
  const stopDescription = stopState.terminationPending === true
    ? stopState.cleanupPending === true ? 'process-tree termination and resource cleanup' : 'process-tree termination'
    : 'resource cleanup';
  return new KernelError(startup.code ?? 'managed_process_start_failed', {
    cause: new AggregateError([startupError, terminationError], 'managed process startup and termination both failed'),
    detail: `managed process ${entry.id} startup failed (${formatFailure(startup)}); ${stopDescription} also failed (${formatFailure(termination)})`,
    diagnostics: startupError instanceof KernelError ? startupError.diagnostics : undefined,
  });
}

function failureState(error: unknown): Pick<ManagedProcessEntry, 'terminationPending' | 'cleanupPending' | 'cleanupFailureCode'> {
  const code = errorCodeOf(error);
  if (code === 'exec_termination_cleanup_failed') {
    return { terminationPending: true, cleanupPending: true, cleanupFailureCode: code };
  }
  if (code === 'exec_temp_cleanup_failed' || code === 'exec_script_snapshot_cleanup_failed' || code === 'exec_sandbox_cleanup_failed') {
    return { terminationPending: false, cleanupPending: true, cleanupFailureCode: code };
  }
  if (code === 'exec_cancelled' || code === 'exec_process_interrupted' || code === 'exec_spawn_failed' || code === 'exec_sandbox_setup_failed') {
    return { terminationPending: false, cleanupPending: false };
  }
  return { terminationPending: true, cleanupPending: false };
}

function applyFailureState(entry: ManagedProcessEntry, error: unknown): void {
  const state = failureState(error);
  entry.terminationPending = state.terminationPending;
  entry.cleanupPending = state.cleanupPending;
  if (state.cleanupFailureCode === undefined) delete entry.cleanupFailureCode;
  else entry.cleanupFailureCode = state.cleanupFailureCode;
}

function updateTerminationFailure(entry: ManagedProcessEntry, error: unknown): void {
  if (failureState(error).terminationPending === true) entry.terminationFailure = failureDetail(error);
  else delete entry.terminationFailure;
}

function terminalEntry(entry: ManagedProcessEntry): boolean {
  return entry.status === 'stopped' || entry.status === 'exited'
    || entry.status === 'failed' && entry.terminationPending !== true && entry.cleanupPending !== true;
}

function removeStopAbortListener(entry: ManagedProcessEntry): void {
  if (entry.stopOnAbort !== undefined && entry.stopSignal !== undefined) {
    entry.stopSignal.removeEventListener('abort', entry.stopOnAbort);
  }
  entry.stopOnAbort = undefined;
  entry.stopSignal = undefined;
}

function loopbackUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new KernelError('managed_process_url_invalid');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new KernelError('managed_process_url_invalid'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    || url.username !== '' || url.password !== '' || url.port === '') {
    throw new KernelError('managed_process_url_invalid', { detail: 'readiness checks must use an explicit HTTP loopback address and port' });
  }
  return url;
}

async function assertPortAvailable(url: URL): Promise<void> {
  const port = Number(url.port);
  const addresses = url.hostname === 'localhost' ? ['127.0.0.1', '::1']
    : url.hostname === '[::1]' ? ['::1'] : ['127.0.0.1'];
  for (const address of addresses) {
    const server = createServer();
    let listening = false;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => { listening = true; resolve(); });
    }).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'EADDRINUSE') {
        throw new KernelError('managed_process_port_in_use', { detail: `loopback port ${port} is already in use` });
      }
      if (url.hostname === 'localhost' && address === '::1'
        && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENOTSUP'].includes(String(code))) return;
      throw new KernelError('managed_process_port_check_failed', { cause: error });
    });
    if (!listening) continue;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function waitForReady(entry: ManagedProcessEntry, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const processExit = entry.lease.completion.then(() => ({ type: 'exit' as const }), () => ({ type: 'exit' as const }));
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new KernelError('exec_cancelled');
    if (entry.status !== 'starting') {
      throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(READY_REQUEST_TIMEOUT_MS, deadline - Date.now()));
    let response: Response | undefined;
    let requestFailed = false;
    let processExited = false;
    try {
      const outcome = await Promise.race([
        fetch(entry.readyUrl, {
          signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
          redirect: 'error',
        }).then(value => ({ type: 'response' as const, value })),
        processExit,
      ]);
      if (outcome.type === 'exit') {
        processExited = true;
        controller.abort();
      } else {
        response = outcome.value;
      }
    } catch {
      requestFailed = true;
    } finally {
      clearTimeout(timer);
    }
    if (signal?.aborted) throw new KernelError('exec_cancelled');
    if (processExited || entry.status !== 'starting') {
      throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
    }
    if (response !== undefined) {
      const ready = response.status >= 200 && response.status < 300;
      try { await response.body?.cancel(); }
      catch { requestFailed = true; }
      if (signal?.aborted) throw new KernelError('exec_cancelled');
      if (entry.status !== 'starting') {
        throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
      }
      if (ready && !requestFailed && Date.now() < deadline) {
        entry.status = 'running';
        return;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let exitedDuringDelay = false;
    try {
      const outcome = await Promise.race([
        delay(Math.min(READY_RETRY_DELAY_MS, remaining), undefined,
          signal === undefined ? undefined : { signal }).then(() => ({ type: 'retry' as const })),
        processExit,
      ]);
      exitedDuringDelay = outcome.type === 'exit';
    } catch (error) {
      if (signal?.aborted) throw new KernelError('exec_cancelled');
      throw error;
    }
    if (exitedDuringDelay || entry.status !== 'starting') {
      throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
    }
  }
  throw new KernelError('managed_process_not_ready', {
    detail: `no successful 2xx HTTP response was received from loopback port ${entry.port} within ${STARTUP_TIMEOUT_MS}ms`,
  });
}

function view(entry: ManagedProcessEntry) {
  return {
    id: entry.id,
    status: entry.status,
    terminationPending: entry.terminationPending === true,
    cleanupPending: entry.cleanupPending === true,
    ready: entry.status === 'running',
    port: entry.port,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    ...(entry.failure === undefined ? {} : { failure: entry.failure }),
    ...(entry.startupFailure === undefined ? {} : { startupFailure: entry.startupFailure }),
    ...(entry.terminationFailure === undefined ? {} : { terminationFailure: entry.terminationFailure }),
    logs: entry.lease.logs().slice(-MAX_LOG_BYTES),
  };
}

function stopEntry(entry: ManagedProcessEntry, onTerminal?: () => void): Promise<void> {
  if (terminalEntry(entry)) {
    onTerminal?.();
    return Promise.resolve();
  }
  if (entry.stopping !== undefined) return entry.stopping;
  entry.status = 'stopping';
  let stopping: Promise<void>;
  stopping = (async () => {
    let lastError: unknown;
    let settledStopFailures = 0;
    let confirmedExitCleanupPending = entry.cleanupPending === true && entry.terminationPending !== true;
    while (settledStopFailures < MAX_SETTLED_STOP_FAILURES) {
      if (terminalEntry(entry)) {
        onTerminal?.();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopRequest = entry.stopRequest ?? Promise.resolve().then(() => entry.lease.stop());
      if (entry.stopRequest === undefined) {
        entry.stopRequest = stopRequest;
        void stopRequest.then(() => {
          if (entry.stopRequest === stopRequest) entry.stopRequest = undefined;
          removeStopAbortListener(entry);
          entry.terminationPending = false;
          entry.cleanupPending = false;
          delete entry.cleanupFailureCode;
          delete entry.terminationFailure;
          if (entry.status !== 'exited') entry.status = 'stopped';
          onTerminal?.();
        }, () => {
          if (entry.stopRequest === stopRequest) entry.stopRequest = undefined;
        });
      }
      const timeout = new Promise<{ readonly type: 'timeout' }>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout({ type: 'timeout' }), STOP_ATTEMPT_TIMEOUT_MS);
      });
      let outcome: { readonly type: 'stopped' | 'completion' }
        | { readonly type: 'failed'; readonly error: unknown }
        | { readonly type: 'completion_failure'; readonly error: unknown }
        | { readonly type: 'timeout' };
      const stopOutcome = stopRequest.then(
        () => ({ type: 'stopped' as const }),
        (error: unknown) => ({ type: 'failed' as const, error }),
      );
      const completionOutcome = confirmedExitCleanupPending ? undefined : entry.lease.completion.then(
        () => ({ type: 'completion' as const }),
        (error: unknown) => errorCodeOf(error) === 'exec_cancelled'
          ? ({ type: 'completion' as const })
          : ({ type: 'completion_failure' as const, error }),
      );
      try {
        outcome = await Promise.race([
          stopOutcome,
          timeout,
          ...(completionOutcome === undefined ? [] : [completionOutcome]),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (outcome.type === 'stopped' || outcome.type === 'completion') {
        removeStopAbortListener(entry);
        if (!terminalEntry(entry)) {
          entry.terminationPending = false;
          entry.cleanupPending = false;
          delete entry.cleanupFailureCode;
          delete entry.terminationFailure;
          entry.status = 'stopped';
        }
        onTerminal?.();
        return;
      }
      if (outcome.type === 'completion_failure') {
        const pending = failureState(outcome.error);
        if (pending.cleanupPending === true && pending.terminationPending !== true) {
          entry.status = 'failed';
          entry.failure = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          delete entry.terminationFailure;
          applyFailureState(entry, outcome.error);
          confirmedExitCleanupPending = true;
          continue;
        }
        entry.status = 'failed';
        entry.failure = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        applyFailureState(entry, outcome.error);
        updateTerminationFailure(entry, outcome.error);
        onTerminal?.();
        throw outcome.error;
      }
      lastError = outcome.type === 'failed' ? outcome.error : new KernelError('exec_terminate_failed', {
        detail: 'the managed process did not confirm termination before the stop deadline',
      });
      if (terminalEntry(entry)) {
        onTerminal?.();
        return;
      }
      if (outcome.type === 'timeout') {
        // The existing Lease.stop remains in flight; later close/stop calls reuse it instead of starting another request.
        break;
      }
      settledStopFailures += 1;
      if (settledStopFailures < MAX_SETTLED_STOP_FAILURES) await delay(STOP_RETRY_DELAY_MS);
    }
    if (confirmedExitCleanupPending) {
      entry.terminationPending = false;
      entry.cleanupPending = true;
      const cleanupErrorCode = entry.cleanupFailureCode ?? 'exec_temp_cleanup_failed';
      lastError = new KernelError(cleanupErrorCode, {
        cause: lastError,
        detail: 'the process exited, but resource cleanup did not finish before the stop deadline',
      });
      entry.cleanupFailureCode = cleanupErrorCode;
    } else applyFailureState(entry, lastError);
    entry.status = 'failed';
    entry.failure = lastError instanceof Error ? lastError.message : String(lastError);
    updateTerminationFailure(entry, lastError);
    onTerminal?.();
    throw lastError;
  })().finally(() => {
    if (entry.stopping === stopping) entry.stopping = undefined;
  });
  entry.stopping = stopping;
  return stopping;
}

export interface ManagedProcessRegistry {
  start(readyUrl: URL, lease: ManagedExecLease, signal?: AbortSignal, workspaceTrustedAtStart?: boolean): Promise<Record<string, unknown>>;
  status(id: string): Record<string, unknown>;
  logs(id: string): Record<string, unknown>;
  stop(id: string): Promise<Record<string, unknown>>;
  stopAll(): Promise<void>;
  stopWorkspaceTrusted(): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedProcessRegistryOptions {
  readonly validateOwner?: () => Promise<void>;
  readonly validateWorkspaceTrust?: () => Promise<void>;
}

export function createManagedProcessRegistry(options: ManagedProcessRegistryOptions = {}): ManagedProcessRegistry {
  const entries = new Map<string, ManagedProcessEntry>();
  let closed = false;
  let ownerCheck: NodeJS.Timeout | undefined;
  let checkingOwner = false;
  let nextTerminalOrder = 0;

  function pruneTerminalEntries(): void {
    const terminal = [...entries.entries()].filter(([, entry]) => terminalEntry(entry));
    for (const [, entry] of terminal) entry.terminalOrder ??= nextTerminalOrder++;
    terminal.sort((left, right) => (left[1].terminalOrder ?? 0) - (right[1].terminalOrder ?? 0));
    while (terminal.length > MAX_RETAINED_TERMINAL_ENTRIES) {
      const [id] = terminal.shift()!;
      entries.delete(id);
    }
  }

  function get(id: string): ManagedProcessEntry {
    const entry = entries.get(id);
    if (entry === undefined) throw new KernelError('managed_process_not_found');
    return entry;
  }

  function watchCompletion(entry: ManagedProcessEntry): void {
    void entry.lease.completion.then((exitCode) => {
      removeStopAbortListener(entry);
      if (entry.status === 'stopping' || entry.status === 'stopped') return;
      entry.exitCode = exitCode;
      entry.terminationPending = false;
      entry.cleanupPending = false;
      delete entry.cleanupFailureCode;
      delete entry.terminationFailure;
      entry.status = 'exited';
      pruneTerminalEntries();
    }, (error: unknown) => {
      removeStopAbortListener(entry);
      if (entry.status === 'stopping' || entry.status === 'stopped') return;
      entry.status = 'failed';
      entry.failure = error instanceof Error ? error.message : String(error);
      applyFailureState(entry, error);
      updateTerminationFailure(entry, error);
      pruneTerminalEntries();
    });
  }

  async function stopAll(): Promise<void> {
    const outcomes = await Promise.allSettled([...entries.values()].map((entry) => stopEntry(entry, pruneTerminalEntries)));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async function stopWorkspaceTrusted(): Promise<void> {
    const outcomes = await Promise.allSettled([...entries.values()]
      .filter((entry) => entry.workspaceTrustedAtStart)
      .map(async (entry) => {
        if (terminalEntry(entry)) return;
        entry.failure = 'workspace trust was revoked';
        try { await stopEntry(entry, pruneTerminalEntries); }
        catch (error) {
          entry.status = 'failed';
          entry.failure = `workspace trust was revoked; process-tree shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
          throw error;
        }
      }));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async function stopAfterOwnerInvalidation(): Promise<void> {
    for (const entry of entries.values()) {
      if (terminalEntry(entry)) continue;
      entry.failure = 'the owning Session Grant is no longer valid';
      try { await stopEntry(entry, pruneTerminalEntries); }
      catch (error) {
        entry.status = 'failed';
        entry.failure = `the owning Session Grant is no longer valid; process-tree shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  return {
    async start(readyUrl, lease, signal, workspaceTrustedAtStart = false) {
      const entry: ManagedProcessEntry = {
        id: randomUUID(),
        port: Number(readyUrl.port),
        readyUrl: readyUrl.href,
        lease,
        workspaceTrustedAtStart,
        status: 'starting',
      };
      entries.set(entry.id, entry);
      watchCompletion(entry);
      if (closed || signal?.aborted) {
        const startupError = new KernelError(closed ? 'managed_process_owner_closed' : 'exec_cancelled');
        entry.startupFailure = failureDetail(startupError);
        try { await stopEntry(entry, pruneTerminalEntries); }
        catch (terminationError) {
          throw combinedStartFailure(entry, startupError, terminationError);
        }
        entries.delete(entry.id);
        throw startupError;
      }
      const stopOnAbort = (): void => {
        removeStopAbortListener(entry);
        void stopEntry(entry, pruneTerminalEntries).catch(() => undefined);
      };
      entry.stopOnAbort = stopOnAbort;
      entry.stopSignal = signal;
      signal?.addEventListener('abort', stopOnAbort, { once: true });
      const validateOwner = options.validateOwner;
      const validateWorkspaceTrust = options.validateWorkspaceTrust;
      if ((validateOwner !== undefined || validateWorkspaceTrust !== undefined && workspaceTrustedAtStart) && ownerCheck === undefined) {
        ownerCheck = setInterval(() => {
          if (checkingOwner || closed) return;
          checkingOwner = true;
          void (async () => {
            await validateOwner?.();
            if (validateWorkspaceTrust !== undefined
              && [...entries.values()].some((item) => item.workspaceTrustedAtStart
                && !terminalEntry(item))) {
              try { await validateWorkspaceTrust(); }
              catch { await stopWorkspaceTrusted().catch(() => undefined); }
            }
          })().catch(stopAfterOwnerInvalidation).finally(() => { checkingOwner = false; });
        }, 1_000);
        ownerCheck.unref();
      }
      try {
        await waitForReady(entry, signal);
      } catch (error) {
        entry.startupFailure = failureDetail(error);
        try { await stopEntry(entry, pruneTerminalEntries); }
        catch (terminationError) { throw combinedStartFailure(entry, error, terminationError); }
        throw error;
      }
      return view(entry);
    },
    status(id) {
      return view(get(id));
    },
    logs(id) {
      const entry = get(id);
      return { id: entry.id, status: entry.status, logs: entry.lease.logs().slice(-MAX_LOG_BYTES) };
    },
    async stop(id) {
      const entry = get(id);
      await stopEntry(entry, pruneTerminalEntries);
      return view(entry);
    },
    stopAll,
    stopWorkspaceTrusted,
    async close() {
      closed = true;
      if (ownerCheck !== undefined) clearInterval(ownerCheck);
      await stopAll();
    },
  };
}

export function managedProcessTool(registry: ManagedProcessRegistry): ToolDefinition {
  return {
    name: 'managed_process',
    access: 'exec',
    commandArgument: 'command',
    capability: () => 'exec',
    description: 'Start, inspect, read bounded logs from, or stop a long-running local process owned by this Session. Start requires an HTTP loopback health URL that returns a 2xx response when ready.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'logs', 'stop'] },
        command: { type: 'string', description: 'The command to start. Required only for action=start.' },
        cwd: { type: 'string', description: 'Optional working directory inside the workspace boundary.' },
        id: { type: 'string', description: 'Managed process handle returned by action=start.' },
        readyUrl: { type: 'string', description: 'HTTP loopback health URL; the server is ready only after it returns a 2xx response.' },
      },
      required: ['action'],
    },
    async preflight(value) {
      const args = value as ManagedProcessArguments;
      if (args.action === 'start') {
        if (typeof args.command !== 'string' || args.command.trim() === '') throw new KernelError('managed_process_command_required');
        const url = loopbackUrl(args.readyUrl);
        await assertPortAvailable(url);
        if (args.cwd !== undefined && typeof args.cwd !== 'string') throw new KernelError('managed_process_cwd_invalid');
        return;
      }
      if (args.action !== 'status' && args.action !== 'logs' && args.action !== 'stop') throw new KernelError('managed_process_action_invalid');
      if (typeof args.id !== 'string' || args.id.trim() === '') throw new KernelError('managed_process_id_required');
    },
    async run(value, context) {
      const args = value as ManagedProcessArguments;
      switch (args.action as ManagedProcessAction) {
        case 'start': {
          const readyUrl = loopbackUrl(args.readyUrl);
          return runManagedExec({ command: args.command, ...(args.cwd === undefined ? {} : { cwd: args.cwd as string }) },
            context as ExecRunContext, (lease) => registry.start(readyUrl, lease, context.signal, context.permission.workspaceTrusted));
        }
        case 'status': return registry.status(args.id as string);
        case 'logs': return registry.logs(args.id as string);
        case 'stop': return registry.stop(args.id as string);
        default: throw new KernelError('managed_process_action_invalid');
      }
    },
  };
}

export function managedProcessPlugin(registry = createManagedProcessRegistry()): Plugin<Kernel> {
  const tool = managedProcessTool(registry);
  return {
    name: 'ligule-managed-process',
    setup(kernel) {
      return kernel.register(tool);
    },
  };
}
