// 会话记录首行保存格式版本、项目归属和创建时的模式信息。
// 未知格式版本必须拒绝读取，避免静默跳过记录并生成错误的模型上下文。
import { KernelRuntimeError } from '../errors.js';
import { isCanonicalTodoItems } from './todo.js';
import { checkedImageReferences } from './media.js';
import { isRunAcceptance, isRunResultRef } from './run.js';

export const SESSION_FORMAT_VERSION = 2;

export interface SessionModeIdentity {
  name: string;
  layer: string;
  source?: 'named' | 'inline';
  digest?: string;
  fileDigest?: string;
  tools?: string[];
  prompt?: string[];
}

export interface SessionHeader {
  kind: 'session';
  formatVersion: number;
  sessionId: string;
  projectRoot: string;
  // 保存工作区身份及来源：`explicit` 表示客户端指定，`default` 表示使用默认工作区。
  // 旧记录缺少这两个字段时保持未指定，不使用当前默认目录补写。
  workspace?: string;
  workspaceOrigin?: 'explicit' | 'default';
  createdAt?: string | null;
  mode?: SessionModeIdentity;
  branchOf?: string;
  branchAt?: number;
}

export interface SessionEvent {
  seq: number;
  kind?: string;
  [key: string]: unknown;
}

// 追加前的事件不含序号；写入时由 Session 分配。
export type PendingSessionEvent = Omit<SessionEvent, 'seq'>;

// 从 `label` 事件推导当前名称和归档状态；新事件只覆盖其中实际提供的字段。
// 会话列表、Host 响应和搜索共用此函数。
export function foldLabel(events: SessionEvent[]): { name: string; archived: boolean } {
  let name = '';
  let archived = false;
  for (const event of events) {
    if (event.kind !== 'label') continue;
    if (typeof event.name === 'string') name = event.name;
    if (typeof event.archived === 'boolean') archived = event.archived;
  }
  return { name, archived };
}

export interface SessionRecord {
  events: SessionEvent[];
  formatVersion: number;
  header: SessionHeader | undefined;
}

function checkedSessionHeader(event: SessionEvent, version: number): SessionHeader {
  const item = event as Record<string, unknown>;
  const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
  const optionalText = (key: string, max: number) => item[key] === undefined || text(item[key], max);
  const mode = item.mode;
  if ((item.sessionId !== undefined && (!text(item.sessionId, 256) || item.sessionId === ''))
    || (version >= 1 && (!text(item.sessionId, 256) || item.sessionId === ''))
    || !optionalText('projectRoot', 8192) || !optionalText('workspace', 8192)
    || ((item.branchOf === undefined) !== (item.branchAt === undefined))
    || (item.branchOf !== undefined && (!text(item.branchOf, 256) || item.branchOf === ''
      || /[\\/]/u.test(item.branchOf) || !Number.isSafeInteger(item.branchAt) || Number(item.branchAt) < 0))
    || (item.workspaceOrigin !== undefined && item.workspaceOrigin !== 'explicit' && item.workspaceOrigin !== 'default')
    || (item.createdAt !== undefined && item.createdAt !== null
      && (!text(item.createdAt, version < 2 ? 8192 : 128) || !Number.isFinite(Date.parse(item.createdAt as string))))
    || (mode !== undefined && (typeof mode !== 'object' || mode === null || Array.isArray(mode)
      || !text((mode as Record<string, unknown>).name, 256)
      || !text((mode as Record<string, unknown>).layer, 128)
      || ((mode as Record<string, unknown>).source !== undefined && !['named', 'inline'].includes(String((mode as Record<string, unknown>).source)))
      || ['digest', 'fileDigest'].some(key => (mode as Record<string, unknown>)[key] !== undefined
        && !text((mode as Record<string, unknown>)[key], 128))
      || ['tools', 'prompt'].some(key => {
        const list = (mode as Record<string, unknown>)[key];
        return list !== undefined && (!Array.isArray(list) || list.length > 1024 || !list.every(value => text(value, 256)));
      })))) throw new KernelRuntimeError('session_header_invalid');
  return event as unknown as SessionHeader;
}

// 当前程序会写入的事件类型。未知事件仅在标记为 `ignorable` 时允许跳过，其他情况拒绝读取。
// `usage` 虽不进入模型投影，但其序号仍用于校验检查点范围，因此必须保留。
// `compaction` 记录每次压缩的块与原因，供界面与导出说明；同样不进入模型投影。
// `label` 保存会话名称和归档状态；这些信息供界面使用，不进入模型上下文。
const WRITTEN_KINDS = [
  'session', 'user', 'reasoning', 'assistant', 'tool', 'mode', 'usage', 'turn', 'label', 'turnContext', 'modelSelection',
  'sessionGeneration', 'sessionLoopIterations', 'sessionPermission', 'sessionPolicy', 'sessionMcpTrust', 'sessionPolicyRule',
  'compaction', 'todoWrite', 'image', 'screenCapture',
];

