import { PROVIDER_DIAGNOSTIC_CATEGORIES, type ProviderDiagnostic } from '../errors.js';

export {
  KernelError,
  KernelRuntimeError,
  type KernelErrorOptions,
  type ProviderDiagnostic,
  type ProviderDiagnosticCategory,
  PROVIDER_DIAGNOSTIC_CATEGORIES,
} from '../errors.js';

// Validate diagnostics received over the protocol before formatting them.
export function parseProviderDiagnostic(value: unknown): ProviderDiagnostic | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ProviderDiagnostic>;
  if (typeof candidate.category !== 'string' || !Object.hasOwn(PROVIDER_DIAGNOSTIC_CATEGORIES, candidate.category)
    || !Number.isSafeInteger(candidate.attempts) || (candidate.attempts ?? 0) < 1
    || typeof candidate.responseReceived !== 'boolean'
    || typeof candidate.streamReceived !== 'boolean'
    || typeof candidate.recoverable !== 'boolean'
    || (candidate.status !== undefined
      && (!Number.isSafeInteger(candidate.status) || candidate.status < 100 || candidate.status > 599))) {
    return undefined;
  }
  return {
    category: candidate.category as ProviderDiagnostic['category'],
    ...(candidate.status === undefined ? {} : { status: candidate.status }),
    attempts: candidate.attempts as number,
    responseReceived: candidate.responseReceived,
    streamReceived: candidate.streamReceived,
    recoverable: candidate.recoverable,
  };
}

// Format one concise diagnostic line with a shared bilingual category label.
export function providerDiagnosticText(diagnostic: ProviderDiagnostic): { readonly zh: string; readonly en: string } {
  const category = PROVIDER_DIAGNOSTIC_CATEGORIES[diagnostic.category];
  const status: readonly [string, string] = diagnostic.status === undefined
    ? ['HTTP 状态未知', 'HTTP status unknown']
    : [`HTTP ${diagnostic.status}`, `HTTP ${diagnostic.status}`];
  const attempts: readonly [string, string] = [`尝试 ${diagnostic.attempts} 次`, `${diagnostic.attempts} attempts`];
  const response: readonly [string, string] = diagnostic.responseReceived ? ['收到响应', 'response received'] : ['未收到响应', 'no response'];
  const stream: readonly [string, string] = diagnostic.streamReceived ? ['收到响应流', 'stream data received'] : ['未收到响应流', 'no stream data'];
  const recovery: readonly [string, string] = diagnostic.recoverable ? ['可恢复', 'recoverable'] : ['不可安全重试', 'not safe to retry'];
  return {
    zh: [status[0], category[0], attempts[0], response[0], stream[0], recovery[0]].join(' · '),
    en: [status[1], category[1], attempts[1], response[1], stream[1], recovery[1]].join(' · '),
  };
}
