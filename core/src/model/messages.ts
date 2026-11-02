// Anthropic Messages 接口使用 `POST <base>/v1/messages` 和 `x-api-key` 鉴权。
// HTTP 地址、重试、SSE 解析和凭据处理由 `model/http.ts` 共用；此适配器负责请求和事件格式。
import { KernelError } from '../kernel/error.js';
import { outputTokenCeiling, resolveOutputTokens } from './output-budget.js';
import {
  apiRoot, assertAllAnswered, DEFAULT_RETRY, open, parseSse, readCredential, readJson, resolveCapabilities, resultText,
  type ProviderCapabilities, type RetryPolicy,
} from './http.js';
import type { ModelMessage, ModelRequest, ProviderEvent } from '../kernel/loop.js';
import { imageInputOf, resolveRequestImages } from './images.js';
import type { ImageReference } from '../media.js';

interface MessagesCapabilities extends ProviderCapabilities {
  readonly streaming: boolean;
  readonly parallelToolCalls: boolean;
  readonly maxOutputTokens: number;
}

interface MessagesProviderOptions {
  readonly imageInput?: boolean;
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly apiKeyEnv?: string;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly outputTokens?: unknown;
  readonly declaredOutputLimit?: unknown;
  readonly contextTokens?: unknown;
  readonly retry?: RetryPolicy;
}

interface ModelProvider {
  readonly imageInput: boolean;
  readonly requiresCompletion: true;
  readonly name: string;
  readonly model: string;
  readonly capabilities: MessagesCapabilities;
  readonly outputTokens: number;
  stream(request: ModelRequest, options?: { readonly signal?: AbortSignal | null }): AsyncGenerator<ProviderEvent>;
  withModel(model: string): ModelProvider;
}

type ImageContentBlock = { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: 'image/png'; readonly data: string } };
type MessagesBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string | undefined; readonly content: string | readonly ImageContentBlock[] | undefined; readonly is_error: boolean };

type MessagesWireMessage =
  | { readonly role: 'user'; content: string | MessagesBlock[] }
  | { readonly role: 'assistant'; content: MessagesBlock[] };

type MessageBlockState =
  | { readonly kind: 'text' }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly input: unknown; json: string }
  | { readonly kind: 'reasoning'; signature?: string };

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, detail: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new KernelError('provider_stream_invalid', { detail });
  }
  return value;
}

