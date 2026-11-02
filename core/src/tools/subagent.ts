// `subagent` 将任务交给独立的派生执行；一个父轮次最多并行运行三个子任务。
//
// 派生执行在同一进程中运行独立循环，使用新的 Kernel 和会话记录，并继承父会话的提供方与配置。
// 它沿用父会话的权限判定、不能递归启动其他子 Agent，且拥有独立记录以便恢复。
//
// 该工具通过插件注册，不属于 Kernel 内置能力。每个父会话最多同时运行三个派生任务。
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import { createLoop, DEFAULT_LOOP_LIMITS, type LoopLimits } from '../kernel/loop.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { createSessionLog } from '../session/session.js';
import {
  assertDelegationCompletion, completedRunResult, createOutputSchemaContract, DELEGATION_RESULT_TOOL, failedRunResult, MAX_DELEGATION_SCHEMA_BYTES,
  MODE_SELECTION_SCHEMA, outputSchemaInstructions, registerDelegationResultTool,
} from '../delegation.js';
import {
  applyModeToPrompt, resolveModeSelection,
  type ModeDirectories, type ModeFile, type ModePromptFragment, type RequestedModeSelection,
} from '../kernel/modes.js';
import { createConfig } from '../kernel/config.js';
import { createDecisionChain } from '../kernel/policy.js';
import { createLogger } from '../kernel/log.js';
import { loadAssembly, type Plugin } from '../kernel/assembly.js';
import { KernelError, KernelRuntimeError } from '../kernel/error.js';
import { runSummary } from '../kernel/run-summary.js';
import type { TaskBudget } from '../kernel/task-budget.js';
import { createTodoWritePlugin } from './todo-write.js';
import { createReadImagePlugin } from './read-image.js';
import { createReadDocumentPlugin } from './read-document.js';
import { createPresentPlugin } from './present.js';
import { createScreenshotPlugin } from './screenshot.js';
import { createMediaStore, type MediaStore } from '../capability/media.js';
import { boundaryOf } from '../capability/limits.js';
import type { PermissionContext } from '../kernel/permission.js';
import type { Telemetry } from '../kernel/telemetry.js';

type LoopOptions = Parameters<typeof createLoop>[0];
type ThinkingEffort = 'none' | 'low' | 'high' | 'max';
type ChildGenerationOptions = { readonly outputTokens?: number; readonly thinkingEffort?: ThinkingEffort };
type SubagentProvider = LoopOptions['provider'] & {
  readonly outputTokens?: number;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingCapability?: { readonly efforts: readonly string[]; readonly defaultEffort: string };
  withGeneration?: (options: ChildGenerationOptions) => SubagentProvider;
};
const DEFAULT_CONCURRENT_SUBAGENTS = 3;
const MAX_CONCURRENT_SUBAGENTS = 8;

function stableErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'subagent_failed';
}

export interface SubagentDeps {
  readonly taskBudget?: () => TaskBudget | undefined;
  readonly createMcp?: (id: string, media: MediaStore) => Promise<{ plugin: Parameters<typeof loadAssembly>[1][number]; close(): Promise<void> }>;
  readonly authorizeScreenCapture?: () => Promise<AbortSignal>;
  config: ReturnType<typeof createConfig>;
  provider: SubagentProvider;
  chain: ReturnType<typeof createDecisionChain>;
  prompt: { staticPrefix: string };
  directory: string;
  sessionId: string;
  logger?: Parameters<typeof createLogger>[0];
  plugins: Parameters<typeof loadAssembly>[1];
  /** Custom user tools inherit into the child after its built-ins have registered. */
  customToolPlugin?: Plugin<Kernel>;
  modePaths?: ModeDirectories;
  modeFile?: () => ModeFile | undefined;
  promptFragments?: () => readonly ModePromptFragment[];
  promptFragmentBytes?: number;
  loopLimits?: LoopLimits;
  telemetry?: Telemetry;
}

