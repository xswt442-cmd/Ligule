// 项目指令按四层加载：管理端、用户、项目根和当前目录向上查找的目录级文件。
// 越靠近当前目录的文件优先级越高；文件名固定为 `AGENTS.md`。
// 指令内容会注入模型，因此受字节上限约束；超限时在末尾添加说明。
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { KernelError } from '../errors.js';
import { matchesName } from '../kernel/match.js';
import { isWithin } from './paths.js';

const FILE_NAME = 'AGENTS.md';

type InstructionLayer = 'managed' | 'user' | 'project' | 'directory';
type InstructionFile = { layer: InstructionLayer; path: string; text: string; key: string };
type TruncatedFile = { path: string; from: number; to: number };
type InstructionFileResult = { path: string; layer: InstructionLayer };
type LoadInstructionsOptions = {
  boundary?: string;
  current?: string;
  managed?: string;
  user?: string;
  maxBytes?: number;
  exclude?: string[];
};
type LoadInstructionsResult = { text: string; files: InstructionFileResult[] };

// 排除路径统一使用正斜杠，保持跨平台比较一致。
const toPosix = (path: string): string => path.split(sep).join('/');

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new KernelError('instructions_read_failed', { cause: error });
  }
}

async function identity(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // 文件在读取和解析真实路径期间被删除时，使用原路径作为去重键。
    return path;
  }
}

// 从当前目录逐层向上查找 `AGENTS.md`，到项目根后停止，不读取项目范围之外的指令文件。
// 项目根判断和路径去重使用同一真实路径身份，避免 Windows 路径大小写差异导致越过项目根。
async function walkUpTo(boundary: string, current: string): Promise<string[]> {
  const found = [];
  const root = resolve(boundary);
  const realRoot = await identity(root);
  let directory = resolve(current);
  while (isWithin(root, directory) && (await identity(directory)) !== realRoot) {
    found.unshift(directory);
    directory = dirname(directory);
  }
  found.unshift(root);
  return found;
}

// 四层指令共用的默认字节预算；加载提示词片段时也使用该值，避免重复截断。
export const DEFAULT_INSTRUCTION_BYTES = 32_000;

