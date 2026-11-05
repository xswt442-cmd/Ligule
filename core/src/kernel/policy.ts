// 判定顺序是工具规则、内容检查、策略档位，最后才是用户审批。
// 任一步拒绝后都不能被后续步骤放行；前面的步骤拒绝时不会询问用户。
// 命令先按 Host 选择的语法解析，再逐段检查。任一段命中拒绝规则就拒绝整条命令，无法确认安全时转交审批。
// 自动放行不会执行脚本解释器命令，因为它们可以运行任意代码；解析时也不会剥除解释器外壳。
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { inspectCommand, type CommandInspection, type ParsedCommand } from '../capability/command.js';
import { classifyDangerousCommand } from '../capability/dangerous-command.js';
import { resolveWithin } from '../capability/paths.js';
import { KernelError } from './error.js';
import { matches } from './match.js';
import type { NetworkTarget } from '../capability/network.js';
import type { ShellSelection } from '../capability/shell.js';
import type { PolicyRule } from './config-edit.js';
import type { PermissionAccess } from './permission.js';
import type { ScriptBinding } from '../capability/script-binding.js';

// 四档审批策略只回答一个问题：这一次工具调用要不要问人。
// `always` 每次都问，`ask` 规则优先、没有规则就问，`auto` 规则优先、其余按确定性分析自动放行，
// `never` 跳过整个策略审批层，但硬性安全校验（目标类别、守卫、脚本绑定、Permission）仍然生效。
export const POLICY_MODES = ['always', 'ask', 'auto', 'never'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];
export type PolicySelection = Exclude<PolicyMode, 'never'>;
export type PolicyModeSource = 'config' | 'session';

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value);
}

// 旧版本里的 `none` 与 `never` 都不能自行升级。`never` 的字符串无法区分新旧语义，
// 因此按旧数据读取时一律降级为 `ask`，只有新版写入的显式标记才认作新的 `never`。
export function readPolicyMode(value: unknown, legacy: boolean): PolicyMode | undefined {
  // 旧语义数据里 `none`/`never` 都不代表“跳过审批”，按保守值 `ask` 读；
  // 反过来，旧数据里的 `always` 不存在，无法自证时也不能当成新档位。
  if (value === 'none') return legacy ? 'ask' : undefined;
  if (value === 'never') return legacy ? 'ask' : 'never';
  if (value === 'always') return legacy ? undefined : 'always';
  return value === 'ask' || value === 'auto' ? value : undefined;
}

// 持久化记录（Session 事件、配置、授权文件）用它标记新四档语义。
// 没有标记的历史值必须按旧语义读取：`none`/`never` 都降级为 `ask`，
// 这样旧数据里的 `never`（旧含义是拒绝一切）永远不会被读成跳过审批。
export const POLICY_SEMANTICS = 2;

export function readPersistedPolicyMode(value: unknown, semantics: unknown): PolicyMode | undefined {
  if (semantics !== undefined) return semantics === POLICY_SEMANTICS && isPolicyMode(value) ? value : undefined;
  return readPolicyMode(value, true);
}

function isPortableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/]/u.test(value);
}

/** 规则表条目来自配置文件，类型定义在 `config-edit.ts`；这里重新导出，避免调用方多引一个模块。 */
export type { PolicyRule } from './config-edit.js';

export function isPolicyRule(value: unknown): value is PolicyRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return 'tool' in value && typeof value.tool === 'string'
    && 'decision' in value && (value.decision === 'allow' || value.decision === 'ask' || value.decision === 'deny')
    && (!('match' in value) || value.match === undefined || typeof value.match === 'string')
    && (!('reason' in value) || value.reason === undefined || typeof value.reason === 'string')
    && (!('target' in value) || value.target === undefined || value.target === 'file' || value.target === 'workspace')
    && (!('path' in value) || value.path === undefined || typeof value.path === 'string')
    && (!('argsHash' in value) || value.argsHash === undefined || typeof value.argsHash === 'string')
    && ((rule.target === undefined && rule.path === undefined) || (rule.target !== undefined && typeof rule.path === 'string' && isPortableAbsolutePath(rule.path)))
    && !(rule.target !== undefined && (rule.match !== undefined || rule.argsHash !== undefined))
    && (rule.argsHash === undefined || /^[a-f0-9]{64}$/u.test(String(rule.argsHash)));
}

