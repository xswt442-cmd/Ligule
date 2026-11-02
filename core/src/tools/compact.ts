// 上下文压缩工具：查看压力与压缩块、按块读回被压缩的原文，并由模型自选范围撰写摘要。
// 压缩只改写后续请求看到的历史投影；原始事件、压缩块和溢出文件全部保持可查。
// 工具操作的是会话自身的派生状态，不访问用户文件系统，因此与 skill 工具同为固定披露入口。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { resultLimit } from '../kernel/result.js';
import { SPILL_NAME } from '../session/spill.js';
import { loadCheckpointFile, type CompactionBlock } from '../session/checkpoint.js';
import { compressibleRange, flatten, SUMMARY_SPILL_NAME } from '../session/compaction.js';
import { estimateTokens, type ProviderCacheUsage } from '../session/usage.js';
import { marker } from './common.js';
import type { SessionEvent } from '../session/format.js';

const ACTIONS = ['status', 'blocks', 'read', 'spill', 'compress'];

interface CompactionHandle {
  context(): Promise<{
    window: number;
    threshold: number;
    soft: number;
    retained: number;
    reserved: number;
    estimated: number;
    factor: number;
    measurement: string;
    reported: { seq: number; input: number | null; output: number | null; cache?: ProviderCacheUsage } | null;
  }>;
  compactRange(args: { fromSeq?: number; toSeq?: number; summary: string }): Promise<{ blockId: number; fromSeq: number; toSeq: number; tokensBefore: number; tokensAfter: number } | null>;
}

export interface CompactToolDeps {
  // 压缩实例随所选模型重建，工具通过取值函数读取当前那一个。
  readonly compaction: () => CompactionHandle | null;
  readonly session: { read(): Promise<SessionEvent[]> };
  readonly directory: string;
  readonly id: string;
}

