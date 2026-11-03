// 此协议定义客户端与 Host 之间的请求和通知，与底层传输方式无关。
// 客户端发起 METHODS 中的请求；Host 发出的审批由客户端答复；流式片段和已落盘事件以通知形式发送。
// 参数模式使用 Kernel 支持的子集，客户端和 Host 共用同一份定义。
import { KernelError } from '../kernel/error.js';
import { assertSupportedSchema, validateArgs } from '../kernel/schema.js';
import { DELEGATION_SPEC_SCHEMA, type DelegationSpec } from '../delegation.js';

interface MethodSpec {
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface HostMethodParams extends Record<string, unknown> {
  readonly sessionId?: string;
  readonly projectRoot?: string;
  readonly workspaceOrigin?: string;
  readonly mode?: string;
  readonly policy?: string;
  readonly permissionProfile?: string;
  readonly permissionNetwork?: string;
  readonly confirmFullAccess?: boolean;
  readonly confirmNetwork?: boolean;
  readonly confirmPartialWorkspaceWrite?: boolean;
  readonly confirmWorkspaceTrust?: boolean;
  readonly name?: string;
  readonly archived?: boolean;
  readonly at?: number;
  readonly limit?: number;
  readonly query?: string;
  readonly path?: string;
  readonly fullResults?: boolean;
  readonly before?: number;
  readonly input?: string;
  readonly request?: unknown;
  readonly origin?: 'human' | 'controller';
  readonly delegation?: DelegationSpec;
  readonly requestKey?: string;
  readonly runId?: string;
  readonly artifactKey?: string;
  readonly offset?: number;
  readonly directory?: string;
  readonly text?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly initialMode?: string;
  readonly initialPolicy?: string;
  readonly initialPermissionProfile?: string;
  readonly initialPermissionNetwork?: string;
  readonly confirmInitialFullAccess?: boolean;
  readonly confirmInitialNetwork?: boolean;
  readonly confirmInitialPartialWorkspaceWrite?: boolean;
  readonly confirmInitialWorkspaceTrust?: boolean;
  readonly trusted?: boolean;
  readonly initialProvider?: string;
  readonly initialModel?: string;
  readonly initialThinkingEffort?: string;
  readonly initialOutputTokens?: number;
  readonly initialLoopIterations?: number;
  readonly thinkingEffort?: string;
  readonly outputTokens?: number;
  readonly loopIterations?: number;
  readonly resetModel?: boolean;
  readonly resetThinking?: boolean;
  readonly resetOutputTokens?: boolean;
  readonly reference?: string;
  readonly value?: unknown;
  readonly json?: string;
  readonly version?: string;
  readonly grantId?: string;
  readonly grantName?: string;
  readonly defaultPermissionProfile?: string;
  readonly maxPermissionProfile?: string;
  readonly defaultNetwork?: string;
  readonly maxNetwork?: string;
  readonly defaultPolicy?: string;
  readonly allowedPolicyAlways?: boolean;
  readonly allowedPolicyAsk?: boolean;
  readonly allowedPolicyAuto?: boolean;
  readonly allowedPolicyNone?: boolean;
  readonly allowedPolicyNever?: boolean;
  readonly allowOperator?: boolean;
  readonly allowScreenCapture?: boolean;
  readonly confirmScreenCapture?: boolean;
  readonly enabled?: boolean;
  readonly confirmUnrestrictedNetwork?: boolean;
  readonly expiresAt?: string;
  readonly field?: string;
  readonly layer?: string;
  readonly op?: string;
  readonly index?: number;
  readonly ruleTool?: string;
  readonly ruleDecision?: string;
  readonly ruleMatch?: string;
  readonly ruleReason?: string;
  readonly ruleTarget?: string;
  readonly rulePath?: string;
  readonly ruleArgsHash?: string;
}

const SESSION_ID: Record<string, unknown> = { type: 'string', description: 'the session this call refers to' };

export const METHODS = Object.freeze({
  'workspace.trust': {
    description: 'Trust or untrust a project for local project-code execution; only the trusted local UI can change this state',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'the project selected in the local UI' },
        trusted: { type: 'boolean', description: 'whether this project is trusted for project scripts, Git commands, and hooks' },
        confirmWorkspaceTrust: { type: 'boolean', description: 'true only after the UI has shown the project and the user confirmed trust' },
      },
      required: ['projectRoot', 'trusted'],
    },
  },
  'session.create': {
    description: 'Start a session the Host keeps; returns the id every later call needs',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'start this session against another project the Host can load' },
        // 客户端明确说明工作区来源，因为指定的目录也可能正是默认工作区。
        // 未提供来源时，Host 根据是否提供工作区路径区分显式选择与默认工作区。
        workspaceOrigin: { type: 'string', description: "how this session landed on that workspace: 'explicit' when the client chose it, 'default' when it is the one the client falls back to" },
        initialMode: { type: 'string', description: 'optional mode to apply before returning the new session' },
        initialPolicy: { type: 'string', description: 'optional session policy override: always, ask, auto, or never' },
        initialPermissionProfile: { type: 'string', description: 'optional initial file and command permission; interactive clients only' },
        initialPermissionNetwork: { type: 'string', description: 'optional initial network permission; interactive clients only' },
        confirmInitialFullAccess: { type: 'boolean', description: 'confirmation for granting full-access permission to a new session' },
        confirmInitialNetwork: { type: 'boolean', description: 'confirmation for granting unrestricted network access to a new session' },
        confirmInitialPartialWorkspaceWrite: { type: 'boolean', description: 'confirmation that the user trusts the project and accepts the limits of a partial workspace-write sandbox' },
        confirmInitialWorkspaceTrust: { type: 'boolean', description: 'confirmation that the user trusts this project for project-code execution' },
        initialProvider: { type: 'string', description: 'provider ID for an initial model selection; must be paired with initialModel' },
        initialModel: { type: 'string', description: 'model ID for an initial model selection; must be paired with initialProvider' },
        initialThinkingEffort: { type: 'string', description: 'provider-supported effort to apply before the first run' },
        initialOutputTokens: { type: 'integer', minimum: 1, description: 'optional session output-token limit; the Host enforces model and context ceilings' },
        initialLoopIterations: { type: 'integer', minimum: 1, description: 'optional maximum model/tool iterations for each user turn in this session' },
      },
      description: 'a session starts on the project the Host was launched on; naming another project is optional',
    },
  },
  'session.open': {
    description: 'Resume a session whose record is already on disk; without a mode the Host takes the one last in force in that record',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        mode: { type: 'string', description: 'the mode to resume with, in place of the one that record carries' },
        // 用项目根目录选择项目环境，并据此解析工具边界和会话记录目录。
        projectRoot: { type: 'string', description: 'the project this record belongs to, when it is not the one the Host started on' },
      },
      required: ['sessionId'],
    },
  },
  // 关闭会话会释放其记录锁、MCP 子进程和扩展监听器。
  // 此操作不取消运行中的轮次，也不修改会话记录。
  'session.close': {
    description: 'Release this session in the Host: its record lock, its MCP servers and its extension listeners; the record on disk stays as it is',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID },
      required: ['sessionId'],
    },
  },
  // 会话名称和归档状态保存在记录中，由 Host 统一更新。
  // 两个字段都可省略，但至少要提供一个。
  'session.label': {
    description: 'Name this session, mark it archived, or both; the fact is appended to the record and the model is never shown it',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        name: { type: 'string', description: 'the title a person reads in the list; it stays out of what the model is shown' },
        archived: { type: 'boolean', description: 'archived keeps the record and only changes how the list shows it' },
      },
      required: ['sessionId'],
    },
  },
  // 创建分支时复制记录前缀，不修改父会话。
  // `at` 指定分支结束的轮次；省略时复制当前已有的全部记录。
  'session.branch': {
    description: 'Copy the prefix of a record into a new session: with `at`, up to that completed turn marker; without it, the whole record as it stands. The parent record is never written to, and a half-written branch is not listed',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        at: { type: 'integer', minimum: 0, description: 'the sequence number of a `turn` marker this record proves it completed' },
        projectRoot: { type: 'string', description: 'the project the parent record belongs to, when it is not the one the Host started on' },
      },
      required: ['sessionId'],
    },
  },
  // 会话列表由 Host 扫描记录目录；客户端不直接访问磁盘。
  'sessions.list': {
    description: 'List sessions already on disk, most recently written first, so a client can pick one to resume',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'only sessions opened against this project root' },
        limit: { type: 'integer', description: 'stop after this many rows', minimum: 1 },
      },
      description: 'listing sessions takes no argument; both filters are optional',
    },
  },
  // 搜索使用与会话列表相同的记录扫描器。
  // 结果包含会话编号和事件序号，供客户端打开会话并定位记录。
  'sessions.search': {
    description: 'Find one piece of text in the records on disk and return which session each hit is in, most recently written session first; the query is required and must not be blank',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the text to look for, matched case-insensitively' },
        projectRoot: { type: 'string', description: 'only search sessions opened against this project root' },
        // 只搜索指定会话，并读取溢出文件中的完整工具结果。
        sessionId: { ...SESSION_ID, description: 'search this one record only, including the tool results it spilled into other files' },
        limit: { type: 'integer', description: 'stop after this many hits', minimum: 1, maximum: 200 },
      },
      required: ['query'],
    },
  },
  // Host 为 `@` 文件引用生成候选项，客户端不扫描磁盘。
  // 只列项目根内的普通文件，不跟随符号链接；无法读取目录时标记结果可能不完整。
  'paths.list': {
    description: 'List file paths inside one project that contain the typed fragment, so an interface can offer @-references without walking the filesystem itself; results are capped and never include links',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'the project to list inside; absent means the one the Host was launched on' },
        query: { type: 'string', description: 'the fragment typed after @; matched case-insensitively against the path, absent or blank lists the first entries' },
        limit: { type: 'integer', description: 'stop after this many paths', minimum: 1, maximum: 50 },
      },
    },
  },
  'session.read': {
    description: 'Read events from an open session. Use `limit` and `before` for a history page, or `at` to read exactly one event by sequence number; `at` and `before` cannot be combined',
    parameters: { type: 'object', properties: {
      sessionId: SESSION_ID,
      fullResults: { type: 'boolean', description: 'read complete spilled tool results for display; the record and model view stay unchanged' },
      // 使用事件序号作为稳定游标；`before` 指向当前页最早事件，新事件只会追加到末尾。
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'take at most this many of the newest events in the requested range' },
      before: { type: 'integer', minimum: 1, description: 'read events older than this sequence number; it has to name an event in this record' },
      at: { type: 'integer', minimum: 1, description: 'read exactly the event with this sequence number; it has to exist in this record and cannot be combined with before' },
    }, required: ['sessionId'] },
  },
  'session.observe': {
    description: 'Read a workspace session snapshot without acquiring its writer lock. Suitable for a read-only viewer when another Host controls the session; poll for new appended events.',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string', description: 'the exact workspace root that owns the session' },
      sessionId: SESSION_ID,
      fullResults: { type: 'boolean', description: 'read complete spilled tool results for display' },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      before: { type: 'integer', minimum: 1 },
      at: { type: 'integer', minimum: 1 },
    }, required: ['projectRoot', 'sessionId'] },
  },
  'session.image.preview': {
    description: 'Read a bounded display preview of an image already referenced by a successful tool result in this workspace session. Does not capture the screen or acquire a session writer lock.',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string' },
      sessionId: SESSION_ID,
      imageId: { type: 'string', minLength: 36, maxLength: 36 },
    }, required: ['projectRoot', 'sessionId', 'imageId'] },
  },
  'browser.stop': {
    description: 'Stop and pause this Session managed browser, including derived browsers; trusted local UI only.',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'browser.resume': {
    description: 'Allow this Session managed browser to start again after a human stopped it; does not launch it.',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'session.control': {
    description: 'Send a human action to the local Host that currently owns this externally controlled Session. The same Host remains its only writer; the local action can read its configuration, observe, message, answer, change permission while idle, cancel, or take over.',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string', description: 'the exact workspace root that owns the session' },
      sessionId: SESSION_ID,
      request: { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', enum: ['status', 'configuration', 'details', 'send', 'reply', 'permission', 'cancel', 'takeover'] },
        after: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        waitMs: { type: 'integer', minimum: 0, maximum: 30000 },
        input: { type: 'string', minLength: 1, maxLength: 65536 },
        requestId: SESSION_ID,
        type: { type: 'string', enum: ['approval', 'question'] },
        decision: { type: 'string', enum: ['allow', 'deny'] },
        rememberScope: { type: 'string', enum: ['session', 'project', 'user'] },
        rememberTarget: { type: 'string', enum: ['file', 'workspace', 'tool', 'command'] },
        answers: {},
        permissionProfile: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'] },
        permissionNetwork: { type: 'string', enum: ['policy', 'unrestricted', 'disabled'] },
        confirmFullAccess: { type: 'boolean', description: 'the human confirmed raising to full-access' },
        confirmNetwork: { type: 'boolean', description: 'the human confirmed unrestricted network' },
        confirmPartialWorkspaceWrite: { type: 'boolean', description: 'the human confirmed the partial sandbox for workspace-write' },
        confirmWorkspaceTrust: { type: 'boolean', description: 'the human trusts this workspace' },
      }, required: ['action'] },
    }, required: ['projectRoot', 'sessionId', 'request'] },
  },
  'approval.details': {
    description: 'Read the full parameters for a pending approval in the same open Session. Only trusted local UI clients should request this after the human expands the details.',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID, requestId: SESSION_ID }, required: ['sessionId', 'requestId'] },
  },
  // Host 读取完整记录、补回溢出内容、生成 Markdown 并写入用户选择的位置。
  // 导出路径由用户通过保存对话框选择，不受模型工具的项目边界限制；返回路径不代表写入成功。
  'session.export': {
    description: 'Write this session record, and each derived branch record, as Markdown files at the destination the human chose; returns the paths written and any branch it could not read',
    parameters: { type: 'object', properties: {
      sessionId: SESSION_ID,
      path: { type: 'string', description: 'the file to write the main record to; branch records get a sibling file named after their own session id' },
    }, required: ['sessionId', 'path'] },
  },
  'run.start': {
    description: 'Send one user input through the loop. A delegated mode can only narrow the active session mode; an output schema requires a validated structured result. Events arrive as notifications while it runs.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        input: { type: 'string', description: 'the user message for this round' },
        origin: { type: 'string', enum: ['human', 'controller'], description: 'requested source; only a trusted local UI or authenticated Agent Control bridge may record human, otherwise the Host binds the run to controller scope' },
        delegation: DELEGATION_SPEC_SCHEMA,
        requestKey: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['sessionId', 'input'],
    },
  },
  'storage.inspect': {
    description: 'Inspect workspace-owned media storage without deleting anything.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' },
    }, required: ['projectRoot'] },
  },
  'storage.cleanup.preview': {
    description: 'Page through Session references before preparing a short-lived deletion plan; no deletion.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: SESSION_ID,
    }, required: ['projectRoot'] },
  },
  'storage.cleanup.apply': {
    description: 'Apply a still-valid local cleanup plan after explicit trusted-UI confirmation. No path arguments.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, planId: SESSION_ID, confirm: { type: 'boolean' },
    }, required: ['projectRoot', 'planId', 'confirm'] },
  },
  'artifact.list': {
    description: 'List confirmed file deliveries from Session tool evidence; never enumerates arbitrary workspace paths.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID, runId: SESSION_ID,
      limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 },
    }, required: ['projectRoot', 'sessionId'] },
  },
  'artifact.resolve': {
    description: 'Resolve a confirmed artifact for an explicit trusted native reveal action after checking current path and digest.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID,
      artifactKey: { type: 'string', minLength: 64, maxLength: 64 },
    }, required: ['projectRoot', 'sessionId', 'artifactKey'] },
  },
  'artifact.inspect': {
    description: 'Verify a confirmed delivered file against its current workspace path and SHA-256.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID,
      artifactKey: { type: 'string', minLength: 64, maxLength: 64 },
    }, required: ['projectRoot', 'sessionId', 'artifactKey'] },
  },
  'artifact.preview': {
    description: 'Preview bounded plain text or a normalized image only after confirming the registered file digest.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID,
      artifactKey: { type: 'string', minLength: 64, maxLength: 64 },
    }, required: ['projectRoot', 'sessionId', 'artifactKey'] },
  },
  'run.submit': {
    description: 'Accept one task durably and return its runId only after the Session user event is synced; a matching requestKey reuses that event.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sessionId: SESSION_ID, input: { type: 'string', minLength: 1, maxLength: 65536 },
      origin: { type: 'string', enum: ['human', 'controller'], description: 'requested source; only a trusted local UI or authenticated Agent Control bridge may record human, otherwise the Host binds the run to controller scope' },
      requestKey: { type: 'string', minLength: 1, maxLength: 128 },
      delegation: DELEGATION_SPEC_SCHEMA,
    }, required: ['sessionId', 'input'] },
  },
  'run.wait': {
    description: 'Wait for a run. The Host derives the run owner from the persisted acceptance and authorizes the caller against its own readable scopes; origin is accepted for compatibility but never grants or selects access.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sessionId: SESSION_ID, runId: SESSION_ID,
      origin: { type: 'string', enum: ['human', 'controller'], description: 'compatibility only; the persisted run owner decides' },
    }, required: ['sessionId', 'runId'] },
  },
  'run.receipt': {
    description: 'Read a durable task receipt from this project Session without reopening its writer or replaying work. A requestKey that matches multiple visible scopes returns run_request_key_ambiguous; use runId to select one receipt.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID,
      runId: SESSION_ID, requestKey: { type: 'string', minLength: 1, maxLength: 128 },
    }, required: ['projectRoot', 'sessionId'] },
  },
  'run.receipts': {
    description: 'List recent durable task receipts without opening a writable Session.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID,
      limit: { type: 'integer', minimum: 1, maximum: 50 }, before: { type: 'integer', minimum: 1 },
    }, required: ['projectRoot', 'sessionId'] },
  },
  'run.result': {
    description: 'Read a validated immutable run-result sidecar as bounded JSON fragments.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID, runId: SESSION_ID,
      offset: { type: 'integer', minimum: 0 },
    }, required: ['projectRoot', 'sessionId', 'runId'] },
  },
  'run.cancel': {
    description: 'Stop the round this session is running; the call answering run.start reports loop_cancelled between model calls and provider_cancelled while one is in flight',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'status.get': {
    description: 'Read the Host state for this session, including its live phase and model output budget when a run is active',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'session.configure': {
    description: 'Read or change one session-owned category: mode, policy, model generation, or the per-turn iteration limit. Loop-limit changes apply at the next turn boundary and never write configuration files.',
    parameters: { type: 'object', properties: {
      sessionId: SESSION_ID,
      mode: { type: 'string', description: 'select a mode; default restores the mode configured for this project' },
      policy: { type: 'string', description: 'always, ask, auto, never, or default to restore the project policy; legacy none is read as ask' },
      provider: { type: 'string', description: 'provider ID for a model selection; must be paired with model' },
      model: { type: 'string', description: 'model ID for a model selection; must be paired with provider' },
      thinkingEffort: { type: 'string', description: 'a value advertised by the selected provider, or default to inherit the provider default' },
      outputTokens: { type: 'integer', minimum: 1, description: 'session output-token maximum bounded by the provider and context window' },
      loopIterations: { type: 'integer', minimum: 1, description: 'maximum model/tool iterations per user turn in this session' },
      resetModel: { type: 'boolean', description: 'restore the model selection inherited from the current project configuration' },
      resetThinking: { type: 'boolean', description: 'inherit the selected provider default thinking behavior' },
      resetOutputTokens: { type: 'boolean', description: 'inherit the selected provider output-token setting' },
    }, required: ['sessionId'] },
  },
  // 工作区登记表和默认选择保存在应用数据根目录中。
  // 客户端可读取登记、设置默认项或移除登记；移除前必须先清除默认项。
  'workspaces.list': {
    description: 'Read the durable workspace roster and its default selection from the application data root; a workspace removed from one window stays registered until explicitly removed',
    parameters: { type: 'object', properties: {} },
  },
  'workspace.default.set': {
    description: 'Name the workspace new sessions fall back to; the directory is registered first so the default always points at a row that exists, and an empty directory clears the default',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'the workspace to make default; blank means no workspace is the default' },
        name: { type: 'string', description: 'the label to show for it; absent keeps the last segment of the directory' },
      },
      required: ['directory'],
    },
  },
  'workspace.remove': {
    description: 'Remove a workspace from the durable roster without changing its directory or session records; the default workspace must be cleared first',
    parameters: {
      type: 'object',
      properties: { directory: { type: 'string', description: 'the registered workspace directory to remove' } },
      required: ['directory'],
    },
  },
  // CLI/TUI 和 Desktop 共用应用数据根目录中的输入历史。
  // 客户端不能获取历史文件路径或读取数据根下的其他文件；输入历史不写入会话，也不提供给模型。
  'history.read': {
    description: 'Read the input history this machine keeps across sessions: sentences that were actually sent, newest first, up to the cap the host applies',
    parameters: { type: 'object', properties: {} },
  },
  // 只保存已发送的输入；重复内容移到列表前端，超过上限时删除最旧条目。响应直接返回更新后的列表。
  'history.append': {
    description: 'Remember one sentence that was sent: it moves to the front of the shared history, an older copy of the same sentence comes with it, and the whole list stays capped; the full list after the write comes back',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the sentence that was sent; blank changes nothing' },
      },
      required: ['text'],
    },
  },
  // Desktop 草稿、暂停队列、语言、通知和外观保存在应用数据根目录的偏好文档中。
  // 客户端不能读取该文件路径或访问数据根目录中的其他文件。
  'credentials.status': {
    description: 'Report whether a credential is configured and its source; never return the credential value',
    parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
  },
  'model.select': {
    description: 'Select a listed provider and model for one session, immediately when idle or at the next turn boundary',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, provider: { type: 'string' }, model: { type: 'string' } },
      required: ['sessionId', 'provider', 'model'],
    },
  },
  'models.discover': {
    description: 'Discover model IDs using a temporary key or a credential bound to a trusted user-level service endpoint; never return or log the credential',
    parameters: {
      type: 'object',
      properties: {
        api: { type: 'string' }, baseURL: { type: 'string' }, reference: { type: 'string' },
        temporaryKey: { type: 'string' }, projectRoot: { type: 'string' },
      },
      required: ['api', 'baseURL', 'reference'],
    },
  },
  'credentials.set': {
    description: 'Store a secret in the system credential store; an active environment override prevents changes',
    parameters: { type: 'object', properties: { reference: { type: 'string' }, value: { type: 'string' } }, required: ['reference', 'value'] },
  },
  'credentials.delete': {
    description: 'Delete a stored secret; never modify an environment variable',
    parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
  },
  'prefs.read': {
    description: 'Read the desktop preferences this machine keeps in the application data root: drafts, paused queues and interface choices; the document is per machine, not per session',
    parameters: { type: 'object', properties: {} },
  },
  // 原子替换偏好文档。Host 校验对象结构，通过临时文件和重命名写入，并返回写入后的版本。
  'prefs.write': {
    description: 'Replace the desktop preferences document with the given JSON; the host checks it parses to an object, writes it atomically so a crash never leaves half a document, and the written document comes back',
    parameters: {
      type: 'object',
      properties: {
        json: { type: 'string', description: 'the whole preferences document as JSON; it must parse to an object' },
        version: { type: 'string', description: 'the byte version returned by prefs.read; blank only when the file did not exist' },
      },
      required: ['json', 'version'],
    },
  },
  // Delegation grants persist outside session preferences and are available only through trusted local clients.
  'agent-control.list': {
    description: 'Read the local Agent Control grants and the version needed for a conflict-checked create or revoke operation',
    parameters: { type: 'object', properties: {} },
  },
  'agent-control.create': {
    description: 'Create a project-bound Agent Control grant after the trusted UI has confirmed project trust and separately confirmed any elevated permission ceilings',
    parameters: { type: 'object', properties: {
      version: { type: 'string' },
      grantName: { type: 'string' },
      projectRoot: { type: 'string' },
      defaultPermissionProfile: { type: 'string' },
      maxPermissionProfile: { type: 'string' },
      defaultNetwork: { type: 'string' },
      maxNetwork: { type: 'string' },
      defaultPolicy: { type: 'string', description: 'always, ask, auto, or never; a legacy none is read as ask' },
      allowedPolicyAlways: { type: 'boolean' },
      allowedPolicyAsk: { type: 'boolean' },
      allowedPolicyAuto: { type: 'boolean' },
      allowedPolicyNone: { type: 'boolean', description: 'legacy spelling; grants ask, never the approval-skipping never' },
      allowedPolicyNever: { type: 'boolean' },
      allowOperator: { type: 'boolean' },
      allowScreenCapture: { type: 'boolean' },
      confirmScreenCapture: { type: 'boolean' },
      allowedMcpServers: { type: 'array', items: { type: 'string' } },
      allowedMcpTools: { type: 'array', items: { type: 'string' } },
      allowedModes: { type: 'array', items: { type: 'string' }, description: 'mode names this grant may select; omit to allow every mode' },
      allowedModels: { type: 'array', items: { type: 'string' }, description: 'model references (service/model or bare model id) this grant may select; omit to allow every model' },
      maxOutputTokens: { type: 'number', description: 'ceiling for a single request output budget; omit to leave the budget unbounded' },
      confirmFullAccess: { type: 'boolean' },
      confirmUnrestrictedNetwork: { type: 'boolean' },
      confirmPartialWorkspaceWrite: { type: 'boolean', description: 'confirm trust in the project and accept partial workspace-write sandbox limits when this platform requires it' },
      confirmWorkspaceTrust: { type: 'boolean', description: 'true only after the trusted UI has shown the project and received the user trust confirmation' },
      expiresAt: { type: 'string' },
    }, required: ['version', 'grantName', 'projectRoot', 'defaultPermissionProfile', 'maxPermissionProfile', 'defaultNetwork', 'maxNetwork', 'defaultPolicy', 'allowOperator', 'confirmFullAccess', 'confirmUnrestrictedNetwork', 'confirmWorkspaceTrust', 'expiresAt'] },
  },
  'screen-capture.set': {
    description: 'Enable or revoke screen capture for this Session and its internal children through a trusted human client',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sessionId: { type: 'string' }, enabled: { type: 'boolean' }, confirmScreenCapture: { type: 'boolean' },
    }, required: ['sessionId', 'enabled'] },
  },
  'agent-control.revoke': {
    description: 'Revoke a persisted Agent Control grant using the version returned by agent-control.list',
    parameters: { type: 'object', properties: {
      grantId: { type: 'string' },
      version: { type: 'string' },
    }, required: ['grantId', 'version'] },
  },
  'mcp.trust.list': {
    description: 'List configured local MCP servers, their launch details without secret values, and the current trusted-user authorization for this project',
    parameters: { type: 'object', properties: { projectRoot: { type: 'string' }, sessionId: SESSION_ID } },
  },
  'settings.catalog': {
    description: 'Read the selected project’s workspace trust, available mode definitions, registered tool metadata, skill metadata, and extension status for a trusted local settings UI; mode is a view selection and never changes a session',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string' }, sessionId: SESSION_ID,
      mode: { type: 'string', description: 'the mode to inspect without applying it to a session' },
    } },
  },
  'mcp.trust.set': {
    description: 'Trust or block one configured MCP server through a trusted local interface; session trust is stored with that session, while project and user trust use the private local trust store',
    parameters: { type: 'object', properties: {
      projectRoot: { type: 'string' },
      sessionId: SESSION_ID,
      server: { type: 'string' },
      identityDigest: { type: 'string', minLength: 64, maxLength: 64 },
      scope: { type: 'string', enum: ['session', 'project', 'user'] },
      trusted: { type: 'boolean' },
      confirmTrust: { type: 'boolean', description: 'true only after the trusted UI showed this exact server configuration and the user chose to trust it' },
      confirmExternalAccess: { type: 'boolean', description: 'true only after the trusted UI explained that the server runs outside the Shell sandbox and may access files and network' },
      version: { type: 'string' },
    }, required: ['server', 'identityDigest', 'scope', 'trusted'] },
  },
  'mcp.trust.tools': {
    description: 'Start one already trusted local MCP server from a trusted interface and list its current tools without calling them',
    parameters: { type: 'object', properties: { projectRoot: { type: 'string' }, sessionId: SESSION_ID, server: { type: 'string' } }, required: ['server'] },
  },
  // 扩展启停登记只由可信界面写入；登记影响下一次 Host 启动时的扩展发现。
  'extensions.set': {
    description: 'Enable or disable one extension installed in the user extensions directory from a trusted interface; the registry takes effect the next time the Host starts and never touches paths declared by configuration layers',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'the project whose environment names the installed extensions; absent means the one the Host was launched on' },
        name: { type: 'string', description: 'the installed extension name shown by settings.catalog' },
        enabled: { type: 'boolean', description: 'false records the extension in the disable registry; true removes it again' },
      },
      required: ['name', 'enabled'],
    },
  },
  // 客户端只能读取配置白名单中的字段，不能请求文件路径或其他配置内容。
  'config.get': {
    description: 'Read allowlisted configuration values, their source layers, and writable-layer versions from one snapshot. Arbitrary paths and secret values are not exposed.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'the project whose settings layers to read; absent means the one the Host was launched on' },
      },
    },
  },
  // 配置由 Host 管理。客户端只能指定允许字段、配置层和已读取版本，不能指定文件路径或写入其他字段。
  'config.set': {
    description: 'Write one whitelisted configuration field into one settings layer of one project; the host owns the field list, the value shape and the target file, refuses the write when that file changed since it was read, and adopts only the sessions whose effective value changed after the layers are folded again',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'one field name from the list the host names back when this is not one of them' },
        value: { description: 'the new value; the host checks scalar, service list, and model selection shapes by field name' },
        layer: { type: 'string', description: 'which settings file to write; the writable ones are named back when this is not one of them' },
        version: { type: 'string', description: 'the version read from that file, so a concurrent edit is reported instead of overwritten; blank when that file did not exist' },
        projectRoot: { type: 'string', description: 'the project whose settings layer to write; absent means the one the Host was launched on' },
        op: { type: 'string', description: 'for the tool rule table: add a rule, change that one rule, or remove it' },
        index: { type: 'number', description: 'which rule in the table that layer writes, counted from 0; ignored when adding' },
        ruleTool: { type: 'string', description: 'for add and change: the capability name the rule matches' },
        ruleDecision: { type: 'string', description: "for add and change: 'allow' or 'deny'" },
        ruleMatch: { type: 'string', description: 'for add and change: the command prefix pattern; absent means the whole capability' },
        ruleReason: { type: 'string', description: 'for add and change: the sentence shown when this rule decides' },
        ruleTarget: { type: 'string', description: 'for remembered file rules: file or workspace' },
        rulePath: { type: 'string', description: 'for remembered file rules: the exact absolute file path or workspace boundary' },
        ruleArgsHash: { type: 'string', description: 'for remembered MCP rules: the approved argument and server identity digest' },
        serverName: { type: 'string', description: 'for the MCP server table: the server to set or remove' },
        serverCommand: { type: 'string', description: 'for setting an MCP server: the executable path; arguments belong in serverArgs' },
        serverArgs: { type: 'array', items: { type: 'string' }, description: 'for setting an MCP server: the command arguments' },
        serverEnv: { type: 'object', description: 'for setting an MCP server: a table of ${NAME} environment variable references' },
        serverCwd: { type: 'string', description: 'for setting an MCP server: the working directory for the server' },
      },
      required: ['field', 'layer', 'version'],
    },
  },
  // 策略默认值来自配置，每个会话可以设置运行期覆盖。
  // 覆盖不写配置文件，也不影响其他会话；`default` 表示恢复配置默认值。
  'policy.set': {
    description: 'Override the approval tier for this session only, or go back to the tier the settings file writes; the new tier applies to the tool decisions that follow',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, mode: { type: 'string', description: "'always', 'ask', 'auto', 'never', or 'default' to drop this session's override; legacy 'none' is read as 'ask'" } },
      required: ['sessionId', 'mode'],
    },
  },
  // Permission 选择由 TUI/Desktop 的显式用户操作发起；MCP Server 不提供对应工具。
  'permission.set': {
    description: 'Change the OS resource permission for this session after trusted UI confirmation; the session is rebuilt before another run starts',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        permissionProfile: { type: 'string', description: 'read-only, workspace-write, or full-access' },
        permissionNetwork: { type: 'string', description: 'policy, unrestricted, or disabled' },
        confirmFullAccess: { type: 'boolean', description: 'true only after the UI has shown and received confirmation for full-access' },
        confirmNetwork: { type: 'boolean', description: 'true only after the UI has shown and received confirmation for unrestricted network access' },
        confirmPartialWorkspaceWrite: { type: 'boolean', description: 'true only after the UI has shown the partial sandbox limits and the user confirmed trust in this project' },
        confirmWorkspaceTrust: { type: 'boolean', description: 'true only after the UI has shown the project and the user confirmed trust for project-code execution' },
      },
      required: ['sessionId', 'permissionProfile'],
    },
  },
  'mode.set': {
    description: 'Switch to another named mode; while a round runs it takes effect once that round ends, and naming the mode already in use withdraws a pending switch',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, name: { type: 'string', description: 'the mode to use for the next round' } },
      required: ['sessionId', 'name'],
    },
  },
  // 压缩需要调用模型并写入检查点，因此只能由 Host 执行，不能由客户端直接完成。
  'session.compact': {
    description: 'Compact the front of this session now: ask for one summary, write the checkpoint, return the new boundary; refuses while a round runs or when no window is configured',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
} satisfies Record<string, MethodSpec>);

