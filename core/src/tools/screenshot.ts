import { KernelError } from '../kernel/error.js';
import { captureScreen, type CaptureOptions } from '../capability/screen-capture.js';
import type { MediaStore } from '../capability/media.js';
import type { ImageToolResult } from '../media.js';
import type { ToolDefinition } from '../kernel/kernel.js';

export interface ScreenshotDeps {
  readonly media?: MediaStore;
  readonly supportsImages?: () => boolean;
  readonly authorize?: () => Promise<AbortSignal>;
}

export function createScreenshotPlugin({ media, supportsImages, authorize }: ScreenshotDeps = {}) {
  return {
    name: 'ligule-screenshot',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'screenshot', access: 'read', readOnly: true, execution: 'serial',
        description: 'Capture one Windows screen or active window after independent screen-capture authorization. Returns an actual image, shotId and Workspace screenshot reference. No recording, mouse or keyboard control. Regions use non-negative physical desktop pixels relative to the chosen target before output resizing.',
        parameters: { type: 'object', additionalProperties: false, properties: {
          target: { type: 'string', enum: ['screen', 'active-window'] },
          region: { type: 'object', additionalProperties: false, properties: {
            x: { type: 'integer', minimum: 0, maximum: 100000 }, y: { type: 'integer', minimum: 0, maximum: 100000 },
            width: { type: 'integer', minimum: 1, maximum: 40000000 }, height: { type: 'integer', minimum: 1, maximum: 40000000 },
          }, required: ['x', 'y', 'width', 'height'] },
        } },
        async run(args: CaptureOptions, { signal }: { signal?: AbortSignal }): Promise<ImageToolResult> {
          if (supportsImages?.() !== true) throw new KernelError('model_image_input_unsupported');
          if (authorize === undefined) throw new KernelError('screen_capture_not_authorized');
          if (media === undefined) throw new KernelError('image_store_unavailable');
          const permission = await authorize();
          const captureSignal = AbortSignal.any([permission, ...(signal === undefined ? [] : [signal])]);
          captureSignal.throwIfAborted();
          const captured = await captureScreen(args, captureSignal);
          await authorize();
          captureSignal.throwIfAborted();
          const reference = await media.put(captured.png, 'desktop', captureSignal);
          return { kind: 'image_result', text: JSON.stringify({ shotId: reference.id,
            path: `screenshots/${reference.id}.png`, createdAt: reference.createdAt,
            width: reference.width, height: reference.height, mimeType: reference.mimeType,
            target: captured.target, sourceWidth: captured.sourceWidth, sourceHeight: captured.sourceHeight,
          }), images: [reference] };
        },
      } satisfies ToolDefinition<CaptureOptions>);
    },
  };
}
