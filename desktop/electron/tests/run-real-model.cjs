const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, session } = require('electron');

const repositoryRoot = resolve(__dirname, '../../..');
const desktopRoot = join(repositoryRoot, 'desktop');
const hostNodeRuntime = resolve(process.env.LIGULE_DESKTOP_TEST_NODE
  ?? join(desktopRoot, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
const workspaceRoot = process.env.LIGULE_REAL_MODEL_WORKSPACE;
const evidenceRoot = process.env.LIGULE_REAL_MODEL_EVIDENCE;
const userDataRoot = process.env.LIGULE_REAL_MODEL_USER_DATA;
const isolatedHome = process.env.LIGULE_HOME;
const results = [];
let mainWindow;
let nativeServices;
let host;
let detachIpc;
let observedCsp;
let sessionId;
let sequence = 0;
let failed = false;
let phase = 'load_application';
const hostRequests = [];
// 真实模型验收和本地 stub 回归共用窗口驱动程序；提供方标签只用于报告。
const providerLabel = process.env.LIGULE_MODEL_PROVIDER_LABEL ?? '真实模型';
const evidenceName = process.env.LIGULE_MODEL_EVIDENCE_NAME ?? 'real-model';
const workspaceStartupTimeoutMs = Number(process.env.LIGULE_DESKTOP_TEST_STARTUP_TIMEOUT_MS ?? 60_000);
if (!Number.isSafeInteger(workspaceStartupTimeoutMs) || workspaceStartupTimeoutMs < 1) throw new Error('desktop_test_startup_timeout_invalid');
const hostResponses = [];
let nextExternalSendResponseGate = null;
let workspaceReadinessMs = null;

function holdNextExternalSendResponse() {
  if (nextExternalSendResponseGate !== null) throw Object.assign(new Error('external_send_response_gate_already_set'), { code: 'external_send_response_gate_already_set' });
  let resolveHeld;
  let resolveReleased;
  const gate = {
    held: new Promise(resolve => { resolveHeld = resolve; }),
    released: new Promise(resolve => { resolveReleased = resolve; }),
    resolveHeld: () => resolveHeld(),
    release: () => resolveReleased(),
  };
  nextExternalSendResponseGate = gate;
  return gate;
}

async function waitForExternalSendResponse(gate, timeoutMs = 15_000) {
  let timer;
  try {
    await Promise.race([
      gate.held,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('external_send_response_not_held'), { code: 'external_send_response_not_held' })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

if ([workspaceRoot, evidenceRoot, userDataRoot, isolatedHome].some(value => typeof value !== 'string' || value.length === 0)) {
  throw new Error('real_model_harness_paths_missing');
}

app.setPath('userData', userDataRoot);
app.enableSandbox();
// 销毁窗口后再写报告；忽略 window-all-closed，避免 Electron 提前退出。
app.on('window-all-closed', () => {});
const secureWindow = require('../dist/secure-window.js');
const security = require('../dist/security.js');
const ipc = require('../dist/ipc.js');
const { HostController } = require('../dist/host.js');
const { resolveHostRuntime } = require('../dist/runtime.js');
const { NativeServices } = require('../dist/native.js');
secureWindow.registerAppScheme();

function note(name, status, detail, code) {
  const item = { name, status, detail, ...(code === undefined ? {} : { code }) };
  results.push(item);
  console.log(JSON.stringify(item));
}

function stableErrorCode(error) {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error !== null && typeof error === 'object' && 'name' in error && typeof error.name === 'string' && /^[A-Za-z]{3,30}$/u.test(error.name)) return `native_${error.name.toLowerCase()}`;
  if (error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const message = error.message;
    const electronCode = /\b(ERR_[A-Z_]{3,60})\b/u.exec(message)?.[1];
    if (electronCode !== undefined) return electronCode.toLowerCase();
    return /^[a-z][a-z0-9_]{2,80}$/u.test(message) ? message : 'unexpected_error';
  }
  return 'unexpected_error';
}

function safeErrorLocation(error) {
  const stack = error !== null && typeof error === 'object' && 'stack' in error && typeof error.stack === 'string' ? error.stack : '';
  const locations = stack.split('\n').slice(1, 6).flatMap(line => {
    const match = /(?:\((?:.*[\\/])?([^\\/:]+):(\d+):(\d+)\)|at (?:.*[\\/])?([^\\/:]+):(\d+):(\d+))/u.exec(line);
    if (match === null) return [];
    return [`${match[1] ?? match[4]}:${match[2] ?? match[5]}`];
  });
  return locations.length === 0 ? 'location_unknown' : locations.join(',');
}

async function check(name, action) {
  try {
    const detail = await action();
    note(name, '通过', detail);
  } catch (error) {
    failed = true;
    const diagnostic = typeof error?.diagnostic === 'string' ? `诊断：${error.diagnostic}。` : '';
    note(name, '失败', `交互未达到预期，位置 ${safeErrorLocation(error)}；只记录稳定错误码。${diagnostic}`, stableErrorCode(error));
  }
}

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

async function evaluate(source) {
  assert.ok(mainWindow !== undefined && !mainWindow.isDestroyed(), 'real_window_unavailable');
  return await mainWindow.webContents.executeJavaScript(source, true);
}

async function clickWithMouse(selector, failureCode) {
  const point = await evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hitTarget: hit !== null && (hit === button || button.contains(hit)) };
  })()`);
  if (point === null || point.hitTarget !== true) {
    throw Object.assign(new Error(failureCode), { code: failureCode });
  }
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function requestHost(method, params = {}, timeoutMs = 60_000) {
  const id = nextId('real-model-rpc');
  const encoded = JSON.stringify({ id, method, params });
  const result = await evaluate(`(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(encoded)});
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      const response = window.__realModelFrames.find(frame => frame.id === ${JSON.stringify(id)});
      if (response !== undefined) return response;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    throw Object.assign(new Error('real_model_host_rpc_timeout'), { code: 'real_model_host_rpc_timeout' });
  })()`);
  if (result.errorCode !== undefined) throw Object.assign(new Error('host_rpc_failed'), { code: result.errorCode });
  return result;
}

async function sessionSummary() {
  if (typeof sessionId !== 'string') throw Object.assign(new Error('real_model_session_missing'), { code: 'real_model_session_missing' });
  const status = await requestHost('status.get', { sessionId });
  const record = await requestHost('session.read', { sessionId, fullResults: true });
  return {
    running: status.running,
    turns: record.events.filter(event => event.kind === 'turn').map(event => ({ status: event.status, code: event.code })),
    tools: record.events.filter(event => event.kind === 'tool').map(event => ({ tool: event.tool, kind: event.resultKind, code: event.resultCode })),
    deltaCount: await evaluate(`window.__realModelFrames.filter(frame => frame.notify === 'delta' && frame.sessionId === ${JSON.stringify(sessionId)}).length`),
  };
}

async function waitForSessionIdle(timeoutMs, failureCode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summary = await sessionSummary();
    if (summary.running === false) return summary;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw Object.assign(new Error(failureCode), { code: failureCode });
}

function cspHeader(headers) {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-security-policy');
  if (entry === undefined) return undefined;
  return Array.isArray(entry[1]) ? entry[1].join('; ') : String(entry[1]);
}

async function createApplication() {
  phase = 'wait_for_electron';
  await app.whenReady();
  phase = 'install_app_protocol';
  secureWindow.installResourceProtocol(join(desktopRoot, 'frontend', 'dist'));
  session.defaultSession.webRequest.onCompleted({ urls: ['app://ligule/*'] }, details => {
    if (details.url === security.APP_PAGE && details.resourceType === 'mainFrame') observedCsp = cspHeader(details.responseHeaders);
  });

  phase = 'create_secure_window';
  mainWindow = secureWindow.createApplicationWindow({
    preload: join(desktopRoot, 'electron', 'dist', 'preload.js'),
    iconPath: join(desktopRoot, 'assets', 'app-icon.png'),
    page: security.APP_PAGE,
    development: false,
  });
  phase = 'create_native_services';
  nativeServices = new NativeServices({
    window: mainWindow,
    onQuitRequested: () => {},
    onNotificationOpen: () => {},
    onFault: () => {},
    iconPath: join(desktopRoot, 'assets', 'app-icon.png'),
  });
  phase = 'resolve_host_runtime';
  const runtime = resolveHostRuntime({ repositoryRoot, node: hostNodeRuntime, environment: process.env });
  host = new HostController({
    ...runtime,
    hostEntry: runtime.hostEntry,
    entry: join(desktopRoot, 'electron', 'dist', 'host-entry.js'),
    onFrame: frame => {
      let heldResponse = false;
      try {
        const response = JSON.parse(frame);
        if (typeof response.id === 'string') {
          hostResponses.push({ id: response.id, errorCode: typeof response.error?.code === 'string' ? response.error.code : undefined, receivedAt: Date.now() });
          const gate = nextExternalSendResponseGate;
          const request = gate === null ? undefined : hostRequests.findLast(item => item.id === response.id);
          if (gate !== null && request?.method === 'session.control' && request.action === 'send') {
            nextExternalSendResponseGate = null;
            heldResponse = true;
            gate.resolveHeld();
            void gate.released.then(() => {
              if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send('ligule:host-frame', frame);
            });
          }
        }
      } catch {}
      if (!heldResponse && mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send('ligule:host-frame', frame);
    },
    onFault: () => {},
  });
  const sendHostFrame = host.send.bind(host);
  host.send = frame => {
    try {
      const request = JSON.parse(frame);
      if (['session.open', 'session.read', 'session.observe', 'session.control', 'prefs.read', 'prefs.write', 'status.get'].includes(request.method)) {
        const projectRoot = request.params?.projectRoot;
        hostRequests.push({
          id: request.id,
          method: request.method,
          sessionId: request.params?.sessionId,
          action: request.method === 'session.control' ? request.params?.request?.action : undefined,
          projectRootScope: projectRoot === undefined ? 'omitted'
            : projectRoot === workspaceRoot ? 'matches_workspace' : 'different_workspace',
          hostPid: host.pid,
          sentAt: Date.now(),
        });
      }
    } catch {}
    return sendHostFrame(frame);
  };
  phase = 'register_production_ipc';
  detachIpc = ipc.registerDesktopIpc(mainWindow, security.APP_PAGE, host, nativeServices, async () => {});
  phase = 'start_node_host';
  await host.start();
  phase = 'load_application_page';
  await mainWindow.loadURL(security.APP_PAGE);
  mainWindow.show();
  phase = 'subscribe_to_host_frames';
  await evaluate(`(() => {
    window.__realModelFrames = [];
    window.liguleDesktop.onHostFrame(raw => {
      try {
        const frame = JSON.parse(raw);
        const safe = {};
        if (typeof frame.id === 'string') safe.id = frame.id;
        if (typeof frame.method === 'string') safe.method = frame.method;
        if (typeof frame.notify === 'string') safe.notify = frame.notify;
        if (typeof frame.sessionId === 'string') safe.sessionId = frame.sessionId;
        if (frame.result && typeof frame.result.sessionId === 'string') safe.createdSessionId = frame.result.sessionId;
        if (frame.result && typeof frame.result.sessionId === 'string') safe.resultSessionId = frame.result.sessionId;
        if (frame.result && typeof frame.result.operationId === 'string') safe.operationId = frame.result.operationId;
        if (frame.result && typeof frame.result.state === 'string') safe.operationState = frame.result.state;
        if (frame.result && Array.isArray(frame.result.pendingInteractions)) safe.pendingInteractionTypes = frame.result.pendingInteractions.map(item => item.type);
        if (frame.error && typeof frame.error.code === 'string') safe.errorCode = frame.error.code;
        if (frame.event && typeof frame.event.type === 'string') safe.deltaType = frame.event.type;
        if (frame.method === 'approval.request') safe.approvalTool = frame.params?.tool;
        if (frame.result && typeof frame.id === 'string' && frame.id.startsWith('real-model-rpc-')) {
          if (typeof frame.result.running === 'boolean') safe.running = frame.result.running;
          if (Array.isArray(frame.result.workspaces)) safe.workspaces = frame.result.workspaces.map(item => ({ identity: item.identity, directory: item.directory }));
          if (Array.isArray(frame.result.events)) safe.events = frame.result.events.map(event => ({
            kind: event.kind,
            status: event.status,
            code: event.code,
            tool: event.tool,
            resultKind: event.result?.kind,
            resultFailed: event.result?.failed === true,
            resultHasSkillProof: JSON.stringify(event.result?.content ?? null).includes('SKILL_LOAD_PROOF'),
            resultHasSchemaDigest: JSON.stringify(event.result?.content ?? null).includes('schemaDigest'),
            resultHasMcpProof: JSON.stringify(event.result?.content ?? null).includes('echo: MCP_LOADING_PROOF'),
            resultHasSessionQuestionOption: JSON.stringify(event.result?.content?.answers ?? null).includes('"selected":["north"]'),
            resultHasSessionQuestionDraft: JSON.stringify(event.result?.content?.answers ?? null).includes('"custom":"desktop-session-question-draft-answer"'),
            resultCode: event.result?.code,
          }));
        }
        window.__realModelFrames.push(safe);
      } catch {}
    });
    return { href: location.href, methods: Object.keys(window.liguleDesktop).sort() };
  })()`);
}

async function waitFor(expression, timeoutMs, failureCode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  throw Object.assign(new Error(failureCode), { code: failureCode });
}

async function allowApproval(tool, previousCount, failureCode) {
  const expected = JSON.stringify(tool);
  await waitFor(
    `window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${previousCount}`
      + ` && document.querySelector('.approval .row-tool')?.textContent.trim() === ${expected}`,
    15_000,
    failureCode,
  );
  const clicked = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.approval')].find(item => item.querySelector('.row-tool')?.textContent.trim() === ${expected});
    const button = card?.querySelector('button[data-tone="allow"]');
    if (button === undefined || button === null) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw Object.assign(new Error(`${tool}_approval_action_missing`), { code: `${tool.replace(/[^a-z0-9]+/giu, '_')}_approval_action_missing` });
}

async function selectNewSessionPermission(profile) {
  await waitFor(`(() => {
    const trigger = document.querySelector('button.permission-trigger');
    return trigger !== null && !trigger.disabled;
  })()`, 20_000, 'new_session_permission_control_unavailable');
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('button.permission-trigger');
    if (trigger === null || trigger.disabled) return false;
    trigger.click();
    return true;
  })()`);
  if (opened !== true) throw Object.assign(new Error('new_session_permission_control_unavailable'), { code: 'new_session_permission_control_unavailable' });
  await waitFor(`document.querySelector('.permission-panel select') !== null`, 5_000, 'new_session_permission_panel_missing');
  const selected = await evaluate(`(() => {
    const field = document.querySelector('.permission-panel select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(field, ${JSON.stringify(profile)});
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return field.value;
  })()`);
  if (selected !== profile) throw Object.assign(new Error('new_session_permission_selection_failed'), { code: 'new_session_permission_selection_failed' });
  await waitFor(`document.querySelector('.permission-panel button.primary-button')?.disabled === false`, 5_000, 'new_session_permission_apply_disabled');
  await evaluate(`document.querySelector('.permission-panel button.primary-button').click(); true`);
  const confirmations = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lead = await evaluate(`document.querySelector('.confirm .confirm-lead')?.textContent ?? null`);
    if (lead === null) break;
    if (/信任此工作区|trust project code/iu.test(lead)) confirmations.push('workspace-trust');
    else if (/部分隔离|partial-isolation/iu.test(lead)) confirmations.push('partial-workspace-write');
    else throw Object.assign(new Error('new_session_permission_confirmation_unknown'), { code: 'new_session_permission_confirmation_unknown' });
    await evaluate(`document.querySelector('.confirm-actions .primary-button')?.click(); true`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  assert.ok(confirmations.includes('workspace-trust'), 'new_session_workspace_trust_confirmation_missing');
  await waitFor(`(() => {
    const label = document.querySelector('button.permission-trigger')?.textContent ?? '';
    return document.querySelector('.permission-panel') === null
      && (label.includes('工作区可写') || label.includes('Workspace write'));
  })()`, 5_000, 'new_session_permission_not_applied');
}

