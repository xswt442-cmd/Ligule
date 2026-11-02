export interface FileArtifact {
  readonly kind: 'file';
  readonly sessionId: string;
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly description?: string;
}

export function isFileArtifact(value: unknown): value is FileArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.some((key) => !['kind', 'sessionId', 'path', 'mimeType', 'bytes', 'sha256', 'description'].includes(key))
    || !['kind', 'sessionId', 'path', 'mimeType', 'bytes', 'sha256'].every((key) => Object.hasOwn(item, key))) return false;
  if (item.kind !== 'file' || typeof item.sessionId !== 'string' || item.sessionId.length === 0 || item.sessionId.length > 256
    || typeof item.path !== 'string' || item.path.length === 0 || item.path.length > 2048 || item.path.includes('\\')
    || item.path.startsWith('/') || /^[a-zA-Z]:/u.test(item.path)
    || item.path.split('/').some((part) => part === '' || part === '.' || part === '..')
    || typeof item.mimeType !== 'string' || item.mimeType.length === 0 || item.mimeType.length > 128
    || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || Number(item.bytes) > 20 * 1024 * 1024
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) return false;
  return item.description === undefined || (typeof item.description === 'string' && [...item.description].length <= 400);
}
