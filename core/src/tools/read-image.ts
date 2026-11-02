import { KernelError } from '../kernel/error.js';
import { readImageFile, type MediaStore } from '../capability/media.js';
import type { ToolContext, ToolDefinition } from '../kernel/kernel.js';
import type { ImageToolResult } from '../media.js';

interface ReadImageArguments { readonly path?: string; readonly shotId?: string }
interface ReadImageDeps { readonly media?: MediaStore; readonly supportsImages?: () => boolean }

export function createReadImagePlugin({ media, supportsImages }: ReadImageDeps = {}) {
  return {
    name: 'ligule-read-image',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'read_image', access: 'read', readOnly: true, execution: 'parallel',
        description: 'View a PNG, JPEG, WebP or GIF image within the file boundary, or reread an owned screenshot by shotId. Requires an image-capable model. Returns an actual image plus a persistent reference; animated images use the first frame.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 2048, description: 'Image file path relative to the working directory; use exactly one of path or shotId.' },
            shotId: { type: 'string', minLength: 36, maxLength: 36, description: 'An image ID owned by this Session or explicitly inherited in its branch history.' },
          },
        },
        async run(args: ReadImageArguments, { config, signal }: Pick<ToolContext, 'config' | 'signal'>): Promise<ImageToolResult> {
          if (supportsImages?.() !== true) throw new KernelError('model_image_input_unsupported');
          if (media === undefined) throw new KernelError('image_store_unavailable');
          if ((args.path === undefined) === (args.shotId === undefined)) throw new KernelError('image_source_required', { detail: 'provide exactly one of path or shotId' });
          signal?.throwIfAborted();
          const reference = args.shotId === undefined
            ? await media.put(await readImageFile(config, args.path!, signal), 'file', signal)
            : await media.reference(args.shotId);
          signal?.throwIfAborted();
          return { kind: 'image_result', text: `Image ${reference.id}: ${reference.width}×${reference.height}, ${reference.mimeType}, ${reference.bytes} bytes.`, images: [reference] };
        },
      } satisfies ToolDefinition<ReadImageArguments>);
    },
  };
}