export interface PolicyThresholds {
  readonly consecutive: number;
  readonly total: number;
}

export interface PolicyQuestion {
  readonly tool: string;
  readonly input: unknown;
  readonly command: string | undefined;
  readonly reason: string | undefined;
  readonly policy: PolicyMode;
  readonly policySource: PolicyModeSource;
  readonly policyForced: boolean;
  readonly rememberable: boolean;
  readonly shell?: string;
  readonly executable?: string;
  readonly scriptBinding?: ScriptBinding;
  readonly callId?: string;
  readonly identityDigest?: string;
}

export type PolicyAskResult =
  | {
      readonly decision: 'allow';
      readonly source?: 'human' | 'controller';
      readonly rememberScope?: 'session' | 'project' | 'user';
      readonly rememberTarget?: 'file' | 'workspace' | 'tool' | 'command';
    }
  | { readonly decision: 'deny'; readonly code?: string; readonly reason?: string; readonly source?: 'human' | 'controller' }
  | { readonly decision: 'unavailable' | 'error' | 'cancelled' | 'timeout'; readonly code: string; readonly reason?: string };

export type PolicyAsk = (question: PolicyQuestion) => boolean | PolicyAskResult | Promise<boolean | PolicyAskResult>;
export type PolicyGuard = (call: { readonly tool: string; readonly input: unknown; readonly command: string | undefined }) => string | undefined;

/**
 * 复审请求只包含当前动作本身。可信事实（用户约束、规则、Grant、边界）由 Host 侧闭包持有，
 * Kernel 不把会话内容交给模型。
 */
export interface PolicyReviewRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly command: string | undefined;
  readonly reason: string | undefined;
  readonly policy: PolicyMode;
  readonly callId?: string;
  readonly identityDigest?: string;
  readonly shell?: string;
  readonly executable?: string;
  readonly scriptBinding?: ScriptBinding;
  // Run 的取消信号：复审请求必须随 Run 一起中止，取消后到达的结论作废。
  readonly signal?: AbortSignal;
}

export interface PolicyReviewRecord {
  readonly decision: 'allow' | 'deny' | 'ask-human';
  readonly reasonCode?: string;
  readonly fingerprint?: string;
  readonly inputVersion?: number;
  readonly reason?: string;
  /** 实际进入复审提示词的事件序号；预算丢掉的历史不在其中。 */
  readonly includedSeqs?: readonly number[];
}

export type PolicyReviewOutcome = PolicyReviewRecord;

/**
 * 复审只在这三种结果间做选择：允许、拒绝、转人工（`allow` / `deny` / `ask-human`）。
 * “不可用”（模型/JSON/超时/预算失败）不是第四种结果，而是 `ask-human` 加一个原因码：
 * 两者都继续走原有审批通道，绝不当成放行。
 */
export type PolicyReview = (request: PolicyReviewRequest) => PolicyReviewOutcome | Promise<PolicyReviewOutcome>;

export interface DecisionChainOptions {
  readonly mode?: PolicyMode;
  readonly rules?: PolicyRule[];
  readonly thresholds?: PolicyThresholds;
  readonly ask?: PolicyAsk;
  readonly review?: PolicyReview;
}

export interface PolicyVerdict {
  decision: 'allow' | 'deny';
  via: string;
  capability: string;
  level: PolicyMode;
  forced?: true;
  code?: string;
  reason?: string;
  rule?: string;
  answer?: string;
  segments?: string[];
  scriptBinding?: ScriptBinding;
  review?: PolicyReviewRecord;
}

export interface DecisionChain {
  readonly mode: PolicyMode;
  readonly modeSource: PolicyModeSource;
  configuredMode(): PolicyMode;
  resetMode(): void;
  setMode(mode: PolicyMode): void;
  setConfiguredMode(mode: PolicyMode): void;
  setRules(rules: PolicyRule[]): void;
  readonly rules: PolicyRule[];
  denials(): { consecutive: number; total: number };
  snapshot(): PolicyState;
  restore(snapshot: PolicyState): void;
  guard(check: PolicyGuard): () => boolean;
  evaluate(input: PolicyCall): Promise<PolicyVerdict>;
}