function childLimits(args: { loopIterations?: number; modelCalls?: number }, parent: LoopLimits) {
  const limits = {
    iterations: args.loopIterations ?? parent.iterations,
    modelCalls: args.modelCalls ?? parent.modelCalls,
    ...(parent.maxParallelTools === undefined ? {} : { maxParallelTools: parent.maxParallelTools }),
  };
  if (limits.iterations > parent.iterations || limits.modelCalls > parent.modelCalls) {
    throw new KernelError('subagent_budget_escalation', { detail: 'a child run may only use budgets within its parent session limits' });
  }
  return limits;
}

function childProvider(args: { outputTokens?: number; thinkingEffort?: ThinkingEffort }, provider: SubagentProvider): SubagentProvider {
  if (args.outputTokens === undefined && args.thinkingEffort === undefined) return provider;
  if (provider.withGeneration === undefined) {
    throw new KernelError('subagent_generation_unavailable', { detail: 'this provider cannot create a bounded child generation' });
  }
  if (args.outputTokens !== undefined
    && (provider.outputTokens === undefined || args.outputTokens > provider.outputTokens)) {
    throw new KernelError('subagent_output_budget_escalation', { detail: 'a child output-token limit cannot exceed the parent session limit' });
  }
  if (args.thinkingEffort !== undefined) {
    const capability = provider.thinkingCapability;
    if (capability === undefined || !capability.efforts.includes(args.thinkingEffort)) {
      throw new KernelError('provider_thinking_effort_invalid', { detail: 'the selected provider does not support this thinking effort' });
    }
    const ceiling = provider.thinkingEffort ?? capability.defaultEffort;
    const ranks: Record<ThinkingEffort, number> = { none: 0, low: 1, high: 2, max: 3 };
    if (ranks[args.thinkingEffort] > (ranks[ceiling as ThinkingEffort] ?? 0)) {
      throw new KernelError('subagent_thinking_escalation', { detail: 'a child thinking effort cannot exceed the parent session setting' });
    }
  }
  const options: { outputTokens?: number; thinkingEffort?: ThinkingEffort } = {};
  const outputTokens = args.outputTokens ?? provider.outputTokens;
  if (outputTokens !== undefined) options.outputTokens = outputTokens;
  const thinkingEffort = args.thinkingEffort ?? provider.thinkingEffort;
  if (thinkingEffort !== undefined) options.thinkingEffort = thinkingEffort;
  return provider.withGeneration(options);
}

