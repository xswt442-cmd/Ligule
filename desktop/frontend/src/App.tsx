import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DropdownMenu } from 'radix-ui';
import { type FlatIndexLocationWithAlign, type VirtuosoHandle } from 'react-virtuoso';
import { code, createClient, type Client, type Transport } from './protocol';
import { ApprovalCard, type Ask } from './components/ApprovalCard';
import { QuestionCard, type QuestionAsk, type QuestionDrafts } from './components/QuestionCard';
import { Icon } from './components/Icon';
import { SettingsDialog, type SettingsSectionId } from './components/Settings';
import { BranchPanel } from './components/BranchPanel';
import { HoldSheet } from './components/HoldSheet';
import { QuitSheet } from './components/QuitSheet';
import { holdReasons, report as reportEdit, type EditGate } from './edit-gate';
import { approvalSession, toApprovalAsk, type ApprovalRequestParams } from './approval-request';
import { reopenSessionWriter } from './session-reopen';
import { requestIsCurrent, type RequestIdentity } from './request-identity';
import { blockedSessions, type QuitInput, type QuitRow } from './quit';
import { SessionRail } from './components/SessionRail';
import type { SearchHit } from './components/rail/types';
import { createCallOf, type WorkspaceRoster } from './rail';
import { SessionActions } from './components/SessionActions';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ExportPanel } from './components/ExportPanel';
import { HelpPanel } from './components/HelpPanel';
import { UsageMeter } from './components/UsageMeter';
import { BrowserControl } from './components/BrowserControl';
import { TranscriptViewport, FIRST_INDEX, streamAnchor } from './components/TranscriptViewport';
import { Palette, type Command } from './components/Palette';
import { keepEscape } from './components/ui';
import { CURRENT, actionOf, formatKeys, isCapturing, isComposing, loadBindings, specOf } from './hotkeys';
import { insertMention, mentionToken } from './mentions';
import type { ModelSelection } from './model-catalog';
import { thinkingRequest } from './thinking-request';
import { createSlotRegistry, SLOTS, type Panel } from './slots';
import { appendProjectedRecords, changeBody, changeOf, metaRow, projectRecord, questionEcho, shownIn, type Record_, type Row } from './rows';
import { taskSummaryLabelOf, taskSummaryOf, type Status } from './status';
import { loadSettings, mergeQueueIntoDraft, readSettings, saveSettings, type Settings } from './settings';
import { LocaleProvider, localeOf } from './locale';
import { notificationOf, notificationTarget, type NotificationKind, type NotificationTarget } from './notifications';
import { SessionStreamBuffer } from './session-stream';
import { observeExternalSession } from './external-session-observation';
import { clearExternalSessionDraftIfCurrent, externalSessionDraftFor, externalSessionDraftRevisionFor, updateExternalSessionDrafts, type ExternalSessionDrafts } from './external-session-drafts';
import { Composer } from './components/Composer';
import { ExternalSessionComposer, ExternalSessionControlPanel } from './components/ExternalSessionControlPanel';
import type { MentionState } from './mentions';
import type { PermissionConfirmations, PermissionTarget } from './permission-control';

// 流式输出显示在已落盘记录之后，并保持固定 ID，避免每个增量都重建行并丢失展开状态。
const LIVE_REASONING: Row = { id: -2, kind: 'reasoning', text: '' };
const LIVE_ANSWER: Row = { id: -1, kind: 'answer', text: '' };
type PolicySelection = 'ask' | 'auto' | 'none';

// 每次向前读取一页事件；打开会话时先取最近页，再按游标读取更早记录。
const RENDER_WINDOW = 400;
type PanelProps = {
  client: Client;
  status: Status | null;
  sessionId: string | null;
  running: boolean;
  // 统计其他会话中正在运行的轮次，供顶栏显示后台活动状态。
  othersRunning: number;
  // 左侧栏按会话显示运行状态和未读完成状态。
  runningIds: string[];
  unread: string[];
  // 当前窗口额外显示的工作区保存在界面偏好中。
  projects: string[];
  onProjects: (roots: string[]) => void;
  // 当前会话所属项目决定模型配置和审批规则的读取与写入范围。
  projectRoot: string;
  // 在指定项目中创建会话；未指定时使用 Host 的默认项目。
  createIn: (root?: string) => void;
  // 当前设置页有未保存编辑时，关闭或切换前先请求用户确认。
  onEdit?: (reason: string) => void;
  seconds: number;
  waiting: number;
  counts: { sent: number; received: number };
  link: string | null;
  logs: string[];
  onReconnect: () => void;
  openSession: (id: string, projectRoot?: string) => void;
  // 搜索结果包含会话和事件序号；先打开会话，再定位到该事件。
  openHit: (hit: SearchHit, projectRoot?: string) => void;
  // 新建分支后递增此值，触发左侧栏重新加载会话列表。
  sessionsRevision: number;
  settings: Settings;
  patch: (part: Partial<Settings>) => void;
};

// 表示当前没有文本组合输入；有效光标位置不会是 -1。
const NO_TOKEN = { start: -1, text: '' };
const DEFAULT_NEW_SESSION_PERMISSION: PermissionTarget = { profile: 'read-only', network: 'policy' };
const NO_PERMISSION_CONFIRMATIONS: PermissionConfirmations = { fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false };

// 已打开的会话。右侧面板显示当前会话状态，不重复提供会话浮层已有的控制项。
/**
 * 返回持久工作区登记中的默认目录。未设置默认目录或读取失败时返回 undefined。
 * Desktop 不使用 Host 继承的进程当前目录作为工作区。
 */
async function defaultWorkspaceOf(client: Client): Promise<string | undefined> {
  const roster = await client.call('workspaces.list', {}, 15_000).catch(() => null) as WorkspaceRoster | null;
  return roster === null ? undefined : roster.workspaces.find((one) => one.identity === roster.default)?.directory;
}

/**
 * 首次启动时请 Electron 壳创建默认工作区并登记选择，以便后续启动和侧栏继续使用。
 * 获取目录、创建目录或写入登记失败时返回原因，不自动切换到其他目录。
 */
async function registerShellWorkspace(getDirectory: () => Promise<string>, client: Client): Promise<{ directory?: string; failed?: string }> {
  try {
    const directory = await getDirectory();
    await client.call('workspace.default.set', { directory }, 15_000);
    return { directory };
  } catch (error) {
    return { failed: String((error as { message?: unknown })?.message ?? error) };
  }
}

const menuPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.diagnostics',
    title: '诊断',
    view: ({ status, counts, waiting, link, logs, onReconnect }) => <DiagnosticsPanel status={status} counts={counts} waiting={waiting} link={link} logs={logs} onReconnect={onReconnect} />,
  },
  {
    id: 'panel.branch',
    title: '派生支线',
    view: ({ client, sessionId, settings }) => <BranchPanel client={client} sessionId={sessionId} verbosity={settings.verbosity} />,
  },
  {
    id: 'panel.export',
    title: '导出全文',
    view: ({ client, sessionId }) => <ExportPanel client={client} sessionId={sessionId} />,
  },
  {
    id: 'panel.help',
    title: '使用手册',
    // 直接显示随包的使用手册内容，不读取磁盘或请求网络；该面板与当前会话无关。
    view: () => <HelpPanel />,
  },
];

// 左侧栏从 `sessions.list` 读取会话，并通过已声明的界面槽位渲染。
const railPanels: Panel<PanelProps>[] = [
  {
    id: 'rail.sessions',
    title: '会话',
    view: ({ client, sessionId, openSession, openHit, sessionsRevision, runningIds, unread, projects, onProjects, createIn, settings, patch }) => (
      <SessionRail client={client} current={sessionId} onOpen={openSession} onOpenHit={openHit} revision={sessionsRevision} running={runningIds} unread={unread} projects={projects} hidden={settings.hiddenProjects} onHidden={(hiddenProjects) => patch({ hiddenProjects })} onProjects={onProjects} onCreate={createIn} />
    ),
  },
];

