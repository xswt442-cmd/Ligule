export type RequestIdentity = {
  readonly scope: string | null;
  readonly generation: number;
};

export function requestIsCurrent(request: RequestIdentity, currentScope: string | null, currentGeneration: number): boolean {
  return request.scope === currentScope && request.generation === currentGeneration;
}
