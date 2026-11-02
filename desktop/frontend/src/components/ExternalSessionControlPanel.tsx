import { useEffect, useRef, useState } from 'react';
import { ApprovalCard, type Ask } from './ApprovalCard';
import { QuestionCard, type QuestionAsk, type QuestionDrafts } from './QuestionCard';
import { Modal } from './ui';
import type { Verbosity } from './types';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { changeBody, changeOf } from '../rows';
import { Icon } from './Icon';
import type { Status } from '../status';

type PendingInteraction = {
  requestId: string;
  sessionId: string;
  type: 'approval' | 'question';
  details: Record<string, unknown>;
};

type ControlEvent = {
  kind: string;
  eventKind?: string;
  type?: 'text' | 'reasoning';
  text?: string;
};

type ControlSnapshot = {
  operationId?: string;
  sessionId: string;
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  ownership: 'external' | 'human';
  phase: string | null;
  progress: { modelCalls: number; toolCalls: number; lastProgressAt: number } | null;
  pendingInteractions: PendingInteraction[];
  events: ControlEvent[];
  nextCursor: number;
  eventGap: boolean;
  firstAvailableCursor: number;
  queue: { queueItemId: string; inputCharacters: number; source: 'human' | 'controller' }[];
};

function questionOf(item: PendingInteraction, project: string): QuestionAsk {
  const details = item.details;
  return {
    id: item.requestId,
    sessionId: item.sessionId,
    project,
    questions: details.questions as QuestionAsk['questions'],
  };
}

function approvalOf(item: PendingInteraction, project: string, expanded?: { args?: Record<string, unknown>; error?: string; loading?: boolean }): Ask {
  const details = item.details;
  const args = expanded?.args ?? (typeof details.args === 'object' && details.args !== null && !Array.isArray(details.args) ? details.args as Record<string, unknown> : {});
  const change = changeOf(typeof details.tool === 'string' ? details.tool : 'unknown', args);
  const englishChange = changeOf(typeof details.tool === 'string' ? details.tool : 'unknown', args, 'en');
  const metadata = typeof details.contentBytes === 'number' && typeof details.contentSha256 === 'string'
    ? `Content ${details.contentBytes} bytes · SHA-256 ${details.contentSha256}\n\n`
    : typeof details.argumentSha256 === 'string' ? `Arguments ${details.argumentBytes ?? 0} bytes · SHA-256 ${details.argumentSha256}\n\n` : '';
  return {
    id: item.requestId,
    sessionId: item.sessionId,
    project,
    tool: typeof details.tool === 'string' ? details.tool : 'unknown',
    detail: typeof details.command === 'string' ? details.command : typeof args.path === 'string' ? args.path : '',
    change: change.summary,
    reason: typeof details.reason === 'string' ? details.reason : '',
    backend: typeof details.executable === 'string' ? details.executable : typeof details.shell === 'string' ? details.shell : '',
    policy: typeof details.policy === 'string' ? details.policy : '',
    policySource: typeof details.policySource === 'string' ? details.policySource : '',
    policyForced: details.policyForced === true,
    content: `${metadata}${changeBody(change, args)}`,
    english: { change: englishChange.summary, content: `${metadata}${changeBody(englishChange, args, 'en')}` },
    detailsRef: typeof details.detailsRef === 'string' ? details.detailsRef : item.requestId,
    ...(typeof details.argumentBytes === 'number' ? { argumentBytes: details.argumentBytes } : {}),
    ...(typeof details.argumentSha256 === 'string' ? { argumentSha256: details.argumentSha256 } : {}),
    ...(typeof details.identityDigest === 'string' ? { identityDigest: details.identityDigest } : {}),
    rememberable: details.rememberable === true,
    rememberScopes: Array.isArray(details.rememberScopes)
      ? details.rememberScopes.filter((scope): scope is 'session' | 'project' | 'user' => scope === 'session' || scope === 'project' || scope === 'user')
      : [],
    rememberHintKey: details.rememberHintKey === 'file' || details.rememberHintKey === 'command' || details.rememberHintKey === 'mcp' || details.rememberHintKey === 'tool'
      ? details.rememberHintKey
      : 'tool',
    rememberTargetOptions: Array.isArray(details.rememberTargetOptions)
      ? details.rememberTargetOptions.filter((target): target is 'file' | 'workspace' | 'tool' | 'command' => target === 'file' || target === 'workspace' || target === 'tool' || target === 'command')
      : [],
    detailsLoading: expanded?.loading === true,
    ...(expanded?.error === undefined ? {} : { detailsError: expanded.error }),
    detailsLoaded: expanded?.args !== undefined,
  };
}