async function verifyExternalControlEventGap({ observerSessionId, draftAwaySessionId, mcpClient, takeoverAfter = false }) {
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${draftAwaySessionId}`)}));
    item?.click();
    return item !== undefined;
  })()`);
  await waitFor(`document.querySelector('.session-item.active')?.title.endsWith(${JSON.stringify(` · ${draftAwaySessionId}`)}) === true
    && document.querySelector('.external-session-composer') === null`, 10_000, 'external_gap_switch_away_failed');
  const gapStart = await mcpClient.callTool({ name: 'ligule_run_start', arguments: {
    sessionId: observerSessionId,
    input: 'desktop-external-control-gap',
  } });
  if (gapStart.isError === true) throw Object.assign(new Error('external_gap_run_start_failed'), { code: JSON.parse(gapStart.content?.[0]?.text ?? '{}').code ?? 'external_gap_run_start_failed' });
  const gapOperationId = gapStart.structuredContent?.operationId;
  if (typeof gapOperationId !== 'string') throw Object.assign(new Error('external_gap_operation_id_missing'), { code: 'external_gap_operation_id_missing' });
  const gapCompleted = await mcpClient.callTool({ name: 'ligule_run_await', arguments: {
    operationId: gapOperationId, timeoutMs: 20_000,
  } });
  if (gapCompleted.isError === true) throw Object.assign(new Error('external_gap_run_await_failed'), { code: JSON.parse(gapCompleted.content?.[0]?.text ?? '{}').code ?? 'external_gap_run_await_failed' });
  assert.equal(gapCompleted.structuredContent?.state, 'done', 'external_gap_run_did_not_complete');
  const gapStatus = await mcpClient.callTool({ name: 'ligule_run_status', arguments: {
    operationId: gapOperationId, after: 0, limit: 50,
  } });
  assert.equal(gapStatus.isError, undefined, 'external_gap_status_failed');
  assert.equal(gapStatus.structuredContent?.eventGap, true, 'the old external Cursor must report a real event gap');
  assert.ok(gapStatus.structuredContent?.firstAvailableCursor > 1, 'the retained window must begin after the stale Cursor');
  assert.equal(gapStatus.structuredContent?.events.length, 50, 'the status page remains bounded at 50 events');

  const gapTranscript = await mcpClient.callTool({ name: 'ligule_session_read', arguments: { sessionId: observerSessionId, limit: 50 } });
  const gapRecords = gapTranscript.structuredContent.records.map(item => JSON.parse(item.json));
  const gapUser = gapRecords.filter(item => item.kind === 'user' && item.text === 'desktop-external-control-gap');
  const gapAssistant = gapRecords.filter(item => item.kind === 'assistant'
    && typeof item.text === 'string' && item.text.includes('P6 desktop retained stream piece 179.'));
  const expectedGapText = Array.from({ length: 180 }, (_, index) => `P6 desktop retained stream piece ${String(index).padStart(3, '0')}.`).join('');
  assert.equal(gapUser.length, 1, 'the controller input must be recorded once');
  assert.equal(gapAssistant.length, 1, 'the final assistant record must be persisted once');
  assert.equal(gapAssistant[0].text, expectedGapText, 'the persistent Session must retain the complete output');
  const gapStubState = await fetch(`${process.env.LIGULE_STUB_CONTROL}/state`).then(response => response.json());
  const gapChunkRequests = gapStubState.externalGapRequests;
  assert.equal(gapChunkRequests, 1, 'the deterministic Provider streamed one 180-chunk request');

  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${observerSessionId}`)}));
    item?.click();
    return item !== undefined;
  })()`);
  await waitFor(`document.querySelector('.session-item.active')?.title.endsWith(${JSON.stringify(` · ${observerSessionId}`)}) === true`, 10_000, 'external_gap_return_failed');
  await waitFor(`(() => {
    const note = document.querySelector('.external-control-note')?.textContent ?? '';
    return note.includes('Some live updates left the event window') || note.includes('部分实时更新已滚出事件窗口');
  })()`, 15_000, 'external_gap_warning_missing');
  const finalGapMarker = 'P6 desktop retained stream piece 179.';
  try {
    await waitFor(`([...document.querySelectorAll('.row.answer[data-kind="answer"]')]
      .some(row => row.textContent.includes(${JSON.stringify(finalGapMarker)})))`, 15_000, 'external_gap_transcript_not_rendered');
  } catch (error) {
    const current = await evaluate(`({
      activeSession: document.querySelector('.session-item.active')?.title ?? null,
      gapNote: document.querySelector('.external-control-note')?.textContent ?? null,
      answerRows: [...document.querySelectorAll('.row.answer[data-kind="answer"]')].map(row => row.textContent.slice(-120)),
      latestVisibleText: document.querySelector('.center')?.innerText.slice(-1_200) ?? '',
    })`);
    const image = await mainWindow.webContents.capturePage();
    writeFileSync(join(evidenceRoot, 'external-control-gap-render-failure.png'), image.toPNG());
    writeFileSync(join(evidenceRoot, 'external-control-gap-render-failure.json'), `${JSON.stringify({
      controllerSessionContainsAssistant: gapAssistant[0]?.text === expectedGapText,
      current,
    }, null, 2)}\n`, 'utf8');
    throw Object.assign(error, { diagnostic: JSON.stringify({ current }) });
  }
  const renderedGapRows = await evaluate(`([...document.querySelectorAll('.row.answer[data-kind="answer"]')]
    .filter(row => row.textContent.includes(${JSON.stringify(finalGapMarker)})).length)`);
  assert.equal(renderedGapRows, 1, 'the recovered assistant record is rendered exactly once');
  await evaluate(`document.querySelector('.jump-latest')?.click(); true`);
  await waitFor(`(() => {
    const scroller = document.querySelector('[data-virtuoso-scroller="true"]');
    return scroller !== null && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 40;
  })()`, 5_000, 'external_gap_transcript_not_at_latest');
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.row.answer[data-kind="answer"]')]
      .find(item => item.textContent.includes(${JSON.stringify(finalGapMarker)}));
    row?.scrollIntoView({ block: 'end', behavior: 'auto' });
    return row !== undefined;
  })()`);
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const gapVisibilityExpression = `(() => {
    const matches = [...document.querySelectorAll('.row.answer[data-kind="answer"]')]
      .filter(item => item.textContent.includes(${JSON.stringify(finalGapMarker)}));
    const row = matches[0];
    const scroller = row?.closest('[data-virtuoso-scroller="true"]');
    const rowBounds = row?.getBoundingClientRect();
    const scrollBounds = scroller?.getBoundingClientRect();
    const style = row === undefined ? null : getComputedStyle(row);
    const ancestors = [];
    for (let item = row, depth = 0; item !== null && item !== undefined && depth < 6; item = item.parentElement, depth += 1) {
      const itemStyle = getComputedStyle(item);
      const bounds = item.getBoundingClientRect();
      ancestors.push({ tag: item.tagName, className: String(item.className ?? ''), display: itemStyle.display,
        visibility: itemStyle.visibility, opacity: itemStyle.opacity, overflowY: itemStyle.overflowY,
        bounds: { top: bounds.top, bottom: bounds.bottom, height: bounds.height } });
    }
    return {
      matchingRowCount: matches.length,
      visibleInTranscript: row !== undefined && scroller !== null && rowBounds !== undefined && scrollBounds !== undefined
        && rowBounds.height > 0 && rowBounds.bottom > scrollBounds.top && rowBounds.top < scrollBounds.bottom
        && style?.display !== 'none' && style?.visibility !== 'hidden' && Number(style?.opacity ?? '1') > 0,
      rowBounds: rowBounds === undefined ? null : { top: rowBounds.top, bottom: rowBounds.bottom, height: rowBounds.height },
      scrollBounds: scrollBounds === undefined ? null : { top: scrollBounds.top, bottom: scrollBounds.bottom },
      scrollMetrics: scroller === null || scroller === undefined ? null : {
        top: scroller.scrollTop, height: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
      },
      rowStyle: style === null ? null : { display: style.display, visibility: style.visibility, opacity: style.opacity, color: style.color },
      ancestors,
      marker: row?.textContent.includes(${JSON.stringify(finalGapMarker)}) === true,
    };
  })()`;
  const visibilityStartedAt = Date.now();
  const visibilityDeadline = visibilityStartedAt + 5_000;
  let renderedGapState = await evaluate(gapVisibilityExpression);
  while (!renderedGapState.visibleInTranscript && Date.now() < visibilityDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    renderedGapState = await evaluate(gapVisibilityExpression);
  }
  const renderedAssistantVisibilityWaitMs = Date.now() - visibilityStartedAt;
  if (!renderedGapState.visibleInTranscript) {
    writeFileSync(join(evidenceRoot, 'external-control-gap-not-visible.png'), (await mainWindow.webContents.capturePage()).toPNG());
    writeFileSync(join(evidenceRoot, 'external-control-gap-not-visible.json'), `${JSON.stringify(renderedGapState, null, 2)}\n`, 'utf8');
  }
  assert.equal(renderedGapState.visibleInTranscript, true,
    `the recovered assistant row must be visible in the transcript: ${JSON.stringify(renderedGapState)}`);
  const image = await mainWindow.webContents.capturePage();
  writeFileSync(join(evidenceRoot, 'external-control-event-gap.png'), image.toPNG());
  let oldControllerRefused = false;
  if (takeoverAfter) {
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.external-control-head button')].find(item => /接管会话|Take over/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    await waitFor(`document.querySelector('.confirm .confirm-lead')?.textContent.includes('停止外控') === true
      || document.querySelector('.confirm .confirm-lead')?.textContent.includes('Stop external control') === true`, 5_000, 'external_gap_takeover_confirmation_missing');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.confirm-actions button')].find(item => /接管|Take over/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    await waitFor(`document.querySelector('.external-control') === null
      && document.querySelector('textarea.composer-input')?.readOnly === false`, 20_000, 'external_gap_takeover_not_completed');
    const refused = await mcpClient.callTool({ name: 'ligule_run_start', arguments: { sessionId: observerSessionId, input: 'after gap takeover' } });
    assert.equal(refused.isError, true, 'the previous Controller must lose write access after takeover');
    assert.equal(JSON.parse(refused.content?.[0]?.text ?? '{}').code, 'control_session_taken_over');
    oldControllerRefused = true;
  }
  return {
    firstAvailableCursor: gapStatus.structuredContent.firstAvailableCursor,
    statusEventCount: gapStatus.structuredContent.events.length,
    providerChunks: 180,
    providerRequests: gapChunkRequests,
    sessionUserRecords: gapUser.length,
    sessionAssistantRecords: gapAssistant.length,
    renderedAssistantRows: renderedGapRows,
    renderedAssistantRowVisible: renderedGapState.visibleInTranscript,
    renderedAssistantVisibilityWaitMs,
    oldControllerRefused,
  };
}

async function verifyExternalSessionControl() {
  const coreRequire = createRequire(join(repositoryRoot, 'core', 'package.json'));
  const { Client } = coreRequire('@modelcontextprotocol/sdk/client');
  const { StdioClientTransport } = coreRequire('@modelcontextprotocol/sdk/client/stdio.js');
  const runtimeNode = process.env.LIGULE_RUNTIME_NODE;
  if (typeof runtimeNode !== 'string' || runtimeNode === '') throw Object.assign(new Error('external_control_runtime_node_missing'), { code: 'external_control_runtime_node_missing' });
  const mcpFixture = join(repositoryRoot, 'core', 'tests', 'fixtures', 'agent-control-mcp-server.mjs');
  const trust = await import(pathToFileURL(join(repositoryRoot, 'core', 'dist', 'kernel', 'workspace-trust.js')).href);
  const agentControl = await import(pathToFileURL(join(repositoryRoot, 'core', 'dist', 'host', 'agent-control.js')).href);
  const previousSessionId = sessionId;
  let draftAwaySessionId = previousSessionId;
  await trust.setTrusted(workspaceRoot, true, join(isolatedHome, 'tui-trust.json'));
  const grantStorePath = agentControl.delegationPathOf(isolatedHome);
  const grantBefore = await agentControl.listDelegationGrants(grantStorePath);
  const grantSnapshot = await agentControl.createDelegationGrant(grantStorePath, {
    name: 'Electron human interaction acceptance',
    projectRoot: workspaceRoot,
    defaultPermissionProfile: 'workspace-write',
    maxPermissionProfile: 'workspace-write',
    defaultNetwork: 'policy',
    maxNetwork: 'policy',
    defaultPolicy: 'ask',
    allowedPolicies: ['ask'],
    allowOperator: false,
    confirmFullAccess: false,
    confirmUnrestrictedNetwork: false,
    confirmPartialWorkspaceWrite: true,
    expiresAt: null,
  }, grantBefore.version);
  const grantId = grantSnapshot.grants.at(-1)?.id;
  if (typeof grantId !== 'string') throw Object.assign(new Error('external_control_test_grant_missing'), { code: 'external_control_test_grant_missing' });
  const transport = new StdioClientTransport({
    command: runtimeNode,
    args: [mcpFixture, workspaceRoot, grantId, ''],
    cwd: workspaceRoot,
    env: { ...process.env, LIGULE_HOME: isolatedHome },
    stderr: 'pipe',
  });
  const mcpClient = new Client({ name: 'ligule-desktop-control-acceptance', version: 'test' });
  let mcpStderr = '';
  transport.stderr?.on('data', chunk => { mcpStderr += chunk.toString(); });
  let observerSessionId;
  try {
    await mcpClient.connect(transport);
    const created = await mcpClient.callTool({ name: 'ligule_session_create', arguments: { projectRoot: workspaceRoot } });
    if (created.isError === true) throw Object.assign(new Error(`external_control_session_create_failed:${mcpStderr.slice(-500)}`), { code: JSON.parse(created.content?.[0]?.text ?? '{}').code ?? 'external_control_session_create_failed' });
    observerSessionId = created.structuredContent.sessionId;
    if (typeof draftAwaySessionId !== 'string') {
      const away = await mcpClient.callTool({ name: 'ligule_session_create', arguments: { projectRoot: workspaceRoot } });
      if (away.isError === true) throw Object.assign(new Error(`external_control_away_session_create_failed:${mcpStderr.slice(-500)}`), { code: JSON.parse(away.content?.[0]?.text ?? '{}').code ?? 'external_control_away_session_create_failed' });
      draftAwaySessionId = away.structuredContent.sessionId;
    }
    await evaluate(`(() => {
      const button = document.querySelector('button[aria-label="展开侧栏"], button[aria-label="Show sidebar"]');
      button?.click();
    })()`);
    await waitFor(`document.querySelector('button[aria-label="刷新会话列表"]') || document.querySelector('button[aria-label="Refresh conversations"]')`, 10_000, 'session_rail_refresh_missing');
    await evaluate(`(() => {
      const button = document.querySelector('button[aria-label="刷新会话列表"], button[aria-label="Refresh conversations"]');
      button?.click();
      return button !== null;
    })()`);
    await waitFor(`(() => {
      const button = [...document.querySelectorAll('.group-fold')].find(item => item.title === ${JSON.stringify(workspaceRoot)});
      if (button === undefined) return false;
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      return true;
    })()`, 10_000, 'observer_workspace_group_missing');
    await waitFor(`[...document.querySelectorAll('.session-item')].some(item => item.title.endsWith(${JSON.stringify(` · ${observerSessionId}`)}))`, 10_000, 'observer_session_not_listed');
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${observerSessionId}`)}));
      item?.click();
      return item !== undefined;
    })()`);
    await waitFor(`(() => {
      const banner = document.querySelector('.center .banner[role="status"]');
      const composer = document.querySelector('.external-session-composer');
      const normalComposer = document.querySelector('footer.composer:not(.external-session-composer)');
      const input = composer?.querySelector('textarea[aria-label="发送消息到外控会话"], textarea[aria-label="Send a message to the external session"]');
      const text = banner?.textContent ?? '';
      const configuration = composer?.querySelector('details.external-session-config-details');
      const summary = configuration?.querySelector('summary')?.textContent ?? '';
      const config = configuration?.querySelector('.external-session-config')?.textContent ?? '';
      const hasModel = (summary.includes('会话配置') || summary.includes('Session configuration'))
        && summary.split(' · ').length >= 3;
      const hasToolMode = config.includes('工具模式') || config.includes('Tool mode');
      const hasPolicy = config.includes('Policy');
      const hasPermission = config.includes('权限') || config.includes('Permission');
      return (text.includes('外控 Agent 正在运行') || text.includes('external agent is controlling'))
        && composer !== null && normalComposer === null && input?.readOnly === false
        && configuration !== null && composer.querySelector('details.external-session-grant') !== null
        && hasModel && hasToolMode && hasPolicy && hasPermission;
    })()`, 15_000, 'external_session_composer_or_config_missing');
    const sendDisabled = await evaluate(`document.querySelector('button.send')?.disabled === true`);
    assert.equal(sendDisabled, true, 'external_session_composer_must_start_empty');
    await evaluate(`document.querySelector('.external-session-grant summary')?.click()`);
    await waitFor(`(() => {
      const details = document.querySelector('.external-session-grant');
      const text = details?.textContent ?? '';
      return details?.open === true && (text.includes('权限上限') || text.includes('Permission ceiling'));
    })()`, 10_000, 'external_session_grant_details_missing');

    if (process.env.LIGULE_EXTERNAL_CONTROL_GAP_ONLY === '1') {
      const gapMetrics = await verifyExternalControlEventGap({ observerSessionId, draftAwaySessionId, mcpClient, takeoverAfter: true });
      return `Desktop 外控缺口恢复通过：${JSON.stringify(gapMetrics)}。真实 Electron 窗口由本地 Stub Provider 驱动。`;
    }

    const baseline = (await fetch(`${process.env.LIGULE_STUB_CONTROL}/state`).then(response => response.json())).requests;
    const started = await mcpClient.callTool({ name: 'ligule_run_start', arguments: {
      sessionId: observerSessionId,
      input: 'desktop-external-control-question',
    } });
    if (started.isError === true) throw Object.assign(new Error(`external_control_run_start_failed:${mcpStderr.slice(-500)}`), { code: JSON.parse(started.content?.[0]?.text ?? '{}').code ?? 'external_control_run_start_failed' });
    const operationId = started.structuredContent?.operationId;
    if (typeof operationId !== 'string') throw Object.assign(new Error('external_control_operation_id_missing'), { code: 'external_control_operation_id_missing' });
    try {
      await waitFor(`document.querySelector('.external-control .question')?.textContent.includes('Choose a route') === true`, 15_000, 'external_control_question_not_visible');
    } catch (error) {
      let questionPending = false;
      let diagnostic;
      try {
        const latest = await mcpClient.callTool({ name: 'ligule_run_status', arguments: { operationId, after: 0, limit: 50 } });
        questionPending = latest.isError !== true
          && latest.structuredContent?.pendingInteractions?.some(item => item.type === 'question' && item.sessionId === observerSessionId) === true;
        let desktopStatus;
        let desktopStatusError;
        try {
          desktopStatus = await requestHost('session.control', {
            projectRoot: workspaceRoot,
            sessionId: observerSessionId,
            request: { action: 'status', after: 0, limit: 50, waitMs: 0 },
          });
        } catch (statusError) {
          desktopStatusError = stableErrorCode(statusError);
        }
        const status = latest.structuredContent;
        diagnostic = JSON.stringify({
          operationState: status?.state ?? null,
          statusSessionMatches: status?.sessionId === observerSessionId,
          questionPending,
          pendingTypes: status?.pendingInteractions?.map(item => item.type) ?? [],
          desktopStatusError: desktopStatusError ?? null,
          desktopStatusMatches: desktopStatus?.resultSessionId === observerSessionId,
          desktopOperationState: desktopStatus?.operationState ?? null,
          desktopPendingTypes: desktopStatus?.pendingInteractionTypes ?? [],
          externalComposer: await evaluate(`document.querySelector('.external-session-composer') !== null`),
          externalQuestionCount: await evaluate(`document.querySelectorAll('.external-control .question').length`),
        });
      } catch {
        throw error;
      }
      if (!questionPending) throw Object.assign(error, { code: 'external_control_question_not_pending', diagnostic });
      throw Object.assign(error, { diagnostic });
    }
    try {
      await waitFor(`(() => {
        const source = document.querySelector('.row.question[data-source="controller"] .question-source')?.textContent ?? '';
        return source.includes('外部 Agent') || source.includes('External agent');
      })()`, 10_000, 'external_controller_message_source_not_visible');
    } catch (error) {
      const sourceRows = await evaluate(`([...document.querySelectorAll('.row.question')].map(row => ({
        source: row.dataset.source ?? null, className: row.className, text: row.textContent,
      })))`);
      const liveQuestion = await evaluate(`document.querySelector('.external-control .question')?.textContent ?? null`);
      const image = await mainWindow.webContents.capturePage();
      writeFileSync(join(evidenceRoot, 'external-controller-source-missing.png'), image.toPNG());
      writeFileSync(join(evidenceRoot, 'external-controller-source-missing.json'), `${JSON.stringify({ sourceRows, liveQuestion }, null, 2)}\n`, 'utf8');
      throw Object.assign(error, { diagnostic: JSON.stringify({ sourceRows, liveQuestion }) });
    }
    const questionDraft = 'desktop-external-question-draft';
    const enteredQuestion = await evaluate(`(() => {
      const card = document.querySelector('.external-control .question');
      const option = card?.querySelector('.question-option input');
      const extra = card?.querySelector('.question-free');
      if (option === null || option === undefined || extra === null || extra === undefined) return false;
      option.click();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(extra, ${JSON.stringify(questionDraft)});
      extra.dispatchEvent(new Event('input', { bubbles: true }));
      return option.checked && extra.value === ${JSON.stringify(questionDraft)};
    })()`);
    assert.equal(enteredQuestion, true, 'external_question_draft_setup_failed');
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${draftAwaySessionId}`)}));
      item?.click();
      return item !== undefined;
    })()`);
    await waitFor(`document.querySelector('.session-item.active')?.title.endsWith(${JSON.stringify(` · ${draftAwaySessionId}`)}) === true
      && document.querySelector('.external-session-composer') === null`, 10_000, 'external_question_switch_away_failed');
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${observerSessionId}`)}));
      item?.click();
      return item !== undefined;
    })()`);
    await waitFor(`(() => {
      const card = document.querySelector('.external-control .question');
      return card?.querySelector('.question-option input')?.checked === true
        && card?.querySelector('.question-free')?.value === ${JSON.stringify(questionDraft)};
    })()`, 10_000, 'external_question_draft_lost_after_navigation');
    const laterDraft = 'desktop-human-control-later-draft';
    const sendGate = holdNextExternalSendResponse();
    try {
      const typed = await evaluate(`(() => {
        const input = document.querySelector('.external-session-composer textarea[aria-label="发送消息到外控会话"], .external-session-composer textarea[aria-label="Send a message to the external session"]');
        if (input === null) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, 'desktop-human-control-followup');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      if (typed !== true) throw Object.assign(new Error('external_control_message_input_missing'), { code: 'external_control_message_input_missing' });
      await evaluate(`document.querySelector('.external-session-composer button.send')?.click(); true`);
      await waitForExternalSendResponse(sendGate);

      const editedWhileSending = await evaluate(`(() => {
        const input = document.querySelector('.external-session-composer textarea[aria-label="发送消息到外控会话"], .external-session-composer textarea[aria-label="Send a message to the external session"]');
        if (input === null) return null;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(laterDraft)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value;
      })()`);
      if (editedWhileSending !== laterDraft) {
        throw Object.assign(new Error('external_control_composer_must_allow_editing_while_send_is_pending'), {
          code: 'external_control_composer_must_allow_editing_while_send_is_pending',
        });
      }
      sendGate.release();
      await waitFor(`document.querySelector('.external-session-note')?.textContent.includes('已加入外控会话队列') === true
        || document.querySelector('.external-session-note')?.textContent.includes('queued for the external session') === true`, 10_000, 'external_control_message_not_queued');
      const remainingDraft = await evaluate(`document.querySelector('.external-session-composer textarea[aria-label="发送消息到外控会话"], .external-session-composer textarea[aria-label="Send a message to the external session"]')?.value ?? null`);
      if (remainingDraft !== laterDraft) {
        throw Object.assign(new Error('external_control_newer_draft_cleared'), {
          code: 'external_control_newer_draft_cleared',
          diagnostic: JSON.stringify({ expected: laterDraft, actual: remainingDraft }),
        });
      }
    } finally {
      sendGate.release();
    }
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.external-control .question-actions button')].find(item => /提交答案|Submit answers/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    await waitFor(`document.querySelector('.center')?.innerText.includes('desktop-human-control-followup') === true
      && document.querySelector('.center')?.innerText.includes('已收到人类补充消息') === true`, 25_000, 'external_control_human_message_not_recorded');
    await waitFor(`document.querySelector('.row.question[data-source="human"]')?.textContent.includes('desktop-human-control-followup') === true`, 10_000, 'human_message_source_not_visible');
    const afterHuman = (await fetch(`${process.env.LIGULE_STUB_CONTROL}/state`).then(response => response.json())).requests;
    assert.equal(afterHuman >= baseline + 3, true, 'external_control_model_turns_missing');
    const transcript = await mcpClient.callTool({ name: 'ligule_session_read', arguments: { sessionId: observerSessionId, limit: 50 } });
    const transcriptRecords = transcript.structuredContent.records.map(item => JSON.parse(item.json));
    const userRecords = transcriptRecords.filter(item => item.kind === 'user');
    assert.equal(userRecords.some(item => item.origin === 'controller' && item.text === 'desktop-external-control-question'), true, 'external_controller_origin_missing');
    assert.equal(userRecords.some(item => item.origin === 'human' && item.text === 'desktop-human-control-followup'), true, 'human_origin_missing');
    assert.equal(userRecords.some(item => item.origin === 'human' && item.text === laterDraft), false, 'newer_external_guidance_must_remain_unsent');
    const gapMetrics = await verifyExternalControlEventGap({ observerSessionId, draftAwaySessionId, mcpClient });

    const approvalStart = await mcpClient.callTool({ name: 'ligule_run_start', arguments: {
      sessionId: observerSessionId,
      input: 'desktop-external-control-approval',
    } });
    if (approvalStart.isError === true) throw Object.assign(new Error('external_control_approval_start_failed'), { code: JSON.parse(approvalStart.content?.[0]?.text ?? '{}').code ?? 'external_control_approval_start_failed' });
    const fetchTarget = process.env.LIGULE_STUB_FETCH_TARGET;
    if (typeof fetchTarget !== 'string' || fetchTarget === '') throw Object.assign(new Error('external_control_fetch_target_missing'), { code: 'external_control_fetch_target_missing' });
    await waitFor(`document.querySelector('.external-control .approval .row-tool')?.textContent.trim() === 'fetch'`, 15_000, 'external_control_approval_not_visible');
    await waitFor(`(() => [...document.querySelectorAll('.external-control .approval .row-target')]
      .some(item => item.textContent?.trim() === ${JSON.stringify(fetchTarget)}))()`, 10_000, 'external_control_approval_target_not_visible');
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.external-control .approval')].find(item => item.querySelector('.row-tool')?.textContent.trim() === 'fetch');
      const button = card?.querySelector('button[data-tone="allow"]');
      button?.click();
      return button !== null && button !== undefined;
    })()`);
    await waitFor(`document.querySelector('.center')?.innerText.includes('外控审批已通过') === true`, 20_000, 'external_control_approval_not_completed');
    const fetchState = await fetch(`${process.env.LIGULE_STUB_CONTROL}/state`).then(response => response.json());
    assert.equal(fetchState.externalFetchCount, 1, 'human_approval_did_not_allow_the_bound_fetch');

    await fetch(`${process.env.LIGULE_STUB_CONTROL}/hang`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hang: true }) });
    await evaluate(`(() => {
      const input = document.querySelector('.external-session-composer textarea[aria-label="发送消息到外控会话"], .external-session-composer textarea[aria-label="Send a message to the external session"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'desktop-human-control-cancel');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.external-session-composer button.send')?.click();
      return true;
    })()`);
    await waitFor(`(() => [...document.querySelectorAll('.external-control-head button')].some(item => /停止本轮|Stop turn/u.test(item.textContent ?? '')))()`, 15_000, 'external_control_cancel_button_missing');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.external-control-head button')].find(item => /停止本轮|Stop turn/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    await waitFor(`document.querySelector('.external-control .external-control-state')?.textContent.includes('已停止') === true
      || document.querySelector('.external-control .external-control-state')?.textContent.includes('Stopped') === true`, 20_000, 'external_control_cancel_not_confirmed');
    await fetch(`${process.env.LIGULE_STUB_CONTROL}/hang`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hang: false }) });

    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.external-control-head button')].find(item => /接管会话|Take over/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    await waitFor(`document.querySelector('.confirm .confirm-lead')?.textContent.includes('停止外控') === true
      || document.querySelector('.confirm .confirm-lead')?.textContent.includes('Stop external control') === true`, 5_000, 'external_control_takeover_confirmation_missing');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.confirm-actions button')].find(item => /接管|Take over/u.test(item.textContent ?? ''));
      button?.click();
      return button !== undefined;
    })()`);
    await waitFor(`document.querySelector('.external-control') === null
      && document.querySelector('textarea.composer-input')?.readOnly === false`, 20_000, 'external_control_takeover_not_completed');
    const refused = await mcpClient.callTool({ name: 'ligule_run_start', arguments: { sessionId: observerSessionId, input: 'after takeover' } });
    assert.equal(refused.isError, true, 'external_controller_kept_write_access_after_takeover');
    const refusalCode = JSON.parse(refused.content?.[0]?.text ?? '{}').code;
    assert.equal(refusalCode, 'control_session_taken_over', 'external_controller_takeover_not_enforced');

    if (typeof previousSessionId === 'string') {
      await evaluate(`(() => {
        const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${previousSessionId}`)}));
        item?.click();
        return item !== undefined;
      })()`);
      await waitFor(`(() => {
        const active = document.querySelector('.session-item.active');
        const input = document.querySelector('textarea.composer-input');
        return active?.title.endsWith(${JSON.stringify(` · ${previousSessionId}`)}) === true && input?.readOnly === false;
      })()`, 10_000, 'observer_previous_session_restore_failed');
    }
    return `真实 Electron 窗口验证外控事件缺口提示与持久转录恢复；gap=${JSON.stringify(gapMetrics)}；并覆盖草稿切换、fetch 审批、队列、取消和接管。Provider 为本地固定 SSE stub，不构成真实模型验收。`;
  } finally {
    await fetch(`${process.env.LIGULE_STUB_CONTROL}/hang`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hang: false }) }).catch(() => {});
    await mcpClient.close().catch(() => {});
    if (typeof previousSessionId === 'string') {
      await evaluate(`(() => {
        const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${previousSessionId}`)}));
        if (!item?.classList.contains('active')) item?.click();
      })()`).catch(() => {});
    }
  }
}

