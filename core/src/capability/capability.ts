// 每种能力后端提供独立探测函数，返回实际强制级别和稳定错误码。
// 无法探测时返回 `none`，不伪报为受控；底层异常写入日志，响应仅包含错误码。
import { KernelError } from '../errors.js';
import { createLogger } from '../kernel/log.js';

type CapabilityLevel = 'full' | 'partial' | 'none';
type ProbeErrorCode = 'capability_probe_missing' | 'capability_probe_failed' | 'capability_probe_result_invalid';
type ProbeBackend = { name?: unknown; probe?: unknown };
type ProbeMethod = (this: ProbeBackend) => unknown;
type ProbeLogger = { error: (message: string, fields: Record<string, unknown>) => void };
type ProbeResult =
  | { name: string; enforced: CapabilityLevel }
  | { name: string; enforced: 'none'; code: ProbeErrorCode };

const LEVELS: readonly CapabilityLevel[] = ['full', 'partial', 'none'];

function hasBackendProperties(value: unknown): value is ProbeBackend {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isProbeMethod(value: unknown): value is ProbeMethod {
  return typeof value === 'function';
}

function isCapabilityLevel(value: unknown): value is CapabilityLevel {
  return typeof value === 'string' && LEVELS.some((level) => level === value);
}

function messageOf(cause: unknown): unknown {
  if (!((typeof cause === 'object' && cause !== null) || typeof cause === 'function')) return undefined;
  return 'message' in cause ? cause.message : undefined;
}

export async function probeBackend(backend: unknown, logger: ProbeLogger = createLogger()): Promise<ProbeResult> {
  if (!hasBackendProperties(backend) || typeof backend.name !== 'string' || backend.name === '') {
    throw new KernelError('backend_name_required');
  }
  const name = backend.name;
  const failed = (code: ProbeErrorCode, cause?: unknown): ProbeResult => {
    logger.error(`backend ${name}: ${code}`, { backend: name, code, cause: messageOf(cause) });
    return { name, enforced: 'none', code };
  };

  const probe = backend.probe;
  if (!isProbeMethod(probe)) return failed('capability_probe_missing');

  let level: unknown;
  try {
    level = await probe.call(backend);
  } catch (cause) {
    return failed('capability_probe_failed', cause);
  }
  if (!isCapabilityLevel(level)) return failed('capability_probe_result_invalid');
  return { name: backend.name, enforced: level };
}
