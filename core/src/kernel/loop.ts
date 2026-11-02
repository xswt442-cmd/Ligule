// 循环负责限制迭代次数和模型请求预算，并使用 AbortSignal 处理取消。
// Host 配置哪些工具会结束本轮；该信息不暴露给模型。
// 提供方通过统一接口接入，服务地址来自配置，凭据通过环境变量解析。
import { KernelError, KernelRuntimeError } from './error.js';
import { usageEvent, type ProviderUsageEvent } from '../session/usage.js';
import { failureOf } from './result.js';
import { rememberRunSummary, type RunSummary } from './run-summary.js';
import type { TaskBudget } from './task-budget.js';
import type { RunResultRef } from '../session/run.js';
import { isFileArtifact, type FileArtifact } from '../session/artifact.js';
import type { Kernel } from './kernel.js';
import type { PromptAssembly } from './prompt.js';
import type { StreamDraftWriter } from '../session/stream-draft.js';
import { checkedImageReferences, type ImageReference } from '../media.js';
import { randomUUID } from 'node:crypto';
import { emitTelemetry, telemetryEnabled, withTelemetryContext, type Telemetry } from './telemetry.js';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args?: unknown;
}

export type ModelMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly toolCalls?: readonly ToolCall[]; readonly reasoning?: string }
  | { readonly role: 'tool'; readonly id?: string; readonly tool?: string; readonly content: unknown; readonly images?: readonly ImageReference[]; readonly failed?: boolean; readonly code?: string };

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface ModelRequest {
  readonly system: string;
  readonly tools: readonly ModelTool[];
  readonly messages: readonly ModelMessage[];
  readonly resolveImage?: (reference: ImageReference, signal?: AbortSignal) => Promise<Buffer>;
}

export type ProviderEvent =
  | { readonly type: 'text' | 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly args: unknown }
  | ProviderUsageEvent
  | { readonly type: 'finish'; readonly reason: 'stop' | 'tool_calls' | 'length' | 'max_tokens' };

export interface ModelProvider {
  readonly imageInput?: boolean;
  readonly requiresCompletion?: true;
  readonly maxOutputTokens?: number;
  stream(request: ModelRequest, options?: { readonly signal?: AbortSignal }): AsyncIterable<ProviderEvent>;
}

export interface LoopSession {
  append(event: Record<string, unknown>): Promise<unknown>;
  modelView(): Promise<unknown[]>;
  beginOutput?(userSeq: number | undefined, onFailure: (error: KernelRuntimeError) => void): StreamDraftWriter;
}

export interface LoopLimits {
  readonly iterations: number;
  readonly modelCalls: number;
  readonly maxParallelTools?: number;
}