async function enterAndSend(text) {
  await waitFor(`document.querySelector('textarea.composer-input') && !document.querySelector('textarea.composer-input').readOnly`, 20_000, 'composer_locked');
  const escaped = JSON.stringify(text);
  await evaluate(`(() => {
    const input = document.querySelector('textarea.composer-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    input.focus();
    setter.call(input, ${escaped});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${escaped} }));
    return true;
  })()`);
  const ready = await waitFor(`document.querySelector('button.send') && !document.querySelector('button.send').disabled`, 8_000, 'composer_input_not_adopted').catch(() => false);
  if (!ready) {
    const state = await evaluate(`(() => {
      const input = document.querySelector('textarea.composer-input');
      const send = document.querySelector('button.send');
      return { inputPresent: input !== null, readOnly: input?.readOnly ?? true, valueLength: input?.value.length ?? 0, sendPresent: send !== null, sendDisabled: send?.disabled ?? true };
    })()`);
    const code = state.readOnly ? 'composer_locked' : state.valueLength === 0 ? 'composer_input_event_ignored' : 'composer_send_disabled';
    throw Object.assign(new Error(code), { code });
  }
  await evaluate(`document.querySelector('button.send').click(); true`);
}

async function enterUnsentDraft(text) {
  await waitFor(`document.querySelector('textarea.composer-input') && !document.querySelector('textarea.composer-input').readOnly`, 20_000, 'composer_locked');
  const escaped = JSON.stringify(text);
  await evaluate(`(() => {
    const input = document.querySelector('textarea.composer-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    input.focus();
    setter.call(input, ${escaped});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${escaped} }));
    return true;
  })()`);
  await waitFor(`document.querySelector('textarea.composer-input')?.value === ${escaped}`, 8_000, 'composer_draft_not_adopted');
}