function phaseLabel(snapshot: ControlSnapshot | null, t: (chinese: string, english: string) => string): string {
  if (snapshot?.state === 'failed') return t('运行失败', 'Run failed');
  if (snapshot?.state === 'cancelled') return t('已停止', 'Stopped');
  if (snapshot?.state === 'done') return t('已完成', 'Completed');
  switch (snapshot?.phase) {
    case 'awaiting_approval': return t('等待审批', 'Waiting for approval');
    case 'awaiting_input': return t('等待回答', 'Waiting for an answer');
    case 'model_request': return t('正在请求模型', 'Requesting the model');
    case 'tool_execution': return t('正在执行工具', 'Running tools');
    default: return snapshot?.state === 'running' ? t('运行中', 'Running') : t('等待外控任务', 'Waiting for an external task');
  }
}

export function ExternalSessionControlPanel({ client, sessionId, projectRoot, verbosity, onRuntimeAvailability, onDelta, onSessionEvent, onTakeover }: {
  client: Client;
  sessionId: string;
  projectRoot: string;
  verbosity: Verbosity;
  onRuntimeAvailability: (sessionId: string, available: boolean) => void;
  onDelta: (kind: 'text' | 'reasoning', text: string) => void;
  onSessionEvent: (kind: string) => void;
  onTakeover: () => void;
}) {
  const t = useText();
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const [approvalDetails, setApprovalDetails] = useState<Record<string, { args?: Record<string, unknown>; error?: string; loading?: boolean }>>({});
  const observedExternalControl = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let operationId: string | null = null;
    let inFlight = false;
    const schedule = (delayMs: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void poll(); }, delayMs);
    };
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      let waitMs = 0;
      try {
        const result = await client.call('session.control', {
          projectRoot,
          sessionId,
          request: { action: 'status', after: cursor, limit: 50, waitMs: 10_000 },
        }, 35_000) as ControlSnapshot;
        if (disposed) return;
        const nextOperationId = result.operationId ?? null;
        if (nextOperationId !== operationId) {
          operationId = nextOperationId;
          cursor = 0;
          if (nextOperationId !== null) {
            waitMs = 0;
            schedule(0);
            return;
          }
        }
        if (result.eventGap) {
          cursor = Math.max(0, result.firstAvailableCursor - 1);
          setNote({ text: t('部分实时更新已滚出事件窗口；转录记录仍可刷新查看。', 'Some live updates left the event window; refresh the transcript to review saved records.'), bad: false });
          waitMs = 0;
        }
        for (const event of result.events) {
          if (event.kind === 'model.delta' && event.type !== undefined && typeof event.text === 'string') onDelta(event.type, event.text);
          else if (event.kind === 'session.event' && typeof event.eventKind === 'string') onSessionEvent(event.eventKind);
        }
        cursor = Math.max(cursor, result.nextCursor);
        observedExternalControl.current = true;
        setSnapshot(result);
        onRuntimeAvailability(sessionId, true);
        setNote((current) => current?.bad === true ? null : current);
        waitMs = result.state === 'running' ? 0 : 1_000;
      } catch (error) {
        if (!disposed) {
          setSnapshot(null);
          onRuntimeAvailability(sessionId, false);
          setNote({ text: t(`外控连接暂不可用：${code(error)}`, `External control is unavailable: ${code(error)}`), bad: true });
          waitMs = 1_000;
        }
      } finally {
        inFlight = false;
        if (!disposed && timer === undefined) schedule(waitMs);
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [client, onDelta, onRuntimeAvailability, onSessionEvent, projectRoot, sessionId, t]);

  async function act(request: Record<string, unknown>): Promise<unknown> {
    return await client.call('session.control', { projectRoot, sessionId, request }, 35_000);
  }

  async function reply(item: PendingInteraction, answer: Record<string, unknown>): Promise<void> {
    setBusy(true);
    try {
      await act({ action: 'reply', requestId: item.requestId, type: item.type, ...answer });
      setNote({ text: t('已将答复交给外控会话。', 'Answer sent to the external session.'), bad: false });
    } catch (error) {
      setNote({ text: t(`答复未提交：${code(error)}`, `Answer was not submitted: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  async function loadApprovalDetails(item: PendingInteraction): Promise<void> {
    if (approvalDetails[item.requestId]?.args !== undefined || approvalDetails[item.requestId]?.loading === true) return;
    setApprovalDetails((current) => ({ ...current, [item.requestId]: { loading: true } }));
    try {
      const result = await act({ action: 'details', requestId: item.requestId }) as { args?: unknown };
      if (typeof result.args !== 'object' || result.args === null || Array.isArray(result.args)) throw new Error('approval_details_invalid');
      setApprovalDetails((current) => ({ ...current, [item.requestId]: { args: result.args as Record<string, unknown> } }));
    } catch (error) {
      setApprovalDetails((current) => ({ ...current, [item.requestId]: { error: code(error) } }));
    }
  }

  async function cancel(): Promise<void> {
    setBusy(true);
    try {
      await act({ action: 'cancel' });
      setNote({ text: t('已请求停止外控会话当前轮次。', 'Requested cancellation of the active external turn.'), bad: false });
    } catch (error) {
      setNote({ text: t(`停止请求失败：${code(error)}`, `Could not stop the run: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  async function takeOver(): Promise<void> {
    setBusy(true);
    try {
      await act({ action: 'takeover' });
      setConfirmTakeover(false);
      onTakeover();
    } catch (error) {
      setNote({ text: t(`接管失败：${code(error)}`, `Could not take over: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  const pending = snapshot?.pendingInteractions ?? [];
  const project = projectRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
  const phase = phaseLabel(snapshot, t);

  if (snapshot === null) return !observedExternalControl.current || note === null ? null : <section className="external-control" aria-label={t('外控会话控制', 'External session controls')}>
    <p className="external-control-note bad" role="alert">{note.text}</p>
  </section>;

  return <section className="external-control" aria-label={t('外控会话控制', 'External session controls')}>
    <div className="external-control-head">
      <strong>{t('外控会话', 'External session')}</strong>
      <span className="external-control-state" role="status">{phase}</span>
      {snapshot?.progress !== null && snapshot?.progress !== undefined && snapshot.state === 'running'
        && <span className="external-control-metrics">{snapshot.progress.modelCalls} {t('次模型调用', 'model calls')} · {snapshot.progress.toolCalls} {t('个工具调用', 'tool calls')}</span>}
      {snapshot?.state === 'running' && <button type="button" disabled={busy} onClick={() => void cancel()}>{t('停止本轮', 'Stop turn')}</button>}
      <button type="button" disabled={busy} onClick={() => setConfirmTakeover(true)}>{t('接管会话', 'Take over')}</button>
    </div>
    {note !== null && <p className={note.bad ? 'external-control-note bad' : 'external-control-note'} role={note.bad ? 'alert' : 'status'}>{note.text}</p>}
    {pending.map((item) => item.type === 'question'
      ? <QuestionCard
          key={item.requestId}
          ask={questionOf(item, project)}
          queued={pending.length - 1}
          active={sessionId}
          onSubmit={(answers) => void reply(item, { answers })}
          onCancel={() => void cancel()}
          onOpen={() => undefined}
          onDraft={(_id: string, _drafts: QuestionDrafts) => undefined}
        />
      : <ApprovalCard
          key={item.requestId}
          ask={approvalOf(item, project, approvalDetails[item.requestId])}
          queued={pending.length - 1}
          verbosity={verbosity}
          active={sessionId}
          onAnswer={(decision, rememberScope, rememberTarget) => void reply(item, {
            decision,
            ...(rememberScope === undefined ? {} : { rememberScope }),
            ...(rememberTarget === undefined ? {} : { rememberTarget }),
          })}
          onOpen={() => undefined}
          onDetails={() => void loadApprovalDetails(item)}
        />)}
    {confirmTakeover && <Modal title={t('接管外控会话', 'Take over external session')} className="confirm" onClose={() => setConfirmTakeover(false)}>
      <h2 className="confirm-lead">{t('停止外控并将会话交给 Desktop？', 'Stop external control and give this session to Desktop?')}</h2>
      <p className="confirm-note">{t('当前轮次会先取消，等待中的外控队列会清空。已经写入工作区的文件不会回滚。', 'The active turn will be cancelled and queued external messages cleared. Workspace changes already made will remain.')}</p>
      <div className="confirm-actions">
        <button type="button" disabled={busy} onClick={() => setConfirmTakeover(false)}>{t('继续观察', 'Keep observing')}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void takeOver()}>{t('接管', 'Take over')}</button>
      </div>
    </Modal>}
  </section>;
}

function policyName(value: string | undefined, t: (chinese: string, english: string) => string): string {
  switch (value) {
    case 'ask': return t('逐项审批', 'Ask each time');
    case 'auto': return t('自动批准', 'Auto approve');
    case 'none': return t('不提示', 'No prompts');
    case 'never': return t('旧版拒绝模式', 'Legacy refusal mode');
    default: return value ?? t('未知', 'Unknown');
  }
}

function permissionName(value: string | undefined, t: (chinese: string, english: string) => string): string {
  switch (value) {
    case 'read-only': return t('只读', 'Read only');
    case 'workspace-write': return t('工作区写入', 'Workspace write');
    case 'full-access': return t('完全访问', 'Full access');
    default: return value ?? t('未知', 'Unknown');
  }
}

function networkName(value: string | undefined, t: (chinese: string, english: string) => string): string {
  switch (value) {
    case 'disabled': return t('禁用', 'Disabled');
    case 'policy': return t('按策略', 'Policy controlled');
    case 'unrestricted': return t('不受限', 'Unrestricted');
    default: return value ?? t('未知', 'Unknown');
  }
}

export function ExternalSessionComposer({ client, sessionId, projectRoot, draft, draftRevision, onDraftChange, onDraftSent }: {
  client: Client;
  sessionId: string;
  projectRoot: string;
  draft: string;
  draftRevision: number;
  onDraftChange: (draft: string) => void;
  onDraftSent: (submittedRevision: number) => void;
}) {
  const t = useText();
  const [status, setStatus] = useState<Status | null>(null);
  const [configurationFailed, setConfigurationFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const current = await client.call('session.control', {
          projectRoot,
          sessionId,
          request: { action: 'configuration' },
        }, 10_000) as Status;
        if (!disposed) {
          setStatus(current);
          setConfigurationFailed(false);
        }
      } catch {
        if (!disposed) {
          setStatus(null);
          setConfigurationFailed(true);
        }
      } finally {
        inFlight = false;
        if (!disposed) timer = setTimeout(() => { void refresh(); }, 5_000);
      }
    };
    void refresh();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [client, projectRoot, sessionId]);

  async function send(): Promise<void> {
    const submittedDraft = draft;
    const submittedRevision = draftRevision;
    if (submittedDraft.trim() === '' || busy) return;
    setBusy(true);
    try {
      const result = await client.call('session.control', {
        projectRoot,
        sessionId,
        request: { action: 'send', input: submittedDraft },
      }, 35_000) as { queued?: boolean };
      onDraftSent(submittedRevision);
      setNote({
        text: result.queued === true
          ? t('消息已加入外控会话队列。', 'Message queued for the external session.')
          : t('消息已发送给外控 Agent。', 'Message sent to the external agent.'),
        bad: false,
      });
    } catch (error) {
      setNote({ text: t(`消息未发送：${code(error)}`, `Message was not sent: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  const grant = status?.delegation ?? null;
  const modelName = status?.selectedModel ?? status?.model ?? t('未知', 'Unknown');
  const modelProvider = status?.serviceId;
  const policy = policyName(status?.policy, t);
  const policySource = status?.policySource === 'session' ? t('会话设置', 'session setting') : t('默认设置', 'default setting');
  const permission = permissionName(status?.permission?.profile, t);
  const listSeparator = t('、', ', ');

  return <>
    <footer className="composer external-session-composer" aria-label={t('外控会话消息输入', 'External session message input')} data-testid="external-session-composer">
    <div className="external-session-composer-head">
      <strong>{t('外控会话', 'Externally controlled session')}</strong>
      <span>{t('此处消息将发送给外部 Agent', 'Messages here go to the external agent')}</span>
      {configurationFailed && <span className="external-session-config-error" role="status">{t('配置暂不可用', 'Configuration unavailable')}</span>}
    </div>
    <details className="external-session-config-details">
      <summary>{t('会话配置', 'Session configuration')} · {modelProvider === undefined ? modelName : `${modelProvider} · ${modelName}`} · {permission}</summary>
      <div className="external-session-config" aria-label={t('当前会话配置', 'Current session configuration')}>
        <span className="external-session-config-item"><b>{t('工具模式', 'Tool mode')}</b>{status?.mode ?? t('默认', 'Default')}</span>
        <span className="external-session-config-item"><b>Policy</b>{policy} · {policySource}</span>
        <span className="external-session-config-item"><b>{t('权限', 'Permission')}</b>{permission} · {networkName(status?.permission?.network, t)}</span>
        {status?.pendingModel !== null && status?.pendingModel !== undefined && <span className="external-session-config-item pending">
          <b>{t('下轮模型', 'Next-turn model')}</b>{status.pendingModel}
        </span>}
      </div>
    </details>
    {grant === null
      ? <div className="external-session-grant-unavailable">{status === null
          ? configurationFailed ? t('无法读取当前授权与会话配置。', 'Could not read the current grant and session configuration.')
            : t('正在读取授权与会话配置…', 'Loading grant and session configuration…')
          : t('当前会话没有可读取的 Grant 信息。', 'No Grant information is available for this session.')}</div>
      : <details className="external-session-grant">
          <summary>{t('Grant', 'Grant')} · {grant.name} · {grant.source === 'trusted-ui' ? t('可信界面', 'trusted UI') : t('旧版授权', 'legacy grant')}</summary>
          <div className="external-session-grant-body">
            <span><b>{t('授权 ID', 'Grant ID')}</b><code>{grant.grantId}</code></span>
            <span><b>{t('默认权限', 'Default permission')}</b>{permissionName(grant.defaultPermissionProfile, t)} · {networkName(grant.defaultNetwork, t)}</span>
            <span><b>{t('权限上限', 'Permission ceiling')}</b>{permissionName(grant.maxPermissionProfile, t)} · {networkName(grant.maxNetwork, t)}</span>
            <span><b>{t('默认 Policy', 'Default Policy')}</b>{policyName(grant.defaultPolicy, t)}</span>
            <span><b>{t('允许的 Policy', 'Allowed Policies')}</b>{grant.allowedPolicies.map((item) => policyName(item, t)).join(listSeparator)}</span>
            <span><b>{t('操作者可配置会话', 'Operator may configure')}</b>{grant.allowOperator ? t('允许', 'Allowed') : t('不允许', 'Not allowed')}</span>
            <span><b>{t('MCP 服务器', 'MCP servers')}</b>{grant.allowedMcpServers.length === 0 ? t('无额外服务器', 'No additional servers') : grant.allowedMcpServers.join(listSeparator)}</span>
            <span><b>{t('MCP 工具', 'MCP tools')}</b>{grant.allowedMcpTools.length === 0 ? t('无额外工具', 'No additional tools') : grant.allowedMcpTools.join(listSeparator)}</span>
          </div>
        </details>}
    <textarea
      className="composer-input"
      value={draft}
      rows={2}
      aria-label={t('发送消息到外控会话', 'Send a message to the external session')}
      placeholder={t('给外控 Agent 补充信息', 'Send guidance to the external agent')}
      onChange={(event) => onDraftChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        void send();
      }}
    />
    <div className="composer-bar external-session-composer-bar">
      <span className="external-session-route">{t('发送目标', 'Sending to')} · {grant?.name ?? t('外控 Agent', 'external agent')}</span>
      <span className="bar-spacer" />
      <button className="send" type="button" title={t('发送给外控 Agent', 'Send to the external agent')} aria-label={t('发送', 'Send')}
        disabled={busy || draft.trim() === ''} onClick={() => void send()}><Icon name="send" size={19} /></button>
    </div>
    {note !== null && <p className={note.bad ? 'external-session-note bad' : 'external-session-note'} role={note.bad ? 'alert' : 'status'}>{note.text}</p>}
    </footer>
    <div className="composer-hint"><span>{t('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line')}</span></div>
  </>;
}
