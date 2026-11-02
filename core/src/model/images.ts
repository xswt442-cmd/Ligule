import { createHash } from 'node:crypto';
import { KernelError } from '../kernel/error.js';
import { checkedImageReferences, type ImageReference } from '../media.js';
import type { ModelRequest } from '../kernel/loop.js';

/** Explicit per-model declarations override the small set of verified official routes. */
export function imageInputOf(baseUrl: string, model: string, declared?: boolean, api: 'messages' | 'chat-completions' = 'chat-completions'): boolean {
  if (declared !== undefined) {
    if (typeof declared !== 'boolean') throw new KernelError('provider_image_capability_invalid');
    return declared;
  }
  const url = new URL(baseUrl);
  const paths = api === 'messages' ? ['/anthropic/v1'] : ['', '/v1'];
  return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && url.port === ''
    && paths.includes(url.pathname.replace(/\/$/u, ''))
    && ['deepseek-flash', 'deepseek-v4-flash-vision-exp'].includes(model);
}

export async function resolveRequestImages(request: ModelRequest, supported: boolean, signal?: AbortSignal | null): Promise<ReadonlyMap<ImageReference, string>> {
  const images = new Map<ImageReference, string>();
  let totalBytes = 0;
  let count = 0;
  for (const message of request.messages ?? []) {
    if (message.role !== 'tool' || message.images === undefined) continue;
    const references = checkedImageReferences(message.images);
    if (!supported) throw new KernelError('model_image_input_unsupported');
    if (request.resolveImage === undefined) throw new KernelError('image_resolver_unavailable');
    for (const reference of references) {
      signal?.throwIfAborted();
      totalBytes += reference.bytes;
      count += 1;
      if (count > 8 || totalBytes > 16 * 1024 * 1024) throw new KernelError('provider_image_budget_exceeded');
      const bytes = await request.resolveImage(reference, signal ?? undefined);
      if (bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
        throw new KernelError('image_digest_mismatch');
      }
      images.set(reference, bytes.toString('base64'));
    }
  }
  return images;
}
