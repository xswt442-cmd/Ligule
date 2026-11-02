import { KernelError } from '../errors.js';
import type { HostMethodParams } from './protocol.js';
import type { HostGenerationOptions } from './provider.js';

export interface ParsedInitialGenerationSettings {
  readonly outputTokens?: number;
  readonly thinkingEffort?: HostGenerationOptions['thinkingEffort'];
  readonly loopIterations?: number;
}

export function parseInitialGenerationSettings(params: HostMethodParams): ParsedInitialGenerationSettings {
  if (params.initialOutputTokens !== undefined && (!Number.isSafeInteger(params.initialOutputTokens) || params.initialOutputTokens < 1)) {
    throw new KernelError('provider_output_budget_invalid');
  }
  if (params.initialThinkingEffort !== undefined && params.initialThinkingEffort !== 'default'
    && params.initialThinkingEffort !== 'none' && params.initialThinkingEffort !== 'low'
    && params.initialThinkingEffort !== 'high' && params.initialThinkingEffort !== 'max') {
    throw new KernelError('provider_thinking_effort_invalid');
  }
  if (params.initialLoopIterations !== undefined && (!Number.isSafeInteger(params.initialLoopIterations) || params.initialLoopIterations < 1)) {
    throw new KernelError('host_loop_limits_invalid', { detail: 'iterations must be a positive safe integer' });
  }
  return {
    ...(params.initialOutputTokens === undefined ? {} : { outputTokens: params.initialOutputTokens }),
    ...(params.initialThinkingEffort === undefined || params.initialThinkingEffort === 'default' ? {} : { thinkingEffort: params.initialThinkingEffort as HostGenerationOptions['thinkingEffort'] }),
    ...(params.initialLoopIterations === undefined ? {} : { loopIterations: params.initialLoopIterations }),
  };
}