// Host 发给客户端的请求及客户端答复的结构。
export const APPROVAL_METHOD = 'approval.request' as const;

// 模型向用户提问的请求与工具审批相互独立，分别使用自己的请求和答复。
// 答复中的 `answers` 为每个问题提供一项结果；工具负责校验答案内容，协议只定义字段结构。
export const QUESTION_METHOD = 'question.request' as const;

// Host 发出的通知类型：`delta` 是流式片段，`event` 是刚写入记录的事件，`progress` 是会话活动状态，`fault` 是连接错误。
export const NOTIFICATIONS = Object.freeze(['delta', 'event', 'fault', 'progress'] as const);

for (const [name, method] of Object.entries(METHODS)) {
  // 此表会发送给客户端；不支持的参数构造在注册时立即报错。
  try {
    assertSupportedSchema(method.parameters);
  } catch (error) {
    const detail = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error);
    throw new KernelError('protocol_method_unsupported', { detail: `${name}: ${detail}` });
  }
}

export function validateCall(name: string, params: unknown): asserts params is HostMethodParams {
  const method = Object.entries(METHODS).find(([methodName]) => methodName === name)?.[1];
  if (method === undefined) throw new KernelError('protocol_method_unknown', { detail: name });
  const violations = validateArgs(method.parameters, params);
  if (violations.length > 0) throw new KernelError('protocol_args_invalid', { detail: `${name}: ${violations.join('; ')}` });
}

// 审批答复只包含允许或拒绝。
export function isApproved(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'decision' in result && result.decision === 'allow';
}
