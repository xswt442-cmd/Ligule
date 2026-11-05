// 压缩时将较早的模型上下文交给模型总结，并在检查点中记录摘要和被替换的事件范围。
// 压力触发在请求发送前根据本地估算判断，估算值会用服务端报告的用量校准。
// 超长触发只在服务端报告上下文超限后执行；一次运行最多压缩并重试一次。原始事件日志保持不变。
import { createHash } from 'node:crypto';
import { createBlock, createCheckpointFile, loadCheckpointFile, PROJECTED_KINDS, writeCheckpointFile, type CompactionBlock } from './checkpoint.js';
import { spillContent } from './spill.js';
import { KernelError } from '../errors.js';
import type { SessionEvent } from './format.js';
import { estimateRequest, estimateTokens, usageEvent, type ProviderCacheUsage } from './usage.js';
import type { LoopCompactionRequest, ModelProvider, ModelTool, ProviderEvent } from '../kernel/loop.js';
import { projectModelView } from './session.js';
export { estimateRequest, estimateTokens } from './usage.js';

// 从记录末尾向前累计 Token；超过保留预算后，选择最近的 user 或 assistant 事件作为切点。
// 不在工具结果上切分，以免丢失与它配对的助手工具调用，破坏模型请求结构。
// 如果预算连一条消息都容不下，至少保留最后一条 user 或 assistant 消息，避免生成空上下文。
export function cutPoint(events: SessionEvent[], budgetTokens: number, measure: (event: SessionEvent) => number = estimateTokens): number | null {
  // 切点仅计算模型上下文投影；推理、模式、用量和轮次标记不进入投影，也不占保留预算。
  const list = events.filter((event) => PROJECTED_KINDS.includes(String(event.kind)));
  let total = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    total += measure(list[index]);
    if (total <= budgetTokens) continue;
    for (let cut = index + 1; cut < list.length; cut += 1) {
      const kind = list[cut].kind;
      if (kind === 'user' || kind === 'assistant') return Number(list[cut].seq);
    }
    for (let cut = index; cut >= 0; cut -= 1) {
      const kind = list[cut].kind;
      if (kind === 'user' || kind === 'assistant') return Number(list[cut].seq);
    }
    return null;
  }
  return null;
}

export interface CompactResult {
  blockId: number;
  fromSeq: number;
  toSeq: number;
  tokensBefore: number;
  tokensAfter: number;
}

// 当前轮次从最后一条轮次标记之后的第一条用户消息开始；它之前的历史才允许被模型压缩。
// 没有任何轮次标记时，整个记录都属于第一轮，没有可压缩的完整历史。
export function compressibleToSeq(events: SessionEvent[]): number {
  let lastTurnSeq = -1;
  for (const event of events) {
    if (event.kind === 'turn') lastTurnSeq = Number(event.seq);
  }
  for (const event of events) {
    if (event.kind === 'user' && Number(event.seq) > lastTurnSeq) return Number(event.seq) - 1;
  }
  return Number(events.at(-1)?.seq ?? -1);
}

// 范围内的调用与结果必须成对：任何一侧落在范围外都会让投影出现悬空的工具消息。
function pairingBreaks(events: SessionEvent[], fromSeq: number, toSeq: number): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const event of events) {
    const seq = Number(event.seq);
    if (seq < fromSeq || seq > toSeq) continue;
    if (event.kind === 'assistant') {
      for (const call of (event.toolCalls as { id?: unknown }[] | undefined) ?? []) {
        if (typeof call?.id === 'string' && call.id !== '') calls.add(call.id);
      }
    } else if (event.kind === 'tool') {
      if (typeof event.callId === 'string' && event.callId !== '') results.add(event.callId);
    }
  }
  for (const id of calls) if (!results.has(id)) return true;
  for (const id of results) if (!calls.has(id)) return true;
  return false;
}