async function waitForSavedSessionInput(projectRoot, id, draft, queued, timeoutMs = 10_000) {
  const path = join(isolatedHome, 'desktop.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const settings = JSON.parse(await require('node:fs/promises').readFile(path, 'utf8'));
      if (settings.drafts?.[projectRoot]?.[id] === draft
        && settings.queued?.[projectRoot]?.[id]?.includes(queued) === true) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw Object.assign(new Error('crash_recovery_inputs_not_persisted'), { code: 'crash_recovery_inputs_not_persisted' });
}

async function verifyQuestionDraftSurvivesSessionSwitchAndSubmission() {
  if (typeof sessionId !== 'string') throw Object.assign(new Error('session_question_session_missing'), { code: 'session_question_session_missing' });
  const stubControl = process.env.LIGULE_STUB_CONTROL;
  if (typeof stubControl !== 'string' || stubControl === '') {
    throw Object.assign(new Error('session_question_stub_control_missing'), { code: 'session_question_stub_control_missing' });
  }
  const owner = sessionId;
  const draft = 'desktop-session-question-draft-answer';
  const stateResponse = await fetch(`${stubControl}/state`);
  if (!stateResponse.ok) throw Object.assign(new Error('session_question_stub_state_unavailable'), { code: 'session_question_stub_state_unavailable' });
  const initialStubState = await stateResponse.json();
  const initialFollowups = initialStubState.sessionQuestionFollowups ?? 0;
  const questionRun = requestHost('run.start', { sessionId: owner, input: 'desktop-session-question-draft' })
    .then(result => ({ result }), error => ({ error }));
  let awaySessionId;
  let step = 'question-card';
  try {
    await waitFor(`(() => [...document.querySelectorAll('.question')]
      .some(item => item.closest('.external-control') === null && item.querySelector('.question-item') !== null
        && item.textContent.includes('Choose a session route')))()`,
    15_000, 'session_question_card_not_visible');
    step = 'type-draft';
    const entered = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.question')].find(item => item.closest('.external-control') === null
        && item.textContent.includes('Choose a session route'));
      const option = [...(card?.querySelectorAll('.question-option') ?? [])]
        .find(item => item.textContent.includes('north'))?.querySelector('input');
      const extra = card?.querySelector('.question-free');
      if (option === null || option === undefined || extra === null || extra === undefined) return false;
      option.click();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(extra, ${JSON.stringify(draft)});
      extra.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(draft)} }));
      return option.checked && extra.value === ${JSON.stringify(draft)}
        && card?.querySelector('.question-actions button[data-tone="allow"]')?.disabled === false;
    })()`);
    assert.equal(entered, true, 'session_question_draft_setup_failed');
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

    step = 'create-away-session';
    const away = await requestHost('session.create', { projectRoot: workspaceRoot });
    awaySessionId = away.createdSessionId;
    if (typeof awaySessionId !== 'string') throw Object.assign(new Error('session_question_away_session_missing'), { code: 'session_question_away_session_missing' });
    await requestHost('session.close', { sessionId: awaySessionId });
    await waitFor(`document.querySelector('button[aria-label="刷新会话列表"]') || document.querySelector('button[aria-label="Refresh conversations"]')`,
      10_000, 'session_rail_refresh_missing');
    await evaluate(`(() => {
      const button = document.querySelector('button[aria-label="刷新会话列表"], button[aria-label="Refresh conversations"]');
      button?.click();
      return button !== null;
    })()`);
    await waitFor(`[...document.querySelectorAll('.session-item')].some(item => item.title.endsWith(${JSON.stringify(` · ${awaySessionId}`)}))`,
      10_000, 'session_question_away_session_not_listed');
    step = 'open-away-session';
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${awaySessionId}`)}));
      item?.click();
      return item !== undefined;
    })()`);
    await waitFor(`document.querySelector('.session-item.active')?.title.endsWith(${JSON.stringify(` · ${awaySessionId}`)}) === true
      && document.querySelector('.question') === null`, 10_000, 'session_question_switch_away_failed');
    step = 'reopen-owner-session';
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${owner}`)}));
      item?.click();
      return item !== undefined;
    })()`);
    await waitFor(`(() => {
      const card = [...document.querySelectorAll('.question')].find(item => item.closest('.external-control') === null
        && item.textContent.includes('Choose a session route'));
      const selected = card?.querySelector('.question-option input:checked')?.closest('.question-option');
      return document.querySelector('.session-item.active')?.title.endsWith(${JSON.stringify(` · ${owner}`)}) === true
        && selected?.textContent.includes('north') === true
        && card?.querySelector('.question-free')?.value === ${JSON.stringify(draft)}
        && card?.querySelector('.question-actions button[data-tone="allow"]')?.disabled === false;
    })()`, 10_000, 'session_question_draft_lost_after_navigation');

    step = 'submit-restored-answer';
    await clickWithMouse('.question-actions button[data-tone="allow"]', 'session_question_submit_mouse_target_missing');
    const completedRun = await questionRun;
    if (completedRun.error !== undefined) throw completedRun.error;
    const summary = await waitForSessionIdle(20_000, 'session_question_turn_did_not_complete');
    assert.equal(summary.turns.at(-1)?.status, 'completed', 'session_question_turn_terminal_status_invalid');
    step = 'verify-host-answer';
    const record = await requestHost('session.read', { sessionId: owner, fullResults: true });
    const questionAnswer = record.events.findLast(event => event.kind === 'tool' && event.tool === 'ask_user_question');
    assert.equal(questionAnswer?.resultKind, 'result', 'session_question_host_answer_not_recorded');
    assert.equal(questionAnswer.resultHasSessionQuestionOption === true && questionAnswer.resultHasSessionQuestionDraft === true,
      true, 'session_question_host_answer_incomplete');

    step = 'verify-provider-followup';
    const finalStateResponse = await fetch(`${stubControl}/state`);
    if (!finalStateResponse.ok) throw Object.assign(new Error('session_question_stub_state_unavailable'), { code: 'session_question_stub_state_unavailable' });
    const finalStubState = await finalStateResponse.json();
    assert.equal(finalStubState.sessionQuestionFollowups, initialFollowups + 1, 'session_question_followup_provider_request_missing');
    assert.deepEqual(finalStubState.lastSessionQuestionAnswer, { includesOption: true, includesDraft: true },
      'session_question_answer_not_forwarded_to_provider');

    return '普通会话问题的选项与自由文本跨会话切换后恢复；Electron 鼠标提交后 Host 完成本轮并将完整答案发送到 Provider followup';
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.diagnostic === undefined) {
      error.diagnostic = `normal-question-step:${step}`;
    }
    throw error;
  } finally {
    if (typeof awaySessionId === 'string') {
      await evaluate(`(() => {
        const item = [...document.querySelectorAll('.session-item')].find(button => button.title.endsWith(${JSON.stringify(` · ${owner}`)}));
        item?.click();
        return item !== undefined;
      })()`).catch(() => undefined);
      await waitFor(`document.querySelector('.session-item.active')?.title.endsWith(${JSON.stringify(` · ${owner}`)}) === true`,
        5_000, 'session_question_owner_restore_failed').catch(() => undefined);
      await requestHost('session.close', { sessionId: awaySessionId }).catch(() => undefined);
    }
  }
}

async function recordReport(exitCode) {
  const prefsReadRequest = hostRequests.find(request => request.method === 'prefs.read');
  const prefsReadResponse = prefsReadRequest === undefined ? undefined : hostResponses.findLast(response => response.id === prefsReadRequest.id);
  const report = {
    platform: process.platform,
    release: require('node:os').release(),
    electron: process.versions.electron,
    hostNode: require('node:child_process').execFileSync(hostNodeRuntime, ['--version'], { encoding: 'utf8', windowsHide: process.platform === 'win32' }).trim(),
    applicationPage: security.APP_PAGE,
    provider: providerLabel,
    workspace: workspaceRoot,
    workspaceReadinessMs,
    prefsReadMs: prefsReadRequest === undefined || prefsReadResponse === undefined
      ? null : prefsReadResponse.receivedAt - prefsReadRequest.sentAt,
    policy: 'ask',
    cspObserved: typeof observedCsp === 'string' && observedCsp.includes("default-src 'self'") && observedCsp.includes("script-src 'self'"),
    sessionId,
    exitCode,
    results,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, `${evidenceName}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(evidenceRoot, `${evidenceName}.log`), `${results.map(item => `${item.name} ${item.status}${item.code === undefined ? '' : ` ${item.code}`}: ${item.detail}`).join('\n')}\n`, 'utf8');
}

