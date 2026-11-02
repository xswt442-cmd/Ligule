// OpenAI Chat Completions 接口使用 `POST <base>/chat/completions` 和 Bearer 鉴权。
// HTTP 地址、重试、SSE 解析和凭据处理由 `model/http.ts` 共用。
// 此适配器负责请求体结构、流式工具参数组装，以及独立 `role:"tool"` 结果消息。
import { createHash } from 'node:crypto';
import { KernelError } from '../kernel/error.js';
import { outputTokenCeiling, resolveOutputTokens } from './output-budget.js';
import { checkedThinkingEffort, thinkingCapabilityOf, type DeepSeekThinkingEffort } from './thinking.js';
import {
  apiRoot, assertAllAnswered, DEFAULT_RETRY, open, parseSse, readCredential, readJson, resolveCapabilities, resultText, SSE_DONE,
  type ProviderCapabilities, type RetryPolicy,
} from './http.js';
import type { ModelMessage, ModelRequest, ProviderEvent } from '../kernel/loop.js';
import { imageInputOf, resolveRequestImages } from './images.js';
import type { ImageReference } from '../media.js';

interface ChatCompletionsCapabilities extends ProviderCapabilities {
  readonly streaming: boolean;
  readonly parallelToolCalls: boolean;
  readonly maxOutputTokens: number;
  readonly streamUsage: boolean;
}

interface ChatCompletionsProviderOptions {
  readonly imageInput?: boolean;
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly apiKeyEnv?: string;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly outputTokens?: unknown;
  readonly declaredOutputLimit?: unknown;
  readonly contextTokens?: unknown;
  readonly thinkingEffort?: unknown;
  readonly retry?: RetryPolicy;
}

interface ModelProvider {
  readonly imageInput: boolean;
  readonly requiresCompletion: true;
  readonly name: string;
  readonly model: string;
  readonly capabilities: ChatCompletionsCapabilities;
  readonly outputTokens: number;
  readonly thinkingEffort?: DeepSeekThinkingEffort;
  stream(request: ModelRequest, options?: { readonly signal?: AbortSignal | null }): AsyncGenerator<ProviderEvent>;
  withModel(model: string): ModelProvider;
}

type JsonRecord = Record<string, unknown>;
interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

type ChatToolMessage = { readonly role: 'tool'; readonly tool_call_id: string | undefined; readonly content: string | undefined };
type ChatImageBlock = { readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };
type ChatWireMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string | readonly ChatImageBlock[] }
  | { readonly role: 'assistant'; readonly content: string | null; readonly reasoning_content?: string; readonly tool_calls?: readonly ChatToolCall[] }
  | ChatToolMessage;

interface StreamToolCall {
  id?: string;
  name: string;
  json: string;
}

const WIRE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const WIRE_TOOL_ALIAS_PREFIX = 'ligule_';