// 尚未被块覆盖、又不在当前轮次内的最大可压缩范围。
// 结束边界必须落在 user 或 assistant 消息上，且不悬空调用/结果对。
export function compressibleRange(events: SessionEvent[], blocks: CompactionBlock[]): { fromSeq: number; toSeq: number } | null {
  const fromSeq = blocks.length === 0 ? 0 : Number(blocks[blocks.length - 1].toSeq) + 1;
  for (let end = compressibleToSeq(events); end >= fromSeq; end -= 1) {
    const event = events.find((item) => Number(item.seq) === end);
    if (event === undefined) continue;
    if (event.kind !== 'user' && event.kind !== 'assistant') continue;
    if (pairingBreaks(events, fromSeq, end)) continue;
    return { fromSeq, toSeq: end };
  }
  return null;
}

// 摘要请求使用扁平消息记录：普通消息包含角色和文本，工具消息保留名称与结果。
// 压缩工具读回块内原文时使用同一格式，保证模型看到的内容形状一致。
export function flatten(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.kind === 'user') lines.push(`user: ${String(event.text ?? '')}`);
    else if (event.kind === 'assistant') {
      const calls = (event.toolCalls as { name?: unknown }[] | undefined) ?? [];
      lines.push(`assistant: ${String(event.text ?? '')}${calls.length === 0 ? '' : ` [called ${calls.map((call) => String(call?.name)).join(', ')}]`}`);
    } else if (event.kind === 'tool') {
      const result = event.result as { content?: unknown; failed?: boolean; code?: string; images?: unknown } | undefined;
      const content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? null);
      lines.push(`tool ${String(event.tool ?? '')}${result?.failed === true ? ` (${result.code})` : ''}: ${content}`
        + (result?.images === undefined ? '' : `\nPersistent images (reread by shotId): ${JSON.stringify(result.images)}`));
    }
  }
  return lines.join('\n\n');
}

const INSTRUCTION = 'Write a summary of the transcript excerpt below so a later agent can continue the work. '
  + 'Keep every decision, still-open question, tool outcome, path, command, code fragment and identifier that matters; write each of them exactly as it appeared. '
  + 'Write the prose in the language the conversation is written in, or the language it asks for. Plain prose, no preamble.\n\n';
// 摘要提示词自身的预留：窗口预算扣掉它，避免请求连同摘要在内超出模型限制。
const SUMMARY_PROMPT_RESERVE_TOKENS = 1024;

// 压缩摘要溢出文件的命名；读取方以此校验文件名，防止借工具读取会话目录外的文件。
// 末尾的短哈希区分同范围不同内容的摘要；旧格式不带哈希，读取时仍接受。
export const SUMMARY_SPILL_NAME = /^summary-\d+-\d+(?:-[a-f0-9]{8})?\.txt$/;

// 每次压缩的触发来源：用户命令、自动压力、服务端超限恢复、模型主动调用压缩工具。
export type CompactionReason = 'manual' | 'auto' | 'overflow' | 'model';

// 摘要输入也可能超过模型窗口；超限时保留较新的内容，并说明已省略更早部分。
// 保留先前生成的摘要，避免后续压缩丢失它总结的早期上下文。
function fitExcerpt(text: string, budgetTokens: number): string {
  const bytes = Buffer.from(text, 'utf8');
  const limit = budgetTokens * 4;
  if (bytes.length <= limit) return text;
  // 字节截断可能切开多字节字符；使用解码后的文本继续处理，避免返回无效编码。
  return `[earlier turns dropped from this excerpt]\n${bytes.subarray(bytes.length - limit).toString('utf8')}`;
}