export interface PolicyState {
  readonly override: PolicyMode | null;
  readonly consecutive: number;
  readonly total: number;
  readonly forcedToAsk: boolean;
}

export interface PolicyCall {
  readonly tool: string;
  readonly input: unknown;
  readonly target?: NetworkTarget;
  readonly shell?: ShellSelection;
  readonly capability?: string;
  readonly access?: PermissionAccess;
  // 参数中不含命令字符串的工具由 Kernel 合成的最终命令行；按命令前缀匹配的规则以此判定。
  readonly command?: string;
  readonly scriptBinding?: ScriptBinding;
  readonly scriptBindingError?: { readonly code: string; readonly detail: string };
  readonly requiresManualApproval?: boolean;
  readonly fileBoundary?: string;
  readonly workingDirectory?: string;
  readonly callId?: string;
  readonly identityDigest?: string;
  // 这次调用所属 Run 的取消信号；复审要跟着它一起及时停下。
  readonly signal?: AbortSignal;
}

// 拒绝阈值和默认策略由配置层提供。
export const DEFAULT_THRESHOLDS: PolicyThresholds = Object.freeze({ consecutive: 3, total: 20 });

// 明确列出写入记录的判定字段，避免后续增加的内部数据意外进入记录。
export const VERDICT_FIELDS = Object.freeze(['capability', 'decision', 'via', 'level', 'forced', 'rule', 'answer', 'review'] as const);

// 用户提问使用独立的请求和答复流程，不属于工具审批。
const UNASKED = new Set(['ask_user_question']);

// 自动策略不会直接放行脚本解释器，因为它们可以执行任意代码。
const INTERPRETERS: readonly string[] = [
  'bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd',
  'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php',
];
const COMMAND_WRAPPERS: readonly string[] = [
  'sudo', 'su', 'doas', 'env', 'command', 'exec', 'source', '.', 'import-module', 'busybox', 'timeout', 'nohup', 'setsid', 'xargs',
  'start-process', 'invoke-expression', 'iex', 'eval', 'npm', 'npx', 'pnpm', 'yarn', 'make',
  'awk', 'gawk', 'mawk', 'nawk',
];
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|ps1|psm1|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php)$/u;
const UP = `..${sep}`;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key])]));
}

export function policyArgsHash(input: unknown, identityDigest = ''): string {
  const serialized = JSON.stringify(stableValue(input));
  return createHash('sha256').update(identityDigest).update('\0').update(serialized).digest('hex');
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withinPath(parent: string, child: string): boolean {
  const part = relative(resolve(parent), resolve(child));
  return part === '' || (part !== '..' && !part.startsWith(UP) && !isAbsolute(part));
}

function commandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input) || typeof input.command !== 'string') return undefined;
  // 空白命令由工具参数校验返回稳定错误码；策略层不把它当作无法识别的命令。
  return input.command.trim() === '' ? undefined : input.command;
}

function commandCwd(input: unknown): string | undefined {
  return typeof input === 'object' && input !== null && 'cwd' in input && typeof input.cwd === 'string'
    ? input.cwd
    : undefined;
}

// 自动放行使用与危险命令分类相同的解析结果；动态命令名和解释器包装必须逐次审批。
function canAutoApprove(inspection: CommandInspection | undefined): boolean {
  if (inspection?.parsed.kind !== 'segments' || inspection.invocations.length === 0) return false;
  return inspection.invocations.every((invocation) => {
    if (invocation.executableDynamic === true || (invocation.executableNested?.length ?? 0) > 0) return false;
    const source = invocation.executable;
    if (source.includes('/') || source.includes('\\')) return false;
    const executable = source.replaceAll('\\', '/').split('/').at(-1) ?? '';
    const name = executable.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '');
    return !INTERPRETERS.includes(name) && !COMMAND_WRAPPERS.includes(name) && !SCRIPT_EXTENSIONS.test(name);
  });
}

