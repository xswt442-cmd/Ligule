import { createHash } from 'node:crypto';
import type { SessionEvent } from './format.js';
import { isFileArtifact, type FileArtifact } from '../artifact.js';

export { isFileArtifact, type FileArtifact } from '../artifact.js';


export interface IndexedFileArtifact {
  readonly artifactKey: string;
  readonly artifact: FileArtifact;
}

export function artifactKey(workspace: string, artifact: FileArtifact): string {
  if (!isFileArtifact(artifact)) throw new TypeError('artifact_invalid');
  return createHash('sha256').update(JSON.stringify([
    workspace, artifact.sessionId, artifact.path, artifact.sha256,
  ])).digest('hex');
}

export function confirmedFileArtifacts(events: readonly SessionEvent[], workspace: string): IndexedFileArtifact[] {
  const found = new Map<string, IndexedFileArtifact>();
  for (const event of events) {
    if (event.kind !== 'tool' || (event.tool !== 'present' && event.tool !== 'subagent')
      || typeof event.result !== 'object' || event.result === null) continue;
    const outcome = event.result as Record<string, unknown>;
    if (outcome.failed === true || typeof outcome.content !== 'object' || outcome.content === null) continue;
    const content = outcome.content as Record<string, unknown>;
    const child = event.tool === 'subagent' && typeof content.result === 'object' && content.result !== null
      ? content.result as Record<string, unknown> : undefined;
    const items = event.tool === 'present' ? content.artifacts : child?.artifacts;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isFileArtifact(item)) continue;
      const key = artifactKey(workspace, item);
      if (!found.has(key)) found.set(key, { artifactKey: key, artifact: item });
    }
  }
  return [...found.values()];
}
