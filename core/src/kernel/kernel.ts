// 新建 Kernel 时工具表为空；只有通过 `register()` 登记的工具才能被调用。
// Kernel 不依赖传输层、界面框架或客户端适配器，CLI 和 Desktop 共用同一套工具与策略逻辑。
import { randomUUID } from 'node:crypto';
import { KernelError } from './error.js';
import { createConfig, type ConfigSnapshot } from './config.js';
import { createLogger, type Logger, type LoggerBackend } from './log.js';
import { failureOf, refusalOf, resultLimit, resultOf, spillContent } from './result.js';
import { POLICY_SEMANTICS, VERDICT_FIELDS, type DecisionChain, type PolicyMode } from './policy.js';
import { createObservationLog, type ObservationLog } from './observe.js';
import { resolveTarget, type NetworkTarget } from '../capability/network.js';
import { resolveShell, withNativeExitCode, type ShellKind, type ShellSelection } from '../capability/shell.js';
import { assertSupportedSchema, validateArgs } from './schema.js';
import { createPermissionContext, DEFAULT_PERMISSION_CONTEXT, isPermissionAccess, permissionDenial, type PermissionAccess, type PermissionContext } from './permission.js';
import { bindScript, requiresManualApprovalForProjectCommand, requiresTrustedWorkspaceCommand, type ScriptBinding } from '../capability/script-binding.js';
import { boundaryOf, workingDirectoryOf } from '../capability/limits.js';
import { resolveWithin } from '../capability/paths.js';
import { isTrusted } from './workspace-trust.js';
import { createFileWriteQueue, fileWriteTargetKey, type FileWriteQueue } from './file-write-queue.js';

export interface ToolContext {
  readonly config: ConfigSnapshot;
  readonly permission: PermissionContext;
  readonly logger: Logger;
  readonly observations: ObservationLog;
  /** Opaque value returned by this invocation's tool preflight, when present. */
  readonly preflightResult?: unknown;
  readonly signal?: AbortSignal;
  readonly target?: NetworkTarget;
  readonly shell?: ShellSelection;
  readonly scriptBinding?: ScriptBinding;
  readonly runId?: string;
  readonly executionId?: string;
  readonly callId?: string;
}

type BivariantToolCallback<TArgs, TResult> = {
  callback(args: TArgs, context: ToolContext): TResult;
}['callback'];

type BivariantPreflight<TArgs> = {
  callback(args: TArgs, context: ToolContext): unknown | Promise<unknown>;
}['callback'];

type BivariantCapability<TArgs> = {
  callback(args: TArgs): string;
}['callback'];

type BivariantPolicyIdentity<TArgs> = {
  callback(args: TArgs): string | undefined;
}['callback'];

export interface ToolDefinition<TArgs = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execution?: 'parallel' | 'serial';
  readonly disclosure?: boolean;
  readonly readOnly?: boolean;
  readonly access?: PermissionAccess;
  readonly targetArgument?: string;
  readonly networkTarget?: string;
  readonly commandArgument?: string;
  // 参数中不含命令字符串的工具（例如用户声明的命令工具）由该函数合成最终命令行，
  // 供 Shell 选择、脚本绑定与策略按命令判定使用；引号跟随 Kernel 选定的后端。
  readonly commandOf?: (args: TArgs, shell: ShellSelection) => string | undefined;
  capability?: BivariantCapability<TArgs>;
  policyIdentity?: BivariantPolicyIdentity<TArgs>;
  /** Run before Policy approval; its return value is passed only to this invocation's `run`. */
  readonly preflight?: BivariantPreflight<TArgs>;
  run: BivariantToolCallback<TArgs, unknown | Promise<unknown>>;
}

interface RegisteredTool extends ToolDefinition {
  readonly parameters: Record<string, unknown>;
  readonly execution: 'parallel' | 'serial';
  readonly disclosure: boolean;
  readonly readOnly: boolean;
  readonly access: PermissionAccess;
}

export interface ToolManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly access: PermissionAccess;
  readonly disclosure: boolean;
}