export function App({ transport }: { transport: Transport }) {
  const client = useMemo(() => createClient(transport), [transport]);
  const registry = useMemo(() => {
    const created = createSlotRegistry<PanelProps>(SLOTS);
    for (const panel of menuPanels) created.register('rail.menu', panel);
    for (const panel of railPanels) created.register('rail.sessions', panel);
    return created;
  }, []);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionLabel, setSessionLabel] = useState({ name: '', archived: false });
  const [starting, setStarting] = useState(false);
  const creating = useRef(false);
  const newParameters = useRef<ReturnType<typeof createCallOf>>({});
  const booted = useRef(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  // 按会话分别保存流式片段；切回后台会话时可先显示尚未落盘的输出。
  const liveStreamRef = useRef<SessionStreamBuffer | null>(null);
  if (liveStreamRef.current === null) liveStreamRef.current = new SessionStreamBuffer();
  const liveBySession = liveStreamRef.current;
  const acceptExternalDelta = useCallback((kind: 'text' | 'reasoning', text: string) => {
    const held = liveBySession.append(sessionId ?? '', kind, text);
    if (held !== null && sessionId !== null) setLive(held);
  }, [liveBySession, sessionId]);
  const settleExternalEvent = useCallback((kind: string) => {
    if (sessionId === null) return;
    const held = liveBySession.settle(sessionId, kind);
    setLive(held);
  }, [liveBySession, sessionId]);
  const terminalBySession = useRef(new Map<string, number>());
  // 同一会话的待答问题按顺序排队，一次显示一个。
  const [asks, setAsks] = useState<Ask[]>([]);
  // 保存每个会话剩余的待答问题数，供轮次结束处理使用；在渲染后同步以避免读取旧状态。
  const asksLeft = useRef<Ask[]>([]);
  useEffect(() => { asksLeft.current = asks; }, [asks]);
  // 提问和审批使用不同卡片与请求流程：审批决定是否允许操作，提问收集用户信息。
  const [queries, setQueries] = useState<QuestionAsk[]>([]);
  // 轮次结束时需要知道该会话剩余问题数和用户已输入的答案。
  const queriesLeft = useRef<QuestionAsk[]>([]);
  useEffect(() => { queriesLeft.current = queries; }, [queries]);
  // 暂存卡片中的答案；卡片关闭后将问题和答案写入转录，并禁止重复提交。
  const questionDrafts = useRef(new Map<string, QuestionDrafts>());
  const externalQuestionDrafts = useRef(new Map<string, Map<string, QuestionDrafts>>());
  // 会话不在前台时暂存其问题和答案，等重新打开该会话时再写入记录。
  const pendingEchoes = useRef(new Map<string, Array<{ zh: string; en: string }>>());
  const keepQuestionDraft = useCallback((id: string, drafts: QuestionDrafts) => { questionDrafts.current.set(id, drafts); }, []);
  const getExternalQuestionDraft = useCallback((owner: string, id: string) => externalQuestionDrafts.current.get(owner)?.get(id), []);
  const keepExternalQuestionDraft = useCallback((owner: string, id: string, drafts: QuestionDrafts | null) => {
    const sessionDrafts = externalQuestionDrafts.current.get(owner);
    if (drafts === null) {
      sessionDrafts?.delete(id);
      if (sessionDrafts?.size === 0) externalQuestionDrafts.current.delete(owner);
      return;
    }
    const nextSessionDrafts = sessionDrafts ?? new Map<string, QuestionDrafts>();
    nextSessionDrafts.set(id, drafts);
    if (sessionDrafts === undefined) externalQuestionDrafts.current.set(owner, nextSessionDrafts);
  }, []);
  // 每个会话独立维护运行状态、取消信号和输入队列。
  // 轮次完成状态只更新所属会话，切换前台会话不会改变其他会话的显示。
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const running = sessionId !== null && runningIds.includes(sessionId);
  const othersRunning = runningIds.filter((id) => id !== sessionId).length;
  // 保存各会话轮次的开始时间；顶栏只显示当前会话的运行时长。
  const roundStart = useRef(new Map<string, number>());
  const [tick, setTick] = useState(Date.now());
  const seconds = sessionId === null ? 0 : Math.max(0, Math.floor((tick - (roundStart.current.get(sessionId) ?? tick)) / 1000));
  // 后台会话结束时标记为有未读结果；用户切回该会话时清除标记。
  const [unread, setUnread] = useState<string[]>([]);
  // 记录允许继续发送队列的会话 ID；只在该会话自身结束或用户明确选择继续时设置。
  // 使用 ref 保存该控制标记，不额外触发界面渲染。
  const allowSend = useRef(new Set<string>());
  const [status, setStatus] = useState<Status | null>(null);
  const [taskSnapshotAt, setTaskSnapshotAt] = useState(Date.now());
  const [newSessionSettingsRevision, setNewSessionSettingsRevision] = useState(0);
  const [newSessionMode, setNewSessionMode] = useState<string | null>(null);
  const [newSessionPolicy, setNewSessionPolicy] = useState<PolicySelection | null>(null);
  const [newSessionPermission, setNewSessionPermission] = useState<PermissionTarget>(DEFAULT_NEW_SESSION_PERMISSION);
  const [newSessionPermissionConfirmations, setNewSessionPermissionConfirmations] = useState<PermissionConfirmations>(NO_PERMISSION_CONFIRMATIONS);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // `@` 路径候选由 Host 提供，前端不扫描项目目录。
  const [mention, setMention] = useState<MentionState | null>(null);
  // 按 Esc 暂时关闭当前候选；输入文本改变后重新查询相应候选。
  const [hiddenMention, setHiddenMention] = useState('');
  const mentionWanted = useRef(NO_TOKEN);
  const mentionAsked = useRef(NO_TOKEN);
  // 从会话记录首行读取草稿和队列所属的项目身份；保存失败时只提示一次。
  const [projectRoot, setProjectRoot] = useState('');
  // 当前草稿所属的会话。打开会话时，需等恢复请求完成后再保存草稿，避免把旧草稿写入新会话。
  const [inputOwner, setInputOwner] = useState<string | null>(null);
  const [readOnlySessionId, setReadOnlySessionId] = useState<string | null>(null);
  const [writerLockNoticeSessionId, setWriterLockNoticeSessionId] = useState<string | null>(null);
  const [sessionWriterActive, setSessionWriterActive] = useState(false);
  const [externalControlSessionId, setExternalControlSessionId] = useState<string | null>(null);
  const [externalSessionDrafts, setExternalSessionDrafts] = useState<ExternalSessionDrafts>(() => new Map());
  const saveWarned = useRef(false);
  // Host 重连期间暂停发送队列，也不触发轮次结束后的自动发送。
  const reconnecting = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel<PanelProps> | null>(null);
  // 右侧面板存在未保存编辑或进行中的写入时，关闭或切换前先确认。
  const [dockGate, setDockGate] = useState<EditGate>({});
  const [dockHold, setDockHold] = useState<{ reasons: string[]; go: () => void } | null>(null);
  const reportDock = useCallback((reason: string) => setDockGate((now) => reportEdit(now, 'dock', reason)), []);
  const leaveDock = useCallback((go: () => void) => {
    const reasons = holdReasons(dockGate);
    if (reasons.length === 0) go();
    else setDockHold({ reasons, go });
  }, [dockGate]);
  const [settings, setSettings] = useState(readSettings);
  const language = localeOf(settings.language);
  const t = useCallback((chinese: string, english: string) => language === 'zh' ? chinese : english, [language]);
  const progress = status?.progress ?? null;
  const observingExternalSession = sessionId !== null && readOnlySessionId === sessionId;
  const progressPhase = progress === null ? '' : {
    preparing: t('准备上下文', 'Preparing context'),
    model_request: t('请求模型', 'Requesting model'),
    tool_execution: t('执行工具', 'Running tools'),
    compaction: t('压缩上下文', 'Compacting context'),
    awaiting_approval: t('等待审批', 'Waiting for approval'),
    awaiting_input: t('等待用户输入', 'Waiting for your input'),
    settling: t('正在收尾', 'Finishing'),
  }[progress.phase];
  const progressIdleSeconds = progress === null ? 0 : Math.max(0, Math.floor((tick - progress.lastProgressAt) / 1000));
  const taskSummary = taskSummaryOf(status?.task, status?.taskLimits, progress, taskSnapshotAt, tick);
  const taskLabel = taskSummary !== null
    ? ` · ${taskSummaryLabelOf(taskSummary, language)}`
    : status?.running === true
      ? ` · ${t('Run 预算准备中', 'run budget initializing')}`
      : '';
  const fallbackCallsLabel = taskSummary === null
    ? ` · ${progress?.modelCalls ?? 0} ${t('次模型调用', 'model calls')}` : '';
  const progressLabel = `${progressPhase || t('运行中', 'Running')} · ${progressIdleSeconds}${t('秒无新进展', 's without progress')}${fallbackCallsLabel} · ${progress?.toolCalls ?? 0} ${t('个工具调用', 'tool calls')}${status?.outputTokens === null || status?.outputTokens === undefined ? '' : ` · ${status.outputTokens} ${t('个输出token', 'output tokens')}`}${taskLabel}`;
  const panelTitle = useCallback((item: Panel<PanelProps>) => {
    const titles: Record<string, [string, string]> = {
      'panel.diagnostics': ['诊断', 'Diagnostics'],
      'panel.branch': ['派生支线', 'Subtasks'],
      'panel.export': ['导出全文', 'Export transcript'],
      'panel.help': ['使用手册', 'User guide'],
      'rail.sessions': ['会话', 'Conversations'],
    };
    const title = titles[item.id];
    return title === undefined ? item.title : t(title[0], title[1]);
  }, [t]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelCatalogRevision, setModelCatalogRevision] = useState(0);
  const settingsEdits = useRef<string[]>([]);
  const reportSettingsEdits = useCallback((reasons: string[]) => { settingsEdits.current = reasons; }, []);
  const dockEdits = useRef<string[]>([]);
  dockEdits.current = holdReasons(dockGate);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  const openModelSettings = useCallback(() => { setSettingsSection('model'); setSettingsOpen(true); }, []);
  const openSecuritySettings = useCallback(() => { setSettingsSection('security'); setSettingsOpen(true); }, []);
  const [notificationProblem, setNotificationProblem] = useState<string | null>(null);
  const [diagnosticLogs, setDiagnosticLogs] = useState<string[]>([]);
  const [notificationDestination, setNotificationDestination] = useState<NotificationTarget | null>(null);
  const notificationSessions = useRef(new Map<string, { root: string; name: string }>());
  const notificationNow = useRef({ preferences: settings.notifications, language });
  notificationNow.current = { preferences: settings.notifications, language };
  const notificationReady = useRef<Promise<unknown>>(Promise.resolve());
  const notify = useCallback((kind: NotificationKind, own?: string, root = '') => {
    const bridge = transport.notifications;
    const { preferences, language: currentLanguage } = notificationNow.current;
    if (bridge === undefined || !preferences.enabled || !preferences[kind]) return;
    const known = own === undefined ? undefined : notificationSessions.current.get(own);
    const target = own === undefined ? undefined : { sessionId: own, projectRoot: known?.root ?? root };
    void notificationReady.current.then(async () => {
      if (!await bridge.permission()) throw new Error('notification_permission_not_granted');
      const latest = notificationNow.current.preferences;
      if (!latest.enabled || !latest[kind]) return;
      await bridge.show(notificationOf(kind, currentLanguage, target, known?.name ?? ''));
    }).catch(error => setNotificationProblem(code(error)));
  }, [transport]);
  // 仅当退出会影响活动会话时显示确认对话框。
  const [quitRows, setQuitRows] = useState<QuitRow[]>([]);
  const [quitHold, setQuitHold] = useState<string[] | null>(null);
  const quitting = useRef(false);
  const [closing, setClosing] = useState(false);
  // 当前会话的模式和策略面板由顶栏对应按钮打开。
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const verbosity = settings.verbosity;
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const collapsed = settings.collapsed || (narrow && !mobileSidebar);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const change = () => { setNarrow(media.matches); setMobileSidebar(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  // 输入历史由 Host 在共享文件中维护；界面使用 `-1` 表示当前未发送草稿。
  const [history, setHistory] = useState<string[]>([]);
  const [walk, setWalk] = useState(-1);
  // 运行期间的新输入按会话保存在前端队列中；取消后暂停，等待用户明确继续。
  const [queues, setQueues] = useState<Record<string, { items: string[]; paused: boolean }>>({});
  const queue = readOnlySessionId === sessionId ? { items: [] as string[], paused: false }
    : queues[sessionId ?? ''] ?? { items: [] as string[], paused: false };
  const patchQueue = useCallback((own: string, next: (current: { items: string[]; paused: boolean }) => { items: string[]; paused: boolean }) => {
    setQueues((current) => ({ ...current, [own]: next(current[own] ?? { items: [], paused: false }) }));
  }, []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // 当前前台会话 ID，与会话打开状态同步更新；后台会话的响应不得覆盖前台状态。
  const active = useRef<string | null>(null);
  const updateExternalControlAvailability = useCallback((owner: string, available: boolean) => {
    if (active.current !== owner) return;
    setExternalControlSessionId(available ? owner : null);
  }, []);
  // 阅读位置在底部时自动跟随新内容；用户向上滚动后暂停跟随，并显示返回最新内容的按钮。
  const list = useRef<VirtuosoHandle | null>(null);
  const [pinned, setPinned] = useState(true);
  // 只有用户滚动会改变跟随状态；布局测量和程序定位不视为用户滚动。
  const readerScrolling = useRef(false);
  // `before` 保存当前最早事件的序号，`hasMore` 表示 Host 是否还有更早记录。
  // 前端只保留已加载页面，完整记录由 Host 持有。
  const [page, setPage] = useState<{ before: number; hasMore: boolean } | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [firstIndex, setFirstIndex] = useState(FIRST_INDEX);
  const prependAnchor = useRef<{ id: number; offset: number; request: number } | null>(null);
  const renderedStream = useRef({ rows: [] as Row[], firstIndex: FIRST_INDEX, verbosity });
  // 当前跳转目标，来源可以是搜索结果或恢复的阅读位置。
  const [wanted, setWanted] = useState<{ sessionId: string; seq: number; kind: string } | null>(null);
  const [stamp, setStamp] = useState(0);
  const [initialIndex, setInitialIndex] = useState<FlatIndexLocationWithAlign>({ index: 'LAST', align: 'end' });
  // 分支创建成功后触发左侧栏重新加载会话列表。
  const [sessionsRevision, setSessionsRevision] = useState(0);
  // 按会话保存最上方可见事件序号；切回时仅在该记录已加载的页面范围内恢复位置。
  const anchors = useRef(new Map<string, number>());
  // 标记当前读取请求所属会话，切换会话后丢弃过期响应。
  const opening = useRef<string | null>(null);
  // 每次打开会话都生成新的请求编号，避免 A→B→A 时旧请求释放新请求的输入保护。
  const openRequest = useRef(0);
  const renderedSessionRequest: RequestIdentity = { scope: sessionId, generation: openRequest.current };
  // 短暂高亮定位目标，帮助用户在长转录中确认跳转位置。
  const [flash, setFlash] = useState<number | null>(null);
  // 按调用 ID 记录派发时间，用于计算工具运行耗时。
  const dispatchAt = useRef(new Map<string, number>());
  // 记录 Host 连接状态；null 表示连接正常，其他值是 Host 返回的错误信息。
  const [link, setLink] = useState<string | null>(null);
  const connectionLost = useRef(false);

  // 窗口打开和 Host 重启时读取共享输入历史。读取失败时按空列表显示；写入由 Host 在锁内合并，避免覆盖其他客户端的更新。
  useEffect(() => {
    client.call('history.read', {}, 60_000).then(
      (read) => setHistory((read as { entries: string[] }).entries),
      () => setHistory([]),
    );
  }, [client]);

  // 桌面偏好以应用数据根中的文档为准，打开窗口时从 Host 读取。
  // 只有该文档不存在且 WebView 缓存仍有内容时，才将缓存迁入数据根。
  // 读取完成前不保存默认值，避免覆盖已有草稿或队列。
  const prefsSettled = useRef<Promise<void>>(Promise.resolve());
  const [settingsReady, setSettingsReady] = useState(false);
  const unsavedInputs = useRef(new Map<string, { root: string; id: string; draft?: string; items?: string[] }>());
  const [prefsFailure, setPrefsFailure] = useState<string | null>(null);
  const [prefsDetails, setPrefsDetails] = useState('');
  const [prefsRevision, setPrefsRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setSettingsReady(false);
    setPrefsFailure(null);
    setPrefsDetails('');
    const settled = loadSettings(client).then(
      (adopted) => {
        if (!live) return;
        setSettings(adopted);
        saveWarned.current = false;
        setSettingsReady(true);
      },
      (error) => {
        if (live) {
          setPrefsFailure(code(error));
          setPrefsDetails(error instanceof Error ? error.message : String(error));
        }
        throw error;
      },
    );
    // 读取失败显示在横幅中；会话恢复也等待此结果，避免用缓存覆盖正式偏好。
    void settled.catch(() => undefined);
    prefsSettled.current = settled;
    return () => {
      live = false;
    };
  }, [client, prefsRevision]);

  // 每秒更新当前会话的运行时长。
  useEffect(() => {
    if (runningIds.length === 0) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningIds]);

  // 每三秒通过只读状态请求检查连接；请求失败时由界面发起一次重连。
  // Host 进程的启动和重启由 Electron 壳负责。
  const beat = useCallback(async (timeoutMs = 5_000) => {
    if (sessionId === null) return;
    const request: RequestIdentity = { scope: sessionId, generation: openRequest.current };
    const isCurrent = () => requestIsCurrent(request, active.current, openRequest.current);
    try {
      if (readOnlySessionId === sessionId) {
        await client.call('session.observe', { projectRoot, sessionId, limit: 1 }, timeoutMs);
      } else await client.call('status.get', { sessionId }, timeoutMs);
      if (!isCurrent()) return;
      connectionLost.current = false;
      setLink(null);
    } catch (error) {
      if (!isCurrent()) return;
      if (!connectionLost.current) notify('disconnected');
      connectionLost.current = true;
      setLink(code(error));
    }
  }, [client, notify, projectRoot, readOnlySessionId, sessionId]);

  useEffect(() => {
    const removeFault = transport.onFault?.((reason) => {
      setLink(reason);
      if (!connectionLost.current) notify('disconnected');
      connectionLost.current = true;
    });
    const timer = sessionId === null ? undefined : setInterval(() => void beat(), 3_000);
    return () => { if (timer !== undefined) clearInterval(timer); if (typeof removeFault === 'function') removeFault(); };
  }, [beat, notify, sessionId, transport]);

  const jumpToLatest = useCallback(() => {
    readerScrolling.current = false;
    list.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
    setPinned(true);
  }, []);

  // 更早的记录由 Host 分页读取；游标采用当前页最早事件的稳定序号。
  const showEarlier = useCallback(async () => {
    if (sessionId === null || page === null || !page.hasMore || olderLoading) return;
    const request = openRequest.current;
    let restoring = false;
    readerScrolling.current = false;
    setPinned(false);
    setOlderLoading(true);
    try {
      const observing = readOnlySessionId === sessionId;
      const older = await client.call(observing ? 'session.observe' : 'session.read', {
        ...(observing ? { projectRoot } : {}),
        sessionId, before: page.before, limit: RENDER_WINDOW, fullResults: true,
      }, 15_000) as { events: Record_[]; hasMore: boolean };
      // 用户已切换会话时忽略过期响应，不更改新会话的列表和游标。
      if (opening.current !== sessionId || openRequest.current !== request) return;
      const added = older.events.flatMap((record) => projectRecord(record));
      const rendered = renderedStream.current;
      const addedShown = added.filter((row) => shownIn(rendered.verbosity, row)).length;
      const anchor = addedShown === 0 ? null : streamAnchor(rendered.rows, rendered.firstIndex);
      prependAnchor.current = anchor === null ? null : { ...anchor, request };
      restoring = anchor !== null;
      // 前插一页时按实际加入 `visible` 的行数调整全局起始索引，保持视口锚点不变。
      setFirstIndex((current) => current - addedShown);
      setRows((current) => [...added, ...current]);
      setPage({ before: older.events.length === 0 ? page.before : Number(older.events[0]?.seq), hasMore: older.hasMore });
    } catch (error) {
      if (openRequest.current === request) setRows((current) => [...current, metaRow('error', `无法读取更早的记录：${code(error)}`, `Could not load earlier records: ${code(error)}`)]);
    } finally {
      if (!restoring && openRequest.current === request) setOlderLoading(false);
    }
  }, [client, olderLoading, page, projectRoot, readOnlySessionId, sessionId]);

  // 草稿和队列按项目与会话保存到 Host 管理的偏好文档；WebView 存储只用于首屏缓存。
  // 切换会话、打开设置、查看历史或断连时保留输入。保存失败时明确提示用户。
  const persistInputs = useCallback(async () => {
    if (!settingsReady) throw Object.assign(new Error('prefs_reload_required'), { code: 'prefs_reload_required' });
    const stored = readSettings();
    const draftId = sessionId ?? '$new';
    const remember = (root: string, id: string, value: { draft?: string; items?: string[] }) => {
      const key = JSON.stringify([root, id]);
      unsavedInputs.current.set(key, { ...unsavedInputs.current.get(key), root, id, ...value });
    };
    if (inputOwner === sessionId) remember(projectRoot, draftId, { draft });
    for (const [id, queue] of Object.entries(queues)) {
      const root = notificationSessions.current.get(id)?.root;
      if (root !== undefined) remember(root, id, { items: queue.items });
    }
    // 重新读取会替换缓存；读取失败时保留内存中其他会话尚未保存的输入。
    const pending = new Map(unsavedInputs.current);
    // 草稿为空且队列已发完时删除该会话的偏好条目。
    const put = <T extends { length: number }>(table: Record<string, Record<string, T>>, root: string, id: string, value: T): Record<string, Record<string, T>> => {
      const row = { ...(table[root] ?? {}) };
      if (value.length === 0) delete row[id];
      else row[id] = value;
      const next = { ...table };
      if (Object.keys(row).length === 0) delete next[root];
      else next[root] = row;
      return next;
    };
    let drafts = stored.drafts;
    let queued = stored.queued;
    for (const input of pending.values()) {
      if (input.draft !== undefined) drafts = put(drafts, input.root, input.id, input.draft);
      if (input.items !== undefined) queued = put(queued, input.root, input.id, input.items);
    }
    await saveSettings(client, { ...settings, drafts, queued });
    for (const [key, input] of pending) {
      if (unsavedInputs.current.get(key) === input) unsavedInputs.current.delete(key);
    }
  }, [client, draft, inputOwner, projectRoot, queues, sessionId, settings, settingsReady]);

  useEffect(() => {
    if (!settingsReady || inputOwner !== sessionId || quitting.current) return;
    void persistInputs().catch((error) => {
      setSettingsReady(false);
      setPrefsFailure(code(error));
      setPrefsDetails(error instanceof Error ? error.message : String(error));
      if (saveWarned.current) return;
      saveWarned.current = true;
      setRows((current) => [...current, metaRow('error', '草稿未能保存。请重试，或先复制内容。', 'Could not save the draft. Try again or copy its contents first.')]);
    });
  }, [inputOwner, persistInputs, sessionId, settingsReady]);

  // 将配色、字号和侧栏宽度写入根元素的 CSS 变量。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.palette = settings.palette;
    root.style.setProperty('--sidebar', `${settings.sidebar}px`);
    root.style.setProperty('--ui-font-size', `${settings.fontUi}px`);
    root.style.setProperty('--user-message-font-size', `${settings.fontUser}px`);
    root.style.setProperty('--assistant-message-font-size', `${settings.fontAssistant}px`);
    root.style.setProperty('--transcript-line-height', String(settings.transcriptLineHeight));
  }, [settings.fontAssistant, settings.fontUi, settings.fontUser, settings.palette, settings.sidebar, settings.transcriptLineHeight]);

  const patch = useCallback((part: Partial<Settings>) => {
    if (part.collapsed !== undefined) setMobileSidebar(!part.collapsed);
    setSettings((current) => ({ ...current, ...part }));
  }, []);

  // 从偏好读取键位覆盖；先恢复默认，再应用有效覆盖，并报告无效项。
  const [keyNotice, setKeyNotice] = useState('');
  useEffect(() => {
    const outcome = loadBindings(settings.keys);
    setKeyNotice(outcome.refused.length === 0 ? ''
      : t(`${outcome.refused.length} 条快捷键无效，已使用默认键：${outcome.refused.join('、')}`, `${outcome.refused.length} invalid shortcuts use their defaults: ${outcome.refused.join(', ')}`));
  }, [settings.keys, t]);

  // 拖动分隔线调整侧栏宽度，范围与设置面板的滑杆一致。
  // 捕获指针后，即使光标移到转录区或侧栏外，拖动事件仍会送到此处。
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = settings.sidebar;
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch { /* 抓不住时窗口上那三条监听照样把移动与松开送到这一处 */ }
    const move = (moveEvent: PointerEvent) => {
      patch({ sidebar: Math.min(420, Math.max(264, startWidth + moveEvent.clientX - startX)) });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      try { target.releasePointerCapture(event.pointerId); } catch { /* 已经松开 */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [patch, settings.sidebar]);

  useEffect(() => {
    const stopNotifications = client.onNotification((message) => {
      if (message.notify === 'fault') {
        setRows((current) => [...current, metaRow('error', `连接错误：${message.code} ${message.detail ?? ''}`, `Connection error: ${message.code} ${message.detail ?? ''}`)]);
        return;
      }
      // 按会话保存流式片段，后台会话继续输出时也能在切回后立即显示已收到内容。
      const owner = message.sessionId ?? '';
      const inView = owner === active.current;
      if (message.notify === 'progress') {
        if (inView) {
          const progress = message.progress === null || message.progress === undefined
            ? null
            : message.progress as Status['progress'];
          setStatus((current) => current === null ? current : {
            ...current,
            running: progress !== null,
            progress,
            ...(progress?.task === undefined ? {} : { task: progress.task }),
          });
          if (progress?.task !== undefined) setTaskSnapshotAt(Date.now());
        }
        return;
      }
      if (message.notify === 'delta') {
        const event = message.event as { type?: string; text?: string } | undefined;
        const held = liveBySession.append(owner, event?.type ?? '', event?.text ?? '');
        if (held === null) return;
        if (inView) setLive(held);
        return;
      }
      if (message.notify === 'event') {
        const record = message.event as Record_;
        if (record?.kind === 'turn') {
          const previous = terminalBySession.current.get(owner);
          terminalBySession.current.set(owner, record.seq ?? -1);
          if (previous !== record.seq) {
            if (record.status === 'completed') notify('completed', owner);
            else if (record.status === 'failed' || record.status === 'interrupted') notify('failed', owner);
          }
        }
        // 记录事件写入后，以持久事件替换对应会话的流式片段。
        const held = liveBySession.settle(owner, record?.kind ?? '');
        if (inView) setLive(held);
        if (!inView) return;
        if (record?.kind === 'assistant') {
          for (const call of record.toolCalls ?? []) dispatchAt.current.set(call.id, Date.now());
        }
        // 事件不保存逐条计时；运行时长由界面在轮次进行期间测量。
        const started = record?.kind === 'tool' && record.callId !== undefined ? dispatchAt.current.get(record.callId) : undefined;
        if (started !== undefined && record?.callId !== undefined) dispatchAt.current.delete(record.callId);
        const added = projectRecord(record, started === undefined ? {} : { startedAt: started });
        if (added.length > 0) setRows((current) => [...current, ...added]);
      }
    });

    const stopRequests = client.onRequest((message) => {
      // 用户提问一次可以包含多道题，答复按题目编号关联；此流程与审批分开处理。
      if (message.method === 'question.request') {
        const asked = message.params as { sessionId?: string; projectRoot?: string; questions?: QuestionAsk['questions'] };
        const owner = asked.sessionId;
        const items = asked.questions;
        if (typeof owner !== 'string' || owner === '' || !Array.isArray(items)) return;
        const id = message.id ?? '';
        if (!queriesLeft.current.some(one => one.id === id)) notify('question', owner, asked.projectRoot ?? '');
        // 同一个请求编号只保留一张卡，且只能答复一次。
        setQueries((current) => current.some((one) => one.id === id) ? current : [...current, { id, sessionId: owner, project: asked.projectRoot ?? '', questions: items }]);
        return;
      }
      // Host 发出的交互请求分为审批和用户提问。
      if (message.method !== 'approval.request') return;
      const params = message.params as ApprovalRequestParams | undefined;
      // 请求属于发起它的会话；即使会话在后台等待，也必须显示并允许答复。
      const asked = approvalSession(params);
      if (asked === null || params === undefined) return;
      notify('approval', asked, params.projectRoot ?? '');
      const ask = toApprovalAsk(message.id ?? '', params);
      setAsks((current) => [...current, ask]);
    });

    // 显示 Host 进程的标准错误输出；它不属于协议帧。
    transport.onLog((line) => setDiagnosticLogs((current) => [...current, line].slice(-50)));
    return () => {
      stopNotifications();
      stopRequests();
    };
  }, [client, notify, transport]);

  const refreshStatus = useCallback(async (id: string) => {
    const request: RequestIdentity = { scope: id, generation: openRequest.current };
    const isCurrent = () => requestIsCurrent(request, active.current, openRequest.current);
    try {
      const next = await client.call('status.get', { sessionId: id }) as Status;
      // 用户已切换会话时，不将该请求的响应写入当前会话状态。
      if (!isCurrent()) return;
      setStatus(next);
      setTaskSnapshotAt(Date.now());
    } catch (error) {
      if (isCurrent()) setRows((current) => [...current, metaRow('error', `无法读取状态：${code(error)}`, `Could not load status: ${code(error)}`)]);
    }
  }, [client]);

  // 待答请求保留在所属会话中，切换前台会话时不清除。
  // 只有该会话轮次结束、取消或 Host 重启时才清理请求。
  const dropAsksOf = useCallback((id: string) => setAsks((current) => current.filter((ask) => ask.sessionId !== id)), [setAsks]);

  // 会话轮次结束、取消或 Host 重启后，未答问题不再等待响应。
  // 移除卡片前将题目和已输入内容写入记录，避免丢失用户输入。
  const dropQueriesOf = useCallback((id: string, reason: string) => {
    const left = queriesLeft.current.filter((one) => one.sessionId === id);
    if (left.length === 0) return;
    const lines = left.map((one) => {
      const drafts = questionDrafts.current.get(one.id);
      const reasonEnglish = reason === '宿主换了一具' ? 'The host restarted' : 'The turn ended';
      return {
        zh: `${questionEcho(one, drafts)}（${reason}，问题已结束）`,
        en: `${questionEcho(one, drafts, 'en')} (${reasonEnglish}; the question is closed)`,
      };
    });
    // 在后台结束的会话将完成提示暂存到自身状态，切回时再显示。
    if (active.current === id) setRows((current) => [...current, metaRow('meta', lines.map((line) => line.zh).join('\n'), lines.map((line) => line.en).join('\n'))]);
    else pendingEchoes.current.set(id, [...(pendingEchoes.current.get(id) ?? []), ...lines]);
    for (const one of left) questionDrafts.current.delete(one.id);
    setQueries((current) => current.filter((one) => one.sessionId !== id));
  }, [setQueries]);

  // 切换会话时先通过 Host 打开记录；已打开的会话复用现有状态。
  // 指定搜索结果时一并读取到目标事件，并同时更新定位目标，避免列表扩展后视口短暂滚到末尾。
  // Host 重启后将暂停队列按顺序移回草稿，等待用户明确发送；普通切换会话时队列仍保持暂停。
  const openSession = useCallback(async (id: string, hit?: SearchHit, reclaimQueue = false, askedRoot?: string) => {
    const savedAnchor = anchors.current.get(id);
    opening.current = id;
    const request = ++openRequest.current;
    // 同步更新前台会话和打开状态，再读取会话状态，避免渲染提交后将有效响应误判为过期。
    active.current = id;
    setSessionId(id);
    // 会话进入前台后清除其未读完成标记。
    setUnread((current) => current.filter((item) => item !== id));
    setMobileSidebar(false);
    setRows([]);
    setPage(null);
    setOlderLoading(false);
    prependAnchor.current = null;
    setFirstIndex(FIRST_INDEX);
    setInitialIndex({ index: 'LAST', align: 'end' });
    readerScrolling.current = false;
    setPinned(true);
    // 切回会话时立即显示其尚未落盘的流式输出，避免正在运行的轮次暂时显示为空。
    setLive(liveBySession.read(id));
    setWanted(null);
    setInputOwner(null);
    setReadOnlySessionId(null);
    setSessionWriterActive(false);
    setExternalControlSessionId(null);
    setStatus(null);
    dispatchAt.current.clear();
    setReading(true);
    let observing = false;
    let writerLockHeld = false;
    let newest: {
      events: Record_[];
      hasMore: boolean;
      header: { projectRoot?: string } | null;
      label: { name: string; archived: boolean };
      writerActive?: boolean;
    };
    const requestedRoot = askedRoot === undefined || askedRoot === '' ? projectRoot : askedRoot;
    try {
      // 为记录读取设置超时，避免客户端一直停留在加载状态。
      // 指定项目时同时传递项目根目录，由 Host 选择对应环境并验证记录归属。
      try {
        await client.call('session.open', requestedRoot === '' ? { sessionId: id } : { sessionId: id, projectRoot: requestedRoot }, 60_000);
        // 请求完整工具结果以读取溢出文件内容；只读取最近一页，更早记录由分页操作加载。
        newest = await client.call('session.read', { sessionId: id, limit: RENDER_WINDOW, fullResults: true }, 60_000) as typeof newest;
      } catch (error) {
        if (code(error) !== 'session_locked') throw error;
        writerLockHeld = true;
        newest = await client.call('session.observe', {
          projectRoot: requestedRoot, sessionId: id, limit: RENDER_WINDOW, fullResults: true,
        }, 60_000) as typeof newest;
        observing = true;
      }
      if (openRequest.current !== request) return;
      // 打开会话时恢复其草稿和暂停队列。
      const root = newest.header?.projectRoot ?? '';
      notificationSessions.current.set(id, { root, name: newest.label.name });
      setSessionLabel(newest.label);
      setProjectRoot(root);
      // 等 Host 读取偏好完成后再恢复草稿和队列，避免使用过期缓存。
      await prefsSettled.current;
      if (openRequest.current !== request) return;
      const stored = readSettings();
      const unsaved = unsavedInputs.current.get(JSON.stringify([root, id]));
      const storedDraft = unsaved?.draft ?? stored.drafts[root]?.[id] ?? '';
      const restored = unsaved?.items ?? stored.queued[root]?.[id] ?? [];
      if (observing) {
        setDraft('');
      } else if (reclaimQueue && restored.length > 0) {
        // 重连后将队列按顺序移回草稿并清空队列，不自动发送任何内容。
        setDraft(mergeQueueIntoDraft(storedDraft, restored));
        patchQueue(id, () => ({ items: [], paused: false }));
      } else {
        setDraft(storedDraft);
        patchQueue(id, () => ({ items: restored, paused: restored.length > 0 }));
      }
      setReadOnlySessionId(observing ? id : null);
      setSessionWriterActive(observing && newest.writerActive === true);
      setInputOwner(observing ? null : id);
      setSettings((current) => ({ ...current, lastSession: { id, projectRoot: root } }));
      let events = newest.events;
      let hasMore = newest.hasMore;
      while (hit !== undefined && hit.seq < Number(events[0]?.seq ?? 0) && hasMore) {
        const older = await client.call(observing ? 'session.observe' : 'session.read', {
          ...(observing ? { projectRoot: root } : {}),
          sessionId: id, before: Number(events[0]?.seq), limit: RENDER_WINDOW, fullResults: true,
        }, 15_000) as { events: Record_[]; hasMore: boolean };
        // 用户已切换会话时忽略过期响应，不更新当前页面。
        if (openRequest.current !== request) return;
        if (older.events.length === 0) { hasMore = false; break; }
        events = [...older.events, ...events];
        hasMore = older.hasMore;
      }
      if (openRequest.current !== request) return;
      setWriterLockNoticeSessionId(writerLockHeld && reclaimQueue ? id : null);
      // 将后台会话中已关闭问题卡片的题目和答案写入该会话记录。
      const kept = pendingEchoes.current.get(id) ?? [];
      pendingEchoes.current.delete(id);
      setRows([
        ...events.flatMap((record) => projectRecord(record)),
        ...kept.map((line) => metaRow('meta', line.zh, line.en)),
      ]);
      connectionLost.current = false;
      setLink(null);
      setPage({ before: Number(events[0]?.seq ?? 1), hasMore });
      // 如果保存的阅读位置仍在已加载页面中就恢复该位置；否则停在末尾，不改变展示档或自动加载更多页面。
      const back = savedAnchor !== undefined && savedAnchor > Number(events[0]?.seq) && savedAnchor < Number(events.at(-1)?.seq)
        ? { sessionId: id, seq: savedAnchor, kind: 'anchor' }
        : null;
      setWanted(hit ?? back);
    } catch (error) {
      // 忽略旧请求的失败，避免将过期错误显示在当前会话中。
      if (openRequest.current === request) setRows((current) => [...current, metaRow('error', `无法打开会话：${code(error)}`, `Could not open conversation: ${code(error)}`)]);
      return false;
    } finally {
      // 只有当前打开请求完成后才解除输入保护，避免旧请求提前解锁新请求。
      if (openRequest.current === request) setReading(false);
    }
    if (openRequest.current !== request) return;
    if (!observing) void refreshStatus(id);
    return true;
  }, [client, projectRoot, refreshStatus]);

  useEffect(() => {
    if (sessionId === null || readOnlySessionId !== sessionId) return;
    const request = openRequest.current;
    return observeExternalSession({
      client,
      projectRoot,
      sessionId,
      limit: RENDER_WINDOW,
      isCurrent: () => openRequest.current === request && active.current === sessionId,
      onSnapshot: (snapshot) => {
        setSessionWriterActive(snapshot.writerActive);
        if (!snapshot.writerActive) setExternalControlSessionId(null);
        setRows((current) => appendProjectedRecords(current, snapshot.events));
      },
    });
  }, [client, projectRoot, readOnlySessionId, sessionId]);

  useEffect(() => {
    const bridge = transport.notifications;
    if (bridge === undefined) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const ready = bridge.onOpen(value => {
      try { setNotificationDestination(notificationTarget(value)); }
      catch { setNotificationProblem('notification_target_invalid'); }
    });
    notificationReady.current = ready;
    void ready.then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => setNotificationProblem('notification_listener_unavailable'));
    return () => { disposed = true; stop?.(); };
  }, [transport]);

  useEffect(() => {
    if (notificationDestination === null || settingsOpen) return;
    const target = notificationDestination;
    setNotificationDestination(null);
    leaveDock(() => {
      setPanel(null);
      setPaletteOpen(false);
      void openSession(target.sessionId, undefined, false, target.projectRoot);
    });
  }, [leaveDock, notificationDestination, openSession, settingsOpen]);

  useEffect(() => {
    const waiting = asks.length + queries.length;
    const label = t(`ligule · ${waiting} 项待处理 · ${runningIds.length} 个运行中`, `ligule · ${waiting} awaiting input · ${runningIds.length} running`);
    void transport.notifications?.updateTray(label, waiting > 0, language).catch(error => {
      setDiagnosticLogs((current) => [...current, `Tray status update failed: ${code(error)}`].slice(-50));
    });
  }, [asks.length, language, queries.length, runningIds.length, t, transport]);

  const newSession = useCallback(async (root?: string) => {
    const request = ++openRequest.current;
    setNewSessionSettingsRevision((revision) => revision + 1);
    setSessionMenuOpen(false);
    prependAnchor.current = null;
    setOlderLoading(false);
    setInitialIndex({ index: 'LAST', align: 'end' });
    readerScrolling.current = false;
    setPinned(true);
    setReading(true);
    try {
      // 优先使用明确选择的工作区；否则沿用当前会话的项目，再使用登记的默认工作区。
      // 尚无默认工作区时请 Electron 壳创建并登记一个，同时记录选择来源。
      const named = root === undefined || root === '' ? undefined : root;
      const current = undefined;
      let landing: string | undefined;
      let refused: string | undefined;
      if (named === undefined && current === undefined) {
        landing = await defaultWorkspaceOf(client);
        if (landing === undefined && transport.defaultWorkspace !== undefined) {
          const fromShell = await registerShellWorkspace(transport.defaultWorkspace, client);
          landing = fromShell.directory;
          refused = fromShell.failed;
        }
      }
      if (named === undefined && current === undefined && landing === undefined && transport.defaultWorkspace !== undefined) {
        throw Object.assign(new Error(refused ?? 'workspace_unavailable'), { code: 'workspace_unavailable' });
      }
      const params = createCallOf(named, current, landing);
      await prefsSettled.current;
      if (openRequest.current !== request) return false;
      newParameters.current = params;
      setNewSessionMode(null);
      setNewSessionPolicy(null);
      setNewSessionPermission(DEFAULT_NEW_SESSION_PERMISSION);
      setNewSessionPermissionConfirmations(NO_PERMISSION_CONFIRMATIONS);
      opening.current = null;
      active.current = null;
      setMobileSidebar(false);
      setSessionId(null);
      setSessionLabel({ name: '', archived: false });
      setInputOwner(null);
      setProjectRoot(params.projectRoot ?? '');
      setRows([]);
      setStatus(null);
      setLive({ text: '', reasoning: '' });
      setPage(null);
      setWanted(null);
      setDraft(unsavedInputs.current.get(JSON.stringify([params.projectRoot ?? '', '$new']))?.draft
        ?? readSettings().drafts[params.projectRoot ?? '']?.$new ?? '');
      setWalk(-1);
      setSettings((current) => ({ ...current, lastSession: null }));
      composerRef.current?.focus();
      return true;
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `无法新建会话：${code(error)}`, `Could not create a conversation: ${code(error)}`)]);
      return false;
    } finally {
      if (openRequest.current === request) setReading(false);
    }
  }, [client, transport]);

  useEffect(() => {
    if (!settingsReady || booted.current) return;
    booted.current = true;
    const last = settings.lastSession;
    if (last !== null) void openSession(last.id, undefined, false, last.projectRoot);
    else void newSession();
  }, [settingsReady, settings.lastSession, newSession, openSession]);

  // 搜索命中交给会话打开流程处理，使读取到目标记录与定位操作同步完成。
  const openHit = useCallback((hit: SearchHit, root?: string) => void openSession(hit.sessionId, hit, false, root), [openSession]);

  // 从当前位置或指定轮次创建分支；省略 `at` 时复制当前完整记录。父会话保持不变。
  const branchFrom = useCallback(async (at?: number) => {
    if (sessionId === null) return;
    try {
      const branched = await client.call('session.branch', { sessionId, ...(at === undefined ? {} : { at }) }, 15_000) as { sessionId: string; at: number };
      await openSession(branched.sessionId);
      setSessionsRevision((current) => current + 1);
      setRows((current) => [...current, metaRow('meta', `已从第 ${branched.at} 条创建分支 ${branched.sessionId.slice(0, 8)}。`, `Created branch ${branched.sessionId.slice(0, 8)} through event ${branched.at}.`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `创建分支失败：${code(error)}`, `Could not create branch: ${code(error)}`)]);
    }
  }, [client, openSession, sessionId]);

  // 重连时将旧请求以稳定错误码结束并清除待答请求，然后让 Electron 壳重启 Host。
  // 新 Host 通过 `session.open` 恢复当前会话，并将暂停队列移回草稿，不自动发送。
  const reconnect = useCallback(async () => {
    if (reconnecting.current) return;
    const request: RequestIdentity = { scope: sessionId, generation: openRequest.current };
    const isCurrent = () => requestIsCurrent(request, active.current, openRequest.current);
    reconnecting.current = true;
    client.discard('host_restarted');
    setAsks([]);
    // Host 重启后旧请求编号失效；将未完成的问题和已输入答案写入记录，不自动提交给新 Host。
    for (const owner of new Set(queriesLeft.current.map((one) => one.sessionId))) dropQueriesOf(owner, '宿主换了一具');
    setRunningIds([]);
    try {
      try {
        await transport.restart?.();
      } catch (error) {
        if (isCurrent()) setRows((current) => [...current, metaRow('error', `无法启动后端：${code(error)}`, `Could not start the host: ${code(error)}`)]);
        return;
      }
      // Host restart invalidates an in-flight preference write. Reload its version and saved values
      // before restoring the Session so a failed write does not leave the composer read-only.
      setSettingsReady(false);
      setPrefsFailure(null);
      setPrefsDetails('');
      const refreshedPreferences = loadSettings(client).then(
        (adopted) => {
          setSettings(adopted);
          saveWarned.current = false;
          setSettingsReady(true);
        },
        (error) => {
          setPrefsFailure(code(error));
          setPrefsDetails(error instanceof Error ? error.message : String(error));
        },
      );
      prefsSettled.current = refreshedPreferences;
      await refreshedPreferences;
      if (!isCurrent()) return;
      if (sessionId !== null) {
        // Host 被强制结束后，记录锁可能要等租约过期；重试预算比租约略长，仍拿不到就明确提示。
        await reopenSessionWriter({
          open: () => client.call('session.open', projectRoot === '' ? { sessionId } : { sessionId, projectRoot }, 60_000).then(() => undefined),
          code,
          isLocked: (failure) => failure === 'session_locked',
          now: () => Date.now(),
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
          budgetMs: 15_000,
          isCurrent,
        });
        if (!isCurrent()) return;
        await openSession(sessionId, undefined, true);
      } else {
        try {
          await client.call('workspaces.list', {}, 60_000);
          if (!isCurrent()) return;
          connectionLost.current = false;
          setLink(null);
          setSessionsRevision((current) => current + 1);
        } catch (error) {
          if (!isCurrent()) return;
          setLink(code(error));
          setRows((current) => [...current, metaRow('error', `无法重新连接后端：${code(error)}`, `Could not reconnect to the host: ${code(error)}`)]);
        }
      }
    } finally {
      // 所有重连结果都要清除重连状态，避免后续无法再次重连或恢复队列。
      reconnecting.current = false;
    }
  }, [client, dropQueriesOf, openSession, projectRoot, sessionId, setAsks, setRunningIds, transport]);

  const readBack = useCallback(async () => {
    if (sessionId === null) return;
    await openSession(sessionId);
  }, [sessionId, openSession]);

  // 按输入所属会话处理输入和轮次结束状态；后台结果不改变当前会话的队列。
  const submit = useCallback(async (text: string, own = sessionId) => {
    if (quitting.current || text === '' || own === null || readOnlySessionId === own) return;
    const inView = () => active.current === own;
    // 会话运行期间的输入加入前端队列，轮次结束后按顺序发送，不写入会话记录。
    if (runningIds.includes(own)) {
      if (inView()) { setDraft(''); setWalk(-1); }
      patchQueue(own, (current) => ({ ...current, items: [...current.items, text] }));
      return;
    }
    if (inView()) { setDraft(''); setWalk(-1); }
    // 发送成功后由 Host 更新共享输入历史，界面采用其返回结果。
    // 历史写入失败时保留本地输入历史，且不阻止消息发送。
    void client.call('history.append', { text }, 15_000).then(
      (written) => setHistory((written as { entries: string[] }).entries),
      () => setHistory((current) => [text, ...current.filter((item) => item !== text)]),
    );
    roundStart.current.set(own, Date.now());
    setTick(Date.now());
    setRunningIds((current) => [...current, own]);
    const previousTerminal = terminalBySession.current.get(own);
    try {
      await client.call('run.start', { sessionId: own, input: text });
    } catch (error) {
      const stopped = code(error);
      // 根据取消发生位置返回不同错误码：模型请求中为 `provider_cancelled`，调用组之间为 `loop_cancelled`，等待用户答复时为 `ask_user_cancelled`。
      const cancelled = stopped === 'loop_cancelled' || stopped === 'provider_cancelled' || stopped === 'ask_user_cancelled';
      // Host 尚未接受的输入没有写入记录，因此恢复到草稿并等待用户重发。
      // Host 接受后发生的失败不在此列，因为输入已经保存在会话记录中。
      if (inView() && (stopped === 'host_unanswered' || stopped === 'host_closed' || stopped === 'host_restarted')) setDraft((current) => mergeQueueIntoDraft(current, [text]));
      if (inView() && terminalBySession.current.get(own) === previousTerminal) setRows((current) => [...current, metaRow(cancelled ? 'meta' : 'error', cancelled ? '本轮已取消' : `无法开始本轮：${stopped}`, cancelled ? 'Turn cancelled' : `Could not start the turn: ${stopped}`)]);
      if (cancelled) patchQueue(own, (current) => ({ ...current, paused: true }));
      else if (terminalBySession.current.get(own) === previousTerminal) notify('failed', own);
    } finally {
      setRunningIds((current) => current.filter((id) => id !== own));
      roundStart.current.delete(own);
      // 轮次结束后 Host 会拒绝未答审批；移除界面中的待答卡片并说明原因。
      const left = asksLeft.current.filter((ask) => ask.sessionId === own).length;
      if (left > 0 && inView()) {
        setRows((current) => [...current, metaRow('meta', `本轮结束时有 ${left} 个问题未回答，已按未允许处理。`, `${left} unanswered question(s) were closed as refused when the turn ended.`)]);
      }
      dropAsksOf(own);
      // 轮次结束后移除该会话的待答问题卡片，避免旧请求阻挡其他会话或接受过期答复。
      dropQueriesOf(own, '这一轮已经收尾');
      // 轮次结束后移除该会话的流式片段；最终内容由已落盘记录提供。
      liveBySession.clear(own);
      if (inView()) setLive({ text: '', reasoning: '' });
      // 只有该会话自己的轮次结束后才继续发送其队列；其他会话结束不会触发发送。
      allowSend.current.add(own);
      // 后台会话结束时标记为有未读结果，切回时再清除。
      if (!inView()) setUnread((current) => [...new Set([...current, own])]);
      void refreshStatus(own);
    }
  }, [client, dropAsksOf, dropQueriesOf, notify, patchQueue, readOnlySessionId, refreshStatus, runningIds, sessionId, t]);

  // 轮次结束后每次只发送队首一条。队列暂停时不发送，等待用户明确继续。
  // 连接断开或正在重连时不发送，避免将输入交给已退出的 Host。
  // 只有前台会话的队列可以自动继续；后台会话需切回前台或由用户显式继续。
  useEffect(() => {
    // 与 `send` 使用相同的会话归属检查；草稿归属同步前不发送队列。
    if (quitting.current || reading || inputOwner !== sessionId) return;
    if (running || link !== null || reconnecting.current || sessionId === null) return;
    if (!allowSend.current.has(sessionId)) return;
    const own = queues[sessionId];
    if (own === undefined || own.paused || own.items.length === 0) return;
    const [next, ...rest] = own.items;
    allowSend.current.delete(sessionId);
    patchQueue(sessionId, () => ({ items: rest, paused: false }));
    void submit(next, sessionId);
  }, [inputOwner, patchQueue, queues, reading, running, sessionId, submit]);

  // 将队列项收回草稿；草稿已有内容时保留原文，不拼接两段输入。
  const recoverQueueItem = useCallback((index: number, all: boolean) => {
    if (sessionId === null || draft !== '') return;
    const own = queues[sessionId] ?? { items: [], paused: false };
    if (own.items.length === 0) return;
    const recovered = all ? own.items.join('\n\n') : own.items[index] ?? '';
    if (recovered === '') return;
    setDraft(recovered);
    setWalk(-1);
    patchQueue(sessionId, all
      ? () => ({ items: [], paused: false })
      : (current) => ({ ...current, items: current.items.filter((_, at) => at !== index) }));
  }, [draft, patchQueue, queues, sessionId]);

  // 打开新会话时，输入区域保持只读，直到会话 ID、草稿和归属信息同步完成。
  // 避免将旧会话草稿写入新会话，也避免恢复草稿时覆盖用户刚输入的内容。
  const send = useCallback(async () => {
    const text = draft.trim();
    if (quitting.current || reading || creating.current || !settingsReady || inputOwner !== sessionId || text === '') return;
    if (sessionId !== null) {
      await submit(text);
      return;
    }
    setStarting(true);
    creating.current = true;
    const request = openRequest.current;
    try {
      const hasPermissionOverride = newSessionPermission.profile !== DEFAULT_NEW_SESSION_PERMISSION.profile
        || newSessionPermission.network !== DEFAULT_NEW_SESSION_PERMISSION.network;
      const createParameters = {
        ...newParameters.current,
        ...(newSessionMode === null ? {} : { initialMode: newSessionMode }),
        ...(newSessionPolicy === null ? {} : { initialPolicy: newSessionPolicy }),
        ...(hasPermissionOverride ? {
          initialPermissionProfile: newSessionPermission.profile,
          initialPermissionNetwork: newSessionPermission.network,
          confirmInitialFullAccess: newSessionPermissionConfirmations.fullAccess,
          confirmInitialNetwork: newSessionPermissionConfirmations.network,
          confirmInitialPartialWorkspaceWrite: newSessionPermissionConfirmations.partialWorkspaceWrite,
          confirmInitialWorkspaceTrust: newSessionPermissionConfirmations.workspaceTrust,
        } : {}),
      };
      const created = await client.call('session.create', createParameters, 15_000) as { sessionId: string };
      if (openRequest.current !== request) return;
      const selection = settings.newSelections[projectRoot];
      if (selection !== undefined) await client.call('model.select', { sessionId: created.sessionId, ...selection }, 15_000);
      await client.call('session.label', { sessionId: created.sessionId, name: text.split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || t('新会话', 'New conversation') }, 15_000);
      const opened = await openSession(created.sessionId, undefined, false, newParameters.current.projectRoot);
      if (active.current !== created.sessionId) return;
      if (opened !== true) throw Object.assign(new Error('session_open_failed'), { code: 'session_open_failed' });
      const cached = readSettings();
      const drafts = { ...cached.drafts };
      const atRoot = { ...(drafts[projectRoot] ?? {}) };
      delete atRoot.$new;
      drafts[projectRoot] = atRoot;
      const next = { ...cached, drafts, lastSession: { id: created.sessionId, projectRoot } };
      await saveSettings(client, next);
      unsavedInputs.current.delete(JSON.stringify([projectRoot, '$new']));
      setSettings(next);
      setSessionsRevision((current) => current + 1);
      void submit(text, created.sessionId);
    } catch (error) {
      setDraft(text);
      setRows((current) => [...current, metaRow('error', `无法开始会话：${code(error)}`, `Could not start conversation: ${code(error)}`)]);
    } finally {
      creating.current = false;
      setStarting(false);
    }
  }, [client, draft, inputOwner, newSessionMode, newSessionPermission, newSessionPermissionConfirmations, newSessionPolicy, openSession, projectRoot, reading, sessionId, settings.newSelections, settingsReady, submit, t]);

  // `own` 指定取消目标会话；默认取消当前前台会话。
  const cancel = useCallback(async (own = sessionId) => {
    if (own === null) return;
    // 只取消目标会话的轮次，不影响其他会话。
    // 取消会暂停该会话队列，后续输入需由用户明确继续。
    if ((queues[own]?.items.length ?? 0) > 0) patchQueue(own, (current) => ({ ...current, paused: true }));
    try {
      await client.call('run.cancel', { sessionId: own });
    } catch (error) {
      // 取消状态属于目标会话；用户切走时暂存提示，切回后显示。
      if (active.current === own) setRows((current) => [...current, metaRow('meta', `取消失败：${code(error)}`, `Could not cancel: ${code(error)}`)]);
    }
  }, [client, patchQueue, queues, sessionId]);

  // 退出请求使用最新会话状态；订阅保持稳定，通过 ref 读取更新后的快照。
  const quitInput = useRef<QuitInput>({ running: [], approvals: [], questions: [], queued: {} });
  useEffect(() => {
    quitInput.current = { running: runningIds, approvals: asks.map((ask) => ask.sessionId), questions: queries.map((query) => query.sessionId), queued: queues };
  }, [asks, queues, queries, runningIds]);

  // 退出前等待偏好保存完成；保存失败时保留窗口和输入，并暂停队列发送。
  const quitApp = useCallback(async () => {
    if (quitting.current) return;
    quitting.current = true;
    setClosing(true);
    setQuitRows([]);
    try {
      await persistInputs();
      for (const own of quitInput.current.running) await cancel(own);
      await transport.quit?.();
    } catch (error) {
      setPrefsFailure(code(error));
      setPrefsDetails(error instanceof Error ? error.message : String(error));
      quitting.current = false;
      setClosing(false);
    }
  }, [cancel, persistInputs, transport]);
  const quitAction = useRef<() => void>(() => undefined);
  quitAction.current = () => {
    const blocked = blockedSessions(quitInput.current);
    if (blocked.length === 0) void quitApp();
    else setQuitRows(blocked);
  };
  useEffect(() => {
    transport.onQuit?.(() => {
      const reasons = [...settingsEdits.current, ...dockEdits.current];
      if (reasons.length > 0) setQuitHold(reasons);
      else quitAction.current();
    });
  }, [transport]);

  // 输入停止 160 毫秒后查询候选；响应到达时若查询文本已变化则丢弃。
  // 传输层不支持取消正在执行的请求，因此通过忽略过期响应避免更新界面。
  useEffect(() => {
    const token = mentionToken(draft, caret);
    if (token === null) { setMention(null); mentionAsked.current = NO_TOKEN; return; }
    mentionWanted.current = token;
    if (hiddenMention === token.text) { mentionAsked.current = NO_TOKEN; return; }
    // 用 ref 保存上次查询文本，避免更新 state 触发 effect 重跑并撤销已安排的查询。
    const asked = mentionAsked.current;
    if (asked.start === token.start && asked.text === token.text) return;
    // 查询文本变化后清除旧候选，避免用户选中与当前输入不匹配的结果。
    mentionAsked.current = token;
    setMention({ ...token, paths: [], chosen: 0, stopped: 'pending', root: projectRoot });
    const timer = setTimeout(() => {
      void (async () => {
        const listed = await client.call('paths.list', { projectRoot, query: token.text, limit: 8 }, 8_000)
          .then((answer) => {
            const got = answer as { projectRoot: string; paths: string[]; stopped: string };
            return { paths: got.paths, stopped: got.stopped, root: got.projectRoot, failed: undefined as string | undefined };
          })
          .catch((error) => ({ paths: [] as string[], stopped: 'error', root: projectRoot, failed: code(error) }));
        const now = mentionWanted.current;
        if (now.start !== token.start || now.text !== token.text) return;
        setMention({ ...token, paths: listed.paths, chosen: 0, stopped: listed.stopped, root: listed.root, failed: listed.failed });
      })();
    }, 160);
    return () => clearTimeout(timer);
  }, [caret, client, draft, hiddenMention, projectRoot]);

  // 选择候选后将对应的 `@…` 替换为 `@路径 `，光标移到替换内容之后并保留后续文本。
  const pickMention = useCallback((path: string) => {
    if (mention === null) return;
    const merged = insertMention(draft, caret, mention.start, path);
    setDraft(merged.draft);
    setCaret(merged.caret);
    setHiddenMention('');
    setMention(null);
    composerRef.current?.setSelectionRange(merged.caret, merged.caret);
    composerRef.current?.focus();
  }, [caret, draft, mention]);

  // 通过 `mode.set` 切换模式；无效清单返回稳定错误码，不静默回退到默认模式。
  const setMode = useCallback(async (name: string | null) => {
    if (sessionId === null) {
      setNewSessionMode(name === '' || name === 'default' ? null : name);
      return;
    }
    if (name === '') return;
    try {
      const result = await client.call('mode.set', { sessionId, name: name ?? 'default' }) as { mode: string; pending: string | null };
      setRows((current) => [...current, metaRow('meta', result.pending === null
        ? `模式已切换为 ${result.mode}。`
        : `本轮结束后将切换为 ${result.pending} 模式。`, result.pending === null
        ? `Mode changed to ${result.mode}.`
        : `Mode will change to ${result.pending} after this turn.`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `切换模式失败：${code(error)}`, `Could not change mode: ${code(error)}`)]);
    }
    void refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  // 通过 `policy.set` 修改当前会话的策略；传入 `null` 时恢复配置默认值。
  const setPolicy = useCallback(async (mode: PolicySelection | null) => {
    if (sessionId === null) {
      setNewSessionPolicy(mode);
      return;
    }
    try {
      const result = await client.call('policy.set', { sessionId, mode: mode ?? 'default' }, 15_000) as { policy: string; policySource: string };
      if (active.current === sessionId) setRows((current) => [...current, metaRow('meta', mode === null
        ? `已恢复配置默认审批方式：${result.policy}。`
        : `本会话审批方式已改为 ${result.policy}。`, mode === null
        ? `Restored the configured approval mode: ${result.policy}.`
        : `Approval mode for this conversation changed to ${result.policy}.`)]);
    } catch (error) {
      if (active.current === sessionId) setRows((current) => [...current, metaRow('error', `更改审批方式失败：${code(error)}`, `Could not change approval mode: ${code(error)}`)]);
      throw error;
    }
    await refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  // 通过 `session.compact` 压缩模型上下文；转录仍从完整会话记录构建。
  const compact = useCallback(async () => {
    if (sessionId === null) return;
    try {
      const result = await client.call('session.compact', { sessionId }) as { fromSeq: number; toSeq: number; tokensBefore: number; tokensAfter: number };
      setRows((current) => [...current, metaRow('meta', `已压缩记录 ${result.fromSeq}–${result.toSeq}：${result.tokensBefore} → ${result.tokensAfter} 个词元。`, `Compacted events ${result.fromSeq}–${result.toSeq}: ${result.tokensBefore} → ${result.tokensAfter} tokens.`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `压缩失败：${code(error)}`, `Could not compact context: ${code(error)}`)]);
    }
    void refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  const copyLastAnswer = useCallback(() => {
    const answer = [...rows].reverse().find((row) => row.kind === 'answer');
    if (answer === undefined) {
      setRows((current) => [...current, metaRow('meta', '还没有可复制的回答。', 'There is no answer to copy yet.')]);
      return;
    }
    void navigator.clipboard.writeText(answer.text).then(
      () => setRows((current) => [...current, metaRow('meta', `已复制最新回答（${answer.text.length} 个字符）。`, `Copied the latest answer (${answer.text.length} characters).`)]),
      (error: unknown) => setRows((current) => [...current, metaRow('error', `复制失败：${code(error)}`, `Could not copy answer: ${code(error)}`)]),
    );
  }, [rows]);

  // 命令面板只触发界面已有操作，不实现另一套操作逻辑。
  const commands = useMemo<Command[]>(() => {
    const sessionCommands: Command[] = observingExternalSession
      ? [{
        id: 'session.read', title: t('刷新观察', 'Refresh observation'),
        run: () => { if (sessionId !== null) void openSession(sessionId, undefined, false, projectRoot); },
      }]
      : [
        { id: 'session.read', title: t('刷新记录', 'Refresh conversation'), run: () => void readBack() },
        { id: 'session.branch', title: t('分支会话', 'Branch conversation'), run: () => void branchFrom() },
        { id: 'run.cancel', title: t('停止本轮', 'Stop this turn'), run: () => void cancel() },
        { id: 'session.compact', title: t('压缩上下文', 'Compact context'), run: () => void compact() },
      ];
    return [
      { id: 'session.new', title: t('新建会话', 'New conversation'), run: () => void newSession() },
      ...sessionCommands,
      { id: 'settings.open', title: t('打开设置', 'Open settings'), run: () => { setSettingsSection('general'); setSettingsOpen(true); } },
      { id: 'rail.toggle', title: collapsed ? t('展开侧栏', 'Show sidebar') : t('收起侧栏', 'Hide sidebar'), note: formatKeys(CURRENT['sidebar']), run: () => patch({ collapsed: !collapsed }) },
      { id: 'answer.copy', title: t('复制最新回答', 'Copy latest answer'), note: formatKeys(CURRENT['copy-answer']), run: copyLastAnswer },
      ...(status?.templates ?? []).map((item) => ({
        id: `prompt:${item.command}`,
        title: t(`使用 /${item.command}`, `Use /${item.command}`),
        note: item.hint === null || item.hint === undefined ? item.description : `${item.description} ${item.hint}`,
        run: () => {
          setDraft(`/${item.command} `);
          setWalk(-1);
          composerRef.current?.focus();
        },
      })),
    ];
  }, [branchFrom, cancel, collapsed, copyLastAnswer, compact, newSession, openSession, observingExternalSession, patch, projectRoot, readBack, sessionId, status, t]);

  const loadApprovalDetails = useCallback(async (ask: Ask) => {
    if (ask.detailsRef === undefined || ask.detailsLoaded === true || ask.detailsLoading === true) return;
    setAsks((current) => current.map((item) => item.id === ask.id ? { ...item, detailsLoading: true, detailsError: undefined } : item));
    try {
      const result = await client.call('approval.details', { sessionId: ask.sessionId, requestId: ask.detailsRef }, 15_000) as { args?: unknown };
      if (typeof result.args !== 'object' || result.args === null || Array.isArray(result.args)) throw new Error('approval_details_invalid');
      const args = result.args as Record<string, unknown>;
      const change = changeOf(ask.tool, args);
      const englishChange = changeOf(ask.tool, args, 'en');
      setAsks((current) => current.map((item) => item.id === ask.id ? {
        ...item,
        change: change.summary,
        content: `${changeBody(change, args)}${item.detailsSuffix?.chinese ?? ''}`,
        english: { change: englishChange.summary, content: `${changeBody(englishChange, args, 'en')}${item.detailsSuffix?.english ?? ''}` },
        detailsLoading: false,
        detailsLoaded: true,
      } : item));
    } catch (error) {
      const failure = code(error);
      setAsks((current) => current.map((item) => item.id === ask.id ? { ...item, detailsLoading: false, detailsError: failure } : item));
    }
  }, [client]);

  const answer = useCallback((decision: 'allow' | 'deny', rememberScope?: 'session' | 'project' | 'user', rememberTarget?: 'file' | 'workspace' | 'tool' | 'command') => {
    const head = asks.find((ask) => ask.sessionId === sessionId);
    if (head === undefined) return;
    setAsks((current) => current.filter((ask) => ask.id !== head.id));
    // 答复按原请求编号返回，与当前前台会话无关。
    // 答案回显只写入发起请求的会话转录。
    if (head.sessionId === sessionId) {
      // 先更新本地转录再发送答复，因为 Host 收到答复后可能立即返回工具结果。
    }
    client.reply(head.id, { decision, ...(rememberScope === undefined ? {} : { rememberScope }), ...(rememberTarget === undefined ? {} : { rememberTarget }) });
    // 答复后移走按钮焦点，避免下一次 Enter 重复提交。
    // 将焦点移至输入框，让键盘用户可以继续输入。
    (document.activeElement as HTMLElement | null)?.blur();
    composerRef.current?.focus();
  }, [asks, client, sessionId]);

  // 每个提问请求只能答复一次；提交后立即移除对应卡片。
  const answerQuestion = useCallback((answers: { id: string; selected: string[]; custom?: string }[]) => {
    const head = queries.find((query) => query.sessionId === sessionId);
    if (head === undefined) return;
    setQueries((current) => current.filter((query) => query.id !== head.id));
    questionDrafts.current.delete(head.id);
    if (head.sessionId === sessionId) {
      setRows((current) => [...current, metaRow('meta', `${answers.length}/${head.questions.length} 个问题已回答，其余已标记为未回答。`, `${answers.length} of ${head.questions.length} questions answered; the rest were marked unanswered.`)]);
    }
    client.reply(head.id, { answers });
    // 答复后移走按钮焦点，防止 Enter 重复提交。
    (document.activeElement as HTMLElement | null)?.blur();
    composerRef.current?.focus();
  }, [client, queries, sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 输入法组合期间，Esc 用于取消候选，Enter 用于选择候选；不要将它们用于关闭面板或取消轮次。
      if (isComposing(event)) return;
      // 设置页正在录制快捷键时，不处理窗口级按键动作。
      if (isCapturing()) return;
      // 从同一键位表解析按键动作并生成界面显示文本。
      const action = actionOf(event, '窗口');
      if (action !== null && action !== 'interrupt') {
        event.preventDefault();
        if (action === 'palette') setPaletteOpen((open) => !open);
        else if (action === 'sidebar') patch({ collapsed: !collapsed });
        else copyLastAnswer();
        return;
      }
      // 先关闭面板和抽屉，再处理轮次取消。
      if (specOf(event) !== CURRENT['interrupt']) return;
      // Radix 负责关闭命令面板、会话菜单、设置和其他浮层，并标记 Esc 已处理。
      // React 状态可能在按键事件到达 document 前更新，因此根据事件是否已处理判断是否继续关闭其他层。
      if (event.defaultPrevented) return;
      if (panel !== null) leaveDock(() => setPanel(null));
      else if (running) void cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, collapsed, copyLastAnswer, leaveDock, panel, patch, running]);

  const streamContext = useMemo(() => ({ hasMore: page?.hasMore === true, loading: olderLoading, showEarlier }), [olderLoading, page?.hasMore, showEarlier]);
  // 按展示设置过滤转录行；虚拟列表不能保留不渲染的行，否则高度测量会得到零。
  const shown = useMemo(() => rows.filter((row) => shownIn(verbosity, row)), [rows, verbosity]);
  // 将流式内容追加在已落盘记录之后，保持事件顺序。
  // 仅在转录内容变化时替换数组，避免每次渲染都触发虚拟列表重新测量。
  const visible = useMemo(() => (live.reasoning === '' && live.text === '' ? shown : [
    ...shown,
    ...(live.reasoning === '' || !shownIn(verbosity, LIVE_REASONING) ? [] : [{ ...LIVE_REASONING, text: live.reasoning }]),
    ...(live.text === '' || !shownIn(verbosity, LIVE_ANSWER) ? [] : [{ ...LIVE_ANSWER, text: live.text }]),
  ]), [shown, live.reasoning, live.text, verbosity]);

  useLayoutEffect(() => {
    renderedStream.current = { rows: visible, firstIndex, verbosity };
  }, [firstIndex, verbosity, visible]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor === null || anchor.request !== openRequest.current) return;
    const index = visible.findIndex((row) => row.id === anchor.id);
    if (index < 0) {
      prependAnchor.current = null;
      setOlderLoading(false);
      return;
    }
    // 等数据提交并补偿前插高度后再定位；测量完成前暂停自动跟随。
    const frame = requestAnimationFrame(() => {
      if (prependAnchor.current !== anchor || anchor.request !== openRequest.current) return;
      list.current?.scrollIntoView({
        index,
        calculateViewLocation: () => ({ index, align: 'start', offset: -anchor.offset }),
        done: () => {
          if (prependAnchor.current !== anchor || anchor.request !== openRequest.current) return;
          prependAnchor.current = null;
          setPinned(false);
          setOlderLoading(false);
        },
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  // 保存各会话当前最上方可见事件序号，切回时恢复阅读位置。
  // 保持回调身份稳定，避免无关渲染导致视口重复订阅。
  const onRangeChanged = useCallback(({ startIndex }: { startIndex: number }) => {
    if (reading) return;
    const row = visible[startIndex - firstIndex];
    if (row?.seq !== undefined && sessionId !== null) anchors.current.set(sessionId, row.seq);
  }, [visible, firstIndex, reading, sessionId]);

  // 每个定位请求只执行一次；高亮期间的补页和内容更新沿用当前视口。
  useLayoutEffect(() => {
    if (wanted === null) return;
    const at = visible.findIndex((row) => row.seq === wanted.seq);
    if (at >= 0) {
      readerScrolling.current = false;
      setPinned(false);
      setInitialIndex({ index: at, align: 'start' });
      setStamp((current) => current + 1);
      setFlash(wanted.seq);
      setWanted(null);
      return;
    }
    // 目标事件被展示设置过滤时停在转录末尾，不修改展示设置或记录。
    if (wanted.kind === 'anchor') {
      setWanted(null);
      return;
    }
    // 记录中存在但当前列表中没有该事件时，说明展示设置已过滤其类型。
    const held = rows.find((row) => row.seq === wanted.seq);
    if (held !== undefined && !shownIn(verbosity, held)) {
      patch({ verbosity: 'detailed' });
      return;
    }
    // 已读取页面中找不到目标事件时显示提示，不等待无法完成的跳转。
    setWanted(null);
    setRows((current) => [...current, metaRow('meta', wanted.kind === 'label'
      ? `记录 ${wanted.seq} 是会话名称，显示在标题和侧栏中。`
      : `记录 ${wanted.seq} 不属于当前可显示的内容。`, wanted.kind === 'label'
      ? `Event ${wanted.seq} is a conversation label shown in the title and sidebar.`
      : `Event ${wanted.seq} is not a displayable record.`)]);
  }, [patch, rows, verbosity, visible, wanted]);

  // 定位目标只短暂高亮，表示刚刚跳转到此处。
  // `stamp` 确保重复跳到同一事件时也会重新开始高亮计时。
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => {
      setFlash(null);
    }, 2500);
    return () => clearTimeout(timer);
  }, [flash, stamp]);

  const panelProps: PanelProps = {
    client,
    status,
    sessionId,
    running,
    othersRunning,
    runningIds,
    unread,
    seconds,
    waiting: client.waiting(),
    counts: client.counts(),
    link,
    logs: diagnosticLogs,
    onReconnect: () => void reconnect(),
    openSession: (id: string, root?: string) => void openSession(id, undefined, false, root),
    openHit,
    projects: settings.projects,
    onProjects: (roots: string[]) => patch({ projects: roots }),
    projectRoot,
    createIn: (root?: string) => void newSession(root),
    onEdit: reportDock,
    sessionsRevision,
    settings,
    patch,
  };

  const currentQueries = queries.filter((query) => query.sessionId === sessionId);
  const currentAsks = asks.filter((ask) => ask.sessionId === sessionId);
  const handleDraftKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (mention !== null) {
      const candidate = actionOf(event, '候选清单');
      if (candidate === 'hide-candidate') {
        setHiddenMention(mention.text);
        setMention(null);
        return;
      }
      if (mention.stopped === 'pending' && (candidate === 'pick-candidate' || candidate === 'complete-candidate')) {
        event.preventDefault();
        return;
      }
      if (candidate !== null && mention.paths.length > 0) {
        event.preventDefault();
        if (candidate === 'pick-candidate' || candidate === 'complete-candidate') {
          pickMention(mention.paths[Math.min(mention.chosen, mention.paths.length - 1)]);
          return;
        }
        const step = candidate === 'candidate-older' ? -1 : 1;
        setMention({ ...mention, chosen: (mention.chosen + step + mention.paths.length) % mention.paths.length });
        return;
      }
    }
    const typed = actionOf(event, '输入坞');
    if (typed === 'send' || typed === 'send-alt') {
      event.preventDefault();
      void send();
      return;
    }
    if (typed !== 'history-older' && typed !== 'history-newer') return;
    if (draft !== '' && walk < 0) return;
    if (history.length === 0) return;
    event.preventDefault();
    const next = typed === 'history-older' ? Math.min(walk + 1, history.length - 1) : walk - 1;
    setWalk(next);
    setDraft(next < 0 ? '' : history[Math.max(next, 0)] ?? '');
  }, [draft, history, mention, pickMention, send, walk]);
  const toggleQueue = useCallback(() => {
    if (sessionId === null) return;
    if (queue.paused) allowSend.current.add(sessionId);
    patchQueue(sessionId, (current) => ({ ...current, paused: !current.paused }));
  }, [patchQueue, queue.paused, sessionId]);
  const selectWorkspace = useCallback(async (root: string) => {
    const text = draft;
    if (!await newSession(root)) throw new Error('workspace_selection_cancelled');
    setDraft(text);
    patch({ projects: [...new Set([...settings.projects, root])], hiddenProjects: settings.hiddenProjects.filter(item => item !== root) });
  }, [draft, newSession, patch, settings.hiddenProjects, settings.projects]);
  const selectModel = useCallback(async (selection: ModelSelection) => {
    if (sessionId === null) { patch({ newSelections: { ...settings.newSelections, [projectRoot]: selection } }); return; }
    await client.call('model.select', { sessionId, ...selection }, 15_000);
    await refreshStatus(sessionId);
  }, [client, patch, projectRoot, refreshStatus, sessionId, settings.newSelections]);
  const selectThinking = useCallback(async (effort: string | null) => {
    if (sessionId === null) return;
    const request = thinkingRequest(sessionId, effort);
    await client.call(request.method, request.params, 15_000);
    await refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);
  return <LocaleProvider language={settings.language}><div className="frame" data-collapsed={collapsed ? 'true' : undefined} data-mobile-sidebar={narrow && mobileSidebar ? 'true' : undefined} data-dock={settings.dock}>
    <aside className="sidebar">
      <div className="brand"><img src="/icon.png" alt="" width="23" height="23" /><span>ligule</span><button type="button" className="icon-button" aria-label={t('收起侧栏', 'Hide sidebar')} onClick={() => patch({ collapsed: true })}><Icon name="sidebar" /></button></div>
      <button className="new-run" type="button" onClick={() => void newSession()}><Icon name="plus" size={17} /><span>{t('新建会话', 'New conversation')}</span></button>
      {registry.list('rail.sessions').map((item) => <div key={item.id} className="rail-slot">{item.view(panelProps)}</div>)}
      <div className="sidebar-foot">
        <button className="entry" type="button" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => { setSettingsSection('general'); setSettingsOpen(true); }}><Icon name="gear" size={17} /><span>{t('设置', 'Settings')}</span></button>
        {/* 这一枚菜单交给 radix：打开、收起、方向键走到哪一条、焦点交回都由它管，这里只说有哪些功能项（方案 4.2）。 */}
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button className="entry" type="button"><Icon name="help" size={17} /><span>{t('帮助', 'Help')}</span></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" side="top" align="start" sideOffset={4} onEscapeKeyDown={keepEscape}>
              {registry.list('rail.menu').filter((item) => ['panel.help', 'panel.diagnostics'].includes(item.id)).map((item) => <DropdownMenu.Item key={item.id} onSelect={() => leaveDock(() => setPanel(item))}>
                {item.id === 'panel.help' ? t('使用手册', 'User guide') : t('诊断', 'Diagnostics')}
              </DropdownMenu.Item>)}
              <DropdownMenu.Item onSelect={() => { setSettingsSection('keys'); setSettingsOpen(true); }}>{t('快捷键', 'Keyboard shortcuts')}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </aside>
    <div className="splitter" role="separator" aria-orientation="vertical" aria-label={t('侧栏宽度', 'Sidebar width')} onPointerDown={startDrag} />

    <main className="center">
      {prefsFailure !== null && <div className="banner" role="alert">
        <span>{t('无法保存更改。请重试，离开前请复制草稿。', 'Could not save changes. Retry, or copy your draft before leaving.')}</span>
        <button type="button" onClick={() => setPrefsRevision((value) => value + 1)}>{t('重试', 'Retry')}</button>
        <details><summary>{t('详情', 'Details')}</summary><code>{prefsFailure}</code>{prefsDetails !== prefsFailure && <p>{prefsDetails}</p>}</details>
      </div>}
      <header className="topbar">
        {collapsed && <button type="button" className="icon-button" aria-label={t('展开侧栏', 'Show sidebar')} onClick={() => patch({ collapsed: false })}><Icon name="sidebar" /></button>}
        <div className="title">
          <strong id="session-title">{sessionId === null ? t('新会话', 'New conversation') : sessionLabel.name || t('未命名会话', 'Untitled conversation')}</strong>
          <span className="muted title-workspace" id="session-note" title={projectRoot}>{projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? t('默认工作区', 'Default workspace')}</span>
        </div>
        {running && <span className="running-label" aria-live="polite" title={progressLabel}><span className="status-dot" /><span className="running-detail">{progressLabel}</span></span>}
        {status?.usage && <UsageMeter usage={status.usage} running={running} seconds={seconds} />}
        {sessionId !== null && <BrowserControl key={`${sessionId}:${observingExternalSession ? 'read-only' : 'managed'}`} client={client} sessionId={sessionId} browser={status?.browser}
        readOnly={observingExternalSession} onStatus={(next) => { if (next.sessionId === renderedSessionRequest.scope
          && requestIsCurrent(renderedSessionRequest, active.current, openRequest.current)) { setStatus(next); setTaskSnapshotAt(Date.now()); } }} />}
        <button className="icon-button" type="button" title={`${t('命令面板', 'Command palette')} (${formatKeys(CURRENT['palette'])})`} aria-label={t('命令面板', 'Command palette')} onClick={() => setPaletteOpen(true)}><Icon name="search" size={17} /></button>
        {sessionId !== null && <SessionActions key={sessionId} client={client} sessionId={sessionId} name={sessionLabel.name} archived={sessionLabel.archived}
          readOnly={observingExternalSession}
          onLabel={(label) => { setSessionLabel(label); setSessionsRevision((value) => value + 1); }}
          onBranch={() => void branchFrom()} onExport={() => setPanel(menuPanels.find((item) => item.id === 'panel.export') ?? null)}
          onTasks={() => setPanel(menuPanels.find((item) => item.id === 'panel.branch') ?? null)} onRefresh={() => {
            if (observingExternalSession) void openSession(sessionId, undefined, false, projectRoot);
            else void readBack();
          }} onCompact={() => void compact()} />}
      </header>

      {observingExternalSession && <div className="banner" role="status">
        <Icon name="warn" size={15} />
        <span>{sessionWriterActive
          ? externalControlSessionId === sessionId
            ? t('外控 Agent 正在运行。下方可以查看进度、补充消息、处理待决问题或接管会话。', 'An external agent is controlling this session. Use the panel below to follow progress, send guidance, answer requests, or take over.')
            : t('另一个 Host 正在写入此会话。当前为只读观察；锁释放后可重新打开会话。', 'Another Host is writing to this conversation. This view is read-only; reopen it after the lock clears.')
          : t('此会话当前没有活动写入者。刷新会话可重新打开并取得控制权。', 'This session has no active writer. Refresh to reopen it and take control.')}
          {writerLockNoticeSessionId === sessionId && <> {t(
            '会话写入锁仍被占用；锁释放后重新打开会话即可恢复写入。',
            'The session writer lock is still held. Reopen the conversation after it clears to regain write access.',
          )}</>}</span>
        <button type="button" onClick={() => { if (sessionId !== null) void openSession(sessionId, undefined, false, projectRoot); }}>
          {sessionWriterActive ? t('刷新观察', 'Refresh view') : t('重新打开', 'Reopen session')}
        </button>
      </div>}

      <TranscriptViewport
        client={client}
        sessionId={sessionId}
        projectRoot={projectRoot}
        rows={visible}
        hasRecords={rows.length > 0}
        reading={reading}
        verbosity={verbosity}
        flash={flash}
        onBranch={observingExternalSession ? undefined : (at) => void branchFrom(at)}
        onModels={openModelSettings}
        pinned={pinned}
        setPinned={setPinned}
        follow={!olderLoading && pinned && wanted === null && flash === null}
        initialIndex={initialIndex}
        list={list}
        firstIndex={firstIndex}
        stamp={stamp}
        streamContext={streamContext}
        readerScrolling={readerScrolling}
        onRangeChanged={onRangeChanged}
        onJumpToLatest={jumpToLatest}
      />

      {currentQueries.length > 0 && <QuestionCard
        key={currentQueries[0].id}
        ask={currentQueries[0]}
        initialDrafts={questionDrafts.current.get(currentQueries[0].id)}
        queued={currentQueries.length - 1}
        active={sessionId}
        onOpen={(id: string) => void openSession(id)}
        onSubmit={answerQuestion}
        // 取消当前卡片所属会话的轮次；前台切换后不能误停其他会话。
        onCancel={() => void cancel(currentQueries[0].sessionId)}
        onDraft={keepQuestionDraft}
      />}

      {currentAsks.length > 0 && <ApprovalCard
        ask={currentAsks[0]}
        queued={currentAsks.length - 1}
        verbosity={verbosity}
        active={sessionId}
        onOpen={(id: string) => void openSession(id)}
        onAnswer={answer}
        onDetails={(ask) => void loadApprovalDetails(ask)}
      />}

      {observingExternalSession && sessionWriterActive && sessionId !== null && <ExternalSessionControlPanel
        key={sessionId}
        client={client}
        sessionId={sessionId}
        projectRoot={projectRoot}
        verbosity={verbosity}
        onRuntimeAvailability={updateExternalControlAvailability}
        onDelta={acceptExternalDelta}
        onSessionEvent={settleExternalEvent}
        onTakeover={() => { void openSession(sessionId, undefined, false, projectRoot); }}
        getQuestionDraft={getExternalQuestionDraft}
        onQuestionDraft={keepExternalQuestionDraft}
      />}

      {link !== null && <div className="banner" role="alert">
        <Icon name="warn" size={15} />
        <span>{t('与后台的连接已中断。重连后可恢复会话，队列保持暂停。', 'Connection lost. Reconnect to restore the conversation; queued messages stay paused.')}</span>
        <button type="button" onClick={() => void reconnect()}>{t('重新连接', 'Reconnect')}</button>
        <details><summary>{t('详情', 'Details')}</summary><code>{link}</code></details>
      </div>}

      {notificationProblem !== null && settings.notifications.enabled && <div className="banner" role="status">
        <Icon name="bell" size={15} />
        <span>{t('系统通知暂不可用。', 'System notifications are unavailable.')}</span>
        <button type="button" onClick={() => { setSettingsSection('notifications'); setSettingsOpen(true); }}>{t('通知设置', 'Notification settings')}</button>
        <button type="button" className="icon-button" aria-label={t('关闭提示', 'Dismiss')} onClick={() => setNotificationProblem(null)}><Icon name="close" size={14} /></button>
      </div>}

      {observingExternalSession && sessionWriterActive && externalControlSessionId === sessionId && sessionId !== null
        ? <ExternalSessionComposer key={`external-session-composer:${sessionId}`} client={client} sessionId={sessionId} projectRoot={projectRoot}
            draft={externalSessionDraftFor(externalSessionDrafts, sessionId)}
            draftRevision={externalSessionDraftRevisionFor(externalSessionDrafts, sessionId)}
            onDraftChange={(value) => setExternalSessionDrafts((current) => updateExternalSessionDrafts(current, sessionId, value))}
            onDraftSent={(revision) => setExternalSessionDrafts((current) => clearExternalSessionDraftIfCurrent(current, sessionId, revision))} />
        : <Composer
        client={client}
        sessionId={sessionId}
        projectRoot={projectRoot}
        status={status}
        settings={settings}
        settingsReady={settingsReady}
        closing={closing}
        reading={reading}
        starting={starting}
        running={running}
        inputOwner={inputOwner}
        draft={draft}
        composerRef={composerRef}
        queue={queue}
        mention={mention}
        sessionMenuOpen={sessionMenuOpen}
        initialMode={newSessionMode}
        initialPolicy={newSessionPolicy}
        initialPermission={newSessionPermission}
        initialPermissionConfirmations={newSessionPermissionConfirmations}
        newSessionSettingsRevision={newSessionSettingsRevision}
        modelCatalogRevision={modelCatalogRevision}
        workspaceRevision={sessionsRevision}
        othersRunning={othersRunning}
        onDraftChange={setDraft}
        onCaretChange={setCaret}
        onWalkChange={setWalk}
        onDraftKeyDown={handleDraftKeyDown}
        onSelectWorkspace={selectWorkspace}
        onToggleQueue={toggleQueue}
        onRecoverQueueItem={(index, all) => recoverQueueItem(index, all)}
        onPickMention={pickMention}
        onSelectModel={selectModel}
        onSetThinking={selectThinking}
        onManageModel={openModelSettings}
        onOpenSecurity={openSecuritySettings}
        onSessionMenuChange={setSessionMenuOpen}
        onSetMode={(name) => void setMode(name)}
        onSetPolicy={setPolicy}
        onInitialPermissionChange={(target, confirmations) => {
          setNewSessionPermission(target);
          setNewSessionPermissionConfirmations(confirmations);
        }}
        onPermissionStatus={(next) => { if (next.sessionId === renderedSessionRequest.scope
          && requestIsCurrent(renderedSessionRequest, active.current, openRequest.current)) { setStatus(next); setTaskSnapshotAt(Date.now()); } }}
        onStop={() => void cancel()}
        onSend={() => void send()}
      />}
    </main>

    {panel !== null && <aside className="dock">
      <div className="dock-head">
        <strong className="dock-title">{panelTitle(panel)}{panel.pending === true && <span className="menu-tag">{t('待实现', 'Coming soon')}</span>}</strong>
        <button type="button" className="icon-button" aria-label={t('关闭面板', 'Close panel')} onClick={() => leaveDock(() => setPanel(null))}><Icon name="close" size={15} /></button>
      </div>
      <div className="dock-body">{panel.view(panelProps)}</div>
    </aside>}

    {/* 面板收起后把焦点交回输入坞：面板自己那一个过滤框带着 `autoFocus`，它收掉之后没人可交，落在页面上就得从页头重新 Tab 过去。 */}
    {paletteOpen && <Palette commands={commands} onClose={() => { setPaletteOpen(false); composerRef.current?.focus(); }} />}
    {settingsOpen && <SettingsDialog
      initialSection={settingsSection}
      client={client}
      sessionId={sessionId}
      projectRoot={projectRoot}
      status={status}
      settings={settings}
      notifications={transport.notifications}
      notificationProblem={notificationProblem}
      notificationPending={notificationDestination !== null}
      patch={patch}
      keyNotice={keyNotice}
      link={link}
      logs={diagnosticLogs}
      onStatus={(next) => { if (next.sessionId === renderedSessionRequest.scope
        && requestIsCurrent(renderedSessionRequest, active.current, openRequest.current)) { setStatus(next); setTaskSnapshotAt(Date.now()); } }}
      counts={panelProps.counts}
      waiting={panelProps.waiting}
      onReconnect={() => void reconnect()}
      onEdit={reportSettingsEdits}
      onClose={() => { setSettingsOpen(false); setModelCatalogRevision((current) => current + 1); if (sessionId !== null) void refreshStatus(sessionId); }}
    />}
    {quitHold !== null && <HoldSheet
      lead={t('退出会丢弃以下未保存的设置：', 'Exiting will discard these unsaved settings:')}
      reasons={quitHold}
      onStay={() => setQuitHold(null)}
      onLeave={() => { setQuitHold(null); quitAction.current(); }}
    />}
    {quitRows.length > 0 && <QuitSheet rows={quitRows} onBack={() => setQuitRows([])} onQuit={() => void quitApp()} />}
    {dockHold !== null && <HoldSheet
      lead={t('放弃未保存的修改？', 'Discard unsaved changes?')}
      reasons={dockHold.reasons}
      onStay={() => setDockHold(null)}
      onLeave={() => { const go = dockHold.go; setDockHold(null); go(); }}
    />}
  </div></LocaleProvider>;
}
