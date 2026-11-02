export type ExternalSessionDraft = {
  readonly text: string;
  readonly revision: number;
};

export type ExternalSessionDrafts = ReadonlyMap<string, ExternalSessionDraft>;

export function externalSessionDraftFor(drafts: ExternalSessionDrafts, sessionId: string): string {
  return drafts.get(sessionId)?.text ?? '';
}

export function externalSessionDraftRevisionFor(drafts: ExternalSessionDrafts, sessionId: string): number {
  return drafts.get(sessionId)?.revision ?? 0;
}

export function updateExternalSessionDrafts(drafts: ExternalSessionDrafts, sessionId: string, draft: string): ExternalSessionDrafts {
  const previous = drafts.get(sessionId);
  if (previous?.text === draft) return drafts;
  const next = new Map(drafts);
  next.set(sessionId, { text: draft, revision: (previous?.revision ?? 0) + 1 });
  return next;
}

export function clearExternalSessionDraftIfCurrent(drafts: ExternalSessionDrafts, sessionId: string, submittedRevision: number): ExternalSessionDrafts {
  const current = drafts.get(sessionId);
  if (current === undefined || current.revision !== submittedRevision || current.text === '') return drafts;
  const next = new Map(drafts);
  next.set(sessionId, { text: '', revision: current.revision + 1 });
  return next;
}
