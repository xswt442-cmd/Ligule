export const IMAGE_LIMITS = Object.freeze({ inputBytes: 20 * 1024 * 1024, pixels: 40_000_000,
  dimension: 2048, outputBytes: 8 * 1024 * 1024, storageBytes: 256 * 1024 * 1024, retentionMs: 30 * 86_400_000 });
export const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ImageReference {
  readonly kind: 'image';
  readonly version: 1;
  readonly id: string;
  readonly workspace: string;
  readonly sessionId: string;
  readonly source: 'file' | 'desktop' | 'browser' | 'document';
  readonly mimeType: 'image/png';
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export function isImageReference(value: unknown): value is ImageReference {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 12 && item.kind === 'image' && item.version === 1 && typeof item.id === 'string' && IMAGE_ID.test(item.id)
    && typeof item.workspace === 'string' && item.workspace.length > 0 && item.workspace.length <= 2048
    && typeof item.sessionId === 'string' && item.sessionId.length > 0 && item.sessionId.length <= 256
    && typeof item.source === 'string' && ['file', 'desktop', 'browser', 'document'].includes(item.source) && item.mimeType === 'image/png'
    && Number.isSafeInteger(item.bytes) && Number(item.bytes) > 0 && Number(item.bytes) <= IMAGE_LIMITS.outputBytes
    && Number.isSafeInteger(item.width) && Number(item.width) > 0 && Number(item.width) <= IMAGE_LIMITS.dimension
    && Number.isSafeInteger(item.height) && Number(item.height) > 0 && Number(item.height) <= IMAGE_LIMITS.dimension
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)
    && typeof item.createdAt === 'string' && item.createdAt.length <= 32 && Number.isFinite(Date.parse(item.createdAt));
}

export interface ImageToolResult {
  readonly kind: 'image_result';
  readonly text: string;
  readonly images: readonly ImageReference[];
}

export function checkedImageReferences(value: unknown): readonly ImageReference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || !value.every(isImageReference)) {
    throw new TypeError('images must contain one to four valid persistent image references');
  }
  return value;
}

export function isImageToolResult(value: unknown): value is ImageToolResult {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'image_result';
}
