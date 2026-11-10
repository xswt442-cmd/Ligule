import { resolve } from 'node:path';
import { KernelError } from './error.js';

export interface FileWriteQueue {
  run<TResult>(target: string, operation: () => Promise<TResult>, signal?: AbortSignal): Promise<TResult>;
}

/**
 * A queue instance coordinates writes only for callers that share it. Hosts create one
 * instance per Host; it does not coordinate other Host instances or other processes.
 */
export function createFileWriteQueue(): FileWriteQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<TResult>(target: string, operation: () => Promise<TResult>, signal?: AbortSignal): Promise<TResult> {
      const key = fileWriteTargetKey(target);
      const predecessor = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
      const tail = predecessor.catch(() => {}).then(() => current);
      tails.set(key, tail);
      let entered = false;
      const releaseSlot = () => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      };

      try {
        await waitForTurn(predecessor, signal);
        if (signal?.aborted) throw cancellationOf(signal);
        entered = true;
        // Once entered, keep the path occupied until the filesystem operation settles.
        return await operation();
      } finally {
        if (entered) releaseSlot();
        else void predecessor.then(releaseSlot, releaseSlot);
      }
    },
  };
}

/** Targets are resolved through the filesystem boundary before they reach the queue. */
export function fileWriteTargetKey(target: string): string {
  const absolute = resolve(target);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function cancellationOf(signal: AbortSignal): KernelError {
  return signal.reason instanceof KernelError
    ? signal.reason
    : new KernelError('loop_cancelled', { cause: signal.reason });
}

async function waitForTurn(predecessor: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return predecessor.catch(() => {});
  if (signal.aborted) throw cancellationOf(signal);

  await new Promise<void>((resolveTurn, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(cancellationOf(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    void predecessor.then(() => {
      cleanup();
      if (signal.aborted) reject(cancellationOf(signal));
      else resolveTurn();
    }, () => {
      cleanup();
      if (signal.aborted) reject(cancellationOf(signal));
      else resolveTurn();
    });
  });
}
