import { KernelError } from '../errors.js';

export const DOCUMENT_LIMITS = Object.freeze({ inputBytes: 20 * 1024 * 1024, outputBytes: 24_000,
  timeoutMs: 15_000, zipBytes: 64 * 1024 * 1024, zipEntries: 2000, units: 200,
  cells: 10_000, pixels: 4_194_304, dimension: 2048 });

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';
export interface DocumentOptions {
  readonly path: string;
  readonly start?: number;
  readonly count?: number;
  readonly offset?: number;
  readonly sheet?: string;
  readonly range?: { readonly startRow: number; readonly endRow: number; readonly startColumn: number; readonly endColumn: number };
  readonly renderPage?: number;
}
export interface DocumentChunk { readonly location: string; readonly text: string }
export interface DocumentResult {
  readonly format: DocumentFormat;
  readonly total: number;
  readonly chunks: readonly DocumentChunk[];
  readonly truncated: boolean;
  readonly continuation: DocumentOptions | null;
  readonly warnings: readonly string[];
  readonly sheets?: readonly string[];
}
export interface DocumentRequest {
  readonly options: DocumentOptions;
  readonly format: DocumentFormat;
  readonly outputBytes: number;
  readonly input: Buffer;
}

export function checkedDocumentOptions(options: DocumentOptions): DocumentFormat {
  const format = options.path.split('.').at(-1)?.toLowerCase();
  if (format !== 'pdf' && format !== 'docx' && format !== 'xlsx' && format !== 'pptx') throw new KernelError('document_format_unsupported');
  for (const [name, value, max] of [['start', options.start, 1_048_576], ['count', options.count, 20],
    ['offset', options.offset, 64 * 1024 * 1024], ['renderPage', options.renderPage, DOCUMENT_LIMITS.units]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (name === 'offset' ? 0 : 1) || value > max)) throw new KernelError('document_options_invalid');
  }
  if ((options.sheet !== undefined || options.range !== undefined) && format !== 'xlsx') throw new KernelError('document_options_invalid');
  if (options.renderPage !== undefined && (format !== 'pdf' || options.start !== undefined || options.count !== undefined || options.offset !== undefined)) throw new KernelError('document_options_invalid');
  if (options.range !== undefined) {
    const range = options.range;
    if (options.start !== undefined || options.count !== undefined
      || ![range.startRow, range.endRow, range.startColumn, range.endColumn].every(value => Number.isSafeInteger(value) && value >= 1)
      || range.startRow > range.endRow || range.startColumn > range.endColumn || range.endRow > 1_048_576 || range.endColumn > 16_384
      || range.endRow - range.startRow >= 200
      || (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > DOCUMENT_LIMITS.cells) throw new KernelError('document_range_invalid');
  }
  return format;
}