export function createCompaction({ provider, session, directory, id, limits, logger, requestPrefix = () => ({ system: '', tools: [] }) }: {
  provider: ModelProvider;
  session: {
    read: () => Promise<SessionEvent[]>;
    modelView: () => Promise<unknown[]>;
    // 只有可写会话才记录 Token 用量；列表和检查等只读路径不写入事件。
    append?: (event: Record<string, unknown>) => Promise<unknown>;
  };
  directory: string;
  id: string;
  limits: { contextTokens: number; compactThresholdRatio: number; compactRetainRatio: number; outputTokens?: number; resultBytes: number };
  logger?: { log?: (message: string, fields?: Record<string, unknown>) => void };
  requestPrefix?: () => { system: string; tools: readonly ModelTool[] };
}) {
  if (!(limits.compactRetainRatio < limits.compactThresholdRatio)) {
    throw new Error('compaction_retain_must_be_below_threshold');
  }
  // 压力阈值和保留预算以同一个上下文窗口计算。
  // 请求的输出与输入共用窗口：模型或会话声明了输出预算时，预留其中一部分给输出，
  // 预留上限为窗口的四分之一，避免过大的输出声明把阈值压到保留预算之下。
  // 预留后阈值不高于保留预算时退回比例阈值，不因预留而停用压缩。
  const retained = Math.floor(limits.contextTokens * limits.compactRetainRatio);
  const reserved = limits.outputTokens === undefined ? 0
    : Math.min(limits.outputTokens, Math.floor(limits.contextTokens / 4));
  const reservedThreshold = limits.contextTokens - reserved;
  const threshold = reservedThreshold > retained
    ? Math.min(Math.floor(limits.contextTokens * limits.compactThresholdRatio), reservedThreshold)
    : Math.floor(limits.contextTokens * limits.compactThresholdRatio);
  // 软阈值：达到后先提醒模型自行压缩，硬阈值仍由自动压缩兜底。
  const soft = Math.floor(threshold * 0.9);
  // 提醒只在不重复打扰的前提下注入：同一压力进程内提醒一次，压力回落后重新允许。
  let nudged = false;
  // 本地估算与服务端用量的校准系数；尚无服务端用量时使用 1。
  let factor = 1;
  // 摘要连续失败最多尝试三次：压缩本身是恢复手段，不能变成每轮重新花一次 Provider 调用。
  // 这个上限只数失败：一次成功就把计数清零，长时间会话该连续产出多少块就产出多少块。
  // 一次网络抖动、超时或空回复也不会永久禁用压缩——下一轮压力到线时会再试一次。
  const SUMMARY_FAILURE_LIMIT = 3;
  // 摘要不可用标记：只在请求失败时记录（网络、超时、工具调用、空回复、输出超限、
  // 上下文超限都由 `summarise` 抛错走到同一条路）。达到失败上限才停止请求；
  // 单次失败只记原因，仍会重试。
  let summaryFailure: string | null = null;
  let summaryFailures = 0;

  // 复审（Reviewer）的用量与主 Agent 记在同一份记录里，压缩只认主 Agent 的对话账：
  // 拿复审或摘要请求的输入量当校准数据会把主 Agent 的窗口估算整体拉偏。
  // 旧记录没有 `purpose`/`source`，按普通主 Agent 对话解释。
  const isAgentUsage = (event: SessionEvent): boolean =>
    event.kind === 'usage' && (event.purpose === undefined || event.purpose === 'agent')
      && event.source !== 'summary';

  // 从最近一条有明确总输入量的 `usage` 事件恢复校准系数，让未知总量不覆盖先前的有效读数。
  // 事件同时保存本地估算和服务端用量，因此无需依赖上一个进程的内存状态。
  let seeded = false;
  async function lastUsage(): Promise<SessionEvent | null> {
    const events = await session.read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (isAgentUsage(events[index])) return events[index];
    }
    return null;
  }

  async function seedFromRecord(): Promise<void> {
    if (seeded) return;
    seeded = true;
    const events = await session.read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const usage = events[index];
      if (!isAgentUsage(usage) || usage.measurement !== 'request-v1') continue;
      const input = usage.input;
      const estimated = Number(usage.estimated);
      if (typeof input === 'number' && Number.isFinite(input) && input > 0 && Number.isFinite(estimated) && estimated > 0) {
        factor = input / estimated;
        return;
      }
    }
  }

  // 摘要请求同样是一次 Provider 调用，要按主 Agent 记账：否则压缩一次就少算一次请求。
  // 端点没报用量时仍写一条未知记录，次数算得清，数值保持 null。
  // 记账只要求“消息数组可展开”，因此这里按 usage 的口径重新包一层，不改原请求。
  async function recordSummaryUsage(request: { readonly system: string; readonly tools: readonly ModelTool[]; readonly messages: readonly { readonly role: string; readonly text: string }[] }, events: readonly ProviderEvent[]): Promise<void> {
    // 摘要请求记在主 Agent 账上（它确实是一次主 Agent 的调用），但标成 `source: 'summary'`：
    // 用量汇总照常计数，窗口校准不拿它当对话读数。
    const usage = usageEvent({ system: request.system, tools: request.tools, messages: [...request.messages] }, [...events], 'agent', { unknownWhenUnreported: true, source: 'summary' });
    if (usage === null || typeof session.append !== 'function') return;
    await session.append(usage);
  }

  async function summarise(events: SessionEvent[], previous: string | undefined, signal?: AbortSignal): Promise<string> {
    // 摘要请求本身也计入窗口预算，并使用校准后的估算，避免请求自身超出模型限制。
    const excerpt = `${previous === undefined ? '' : `Earlier summary:\n${previous}\n\n`}${fitExcerpt(flatten(events), Math.max(1, Math.floor((threshold - SUMMARY_PROMPT_RESERVE_TOKENS) / factor)))}`;
    const parts: string[] = [];
    const seen: ProviderEvent[] = [];
    let finish: ProviderEvent | undefined;
    const messages = [{ role: 'user' as const, text: `${INSTRUCTION}${excerpt}` }];
    const request = { system: '', tools: [] as ModelTool[], messages };
    // 记账放进 finally：请求抛错（网络、超时）时同样花了额度，次数要算得清。
    // 先记账再看结果，被截断或后续校验失败的请求也不会从账上消失。
    try {
      for await (const event of provider.stream(
        request,
        { signal },
      )) {
        seen.push(event);
        if (event.type === 'text') parts.push(event.text);
        if (event.type === 'finish') finish = event;
        if (event.type === 'tool-call') throw new KernelError('provider_tool_call_invalid', { detail: 'a compaction summary cannot call tools' });
      }
    } finally {
      await recordSummaryUsage(request, seen);
    }

    if (signal?.aborted) throw new KernelError('provider_cancelled');
    if (provider.requiresCompletion === true && finish === undefined) throw new KernelError('provider_stream_incomplete');
    if (finish?.type === 'finish' && (finish.reason === 'length' || finish.reason === 'max_tokens')) {
      throw new KernelError('provider_output_exhausted');
    }
    const text = parts.join('').trim();
    if (text === '') throw new KernelError('provider_empty_response');
    return text;
  }

  // 计算切点、请求摘要并追加压缩块。无法压缩时返回具体原因和 null 结果。
  // 每次压缩覆盖尚未进入任何块的区间；块文件整体原子替换，已有块保持不变。
  async function compact(reason: CompactionReason, signal?: AbortSignal): Promise<CompactResult | null> {
    await seedFromRecord();
    const events = await session.read();
    const { blocks } = await loadCheckpointFile({ directory, id, events });
    const last = blocks.at(-1);
    const fromSeq = last === undefined ? 0 : last.toSeq + 1;
    const tail = events.filter((event) => event.seq >= fromSeq);
    // 被排除在模型投影之外的事件不占用保留预算，也不计入压缩后的 Token 数。
    // 使用校准后的估算计算切点，确保压缩后按同一口径检查压力阈值。
    const cut = cutPoint(tail, retained, (event) => estimateTokens(projectModelView([event])) * factor);
    if (cut === null) return null;
    // 压缩块保存连续的事件序号范围；范围不依赖事件是否进入模型投影。
    const covered = tail.filter((event) => event.seq < cut);
    if (covered.length === 0) return null;
    const tokensBefore = estimateTokens(await session.modelView());
    // 摘要已经确认不可用（连续失败到达上限）时不再重发：同一份记录上每轮重试只会重复花钱，
    // 结论仍然是“压缩不可用”，由调用方按原上下文继续或失败。
    if (summaryFailure !== null && summaryFailures >= SUMMARY_FAILURE_LIMIT) {
      logger?.log?.('compaction summary is unavailable, not retrying', { sessionId: id, code: summaryFailure });
      return null;
    }
    let text: string;
    try {
      // 新块请求携带上一块的摘要，摘要链因此覆盖更早的全部历史。
      text = await summarise(covered, last?.text, signal);
    } catch (error) {
      const code = (error as { code?: string }).code;
      logger?.log?.('compaction summary call failed', { sessionId: id, code });
      // Run 取消不是摘要坏了：这次调用本身不该继续，不记失败、不锁死后续压缩。
      if (signal?.aborted) throw new KernelError('loop_cancelled', { cause: error });
      // 请求抛错属于“摘要不可用”：`summarise` 把空回复与超长输出也变成错误抛出，
      // 因此这里统一记下原因，连续失败到上限才停。
      summaryFailure = code ?? 'summary_failed';
      summaryFailures += 1;
      throw error;
    }
    const written = await writeBlock({ blocks, covered, text, reason, tokensBefore });
    if (written === null) {
      // 摘要写出来却不比原文小：这一轮同样没有收益，也算一次失败，连续三次就停止花钱。
      summaryFailure = 'summary_not_smaller';
      summaryFailures += 1;
      return null;
    }
    // 真正写出块才清零：失败上限只约束连续重试，不约束同一会话产出的摘要块数量。
    summaryFailure = null;
    summaryFailures = 0;
    return written;
  }

  // 校验块级不变量后写入块文件与压缩事件。压缩结果必须小于原投影，否则块只增加
  // 文件和验证成本，却让原有历史无法再进入模型上下文；此时不写并返回 null。
  async function writeBlock({ blocks, covered, text, reason, tokensBefore }: {
    blocks: CompactionBlock[];
    covered: SessionEvent[];
    text: string;
    reason: CompactionReason;
    tokensBefore: number;
  }): Promise<CompactResult | null> {
    const fromSeq = Number(covered[0].seq);
    const toSeq = Number(covered[covered.length - 1].seq);
    // 摘要受工具结果字节上限约束；超限时保存到溢出文件，并在块中记录读取引用。
    // 文件名带内容哈希：同一目录存放工作区的全部会话，仅有序号范围的名称会跨会话互相覆盖。
    const kept = await spillContent(text, {
      limit: limits.resultBytes,
      directory,
      name: `summary-${fromSeq}-${toSeq + 1}-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)}.txt`,
    });
    const block = createBlock({ events: covered, text: kept, fromSeq, toSeq, blockId: (blocks.at(-1)?.blockId ?? 0) + 1 });
    // 与真实请求使用同一投影，忽略 responseId 等非模型元数据。
    const tokensAfter = estimateTokens(projectModelView(await session.read(), [...blocks, block]));
    if (tokensAfter >= tokensBefore) {
      logger?.log?.('compaction would not shrink the projection, skipping', {
        sessionId: id, tokensBefore, tokensAfter, covered: covered.length,
      });
      return null;
    }
    await writeCheckpointFile(directory, id, createCheckpointFile({ id, blocks: [...blocks, block] }));
    // 压缩事实写入记录：界面与导出据此说明第几块覆盖哪段、为什么压。
    if (typeof session.append === 'function') {
      await session.append({
        kind: 'compaction', ignorable: true, reason, blockId: block.blockId, fromSeq, toSeq, tokensBefore, tokensAfter,
      });
    }
    // 保存本地估算和校准系数，使读取记录的一方可以还原触发压缩时的计算依据。
    logger?.log?.('session compacted', {
      sessionId: id,
      reason,
      blockId: block.blockId,
      fromSeq,
      toSeq,
      tokensBefore,
      tokensAfter,
      factor: Math.round(factor * 100) / 100,
    });
    return { blockId: block.blockId, fromSeq, toSeq, tokensBefore, tokensAfter };
  }

  // 模型主动压缩：模型自己选择范围并撰写摘要，不再发起独立的摘要请求。
  // 范围只能覆盖当前轮次之前的完整历史，且不得悬空任何调用/结果对。
  async function compactRange({ fromSeq, toSeq, summary }: {
    fromSeq?: number;
    toSeq?: number;
    summary: string;
  }): Promise<CompactResult | null> {
    if (typeof summary !== 'string' || summary.trim() === '') {
      throw new KernelError('compact_summary_required', { detail: 'compress takes the summary text you wrote for the covered range' });
    }
    const events = await session.read();
    const { blocks } = await loadCheckpointFile({ directory, id, events });
    const last = blocks.at(-1);
    const start = fromSeq ?? (last === undefined ? 0 : last.toSeq + 1);
    const limit = compressibleToSeq(events);
    const end = toSeq ?? compressibleRange(events, blocks)?.toSeq;
    if (end === undefined) {
      throw new KernelError('compact_range_unavailable', { detail: 'no completed history outside the current turn can be summarized yet' });
    }
    if (end > limit) {
      throw new KernelError('compact_range_invalid', {
        detail: `the current turn starts inside the range; compress up to event ${limit} at most`,
      });
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) {
      throw new KernelError('compact_range_invalid', { detail: 'fromSeq and toSeq must be event sequence numbers with fromSeq <= toSeq' });
    }
    if (start <= (last?.toSeq ?? -1)) {
      throw new KernelError('compact_range_invalid', {
        detail: `events up to ${last?.toSeq} are already covered by block ${last?.blockId}; start after that`,
      });
    }
    const covered = events.filter((event) => Number(event.seq) >= start && Number(event.seq) <= end);
    if (covered.length !== end - start + 1) {
      throw new KernelError('compact_range_invalid', { detail: `events ${start}..${end} are not all present in the record` });
    }
    const boundary = covered[covered.length - 1];
    if (boundary.kind !== 'user' && boundary.kind !== 'assistant') {
      throw new KernelError('compact_range_invalid', {
        detail: `the range must end at a user or assistant message; event ${end} is ${String(boundary.kind)}`,
      });
    }
    if (pairingBreaks(events, start, end)) {
      throw new KernelError('compact_range_invalid', {
        detail: 'the range would separate an assistant tool call from its result; end it at a message boundary that keeps each pair together',
      });
    }
    const tokensBefore = estimateTokens(await session.modelView());
    return await writeBlock({ blocks, covered, text: summary, reason: 'model', tokensBefore });
  }

  // 识别服务端明确报告的上下文超限错误，通常是 HTTP 400 响应。
  function isOverflow(error: unknown): boolean {
    const value = error as { code?: string; detail?: string };
    if (value?.code !== 'provider_http_error' || typeof value.detail !== 'string') return false;
    return /context|token|too long|too many|maximum|length/i.test(value.detail);
  }

  // 软阈值提醒以请求尾部的临时用户消息注入：不写入记录，不改动 system 前缀，
  // 因此不破坏持久历史，也不让缓存前缀失效。无可压缩范围时不提醒。
  async function reminder(estimated: number): Promise<string | null> {
    const events = await session.read();
    const { blocks } = await loadCheckpointFile({ directory, id, events });
    const range = compressibleRange(events, blocks);
    if (range === null) return null;
    return 'Context usage reminder: the request is estimated at '
      + `${Math.round(estimated)} of ${limits.contextTokens} context tokens and approaches the compaction threshold of ${threshold}. `
      + `Completed history from event ${range.fromSeq} to ${range.toSeq} can be summarized. `
      + 'When those turns are no longer needed word for word, call the compact tool with action "compress" '
      + '(fromSeq and toSeq default to this range) and write the summary yourself, keeping every path, command, identifier, '
      + 'decision, exact value and open question. If the context is still in use, continue normally and ignore this reminder.';
  }

  return {
    tokens: () => ({ threshold, soft, retained, reserved, factor }),

    // 为状态和命令行提供上下文窗口、压力阈值、当前估算和最近一次服务端用量。
    async context(): Promise<{
      window: number;
      threshold: number;
      soft: number;
      retained: number;
      reserved: number;
      estimated: number;
      factor: number;
      // 返回本地估算使用的算法标识，供界面显示。
      measurement: string;
      reported: { seq: number; input: number | null; output: number | null; cache?: ProviderCacheUsage } | null;
    }> {
      await seedFromRecord();
      const usage = await lastUsage();
      const input = usage !== null && typeof usage.input === 'number' && Number.isFinite(usage.input) ? usage.input : null;
      const output = usage !== null && typeof usage.output === 'number' && Number.isFinite(usage.output) ? usage.output : null;
      const view = await session.modelView();
      return {
        window: limits.contextTokens,
        threshold,
        soft,
        retained,
        reserved,
        estimated: Math.round(estimateRequest({ ...requestPrefix(), messages: view }) * factor),
        factor: Math.round(factor * 100) / 100,
        measurement: 'request-v1',
        // 端点没报数值时这条记录只用来计次：报回的那一格仍是 null，不能变成 0。
        reported: usage === null || (input === null && output === null) ? null : {
          seq: Number(usage.seq), input, output,
          ...(usage.cache !== undefined ? { cache: usage.cache as ProviderCacheUsage } : {}),
        },
      };
    },

    // 模型主动压缩入口：范围与摘要都由模型提供，校验失败抛出带指引的错误。
    compactRange,

    // 手动压缩只能在没有活动轮次时执行；无法缩短时返回明确结果。
    compactNow: (signal?: AbortSignal) => compact('manual', signal),

    // 在构造请求后检查上下文压力；超出阈值时先压缩，再使用新投影发送请求。
    // 软阈值区间内先提醒模型自行压缩；提醒是临时的，不进入持久历史。
    async prepare(request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[]> {
      await seedFromRecord();
      const estimated = estimateRequest(request) * factor;
      if (estimated > threshold) {
        const done = await compact('auto', signal);
        if (done === null) return request.messages;
        return await session.modelView();
      }
      if (estimated >= soft && !nudged) {
        const text = await reminder(estimated);
        if (text !== null) {
          nudged = true;
          return [...request.messages, { role: 'user', text }];
        }
      }
      if (estimated < soft) nudged = false;
      return request.messages;
    },

    // Loop 按轮次限制超长恢复次数；此处只处理超长错误并返回重新构造的投影。
    async recover(error: unknown, request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[] | null> {
      if (!isOverflow(error)) return null;
      logger?.log?.('context reported overflow, compacting once', {
        sessionId: id,
        detail: (error as { detail?: string }).detail?.slice(0, 200),
        estimated: Math.round(estimateRequest(request) * factor),
      });
      const done = await compact('overflow', signal);
      if (done === null) {
        // 压缩不能用时给出明确原因：没有可压范围、摘要不可用、或尝试次数已用尽。
        logger?.log?.('the one allowed compaction did not happen, the round is abandoned', {
          sessionId: id,
          reason: summaryFailure ?? 'no_compressible_range',
        });
        return null;
      }
      return await session.modelView();
    },

    // 服务端报告用量后校准本地估算并写入会话记录，避免持续低估导致压力触发失效。
    // 服务端和本地估算都包含系统提示、工具定义与消息，因此固定前缀不会被误判为历史增长。
    async observe(request: LoopCompactionRequest, events: ProviderEvent[]): Promise<void> {
      // 端点没报用量时写一条未知记录：既保留了请求次数，也不会拿它校准估算。
      const usage = usageEvent(request, events, 'agent', { unknownWhenUnreported: true });
      if (usage === null) return;
      // 使用当前响应中的最新用量，无需再从历史记录查找。
      // 缺少总输入量时仍保存缓存分项，但不改变本地估算校准系数。
      if (usage.input !== null && usage.input > 0) {
        seeded = true;
        factor = usage.input / usage.estimated;
      }
      if (typeof session.append !== 'function') return;
      // 同时保存本地估算，以便从记录恢复校准系数；用量事件不参与检查点哈希。
      await session.append(usage);
    },
  };
}