function requiredString(value: unknown, detail: string): string {
  if (typeof value !== 'string' || value === '') throw new KernelError('provider_tool_call_invalid', { detail });
  return value;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function messagesUsageEvent(usage: JsonRecord): ProviderEvent | undefined {
  // Anthropic input_tokens excludes cache reads/writes; require all reported components before publishing a total.
  const uncached = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const readPresent = Object.hasOwn(usage, 'cache_read_input_tokens');
  const creationPresent = Object.hasOwn(usage, 'cache_creation_input_tokens');
  const uncachedPresent = Object.hasOwn(usage, 'input_tokens');
  const read = tokenCount(usage.cache_read_input_tokens);
  const creation = tokenCount(usage.cache_creation_input_tokens);
  const total = uncached !== null && readPresent && creationPresent && read !== null && creation !== null
    ? uncached + read + creation
    : null;
  const input = total !== null && Number.isSafeInteger(total) ? total : null;
  const cachePresent = uncachedPresent || readPresent || creationPresent;
  if (!cachePresent && output === null) return undefined;
  const sourceFields = [
    ...(uncachedPresent ? [{ field: 'input_tokens', tokens: uncached }] : []),
    ...(readPresent ? [{ field: 'cache_read_input_tokens', tokens: read }] : []),
    ...(creationPresent ? [{ field: 'cache_creation_input_tokens', tokens: creation }] : []),
  ];
  return {
    type: 'usage', input, output,
    ...(cachePresent ? { cache: {
      source: 'anthropic-messages' as const,
      sourceFields,
      hitInputTokens: read,
      missInputTokens: null,
      creationInputTokens: creation,
      uncachedInputTokens: uncached,
      providerInputIncludesCache: false,
      consistent: null,
    } } : {}),
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberCapability(value: boolean | number, name: string): number {
  if (typeof value !== 'number') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a number` });
  return value;
}

function booleanCapability(value: boolean | number, name: string): boolean {
  if (typeof value !== 'boolean') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a boolean` });
  return value;
}

// 提供方声明的能力上限；配置不能超过这些值。
export const MESSAGES_CAPABILITIES: MessagesCapabilities = Object.freeze({
  streaming: true,
  parallelToolCalls: false,
  maxOutputTokens: 8192,
});

const ANTHROPIC_VERSION = '2023-06-01';

export function capabilitiesOf(requested: Readonly<Record<string, unknown>> = {}): MessagesCapabilities {
  const resolved = resolveCapabilities(MESSAGES_CAPABILITIES, requested);
  return Object.freeze({
    streaming: booleanCapability(resolved.streaming, 'streaming'),
    parallelToolCalls: booleanCapability(resolved.parallelToolCalls, 'parallelToolCalls'),
    maxOutputTokens: numberCapability(resolved.maxOutputTokens, 'maxOutputTokens'),
  });
}

// Messages 端点位于 `/v1` 下；baseURL 已包含该路径时不重复追加。
function messagesRoot(baseUrl: unknown): string {
  const root = apiRoot(baseUrl);
  return root.endsWith('/v1') ? root : `${root}/v1`;
}

// 将会话投影转换为 Messages 请求；连续工具结果合并到一条 user 消息中，紧跟对应的 assistant 工具调用。
function toWireMessages(view: readonly ModelMessage[], images: ReadonlyMap<ImageReference, string>): MessagesWireMessage[] {
  const messages: MessagesWireMessage[] = [];
  assertAllAnswered(view);
  for (const entry of view) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
      continue;
    }
    if (entry.role === 'assistant') {
      const content: MessagesBlock[] = [];
      if (entry.text !== '') content.push({ type: 'text', text: entry.text });
      for (const call of entry.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    const text = resultText(entry.content);
    const content: ImageContentBlock[] = text ? [{ type: 'text', text }] : [];
    for (const reference of entry.images ?? []) {
      const image = images.get(reference);
      if (image === undefined) throw new KernelError('image_reference_invalid');
      content.push({ type: 'image', source: { type: 'base64', media_type: reference.mimeType, data: image } });
    }
    const result: MessagesBlock = {
      type: 'tool_result',
      tool_use_id: entry.id,
      content: entry.images === undefined ? text : content,
      is_error: entry.failed === true,
    };
    const last = messages[messages.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(result);
    else messages.push({ role: 'user', content: [result] });
  }
  return messages;
}

export function createMessagesProvider({
  baseUrl,
  model,
  apiKeyEnv = 'LIGULE_API_KEY',
  capabilities,
  outputTokens,
  declaredOutputLimit,
  contextTokens,
  imageInput: declaredImageInput,
  retry = DEFAULT_RETRY,
}: MessagesProviderOptions = {}): ModelProvider {
  const root = messagesRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = capabilitiesOf(capabilities);
  const imageInput = imageInputOf(root, model, declaredImageInput, 'messages');
  const budgetLimits = {
    defaultTokens: effective.maxOutputTokens,
    configuredLimit: capabilities?.maxOutputTokens === undefined ? undefined : effective.maxOutputTokens,
    ...(declaredOutputLimit === undefined ? {} : { declaredOutputLimit }),
  };
  const maxOutputTokens = outputTokenCeiling({ baseUrl: root, model, ...budgetLimits });
  const budget = resolveOutputTokens({ baseUrl: root, model, requested: outputTokens, ...budgetLimits, contextLimit: contextTokens });

  async function* stream(request: ModelRequest, { signal }: { readonly signal?: AbortSignal | null } = {}): AsyncGenerator<ProviderEvent> {
    assertAllAnswered(request.messages ?? []);
    const images = await resolveRequestImages(request, imageInput, signal);
    const response = await open(`${root}/messages`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': effective.streaming ? 'text/event-stream' : 'application/json',
        'x-api-key': await readCredential(apiKeyEnv),
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: budget,
        stream: effective.streaming,
        system: request.system,
        messages: toWireMessages(request.messages ?? [], images),
        tools: (request.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      }),
    }, retry);
    if (response.body === null) throw new KernelError('provider_stream_missing');

    if (!effective.streaming) {
      const message = asRecord(await readJson(response, signal), 'a Messages response is not an object');
      if (message.role !== undefined && message.role !== 'assistant') throw new KernelError('provider_stream_invalid', { detail: 'response is not an assistant message' });
      if (!Array.isArray(message.content)) throw new KernelError('provider_stream_incomplete');
      const calls: { id: string; name: string; input: unknown }[] = [];
      const callIds = new Set<string>();
      for (const rawBlock of message.content) {
        const block = asRecord(rawBlock, 'a content block is not an object');
        if (block.type === 'text') {
          if (typeof block.text !== 'string') throw new KernelError('provider_stream_invalid', { detail: 'text block has no text' });
          if (block.text !== '') yield { type: 'text', text: block.text };
        } else if (block.type === 'thinking') {
          if (typeof block.thinking !== 'string') throw new KernelError('provider_stream_invalid', { detail: 'thinking block has no text' });
          if (block.thinking !== '') yield { type: 'reasoning', text: block.thinking };
        } else if (block.type === 'redacted_thinking') {
          continue;
        } else if (block.type === 'tool_use') {
          const id = requiredString(block.id, 'tool_use has no id');
          if (callIds.has(id)) throw new KernelError('provider_tool_call_invalid', { detail: 'duplicate tool call id' });
          callIds.add(id);
          calls.push({
            id,
            name: requiredString(block.name, 'tool_use has no name'),
            input: block.input ?? {},
          });
        } else {
          throw new KernelError('provider_content_unsupported', { detail: 'unsupported content block type' });
        }
      }
      const reason = message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence'
        ? 'stop'
        : message.stop_reason === 'tool_use'
          ? 'tool_calls'
          : message.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : undefined;
      if (reason === undefined) {
        if (typeof message.stop_reason !== 'string') throw new KernelError('provider_stream_incomplete');
        throw new KernelError('provider_finish_reason_invalid');
      }
      if (reason !== 'max_tokens') {
        for (const call of calls) yield { type: 'tool-call', id: call.id, name: call.name, args: call.input };
      }
      const usage = message.usage === undefined || message.usage === null
        ? undefined
        : asRecord(message.usage, 'message usage is not an object');
      if (usage !== undefined) {
        const event = messagesUsageEvent(usage);
        if (event !== undefined) yield event;
      }
      yield { type: 'finish', reason };
      return;
    }

    const blocks = new Map<number, MessageBlockState>();
    let started = false;
    // 汇总用量对象，保留 message_start 的缓存分项和 message_delta 的最终输出数。
    let usageRecord: JsonRecord = {};
    let stopReason: unknown;
    let stopped = false;
    const toolCalls: { id: string; name: string; input: unknown; json: string }[] = [];
    const callIds = new Set<string>();
    for await (const rawEvent of parseSse(response.body, { signal })) {
      const event = asRecord(rawEvent, 'an event is not an object');
      if (stopped) throw new KernelError('provider_stream_invalid', { detail: 'an event follows message_stop' });
      // 忽略不包含内容的扩展事件类型。
      if (event.type === 'message_start') {
        if (started) throw new KernelError('provider_stream_invalid', { detail: 'duplicate message_start' });
        started = true;
        const message = typeof event.message === 'object' && event.message !== null ? event.message : {};
        const usageValue = asRecord(message, 'message_start has an invalid message');
        const usage = typeof usageValue.usage === 'object' && usageValue.usage !== null ? usageValue.usage : {};
        usageRecord = asRecord(usage, 'message_start has invalid usage');
        continue;
      }
      if (!started) throw new KernelError('provider_stream_invalid', { detail: 'an event precedes message_start' });
      if (event.type === 'content_block_start') {
        const index = typeof event.index === 'number' ? event.index : Number.NaN;
        if (!Number.isInteger(index)) throw new KernelError('provider_stream_invalid', { detail: 'content block has an invalid index' });
        if (blocks.has(index)) throw new KernelError('provider_stream_invalid', { detail: 'duplicate open content block' });
        const content = asRecord(event.content_block ?? {}, 'content_block_start has an invalid content block');
        if (content.type === 'text') {
          blocks.set(index, { kind: 'text' });
          if (typeof content.text === 'string' && content.text !== '') yield { type: 'text', text: content.text };
        }
        else if (content.type === 'tool_use') {
          const id = requiredString(content.id, 'tool_use has no id');
          if (callIds.has(id)) throw new KernelError('provider_tool_call_invalid', { detail: 'duplicate tool call id' });
          callIds.add(id);
          blocks.set(index, {
            kind: 'tool',
            id,
            name: requiredString(content.name, 'tool_use has no name'),
            input: content.input ?? {},
            json: '',
          });
        }
        // 将推理内容块转换为 reasoning 事件。
        // 签名字段仅用于原生 Anthropic 端点，目前不传回内部事件。
        else if (content.type === 'thinking' || content.type === 'redacted_thinking') blocks.set(index, { kind: 'reasoning' });
        else throw new KernelError('provider_content_unsupported', { detail: 'unsupported content block type' });
      } else if (event.type === 'content_block_delta') {
        const index = typeof event.index === 'number' ? event.index : Number.NaN;
        const block = blocks.get(index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a delta without an open block' });
        const delta = asRecord(event.delta ?? {}, 'content_block_delta has an invalid delta');
        if (delta.type === 'text_delta') {
          yield { type: 'text', text: stringOrEmpty(delta.text) };
        } else if (delta.type === 'input_json_delta') {
          if (block.kind !== 'tool') throw new KernelError('provider_stream_invalid', { detail: 'input JSON delta without a tool block' });
          block.json += stringOrEmpty(delta.partial_json);
        } else if (delta.type === 'thinking_delta') {
          yield { type: 'reasoning', text: stringOrEmpty(delta.thinking) };
        } else if (delta.type === 'signature_delta') {
          if (block.kind !== 'reasoning') {
            throw new KernelError('provider_stream_invalid', { detail: 'a signature delta on a block that is not reasoning' });
          }
          block.signature = (block.signature ?? '') + stringOrEmpty(delta.signature);
        } else {
          throw new KernelError('provider_stream_invalid', { detail: 'unsupported content delta type' });
        }
      } else if (event.type === 'content_block_stop') {
        const index = typeof event.index === 'number' ? event.index : Number.NaN;
        const block = blocks.get(index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a stop without an open block' });
        blocks.delete(index);
        if (block.kind !== 'tool') continue;
        toolCalls.push(block);
      } else if (event.type === 'message_delta') {
        const delta = asRecord(event.delta ?? {}, 'message_delta has invalid delta');
        if (delta.stop_reason !== undefined) stopReason = delta.stop_reason;
        const usage = typeof event.usage === 'object' && event.usage !== null ? asRecord(event.usage, 'message_delta has invalid usage') : {};
        usageRecord = { ...usageRecord, ...usage };
      } else if (event.type === 'message_stop') {
        if (blocks.size > 0) throw new KernelError('provider_stream_incomplete');
        stopped = true;
      }
    }
    if (!stopped || typeof stopReason !== 'string') throw new KernelError('provider_stream_incomplete');
    const reason = stopReason === 'end_turn' || stopReason === 'stop_sequence'
      ? 'stop'
      : stopReason === 'tool_use'
        ? 'tool_calls'
        : stopReason === 'max_tokens'
          ? 'max_tokens'
          : undefined;
    if (reason === undefined) throw new KernelError('provider_finish_reason_invalid');
    if (reason !== 'max_tokens') {
      const parsed = toolCalls.map((call) => ({ type: 'tool-call' as const, id: call.id, name: call.name,
        args: call.json === '' ? call.input : parseArgs(call.json) }));
      for (const call of parsed) yield call;
    }
    const usage = messagesUsageEvent(usageRecord);
    if (usage !== undefined) yield usage;
    yield { type: 'finish', reason };
  }

  const provider = {
    imageInput,
    name: 'messages',
    requiresCompletion: true as const,
    model,
    capabilities: effective,
    maxOutputTokens,
    outputTokens: budget,
    stream,
    // 模型切换必须由调用方明确请求；失败时不自动改用其他模型。
    withModel(next: string) {
      return createMessagesProvider({ baseUrl, model: next, apiKeyEnv, capabilities, outputTokens,
        ...(next === model ? { declaredOutputLimit, contextTokens, imageInput: declaredImageInput } : {}), retry });
    },
  };
  return Object.freeze(provider);
}

// 参数无法解析时立即报错，不等待流结束。空参数片段表示无参数调用，不等于参数缺失。
function parseArgs(json: string): unknown {
  if (json === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch (error) {
    throw new KernelError('provider_tool_args_invalid', { detail: 'tool arguments are not valid JSON' });
  }
}
