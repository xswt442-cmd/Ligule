// Kernel and its components use stable error codes for caller-side branching.
// Error options preserve the underlying cause.
export interface KernelErrorOptions extends ErrorOptions {
  readonly detail?: string;
  readonly diagnostics?: ProviderDiagnostic;
}

export type ProviderDiagnosticCategory = 'authentication' | 'rate_limit' | 'client' | 'server' | 'http' | 'transport' | 'stream' | 'invalid_response' | 'cancelled';

export interface ProviderDiagnostic {
  readonly category: ProviderDiagnosticCategory;
  readonly status?: number;
  readonly attempts: number;
  readonly responseReceived: boolean;
  readonly streamReceived: boolean;
  readonly recoverable: boolean;
}

// Desktop, TUI, and Host share this category table for consistent diagnostics.
export const PROVIDER_DIAGNOSTIC_CATEGORIES: Readonly<Record<ProviderDiagnosticCategory, readonly [string, string]>> = {
  authentication: ['身份认证', 'authentication'],
  rate_limit: ['请求限流', 'rate limit'],
  client: ['客户端请求', 'client request'],
  server: ['服务端故障', 'server failure'],
  http: ['HTTP 响应', 'HTTP response'],
  transport: ['传输故障', 'transport failure'],
  stream: ['响应流中断', 'response stream interrupted'],
  invalid_response: ['响应格式无效', 'invalid response'],
  cancelled: ['请求已取消', 'request cancelled'],
};

export class KernelError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  readonly diagnostics: ProviderDiagnostic | undefined;

  constructor(code: string, options?: KernelErrorOptions) {
    super(code, options);
    this.name = 'KernelError';
    this.code = code;
    // The detail is shown to the model; callers branch on the stable code.
    this.detail = options?.detail;
    const diagnostics = options?.diagnostics;
    if (diagnostics !== undefined) {
      const categories: readonly string[] = Object.keys(PROVIDER_DIAGNOSTIC_CATEGORIES);
      if (!categories.includes(diagnostics.category)
        || !Number.isSafeInteger(diagnostics.attempts) || diagnostics.attempts < 1
        || (diagnostics.status !== undefined
          && (!Number.isSafeInteger(diagnostics.status) || diagnostics.status < 100 || diagnostics.status > 599))
        || typeof diagnostics.responseReceived !== 'boolean'
        || typeof diagnostics.streamReceived !== 'boolean'
        || typeof diagnostics.recoverable !== 'boolean') {
        throw new TypeError('provider diagnostics are invalid');
      }
    }
    this.diagnostics = diagnostics === undefined ? undefined : Object.freeze({
      category: diagnostics.category,
      ...(diagnostics.status === undefined ? {} : { status: diagnostics.status }),
      attempts: diagnostics.attempts,
      responseReceived: diagnostics.responseReceived,
      streamReceived: diagnostics.streamReceived,
      recoverable: diagnostics.recoverable,
    });
  }
}

// Runtime failures make the loop stop; ordinary tool failures are recorded and can continue.
export class KernelRuntimeError extends KernelError {
  constructor(code: string, options?: KernelErrorOptions) {
    super(code, options);
    this.name = 'KernelRuntimeError';
  }
}
