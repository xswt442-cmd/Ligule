import { isRunAcceptance, type DurableRunReceipt } from '../session/run.js';
import type { SessionEvent } from '../session/format.js';

/** Map persisted Run receipts and current Host liveness to the public status. */
export function runReceiptView(receipt: DurableRunReceipt, live: boolean): DurableRunReceipt & { liveness: 'alive' | 'unknown' } {
  return { ...receipt, state: live ? 'running' : receipt.state, liveness: live ? 'alive' : 'unknown' };
}

/** Events covered by a Run, from its accepting user event until the next one. */
export function withinRunWindows(events: readonly SessionEvent[], receipts: readonly DurableRunReceipt[]): SessionEvent[] {
  if (receipts.length === 0) return [];
  const windows = receipts.map((receipt) => {
    const nextUser = events.find(event => event.kind === 'user' && event.seq > receipt.userSeq);
    return { start: receipt.userSeq, end: nextUser?.seq ?? Number.POSITIVE_INFINITY };
  });
  return events.filter(event => windows.some(window => event.seq > window.start && event.seq < window.end));
}

/** The persisted caller scope for an accepted Run; request parameters are not authoritative. */
export function runAcceptanceScope(events: readonly SessionEvent[], sessionId: string, runId: string): string | undefined {
  const accepted = events.find(event => event.kind === 'user' && isRunAcceptance(event.run)
    && event.run.sessionId === sessionId && event.run.runId === runId);
  return accepted?.kind === 'user' && isRunAcceptance(accepted.run) ? accepted.run.callerScope : undefined;
}