interface ToolNameMapping {
  encode(name: string): string;
  decode(name: string): string;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, detail: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new KernelError('provider_stream_invalid', { detail });
  }
  return value;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function chatUsageEvent(usage: JsonRecord): ProviderEvent | undefined {
  // prompt_tokens is the reported total; cache field paths identify the format without guessing the endpoint vendor.
  const input = tokenCount(usage.prompt_tokens);
  const output = tokenCount(usage.completion_tokens);
  const details = isJsonRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const hitPresent = Object.hasOwn(usage, 'prompt_cache_hit_tokens');
  const cachedAliasPresent = details !== undefined && Object.hasOwn(details, 'cached_tokens');
  const missPresent = Object.hasOwn(usage, 'prompt_cache_miss_tokens');
  const cachePresent = hitPresent || cachedAliasPresent || missPresent;
  if (!cachePresent && input === null && output === null) return undefined;

  const primaryHit = tokenCount(usage.prompt_cache_hit_tokens);
  const aliasHit = tokenCount(details?.cached_tokens);
  const hit = primaryHit ?? aliasHit;
  const miss = tokenCount(usage.prompt_cache_miss_tokens);
  const aliasConflict = hitPresent && cachedAliasPresent && primaryHit !== null && aliasHit !== null && primaryHit !== aliasHit;
  const consistent = aliasConflict || (input !== null && ((hit !== null && hit > input) || (miss !== null && miss > input)))
    || (input !== null && hit !== null && miss !== null && input !== hit + miss)
    ? false
    : input !== null && hit !== null && miss !== null ? true : null;
  const sourceFields = [
    ...(Object.hasOwn(usage, 'prompt_tokens') ? [{ field: 'prompt_tokens', tokens: input }] : []),
    ...(hitPresent ? [{ field: 'prompt_cache_hit_tokens', tokens: primaryHit }] : []),
    ...(missPresent ? [{ field: 'prompt_cache_miss_tokens', tokens: miss }] : []),
    ...(cachedAliasPresent ? [{ field: 'prompt_tokens_details.cached_tokens', tokens: aliasHit }] : []),
  ];
  return {
    type: 'usage', input, output,
    ...(cachePresent ? { cache: {
      source: 'chat-completions' as const,
      sourceFields,
      hitInputTokens: hit,
      missInputTokens: miss,
      creationInputTokens: null,
      uncachedInputTokens: null,
      providerInputIncludesCache: true,
      consistent,
    } } : {}),
  };
}

function booleanCapability(value: boolean | number, name: string): boolean {
  if (typeof value !== 'boolean') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a boolean` });
  return value;
}

function numberCapability(value: boolean | number, name: string): number {
  if (typeof value !== 'number') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a number` });
  return value;
}

export const CHAT_COMPLETIONS_CAPABILITIES: ChatCompletionsCapabilities = Object.freeze({
  streaming: true,
  parallelToolCalls: true,
  maxOutputTokens: 8192,
  // 按提供方能力决定是否请求流式 Token 用量；不支持该字段的端点会关闭此选项。
  streamUsage: true,
});

export function chatCompletionsCapabilities(requested: Readonly<Record<string, unknown>> = {}): ChatCompletionsCapabilities {
  const resolved = resolveCapabilities(CHAT_COMPLETIONS_CAPABILITIES, requested);
  return Object.freeze({
    streaming: booleanCapability(resolved.streaming, 'streaming'),
    parallelToolCalls: booleanCapability(resolved.parallelToolCalls, 'parallelToolCalls'),
    maxOutputTokens: numberCapability(resolved.maxOutputTokens, 'maxOutputTokens'),
    streamUsage: booleanCapability(resolved.streamUsage, 'streamUsage'),
  });
}

function toolNameMapping(request: ModelRequest): ToolNameMapping {
  const names = new Set<string>();
  for (const tool of request.tools ?? []) names.add(tool.name);
  for (const message of request.messages ?? []) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) names.add(call.name);
    }
  }

  const encoded = new Set([...names].filter((name) => !WIRE_TOOL_NAME.test(name)));
  const aliasOf = (name: string) => `${WIRE_TOOL_ALIAS_PREFIX}${createHash('sha256').update(name).digest('hex').slice(0, 48)}`;
  // 无效工具名的别名可能与另一个有效名称冲突；持续编码冲突名称，直到别名不再重叠。
  while (true) {
    const aliases = new Map<string, string>();
    for (const name of encoded) {
      const alias = aliasOf(name);
      const previous = aliases.get(alias);
      if (previous !== undefined && previous !== name) {
        throw new KernelError('provider_tool_name_collision', { detail: `${previous} and ${name} share a wire alias` });
      }
      aliases.set(alias, name);
    }
    const collisions = [...names].filter((name) => !encoded.has(name) && aliases.has(name));
    if (collisions.length === 0) break;
    for (const name of collisions) encoded.add(name);
  }

  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const name of names) {
    const wireName = encoded.has(name) ? aliasOf(name) : name;
    const previous = fromWire.get(wireName);
    if (previous !== undefined && previous !== name) {
      throw new KernelError('provider_tool_name_collision', { detail: `${previous} and ${name} share wire name ${wireName}` });
    }
    toWire.set(name, wireName);
    fromWire.set(wireName, name);
  }
  return {
    encode: (name) => toWire.get(name) ?? name,
    // 保留未知工具名称，由 Host Kernel 按原名称拒绝调用。
    decode: (name) => fromWire.get(name) ?? name,
  };
}