export function createSubagentPlugin(deps: SubagentDeps) {
  const loopConfig = typeof deps.config.loop === 'object' && deps.config.loop !== null && !Array.isArray(deps.config.loop)
    ? deps.config.loop as Record<string, unknown> : {};
  const concurrency = loopConfig.maxConcurrentSubagents ?? DEFAULT_CONCURRENT_SUBAGENTS;
  if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENT_SUBAGENTS) {
    throw new KernelError('subagent_concurrency_invalid', { detail: `loop.maxConcurrentSubagents must be an integer between 1 and ${MAX_CONCURRENT_SUBAGENTS}` });
  }
  let counter = 0;
  let active = 0;

  async function nextSessionId(): Promise<string> {
    let entries;
    try { entries = await readdir(deps.directory, { withFileTypes: true }); }
    catch (cause) { throw new KernelError('subagent_session_directory_read_failed', { cause }); }
    const prefix = `${deps.sessionId}.sub-`;
    let highest = counter;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.jsonl')) continue;
      const suffix = entry.name.slice(prefix.length, -'.jsonl'.length);
      if (!/^\d+$/u.test(suffix)) continue;
      const number = Number(suffix);
      if (Number.isSafeInteger(number)) highest = Math.max(highest, number);
    }
    counter = highest + 1;
    return `${deps.sessionId}.sub-${counter}`;
  }

  return {
    name: 'ligule-subagent',
    setup(kernel: {
      register(tool: unknown): () => void;
      manifest(): readonly { readonly name: string }[];
    }) {
      return kernel.register({
        name: 'subagent',
        access: 'inherit',
        execution: 'parallel',
        description: `Delegate independent work to child runs with the parent policy and separate session records. Up to ${concurrency} children can run at once; children cannot create more children. Optional output, thinking, and loop budgets can only lower the parent session limits. Check result.state because a failed or cancelled child still returns its saved Session reference. When outputSchema is provided, the child must submit its final value with ligule_delegation_result.`,
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What the derived agent should do, as one instruction.' },
            mode: MODE_SELECTION_SCHEMA,
            outputTokens: { type: 'integer', minimum: 1, description: 'optional child output-token limit; it cannot exceed the parent session limit' },
            thinkingEffort: { type: 'string', enum: ['none', 'low', 'high', 'max'], description: 'optional child thinking effort; it cannot exceed the parent session setting' },
            loopIterations: { type: 'integer', minimum: 1, description: 'optional child iteration limit; it cannot exceed the parent session limit' },
            modelCalls: { type: 'integer', minimum: 1, description: 'optional child model-call limit; it cannot exceed the parent session limit' },
            outputSchema: { type: 'object', description: 'Optional supported JSON Schema for the child result. A valid value must be submitted with the child-only ligule_delegation_result tool.' },
          },
          additionalProperties: false,
          required: ['task'],
        },
        async run(args: {
          task?: string;
          mode?: RequestedModeSelection;
          outputTokens?: number;
          thinkingEffort?: ThinkingEffort;
          loopIterations?: number;
          modelCalls?: number;
          outputSchema?: Record<string, unknown>;
        }, { signal, permission, runId, executionId, callId }: { signal?: AbortSignal; permission: PermissionContext; runId?: string; executionId?: string; callId?: string }) {
          if (typeof args.task !== 'string' || args.task.trim() === '') {
            throw new KernelError('subagent_task_required', { detail: 'the derived agent needs a task to work on' });
          }
          const namedMode = typeof args.mode === 'string' || (typeof args.mode === 'object' && args.mode?.type === 'named');
          if (namedMode && deps.modePaths === undefined) {
            throw new KernelError('subagent_mode_paths_required', { detail: 'this run has no mode directories to look a name up in' });
          }
          const outputContract = args.outputSchema === undefined ? undefined : createOutputSchemaContract(args.outputSchema);
          const limits = childLimits(args, deps.loopLimits ?? DEFAULT_LOOP_LIMITS);
          const provider = childProvider(args, deps.provider);
          if (active >= concurrency) {
            throw new KernelError('subagent_concurrency_limit', { detail: `at most ${concurrency} derived runs can be active for this parent` });
          }
          const parentTools = new Set(kernel.manifest().map(({ name }) => name));
          active += 1;
          try {
            const id = await nextSessionId();
            // 首行在首次写入时生成；模式选择确定后再补入模式身份。
            let modeIdentity: {
              name: string;
              layer: string;
              source?: 'named' | 'inline';
              digest?: string;
              fileDigest?: string;
              tools?: string[];
              prompt?: string[];
            } | undefined;
            const session = createSessionLog({
              directory: deps.directory,
              id,
              meta: () => ({
                projectRoot: typeof deps.config.workspaceRoot === 'string'
                  ? deps.config.workspaceRoot
                  : typeof deps.config.boundary === 'string' ? deps.config.boundary : undefined,
                mode: modeIdentity,
              }),
            });
            let disposeAssembly: (() => void) | undefined;
            let closeMcp: (() => Promise<void>) | undefined;
            let disposeResultTool: (() => void) | undefined;
            let undoMode = () => {};
            let undoParentRestrictions = () => {};
            let undoOutputContract = () => {};
            try {
              const child = createKernel({
                config: deps.config,
                // 派生执行复用父会话的权限判定实例，包括拒绝次数与强制审批状态。
                policy: deps.chain,
                session,
                logger: deps.logger,
                permission,
              });
              // 派生执行继承父会话的插件工具，但不注册 `subagent`，从而禁止递归派生。
              const media = createMediaStore({ boundary: boundaryOf(deps.config),
                ...(typeof deps.config.workspaceRoot === 'string' ? { workspaceRoot: deps.config.workspaceRoot } : {}),
                ...(typeof deps.config.userHome === 'string' ? { userHome: deps.config.userHome } : {}),
              }, id);
              let recordedScreenConsent = false;
              const authorizeScreenCapture = deps.authorizeScreenCapture === undefined ? undefined : async () => {
                const signal = await deps.authorizeScreenCapture!();
                if (!recordedScreenConsent) {
                  await session.append({ kind: 'screenCapture', ignorable: true, enabled: true, source: 'parent', at: new Date().toISOString() });
                  recordedScreenConsent = true;
                }
                return signal;
              };
              const mcp = deps.createMcp === undefined ? undefined : await deps.createMcp(id, media);
              closeMcp = mcp === undefined ? undefined : () => mcp.close();
              const assembly = loadAssembly(child, [
                ...deps.plugins,
                ...(mcp === undefined ? [] : [mcp.plugin]),
                ...(parentTools.has('todo_write') ? [createTodoWritePlugin({ session })] : []),
                ...(parentTools.has('read_image') ? [createReadImagePlugin({ media, supportsImages: () => provider.imageInput === true })] : []),
                ...(parentTools.has('read_document') ? [createReadDocumentPlugin({ media, supportsImages: () => provider.imageInput === true })] : []),
                ...(parentTools.has('present') ? [createPresentPlugin({ sessionId: id,
                  workspaceRoot: typeof deps.config.workspaceRoot === 'string' ? deps.config.workspaceRoot : boundaryOf(deps.config), session })] : []),
                ...(parentTools.has('screenshot') ? [createScreenshotPlugin({ media,
                  supportsImages: () => provider.imageInput === true,
                  authorize: authorizeScreenCapture,
                })] : []),
                ...(deps.customToolPlugin === undefined ? [] : [deps.customToolPlugin]),
              ]);
              disposeAssembly = () => assembly.dispose();
              let structuredSubmitted = false;
              let structuredResult: unknown;
              if (outputContract !== undefined) {
                disposeResultTool = registerDelegationResultTool(child, outputContract, (value) => {
                  structuredResult = value;
                  structuredSubmitted = true;
                });
              }
              // Explicit child modes can narrow the parent manifest but cannot expand it.
              undoParentRestrictions = child.restrict(
                child.list().filter((name) => name !== DELEGATION_RESULT_TOOL && !parentTools.has(name)),
              );
              const prompt = createPromptAssembly({ static: deps.prompt.staticPrefix });
              if (outputContract !== undefined) {
                undoOutputContract = prompt.fragment({
                  name: 'subagent-output-contract',
                  anchor: 1,
                  text: outputSchemaInstructions(outputContract),
                  maxBytes: MAX_DELEGATION_SCHEMA_BYTES + 1024,
                });
              }
              const resolvedMode = await resolveModeSelection(args.mode, deps.modePaths, deps.modeFile?.());
              if (resolvedMode !== undefined) {
                const applied = applyModeToPrompt({
                  file: resolvedMode.application,
                  kernel: child,
                  prompt,
                  fragments: deps.promptFragments?.() ?? [],
                  maxBytes: deps.promptFragmentBytes ?? 8192,
                });
                undoMode = applied.undo;
                modeIdentity = {
                  name: resolvedMode.name,
                  layer: resolvedMode.layer,
                  source: resolvedMode.source,
                  digest: applied.digest,
                  ...(resolvedMode.fileDigest === undefined ? {} : { fileDigest: resolvedMode.fileDigest }),
                  tools: applied.tools,
                  prompt: applied.prompt,
                };
              }
              const loop = createLoop({
                kernel: child,
                provider,
                prompt,
                session,
                limits,
                resolveImage: media.read,
                telemetry: deps.telemetry,
                sessionId: id,
                ...(runId === undefined ? {} : { parentRunId: runId }),
                ...(executionId === undefined ? {} : { parentExecutionId: executionId }),
                ...(callId === undefined ? {} : { parentCallId: callId }),
                completesRun: outputContract === undefined ? [] : [DELEGATION_RESULT_TOOL],
                turnContext: () => ({
                  childGeneration: {
                    outputTokens: provider.outputTokens ?? null,
                    thinkingEffort: provider.thinkingEffort ?? provider.thinkingCapability?.defaultEffort ?? null,
                  },
                  childLimits: limits,
                  ...(outputContract === undefined ? {} : { delegationSchemaDigest: outputContract.digest }),
                }),
              });
              let result: Awaited<ReturnType<typeof loop.run>>;
              const resumeParent = deps.taskBudget?.()?.suspendCurrentWork();
              try {
                result = await loop.run(args.task, { signal, task: deps.taskBudget?.(),
                  validateCompletion: () => assertDelegationCompletion(outputContract, structuredSubmitted) });
              } catch (error) {
                // Record-lock and Session I/O failures mean the child record may be unreliable; do not turn them into a normal child result.
                if (error instanceof KernelRuntimeError) throw error;
                const code = stableErrorCode(error);
                const summary = runSummary(error);
                const validation = outputContract === undefined ? undefined : {
                  status: 'invalid' as const,
                  schemaDigest: outputContract.digest,
                  errors: [`Run ended with ${code} before a valid structured result was submitted.`],
                };
                return {
                  text: summary?.text || null,
                  summary: `Child run ${code}; its saved Session is available for inspection.`,
                  sessionId: id,
                  path: session.path,
                  iterations: summary?.iterations ?? null,
                  modelCalls: summary?.modelCalls ?? null,
                  generation: {
                    outputTokens: provider.outputTokens ?? null,
                    thinkingEffort: provider.thinkingEffort ?? provider.thinkingCapability?.defaultEffort ?? null,
                  },
                  limits,
                  mode: resolvedMode?.name ?? null,
                  modeDigest: modeIdentity?.digest ?? null,
                  result: failedRunResult(
                    randomUUID(),
                    id,
                    code,
                    error instanceof KernelError ? error.diagnostics : undefined,
                    validation,
                    summary,
                  ),
                };
              } finally { resumeParent?.(); }
              const validation = outputContract === undefined
                ? { status: 'not_requested' as const }
                : { status: 'valid' as const, schemaDigest: outputContract.digest };
              return {
                text: result.text,
                sessionId: id,
                path: session.path,
                iterations: result.iterations,
                modelCalls: result.modelCalls,
                generation: {
                  outputTokens: provider.outputTokens ?? null,
                  thinkingEffort: provider.thinkingEffort ?? provider.thinkingCapability?.defaultEffort ?? null,
                },
                limits,
                mode: resolvedMode?.name ?? null,
                modeDigest: modeIdentity?.digest ?? null,
                result: completedRunResult(randomUUID(), id, result, {
                  ...(structuredSubmitted ? { structured: structuredResult } : {}),
                  validation,
                }),
              };
            } finally {
              try { undoMode(); }
              finally {
                try { undoParentRestrictions(); }
                finally {
                  try { undoOutputContract(); }
                  finally {
                    try { disposeResultTool?.(); }
                    finally {
                      try { disposeAssembly?.(); }
                      finally { try { await closeMcp?.(); } finally { await session.close(); } }
                    }
                  }
                }
              }
            }
          } finally {
            active -= 1;
          }
        },
      });
    },
  };
}