export interface LoopCompaction {
  prepare(request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[]>;
  recover(error: unknown, request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[] | null>;
  observe(request: LoopCompactionRequest, events: ProviderEvent[]): Promise<void>;
}

export interface LoopCompactionRequest {
  readonly system: string;
  readonly tools: unknown;
  readonly messages: unknown[];
}

export interface LoopOptions {
  readonly kernel: Kernel;
  readonly provider: ModelProvider;
  readonly prompt?: Pick<PromptAssembly, 'render'>;
  readonly session?: LoopSession;
  readonly limits?: LoopLimits;
  readonly completesRun?: readonly string[];
  readonly compaction?: LoopCompaction | null;
  readonly turnContext?: (() => Record<string, unknown>) | null;
  readonly onProgress?: (event: LoopProgressEvent) => void;
  readonly resolveImage?: ModelRequest['resolveImage'];
  readonly telemetry?: Telemetry;
  readonly sessionId?: string;
  readonly parentRunId?: string;
  readonly parentExecutionId?: string;
  readonly parentCallId?: string;
  readonly telemetryModel?: () => { readonly provider?: string; readonly model?: string };
}

export type LoopProgressPhase = 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';

export type LoopProgressEvent =
  | { readonly kind: 'phase'; readonly phase: LoopProgressPhase; readonly modelCalls: number; readonly toolCalls: number }
  | { readonly kind: 'activity'; readonly phase: LoopProgressPhase; readonly activity: 'model_output' | 'tool'; readonly modelCalls: number; readonly toolCalls: number };

export interface LoopResult extends RunSummary {
  readonly completedBy?: string;
}

export interface LoopRunOptions {
  readonly task?: TaskBudget;
  readonly runId?: string;
  readonly onAccepted?: (userSeq: number) => void;
  readonly persistTerminal?: (status: 'completed' | 'failed' | 'cancelled', summary: RunSummary, fields: Record<string, unknown>) => Promise<RunResultRef>;
  readonly signal?: AbortSignal;
  readonly user?: Record<string, unknown>;
  readonly onProgress?: (event: LoopProgressEvent) => void;
  readonly completesRun?: readonly string[];
  readonly turnContext?: Record<string, unknown>;
  // 校验通过后才记录成功终态；抛出的领域错误由本轮统一写入失败终态。
  readonly validateCompletion?: () => void;
}

type TurnStatus = 'completed' | 'cancelled' | 'failed';

function sequenceOf(event: unknown): number | undefined {
  return typeof event === 'object' && event !== null && 'seq' in event && typeof event.seq === 'number'
    ? event.seq
    : undefined;
}

function isToolCall(value: unknown): value is ToolCall {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string';
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (typeof value !== 'object' || value === null || !('role' in value)) return false;
  if (value.role === 'user') return 'text' in value && typeof value.text === 'string';
  if (value.role === 'assistant') {
    if (!('text' in value) || typeof value.text !== 'string') return false;
    if ('reasoning' in value && value.reasoning !== undefined && typeof value.reasoning !== 'string') return false;
    return !('toolCalls' in value) || value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall));
  }
  if (value.role !== 'tool' || ('id' in value && value.id !== undefined && typeof value.id !== 'string') || !('content' in value)) return false;
  if ('images' in value && value.images !== undefined) checkedImageReferences(value.images);
  return true;
}

function modelMessagesOf(values: readonly unknown[]): ModelMessage[] {
  return values.map((value) => {
    if (!isModelMessage(value)) throw new TypeError('the session model view contains an invalid message');
    return value;
  });
}

export const DEFAULT_LOOP_LIMITS = Object.freeze({ iterations: 64, modelCalls: 64, maxParallelTools: 4 }) satisfies LoopLimits;
export const MAX_PARALLEL_TOOLS = 32;

const TURN_CANCEL_CODES = new Set(['provider_cancelled', 'loop_cancelled', 'ask_user_cancelled', 'task_cancelled']);

function failureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'loop_failed';
  if ('code' in error && typeof error.code === 'string' && error.code !== '') return error.code;
  if ('name' in error && error.name === 'AbortError') return 'provider_cancelled';
  return 'loop_failed';
}

// 连续的并发调用组成一组并同时启动；串行调用各自成组，形成顺序边界。
interface CallGroup {
  readonly parallel: boolean;
  readonly calls: ToolCall[];
}

function groupCalls(calls: readonly ToolCall[], executionOf: (name: string) => 'parallel' | 'serial', completing: ReadonlySet<string>): CallGroup[] {
  const groups: CallGroup[] = [];
  for (const call of calls) {
    const parallel = !completing.has(call.name) && executionOf(call.name) === 'parallel';
    const last = groups[groups.length - 1];
    if (parallel && last?.parallel) last.calls.push(call);
    else groups.push({ parallel, calls: [call] });
  }
  return groups;
}