export async function loadInstructions(options: LoadInstructionsOptions = {}): Promise<LoadInstructionsResult> {
  const { boundary, current: requestedCurrent, managed, user, maxBytes = DEFAULT_INSTRUCTION_BYTES, exclude = [] } = options;
  if (typeof boundary !== 'string' || boundary === '') throw new KernelError('instructions_boundary_required');
  if (!(maxBytes >= 1)) throw new KernelError('instructions_max_bytes_required');
  const current = requestedCurrent === undefined ? boundary : requestedCurrent;
  // 确认查找起点位于项目根内，避免读取项目边界之外的指令文件。
  if (!isWithin(resolve(boundary), resolve(current))) throw new KernelError('instructions_current_outside_boundary');

  const layers: InstructionFile[] = [];
  const push = async (layer: InstructionLayer, path: string | undefined): Promise<void> => {
    if (path === undefined) return;
    const comparable = toPosix(path);
    if ((layer === 'project' || layer === 'directory') && exclude.some((pattern) => matchesName(comparable, toPosix(pattern)))) return;
    const text = await readIfExists(path);
    if (text === undefined) return;
    layers.push({ layer, path, text, key: await identity(path) });
  };

  await push('managed', managed);
  await push('user', user);
  const directories = await walkUpTo(boundary, current);
  for (const [index, directory] of directories.entries()) {
    await push(index === 0 ? 'project' : 'directory', join(directory, FILE_NAME));
  }

  // 符号链接或嵌套仓库可能指向同一文件；按真实路径去重，并保留优先级更高的版本。
  const unique: InstructionFile[] = [];
  for (const file of layers) {
    const duplicate = unique.findIndex((entry) => entry.key === file.key);
    if (duplicate >= 0) unique.splice(duplicate, 1);
    unique.push(file);
  }

  // 预算覆盖完整结果，包括标题、段间空行和末尾说明。
  // 标题和说明使用相对项目根的路径，避免绝对路径占用大量预算。
  const nameOf = (item: string | { path: string }): string => toPosix(relative(resolve(boundary), typeof item === 'string' ? item : item.path));
  const headingOf = (file: InstructionFile): string => `## ${nameOf(file)}\n\n`;
  const listed = (files: readonly (InstructionFile | TruncatedFile)[], name: string): string => (files.length <= 3
    ? `${name} ${files.map(nameOf).join(', ')}`
    : `${name} ${files.slice(0, 3).map(nameOf).join(', ')} and ${files.length - 3} more`);
  const markerFor = (
    omittedFiles: readonly InstructionFile[],
    truncatedFiles: readonly TruncatedFile[],
    detailed: boolean,
  ): string => {
    const notes: string[] = [];
    if (omittedFiles.length > 0) {
      notes.push(detailed ? listed(omittedFiles, 'omitted') : `omitted ${omittedFiles.length} file(s)`);
    }
    if (truncatedFiles.length > 0) {
      notes.push(detailed
        ? `truncated ${truncatedFiles.map((item) => `${nameOf(item)} from ${item.from} to ${item.to} bytes`).join(', ')}`
        : `truncated ${truncatedFiles.length} file(s)`);
    }
    return notes.length === 0 ? '' : `\n\n[Instruction budget ${maxBytes} bytes: ${notes.join('; ')}]`;
  };
  const assemble = (
    keptFiles: readonly InstructionFile[],
    omittedFiles: readonly InstructionFile[],
    truncatedFiles: readonly TruncatedFile[],
    detailed: boolean,
  ): string => `${
    keptFiles.map((file) => `${headingOf(file)}${file.text}`).join('\n\n')
  }${markerFor(omittedFiles, truncatedFiles, detailed)}`;

  // 按优先级从高到低分配预算；空间不足时截断当前文件，后续文件不再加入。
  // 预留末尾说明所需空间，避免最后一段内容占满预算后又被说明挤掉。
  const MARKER_RESERVE = 96;
  const kept: InstructionFile[] = [];
  const omitted: InstructionFile[] = [];
  const truncated: TruncatedFile[] = [];
  let used = 0;
  for (const file of [...unique].reverse()) {
    const separator = used > 0 ? 2 : 0;
    const heading = Buffer.byteLength(headingOf(file), 'utf8');
    const bytes = Buffer.byteLength(file.text, 'utf8');
    const room = maxBytes - MARKER_RESERVE - used - separator - heading;
    if (room < 1) {
      omitted.unshift(file);
      continue;
    }
    if (bytes <= room) {
      kept.unshift(file);
      used += separator + heading + bytes;
      continue;
    }
    const note = `\n[truncated from ${bytes} bytes]`;
    const budget = room - Buffer.byteLength(note, 'utf8');
    if (budget < 1) {
      omitted.unshift(file);
      continue;
    }
    let head = Buffer.from(file.text, 'utf8').subarray(0, budget).toString('utf8');
    while (Buffer.byteLength(head, 'utf8') > budget) head = head.slice(0, -1);
    // 按字节截断可能切开多字节字符；标记长度和用量按实际解码后的文本计算。
    const keptBytes = Buffer.byteLength(head, 'utf8');
    kept.unshift({ ...file, text: `${head}${note}` });
    truncated.unshift({ path: file.path, from: bytes, to: keptBytes });
    used += separator + heading + keptBytes + Buffer.byteLength(note, 'utf8');
  }

  // 说明行也占用预算。先缩短说明，再从最低优先级开始移除内容，为有效指令保留空间。
  let detailed = true;
  let text = assemble(kept, omitted, truncated, detailed);
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    if (detailed) {
      detailed = false;
    } else if (kept.length > 0) {
      const dropped = kept.pop();
      if (dropped === undefined) throw new Error('an instruction layer disappeared while reducing the output');
      omitted.unshift(dropped);
    } else {
      break;
    }
    text = assemble(kept, omitted, truncated, detailed);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    // 预算不足以容纳简短说明时按字节截断，仍保留可见的截断提示。
    let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
    while (Buffer.byteLength(cut, 'utf8') > maxBytes) cut = cut.slice(0, -1);
    text = cut;
  }
  return { text, files: kept.map((file) => ({ path: file.path, layer: file.layer })) };
}
