// 将会话记录导出为 Markdown。记录和溢出内容由 Host 读取，此模块负责排版和写文件。
// 用户界面负责选择目标路径。
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { checkedImageReferences, IMAGE_LIMITS, IMAGE_ID, isImageReference, type ImageReference } from '../media.js';
import type { SessionEvent } from '../session/format.js';

/** 导出结果中每个文件的状态，包括已写入、目标已存在和写入失败。 */
export interface Exported {
  readonly written: readonly string[];
  readonly skipped: readonly { id: string; path?: string; code: string }[];
  readonly failed: readonly { path: string; code: string }[];
}

export interface ExportRecord {
  readonly kind: string;
  readonly seq?: number;
  readonly raw?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly args?: Record<string, unknown> }[];
  readonly result?: {
    readonly content?: unknown;
    readonly failed?: boolean;
    readonly code?: string;
    readonly spilled?: string;
    readonly images?: readonly ImageReference[];
  };
  readonly name?: string;
  readonly layer?: string;
}

export interface ExportAsset {
  readonly reference: ImageReference;
  readonly data: Buffer;
}

export const MAX_EXPORT_ASSETS = 4096;
const fence = (value: string) => `\`\`\`\n${value.replace(/\n+$/, '')}\n\`\`\``;
const stemOf = (path: string) => path.replace(/\.(md|markdown|txt)$/i, '');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exportRecordOf(event: SessionEvent): ExportRecord | undefined {
  if (typeof event.kind !== 'string') return undefined;
  const record: {
    kind: string;
    seq?: number;
    raw?: string;
    text?: string;
    tool?: string;
    toolCalls?: { id: string; name: string; args?: Record<string, unknown> }[];
    result?: { content?: unknown; failed?: boolean; code?: string; spilled?: string; images?: readonly ImageReference[] };
    name?: string;
    layer?: string;
  } = { kind: event.kind };
  if (typeof event.seq === 'number') record.seq = event.seq;
  if (typeof event.raw === 'string') record.raw = event.raw;
  if (typeof event.text === 'string') record.text = event.text;
  if (typeof event.tool === 'string') record.tool = event.tool;
  if (typeof event.name === 'string') record.name = event.name;
  if (typeof event.layer === 'string') record.layer = event.layer;
  if (Array.isArray(event.toolCalls)) {
    record.toolCalls = event.toolCalls.flatMap((call) => isRecord(call) && typeof call.id === 'string' && typeof call.name === 'string'
      ? [{ id: call.id, name: call.name, ...(isRecord(call.args) ? { args: call.args } : {}) }]
      : []);
  }
  if (isRecord(event.result)) {
    record.result = {
      ...(Object.hasOwn(event.result, 'content') ? { content: event.result.content } : {}),
      ...(typeof event.result.failed === 'boolean' ? { failed: event.result.failed } : {}),
      ...(typeof event.result.code === 'string' ? { code: event.result.code } : {}),
      ...(typeof event.result.spilled === 'string' ? { spilled: event.result.spilled } : {}),
      ...(event.result.images === undefined ? {} : { images: checkedImageReferences(event.result.images) }),
    };
  }
  return record;
}