async function executeGroup(kernel: Kernel, group: CallGroup, signal: AbortSignal, maximum: number, task: TaskBudget | undefined,
  telemetry: Telemetry | undefined, executionId: string, runId: string | undefined, sessionId: string | undefined,
  userSeq: number | undefined, parentExecutionId: string | undefined, parentRunId: string | undefined, parentCallId: string | undefined) {
  const settled: PromiseSettledResult<unknown>[] = [];
  const pending = new Map<number, Promise<number>>();
  let started = 0;
  let fatal = false;
  let exclusive = false;
  while (started < group.calls.length || pending.size > 0) {
    while (!signal.aborted && !fatal && !exclusive && started < group.calls.length && pending.size < maximum) {
      const call = group.calls[started];
      const parallel = group.parallel && kernel.execution(call.name) === 'parallel';
      if (!parallel && pending.size > 0) break;
      const index = started++;
      exclusive = !parallel;
      const invoke = telemetryEnabled(telemetry) ? async () => {
        const startedAt = process.hrtime.bigint();
        const context = { executionId, runId, sessionId, userSeq, callId: call.id, parentExecutionId, parentRunId, parentCallId };
        emitTelemetry(telemetry, { type: 'tool.started', executionId, ...(runId === undefined ? {} : { runId }),
          ...(sessionId === undefined ? {} : { sessionId }), ...(userSeq === undefined ? {} : { userSeq }), callId: call.id, tool: call.name });
        try {
          const value = await withTelemetryContext(context, () => kernel.call(call.name, call.args,
            { signal, callId: call.id, executionId, ...(runId === undefined ? {} : { runId }) }));
          emitTelemetry(telemetry, { type: 'tool.finished', executionId, ...(runId === undefined ? {} : { runId }), ...(sessionId === undefined ? {} : { sessionId }),
            ...(userSeq === undefined ? {} : { userSeq }), callId: call.id, tool: call.name,
            durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n), outcome: 'success' });
          return value;
        } catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
          const refused = typeof code === 'string' && (code.startsWith('policy_') || code.startsWith('permission_')
            || code === 'tool_denied' || code === 'ask_declined' || code === 'controller_declined'
            || code === 'browser_tool_denied' || code === 'mcp_server_untrusted' || code === 'mcp_tool_denied');
          emitTelemetry(telemetry, { type: 'tool.finished', executionId, ...(runId === undefined ? {} : { runId }), ...(sessionId === undefined ? {} : { sessionId }),
            ...(userSeq === undefined ? {} : { userSeq }), callId: call.id, tool: call.name,
            durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
            outcome: signal.aborted ? 'cancelled' : refused ? 'refused' : 'failure',
            ...(typeof code === 'string' ? { errorCode: code } : {}) });
          throw error;
        }
      } : () => kernel.call(call.name, call.args, { signal, callId: call.id });
      pending.set(index, (task === undefined ? invoke() : task.runWork(invoke)).then(
        value => { settled[index] = { status: 'fulfilled', value }; return index; },
        reason => {
          settled[index] = { status: 'rejected', reason };
          if (!(reason instanceof KernelError) || reason instanceof KernelRuntimeError) fatal = true;
          return index;
        },
      ));
    }
    if (pending.size === 0) break;
    const index = await Promise.race(pending.values());
    pending.delete(index);
    exclusive = false;
  }
  return { settled, started };
}

// 返回指定组中从 `index` 开始尚未执行的调用。
function restOf(groups: readonly CallGroup[], groupIndex: number, index = -1): ToolCall[] {
  return groups.slice(groupIndex).flatMap((group, offset) => group.calls.slice(offset === 0 ? index + 1 : 0));
}