export interface KernelSession {
  readonly directory: string;
  append(event: Record<string, unknown>): Promise<unknown>;
  header?(): Promise<{ readonly formatVersion?: number } | undefined>;
}

export interface KernelOptions {
  readonly config?: ConfigSnapshot;
  readonly policy?: DecisionChain;
  readonly session?: KernelSession;
  readonly logger?: LoggerBackend;
  // Omitted low-level callers receive a read-only context with execution unavailable.
  readonly permission?: PermissionContext;
  readonly permissionForCall?: () => PermissionContext;
  readonly policyOverrideForSession?: () => PolicyMode | null;
  /** Shared by Sessions that belong to the same Host; omitted Kernels get a private queue. */
  readonly fileWriteQueue?: FileWriteQueue;
}

export interface Kernel {
  list(): string[];
  readOnly(): string[];
  selectable(): string[];
  execution(name: string): 'parallel' | 'serial';
  register(tool: ToolDefinition): () => void;
  manifest(): ToolManifestEntry[];
  catalog(): ToolCatalogEntry[];
  validateCall(name: string, args: unknown): { readonly code?: 'tool_not_found' | 'tool_args_invalid'; readonly detail?: string };
  restrict(names: readonly string[]): () => void;
  call(name: string, args?: unknown, options?: { readonly callId?: string; readonly signal?: AbortSignal; readonly runId?: string; readonly executionId?: string }): Promise<unknown>;
}