function toWireMessages(view: readonly ModelMessage[], system: string, toolNames: ToolNameMapping, preserveReasoning: boolean, images: ReadonlyMap<ImageReference, string>): ChatWireMessage[] {
  // Chat Completions 将系统提示作为消息列表首项发送。
  const messages: ChatWireMessage[] = system === '' ? [] : [{ role: 'system', content: system }];
  assertAllAnswered(view);
  let pending: ChatImageBlock[] = [];
  const flushImages = () => {
    if (pending.length === 0) return;
    messages.push({ role: 'user', content: pending });
    pending = [];
  };
  for (const entry of view) {
    if (entry.role !== 'tool') flushImages();
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
    } else if (entry.role === 'assistant') {
      const calls = entry.toolCalls ?? [];
      messages.push({
        role: 'assistant',
        // 只有工具调用且没有正文时使用 null，避免兼容服务将空字符串视为续写内容。
        content: entry.text === '' && calls.length > 0 ? null : entry.text,
        ...(preserveReasoning && entry.reasoning !== undefined ? { reasoning_content: entry.reasoning } : {}),
        ...(calls.length === 0 ? {} : {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: toolNames.encode(call.name), arguments: JSON.stringify(call.args ?? {}) },
          })),
        }),
      });
    } else {
      // 每个工具调用单独发送一条结果消息，并使用调用 ID 关联。
      messages.push({ role: 'tool', tool_call_id: entry.id, content: resultText(entry.content) });
      for (const reference of entry.images ?? []) {
        const image = images.get(reference);
        if (image === undefined) throw new KernelError('image_reference_invalid');
        pending.push({ type: 'text', text: `Image from tool call ${entry.id ?? ''}: ${reference.id}` },
          { type: 'image_url', image_url: { url: `data:${reference.mimeType};base64,${image}` } });
      }
    }
  }
  flushImages();
  return messages;
}