export function createLoop({
  kernel, provider, prompt, session, limits = DEFAULT_LOOP_LIMITS, completesRun = [], compaction = null, turnContext = null, onProgress, resolveImage,
  telemetry, sessionId, parentRunId, parentExecutionId, parentCallId, telemetryModel,
}: LoopOptions) {
  if (typeof provider?.stream !== 'function') throw new KernelError('loop_provider_required');
  const maxParallelTools = limits.maxParallelTools ?? DEFAULT_LOOP_LIMITS.maxParallelTools;
  if (!Number.isSafeInteger(maxParallelTools) || maxParallelTools < 1 || maxParallelTools > MAX_PARALLEL_TOOLS) {
    throw new KernelError('loop_parallel_limit_invalid', {
      detail: `maxParallelTools must be an integer between 1 and ${MAX_PARALLEL_TOOLS}`,
    });
  }
  const completing = new Set(completesRun);

  return {
    // 为本轮创建独立取消信号，并将取消传递给工具和模型提供方。
    // `options.user` 中的元数据只写入记录；模型仍接收 `input` 中的文本。
    async run(input: string, runOptions: LoopRunOptions = {}): Promise<LoopResult> {
      const observing = telemetryEnabled(telemetry);
      const telemetryExecutionId = observing ? randomUUID() : undefined;
      const telemetryStartedAt = observing ? process.hrtime.bigint() : 0n;
      let telemetryFinished = false;
      let calls = 0;
      let toolCallCount = 0;
      let userSeq: number | undefined;
      const finishTelemetry = (status: TurnStatus, code?: string) => {
        if (!observing || telemetryExecutionId === undefined || telemetryFinished) return;
        telemetryFinished = true;
        emitTelemetry(telemetry, { type: 'run.finished', executionId: telemetryExecutionId,
          ...(runOptions.runId === undefined ? {} : { runId: runOptions.runId }),
          ...(sessionId === undefined ? {} : { sessionId }), ...(userSeq === undefined ? {} : { userSeq }), status,
          durationMs: Number((process.hrtime.bigint() - telemetryStartedAt) / 1_000_000n),
          modelCalls: calls, toolCalls: toolCallCount, ...(code === undefined ? {} : { errorCode: code }) });
      };
      const telemetryModelIdentity = () => {
        try { return telemetryModel?.() ?? {}; } catch { return {}; }
      };
      const finishModelTelemetry = (startedAt: bigint, events: readonly ProviderEvent[], requestId: string,
        logicalRequestId: string, attempt: number, error?: unknown) => {
        if (!observing || telemetryExecutionId === undefined) return;
        const identity = telemetryModelIdentity();
        const usage = [...events].reverse().find((event) => event.type === 'usage');
        const finish = events.findLast((event) => event.type === 'finish');
        const cache = usage?.type === 'usage' ? usage.cache : undefined;
        const errorCode = error === undefined ? undefined : failureCode(error);
        const status = error === undefined ? 'completed'
          : ['provider_cancelled', 'loop_cancelled', 'task_cancelled'].includes(errorCode ?? '') ? 'cancelled' : 'failed';
        emitTelemetry(telemetry, { type: 'model.finished', executionId: telemetryExecutionId,
          ...(runOptions.runId === undefined ? {} : { runId: runOptions.runId }),
          ...(sessionId === undefined ? {} : { sessionId }), ...(userSeq === undefined ? {} : { userSeq }),
          requestId, logicalRequestId, attempt, ...identity,
          durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
          status,
          ...(usage?.type === 'usage' && typeof usage.input === 'number' ? { inputTokens: usage.input } : {}),
          ...(usage?.type === 'usage' && typeof usage.output === 'number' ? { outputTokens: usage.output } : {}),
          ...(cache === undefined ? {} : { cacheSource: cache.source,
            ...(cache.sourceFields.length === 0 ? {} : { cacheSourceFields: cache.sourceFields.map(field => field.field).join(',') }),
            ...(cache.hitInputTokens === null ? {} : { cacheHitInputTokens: cache.hitInputTokens }),
            ...(cache.missInputTokens === null ? {} : { cacheMissInputTokens: cache.missInputTokens }),
            ...(cache.creationInputTokens === null ? {} : { cacheCreationInputTokens: cache.creationInputTokens }),
            ...(cache.uncachedInputTokens === null ? {} : { cacheUncachedInputTokens: cache.uncachedInputTokens }),
            providerInputIncludesCache: cache.providerInputIncludesCache,
            ...(cache.consistent === null ? {} : { cacheConsistent: cache.consistent }) }),
          ...(error === undefined ? { finishReason: finish?.type === 'finish' ? finish.reason : 'unknown' }
            : (errorCode === undefined ? {} : { errorCode })) });
      };
      const startCompactionTelemetry = (operation: 'prepare' | 'recover' | 'explicit', inputMessages: number) => {
        if (!observing || telemetryExecutionId === undefined) return undefined;
        const operationId = randomUUID();
        const startedAt = process.hrtime.bigint();
        emitTelemetry(telemetry, { type: 'compaction.started', executionId: telemetryExecutionId,
          ...(runOptions.runId === undefined ? {} : { runId: runOptions.runId }),
          ...(sessionId === undefined ? {} : { sessionId }), ...(userSeq === undefined ? {} : { userSeq }),
          operationId, operation, inputMessages });
        return (status: 'completed' | 'unchanged' | 'failed' | 'cancelled', outputMessages?: number, error?: unknown) => {
          emitTelemetry(telemetry, { type: 'compaction.finished', executionId: telemetryExecutionId,
            ...(runOptions.runId === undefined ? {} : { runId: runOptions.runId }),
            ...(sessionId === undefined ? {} : { sessionId }), ...(userSeq === undefined ? {} : { userSeq }),
            operationId, operation, status,
            durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n), inputMessages,
            ...(outputMessages === undefined ? {} : { outputMessages }),
            ...(error === undefined ? {} : { errorCode: failureCode(error) }) });
        };
      };
      const loopWork = runOptions.task?.startWork();
      const { signal, user, onProgress: runProgress, completesRun: runCompletes, turnContext: runTurnContext } = runOptions;
      const progress = runProgress ?? onProgress;
      const completingThisRun = new Set([...completing, ...(runCompletes ?? [])]);
      const controller = new AbortController();
      const forward = () => controller.abort(signal?.reason);
      const taskSignal = runOptions.task?.signal;
      const forwardTask = () => controller.abort(taskSignal?.reason);
      if (signal?.aborted) forward();
      else signal?.addEventListener('abort', forward, { once: true });
      if (taskSignal?.aborted) forwardTask();
      else taskSignal?.addEventListener('abort', forwardTask, { once: true });
      let iterations = 0;
      let text = '';
      let phase: LoopProgressPhase = 'preparing';
      let terminalAttempted = false;
      let overflowRecoveryTried = false;
      let draft: StreamDraftWriter | undefined;
      const artifacts = new Map<string, FileArtifact>();
      let artifactsTruncated = false;
      const summary = () => ({ text, iterations, modelCalls: calls,
        ...(userSeq === undefined ? {} : { userSeq }),
        ...(artifacts.size === 0 ? {} : { artifacts: [...artifacts.values()] }),
        ...(artifactsTruncated ? { artifactsTruncated: true as const } : {}),
        ...(runOptions.task === undefined ? {} : { task: runOptions.task.snapshot() }),
      });
      const cancelled = () => controller.signal.reason instanceof KernelError && controller.signal.reason.code.startsWith('task_')
        ? controller.signal.reason : new KernelError('loop_cancelled');

      // 每个已返回给模型的工具调用都必须有对应结果，否则后续模型请求会因调用未完成而被拒绝。
      // 未执行的调用也要写入错误结果，保持记录结构完整。
      async function answerRemaining(skipped: readonly ToolCall[], content: string): Promise<void> {
        if (!session) return;
        for (const call of skipped) {
          await session.append({
            kind: 'tool', tool: call.name, callId: call.id, args: call.args,
            result: failureOf('tool_skipped', { content }),
          });
        }
      }

      // 将本轮用户输入写入记录，以便之后重建模型上下文。
      // 用户事件序号用于关联轮次完成状态和分支位置。
      // 每轮只写一条可忽略的终态事件；该事件不进入模型投影或检查点哈希。
      async function markTurn(status: TurnStatus, fields: Record<string, unknown> = {}): Promise<void> {
        if (!session || userSeq === undefined || terminalAttempted) return;
        terminalAttempted = true;
        let resultRef: RunResultRef | undefined;
        if (runOptions.runId !== undefined && runOptions.persistTerminal !== undefined) {
          try { resultRef = await runOptions.persistTerminal(status, summary(), fields); }
          catch (cause) {
            await session.append({ kind: 'turn', ignorable: true, status: 'failed', userSeq,
              iterations, modelCalls: calls, runId: runOptions.runId, code: 'run_result_write_failed' });
            throw new KernelError('run_result_write_failed', { cause });
          }
        }
        await session.append({
          kind: 'turn', ignorable: true, status, userSeq, iterations, modelCalls: calls,
          ...(runOptions.runId === undefined ? {} : { runId: runOptions.runId }),
          ...(resultRef === undefined ? {} : { resultRef }),
          ...(runOptions.task === undefined ? {} : { task: runOptions.task.snapshot() }), ...fields,
        });
      }

      function reportPhase(next: LoopProgressPhase): void {
        phase = next;
        progress?.({ kind: 'phase', phase, modelCalls: calls, toolCalls: toolCallCount });
      }

      function reportActivity(activity: 'model_output' | 'tool'): void {
        progress?.({ kind: 'activity', phase, activity, modelCalls: calls, toolCalls: toolCallCount });
      }

      try {
        if (session) {
          userSeq = sequenceOf(await session.append({ kind: 'user', text: input, ...user }));
          if (userSeq !== undefined) runOptions.onAccepted?.(userSeq);
        }
        if (observing && telemetryExecutionId !== undefined) emitTelemetry(telemetry, { type: 'run.started', executionId: telemetryExecutionId,
          ...(runOptions.runId === undefined ? {} : { runId: runOptions.runId }),
          ...(sessionId === undefined ? {} : { sessionId }), ...(userSeq === undefined ? {} : { userSeq }),
          ...(parentExecutionId === undefined ? {} : { parentExecutionId }), ...(parentRunId === undefined ? {} : { parentRunId }),
          ...(parentCallId === undefined ? {} : { parentCallId }) });
        // 用户事件写入后若快照失败，记录本轮失败终态。Host 在接受输入前失败时没有事件序号，不写终态事件。
        if (session && (turnContext !== null || runTurnContext !== undefined)) {
          await session.append({ kind: 'turnContext', ignorable: true, userSeq, ...(turnContext?.() ?? {}), ...(runTurnContext ?? {}) });
        }
        for (let iteration = 1; iteration <= limits.iterations; iteration += 1) {
          if (controller.signal.aborted) throw cancelled();
          reportPhase('preparing');
          if (calls >= limits.modelCalls) throw new KernelError('loop_model_budget_exhausted');
          iterations = iteration;
          calls += 1;

          const events = [];
          const system = prompt?.render() ?? '';
          const tools = kernel.manifest();
          let messages: unknown[] = session ? await session.modelView() : [{ role: 'user', text: input }];
          // 请求构造完成后、发送前检查上下文压力；超出阈值时压缩一次并重新构造请求。
          if (compaction !== null) {
            const finishCompaction = startCompactionTelemetry('prepare', messages.length);
            const beforeMessages = messages;
            try {
              messages = await compaction.prepare({ system, tools, messages }, controller.signal);
              const changed = messages.length !== beforeMessages.length || messages.some((message, index) => message !== beforeMessages[index]);
              finishCompaction?.(changed ? 'completed' : 'unchanged', messages.length);
            } catch (error) {
              finishCompaction?.(controller.signal.aborted ? 'cancelled' : 'failed', undefined, error);
              throw error;
            }
          }
          // 在流式接收期间逐步组装模型发起的工具调用。
          const logicalRequestId = observing ? randomUUID() : undefined;
          for (let attempt = 0; ; attempt += 1) {
            const modelStartedAt = observing ? process.hrtime.bigint() : 0n;
            const requestId = observing ? randomUUID() : undefined;
            const providerAttempt = attempt + 1;
            const identity = telemetryModelIdentity();
            if (requestId !== undefined && logicalRequestId !== undefined && telemetryExecutionId !== undefined) {
              emitTelemetry(telemetry, { type: 'model.started', executionId: telemetryExecutionId,
                ...(runOptions.runId === undefined ? {} : { runId: runOptions.runId }),
                ...(sessionId === undefined ? {} : { sessionId }), ...(userSeq === undefined ? {} : { userSeq }),
                requestId, logicalRequestId, attempt: providerAttempt, ...identity });
            }
            try {
              draft = session?.beginOutput?.(userSeq, error => controller.abort(error));
              reportPhase('model_request');
              for await (const event of provider.stream({ system, tools, messages: modelMessagesOf(messages),
                ...(resolveImage === undefined ? {} : { resolveImage }) }, { signal: controller.signal })) {
                if (event.type === 'tool-call') toolCallCount += 1;
                if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call') reportActivity('model_output');
                events.push(event);
                if (event.type === 'text' || event.type === 'reasoning') await draft?.append(event);
              }
              await draft?.flush();
              if (requestId !== undefined && logicalRequestId !== undefined) {
                finishModelTelemetry(modelStartedAt, events, requestId, logicalRequestId, providerAttempt);
              }
              break;
            } catch (error) {
              if (requestId !== undefined && logicalRequestId !== undefined) {
                finishModelTelemetry(modelStartedAt, events, requestId, logicalRequestId, providerAttempt, error);
              }
              if (draft?.failure !== undefined) error = draft.failure;
              // 服务端报告上下文超限后最多压缩并重试一次；无法压缩、已经重试或其他错误都返回原错误。
              let retried: unknown[] | null = null;
              if (attempt === 0 && compaction !== null && !overflowRecoveryTried) {
                overflowRecoveryTried = true;
                const finishCompaction = startCompactionTelemetry('recover', messages.length);
                try {
                  retried = await compaction.recover(error, { system, tools, messages }, controller.signal);
                  finishCompaction?.(retried === null ? 'unchanged' : 'completed', retried?.length);
                } catch (recoverError) {
                  finishCompaction?.(controller.signal.aborted ? 'cancelled' : 'failed', undefined, recoverError);
                  throw recoverError;
                }
              }
              if (retried === null) {
                const partialText = events.flatMap((event) => event.type === 'text' ? [event.text] : []).join('');
                if (partialText !== '') text = partialText;
                const partialReasoning = events.flatMap((event) => event.type === 'reasoning' ? [event.text] : []).join('');
                const partialCalls = events.flatMap((event) => event.type === 'tool-call'
                  ? [{ id: event.id, name: event.name, args: event.args ?? {} }]
                  : []);
                if (session && (partialText !== '' || partialReasoning !== '' || partialCalls.length > 0)) {
                  if (partialReasoning !== '') await session.append({ kind: 'reasoning', text: partialReasoning });
                  await session.append({ kind: 'assistant', text: partialText, toolCalls: partialCalls,
                    ...(draft === undefined ? {} : { responseId: draft.responseId }),
                    ...(partialReasoning === '' ? {} : { reasoning: partialReasoning }) });
                }
                const cleanup = await draft?.discard();
                if (cleanup !== undefined && session !== undefined) await session.append({ kind: 'streamDiagnostic', ignorable: true, code: cleanup.code });
                await answerRemaining(partialCalls, 'the provider response did not finish');
                throw controller.signal.aborted && controller.signal.reason instanceof KernelError
                  && controller.signal.reason.code.startsWith('task_') ? controller.signal.reason : error;
              }
              const cleanup = await draft?.discard();
              if (cleanup !== undefined && session !== undefined) await session.append({ kind: 'streamDiagnostic', ignorable: true, code: cleanup.code });
              events.length = 0;
              messages = retried;
            }
          }
          // 使用服务端报告的真实用量校准本地估算，并将用量事件写入记录供界面和恢复读取。
          if (compaction !== null) await compaction.observe({ system, tools, messages }, events);
          else if (session !== undefined) {
            const usage = usageEvent({ system, tools, messages }, events);
            if (usage !== null) await session.append(usage);
          }

          text = events.flatMap((event) => event.type === 'text' ? [event.text] : []).join('');
          const reasoning = events.flatMap((event) => event.type === 'reasoning' ? [event.text] : []).join('');
          const toolCalls = events.flatMap((event) => event.type === 'tool-call'
            ? [{ id: event.id, name: event.name, args: event.args ?? {} }]
            : []);
          // 推理事件写入记录供界面和恢复查看，但不进入模型投影，以免后续请求重复占用上下文。
          if (session && reasoning !== '') await session.append({ kind: 'reasoning', text: reasoning });
          if (session) await session.append({ kind: 'assistant', text, toolCalls,
            ...(draft === undefined ? {} : { responseId: draft.responseId }), ...(reasoning === '' ? {} : { reasoning }) });
          const cleanup = await draft?.discard();
          if (cleanup !== undefined && session !== undefined) await session.append({ kind: 'streamDiagnostic', ignorable: true, code: cleanup.code });
          const finish = events.findLast((event) => event.type === 'finish');
          if (provider.requiresCompletion === true && finish === undefined) {
            await answerRemaining(toolCalls, 'the provider response ended without a completion signal');
            throw new KernelError('provider_stream_incomplete');
          }
          if (finish?.type === 'finish' && (finish.reason === 'length' || finish.reason === 'max_tokens')) {
            await answerRemaining(toolCalls, 'the provider response reached its output limit before completion');
            throw new KernelError('provider_output_exhausted');
          }
          if (toolCalls.length === 0 && text.trim() === '') throw new KernelError('provider_empty_response');
          const validation = toolCalls.map((call) => kernel.validateCall(call.name, call.args));
          const invalidIndex = validation.findIndex((result) => result.code !== undefined);
          if (invalidIndex >= 0) {
            if (session) {
              for (const [index, call] of toolCalls.entries()) {
                const outcome = validation[index];
                await session.append({
                  kind: 'tool', tool: call.name, callId: call.id, args: call.args,
                  result: failureOf(outcome.code ?? 'tool_skipped', {
                    content: outcome.detail ?? 'another call in this response was invalid',
                  }),
                });
              }
            }
            continue;
          }
          if (toolCalls.length === 0) {
            runOptions.validateCompletion?.();
            await markTurn('completed');
            finishTelemetry('completed');
            return summary();
          }

          reportPhase('tool_execution');
          const groups = groupCalls(toolCalls, (name) => kernel.execution(name), completingThisRun);
          for (const [groupIndex, group] of groups.entries()) {
            reportActivity('tool');
            loopWork?.suspend();
            let execution: Awaited<ReturnType<typeof executeGroup>>;
            try { execution = await executeGroup(kernel, group, controller.signal, maxParallelTools, runOptions.task,
              observing ? telemetry : undefined, telemetryExecutionId ?? '', runOptions.runId, sessionId, userSeq,
              parentExecutionId, parentRunId, parentCallId); }
            finally { loopWork?.resume(); }
            const { settled, started } = execution;
            if (controller.signal.aborted) {
              await answerRemaining([...group.calls.slice(started), ...restOf(groups, groupIndex + 1)], 'the run was cancelled before this call ran');
              throw cancelled();
            }
            for (const [outcomeIndex, outcome] of settled.entries()) {
              const tool = group.calls[outcomeIndex].name;
              if (tool !== 'present' && tool !== 'subagent') continue;
              if (outcome.status !== 'fulfilled' || outcome.value === null || typeof outcome.value !== 'object') continue;
              const result = outcome.value as Record<string, unknown>;
              const child = tool === 'subagent' && result.result !== null && typeof result.result === 'object'
                ? result.result as Record<string, unknown> : undefined;
              if (child?.artifactsTruncated === true) artifactsTruncated = true;
              const presented = tool === 'present' ? result.artifacts : child?.artifacts;
              if (!Array.isArray(presented)) continue;
              for (const artifact of presented) {
                if (isFileArtifact(artifact)) {
                  const key = `${artifact.sessionId}/${artifact.path}`;
                  if (artifacts.has(key) || artifacts.size < 16) artifacts.set(key, artifact);
                  else artifactsTruncated = true;
                }
              }
            }
            for (const [index, outcome] of settled.entries()) {
              reportActivity('tool');
              // Kernel 已将工具失败转换为稳定错误码并写入记录，因此循环可以将失败结果交给模型继续处理。
              // Kernel 内部故障和意外异常会中止本轮并向上抛出。
              if (outcome.status === 'rejected' && (!(outcome.reason instanceof KernelError) || outcome.reason instanceof KernelRuntimeError)) {
                await answerRemaining([...group.calls.slice(started), ...restOf(groups, groupIndex + 1)], 'the run failed before this call started');
                throw outcome.reason;
              }
              if (outcome.status === 'fulfilled' && completingThisRun.has(group.calls[index].name)) {
                // 结束本轮后，同一条助手消息中剩余的调用不会执行；为每个调用写入未执行结果。
                const name = group.calls[index].name;
                await answerRemaining(restOf(groups, groupIndex, index), `${name} ended this round before this call ran`);
                runOptions.validateCompletion?.();
                await markTurn('completed', { completedBy: name });
                finishTelemetry('completed');
                return { ...summary(), completedBy: name };
              }
            }
            if (controller.signal.aborted) {
              // 两组工具调用之间收到取消时，后续调用虽已由模型提出，但不能再执行。
              // 为其写入未执行结果和原因，避免会话中留下未完成调用。
              await answerRemaining([...group.calls.slice(started), ...restOf(groups, groupIndex + 1)], 'the run was cancelled before this call ran');
              throw cancelled();
            }
          }
        }
        throw new KernelError('loop_iteration_limit');
      } catch (error) {
        try { await draft?.flush(); }
        catch (writeError) { error = writeError; }
        const diagnostics = error instanceof KernelError ? error.diagnostics : undefined;
        const code = failureCode(error);
        try {
          await markTurn(TURN_CANCEL_CODES.has(code) ? 'cancelled' : 'failed', {
            code,
            ...(diagnostics === undefined ? {} : { diagnostics }),
          });
        } catch (turnError) {
          const turnCode = failureCode(turnError);
          finishTelemetry(TURN_CANCEL_CODES.has(turnCode) ? 'cancelled' : 'failed', turnCode);
          throw turnError;
        }
        finishTelemetry(TURN_CANCEL_CODES.has(code) ? 'cancelled' : 'failed', code);
        rememberRunSummary(error, summary());
        throw error;
      } finally {
        reportPhase('settling');
        signal?.removeEventListener('abort', forward);
        taskSignal?.removeEventListener('abort', forwardTask);
        loopWork?.dispose();
      }
    },
  };
}