function windowSlice(text: string, offsetBytes: number, maxBytes: number, what: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (offsetBytes >= bytes.length) return '';
  if (offsetBytes < bytes.length && (bytes[offsetBytes] & 0xc0) === 0x80) {
    throw new KernelError('compact_offset_invalid', { detail: 'offsetBytes must point to a UTF-8 character boundary' });
  }
  const remaining = bytes.length - Math.min(offsetBytes, bytes.length);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const page = (length: number) => {
    let end = Math.min(offsetBytes + length, bytes.length);
    while (end > offsetBytes && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const kept = decoder.decode(bytes.subarray(offsetBytes, end));
    const consumed = end - offsetBytes;
    return { consumed, text: kept + (consumed < remaining
      ? marker(`truncated: ${consumed} of ${remaining} bytes of ${what} shown, continue with offsetBytes=${end}`)
      : '') };
  };
  let low = 0;
  let high = Math.min(remaining, maxBytes);
  let best = page(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = page(middle);
    if (Buffer.byteLength(JSON.stringify({ text: candidate.text }), 'utf8') <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (remaining > 0 && best.consumed === 0) {
    throw new KernelError('compact_result_limit_too_small', { detail: 'resultBytes is too small for a page and its continuation marker' });
  }
  return best.text;
}

export function createCompactTool({ compaction, session, directory, id }: CompactToolDeps) {
  return {
    name: 'compact',
    access: 'read' as const,
    // 上下文管理不依赖模式选择的工具清单：配置了窗口的会话始终可用。
    disclosure: true,
    description: 'Manage this conversation\'s context. action "status" shows context usage and the range that can be summarized; '
      + '"blocks" lists compaction blocks with their summaries; "read" returns the original events a block covers; '
      + '"spill" reads an overflow file named in a tool result or block summary: pass its name and use the returned offsetBytes to continue; '
      + '"compress" replaces a completed range of earlier turns with a summary you write. '
      + 'Compression only changes what later requests see; the session record keeps every event.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of status, blocks, read, spill, compress.' },
        summary: { type: 'string', description: 'The summary you wrote for the covered range, for action "compress".' },
        fromSeq: { type: 'integer', minimum: 0, description: 'First event of the range, for "compress"; defaults to just after the last block.' },
        toSeq: { type: 'integer', minimum: 0, description: 'Last event of the range, for "compress"; defaults to the latest boundary before the current turn.' },
        blockId: { type: 'integer', minimum: 1, description: 'Block number from "blocks", for action "read".' },
        name: { type: 'string', description: 'Overflow file name shown in a result or block summary, for action "spill".' },
        offsetBytes: { type: 'integer', minimum: 0, description: 'Byte offset to continue from after a truncation, for "read" or "spill".' },
      },
      required: ['action'],
    },
    async run(args: { action?: string; summary?: string; fromSeq?: number; toSeq?: number; blockId?: number; name?: string; offsetBytes?: number }, { config }: { config: Record<string, unknown> }) {
      const resultBytes = resultLimit(config);
      const action = args.action;
      if (typeof action !== 'string' || !ACTIONS.includes(action)) {
        throw new KernelError('compact_action_invalid', { detail: `action must be one of ${ACTIONS.join(', ')}` });
      }
      const events = await session.read();
      const { blocks } = await loadCheckpointFile({ directory, id, events });

      if (action === 'status') {
        const current = compaction();
        if (current === null) return { text: 'no context window is configured; compaction is off for this session' };
        const usage = await current.context();
        const range = compressibleRange(events, blocks);
        return {
          text: `window ${usage.window} tokens, threshold ${usage.threshold}${usage.reserved > 0 ? ` (output reserved ${usage.reserved})` : ''}, `
            + `soft reminder at ${usage.soft}, estimated ${usage.estimated} (calibration factor ${usage.factor})\n`
            + `compaction blocks: ${blocks.length}\n`
            + (range === null
              ? 'no completed history outside the current turn is compressible yet'
              : `compressible range: events ${range.fromSeq}..${range.toSeq}`),
        };
      }

      if (action === 'blocks') {
        if (blocks.length === 0) return { text: 'no compaction blocks yet; action "status" shows the range that can be summarized' };
        const reasons = new Map<number, string>();
        for (const event of events) {
          if (event.kind === 'compaction' && typeof event.blockId === 'number') reasons.set(event.blockId, String(event.reason));
        }
        const lines = blocks.map((block: CompactionBlock) =>
          `block ${block.blockId}: events ${block.fromSeq}..${block.toSeq}, ~${estimateTokens(block.text)} tokens, ${reasons.get(block.blockId) ?? 'unknown reason'}\n${block.text}`);
        return { text: windowSlice(lines.join('\n\n'), 0, resultBytes, 'the block list') };
      }

      if (action === 'read') {
        if (typeof args.blockId !== 'number' || !Number.isInteger(args.blockId)) {
          throw new KernelError('compact_block_required', { detail: 'action "read" takes the block number from "blocks"' });
        }
        const block = blocks.find((item: CompactionBlock) => item.blockId === args.blockId);
        if (block === undefined) {
          throw new KernelError('compact_block_unknown', { detail: `no block ${args.blockId}; action "blocks" lists the existing ones` });
        }
        const covered = events.filter((event) => Number(event.seq) >= block.fromSeq && Number(event.seq) <= block.toSeq);
        return { text: windowSlice(flatten(covered), args.offsetBytes ?? 0, resultBytes, `block ${block.blockId}`) };
      }

      if (action === 'spill') {
        const name = args.name;
        if (typeof name !== 'string' || !(SPILL_NAME.test(name) || SUMMARY_SPILL_NAME.test(name))) {
          throw new KernelError('compact_spill_name_invalid', { detail: 'action "spill" takes an overflow file name referenced by a tool result or block summary' });
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(join(directory, name));
        } catch (cause) {
          throw new KernelError('compact_spill_missing', { cause, detail: `${name} is not in this session's record directory` });
        }
        return { text: windowSlice(bytes.toString('utf8'), args.offsetBytes ?? 0, resultBytes, name) };
      }

      // compress：范围与摘要都由模型提供；摘要为空或范围非法时给出可行动的错误。
      const current = compaction();
      if (current === null) {
        throw new KernelError('compact_window_unset', { detail: 'no context window is configured for this session' });
      }
      const done = await current.compactRange({ fromSeq: args.fromSeq, toSeq: args.toSeq, summary: args.summary ?? '' });
      if (done === null) {
        return { text: 'the summary would not shrink the projection, so nothing was compressed; write a shorter summary or compress a larger range' };
      }
      return {
        text: `block ${done.blockId} now covers events ${done.fromSeq}..${done.toSeq} `
          + `(${done.tokensBefore} -> ${done.tokensAfter} estimated tokens); the next request sees the summary in place of that range`,
      };
    },
  };
}

export function createCompactPlugin(deps: CompactToolDeps) {
  return {
    name: 'ligule-compact',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register(createCompactTool(deps));
    },
  };
}