// 优先显示结构化结果中的 `text` 字段；其他结果序列化为文本，失败时附带稳定错误码。
function resultBody(record: ExportRecord): string {
  const content = record.result?.content;
  if (typeof content === 'string') return content;
  if (content !== null && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return JSON.stringify({ content, code: record.result?.code, spilled: record.result?.spilled }, null, 2);
}

// 派生结果可能将支线 ID 存在溢出文件中，需在读取完整结果后提取。
export function branchSessionId(record: ExportRecord): string | undefined {
  if (record.kind !== 'tool' || record.tool !== 'subagent') return undefined;
  const id = (record.result?.content as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function relativeUrl(path: string): string {
  return path.split(/[\\/]/u).map((part) => encodeURIComponent(part)).join('/');
}

/** 返回相对于 Markdown 文件的受控图片路径。 */
export function exportImageUrl(path: string, id: string): string {
  if (!IMAGE_ID.test(id)) throw new TypeError('export image id is invalid');
  const directory = `${basename(stemOf(path))}.assets`;
  return relativeUrl(join(directory, `${id}.png`));
}

function imageMarkdown(image: ImageReference, imageUrls?: ReadonlyMap<string, string>): string[] {
  const url = imageUrls?.get(image.id);
  return [
    url === undefined ? `- 图片文件未随导出包含：${image.id}` : `![图片 ${image.id}](${url})`,
    `- 图片引用：${image.id}`,
    `- 尺寸：${image.width} × ${image.height}`,
    `- 来源：${image.source}`,
    `- 类型与大小：${image.mimeType}，${image.bytes} 字节`,
    `- 创建时间：${image.createdAt}`,
    `- SHA-256：${image.sha256}`,
    '',
  ];
}

/** 将会话记录写为 Markdown；工具调用及其结果分别成段，并保留事件序号供 `/show` 定位。 */
export function exportMarkdown(
  events: readonly ExportRecord[],
  meta: { id: string; projectRoot?: string; createdAt?: string | null; unfinished?: boolean },
  imageUrls?: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [`# ligule 会话 ${meta.id}`, ''];
  if (meta.projectRoot !== undefined && meta.projectRoot !== '') lines.push(`- 项目根：${meta.projectRoot}`, '');
  if (meta.createdAt !== undefined && meta.createdAt !== null) lines.push(`- 开始：${meta.createdAt}`, '');
  // 导出末尾序号表示本次读取的快照边界，不表示会话轮次已结束。
  if (meta.unfinished === true) lines.push('> 导出这一刻这一份会话还在跑：这份文件到记录落到那一条为止，后面写进来的不在这份里。', '');
  for (const record of events) {
    if (record.kind === 'user') lines.push(`## 第 ${record.seq} 条 · 你说`, '', record.raw ?? record.text ?? '', '');
    else if (record.kind === 'reasoning') lines.push(`## 第 ${record.seq} 条 · 推理`, '', record.text ?? '', '');
    else if (record.kind === 'assistant') {
      lines.push(`## 第 ${record.seq} 条 · 模型`, '');
      if (record.text !== undefined && record.text !== '') lines.push(record.text, '');
      for (const call of record.toolCalls ?? []) {
        lines.push(`### 第 ${record.seq} 条的一次调用 · ${call.name}`, '', fence(JSON.stringify(call.args ?? {}, null, 2)), '');
      }
    } else if (record.kind === 'tool') {
      lines.push(`### 第 ${record.seq} 条 · ${record.tool} 的结果`);
      if (record.result?.failed === true) lines.push(`（这一次没做成）${record.result.code === undefined ? '' : ` ${record.result.code}`}`);
      lines.push('', resultBody(record), '');
      for (const image of record.result?.images ?? []) lines.push(...imageMarkdown(image, imageUrls));
    } else if (record.kind === 'mode') {
      lines.push(`> 第 ${record.seq} 条：模式 ${record.name}（${record.layer ?? ''}）生效`, '');
    }
    // `session` 首行和 `usage` 事件是元数据，不作为会话内容段落导出。
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function errorCode(cause: unknown, fallback = 'write_failed'): string {
  return String((cause as { code?: string } | null)?.code ?? fallback);
}

interface PreparedAsset extends ExportAsset {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function safeAssetDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function matchesExistingAsset(path: string, data: Buffer, sha256: string): Promise<boolean> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== data.length) return false;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== data.length) return false;
    const bytes = Buffer.alloc(data.length + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, Math.min(bytes.length - length, 64 * 1024), null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return length === data.length && digest(bytes.subarray(0, length)) === sha256;
  } finally {
    await file.close();
  }
}

async function writeAsset(path: string, data: Buffer, sha256: string): Promise<'written' | 'reused' | 'conflict'> {
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    return 'written';
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return await matchesExistingAsset(path, data, sha256) ? 'reused' : 'conflict';
  }
}

function disableImageLinks(markdown: string, ids: ReadonlySet<string>): string {
  let result = markdown;
  for (const id of ids) result = result.replace(new RegExp(`!\\[图片 ${id}\\]\\([^\\n)]*\\)`, 'gu'), `- 图片文件未导出：${id}`);
  return result;
}

function prepareAssets(path: string, assets: readonly ExportAsset[], failed: { path: string; code: string }[]): PreparedAsset[] {
  const stem = stemOf(path);
  const assetDirectory = `${stem}.assets`;
  const unique = new Map<string, PreparedAsset>();
  const invalidIds = new Set<string>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const validReference = isImageReference(asset?.reference);
    const id = validReference ? asset.reference.id : `invalid-${index}`;
    const assetPath = join(assetDirectory, `${id}.png`);
    if (!validReference || !Buffer.isBuffer(asset.data) || asset.data.length !== asset.reference.bytes
      || digest(asset.data) !== asset.reference.sha256) {
      failed.push({ path: assetPath, code: 'export_asset_invalid' });
      if (validReference) invalidIds.add(id);
      continue;
    }
    const previous = unique.get(id);
    if (previous !== undefined) {
      if (previous.sha256 !== asset.reference.sha256) {
        failed.push({ path: assetPath, code: 'export_asset_conflict' });
        unique.delete(id);
        invalidIds.add(id);
      }
      continue;
    }
    unique.set(id, { ...asset, id, path: assetPath, sha256: asset.reference.sha256 });
  }
  const prepared: PreparedAsset[] = [];
  let totalBytes = 0;
  for (const asset of unique.values()) {
    if (invalidIds.has(asset.id)) continue;
    if (prepared.length >= MAX_EXPORT_ASSETS || totalBytes + asset.data.length > IMAGE_LIMITS.storageBytes) {
      failed.push({ path: asset.path, code: 'export_asset_limit_exceeded' });
      invalidIds.add(asset.id);
      continue;
    }
    prepared.push(asset);
    totalBytes += asset.data.length;
  }
  for (const id of invalidIds) unique.delete(id);
  return prepared;
}

/** 导出主会话、派生会话和 Host 已验证的图片字节；资产目标冲突不会覆盖已有文件。 */
export async function writeExport(
  path: string,
  main: string,
  branches: readonly { id: string; text: string }[],
  assets: readonly ExportAsset[] = [],
): Promise<Exported> {
  await mkdir(dirname(path), { recursive: true });
  const written: string[] = [];
  const skipped: { id: string; path?: string; code: string }[] = [];
  const failed: { path: string; code: string }[] = [];
  const assetErrorsStart = failed.length;
  const readyAssets = assets.length === 0 ? [] : prepareAssets(path, assets, failed);
  const unavailableImageIds = new Set(failed.slice(assetErrorsStart).flatMap((entry) => {
    const id = /([0-9a-f-]{36})\.png$/u.exec(entry.path)?.[1];
    return id === undefined ? [] : [id];
  }));
  if (readyAssets.length > 0) {
    const assetDirectory = `${stemOf(path)}.assets`;
    let available = false;
    let directoryError: string | undefined;
    try { available = await safeAssetDirectory(assetDirectory); }
    catch (cause) { directoryError = errorCode(cause); }
    if (!available) {
      const code = directoryError ?? 'export_asset_directory_invalid';
      for (const asset of readyAssets) {
        failed.push({ path: asset.path, code });
        unavailableImageIds.add(asset.id);
      }
    } else if (available) {
      for (const asset of readyAssets) {
        try {
          if (!(await safeAssetDirectory(assetDirectory))) {
            failed.push({ path: asset.path, code: 'export_asset_directory_invalid' });
            unavailableImageIds.add(asset.id);
            continue;
          }
          const result = await writeAsset(asset.path, asset.data, asset.sha256);
          if (result === 'conflict') {
            failed.push({ path: asset.path, code: 'export_asset_conflict' });
            unavailableImageIds.add(asset.id);
          } else written.push(asset.path);
        } catch (cause) {
          failed.push({ path: asset.path, code: errorCode(cause) });
          unavailableImageIds.add(asset.id);
        }
      }
    }
  }
  const mainText = disableImageLinks(main, unavailableImageIds);
  try {
    await writeFile(path, mainText);
    written.push(path);
  } catch (cause) {
    failed.push({ path, code: errorCode(cause) });
  }
  const stem = stemOf(path);
  for (const branch of branches) {
    const branchPath = `${stem}.${branch.id}.md`;
    try {
      // 使用独占创建，避免检查路径和写入之间的竞态覆盖已有文件。
      await writeFile(branchPath, disableImageLinks(branch.text, unavailableImageIds), { flag: 'wx' });
      written.push(branchPath);
    } catch (cause) {
      const code = errorCode(cause);
      // 目标文件已存在时不覆盖其内容。
      if (code === 'EEXIST') skipped.push({ id: branch.id, path: branchPath, code: 'export_target_exists' });
      else failed.push({ path: branchPath, code });
    }
  }
  return { written, skipped, failed };
}