async function runChecks() {
  const externalControlOnly = process.env.LIGULE_EXTERNAL_CONTROL_ONLY === '1';
  const preferences = mainWindow.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);

  const workspaceReadinessStartedAt = process.hrtime.bigint();
  const workspaceRegistration = await requestHost('workspaces.list', {}, workspaceStartupTimeoutMs);
  workspaceReadinessMs = Number(process.hrtime.bigint() - workspaceReadinessStartedAt) / 1_000_000;
  assert.ok(workspaceRegistration.workspaces.some(item => resolve(item.directory) === resolve(workspaceRoot)), 'isolated_workspace_not_registered');

  // 新会话默认只读；审批用例先通过真实设置控件授予工作区文件工具写入权限。
  if (!externalControlOnly) await selectNewSessionPermission('workspace-write');
  if (externalControlOnly) {
    await check('MCP 外控会话的人类观察、干预与接管', verifyExternalSessionControl);
    return;
  }

  await check(`${providerLabel}工具审批拒绝`, async () => {
    await enterAndSend('请调用 create 工具，在项目根目录创建 model-denial-proof.txt，内容只写 DENIED。必须先调用工具，再简短说明结果。');
    await waitFor(`window.__realModelFrames.some(frame => typeof frame.createdSessionId === 'string')`, 15_000, 'session_create_response_missing');
    sessionId = await evaluate(`window.__realModelFrames.find(frame => typeof frame.createdSessionId === 'string').createdSessionId`);
    await waitFor(`window.__realModelFrames.some(frame => frame.method === 'approval.request') || window.__realModelFrames.some(frame => typeof frame.errorCode === 'string')`, 100_000, 'model_approval_wait_timeout');
    const request = await evaluate(`window.__realModelFrames.find(frame => frame.method === 'approval.request') ?? null`);
    if (request === null) {
      const error = await evaluate(`window.__realModelFrames.find(frame => typeof frame.errorCode === 'string')?.errorCode ?? 'model_request_failed'`);
      throw Object.assign(new Error('real_model_request_failed'), { code: error });
    }
    assert.equal(request.approvalTool, 'create', 'model_did_not_request_create_tool');
    await waitFor(`document.querySelector('.approval button[data-tone="deny"]')`, 15_000, 'approval_card_not_rendered');
    await evaluate(`document.querySelector('.approval button[data-tone="deny"]').click(); true`);
    await waitFor(`window.__realModelFrames.some(frame => frame.notify === 'event' && frame.sessionId === ${JSON.stringify(sessionId)})`, 15_000, 'approval_reply_event_missing');
    const summary = await waitForSessionIdle(25_000, 'approval_turn_did_not_finish');
    const fileExists = await require('node:fs/promises').access(join(workspaceRoot, 'model-denial-proof.txt')).then(() => true, () => false);
    assert.equal(fileExists, false, 'denied_tool_created_file');
    assert.equal(summary.tools.some(item => item.tool === 'create' && item.kind === 'refusal'), true, 'denied_tool_refusal_not_recorded');
    return `真实 Host 请求 create 审批；界面拒绝后记录 refusal，目标文件不存在`;
  });

  await check(`${providerLabel}工具审批允许`, async () => {
    if (typeof sessionId !== 'string') throw Object.assign(new Error('approval_session_unavailable'), { code: 'approval_session_unavailable' });
    const target = join(workspaceRoot, 'model-allow-proof.txt');
    await require('node:fs/promises').rm(target, { force: true });
    const before = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length`);
    await enterAndSend('请调用 create 工具，在项目根目录创建 model-allow-proof.txt，内容只写 ALLOWED。必须先调用工具，再简短说明结果。');
    await waitFor(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${before}`, 100_000, 'model_approval_wait_timeout');
    await waitFor(`document.querySelector('.approval button[data-tone="allow"]')`, 15_000, 'approval_card_not_rendered');
    await evaluate(`document.querySelector('.approval button[data-tone="allow"]').click(); true`);
    // Host 可能先执行工具再结束回合；等待回合结束且工具结果写入后再检查状态。
    const deadline = Date.now() + 30_000;
    let summary = null;
    while (Date.now() < deadline) {
      summary = await sessionSummary();
      if (summary.running === false && summary.tools.some(item => item.tool === 'create' && item.kind === 'result')) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    }
    assert.equal(summary?.tools.some(item => item.tool === 'create' && item.kind === 'result'), true, 'approved_tool_result_not_recorded');
    const content = await require('node:fs/promises').readFile(target, 'utf8').catch(() => null);
    assert.equal(content?.trim(), 'ALLOWED', 'approved_tool_did_not_write_file');
    return '真实 Host 请求 create 审批；界面允许后由 Host 写入目标文件并记录 result';
  });

  const stubControl = process.env.LIGULE_STUB_CONTROL;
  if (typeof stubControl === 'string' && stubControl !== '') {
    await check(`${providerLabel}代码复制与界面语言`, async () => {
      await enterAndSend('desktop-code-copy-proof');
      await waitForSessionIdle(30_000, 'code_copy_turn_did_not_finish');
      await waitFor(`document.querySelector('.code-copy')`, 10_000, 'code_copy_button_missing');
      assert.equal(await evaluate(`document.querySelector('.md-code code').textContent`), 'console.log("原始代码🙂 <img src=x onerror=alert(1)>");');
      assert.equal(await evaluate(`document.querySelector('.md-code code img') === null`), true, 'code_markup_was_interpreted');
      assert.equal(await evaluate(`document.querySelector('.md-code code span[class^="hljs-"]') !== null`), true, 'code_highlighting_missing');
      const originalLanguage = await evaluate('document.documentElement.lang');
      try {
        for (const language of ['en', 'zh']) {
          await evaluate(`document.querySelector('button.entry').click(); true`);
          await waitFor(`document.querySelector('.sheet-body select option[value="en"]')`, 10_000, 'language_setting_missing');
          await evaluate(`(() => {
            const select = [...document.querySelectorAll('.sheet-body select')].find(item => item.querySelector('option[value="en"]'));
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(language)});
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`);
          await waitFor(`document.documentElement.lang === ${JSON.stringify(language === 'zh' ? 'zh-CN' : 'en')}`, 5_000, 'language_setting_not_adopted');
          await evaluate(`document.querySelector('.sheet-head button').click(); true`);
          await waitFor(`!document.querySelector('.sheet')`, 5_000, 'settings_did_not_close');
          assert.equal(await evaluate(`document.querySelector('.code-copy').textContent`), language === 'en' ? 'Copy code' : '复制代码');
          if (language === 'zh') {
            assert.equal(await evaluate(`document.querySelector('.code-copy-row .row-note')?.textContent.startsWith('已复制代码（')`), true, 'existing_copy_feedback_not_translated');
          }
          await evaluate(`document.querySelector('.code-copy').click(); true`);
          const prefix = language === 'en' ? 'Copied code (' : '已复制代码（';
          await waitFor(`document.querySelector('.code-copy-row .row-note')?.textContent.startsWith(${JSON.stringify(prefix)})`, 5_000, 'code_copy_success_not_localized');
          const clipboardText = await require('electron').clipboard.readText();
          const expectedCode = 'console.log("原始代码🙂 <img src=x onerror=alert(1)>");';
          assert.equal(clipboardText === expectedCode, true, 'code_copy_changed_original_text');
        }
        const image = await mainWindow.webContents.capturePage();
        writeFileSync(join(evidenceRoot, 'code-copy-localized.png'), image.toPNG());
      } finally {
        await evaluate(`document.querySelector('button.entry').click(); true`);
        await waitFor(`document.querySelector('.sheet-body select option[value="en"]')`, 10_000, 'language_setting_missing');
        await evaluate(`(() => {
          const select = [...document.querySelectorAll('.sheet-body select')].find(item => item.querySelector('option[value="en"]'));
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(originalLanguage.startsWith('zh') ? 'zh' : 'en')});
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await evaluate(`document.querySelector('.sheet-head button').click(); true`);
        await waitFor(`!document.querySelector('.sheet')`, 5_000, 'settings_did_not_close');
      }
      return '真实 Electron 页面切换中英文，复制按钮与成功反馈跟随语言，系统剪贴板保留原始代码';
    });
    await check(`${providerLabel}Skill 与 MCP 权限边界`, async () => {
      if (typeof sessionId !== 'string') throw Object.assign(new Error('skill_mcp_session_unavailable'), { code: 'skill_mcp_session_unavailable' });
      const approvalCount = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length`);
      await enterAndSend('执行 desktop-skill-mcp-load-proof：激活 desktop-smoke Skill，检查当前会话是否提供 MCP 工具，并简短说明权限边界。');
      await waitFor(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${approvalCount}`, 60_000, 'skill_activation_approval_missing');
      const skillApproval = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').at(-1)?.approvalTool ?? null`);
      if (skillApproval !== 'skill') throw Object.assign(new Error('skill_activation_approval_not_requested'), { code: 'skill_activation_approval_not_requested' });
      await allowApproval('skill', approvalCount, 'skill_mcp_approval_card_missing');
      await waitForSessionIdle(60_000, 'skill_mcp_turn_did_not_finish');

      const record = await requestHost('session.read', { sessionId, fullResults: true });
      const events = record.events ?? [];
      const skill = events.findLast(event => event.kind === 'tool' && event.tool === 'skill');
      if (skill?.resultKind !== 'result' || skill.resultFailed) throw Object.assign(new Error('skill_activation_result_missing'), { code: 'skill_activation_result_missing' });
      if (skill.resultHasSkillProof !== true) throw Object.assign(new Error('project_skill_body_not_loaded'), { code: 'project_skill_body_not_loaded' });
      const inspected = events.findLast(event => event.kind === 'tool' && event.tool === 'mcp.inspect');
      if (inspected?.resultCode !== 'mcp_server_untrusted') {
        throw Object.assign(new Error('untrusted_mcp_server_was_not_denied'), { code: 'untrusted_mcp_server_was_not_denied' });
      }
      if (events.some(event => event.kind === 'tool' && event.tool === 'mcp.call')) {
        throw Object.assign(new Error('mcp_call_ran_without_trusted_server'), { code: 'mcp_call_ran_without_trusted_server' });
      }

      const response = await fetch(`${stubControl}/state`);
      const state = await response.json();
      for (const [key, expected, code] of [
        ['skillToolAvailable', true, 'skill_mcp_skill_tool_not_available'],
        ['skillActivated', true, 'skill_mcp_skill_not_activated'],
        ['mcpInspectAvailable', true, 'mcp_inspect_not_disclosed'],
        ['mcpCallAvailable', true, 'mcp_call_not_disclosed'],
        ['mcpInspectRequested', true, 'untrusted_mcp_inspect_not_requested'],
      ]) {
        if (state.skillMcpProof?.[key] !== expected) throw Object.assign(new Error(code), { code });
      }
      return '真实 Electron 窗口装载项目 Skill；MCP 披露工具可见，但未信任的 Server 在 Host 预检中被拒绝，未启动 MCP Server 或执行其工具';
    });
  }

  await check(`${providerLabel}流式取消`, async () => {
    if (typeof sessionId !== 'string') throw Object.assign(new Error('approval_session_unavailable'), { code: 'approval_session_unavailable' });
    await enterAndSend('请用中文连续写一篇很长的说明，至少输出三千字，不要调用工具。');
    const initial = await evaluate(`window.__realModelFrames.filter(frame => frame.notify === 'delta' && frame.deltaType === 'text').length`);
    await waitFor(`window.__realModelFrames.filter(frame => frame.notify === 'delta' && frame.deltaType === 'text').length > ${initial}`, 60_000, 'model_text_stream_missing');
    await waitFor(`document.querySelector('button.stop-button')`, 5_000, 'turn_stop_control_missing');
    await evaluate(`document.querySelector('button.stop-button').click(); true`);
    const summary = await waitForSessionIdle(20_000, 'cancelled_turn_did_not_finish');
    assert.equal(summary.turns.at(-1)?.status, 'cancelled', 'cancelled_turn_terminal_status_invalid');
    return `收到真实 text 增量 ${summary.deltaCount ?? 1} 次后按界面停止；Host 写入 cancelled 终态`;
  });

  if (process.env.LIGULE_EXTERNAL_CONTROL_TEST === '1') {
    await check('MCP 外控会话的人类观察、干预与接管', verifyExternalSessionControl);
  }

  // 仅本地 stub 可稳定模拟请求发出后一直没有响应的情况。
  if (typeof stubControl === 'string' && stubControl !== '') {
    await check(`${providerLabel}宿主崩溃后的界面重连`, async () => {
      if (typeof sessionId !== 'string') throw Object.assign(new Error('approval_session_unavailable'), { code: 'approval_session_unavailable' });
      const control = async (path, body) => {
        const response = await fetch(`${stubControl}${path}`, body === undefined
          ? {}
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return response.json();
      };
      await control('/hang', { hang: true });
      const before = (await control('/state')).requests;
      await enterAndSend('请写一篇很长的说明，先不要结束。');
      await waitFor(`document.querySelector('button.stop-button') !== null`, 25_000, 'crash_turn_not_running');
      const receivedDeadline = Date.now() + 20_000;
      let received = before;
      while (Date.now() < receivedDeadline) {
        received = (await control('/state')).requests;
        if (received > before) break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
      }
      assert.equal(received > before, true, 'model_request_not_received');
      const crashRequestStart = hostRequests.length;
      const queuedText = 'desktop-crash-recovery-queued';
      await enterAndSend(queuedText);
      await waitFor(`document.querySelector('.queue-item .queue-text')?.textContent === ${JSON.stringify(queuedText)}`, 8_000, 'crash_recovery_queue_not_visible');
      const unsentDraft = 'desktop-crash-recovery-unsent-draft';
      await enterUnsentDraft(unsentDraft);
      await waitForSavedSessionInput(workspaceRoot, sessionId, unsentDraft, queuedText);
      const killedPid = host.pid;
      assert.equal(typeof killedPid, 'number', 'host_pid_unavailable');
      process.kill(killedPid);
      // 页面可能同时显示多个 alert；按按钮文字定位断连提示中的重试按钮。
      const reconnectButton = `[...document.querySelectorAll('.banner[role="alert"] button')].find((button) => /重新连接|Reconnect/u.test(button.textContent ?? '')) ?? null`;
      await waitFor(`${reconnectButton} !== null`, 30_000, 'disconnected_banner_missing');
      const clickAt = Date.now();
      const reopenRequestStart = hostRequests.length;
      await evaluate(`{ const button = (${reconnectButton}); button.click(); button.click(); } true`);
      let cleared = false;
      while (Date.now() < clickAt + 45_000) {
        if (await evaluate(`${reconnectButton} === null`)) { cleared = true; break; }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
      }
      if (!cleared) throw Object.assign(new Error('reconnect_did_not_recover'), { code: 'reconnect_did_not_recover' });
      if (await evaluate(`/无法启动后端|Could not start the host/u.test(document.body.innerText)`)) {
        throw Object.assign(new Error('repeated_reconnect_started_another_lifecycle'), { code: 'repeated_reconnect_started_another_lifecycle' });
      }
      // 断连提示消失只表示新 Host 已启动；等待应用自己的 session.read 成功，避免探测请求与恢复竞态。
      const reopenDeadline = clickAt + 45_000;
      let reopened = false;
      while (Date.now() < reopenDeadline) {
        const uiOpen = hostRequests.slice(reopenRequestStart).findLast(request =>
          request.method === 'session.open' && request.sessionId === sessionId && !String(request.id).startsWith('real-model-rpc-'));
        if (uiOpen !== undefined) {
          assert.equal(uiOpen.projectRootScope, 'matches_workspace', 'reconnect_session_open_project_mismatch');
          assert.notEqual(uiOpen.hostPid, killedPid, 'reconnect_session_open_used_old_host');
        }
        const uiRead = hostRequests.slice(reopenRequestStart).findLast(request =>
          request.method === 'session.read' && request.sessionId === sessionId && !String(request.id).startsWith('real-model-rpc-'));
        if (uiRead !== undefined) {
          assert.equal(uiRead.projectRootScope, 'omitted', 'reconnect_session_read_project_scope_invalid');
          assert.notEqual(uiRead.hostPid, killedPid, 'reconnect_session_read_used_old_host');
          const response = hostResponses.find(item => item.id === uiRead.id);
          if (response !== undefined) {
            if (response.errorCode === undefined) {
              assert.ok(uiOpen !== undefined, 'reconnect_session_open_not_observed');
              reopened = true;
              break;
            }
            if (response.errorCode !== 'session_not_open' && response.errorCode !== 'session_locked') {
              throw Object.assign(new Error(response.errorCode), { code: response.errorCode });
            }
          }
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      }
      if (!reopened) {
        const requests = hostRequests.slice(reopenRequestStart).map(request => {
          const response = hostResponses.find(item => item.id === request.id);
          return {
            ...request,
            result: response === undefined ? 'pending' : response.errorCode ?? 'ok',
            elapsedMs: response === undefined ? undefined : response.receivedAt - request.sentAt,
          };
        });
        const visible = await evaluate(`(() => ({
          activeSession: document.querySelector('.session-item.active')?.title ?? null,
          composerReadOnly: document.querySelector('textarea.composer-input')?.readOnly ?? true,
          prefsFailure: document.querySelector('.banner[role="alert"]')?.textContent ?? '',
          page: document.body.innerText.replace(/\\s+/gu, ' ').slice(0, 700),
        }))()`);
        console.log(`CRASH-DIAG trace=${JSON.stringify({ requests, visible })}`);
        throw Object.assign(new Error('session_reopen_timeout'), { code: 'session_reopen_timeout' });
      }
      const summary = await waitForSessionIdle(30_000, 'recovered_session_not_idle');
      const restoredInput = await evaluate(`(() => ({
        draft: document.querySelector('textarea.composer-input')?.value ?? '',
        queued: [...document.querySelectorAll('.queue-item .queue-text')].map(item => item.textContent ?? ''),
        readOnly: document.querySelector('textarea.composer-input')?.readOnly ?? true,
        prefsFailure: document.querySelector('.banner[role="alert"]')?.textContent ?? '',
      }))()`);
      const reopenCalls = hostRequests.slice(reopenRequestStart).map(request => {
        const response = hostResponses.find(item => item.id === request.id);
        return {
          method: request.method,
          projectRootScope: request.projectRootScope,
          hostPid: request.hostPid,
          result: response === undefined ? 'pending' : response.errorCode ?? 'ok',
          elapsedMs: response === undefined ? undefined : response.receivedAt - request.sentAt,
        };
      });
      console.log(`CRASH-RECOVERY-DIAG ${JSON.stringify({ reopenCalls, restoredInput })}`);
      assert.equal(restoredInput.readOnly, false, 'recovered_composer_remained_locked');
      assert.equal(restoredInput.draft.includes(unsentDraft), true, 'crash_recovery_lost_unsent_draft');
      assert.equal(restoredInput.draft.includes(queuedText), true, 'crash_recovery_lost_queued_message');
      assert.deepEqual(restoredInput.queued, [], 'crash_recovery_left_queue_armed');
      const after = (await control('/state')).requests;
      await control('/hang', { hang: false });
      assert.equal(after, received, 'reconnect_replayed_the_request');
      const last = summary.turns.at(-1) ?? {};
      assert.equal(last.status, 'interrupted', 'pending_turn_status_after_host_restart');
      assert.equal(last.code, 'host_restarted', 'pending_turn_code_after_host_restart');
      const requestSummary = hostRequests.slice(crashRequestStart).flatMap(request => {
        if (!['session.open', 'session.read', 'session.observe', 'prefs.read', 'prefs.write'].includes(request.method)) return [];
        const response = hostResponses.find(item => item.id === request.id);
        return [{
          method: request.method,
          hostPid: request.hostPid,
          projectRootScope: request.projectRootScope,
          result: response === undefined ? 'pending' : response.errorCode ?? 'ok',
          elapsedMs: response === undefined ? null : response.receivedAt - request.sentAt,
        }];
      });
      return `硬杀 Host（PID ${killedPid}）后界面恢复会话与草稿/队列；未决那一轮终态 ${last.status ?? '无'}${last.code === undefined ? '' : `/${last.code}`}，模型请求数未增加。RPC 阶段：${JSON.stringify(requestSummary)}`;
    });
  }

  if (typeof stubControl === 'string' && stubControl !== '') {
    await check(`${providerLabel}普通会话问题恢复、鼠标提交与 Provider followup`, verifyQuestionDraftSurvivesSessionSwitchAndSubmission);
  }

}

async function cleanup() {
  try { await host?.stop(); } catch { failed = true; }
  try { detachIpc?.(); } catch { failed = true; }
  try { nativeServices?.dispose(); } catch { failed = true; }
  try { if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch { failed = true; }
}

(async () => {
  let exitCode = 0;
  try {
    await createApplication();
    phase = 'run_model_checks';
    await runChecks();
    if (failed) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    const code = stableErrorCode(error);
    note(`${providerLabel}验收启动`, '失败', `阶段 ${phase}，位置 ${safeErrorLocation(error)}。`, code);
  } finally {
    await cleanup();
    if (failed) exitCode = 1;
    try { await recordReport(exitCode); } catch (error) {
      exitCode = 1;
      note('证据写入', '失败', `脱敏报告写入位置 ${safeErrorLocation(error)}。`, stableErrorCode(error));
      try {
        writeFileSync(join(evidenceRoot, `${evidenceName}.json`), `${JSON.stringify({ platform: process.platform, electron: process.versions.electron, exitCode, results }, null, 2)}\n`, 'utf8');
      } catch {}
    }
    process.exitCode = exitCode;
    app.quit();
  }
})();