// 需要审批时附上解析器状态、无法识别的命令构造和所用语法，让界面可以说明原因。
// 只有这个函数负责“为什么需要审批”的解释文案，因此统一用中文；机器可判断的信息由稳定错误码提供。
// 危险命令分类的拒绝理由另在 classifyDangerousCommand 里给出，那里的措辞不经过这里。
function askReason(parsed: ParsedCommand | undefined, target: NetworkTarget | undefined, shell: ShellSelection | undefined): string | undefined {
  const kind = shell?.kind ?? 'bash';
  if (parsed?.kind === 'unavailable') return `${kind} 的命令语法解析器用不了：${parsed.detail}`;
  if (parsed?.kind === 'unsupported') return `${kind} 的这一条命令没能完整读下来：${parsed.construct}`;
  if (target?.class === 'loopback' || target?.class === 'private') {
    return `地址 ${target.addresses.join(', ')} 属于 ${target.class}，这一次取回要你明确点头`;
  }
  return undefined;
}

// `ask` 是 Host 注入的用户审批通道。未提供该通道时，所有需要审批的调用都会被拒绝。
export function createDecisionChain({ mode = 'ask', rules = [], thresholds = DEFAULT_THRESHOLDS, ask, review }: DecisionChainOptions = {}): DecisionChain {
  if (!isPolicyMode(mode)) throw new KernelError('policy_mode_unknown');
  if (!(thresholds.consecutive >= 1) || !(thresholds.total >= 1)) throw new KernelError('policy_thresholds_required');

  let current = mode;
  // 会话可以覆盖配置默认值；保留 `configured`，以便会话撤销覆盖时恢复默认策略。
  let configured = mode;
  let source: PolicyModeSource = 'config';
  let currentRules = rules;
  let forcedToAsk = false;
  let consecutive = 0;
  let total = 0;
  const guards = new Set<PolicyGuard>();

  function recordDenial(): void {
    consecutive += 1;
    total += 1;
    // 拒绝次数达到阈值后降为逐次审批；策略只会收紧，不会因此放宽。
    if (consecutive >= thresholds.consecutive || total >= thresholds.total) forcedToAsk = true;
  }

  function recordApproval(): void {
    consecutive = 0;
    total = 0;
    forcedToAsk = false;
  }

  return {
    // 守卫只能返回拒绝理由或不作判断，后续守卫不能撤销之前的拒绝。
    guard(check: PolicyGuard) {
      if (typeof check !== 'function') throw new KernelError('guard_check_required');
      guards.add(check);
      return () => guards.delete(check);
    },

    get mode() {
      // always 本身就要求每次审批，拒绝阈值不会把它收紧成 ask。
      return forcedToAsk && current !== 'never' && current !== 'always' ? 'ask' : current;
    },

    // 标明当前策略来自配置默认值还是会话覆盖；拒绝阈值触发的收紧状态单独记录在 `forced`。
    get modeSource() {
      return source;
    },

    configuredMode() {
      return configured;
    },

    // 撤销运行期的会话覆盖，恢复配置中的默认策略。
    resetMode() {
      current = configured;
      source = 'config';
    },

    setMode(next: PolicyMode) {
      if (!isPolicyMode(next)) throw new KernelError('policy_mode_unknown');
      current = next;
      source = 'session';
    },

    // 配置默认值变化时，只更新未设置会话覆盖的策略。
    setConfiguredMode(next: PolicyMode) {
      if (!isPolicyMode(next)) throw new KernelError('policy_mode_unknown');
      configured = next;
      if (source === 'config') current = next;
    },

    // 配置规则写入后立即影响后续判定，不重置守卫、拒绝计数或强制审批状态。
    setRules(next: PolicyRule[]) {
      if (!Array.isArray(next)) throw new KernelError('policy_rules_invalid');
      currentRules = next;
    },

    get rules() {
      return currentRules;
    },

    denials() {
      return { consecutive, total };
    },

    snapshot() {
      return { override: source === 'session' ? current : null, consecutive, total, forcedToAsk };
    },

    restore(snapshot: PolicyState) {
      if (snapshot === null || typeof snapshot !== 'object'
        || (snapshot.override !== null && !isPolicyMode(snapshot.override))
        || !Number.isSafeInteger(snapshot.consecutive) || snapshot.consecutive < 0
        || !Number.isSafeInteger(snapshot.total) || snapshot.total < snapshot.consecutive
        || typeof snapshot.forcedToAsk !== 'boolean') {
        throw new KernelError('policy_state_invalid');
      }
      if (snapshot.override === null) {
        current = configured;
        source = 'config';
      } else {
        current = snapshot.override;
        source = 'session';
      }
      consecutive = snapshot.consecutive;
      total = snapshot.total;
      forcedToAsk = snapshot.forcedToAsk;
    },

    async evaluate({ tool, input, target, shell, capability, access, command: composedCommand, scriptBinding, scriptBindingError, requiresManualApproval: manualApprovalRequired,
      fileBoundary, workingDirectory, callId, identityDigest, signal }: PolicyCall): Promise<PolicyVerdict> {
      if (typeof tool !== 'string' || tool === '') throw new KernelError('policy_call_tool_required');
      // 使用工具声明的实际能力名称进行判定。MCP 调用使用 `mcp:<服务器>/<工具>`，而不是通用工具名 `mcp.call`。
      const named = capability ?? tool;
      // 用户提问不进入工具审批链。审批决定是否允许操作，提问请求用户提供信息。
      // 提问通道由 Host 管理，不能由策略档位或规则表启用、禁用。
      if (capability === undefined && UNASKED.has(named)) {
        return { decision: 'allow', via: 'unasked', capability: named, level: current, ...(forcedToAsk ? { forced: true } : {}) };
      }

      const command = composedCommand ?? commandOf(input);
      // `never` 跳过整个策略审批层：不应用规则、不因危险分析或脚本解释器升级为审批、也不询问。
      // 硬性安全校验（网络目标类别、守卫、脚本绑定、Permission）在下面照常执行。
      const applyRules = current !== 'never';
      let effective: PolicyMode = current === 'always' || current === 'never' || !forcedToAsk ? current : 'ask';
      // 记录此次判定时的有效策略；拒绝阈值触发的收紧状态另行记录。
      const judged = (decision: PolicyVerdict['decision'], via: string, extra: Omit<PolicyVerdict, 'decision' | 'via' | 'capability' | 'level' | 'forced'>, hardDenied = false): PolicyVerdict => ({
        decision,
        via,
        capability: named,
        level: current,
        ...(forcedToAsk || hardDenied ? { forced: true } : {}),
        ...extra,
      });
      let currentFilePath: string | undefined;
      const inputPath = typeof input === 'object' && input !== null && 'path' in input && typeof input.path === 'string'
        ? input.path
        : undefined;
      if (inputPath !== undefined && fileBoundary !== undefined && workingDirectory !== undefined) {
        try { currentFilePath = await resolveWithin(fileBoundary, inputPath, { cwd: workingDirectory }); }
        catch { /* Invalid paths cannot match a remembered allow and remain subject to the tool's path check. */ }
      }
      const argsHash = policyArgsHash(input, identityDigest);
      // 一条规则是否作用于这一次调用：工具、文件/工作区范围与参数指纹都要对上。
      // 复审返回后重验拒绝规则时也用它，范围规则不会被漏掉。
      const inScope = (item: PolicyRule): boolean => {
        if (item.tool !== named) return false;
        if (item.target !== undefined || item.path !== undefined) {
          if (currentFilePath === undefined || item.path === undefined || !isAbsolute(item.path)) return false;
          return item.target === 'file'
            ? samePath(item.path, currentFilePath)
            : item.target === 'workspace' && withinPath(item.path, currentFilePath);
        }
        if (item.argsHash !== undefined) return item.argsHash === argsHash;
        return true;
      };
      const candidates = !applyRules ? [] : currentRules.filter(inScope);
      // 先按 Host 选择的语法解析命令，再逐段应用规则。解析不完整时将整条命令视为无法确认。
      const kind = shell?.kind ?? 'bash';
      const inspection = command === undefined ? undefined : await inspectCommand(command, kind);
      const parsed = inspection?.parsed;
      const segments = parsed?.kind === 'segments' ? parsed.segments : undefined;
      // 没有命令文本的调用仍作为一个分段应用规则检查。
      const parts = command === undefined ? [undefined] : segments;
      // 规则命中“整条命令”或“解析出的任一分段”都算命中：问句规则、拒绝规则与复审后的收紧复查共用这一处判定。
      const ruleHits = (item: PolicyRule): boolean =>
        matches(command, item.match) || (segments ?? []).some((segment) => matches(segment, item.match));
      const askedRule = candidates.find((item) => item.decision === 'ask' && ruleHits(item));
      if (askedRule !== undefined) effective = 'ask';
      // 在结果中包含解析分段，便于从记录中还原命令如何被解释。
      // 无命令文本或无法解析时不返回分段字段。
      // 放行结果一律带回脚本绑定，让执行前的重绑定校验对规则、自动与 never 三条路径同样生效。
      const answer = (via: string, rule?: PolicyRule) => judged('allow', via, {
        ...(segments === undefined ? {} : { segments }),
        ...(rule?.match === undefined ? {} : { rule: rule.match }),
        ...(scriptBinding === undefined ? {} : { scriptBinding }),
      });

      const refuse = (code: string, via: string, reason: string, rule?: string, reply?: string, countsAsDenial = true): PolicyVerdict => {
        if (countsAsDenial) recordDenial();
        return judged('deny', via, {
          code,
          reason,
          ...(rule === undefined ? {} : { rule }),
          ...(reply === undefined ? {} : { answer: reply }),
        });
      };

      const hardDeny = (reason: string): PolicyVerdict => {
        recordDenial();
        return judged('deny', 'hard-deny', { code: 'policy_hard_denied', reason }, true);
      };

      let requiresManualApproval = manualApprovalRequired === true || access === 'external' || access === 'unknown';
      let rememberable = manualApprovalRequired !== true && access !== 'external' && access !== 'unknown';
      let manualApprovalReason = manualApprovalRequired === true
        ? 'Git may execute project hooks, helpers, or configured aliases; the user must approve each call.'
        : access === 'external'
        ? 'this operation runs in an external process that the built-in sandbox cannot confine'
        : access === 'unknown'
          ? 'this tool has no permission classification and requires per-call approval'
          : undefined;
      if (askedRule !== undefined) {
        requiresManualApproval = true;
        manualApprovalReason = askedRule.reason ?? `${named} requires approval by its policy rule`;
      }
      // 复审只处理“确定性策略认不出命令形状”这一类不确定；规则询问属于强制人工检查点。
      let reviewable = false;
      if (command !== undefined) {
        if (segments === undefined || !canAutoApprove(inspection)) {
          requiresManualApproval = true;
          rememberable = false;
          manualApprovalReason ??= askReason(parsed, target, shell) ?? '命令使用脚本解释器或包装器，需要逐次审批';
          reviewable = manualApprovalRequired !== true && access !== 'external' && access !== 'unknown';
        }
        const classified = await classifyDangerousCommand(command, kind, inspection, commandCwd(input));
        if (classified?.kind === 'hard-deny') return hardDeny(classified.reason);
        if (classified?.kind === 'approval') {
          requiresManualApproval = true;
          rememberable = false;
          reviewable = false;
          manualApprovalReason ??= parsed?.kind === 'segments'
            ? classified.reason
            : askReason(parsed, target, shell) ?? classified.reason;
        }
      }

      // 先拒绝格式不支持的 URL 和不允许访问的网络地址，再进行后续权限判定。
      if (target !== undefined && (target.failure !== undefined || target.class === undefined)) {
        return refuse('policy_denied', 'target', `分不出这一个网络目标的类别（${target.failure ?? 'unsupported'}）`);
      }
      if (target?.class === 'link-local' || target?.class === 'unspecified') {
        return refuse('policy_denied', 'target', `${target.class} 这一类地址（链路本地、元数据端点、组播与保留段）不在这一趟运行里取回`);
      }
      const loopOrPrivate = target?.class === 'loopback' || target?.class === 'private';
      if (loopOrPrivate) {
        rememberable = false;
        reviewable = false;
        manualApprovalReason ??= askReason(parsed, target, shell);
      }

      // 任一匹配规则拒绝时就拒绝调用，后续放行规则不能覆盖拒绝。
      // 命令规则同时检查整条命令和每个分段（ruleHits），以拦截管道中的危险命令。
      const denied = candidates.find((item) => item.decision === 'deny' && ruleHits(item));
      if (denied) {
        return refuse('policy_denied', 'rule', denied.reason ?? `${named} 被规则表拒绝`, denied.match);
      }

      for (const check of guards) {
        const reason = check({ tool: named, input, command });
        if (typeof reason === 'string') return refuse('guard_denied', 'guard', reason);
      }

      if (scriptBindingError !== undefined) {
        return refuse(scriptBindingError.code, 'script-binding', scriptBindingError.detail);
      }

      // `never` 跳过整个策略审批层。走到这里说明硬性安全校验都没有拦它，直接放行。
      if (!applyRules) return answer('never');

      // `always` 让每一次工具调用都单独询问：规则里的放行、自动分类与已记住的批准都不能免除审批。
      if (effective === 'always') {
        requiresManualApproval = true;
        rememberable = false;
        manualApprovalReason ??= 'Always mode asks about every tool call.';
      }

      const allowed = candidates.filter((item) => item.decision === 'allow');
      // 记录实际匹配的放行规则模式，便于解释判定结果。
      const covering = () => (parts === undefined ? undefined : allowed.find((item) => parts.every((segment) => matches(segment, item.match))));
      let covered;
      if (loopOrPrivate) {
        // 环回和私有网络地址至少需要一次审批；宽泛的字符串规则无法可靠确认最终连接地址。
        covered = undefined;
      } else if (command === undefined) {
        // 不含命令文本的调用不受命令语法检查影响；自动策略可放行，逐次审批仍需匹配放行规则。
        covered = effective === 'auto' ? null : covering();
      } else if (effective === 'auto') {
        // 自动策略只放行可完整解析且每段首词都不是脚本解释器的命令。
        // 不剥离解释器包装；例如 `bash -lc "git status"` 仍须审批。
        covered = segments !== undefined && canAutoApprove(inspection) ? null : undefined;
      } else {
        // 逐次审批要求放行规则覆盖每个命令分段；无法解析的命令不能视为已覆盖。
        covered = segments !== undefined && parts?.every((segment) => allowed.some((item) => matches(segment, item.match)))
          ? covering()
          : undefined;
      }
      if (requiresManualApproval) covered = undefined;
      if (covered !== undefined) {
        return covered === null ? answer('auto') : answer('rules', covered);
      }

      // `auto` 下只有“命令形状认不出”这一种不确定可以交给配置好的复审；
      // 规则询问、强制人审、外部进程、无法分类的工具与私有网络都不交模型改判。
      // 复审不可用（未配置、超时、超预算、回复不合法）都退回人工审批，绝不当成放行。
      if (typeof review === 'function' && effective === 'auto' && reviewable) {
        // 复审是异步请求；期间的策略切换或规则变更会让结论失效，先留一份签名用于复核。
        // 拒绝阈值也会收紧语义：连续拒绝后 `forcedToAsk` 生效，mode 仍然是 auto。
        const modeSignature = `${current}:${forcedToAsk}`;
        const rulesSignature = JSON.stringify(currentRules);
        let outcome: PolicyReviewRecord | undefined;
        try {
          outcome = await review({
            tool: named,
            input,
            command,
            reason: manualApprovalReason,
            policy: effective,
            ...(callId === undefined ? {} : { callId }),
            ...(identityDigest === undefined ? {} : { identityDigest }),
            ...(shell === undefined ? {} : { shell: shell.kind, executable: shell.executable }),
            ...(scriptBinding === undefined ? {} : { scriptBinding }),
            ...(signal === undefined ? {} : { signal }),
          });
        } catch {
          outcome = undefined;
        }
        // 过期结论必须作废：回到确定性与人工审批路径，而不是拿旧判定放行或拒绝。
        // 复审抛错时同样要重验：异常不能让等待期间新增的拒绝规则失效。
        // Run 被取消后到达的结论同样作废——那次调用已经不该执行了。
        const changed = `${current}:${forcedToAsk}` !== modeSignature || JSON.stringify(currentRules) !== rulesSignature
          || signal?.aborted === true;
        if (changed) {
          outcome = undefined;
          // 取消优先于规则收紧：Run 已经取消时这次调用本来就不该执行，报“被规则拒绝”
          // 还会把拒绝计数加一，把下一次运行的错误归到这次取消上。
          if (signal?.aborted === true) {
            return refuse('run_cancelled', 'ask', 'Run 已取消，这次调用不再执行', undefined, 'cancelled', false);
          }
          // 作废不等于忽略新规则：等待期间新增的 deny 要当场生效，否则会落到可被批准的分支。
          const tightened = currentRules.filter(inScope).find((item) => item.decision === 'deny' && ruleHits(item));
          if (tightened !== undefined) return refuse('policy_denied', 'rule', tightened.reason ?? '等待复审期间规则表收紧了这一次调用', tightened.match);
        }
        if (outcome !== undefined && outcome.decision === 'allow') {
          recordApproval();
          return { ...answer('auto-reviewer'), review: outcome };
        }
        if (outcome !== undefined && outcome.decision === 'deny') {
          return refuse(outcome.reasonCode ?? 'reviewer_denied', 'auto-reviewer', outcome.reason ?? '复审拒绝了这一次调用', undefined, 'deny');
        }
      }

      // 复审期间 Run 被取消时不再发起新的审批：取消只结清当时已经登记的请求，
      // 之后登记的审批可能永远等不到人回答，Run 也就无法及时结束。
      if (signal?.aborted === true) {
        return refuse('run_cancelled', 'ask', 'Run 已取消，这次调用不再执行', undefined, 'cancelled', false);
      }

      // 自动策略无法识别命令时转为逐次审批，并返回无法自动放行的原因。
      const reason = requiresManualApproval
        ? manualApprovalReason
        : askReason(parsed, target, shell);
      if (typeof ask !== 'function') return refuse('ask_unavailable', 'ask', reason ?? '这一条连接上没有问人的通道', undefined, 'unavailable', false);
      // 审批请求包含 Host 实际使用的语法和可执行文件，避免用户批准一种解释、实际执行另一种。
      // 不含命令文本时省略这两个字段。将当前策略及来源随请求返回，确保客户端显示的是本次调用所属会话的状态。
      // `policyForced` 标记策略是否因连续拒绝而收紧。
      const question: PolicyQuestion = {
        tool: named,
        input,
        command,
        reason,
        policy: effective,
        policySource: source,
        policyForced: forcedToAsk,
        rememberable,
        ...(scriptBinding === undefined ? {} : { scriptBinding }),
        ...(shell === undefined ? {} : { shell: shell.kind, executable: shell.executable }),
        ...(callId === undefined ? {} : { callId }),
        ...(identityDigest === undefined ? {} : { identityDigest }),
      };
      let response: boolean | PolicyAskResult;
      try {
        response = await ask(question);
      } catch (error) {
        const code = error instanceof KernelError ? error.code : 'policy_approval_channel_error';
        return refuse(code, 'ask', 'approval channel failed', undefined, 'error', false);
      }
      if (response === false) return refuse('ask_declined', 'ask', 'the user declined', undefined, 'deny');
      // 审批期间 Run 被取消时，人给出的 allow 已经过期：这次调用不会再执行，
      // 拿它当批准还会把拒绝阈值之外的状态改掉。取消后只报取消，不计拒绝。
      const allowAfterApproval = (): PolicyVerdict => {
        if (signal?.aborted === true) {
          return refuse('run_cancelled', 'ask', 'Run 已取消，这次调用不再执行', undefined, 'cancelled', false);
        }
        recordApproval();
        return { ...judged('allow', 'ask', { ...(segments === undefined ? {} : { segments }), answer: 'allow' }), ...(scriptBinding === undefined ? {} : { scriptBinding }) };
      };
      if (response === true) return allowAfterApproval();
      switch (response.decision) {
        case 'allow': return allowAfterApproval();
        case 'deny': {
          const explicitHumanDenial = response.source === undefined || response.source === 'human';
          const reason = response.reason ?? (explicitHumanDenial ? 'the user declined' : 'the controller declined');
          return refuse(response.code ?? 'ask_declined', 'ask', reason, undefined, 'deny', explicitHumanDenial);
        }
        case 'unavailable':
        case 'error':
        case 'cancelled':
        case 'timeout':
          return refuse(response.code, 'ask', response.reason ?? 'approval was not completed', undefined, response.decision, false);
      }
      return refuse('policy_approval_result_invalid', 'ask', 'approval channel returned an unknown result', undefined, 'error', false);
    },
  };
}