export function createSessionHeader({
  id,
  projectRoot,
  workspace,
  workspaceOrigin,
  createdAt,
  mode,
}: {
  id: string;
  projectRoot?: string;
  workspace?: string;
  workspaceOrigin?: 'explicit' | 'default';
  createdAt: string;
  mode?: SessionModeIdentity;
}): SessionHeader {
  const header: SessionHeader = {
    kind: 'session',
    formatVersion: SESSION_FORMAT_VERSION,
    sessionId: id,
    // 创建记录时可能尚未确定模式；此时省略该字段，不写空名称或虚构的默认值。
    projectRoot: projectRoot ?? '',
    createdAt,
  };
  if (workspace !== undefined && workspace !== '') header.workspace = workspace;
  if (workspaceOrigin !== undefined) header.workspaceOrigin = workspaceOrigin;
  if (mode !== undefined) header.mode = mode;
  return header;
}

// 首行元数据不是事件，不占事件序号；旧记录没有首行时按版本 0 读取。
export function parseSessionEvents(objects: SessionEvent[]): SessionRecord {
  let formatVersion = 0;
  let header: SessionHeader | undefined;
  let currentUserSeq: number | null = null;
  let currentRunId: string | undefined;
  let currentTurnFinished = false;
  const runIds = new Set<string>();
  const requestKeys = new Set<string>();
  const imageCalls = new Set<string>();
  const events: SessionEvent[] = [];
  for (const [index, event] of objects.entries()) {
    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'session') {
      // 会话元数据只能出现在首行；后续再次出现通常表示记录被拼接，应拒绝读取。
      if (index !== 0) throw new KernelRuntimeError('session_header_position', { detail: `line ${index + 1}` });
      const version = event.formatVersion;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
        throw new KernelRuntimeError('session_header_invalid', { detail: `formatVersion ${JSON.stringify(version)}` });
      }
      if (version > SESSION_FORMAT_VERSION) {
        throw new KernelRuntimeError('session_version_unsupported', {
          detail: `the record is version ${version}, this build reads up to ${SESSION_FORMAT_VERSION}`,
        });
      }
      formatVersion = version;
      header = checkedSessionHeader(event, version);
      continue;
    }
    if (!WRITTEN_KINDS.includes(kind)) {
      // 未知事件只有标记为可忽略时才跳过；其他未知事件可能影响记录重建，必须拒绝读取。
      if (event.ignorable !== true) {
        throw new KernelRuntimeError('session_event_unsupported', { detail: kind === '' ? 'an event without a kind' : kind });
      }
      continue;
    }
    if ((kind === 'sessionPermission' || kind === 'sessionPolicy') && formatVersion < 2) {
      throw new KernelRuntimeError('session_event_version_unsupported', { detail: `${kind} requires format version 2` });
    }
    if (kind === 'sessionPolicy') {
      if (event.ignorable !== true) throw new KernelRuntimeError('session_policy_ignorable_required');
      const override = event.override;
      if ((override !== null && override !== 'ask' && override !== 'auto' && override !== 'none' && override !== 'never')
        || !Number.isSafeInteger(event.consecutive) || (event.consecutive as number) < 0
        || !Number.isSafeInteger(event.total) || (event.total as number) < (event.consecutive as number)
        || typeof event.forcedToAsk !== 'boolean') {
        throw new KernelRuntimeError('session_policy_event_invalid');
      }
    }
    if (kind === 'sessionMcpTrust') {
      if (event.ignorable !== true || event.source !== 'trusted-ui' || typeof event.server !== 'string' || event.server === '' || event.server.length > 128
        || typeof event.identityDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(event.identityDigest)
        || typeof event.trusted !== 'boolean'
        || typeof event.updatedAt !== 'string' || !Number.isFinite(Date.parse(event.updatedAt))) {
        throw new KernelRuntimeError('session_mcp_trust_event_invalid');
      }
    }
    if (kind === 'todoWrite') {
      if (event.ignorable !== true || currentTurnFinished || !Number.isSafeInteger(event.userSeq) || event.userSeq !== currentUserSeq
        || !isCanonicalTodoItems(event.items)) {
        throw new KernelRuntimeError('session_todo_event_invalid');
      }
    }
    if (kind === 'user' && event.run !== undefined) {
      const inherited = header?.branchOf !== undefined && event.seq <= header.branchAt!;
      if (!isRunAcceptance(event.run) || (header?.sessionId !== event.run.sessionId && !inherited)
        || runIds.has(event.run.runId)
        || (event.run.requestKey !== undefined
          && requestKeys.has(JSON.stringify([event.run.sessionId, event.run.callerScope, event.run.requestKey])))) {
        throw new KernelRuntimeError('session_run_acceptance_invalid');
      }
      runIds.add(event.run.runId);
      if (event.run.requestKey !== undefined) requestKeys.add(JSON.stringify([event.run.sessionId, event.run.callerScope, event.run.requestKey]));
    }
    if (kind === 'turn' && currentRunId !== undefined && event.userSeq === currentUserSeq
      && event.status === 'completed' && event.resultRef === undefined) {
      throw new KernelRuntimeError('session_run_result_reference_invalid');
    }
    if (kind === 'turn' && (event.runId !== undefined || event.resultRef !== undefined)) {
      if (typeof event.runId !== 'string' || event.runId !== currentRunId
        || event.userSeq !== currentUserSeq || currentTurnFinished
        || !['completed', 'failed', 'cancelled', 'interrupted'].includes(String(event.status))
        || (event.resultRef !== undefined && !isRunResultRef(event.resultRef, event.runId))) {
        throw new KernelRuntimeError('session_run_result_reference_invalid');
      }
    }
    if (kind === 'image') {
      if (event.ignorable === true || typeof event.callId !== 'string' || event.callId === '') throw new KernelRuntimeError('session_image_reference_invalid');
      imageCalls.add(event.callId);
    }
    if (kind === 'screenCapture' && (event.ignorable !== true || typeof event.enabled !== 'boolean'
      || !['startup', 'trusted-ui', 'grant', 'parent'].includes(String(event.source))
      || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)))) {
      throw new KernelRuntimeError('session_screen_capture_event_invalid');
    }
    if (kind === 'tool' && typeof event.result === 'object' && event.result !== null && 'images' in event.result && event.result.images !== undefined) {
      if (typeof event.callId !== 'string' || !imageCalls.has(event.callId)) throw new KernelRuntimeError('session_image_reference_invalid');
      try { checkedImageReferences(event.result.images); }
      catch (cause) { throw new KernelRuntimeError('session_image_reference_invalid', { cause }); }
    }
    if (kind === 'compaction') {
      if (event.ignorable !== true
        || (event.reason !== 'manual' && event.reason !== 'auto' && event.reason !== 'overflow' && event.reason !== 'model')
        || !Number.isSafeInteger(event.blockId) || (event.blockId as number) < 1
        || !Number.isSafeInteger(event.fromSeq) || (event.fromSeq as number) < 0
        || !Number.isSafeInteger(event.toSeq) || (event.toSeq as number) < (event.fromSeq as number)
        || typeof event.tokensBefore !== 'number' || !Number.isFinite(event.tokensBefore)
        || typeof event.tokensAfter !== 'number' || !Number.isFinite(event.tokensAfter)) {
        throw new KernelRuntimeError('session_compaction_event_invalid');
      }
    }
    if (kind === 'sessionPolicyRule') {
      const rule = typeof event.rule === 'object' && event.rule !== null && !Array.isArray(event.rule)
        ? event.rule as Record<string, unknown>
        : undefined;
      if (event.ignorable !== true || rule === undefined
        || typeof event.updatedAt !== 'string' || !Number.isFinite(Date.parse(event.updatedAt))
        || typeof rule.tool !== 'string' || rule.tool.trim() === ''
        || (rule.decision !== 'allow' && rule.decision !== 'ask' && rule.decision !== 'deny')
        || (rule.match !== undefined && typeof rule.match !== 'string')
        || (rule.reason !== undefined && typeof rule.reason !== 'string')
        || (rule.target !== undefined && rule.target !== 'file' && rule.target !== 'workspace')
        || (rule.path !== undefined && typeof rule.path !== 'string')
        || (rule.argsHash !== undefined && (typeof rule.argsHash !== 'string' || !/^[a-f0-9]{64}$/u.test(rule.argsHash)))
        || ((rule.target === undefined) !== (rule.path === undefined))
        || (rule.target !== undefined && (rule.match !== undefined || rule.argsHash !== undefined))
        || (typeof rule.path === 'string' && !(/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/u.test(rule.path) || rule.path.startsWith('/')))) {
        throw new KernelRuntimeError('session_policy_rule_event_invalid');
      }
    }
    events.push(event);
    if (kind === 'user') {
      currentUserSeq = event.seq;
      currentRunId = isRunAcceptance(event.run) ? event.run.runId : undefined;
      currentTurnFinished = false;
    } else if (kind === 'turn' && event.userSeq === currentUserSeq
      && (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled' || event.status === 'interrupted')) {
      currentTurnFinished = true;
    }
  }
  return { events, formatVersion, header };
}