interface ToolEvent extends Record<string, unknown> {
  kind: 'tool';
  tool: string;
  callId?: string;
  args: unknown;
  shell?: { kind: ShellKind; executable: string; segments?: string[]; tail?: string };
  verdict?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  durationMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

function samePermission(left: PermissionContext, right: PermissionContext): boolean {
  return left.profile === right.profile && left.network === right.network
    && left.capabilities.filesystemRead === right.capabilities.filesystemRead
    && left.capabilities.filesystemWrite === right.capabilities.filesystemWrite
    && left.capabilities.network === right.capabilities.network
    && left.capabilities.process === right.capabilities.process
    && left.profiles.readOnly === right.profiles.readOnly
    && left.profiles.workspaceWrite === right.profiles.workspaceWrite
    && left.partialWorkspaceWriteConfirmationRequired === right.partialWorkspaceWriteConfirmationRequired
    && left.partialWorkspaceWriteConfirmed === right.partialWorkspaceWriteConfirmed;
}

function permissionWithWorkspaceTrust(permission: PermissionContext, workspaceTrusted: boolean): PermissionContext {
  if (permission.workspaceTrusted === workspaceTrusted) return permission;
  return createPermissionContext(permission.profile, permission.network, permission.capabilities, {
    profiles: permission.profiles,
    limitations: permission.limitations,
    partialWorkspaceWriteConfirmationRequired: permission.partialWorkspaceWriteConfirmationRequired,
    partialWorkspaceWriteConfirmed: permission.partialWorkspaceWriteConfirmed,
    workspaceTrusted,
  });
}

// `options.config` 是加载器生成的配置快照，`options.logger` 是 Host 提供的日志接口。
// `options.policy` 决定调用如何判定，`options.session` 负责记录本次运行。
// 未提供策略时只检查工具登记和拒绝规则；未提供会话时不写入记录。
export function createKernel(options: KernelOptions = {}): Kernel {
  const config = options.config ?? createConfig({});
  // 使用 `createConfig` 生成的冻结快照，确保工具读取期间配置不会被修改。
  if (!Object.isFrozen(config)) throw new KernelError('config_snapshot_must_be_frozen');
  const policy = options.policy;
  const permission = options.permission ?? DEFAULT_PERMISSION_CONTEXT;
  const session = options.session;
  const fileWriteQueue = options.fileWriteQueue ?? createFileWriteQueue();
  const logger = createLogger(options.logger);
  // 文件观察记录与工具表具有相同生命周期；覆盖文件前必须与此前读取的版本匹配。
  const observations = createObservationLog();
  const context = Object.freeze({ config, logger, observations });

  function currentPermission(): PermissionContext {
    return options.permissionForCall?.() ?? permission;
  }

  const tools = new Map<string, RegisteredTool>();
  const policyOverrideForSession = options.policyOverrideForSession;
  // 按工具名维护 Host 添加的拒绝规则；多次 `restrict()` 可以为同一工具添加多条规则。
  const restrictions: Set<string>[] = [];

  function isDenied(name: string): boolean {
    return restrictions.some((denied) => denied.has(name));
  }

  // 限制注入模型的工具结果字节数；超限内容另存文件，记录中保留可读取的引用。
  async function withinLimit(
    result: ReturnType<typeof refusalOf> | ReturnType<typeof failureOf> | ReturnType<typeof resultOf>,
    directory: string,
  ) {
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    if (text === undefined) return result;
    const limit = resultLimit(config);
    if (Buffer.byteLength(text, 'utf8') <= limit) return result;
    const name = `result-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    const compact = tools.get('compact');
    const readWithCompact = compact !== undefined && !isDenied('compact')
      && permissionDenial(currentPermission(), compact.access) === undefined;
    return { ...result, content: await spillContent(text, { limit, directory, name, readWithCompact }), spilled: name,
      spillFormat: typeof result.content === 'string' ? 'text' : 'json',
    };
  }

  async function record(
    entry: ToolEvent,
    result: ReturnType<typeof refusalOf> | ReturnType<typeof failureOf> | ReturnType<typeof resultOf>,
  ): Promise<void> {
    if (!session) return;
    // Older readers must reject a record requiring images rather than silently project text alone.
    if (result.images !== undefined) {
      entry.callId ??= randomUUID();
      await session.append({ kind: 'image', callId: entry.callId });
    }
    await session.append({ ...entry, result: await withinLimit(result, session.directory) });
  }

  // 失败先写入会话记录再交给调用方；稳定错误码供分支判断，说明文字供模型查看。
  async function fail(entry: ToolEvent, error: KernelError): Promise<never> {
    await record(entry, failureOf(error.code, error.detail === undefined ? undefined : { content: error.detail }));
    throw error;
  }

  const kernel: Kernel = {
    // 返回本次运行中已登记的工具。
    list() {
      return [...tools.keys()].sort();
    },

    // 返回声明为可安全重试的工具名称。此字段仅用于恢复说明，不参与权限判定，也不会发给模型。
    readOnly() {
      const activePermission = currentPermission();
      return [...tools.values()].filter((tool) => tool.readOnly && permissionDenial(activePermission, tool.access) === undefined)
        .map((tool) => tool.name).sort();
    },

    // 模式只选择已登记的工具；当前 Permission 单独决定哪些工具进入模型清单。
    selectable() {
      return [...tools.values()].filter((tool) => !tool.disclosure)
        .map((tool) => tool.name).sort();
    },

    // 返回循环使用的执行分组；未声明或引用未知分组的工具按串行执行。
    execution(name: string) {
      return tools.get(name)?.execution ?? 'serial';
    },

    // 返回用于撤销本次登记的函数。重复名称会报错，不覆盖现有工具。
    register(tool: ToolDefinition) {
      if (!tool || typeof tool.name !== 'string' || tool.name === '') {
        throw new KernelError('tool_name_required');
      }
      if (typeof tool.description !== 'string' || tool.description === '') {
        throw new KernelError('tool_description_required');
      }
      if (typeof tool.run !== 'function') {
        throw new KernelError('tool_run_required');
      }
      // 参数模式顶层必须是对象。
      const schema = tool.parameters;
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new KernelError('tool_parameters_must_be_object');
      }
      if (schema.type !== 'object') {
        throw new KernelError('tool_parameters_type_not_object');
      }
      if (tools.has(tool.name)) {
        throw new KernelError('tool_already_registered');
      }
      const access = tool.access ?? 'unknown';
      if (!isPermissionAccess(access)) throw new KernelError('tool_access_unknown');
      if (tool.networkTarget !== undefined && (access !== 'network' || typeof tool.networkTarget !== 'string'
        || tool.networkTarget.trim() === '' || tool.targetArgument !== undefined)) throw new KernelError('tool_network_target_invalid');
      let parameters;
      try {
        // 保存独立副本，避免插件后续修改对象时改变已登记的参数模式。
        parameters = structuredClone(schema);
      } catch {
        // `structuredClone` 无法复制函数和 Symbol；这类值无法通过 JSON 往返。
        throw new KernelError('tool_parameters_not_serializable');
      }
      // 只允许受控参数模式子集中的构造。
      assertSupportedSchema(parameters);
      // 模型清单只包含名称、说明和参数模式，不暴露插件附带字段。
      // 工具执行策略保存在 Kernel 中，供循环读取，不发给模型。
      // 固定披露工具不受模式筛选影响，其可用性由登记表决定。
      // 网络目标和命令文本的元数据保留在 Kernel 中，供权限判定使用解析后的地址和命令语法。
      const entry: RegisteredTool = {
        name: tool.name,
        description: tool.description,
        parameters,
        execution: tool.execution === 'parallel' ? 'parallel' : 'serial',
        disclosure: tool.disclosure === true,
        // 工具可声明重试是否会产生额外副作用；该声明只用于恢复说明，不参与权限判定。
        readOnly: tool.readOnly === true,
        access,
        targetArgument: typeof tool.targetArgument === 'string' ? tool.targetArgument : undefined,
        networkTarget: tool.networkTarget,
        commandArgument: typeof tool.commandArgument === 'string' ? tool.commandArgument : undefined,
                // 工具可提供实际能力名称；MCP 工具用它传递 `mcp:<服务器>/<工具>` 身份。
                capability: typeof tool.capability === 'function' ? tool.capability : undefined,
                policyIdentity: tool.policyIdentity,
                commandOf: typeof tool.commandOf === 'function' ? tool.commandOf : undefined,
                preflight: tool.preflight,
                run: tool.run,
      };
      tools.set(tool.name, entry);
      return () => {
        // 只撤销本次登记，避免旧的卸载函数删除之后重新登记的同名工具。
        if (tools.get(tool.name) === entry) tools.delete(tool.name);
      };
    },

    // 生成模型清单前移除被拒绝的工具，并复制参数模式，避免调用方修改 Kernel 保存的数据。
    manifest() {
      const activePermission = currentPermission();
      return [...tools.values()]
        .filter((tool) => !isDenied(tool.name) && permissionDenial(activePermission, tool.access) === undefined)
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        }));
    },

    // Settings can inspect registered capabilities without exposing schemas or changing the model-visible manifest.
    catalog() {
      return [...tools.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, description, access, disclosure }) => ({ name, description, access, disclosure }));
    },

    // 预检模型返回的一批调用：检查工具是否已登记，并使用与 `call()` 相同的参数模式校验。
    // 预检不执行权限判定、不写入会话、不请求审批，也不运行工具。
    validateCall(name, args) {
      const tool = tools.get(name);
      if (!tool) return { code: 'tool_not_found', detail: `no tool named "${name}" is registered for this run` };
      const violations = validateArgs(tool.parameters, args);
      if (violations.length > 0 || !isPlainObject(args)) {
        return { code: 'tool_args_invalid', detail: violations.length > 0 ? violations.join('; ') : 'arguments must be an object' };
      }
      return {};
    },

    // 拒绝规则只能增加限制；撤销一条规则不会移除其他重叠规则。
    // 未登记工具名的拒绝规则保留在规则表中，但不会匹配本次运行中的工具。
    restrict(names: readonly string[]) {
      const denied = new Set(names);
      restrictions.push(denied);
      return () => {
        // 重复调用此函数只移除本次添加的规则，不影响其他 `restrict()` 规则。
        const index = restrictions.indexOf(denied);
        if (index >= 0) restrictions.splice(index, 1);
      };
    },

    // 每种失败都返回稳定错误码，供调用方分支处理。
    // 工具从 context 读取配置快照和日志接口；取消信号由循环或适配器传入。
    // 所有调用都经过权限判定，并将拒绝、失败和成功结果写入会话记录。
    async call(name: string, args?: unknown, options: { readonly callId?: string; readonly signal?: AbortSignal; readonly runId?: string; readonly executionId?: string } = {}) {
      // `options.callId` 用于将工具结果关联到模型发起的调用。
      const entry: ToolEvent = { kind: 'tool', tool: name, callId: options.callId, args };
      const tool = tools.get(name);
      if (!tool) {
        // 即使工具未登记也要记录失败结果，确保本轮中的每个模型调用都有对应结果。
        // 否则下一次请求会包含没有结果的工具调用，并被模型服务拒绝。
        await fail(entry, new KernelError('tool_not_found', { detail: `no tool named "${name}" is registered for this run` }));
        return undefined;
      }
      if (isDenied(name)) {
        await record(entry, refusalOf('tool_denied', 'the tool is restricted for this run'));
        throw new KernelError('tool_denied');
      }
      // 先校验参数再运行权限判定。格式错误的调用无法成功，不能要求用户审批，也不应增加拒绝计数。
      const violations = validateArgs(tool.parameters, args);
      if (violations.length > 0) {
        await fail(entry, new KernelError('tool_args_invalid', { detail: violations.join('; ') }));
        return undefined;
      }
      if (!isPlainObject(args)) {
        await fail(entry, new KernelError('tool_args_invalid', { detail: 'arguments must be an object' }));
        return undefined;
      }
      const activePermission = currentPermission();
      let callPermission = activePermission;
      const denied = permissionDenial(activePermission, tool.access);
      if (denied !== undefined) {
        entry.permission = {
          decision: 'deny',
          source: 'kernel-preflight',
          profile: activePermission.profile,
          network: activePermission.network,
          code: denied.code,
          reason: denied.reason,
        };
        logger.log(`tool ${name} is not permitted`, { tool: name, code: denied.code, reason: denied.reason });
        await record(entry, refusalOf(denied.code, denied.reason));
        throw new KernelError(denied.code, { detail: denied.reason });
      }
      let preflightResult: unknown;
      if (tool.preflight !== undefined) {
        try { preflightResult = await tool.preflight(args, { config, permission: activePermission, logger, observations, ...options }); }
        catch (error) {
          const failure = error instanceof KernelError
            ? error
            : new KernelError('tool_preflight_failed', { cause: error, detail: errorMessage(error) });
          await fail(entry, failure);
          return undefined;
        }
      }
      // 只解析一次网络目标，并将同一结果传给权限判定和执行。
      // 避免 DNS 在审批和连接之间变化，导致实际连接地址与批准地址不同。
      const targetAddress = tool.networkTarget ?? (tool.targetArgument === undefined ? undefined : args[tool.targetArgument]);
      const network = typeof targetAddress === 'string' ? await resolveTarget(targetAddress) : undefined;
      // 只选择一次命令解释器，并将同一后端用于语法解析、权限判定和执行。
      // 配置指定的解释器不可用时返回错误，不自动切换到另一种语法或程序。
      // 参数中声明命令的工具直接取参数；参数不含命令的工具（用户声明的命令工具）
      // 通过 `commandOf` 在选定后端后合成最终命令行，判定与执行用同一段文本。
      let shell: ShellSelection | undefined;
      let commandText: string | undefined;
      const declaredCommand = tool.commandArgument !== undefined && typeof args?.[tool.commandArgument] === 'string'
        ? args[tool.commandArgument] as string
        : undefined;
      if (declaredCommand !== undefined || tool.commandOf !== undefined) {
        try {
          shell = resolveShell(config);
        } catch (error) {
          if (!(error instanceof KernelError)) throw error;
          await fail(entry, error);
          return undefined;
        }
        entry.shell = { kind: shell.kind, executable: shell.executable };
        // 空白命令视同未提供：与策略层「不含命令文本」的口径一致，
        // 由工具自身的参数校验给出具体错误。
        const composed = declaredCommand ?? tool.commandOf!(args, shell);
        commandText = composed === undefined || composed.trim() === '' ? undefined : composed;
      }
      let approvedScriptBinding: ScriptBinding | undefined;
      let scriptBindingError: KernelError | undefined;
      let requiresManualApproval = false;
      let requiresWorkspaceTrust = false;
      let scriptWorkspaceRoot: string | undefined;
      if (policy) {
        // 有能力元数据的工具按其声明的实际能力名称进行判定，例如 `mcp:<服务器>/<工具>`。
        const capability = tool.capability?.(args);
        const identityDigest = tool.policyIdentity?.(args);
        let scriptBinding: ScriptBinding | undefined;
        if (tool.access === 'exec' && shell !== undefined && commandText !== undefined) {
          let workspaceRoot: string;
          let boundary: string;
          let workingDirectory: string;
          try {
            workspaceRoot = workingDirectoryOf(config);
            scriptWorkspaceRoot = workspaceRoot;
            boundary = boundaryOf(config);
            workingDirectory = args.cwd === undefined
              ? await resolveWithin(boundary, '.', { cwd: workspaceRoot })
              : await resolveWithin(boundary, args.cwd as string, { cwd: workspaceRoot });
          } catch (error) {
            await fail(entry, error instanceof KernelError ? error : new KernelError('tool_failed', { cause: error, detail: errorMessage(error) }));
            return undefined;
          }
          try {
            requiresWorkspaceTrust = await requiresTrustedWorkspaceCommand(commandText, shell);
            const trusted = requiresWorkspaceTrust ? await isTrusted(workspaceRoot) : activePermission.workspaceTrusted;
            callPermission = permissionWithWorkspaceTrust(activePermission, trusted);
            scriptBinding = await bindScript({ command: commandText, shell, boundary, workspaceRoot, cwd: workingDirectory, permission: callPermission });
            requiresManualApproval = await requiresManualApprovalForProjectCommand(commandText, shell);
          } catch (error) {
            scriptBindingError = error instanceof KernelError ? error : new KernelError('exec_script_binding_unavailable', { cause: error });
          }
        }
        const verdict = await policy.evaluate({ tool: name, input: args, target: network, shell, capability, access: tool.access, scriptBinding,
          ...(commandText === undefined ? {} : { command: commandText }),
          ...(options.callId === undefined ? {} : { callId: options.callId }),
          ...(identityDigest === undefined ? {} : { identityDigest }),
          ...(['create', 'write', 'edit', 'delete'].includes(name)
            ? { fileBoundary: boundaryOf(config), workingDirectory: workingDirectoryOf(config) }
            : {}),
          ...(requiresManualApproval ? { requiresManualApproval: true } : {}),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(scriptBindingError === undefined ? {} : { scriptBindingError: { code: scriptBindingError.code, detail: scriptBindingError.detail ?? scriptBindingError.code } }),
        });
        if (session?.header !== undefined && policy.snapshot !== undefined) {
          const header = await session.header();
          if ((header?.formatVersion ?? 0) >= 2) {
            const snapshot = policy.snapshot();
            const sessionOverride = policyOverrideForSession?.();
            try { await session.append({ kind: 'sessionPolicy', ignorable: true, ...snapshot,
              override: sessionOverride === undefined ? snapshot.override : sessionOverride, semantics: POLICY_SEMANTICS,
            }); }
            catch (error) {
              await fail(entry, error instanceof KernelError ? error : new KernelError('session_write_failed', { cause: error }));
              return undefined;
            }
          }
        }
        approvedScriptBinding = verdict.scriptBinding;
        if (approvedScriptBinding !== undefined && !samePermission(activePermission, currentPermission())) {
          await fail(entry, new KernelError('exec_script_binding_changed', { detail: 'the effective permission changed while script approval was pending' }));
          return undefined;
        }
        // 会话记录保存权限判定结果，包括策略档位、匹配规则和审批答复。
        // 该结果仅供客户端查看，不加入模型上下文或检查点摘要。
        const recordedVerdict: Record<string, unknown> = {};
        for (const field of VERDICT_FIELDS) {
          if (verdict[field] !== undefined) recordedVerdict[field] = verdict[field];
        }
        entry.verdict = recordedVerdict;
        if (verdict.decision !== 'allow') {
          // 拒绝理由写入日志和会话记录；返回值只包含稳定错误码。
          const code = verdict.code ?? 'policy_denied';
          const reason = verdict.reason ?? '';
          logger.log(`tool ${name} is not allowed`, { tool: name, code, reason });
          await record(entry, refusalOf(code, reason));
          throw new KernelError(code);
        }
        // 在结果中保留解析出的命令分段，便于从记录中确认实际判定了哪些命令。
        if (entry.shell !== undefined && shell !== undefined) {
          if (verdict.segments !== undefined) entry.shell.segments = verdict.segments;
          // 只有判定结果确认命令是单条原生命令且首个程序可执行时，才附加退出码。
          // 未运行权限判定时无法确认命令形状，因此不附加退出码。
          shell = withNativeExitCode(shell, verdict.segments?.length === 1 ? verdict.segments[0] : undefined);
          if (shell.tail !== '') entry.shell.tail = shell.tail;
        }
      }
      if (scriptBindingError !== undefined) {
        await fail(entry, scriptBindingError);
        return undefined;
      }
      if (requiresWorkspaceTrust && scriptWorkspaceRoot !== undefined) {
        try {
          if (!(await isTrusted(scriptWorkspaceRoot))) throw new KernelError('exec_workspace_untrusted', { detail: 'the project trust was revoked before the command started' });
        } catch (error) {
          await fail(entry, error instanceof KernelError ? error : new KernelError('workspace_trust_unavailable', { cause: error }));
          return undefined;
        }
        if (!samePermission(callPermission, currentPermission())) {
          await fail(entry, new KernelError('exec_workspace_untrusted', { detail: 'workspace trust changed while the command waited for approval' }));
          return undefined;
        }
      }
      let value;
      // 将执行耗时写入事件；计时从权限判定通过后开始，不包含等待审批的时间。
      // 使用单调时钟，避免系统时间调整影响耗时结果。
      const startedAt = process.hrtime.bigint();
      const timed = () => {
        entry.durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      };
      let success: ReturnType<typeof resultOf>;
      try {
          const runTool = (runPermission: PermissionContext) => tool.run(args, { ...context, permission: runPermission, signal: options.signal, target: network, shell,
            ...(preflightResult === undefined ? {} : { preflightResult }),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
            ...(options.callId === undefined ? {} : { callId: options.callId }),
            ...(approvedScriptBinding === undefined ? {} : { scriptBinding: approvedScriptBinding }) });
          if (['create', 'write', 'edit', 'delete'].includes(name) && typeof args.path === 'string') {
            const target = await resolveWithin(boundaryOf(config), args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
            value = await fileWriteQueue.run(target, async () => {
              const latestPermission = currentPermission();
              const latestDenial = permissionDenial(latestPermission, tool.access);
              if (latestDenial !== undefined) {
                throw new KernelError(latestDenial.code, { detail: latestDenial.reason });
              }
              // A queued operation may outlive a path or permission change. Recheck the
              // effective write target after acquiring the Host-scoped path slot.
              const currentTarget = await resolveWithin(boundaryOf(config), args.path as string,
                { forWrite: true, cwd: workingDirectoryOf(config) });
              if (name !== 'delete' && fileWriteTargetKey(currentTarget) !== fileWriteTargetKey(target)) {
                throw new KernelError('write_target_changed', { detail: `${args.path} resolved to a different file while waiting for the Host write queue` });
              }
              if (options.signal?.aborted) {
                const reason = options.signal.reason;
                throw reason instanceof KernelError ? reason : new KernelError('loop_cancelled', { cause: reason });
              }
              return await runTool(latestPermission);
            }, options.signal);
          } else {
            value = await runTool(callPermission);
          }
          success = resultOf(value);
      } catch (error) {
        // 工具抛出未包装的错误时，转换为稳定错误码并将原始错误保存在 cause 中。
        // 错误说明会写入会话记录并提供给模型，避免单个工具异常中断整个循环。
        const failure = error instanceof KernelError
          ? error
          : new KernelError('tool_failed', { cause: error, detail: errorMessage(error) });
        // 失败和取消的调用也记录实际执行耗时；拒绝、参数错误和跳过的调用不会进入此处。
        timed();
        await fail(entry, failure);
      }
      timed();
      await record(entry, success!);
      return value;
    },
  };
  return kernel;
}
