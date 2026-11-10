import { createHash } from 'node:crypto';
import { KernelError } from '../kernel/error.js';

const PREVIEW_CHARACTERS = 512;
const DISPLAY_TEXT_CHARACTERS = 2048;
const MAX_SUMMARY_BYTES = 16_384;

export interface ApprovalSummaryInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly callId?: string;
  readonly identityDigest?: string;
  readonly tool: string;
  readonly args: unknown;
  readonly command?: string;
  readonly reason?: string;
  readonly policy?: string;
  readonly policySource?: string;
  readonly policyForced?: boolean;
  readonly shell?: string;
  readonly executable?: string;
}

export interface ApprovalSummary extends Record<string, unknown> {
  readonly requestId: string;
  readonly sessionId: string;
  readonly detailsRef: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly argumentBytes: number;
  readonly argumentSha256: string;
  readonly preview: string;
  readonly rememberable: boolean;
  readonly rememberHintKey: 'file' | 'command' | 'tool';
  readonly rememberTargetOptions: readonly ('file' | 'workspace' | 'tool' | 'command')[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function displayText(value: string, maximum = DISPLAY_TEXT_CHARACTERS): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return clean.length > maximum ? `${clean.slice(0, maximum)}…` : clean;
}

function contentOf(tool: string, args: Record<string, unknown>): string | undefined {
  if ((tool === 'create' || tool === 'write') && typeof args.content === 'string') return args.content;
  if (tool === 'edit' && typeof args.replacement === 'string') return args.replacement;
  if (tool === 'edit' && Array.isArray(args.changes)) {
    return args.changes.map((change, index) => {
      if (!isRecord(change)) return `Change ${index + 1}: invalid`;
      const oldText = typeof change.oldText === 'string' ? change.oldText : '(missing oldText)';
      const newText = typeof change.newText === 'string' ? change.newText : '(missing newText)';
      return `Change ${index + 1}:\n- ${oldText}\n+ ${newText}`;
    }).join('\n');
  }
  return undefined;
}

export function containsSensitiveMaterial(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\bBearer\s+\S+/iu.test(value)
      || /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Basic|Digest|Token)\s+\S+/iu.test(value)
      || /(?:^|[^A-Za-z0-9_-])(?:x[-_]api[-_]key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret)\s*[:=]\s*["']?[^\s"'\x00-\x1f]+/iu.test(value)
      || /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u.test(value)
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)
      || /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSensitiveMaterial);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:^|[-_])(?:api[-_]?key|authorization|proxy[-_]?authorization|cookie|set-cookie|password|passwd|secret|credential|credentials|access[-_]?token|refresh[-_]?token|bearer)(?:$|[-_])/iu.test(key)
      && nested !== undefined && nested !== null && nested !== '') return true;
    if (containsSensitiveMaterial(nested)) return true;
  }
  return false;
}

export function summarizeApproval(input: ApprovalSummaryInput): ApprovalSummary {
  if (!isRecord(input.args)) throw new KernelError('policy_approval_unreviewable');
  if (containsSensitiveMaterial(input.args)
    || (input.command !== undefined && containsSensitiveMaterial(input.command))
    || (input.reason !== undefined && containsSensitiveMaterial(input.reason))) {
    throw new KernelError('control_interaction_sensitive');
  }
  const args = input.args;
  const serialized = stableJson(args);
  const argumentBytes = Buffer.byteLength(serialized, 'utf8');
  const argumentSha256 = sha256(serialized);
  const content = contentOf(input.tool, args);
  const preview = displayText(content ?? serialized, PREVIEW_CHARACTERS);
  const fileTool = ['create', 'write', 'edit', 'delete'].includes(input.tool);
  const mcpTool = input.tool.startsWith('mcp:');
  const safeArgs: Record<string, unknown> = {
    ...(typeof args.path === 'string' ? { path: displayText(args.path) } : {}),
    ...(input.command === undefined ? {} : { command: displayText(input.command) }),
    ...(content === undefined ? {} : {
      content: preview,
      contentCharacters: content.length,
      contentBytes: Buffer.byteLength(content, 'utf8'),
      contentSha256: sha256(Buffer.from(content, 'utf8')),
    }),
    ...(typeof args.url === 'string' ? { url: displayText(args.url) } : {}),
    ...(typeof args.server === 'string' ? { server: displayText(args.server) } : {}),
    ...(typeof args.tool === 'string' ? { toolName: displayText(args.tool) } : {}),
    argumentSha256,
  };
  const summary: ApprovalSummary = {
    requestId: input.requestId,
    sessionId: input.sessionId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.callId === undefined ? {} : { callId: displayText(input.callId, 160) }),
    ...(input.identityDigest === undefined ? {} : { identityDigest: input.identityDigest }),
    detailsRef: input.requestId,
    tool: displayText(input.tool, 256),
    args: safeArgs,
    ...(input.command === undefined ? {} : { command: displayText(input.command) }),
    ...(input.reason === undefined ? {} : { reason: displayText(input.reason, 1024) }),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.policySource === undefined ? {} : { policySource: input.policySource }),
    ...(input.policyForced === undefined ? {} : { policyForced: input.policyForced }),
    ...(input.shell === undefined ? {} : { shell: displayText(input.shell, 128) }),
    ...(input.executable === undefined ? {} : { executable: displayText(input.executable, 512) }),
    argumentBytes,
    argumentSha256,
    ...(content === undefined ? {} : {
      contentCharacters: content.length,
      contentBytes: Buffer.byteLength(content, 'utf8'),
      contentSha256: sha256(Buffer.from(content, 'utf8')),
    }),
    preview,
    rememberable: true,
    rememberHintKey: fileTool ? 'file' : input.command !== undefined ? 'command' : 'tool',
    rememberTargetOptions: fileTool ? ['file', 'workspace'] : mcpTool ? [] : input.command !== undefined ? ['command'] : ['tool'],
  };
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_SUMMARY_BYTES) {
    throw new KernelError('control_interaction_unreviewable');
  }
  return summary;
}

export function approvalArgsDigest(value: unknown): string {
  return sha256(stableJson(value));
}
