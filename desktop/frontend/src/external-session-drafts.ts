export type ExternalSessionDrafts = ReadonlyMap<string, string>;

export function externalSessionDraftFor(drafts: ExternalSessionDrafts, sessionId: string): string {
  return drafts.get(sessionId) ?? '';
}

export function updateExternalSessionDrafts(drafts: ExternalSessionDrafts, sessionId: string, draft: string): ExternalSessionDrafts {
  if (drafts.get(sessionId) === draft) return drafts;
  const next = new Map(drafts);
  if (draft === '') next.delete(sessionId);
  else next.set(sessionId, draft);
  return next;
}
