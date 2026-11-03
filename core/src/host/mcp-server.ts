import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createConfig } from '../kernel/config.js';
import { KernelError } from '../kernel/error.js';
import { DELEGATION_SPEC_SCHEMA, type DelegationSpec } from '../delegation.js';
import { createPermissionContext } from '../kernel/permission.js';
import { isTrusted } from '../kernel/workspace-trust.js';
import { createHost } from './host.js';
import { delegationPathOf, recordDelegationEvent, requireDelegationGrant } from './agent-control.js';
import { loadHostEnvironment } from './environment.js';
import { createControl, controlErrorCode, type McpInitialSettings, type McpSessionChanges } from './control.js';
import { createInteractivePermissionContext } from '../capability/permission-capabilities.js';

const id = { type: 'string', minLength: 1, maxLength: 160 };
const root = { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute project root authorized when this server started.' };
const providerDiagnostic = { type: 'object', additionalProperties: false, properties: {
  category: { type: 'string', enum: ['authentication', 'rate_limit', 'client', 'server', 'http', 'transport', 'stream', 'invalid_response', 'cancelled'] },
  status: { type: 'integer', minimum: 100, maximum: 599 },
  attempts: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  responseReceived: { type: 'boolean' }, streamReceived: { type: 'boolean' }, recoverable: { type: 'boolean' },
}, required: ['category', 'attempts', 'responseReceived', 'streamReceived', 'recoverable'] };
const taskLimitsOutput = {
  maxModelCalls: { type: 'integer', minimum: 1 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 86_400_000 },
  requestTimeoutMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
  interactionWaitTimeoutMs: { type: 'integer', minimum: 1, maximum: 604_800_000 },
};
const taskOutput = object({ ...taskLimitsOutput, modelCalls: { type: 'integer', minimum: 0 },
  interactionWaitMs: { type: 'integer', minimum: 0 }, executionElapsedMs: { type: 'integer', minimum: 0 },
  executionPaused: { type: 'boolean' },
  startedAt: { type: 'string' }, deadlineAt: { type: 'string' },
}, ['maxModelCalls', 'timeoutMs', 'requestTimeoutMs', 'modelCalls', 'startedAt', 'deadlineAt']);
const fileArtifactOutput = object({ kind: { type: 'string', enum: ['file'] }, sessionId: id,
  path: { type: 'string', minLength: 1, maxLength: 2048 }, mimeType: { type: 'string', maxLength: 128 },
  bytes: { type: 'integer', minimum: 0, maximum: 20 * 1024 * 1024 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  description: { type: 'string', maxLength: 400 },
}, ['kind', 'sessionId', 'path', 'mimeType', 'bytes', 'sha256']);
const runResultOutput = object({
  runId: id,
  sessionId: id,
  state: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
  stopReason: { type: 'string', enum: [
    'assistant_completed', 'tool_completed', 'cancelled', 'budget_exhausted', 'refused',
    'provider_error', 'tool_error', 'validation_failed', 'host_error', 'deadline_exceeded', 'request_timeout', 'interaction_timeout',
  ] },
  output: object({ text: { type: ['string', 'null'] }, structured: {}, partial: { type: 'boolean', const: true } }, ['text']),
  validation: object({
    status: { type: 'string', enum: ['not_requested', 'valid', 'invalid'] },
    schemaDigest: { type: 'string', minLength: 12, maxLength: 64 },
    errors: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 512 } },
  }, ['status']),
  artifacts: { type: 'array', maxItems: 32, items: { anyOf: [object({
    kind: { type: 'string', enum: ['session'] }, sessionId: id,
  }, ['kind', 'sessionId']), fileArtifactOutput] } },
  userSeq: { type: 'integer', minimum: 0 },
  artifactsTruncated: { type: 'boolean', const: true },
  task: taskOutput,
  usage: object({
    iterations: { type: ['integer', 'null'], minimum: 0 },
    modelCalls: { type: ['integer', 'null'], minimum: 0 },
  }, ['iterations', 'modelCalls']),
  diagnostic: object({ code: { type: 'string' }, provider: providerDiagnostic }, ['code']),
}, ['runId', 'sessionId', 'state', 'stopReason', 'output', 'validation', 'artifacts', 'usage']);
const durableReceiptOutput = object({
  runId: id, sessionId: id, userSeq: { type: 'integer', minimum: 0 },
  acceptedAt: { type: 'string' }, state: { type: 'string', enum: ['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] },
  liveness: { type: 'string', enum: ['alive', 'unknown'] }, reused: { type: 'boolean' }, requestKey: { type: 'string', maxLength: 128 },
  via: { type: 'string', enum: ['trusted-ui', 'agent-control-bridge', 'mcp'] },
  resolvedBy: { type: 'string', enum: ['permission-control', 'agent-control-bridge', 'caller-scope-default', 'controller-local', 'controller-grant'] },
  resultRef: object({ version: { type: 'integer', const: 1 }, name: { type: 'string', maxLength: 64 },
    bytes: { type: 'integer', minimum: 1, maximum: 16 * 1024 * 1024 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  }, ['version', 'name', 'bytes', 'sha256']),
}, ['runId', 'sessionId', 'userSeq', 'acceptedAt', 'state', 'liveness']);
const runPageOutput = object({ runId: id, json: { type: 'string', maxLength: 8192 }, offset: { type: 'integer', minimum: 0 },
  nextOffset: { type: ['integer', 'null'] }, totalCharacters: { type: 'integer', minimum: 0 },
}, ['runId', 'json', 'offset', 'nextOffset', 'totalCharacters']);
const operationProperties = {
  operationId: id, sessionId: id, state: { type: 'string', enum: ['running', 'done', 'failed', 'cancelled'] },
  reused: { type: 'boolean' }, receipt: durableReceiptOutput,
  source: { type: 'string', enum: ['human', 'controller'] },
  code: { type: 'string' }, summary: { type: 'string', maxLength: 2048 },
  diagnostics: providerDiagnostic, result: { anyOf: [{ type: 'null' }, runResultOutput] },
  phase: { type: ['string', 'null'] },
  waitingFor: { type: ['string', 'null'], enum: ['approval', 'input', null] },
  progress: { type: ['object', 'null'], properties: {
    phase: { type: 'string' }, startedAt: { type: 'number' }, phaseStartedAt: { type: 'number' },
    lastProgressAt: { type: 'number' }, modelCalls: { type: 'integer' }, toolCalls: { type: 'integer' }, outputTokens: { type: ['integer', 'null'] },
  } },
  updatedAt: { type: 'number' },
  pendingInteractions: { type: 'array', maxItems: 8, items: object({
    requestId: id, sessionId: id, operationId: id, type: { type: 'string', enum: ['approval', 'question'] },
    createdAt: { type: 'number' }, details: { type: 'object' },
  }, ['requestId', 'sessionId', 'operationId', 'type', 'createdAt', 'details']) },
  events: { type: 'array', maxItems: 50, items: object({
    cursor: { type: 'integer', minimum: 1 }, kind: { type: 'string' }, at: { type: 'number' }, sessionId: id, operationId: id,
    phase: { type: ['string', 'null'] }, progress: { type: 'object' }, code: { type: 'string' },
    requestId: id, interactionType: { type: 'string', enum: ['approval', 'question'] }, decision: { type: 'string', enum: ['allow', 'deny'] },
    answered: { type: 'integer' }, diagnostics: providerDiagnostic,
    source: { type: 'string', enum: ['human', 'controller'] },
    type: { type: 'string', enum: ['text', 'reasoning'] }, text: { type: 'string', maxLength: 8192 },
    from: { type: 'string', enum: ['external', 'human'] }, to: { type: 'string', enum: ['external', 'human'] },
    eventSeq: { type: ['integer', 'null'] }, eventKind: { type: 'string' },
    queueItemId: id, newOperationId: id, inputCharacters: { type: 'integer' }, cleared: { type: 'integer' },
  }, ['cursor', 'kind', 'at', 'sessionId', 'operationId']) },
  nextCursor: { type: 'integer', minimum: 0 }, hasMoreEvents: { type: 'boolean' }, eventGap: { type: 'boolean' },
  firstAvailableCursor: { type: 'integer', minimum: 1 }, currentOperationId: { type: ['string', 'null'] },
  queue: { type: 'array', maxItems: 16, items: object({
    queueItemId: id, acceptedAt: { type: 'number' }, inputCharacters: { type: 'integer' },
    source: { type: 'string', enum: ['human', 'controller'] },
  }, ['queueItemId', 'acceptedAt', 'inputCharacters', 'source']) },
  queuePaused: { type: 'boolean' },
};
function object(properties: Record<string, object>, required: string[]) {
  return { type: 'object' as const, properties, required, additionalProperties: false };
}
const operationOutput = object(operationProperties, ['operationId', 'sessionId', 'state']);
const awaitOutput = object({ ...operationProperties, timedOut: { type: 'boolean' } }, ['operationId', 'sessionId', 'state', 'timedOut']);
const sessionOutput = object({ sessionId: id, settingsApplied: { type: 'boolean' } }, ['sessionId']);
const sessionChanges = {
  type: 'object', additionalProperties: false, properties: {
    mode: { type: 'string', maxLength: 64 },
    policy: { type: 'string', enum: ['always', 'ask', 'auto', 'never', 'none', 'default'], description: 'always asks every time, ask follows the rule table then asks, auto follows the rule table then analyses the call, never skips the policy layer; legacy none is read as ask' },
    model: { type: ['object', 'null'], additionalProperties: false, properties: { provider: id, model: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['provider', 'model'] },
    thinking: { type: ['object', 'null'], additionalProperties: false, properties: { effort: { type: 'string', enum: ['default', 'none', 'low', 'high', 'max'] } }, required: ['effort'] },
    outputTokens: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    loopIterations: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    permission: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      profile: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'] },
      network: { type: 'string', enum: ['policy', 'unrestricted', 'disabled'] },
    } },
  },
  oneOf: [
    { maxProperties: 0 },
    { required: ['mode'], maxProperties: 1 },
    { required: ['policy'], maxProperties: 1 },
    { required: ['loopIterations'], maxProperties: 1 },
    { required: ['permission'], maxProperties: 1 },
    {
      not: { anyOf: [{ required: ['mode'] }, { required: ['policy'] }, { required: ['loopIterations'] }, { required: ['permission'] }] },
      anyOf: [{ required: ['model'] }, { required: ['thinking'] }, { required: ['outputTokens'] }],
    },
  ],
};
const initialSettings = {
  type: 'object', additionalProperties: false, properties: {
    mode: { type: 'string', maxLength: 64 },
    policy: { type: 'string', enum: ['always', 'ask', 'auto', 'never', 'none'], description: 'legacy none is read as ask' },
    model: { type: 'object', additionalProperties: false, properties: { provider: id, model: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['provider', 'model'] },
    thinking: { type: 'object', additionalProperties: false, properties: { effort: { type: 'string', enum: ['default', 'none', 'low', 'high', 'max'] } }, required: ['effort'] },
    outputTokens: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    loopIterations: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    permission: { type: 'object', additionalProperties: false, properties: {
      profile: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'] },
      network: { type: 'string', enum: ['policy', 'unrestricted', 'disabled'] },
    }, required: ['profile', 'network'] },
  },
};
const permissionOutput = object({
  profile: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'] },
  network: { type: 'string', enum: ['policy', 'unrestricted', 'disabled'] },
  capabilities: object({
    filesystemRead: { type: 'string', enum: ['full', 'partial', 'unavailable'] },
    filesystemWrite: { type: 'string', enum: ['full', 'partial', 'unavailable'] },
    network: { type: 'string', enum: ['full', 'partial', 'unavailable'] },
    process: { type: 'string', enum: ['full', 'partial', 'unavailable'] },
  }, ['filesystemRead', 'filesystemWrite', 'network', 'process']),
  profiles: object({
    readOnly: { type: 'string', enum: ['full', 'partial', 'unavailable'] },
    workspaceWrite: { type: 'string', enum: ['full', 'partial', 'unavailable'] },
  }, ['readOnly', 'workspaceWrite']),
  limitations: { type: 'array', items: { type: 'string' } },
  partialWorkspaceWriteConfirmationRequired: { type: 'boolean' },
  partialWorkspaceWriteConfirmed: { type: 'boolean' },
  workspaceTrusted: { type: 'boolean' },
  execution: object({ available: { type: 'boolean' }, code: { type: ['string', 'null'] }, reason: { type: ['string', 'null'] } }, ['available', 'code', 'reason']),
  changeAllowed: { type: 'boolean' }, changeReason: { type: 'string' },
}, ['profile', 'network', 'capabilities', 'profiles', 'limitations', 'partialWorkspaceWriteConfirmationRequired',
  'partialWorkspaceWriteConfirmed', 'workspaceTrusted', 'execution', 'changeAllowed']);
const delegationOutput = { type: ['object', 'null'], additionalProperties: false, properties: {
  grantId: id,
  maxPermissionProfile: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'] },
  maxNetwork: { type: 'string', enum: ['policy', 'unrestricted', 'disabled'] },
  allowedPolicies: { type: 'array', items: { type: 'string', enum: ['always', 'ask', 'auto', 'never'] } },
  allowedMcpServers: { type: 'array', items: { type: 'string' } },
  allowedMcpTools: { type: 'array', items: { type: 'string' } },
  allowScreenCapture: { type: 'boolean' },
}, required: ['grantId', 'maxPermissionProfile', 'maxNetwork', 'allowedPolicies', 'allowedMcpServers', 'allowedMcpTools'] };
const requestedChanges = { type: ['object', 'null'], additionalProperties: false, properties: {
  mode: { type: 'string' }, policy: { type: 'string' }, model: { type: ['object', 'null'] },
  thinking: { type: ['object', 'null'] }, outputTokens: { type: ['integer', 'null'] }, loopIterations: { type: 'integer' },
  permission: { type: 'object', additionalProperties: false, properties: {
    profile: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'] },
    network: { type: 'string', enum: ['policy', 'unrestricted', 'disabled'] },
  } },
} };
const configurationOutput = object({
  sessionId: id,
  requested: requestedChanges,
  delegation: delegationOutput,
  effective: { type: 'object', additionalProperties: false, properties: {
    mode: { type: ['string', 'null'] },
    loopIterations: { type: 'integer', minimum: 1 },
    taskLimits: object(taskLimitsOutput, ['maxModelCalls', 'timeoutMs', 'requestTimeoutMs']),
    permission: permissionOutput,
    screenCapture: object({ enabled: { type: 'boolean' }, source: { type: 'string', enum: ['none', 'startup', 'trusted-ui', 'grant'] }, changeAllowed: { type: 'boolean' } }, ['enabled', 'source']),
    search: object({ configured: { type: 'boolean' }, available: { type: 'boolean' },
      serviceId: { type: 'string', maxLength: 128 }, code: { type: 'string', maxLength: 128 } }, ['configured', 'available']),
    browser: object({ configured: { type: 'boolean' }, available: { type: 'boolean' }, permitted: { type: 'boolean' },
      paused: { type: 'boolean' }, connected: { type: 'boolean' }, changeAllowed: { type: 'boolean' },
      code: { type: 'string', maxLength: 128 } }, ['configured', 'available', 'permitted', 'paused', 'connected', 'changeAllowed']),
    policy: { type: 'object', additionalProperties: false, properties: {
      mode: { type: 'string', enum: ['always', 'ask', 'auto', 'never'] }, source: { type: 'string' }, default: { type: 'string' },
    }, required: ['mode', 'source', 'default'] },
    generation: { type: 'object', additionalProperties: false, properties: {
      model: { type: 'object', additionalProperties: false, properties: { provider: { type: 'string' }, model: { type: ['string', 'null'] } }, required: ['provider', 'model'] },
      thinking: { type: 'object', additionalProperties: false, properties: {
        supported: { type: 'boolean' }, efforts: { type: 'array', items: { type: 'string' } }, defaultEffort: { type: ['string', 'null'] }, effort: { type: 'string' },
      }, required: ['supported', 'efforts', 'defaultEffort', 'effort'] },
      outputTokens: { type: ['integer', 'null'] }, contextTokens: { type: ['integer', 'null'] }, maxOutputTokens: { type: ['integer', 'null'] },
    }, required: ['model', 'thinking', 'outputTokens', 'contextTokens', 'maxOutputTokens'] },
  }, required: ['mode', 'loopIterations', 'policy', 'permission', 'generation'] },
  pending: { type: ['object', 'null'], additionalProperties: false, properties: {
    mode: { type: ['string', 'null'] },
    loopIterations: { type: ['integer', 'null'], minimum: 1 },
    generation: { type: ['object', 'null'], additionalProperties: false, properties: {
      model: { type: 'object', additionalProperties: false, properties: { provider: { type: 'string' }, model: { type: ['string', 'null'] } }, required: ['provider', 'model'] },
      thinking: { type: 'object', additionalProperties: false, properties: {
        supported: { type: 'boolean' }, efforts: { type: 'array', items: { type: 'string' } }, defaultEffort: { type: ['string', 'null'] }, effort: { type: 'string' },
      }, required: ['supported', 'efforts', 'defaultEffort', 'effort'] },
      outputTokens: { type: ['integer', 'null'] }, contextTokens: { type: ['integer', 'null'] }, maxOutputTokens: { type: ['integer', 'null'] },
    }, required: ['model', 'thinking', 'outputTokens', 'contextTokens', 'maxOutputTokens'] },
  }, required: ['mode', 'loopIterations', 'generation'] },
  available: { type: 'object', additionalProperties: false, properties: {
    modes: { type: 'object', additionalProperties: false, properties: {
      modes: { type: 'array', maxItems: 128, items: object({ name: { type: 'string', maxLength: 64 }, layer: { type: 'string' } }, ['name', 'layer']) },
      invalid: { type: 'array', maxItems: 128, items: object({ name: { type: 'string', maxLength: 64 }, code: { type: 'string' } }, ['name', 'code']) },
      truncated: { type: 'boolean' },
    }, required: ['modes', 'invalid', 'truncated'] },
    policies: { type: 'array', items: { type: 'string' } },
    permissionProfiles: { type: 'array', items: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'] } },
    permissionNetworks: { type: 'array', items: { type: 'string', enum: ['policy', 'unrestricted', 'disabled'] } },
    services: { type: 'array', items: object({
      id, name: { type: 'string' }, api: { type: 'string', enum: ['chat-completions', 'messages'] },
      models: { type: 'array', items: object({
        id: { type: 'string', maxLength: 256 }, name: { type: 'string' }, contextTokens: { type: 'integer', minimum: 1 }, outputTokens: { type: 'integer', minimum: 1 },
        thinking: { type: 'object', additionalProperties: false, properties: {
          supported: { type: 'boolean' }, efforts: { type: 'array', items: { type: 'string' } }, defaultEffort: { type: ['string', 'null'] },
        }, required: ['supported', 'efforts', 'defaultEffort'] },
      }, ['id', 'thinking']) },
    }, ['id', 'name', 'api', 'models']) },
  }, required: ['modes', 'policies', 'permissionProfiles', 'permissionNetworks', 'services'] },
  denials: { type: 'object', additionalProperties: false, properties: {
    consecutive: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 0 },
  }, required: ['consecutive', 'total'] },
  applies: { type: 'string', enum: ['now', 'next_round', 'next_decision', 'unchanged'] },
}, ['sessionId', 'requested', 'delegation', 'effective', 'pending', 'available', 'denials', 'applies']);
const queueOutput = object({
  sessionId: id, accepted: { type: 'boolean' }, queued: { type: 'boolean' }, queueItemId: id,
  operationId: id, state: { type: 'string', enum: ['running', 'done', 'failed', 'cancelled'] },
  currentOperationId: { type: ['string', 'null'] },
  queue: operationProperties.queue, queuePaused: { type: 'boolean' },
  action: { type: 'string', enum: ['send', 'continue', 'cancel_queued', 'clear_queue'] }, cleared: { type: 'integer' },
}, ['sessionId']);
const approvalAnswers = { type: 'array', minItems: 1, maxItems: 4, items: object({
  id: { type: 'string', minLength: 1, maxLength: 16 },
  selected: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 80 } },
  custom: { type: 'string', maxLength: 4000 },
}, ['id', 'selected']) };
const provisionalOutput = { type: ['object', 'null'], additionalProperties: false, properties: {
  provisional: { type: 'boolean', enum: [true] }, responseId: id,
  userSeq: { type: ['integer', 'null'], minimum: 0 }, updatedAt: { type: 'string', maxLength: 64 },
  text: { type: 'string', maxLength: 8192 }, reasoning: { type: 'string', maxLength: 8192 },
  textCharacters: { type: 'integer', minimum: 0 }, reasoningCharacters: { type: 'integer', minimum: 0 },
  truncated: { type: 'boolean' },
}, required: ['provisional', 'responseId', 'userSeq', 'updatedAt', 'text', 'reasoning', 'textCharacters', 'reasoningCharacters', 'truncated'] };
const replyOutput = object({ requestId: id, sessionId: id, operationId: id, type: { type: 'string', enum: ['approval', 'question'] },
  decision: { type: 'string', enum: ['allow', 'deny'] }, answered: { type: 'integer' }, resolved: { type: 'boolean' },
  source: { type: 'string', enum: ['human', 'controller'] } },
['requestId', 'sessionId', 'operationId', 'type', 'resolved']);
const tools: Tool[] = [
  { name: 'ligule_session_create', description: 'Create a writable session in the authorized project. Returns its sessionId. At most 64 open sessions per server. Optional initial settings, including the per-turn loop limit, require --operator and are applied before the session is returned.',
    inputSchema: object({ projectRoot: root, initial: initialSettings }, ['projectRoot']), outputSchema: sessionOutput },
  { name: 'ligule_session_open', description: 'Resume a persistent session in the authorized project. Missing, locked or foreign sessions fail. No operation IDs survive server restart.',
    inputSchema: object({ projectRoot: root, sessionId: id }, ['projectRoot', 'sessionId']), outputSchema: sessionOutput },
  { name: 'ligule_session_close', description: 'Close an idle session owned by this controller. The queue must be empty and no approval or question may be pending. Busy sessions remain open; cancel or finish work and clear queued messages before retrying. Session history and completed operation status are retained.',
    inputSchema: object({ sessionId: id }, ['sessionId']), outputSchema: sessionOutput },
  { name: 'ligule_session_list', description: 'List up to 50 persistent sessions belonging to the authorized project. Open one before reading its records.',
    inputSchema: object({ projectRoot: root, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, ['projectRoot']),
    outputSchema: object({ sessions: { type: 'array', maxItems: 50, items: object({ sessionId: id, name: { type: 'string', maxLength: 120 }, archived: { type: 'boolean' }, createdAt: { type: ['string', 'null'], maxLength: 128 } }, ['sessionId', 'name', 'archived', 'createdAt']) } }, ['sessions']) },
  { name: 'ligule_session_configure', description: 'Read this session’s effective and pending settings plus available modes, providers, models and verified thinking controls. Set loopIterations to change the per-turn model/tool iteration cap. Changes are session-scoped, require --operator, and apply at documented turn boundaries.',
    inputSchema: object({ sessionId: id, changes: sessionChanges }, ['sessionId']), outputSchema: configurationOutput },
  { name: 'ligule_interaction_reply', description: 'Reply once to a real pending approval or question bound to its session and request ID. Approval replies require --operator; hard denials remain final.',
    inputSchema: object({
      sessionId: id, requestId: id, type: { type: 'string', enum: ['approval', 'question'] },
      decision: { type: 'string', enum: ['allow', 'deny'] }, answers: approvalAnswers,
    }, ['sessionId', 'requestId', 'type']), outputSchema: replyOutput },
  { name: 'ligule_session_send', description: 'Send a user message immediately or queue it for the next turn. Use actions to continue a paused queue, cancel one queued message, or clear queued messages. The queue is process-local and is not replayed after restart.',
    inputSchema: object({
      sessionId: id, action: { type: 'string', enum: ['send', 'continue', 'cancel_queued', 'clear_queue'], default: 'send' },
      input: { type: 'string', minLength: 1, maxLength: 65536 }, queueItemId: id,
    }, ['sessionId']), outputSchema: queueOutput },
  { name: 'ligule_run_start', description: 'Submit text and return immediately while the real Host runs in the background. Optional delegation.mode narrows the active session mode and adds its prompt fragments; it cannot broaden the session tool ceiling. delegation.outputSchema requires a valid result submission; Policy still applies. One active run per session. Poll status and read records. IDs are process-local; the server keeps 256 recent operations and evicts the oldest completed one when full.',
    inputSchema: object({ sessionId: id, input: { type: 'string', minLength: 1, maxLength: 65536 }, delegation: DELEGATION_SPEC_SCHEMA,
      requestKey: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' } }, ['sessionId', 'input']), outputSchema: operationOutput },
  { name: 'ligule_run', description: 'Start one real Host run and wait server-side for its terminal result, up to timeoutMs (default 60 seconds, maximum 5 minutes). Optional delegation.mode narrows the active session mode and adds its prompt fragments; it cannot broaden the session tool ceiling. delegation.outputSchema requires a valid result submission; Policy still applies. A timeout returns the current state without cancelling the run; continue with ligule_run_await or ligule_run_status.',
    inputSchema: object({ sessionId: id, input: { type: 'string', minLength: 1, maxLength: 65536 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 300_000, default: 60_000 }, delegation: DELEGATION_SPEC_SCHEMA,
      requestKey: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' } }, ['sessionId', 'input']), outputSchema: awaitOutput },
  { name: 'ligule_run_get', description: 'Read a durable task receipt from an existing Session in this project without opening its writer or replaying work. Project ownership and the caller’s visible run scope are checked. If a requestKey matches multiple visible scopes, use runId to select one receipt. Set offset to retrieve a verified 8192-character JSON fragment of its completed result. Task keys are not authorization credentials.',
    inputSchema: object({ sessionId: id, runId: id, requestKey: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' }, offset: { type: 'integer', minimum: 0 } }, ['sessionId']),
    outputSchema: object({ receipt: durableReceiptOutput, result: runPageOutput }, ['receipt']) },
  { name: 'ligule_run_status', description: 'Read the actual Host state, progress, pending interactions, queued messages, and bounded events after a cursor. Operation IDs are process-local; reopen the session after restart and read durable records.',
    inputSchema: object({ operationId: id, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, ['operationId']), outputSchema: operationOutput },
  { name: 'ligule_run_await', description: 'Wait in the server for one known run, up to timeoutMs (default 60 seconds, maximum 5 minutes). A timeout returns the current resumable state without cancelling the run. A terminal run includes its result. Resolve pending approvals or questions with the interaction tool while the run waits.',
    inputSchema: object({ operationId: id, timeoutMs: { type: 'integer', minimum: 0, maximum: 300_000, default: 60_000 } }, ['operationId']), outputSchema: awaitOutput },
  { name: 'ligule_run_cancel', description: 'Cancel this known operation and wait for Host cleanup. Reports terminated only after it settles. Completed operations keep their outcome; other sessions are unaffected.',
    inputSchema: object({ operationId: id }, ['operationId']), outputSchema: object({ ...operationProperties, terminated: { type: 'boolean' } }, ['operationId', 'sessionId', 'state', 'terminated']) },
  { name: 'ligule_session_read', description: 'Read real persistent records, newest page first (records inside a page are chronological). Use nextBefore as before for older pages. Each json field is a record JSON fragment, at most 8192 UTF-16 characters. If nextOffset is non-null, call with at=that seq and offset=nextOffset until null, concatenating fragments before JSON.parse. at and before are exclusive. This preserves complete large records without unbounded responses.',
    inputSchema: object({ sessionId: id, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, before: { type: 'integer', minimum: 1 }, at: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0, default: 0 } }, ['sessionId']),
    outputSchema: object({ sessionId: id, nextBefore: { type: ['integer', 'null'] }, hasMore: { type: 'boolean' }, provisionalOutput, provisionalOutputError: { type: ['string', 'null'] }, records: { type: 'array', maxItems: 50, items: object({ seq: { type: 'integer' }, kind: { type: 'string' }, json: { type: 'string', maxLength: 8192 }, offset: { type: 'integer' }, nextOffset: { type: ['integer', 'null'] }, totalCharacters: { type: 'integer' } }, ['seq', 'kind', 'json', 'offset', 'nextOffset', 'totalCharacters']) } }, ['sessionId', 'records', 'nextBefore', 'hasMore']) },
];

interface Arguments {
  projectRoot?: string;
  sessionId?: string;
  operationId?: string;
  timeoutMs?: number;
  delegation?: DelegationSpec;
  requestKey?: string;
  runId?: string;
  input?: string;
  initial?: McpInitialSettings;
  changes?: McpSessionChanges;
  requestId?: string;
  type?: 'approval' | 'question';
  decision?: 'allow' | 'deny';
  answers?: { id: string; selected: string[]; custom?: string }[];
  action?: 'send' | 'continue' | 'cancel_queued' | 'clear_queue';
  queueItemId?: string;
  limit?: number;
  before?: number;
  at?: number;
  offset?: number;
  after?: number;
}

export async function serveMcp({ projectRoot, version, flags = [], modeName, operator = false, grantId }: {
  projectRoot: string; version: string; flags?: string[]; modeName?: string; operator?: boolean; grantId?: string;
}): Promise<void> {
  if (!isAbsolute(projectRoot)) throw new KernelError('control_project_required');
  let authorizedRoot: string;
  try {
    authorizedRoot = await realpath(projectRoot);
    if (!(await stat(authorizedRoot)).isDirectory()) throw new KernelError('control_project_required');
  } catch { throw new KernelError('control_project_required'); }
  if (!(await isTrusted(authorizedRoot))) throw new KernelError('control_project_untrusted');
  const grantStorePath = delegationPathOf();
  const grant = grantId === undefined ? undefined : await requireDelegationGrant(grantStorePath, grantId, authorizedRoot);
  if (grant !== undefined && operator && !grant.allowOperator) throw new KernelError('agent_control_operator_not_allowed');
  const operatorEnabled = operator && (grant === undefined || grant.allowOperator);
  const shippedModes = fileURLToPath(new URL('../../modes/', import.meta.url));
  const { layers, ...environment } = await loadHostEnvironment(authorizedRoot, shippedModes, flags);
  const capabilities = await createInteractivePermissionContext({ shellConfig: environment.config, workspaceRoot: authorizedRoot });
  const permission = grant === undefined ? capabilities
    : createPermissionContext(grant.defaultPermissionProfile, grant.defaultNetwork, capabilities.capabilities, {
        profiles: capabilities.profiles,
        limitations: capabilities.limitations,
        partialWorkspaceWriteConfirmationRequired: capabilities.partialWorkspaceWriteConfirmationRequired,
        partialWorkspaceWriteConfirmed: grant.confirmedPartialWorkspaceWrite,
      });
  const agentControl = grant === undefined ? undefined : {
    grantId: grant.id,
    storePath: grantStorePath,
    operator: operatorEnabled,
    validate: () => requireDelegationGrant(grantStorePath, grant.id, authorizedRoot),
  };
  const host = createHost({ ...environment,
    config: createConfig({ user: { ...environment.config, workspaceRoot: authorizedRoot } }),
    configLayers: layers,
    loadEnvironment: async (project) => {
      const { layers: freshLayers, ...fresh } = await loadHostEnvironment(project, shippedModes, flags);
      return { ...fresh, layers: freshLayers };
    },
    permission,
    ...(modeName === undefined ? {} : { modeName }),
    interactive: true,
    ...(agentControl === undefined ? {} : { agentControl }),
  });
  if (grant !== undefined) await recordDelegationEvent(grantStorePath, { kind: 'grant.used', grantId: grant.id });
  const server = new Server({ name: 'ligule', version }, {
    capabilities: { tools: {}, logging: {} },
    instructions: grant === undefined
      ? operatorEnabled
        ? 'One local stdio operator for the explicitly authorized project. This server was launched with --operator, so session-only settings and replies to real pending approvals/questions are available. Policy decisions still run in Host; hard denials cannot be overridden. Use ligule_run to delegate and wait in one call, or run_start/await/status/cancel for separate control. Idle sessions can be explicitly closed after queued messages are cleared. Notifications are best-effort. Disconnect cancels active runs and releases locks. Operation IDs and queued messages are process-local; Session JSONL persists.'
        : 'One local stdio controller for the explicitly authorized project. Session creation/open/close/list, run, run_start/await/status/cancel, session configuration reads, message sending and record paging are available. Ordinary approvals and questions wait for the local Desktop/TUI user; MCP replies and settings changes require the explicit --operator flag. Idle sessions can be explicitly closed after queued messages are cleared. Disconnect cancels active runs and releases locks. Operation IDs and queued messages are process-local; Session JSONL persists.'
      : `One local stdio controller for project ${grant.projectRoot}, bounded by grant ${grant.id} (${grant.maxPermissionProfile}, network up to ${grant.maxNetwork}, policies: ${grant.allowedPolicies.join(', ')}). The grant is not remote identity authentication and does not override OS sandbox limits or hard Policy denials.${operatorEnabled ? ' --operator also allows ordinary approved interactions.' : ' Ordinary approvals and questions wait for the local Desktop/TUI user; MCP replies and settings changes are disabled.'} Idle sessions can be explicitly closed after queued messages are cleared. Use ligule_run to delegate and wait in one call. Disconnect cancels active runs and releases locks.`,
  });
  const control = createControl(host, authorizedRoot, {
    operator: operatorEnabled,
    onEvent(event) {
      void server.sendLoggingMessage({ level: 'info', logger: 'ligule', data: event })
        .catch(() => { process.stderr.write('mcp_notification_delivery_failed\n'); });
    },
  });
  let grantWatch: NodeJS.Timeout | undefined;
  if (agentControl !== undefined) {
    const checkGrant = () => {
      grantWatch = setTimeout(() => {
        void agentControl.validate().then(checkGrant, async (error: unknown) => {
          grantWatch = undefined;
          try { await control.invalidate(controlErrorCode(error)); }
          catch { process.stderr.write('mcp_grant_shutdown_failed\n'); }
        });
      }, 500);
      grantWatch.unref();
    };
    checkGrant();
  }
  const ajv = new Ajv({ strict: false });
  const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
  const outputs = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.outputSchema!)]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const validate = validators.get(request.params.name);
    if (validate === undefined) throw new McpError(ErrorCode.InvalidParams, 'tool_unknown');
    const args = request.params.arguments ?? {};
    if (!validate(args)) throw new McpError(ErrorCode.InvalidParams, 'tool_args_invalid');
    const input: Arguments = args;
    try {
      if (agentControl !== undefined) {
        try { await agentControl.validate(); }
        catch (error) {
          await control.invalidate(controlErrorCode(error));
          throw error;
        }
      }
      let result: Record<string, unknown>;
      switch (request.params.name) {
        case 'ligule_session_create': result = await control.create(input.projectRoot!, input.initial); break;
        case 'ligule_session_open': result = await control.open(input.projectRoot!, input.sessionId!); break;
        case 'ligule_session_close': result = await control.close(input.sessionId!); break;
        case 'ligule_session_list': result = await control.list(input.projectRoot!, input.limit ?? 20); break;
        case 'ligule_session_configure': result = await control.configure(input.sessionId!, input.changes); break;
        case 'ligule_interaction_reply': result = control.replyInteraction({
          sessionId: input.sessionId!, requestId: input.requestId!, type: input.type!,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
          ...(input.answers === undefined ? {} : { answers: input.answers }),
        }); break;
        case 'ligule_session_send': result = control.send(input.sessionId!, input.action ?? 'send', input.input, input.queueItemId); break;
        case 'ligule_run_start': result = await control.submit(input.sessionId!, input.input!, input.delegation, input.requestKey); break;
        case 'ligule_run_get': result = await control.getRun(input.sessionId!, {
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
        }, input.offset); break;
        case 'ligule_run': {
          const started = await control.submit(input.sessionId!, input.input!, input.delegation, input.requestKey);
          result = { ...await control.await(started.operationId, input.timeoutMs ?? 60_000), receipt: started.receipt, reused: started.reused };
          break;
        }
        case 'ligule_run_status': result = control.status(input.operationId!, input.after ?? 0, input.limit ?? 20); break;
        case 'ligule_run_await': result = await control.await(input.operationId!, input.timeoutMs ?? 60_000); break;
        case 'ligule_run_cancel': result = await control.cancel(input.operationId!); break;
        case 'ligule_session_read': result = await control.read(input.sessionId!, input.before, input.limit ?? 20, input.at, input.offset); break;
        default: throw new KernelError('tool_unknown');
      }
      const outputValid = outputs.get(request.params.name)!(result);
      if (!outputValid) throw new KernelError('host_response_invalid');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { code: controlErrorCode(error) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  let shutdown: Promise<void> | undefined;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  function close(): void {
    if (shutdown !== undefined) return;
    shutdown = (async () => {
      try { await control.release(); }
      finally { await server.close(); }
    })();
    void shutdown.then(finish, fail);
  }
  server.onclose = close;
  server.onerror = () => { process.stderr.write('mcp_transport_error\n'); close(); };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.stdout.once('error', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await server.connect(transport);
    await done;
  } finally {
    close();
    await shutdown;
    process.stdin.off('end', close);
    process.stdin.off('close', close);
    process.stdout.off('error', close);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    if (grantWatch !== undefined) clearTimeout(grantWatch);
  }
}