export function createChatCompletionsProvider({
  baseUrl,
  model,
  apiKeyEnv = 'LIGULE_API_KEY',
  capabilities,
  outputTokens,
  declaredOutputLimit,
  contextTokens,
  thinkingEffort: requestedThinkingEffort,
  imageInput: declaredImageInput,
  retry = DEFAULT_RETRY,
}: ChatCompletionsProviderOptions = {}): ModelProvider {
  // 直接使用配置中的 baseURL；不同兼容服务对 `/v1` 前缀的要求不同，不在此处补写路径。
  const root = apiRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = chatCompletionsCapabilities(capabilities);
  const imageInput = imageInputOf(root, model, declaredImageInput);
  const thinkingCapability = thinkingCapabilityOf('chat-completions', root, model);
  const thinkingEffort = requestedThinkingEffort === undefined
    ? undefined
    : checkedThinkingEffort(requestedThinkingEffort, thinkingCapability);
  const budgetLimits = {
    defaultTokens: effective.maxOutputTokens,
    configuredLimit: capabilities?.maxOutputTokens === undefined ? undefined : effective.maxOutputTokens,
    ...(declaredOutputLimit === undefined ? {} : { declaredOutputLimit }),
  };
  const maxOutputTokens = outputTokenCeiling({ baseUrl: root, model, ...budgetLimits });
  const budget = resolveOutputTokens({ baseUrl: root, model, requested: outputTokens, ...budgetLimits, contextLimit: contextTokens });

  async function* stream(request: ModelRequest, { signal }: { readonly signal?: AbortSignal | null } = {}): AsyncGenerator<ProviderEvent> {
    const toolNames = toolNameMapping(request);
    assertAllAnswered(request.messages ?? []);
    const images = await resolveRequestImages(request, imageInput, signal);
    const body = {
      model,
      messages: toWireMessages(request.messages ?? [], request.system ?? '', toolNames,
        thinkingCapability !== undefined && thinkingEffort !== 'none', images),
      stream: effective.streaming,
      // 根据提供方能力决定是否请求最终用量；不支持时由压缩逻辑继续使用本地估算。
      ...(effective.streaming && effective.streamUsage ? { stream_options: { include_usage: true } } : {}),
      max_tokens: budget,
      parallel_tool_calls: effective.parallelToolCalls,
      ...(thinkingEffort === undefined ? {} : {
        thinking: { type: thinkingEffort === 'none' ? 'disabled' : 'enabled' },
        reasoning_effort: thinkingEffort,
      }),
      ...(request.tools?.length === 0 || request.tools === undefined ? {} : {
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: { name: toolNames.encode(tool.name), description: tool.description, parameters: tool.parameters },
        })),
      }),
    };
    const response = await open(`${root}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': effective.streaming ? 'text/event-stream' : 'application/json',
        'authorization': `Bearer ${await readCredential(apiKeyEnv)}`,
      },
      body: JSON.stringify(body),
    }, retry);
    if (response.body === null) throw new KernelError('provider_stream_missing');

    if (!effective.streaming) {
      const completion = asRecord(await readJson(response, signal), 'a completion response is not an object');
      if (!Array.isArray(completion.choices) || completion.choices.length !== 1) {
        throw new KernelError('provider_stream_incomplete');
      }
      const choice = asRecord(completion.choices[0], 'a completion choice is not an object');
      const message = asRecord(choice.message, 'a completion message is not an object');
      if (message.role !== undefined && message.role !== 'assistant') throw new KernelError('provider_stream_invalid', { detail: 'completion message is not an assistant message' });
      if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
        throw new KernelError('provider_stream_invalid', { detail: 'completion content is not text' });
      }
      const text = typeof message.content === 'string' ? message.content : '';
      const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
      if (text !== '') yield { type: 'text', text };
      if (reasoning !== '') yield { type: 'reasoning', text: reasoning };
      const finishReason = choice.finish_reason;
      const reason = finishReason === 'stop'
        ? 'stop'
        : finishReason === 'tool_calls'
          ? 'tool_calls'
          : finishReason === 'length'
            ? 'length'
            : undefined;
      if (reason === undefined) {
        if (typeof finishReason !== 'string') throw new KernelError('provider_stream_incomplete');
        throw new KernelError('provider_finish_reason_invalid');
      }
      if (reason !== 'length') {
        const calls = message.tool_calls === undefined || message.tool_calls === null
          ? []
          : Array.isArray(message.tool_calls)
            ? message.tool_calls
            : (() => { throw new KernelError('provider_stream_invalid', { detail: 'completion tool_calls is not an array' }); })();
        const callIds = new Set<string>();
        const parsed = calls.map((rawCall) => {
          const call = asRecord(rawCall, 'a completion tool call is not an object');
          const id = typeof call.id === 'string' ? call.id : '';
          if (id === '' || callIds.has(id)) throw new KernelError('provider_tool_call_invalid');
          callIds.add(id);
          const functionValue = asRecord(call.function, 'a completion tool function is not an object');
          const name = typeof functionValue.name === 'string' ? functionValue.name : '';
          if (name === '') throw new KernelError('provider_tool_call_invalid');
          const args = functionValue.arguments === undefined ? '' : functionValue.arguments;
          if (typeof args !== 'string') throw new KernelError('provider_tool_args_invalid', { detail: 'tool arguments are not valid JSON' });
          return { type: 'tool-call' as const, id, name: toolNames.decode(name), args: parseArgs(args) };
        });
        for (const call of parsed) yield call;
      }
      const usage = completion.usage === undefined || completion.usage === null
        ? undefined
        : asRecord(completion.usage, 'completion usage is not an object');
      if (usage !== undefined) {
        const event = chatUsageEvent(usage);
        if (event !== undefined) yield event;
      }
      yield { type: 'finish', reason };
      return;
    }

    // 工具参数按索引分片传输，没有单独的参数结束事件，因此收集完整流后再返回调用。
    const calls = new Map<number, StreamToolCall>();
    let usage: JsonRecord | undefined;
    let finishReason: unknown;
    let done = false;
    for await (const rawChunk of parseSse(response.body, { includeDone: true, signal })) {
      if (rawChunk === SSE_DONE) {
        if (done) throw new KernelError('provider_stream_invalid', { detail: 'duplicate stream terminator' });
        done = true;
        continue;
      }
      if (done) throw new KernelError('provider_stream_invalid', { detail: 'data follows the stream terminator' });
      const chunk = asRecord(rawChunk, 'a stream chunk is not an object');
      // 普通流式分片的 usage 可能为 null；只保留实际用量对象。
      if (chunk.usage !== undefined && chunk.usage !== null) usage = asRecord(chunk.usage, 'a stream usage value is not an object');
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const rawChoice of choices) {
        const choice = asRecord(rawChoice, 'a stream choice is not an object');
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
        const delta = asRecord(choice.delta ?? {}, 'a stream delta is not an object');
        if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', text: delta.content };
        // 推理内容作为独立增量字段处理；部分服务使用 `reasoning_content` 字段名。
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          yield { type: 'reasoning', text: delta.reasoning_content };
        }
        const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawFragment of fragments) {
          const fragment = asRecord(rawFragment, 'a tool call fragment is not an object');
          const index = Number.isInteger(fragment.index) ? Number(fragment.index) : calls.size;
          const call = calls.get(index) ?? { name: '', json: '' };
          if (typeof fragment.id === 'string') call.id = fragment.id;
          const functionValue = typeof fragment.function === 'object' && fragment.function !== null
            ? asRecord(fragment.function, 'a tool call function is not an object')
            : {};
          if (typeof functionValue.name === 'string') call.name += functionValue.name;
          if (typeof functionValue.arguments === 'string') call.json += functionValue.arguments;
          calls.set(index, call);
        }
      }
    }
    if (!done || typeof finishReason !== 'string') throw new KernelError('provider_stream_incomplete');
    const reason = finishReason === 'stop'
      ? 'stop'
      : finishReason === 'tool_calls'
        ? 'tool_calls'
        : finishReason === 'length'
          ? 'length'
          : undefined;
    if (reason === undefined) throw new KernelError('provider_finish_reason_invalid');
    if (reason !== 'length') {
      const callIds = new Set<string>();
      const parsed = [...calls.entries()].sort((left, right) => left[0] - right[0]).map(([, call]) => {
        if (call.id === undefined || call.id === '' || call.name === '' || callIds.has(call.id)) {
          throw new KernelError('provider_tool_call_invalid');
        }
        callIds.add(call.id);
        return { type: 'tool-call' as const, id: call.id, name: toolNames.decode(call.name), args: parseArgs(call.json) };
      });
      for (const call of parsed) yield call;
    }
    // 最终用量通常位于没有 choices 的结束分片中；缺少时不生成用量事件，压缩逻辑使用本地估算。
    if (usage !== undefined) {
      const event = chatUsageEvent(usage);
      if (event !== undefined) yield event;
    }
    yield { type: 'finish', reason };
  }

  const provider = {
    imageInput,
    name: 'chat-completions',
    requiresCompletion: true as const,
    model,
    capabilities: effective,
    maxOutputTokens,
    outputTokens: budget,
    ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
    stream,
    // 模型切换必须由调用方明确请求；失败时不自动切换到其他模型。
    withModel(next: string) {
      return createChatCompletionsProvider({ baseUrl, model: next, apiKeyEnv, capabilities, outputTokens,
        ...(next === model ? { declaredOutputLimit, contextTokens, imageInput: declaredImageInput } : {}),
        ...(requestedThinkingEffort === undefined ? {} : { thinkingEffort: requestedThinkingEffort }), retry });
    },
  };
  return Object.freeze(provider);
}

// 参数无法解析时立即报错。空参数片段表示无参数调用，不等同于参数缺失。
function parseArgs(json: string): unknown {
  if (json === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch (error) {
    throw new KernelError('provider_tool_args_invalid', { detail: 'tool arguments are not valid JSON' });
  }
}
