// Job 句柄只由守护进程持有；后代自动继承归属，不继承这个句柄。
import { KernelError } from '../errors.js';

type NativeHandle = number | bigint;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

export interface OwnedProcessJob {
  assign(processHandle: NativeHandle): void;
  assignPid(pid: number): void;
  close(): void;
}

export async function createOwnedProcessJob(options: { assignCurrentProcess?: boolean; processMemoryBytes?: number } = {}): Promise<OwnedProcessJob> {
  if (process.platform !== 'win32') throw new KernelError('exec_job_platform');
  if (options.processMemoryBytes !== undefined && (!Number.isSafeInteger(options.processMemoryBytes) || options.processMemoryBytes < 1)) {
    throw new KernelError('exec_job_memory_limit_invalid');
  }
  const koffi = (await import('koffi')).default;
  const kernel = koffi.load('kernel32.dll');
  const basic = koffi.struct({
    PerProcessUserTimeLimit: 'int64_t',
    PerJobUserTimeLimit: 'int64_t',
    LimitFlags: 'uint32_t',
    MinimumWorkingSetSize: 'size_t',
    MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32_t',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32_t',
    SchedulingClass: 'uint32_t',
  });
  const counters = koffi.struct({
    ReadOperationCount: 'uint64_t',
    WriteOperationCount: 'uint64_t',
    OtherOperationCount: 'uint64_t',
    ReadTransferCount: 'uint64_t',
    WriteTransferCount: 'uint64_t',
    OtherTransferCount: 'uint64_t',
  });
  const extended = koffi.struct({
    BasicLimitInformation: basic,
    IoInfo: counters,
    ProcessMemoryLimit: 'size_t',
    JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t',
    PeakJobMemoryUsed: 'size_t',
  });
  const createJob = kernel.func('__stdcall', 'CreateJobObjectW', 'intptr', ['void*', 'str16']) as (security: null, name: null) => NativeHandle;
  const setInformation = kernel.func('__stdcall', 'SetInformationJobObject', 'int', ['intptr', 'int', koffi.pointer(extended), 'uint32_t']) as (job: NativeHandle, kind: number, info: unknown, length: number) => number;
  const currentProcess = kernel.func('__stdcall', 'GetCurrentProcess', 'intptr', []) as () => NativeHandle;
  const openProcess = kernel.func('__stdcall', 'OpenProcess', 'intptr', ['uint32_t', 'int', 'uint32_t']) as (access: number, inherit: number, pid: number) => NativeHandle;
  const assignProcess = kernel.func('__stdcall', 'AssignProcessToJobObject', 'int', ['intptr', 'intptr']) as (job: NativeHandle, processHandle: NativeHandle) => number;
  const closeHandle = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as (handle: NativeHandle) => number;
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32_t', []) as () => number;
  const failed = (operation: string, code: number) => new KernelError('exec_job_failed', { detail: `${operation} failed with Win32 error ${code}` });
  const handle = createJob(null, null);
  if (handle === 0 || handle === 0n) throw failed('CreateJobObjectW', lastError());
  let ready = false;
  let closed = false;
  try {
    const configured = setInformation(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | (options.processMemoryBytes === undefined ? 0 : JOB_OBJECT_LIMIT_PROCESS_MEMORY),
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0,
        WriteOperationCount: 0,
        OtherOperationCount: 0,
        ReadTransferCount: 0,
        WriteTransferCount: 0,
        OtherTransferCount: 0,
      },
      ProcessMemoryLimit: options.processMemoryBytes ?? 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    }, koffi.sizeof(extended));
    if (configured === 0) throw failed('SetInformationJobObject', lastError());
    if (options.assignCurrentProcess !== false && assignProcess(handle, currentProcess()) === 0) {
      throw failed('AssignProcessToJobObject', lastError());
    }
    ready = true;
  } finally {
    if (!ready && closeHandle(handle) === 0) throw failed('CloseHandle', lastError());
  }
  return {
    assignPid(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) throw failed('OpenProcess', 87);
      const processHandle = openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (processHandle === 0 || processHandle === 0n) throw failed('OpenProcess', lastError());
      try {
        if (closed || assignProcess(handle, processHandle) === 0) throw failed('AssignProcessToJobObject', closed ? 6 : lastError());
      } finally {
        if (closeHandle(processHandle) === 0) throw failed('CloseHandle', lastError());
      }
    },
    assign(processHandle) {
      if (closed) throw failed('AssignProcessToJobObject', 6);
      if (assignProcess(handle, processHandle) === 0) throw failed('AssignProcessToJobObject', lastError());
    },
    close() {
      // 关闭最后一个句柄会终止整个 Job，包括当前守护进程。
      if (closed) return;
      closed = true;
      if (closeHandle(handle) === 0) throw failed('CloseHandle', lastError());
    },
  };
}
