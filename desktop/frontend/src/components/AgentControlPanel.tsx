import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { Icon } from './Icon';
import { Group, Modal, Row } from './ui';
import { GrantOverview } from './GrantOverview';
import { applyGrantPreset, grantPreset, grantPresets, type GrantPresetId } from '../agent-control-presets';
import type { Grant, NetworkLimit, PermissionProfile, PolicySelection } from './agent-control-types';
import { createGrantRequest, emptyGrantDraft, grantDraftFlags, grantReady, grantState, limitsReady, sameProjectPath, type GrantDraft } from '../agent-control-draft';
import { requestIsCurrent } from '../request-identity';
type Snapshot = { version: string; grants: Grant[] };
type WorkspaceRoster = { default: string | null; workspaces: { identity: string; directory: string; name: string }[] };
type McpTool = { name: string; description: string; digest: string };
type McpServer = { name: string; identityDigest: string; trust: { scope: string; trusted: boolean } | null };
type McpTools = { identityDigest: string; tools: McpTool[] };
export function AgentControlPanel({ client, projectRoot, onEdit }: {
  client: Client;
  projectRoot: string;
  onEdit?: (reason: string) => void;
}) {
  const t = useText();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpTools, setMcpTools] = useState<Record<string, McpTools>>({});
  const [mcpLoading, setMcpLoading] = useState<string | null>(null);
  const [draft, setDraft] = useState<GrantDraft>(emptyGrantDraft);
  const [grantStep, setGrantStep] = useState<0 | 1 | 2>(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; code?: string; bad: boolean } | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<Grant | null>(null);
  const [copied, setCopied] = useState('');
  const [policyDetailsOpen, setPolicyDetailsOpen] = useState(false);
  const [screenCaptureDetailsOpen, setScreenCaptureDetailsOpen] = useState(false);
  const [mcpDetailsOpen, setMcpDetailsOpen] = useState(false);
  const [workspaceRoster, setWorkspaceRoster] = useState<WorkspaceRoster>({ default: null, workspaces: [] });
  const [selectedProject, setSelectedProject] = useState(projectRoot.trim());
  const selectedProjectRef = useRef(projectRoot.trim());
  const projectGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const [selectedGrantId, setSelectedGrantId] = useState('');
  const project = selectedProject.trim();
  const { profileExceeds, networkExceeds, policyMissing, mcpLimitInvalid, invalidExpiry } = grantDraftFlags(draft);
  const canSave = !busy && snapshot !== null && grantReady(draft, project);
  const canContinueLimits = !busy && limitsReady(draft);
  const held = busy && dirty
    ? t('外部控制授权正在保存。', 'The Agent Control grant is being saved.')
    : dirty
      ? t('有一份外部控制授权草稿尚未保存。', 'An Agent Control grant draft is not saved yet.')
      : '';

  useEffect(() => {
    if (onEdit === undefined) return;
    onEdit(held);
    return () => onEdit('');
  }, [held, onEdit]);

  const selectProject = useCallback((directory: string) => {
    const next = directory.trim();
    if (selectedProjectRef.current !== next) {
      selectedProjectRef.current = next;
      projectGeneration.current += 1;
      loadGeneration.current += 1;
      setMcpTools({});
      setMcpServers([]);
      setMcpLoading(null);
    }
    setSelectedProject(directory);
    setSelectedGrantId('');
    setNote(null);
  }, []);

  useEffect(() => {
    const root = projectRoot.trim();
    if (selectedProjectRef.current === '' && root !== '') selectProject(root);
  }, [projectRoot, selectProject]);

  const resetAdvancedDetails = () => {
    setPolicyDetailsOpen(false);
    setScreenCaptureDetailsOpen(false);
    setMcpDetailsOpen(false);
  };

  const load = useCallback(async (keepNote = false) => {
    const request = ++loadGeneration.current;
    const scope = { scope: project, generation: projectGeneration.current };
    const isCurrent = () => request === loadGeneration.current
      && requestIsCurrent(scope, selectedProjectRef.current, projectGeneration.current);
    try {
      const result = await client.call('agent-control.list', {}, 15_000) as Snapshot;
      if (!isCurrent()) return;
      setSnapshot(result);
      const roster = await client.call('workspaces.list', {}, 15_000).catch(() => null) as WorkspaceRoster | null;
      if (!isCurrent()) return;
      if (roster !== null) {
        setWorkspaceRoster(roster);
        if (project === '') {
          const preferred = roster.workspaces.find((workspace) => workspace.identity === roster.default)?.directory
            ?? roster.workspaces[0]?.directory ?? '';
          if (preferred !== '') {
            selectProject(preferred);
            return;
          }
        }
      }
      const ownGrants = result.grants.filter((grant) => sameProjectPath(grant.projectRoot, project));
      setSelectedGrantId((current) => ownGrants.some((grant) => grant.id === current)
        ? current : ownGrants.find((grant) => grant.revokedAt === null)?.id ?? ownGrants[0]?.id ?? '');
      setMcpTools({});
      try {
        const mcp = await client.call('mcp.trust.list', project === '' ? {} : { projectRoot: project }, 15_000) as { servers: McpServer[] };
        if (!isCurrent()) return;
        setMcpServers(mcp.servers);
      } catch (error) {
        if (!isCurrent()) return;
        setMcpServers([]);
        setNote({ text: t('外控授权已读取；MCP 信任清单暂不可用。', 'Agent Control grants loaded; the MCP trust list is unavailable.'), code: code(error), bad: true });
        return;
      }
      if (!keepNote && isCurrent()) setNote(null);
    } catch (error) {
      if (!isCurrent()) return;
      setNote({ text: t('无法读取本机外控授权。', 'Could not read local Agent Control grants.'), code: code(error), bad: true });
    }
  }, [client, project, selectProject, t]);

  useEffect(() => { void load(); }, [load]);

  const update = <K extends keyof GrantDraft>(key: K, value: GrantDraft[K]) => {
    setDirty(true);
    setDraft(current => ({ ...current, [key]: value }));
    setNote(null);
  };

  const loadMcpTools = async (server: McpServer) => {
    const request = { scope: project, generation: projectGeneration.current };
    const isCurrent = () => requestIsCurrent(request, selectedProjectRef.current, projectGeneration.current);
    setMcpLoading(server.name);
    setNote(null);
    try {
      const result = await client.call('mcp.trust.tools', project === ''
        ? { server: server.name }
        : { projectRoot: project, server: server.name }, 30_000) as McpTools;
      if (!isCurrent()) return;
      setMcpTools(current => ({ ...current, [server.name]: result }));
    } catch (error) {
      if (!isCurrent()) return;
      setNote({ text: t(`无法读取 ${server.name} 的工具清单。`, `Could not read tools from ${server.name}.`), code: code(error), bad: true });
    } finally {
      if (isCurrent()) setMcpLoading(null);
    }
  };

  const toggleMcpServer = (server: string, allowed: boolean) => {
    const allowedMcpServers = allowed
      ? [...draft.allowedMcpServers, server]
      : draft.allowedMcpServers.filter((item) => item !== server);
    const allowedMcpTools = allowed
      ? draft.allowedMcpTools
      : draft.allowedMcpTools.filter((capability) => !capability.startsWith(`mcp:${server}/`));
    update('allowedMcpServers', allowedMcpServers);
    update('allowedMcpTools', allowedMcpTools);
  };

  const toggleMcpTool = (capability: string, allowed: boolean) => {
    update('allowedMcpTools', allowed
      ? [...draft.allowedMcpTools, capability]
      : draft.allowedMcpTools.filter((item) => item !== capability));
  };

  const save = async () => {
    if (!canSave || snapshot === null) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await client.call('agent-control.create', createGrantRequest(draft, project, snapshot.version), 30_000) as Snapshot;
      setSnapshot(result);
      const created = result.grants.find((grant) => !snapshot.grants.some((previous) => previous.id === grant.id));
      if (created !== undefined) setSelectedGrantId(created.id);
      setDraft(emptyGrantDraft());
      setDirty(false);
      setGrantStep(0);
      resetAdvancedDetails();
      setNote({ text: t('授权已保存。请将授权 ID 放入本地 MCP 配置。', 'Grant saved. Use its ID in your local MCP configuration.'), bad: false });
    } catch (error) {
      setNote({ text: t('授权保存失败。', 'Could not save the grant.'), code: code(error), bad: true });
      await load(true);
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    if (snapshot === null || confirmingRevoke === null) return;
    setBusy(true);
    try {
      const result = await client.call('agent-control.revoke', {
        grantId: confirmingRevoke.id,
        version: snapshot.version,
      }, 30_000) as Snapshot;
      setSnapshot(result);
      setNote({ text: t('授权已撤销。已连接的 MCP 进程将在检查到撤销后取消运行并拒绝后续调用。', 'Grant revoked. Connected MCP processes cancel active work and reject later calls when they detect the revocation.'), bad: false });
    } catch (error) {
      setNote({ text: t('授权撤销失败。', 'Could not revoke the grant.'), code: code(error), bad: true });
      await load(true);
    } finally {
      setBusy(false);
      setConfirmingRevoke(null);
    }
  };

  const copyConfig = async (grant: Grant) => {
    const args = ['mcp-server', '--project', grant.projectRoot, '--grant', grant.id];
    if (grant.allowOperator) args.push('--operator');
    const config = JSON.stringify({ mcpServers: { ligule: { command: 'ligule', args } } }, null, 2);
    try {
      await navigator.clipboard.writeText(config);
      setCopied(grant.id);
      setNote({ text: t('本地 MCP 配置已复制。配置不包含模型凭据。', 'Local MCP configuration copied. It contains no model credentials.'), bad: false });
    } catch (error) {
      setNote({ text: t('复制配置失败。', 'Could not copy the configuration.'), code: code(error), bad: true });
    }
  };

  const activeGrants = useMemo(() => snapshot?.grants ?? [], [snapshot]);
  const projectGrants = useMemo(() => activeGrants.filter((grant) => project === '' || sameProjectPath(grant.projectRoot, project)), [activeGrants, project]);
  const selectedGrant = projectGrants.find((grant) => grant.id === selectedGrantId) ?? null;
  const workspaceOptions = useMemo(() => {
    const options = [...workspaceRoster.workspaces];
    const candidates = [projectRoot.trim(), project];
    for (const directory of candidates) {
      if (directory !== '' && !options.some((workspace) => sameProjectPath(workspace.directory, directory))) {
        options.push({ identity: directory, directory, name: directory });
      }
    }
    return options;
  }, [projectRoot, project, workspaceRoster]);
  const applyPreset = (id: GrantPresetId) => {
    const preset = grantPreset(id);
    const nextDraft = {
      ...applyGrantPreset(draft, id),
      name: draft.name.trim() === '' ? t(preset.name.zh, preset.name.en) : draft.name,
    };
    setDraft(nextDraft);
    setPolicyDetailsOpen(nextDraft.allowOperator || nextDraft.defaultPolicy !== 'ask' || nextDraft.allowedPolicies.length > 1);
    setScreenCaptureDetailsOpen(nextDraft.allowScreenCapture);
    setMcpDetailsOpen(nextDraft.allowedMcpServers.length > 0 || nextDraft.allowedMcpTools.length > 0);
    setDirty(true);
    setGrantStep(1);
    setNote(null);
  };
  const clearDraft = () => {
    setDraft(emptyGrantDraft());
    setDirty(false);
    setGrantStep(0);
    resetAdvancedDetails();
    setNote(null);
  };

  return <div className="agent-control-panel">
    <div className="agent-control-toolbar">
      <span className="agent-control-status">{t('本机授权管理', 'Local grant management')}</span>
      <button type="button" className="rail-refresh" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={13} />{t('重新读取', 'Reload')}</button>
    </div>
    {note !== null && <div className="session-note" data-tone={note.bad ? 'bad' : undefined}>
      <span>{note.text}</span>{note.code !== undefined && <code>{note.code}</code>}
    </div>}
    <p className="agent-control-notice">{t('新授权默认只读、禁用网络并在 24 小时后到期。授权仅供本机 stdio MCP 使用；名称是备注，同一 OS 账户下的程序仍可访问本机授权数据。', 'New grants default to read-only, disabled network access, and expire after 24 hours. Grants are for local stdio MCP; names are labels, and programs under this OS account can still access local grant data.')}</p>

    <Group title={t('查看授权', 'Inspect grants')}>
      <Row label={t('工作区', 'Workspace')} note={t('只改变本页查看范围，不切换任何会话。', 'Changes this page’s view only; it does not switch any conversation.')}>
        <select value={project} disabled={busy || dirty} aria-label={t('查看外控授权的工作区', 'Workspace to inspect grants for')} onChange={(event) => {
          selectProject(event.target.value);
        }}>
          {project === '' && <option value="">{t('Host 项目', 'Host project')}</option>}
          {workspaceOptions.map((workspace) => <option key={`${workspace.identity}:${workspace.directory}`} value={workspace.directory}>
            {workspace.name}{workspaceRoster.default === workspace.identity ? ` · ${t('默认', 'Default')}` : ''}
          </option>)}
        </select>
      </Row>
      <Row label={t('授权', 'Grant')}>
        <select value={selectedGrant?.id ?? ''} disabled={busy || projectGrants.length === 0} aria-label={t('查看授权', 'Grant to inspect')} onChange={(event) => setSelectedGrantId(event.target.value)}>
          {projectGrants.length === 0
            ? <option value="">{t('此工作区没有授权', 'No grants for this workspace')}</option>
            : projectGrants.map((grant) => <option key={grant.id} value={grant.id}>{grant.name} · {grantState(grant, t)}</option>)}
        </select>
      </Row>
    </Group>
    {selectedGrant !== null && <GrantOverview
      grant={selectedGrant}
      state={grantState(selectedGrant, t)}
      copied={copied === selectedGrant.id}
      disabled={busy}
      onCopy={() => void copyConfig(selectedGrant)}
      onRevoke={() => setConfirmingRevoke(selectedGrant)}
    />}
    <details className="catalog-fold grant-all">
      <summary>{t(`此工作区全部授权（${projectGrants.length}）`, `All grants for this workspace (${projectGrants.length})`)}</summary>
      {projectGrants.length === 0 ? <p className="stub">{t('尚未创建授权。', 'No grants have been created.')}</p>
        : <ul className="catalog-list">{projectGrants.map((grant) => <li key={grant.id}>
          <strong>{grant.name}</strong><span>{grantState(grant, t)}</span>
          <small>{grant.defaultPermissionProfile} / {grant.maxPermissionProfile} · {grant.defaultNetwork} / {grant.maxNetwork} · Policy: {grant.allowedPolicies.join(', ')}</small>
          <button type="button" className="mini chip" onClick={() => setSelectedGrantId(grant.id)}>{t('查看授权', 'Inspect grant')}</button>
        </li>)}</ul>}
    </details>
    <details className="catalog-fold agent-control-connection">
      <summary>{t('连接与高级选项', 'Connection and advanced options')}</summary>
      <p className="sheet-note">{t('本机 stdio MCP 客户端的连接状态由客户端管理，Host 不提供在线连接列表。选中授权后，在授权详情中复制对应的 MCP 配置。MCP Server 信任与 Grant 的工具上限保持独立。', 'Local stdio MCP clients manage their own connection state; the Host does not expose an online connection list. Select a grant and copy its MCP configuration from the grant details. MCP server trust remains separate from each grant’s tool ceiling.')}</p>
    </details>
    <details className="catalog-fold grant-create-fold" data-grant-step={grantStep}>
      <summary>{t('新建外控授权', 'Create an Agent Control grant')}</summary>
      <section className="region-group agent-control-create">
      <ol className="grant-stepper" aria-label={t('授权创建步骤', 'Grant creation steps')}>
        {[
          t('项目与名称', 'Project and name'),
          t('能力与上限', 'Capabilities and limits'),
          t('风险确认与创建', 'Risk review and create'),
        ].map((label, index) => <li key={label} aria-current={grantStep === index ? 'step' : undefined}>{label}</li>)}
      </ol>
      {grantStep === 0 && <section className="grant-presets" aria-label={t('安全预设', 'Safe presets')}>
        <p className="session-note">{t('常见外控场景从预设开始：只读观察，或允许确认后写入工作区。预设不会开启完整访问、无限制网络、Operator 或 Screen Capture；需要更大能力时在下面的上限里逐项确认。', 'Start from a preset for the common external-control cases: observe read-only, or allow workspace writes after confirmation. Presets never enable full access, unrestricted network, Operator or Screen Capture; widen the limits below with explicit confirmations.')}</p>
        <div className="grant-actions">
          {grantPresets.map((preset) => <button type="button" key={preset.id} disabled={busy} onClick={() => applyPreset(preset.id)}>
            <strong>{t(preset.label.zh, preset.label.en)}</strong>
            <small>{t(preset.description.zh, preset.description.en)}</small>
          </button>)}
        </div>
      </section>}
      {grantStep === 0 && <>
      <div className="grant-basic-grid">
        <label className="grant-field">
          <span>{t('授权项目', 'Project')}</span>
          <input value={project} readOnly placeholder={t('请先选择工作区', 'Choose a workspace first')} aria-label={t('授权项目目录', 'Grant project directory')} />
        </label>
        <label className="grant-field">
          <span>{t('名称备注', 'Name')}</span>
          <input value={draft.name} maxLength={80} onChange={(event) => update('name', event.target.value)} placeholder={t('例如 Codex 本地任务', 'e.g. Codex local task')} />
        </label>
      </div>
      <div className="grant-actions">
        <button type="button" disabled={busy || project === '' || draft.name.trim() === ''} onClick={() => setGrantStep(1)}>{t('继续：能力与上限', 'Continue: capabilities and limits')}</button>
        <button type="button" disabled={busy || !dirty} onClick={clearDraft}>{t('清除草稿', 'Clear draft')}</button>
      </div>
      </>}

      {grantStep === 1 && <>
      <div className="grant-config-grid">
        <section className="grant-config-card">
          <h4>{t('文件与命令权限', 'Files and commands')}</h4>
          <div className="grant-choice-grid">
            <label className="grant-field">
              <span>{t('默认权限', 'Default')}</span>
              <select value={draft.defaultPermissionProfile} onChange={(event) => update('defaultPermissionProfile', event.target.value as PermissionProfile)}>
                <option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="full-access">full-access</option>
              </select>
            </label>
            <label className="grant-field">
              <span>{t('权限上限', 'Maximum')}</span>
              <select value={draft.maxPermissionProfile} onChange={(event) => update('maxPermissionProfile', event.target.value as PermissionProfile)}>
                <option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="full-access">full-access</option>
              </select>
            </label>
          </div>
          {profileExceeds && <p className="grant-validation">{t('默认权限不能高于权限上限。', 'Default permission cannot exceed the maximum.')}</p>}
          {draft.maxPermissionProfile === 'full-access' && <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmFullAccess} onChange={(event) => update('confirmFullAccess', event.target.checked)} />
            <span>{t('确认允许访问当前 OS 账户可访问的全部资源。', 'Allow access to everything available to this OS account.')}</span>
          </label>}
          {draft.maxPermissionProfile !== 'read-only' && <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmPartialWorkspaceWrite} onChange={(event) => update('confirmPartialWorkspaceWrite', event.target.checked)} />
            <span>{t('确认接受可能适用的部分隔离限制。Windows 工作区写入无法限制读取和网络，硬链接或可写父目录删除权限也可能越过工作区范围；正常清理会撤销临时 ACE，但自动继承元数据标记可能保留。Shell 每次运行使用临时用户配置目录，用户级缓存不会沿用。', 'Accept the partial-isolation limits that may apply. Windows workspace-write cannot restrict reads or network, and hard links or delete-child rights on writable parent folders may escape the workspace boundary. Normal cleanup revokes temporary ACEs, but auto-inheritance metadata may remain. Each Shell command uses a temporary user profile, so user-level caches are not reused.')}</span>
          </label>}
        </section>

        <section className="grant-config-card">
          <h4>{t('网络访问', 'Network access')}</h4>
          <div className="grant-choice-grid">
            <label className="grant-field">
              <span>{t('默认范围', 'Default')}</span>
              <select value={draft.defaultNetwork} onChange={(event) => update('defaultNetwork', event.target.value as NetworkLimit)}>
                <option value="disabled">disabled</option><option value="policy">policy</option><option value="unrestricted">unrestricted</option>
              </select>
            </label>
            <label className="grant-field">
              <span>{t('范围上限', 'Maximum')}</span>
              <select value={draft.maxNetwork} onChange={(event) => update('maxNetwork', event.target.value as NetworkLimit)}>
                <option value="disabled">disabled</option><option value="policy">policy</option><option value="unrestricted">unrestricted</option>
              </select>
            </label>
          </div>
          {networkExceeds && <p className="grant-validation">{t('默认网络范围不能高于上限。', 'Default network access cannot exceed the maximum.')}</p>}
          {draft.maxNetwork === 'unrestricted' && <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmUnrestrictedNetwork} onChange={(event) => update('confirmUnrestrictedNetwork', event.target.checked)} />
            <span>{t('单独确认允许不受限网络访问。', 'Separately confirm unrestricted network access.')}</span>
          </label>}
        </section>

        <details className="grant-config-card grant-advanced" open={policyDetailsOpen || policyMissing}
          onToggle={(event) => setPolicyDetailsOpen(event.currentTarget.open)}>
          <summary>{t('高级：审批方式与 Operator', 'Advanced: approval and operator')}</summary>
          <h4>{t('审批方式', 'Approval behavior')}</h4>
          <label className="grant-field">
            <span>{t('默认 Policy', 'Default Policy')}</span>
            <select value={draft.defaultPolicy} onChange={(event) => update('defaultPolicy', event.target.value as PolicySelection)}>
              <option value="always">always</option><option value="ask">ask</option><option value="auto">auto</option><option value="never">never</option>
            </select>
          </label>
          <fieldset className="grant-policies">
            <legend>{t('允许的模式', 'Allowed modes')}</legend>
            {(['always', 'ask', 'auto', 'never'] as const).map((policy) => <label key={policy}>
              <input type="checkbox" checked={draft.allowedPolicies.includes(policy)} onChange={(event) => {
                const selected = event.target.checked
                  ? [...draft.allowedPolicies, policy]
                  : draft.allowedPolicies.filter((item) => item !== policy);
                update('allowedPolicies', selected);
              }} /> {policy}
            </label>)}
          </fieldset>
          {policyMissing && <p className="grant-validation">{t('默认 Policy 必须在允许列表中。', 'The default Policy must be allowed.')}</p>}
          <label className="grant-confirmation">
            <input type="checkbox" checked={draft.allowOperator} onChange={(event) => update('allowOperator', event.target.checked)} />
            <span>{t('允许 MCP 使用者通过 --operator 处理普通审批。', 'Allow the MCP client to handle ordinary approvals with --operator.')}</span>
          </label>
        </details>

        <details className="grant-config-card grant-advanced" open={screenCaptureDetailsOpen}
          onToggle={(event) => setScreenCaptureDetailsOpen(event.currentTarget.open)}>
          <summary>{t('高级：屏幕观察（Windows）', 'Advanced: screen capture (Windows)')}</summary>
          <label className="grant-confirmation">
            <input type="checkbox" checked={draft.allowScreenCapture} onChange={event => {
              update('allowScreenCapture', event.target.checked);
              update('confirmScreenCapture', false);
            }} />
            <span>{t('允许此授权下的会话及其内部子代理调用截图工具。', 'Allow Sessions and internal children using this grant to call the screenshot tool.')}</span>
          </label>
          {draft.allowScreenCapture && <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmScreenCapture} onChange={event => update('confirmScreenCapture', event.target.checked)} />
            <span>{t('确认屏幕可能含其他应用或项目的信息，截图将发送给当前图像模型。此授权不允许移动窗口、抢焦点、鼠标或键盘控制。', 'Confirm that the screen may include other applications or projects and captures will be sent to the selected image model. This permission does not allow moving windows, changing focus, or mouse and keyboard control.')}</span>
          </label>}
        </details>

        <details className="grant-config-card grant-advanced grant-mcp-limits" open={mcpDetailsOpen || mcpLimitInvalid}
          onToggle={(event) => setMcpDetailsOpen(event.currentTarget.open)}>
          <summary>{t('高级：MCP Server 与工具', 'Advanced: MCP servers and tools')}</summary>
          <h4>{t('MCP Server 与工具', 'MCP servers and tools')}</h4>
          <p className="session-note">{t('此授权只能使用已在 MCP 信任设置中批准的 Server。先选允许启动的 Server，再加载工具清单并逐项选择。未选工具时，外部 Agent 不能调用该 Server 的工具。', 'This grant can use only servers approved in MCP trust settings. Select servers it may start, load their tool lists, then choose tools individually. Tools not selected here cannot be called by the external agent.')}</p>
          {mcpServers.length === 0 ? <p className="stub">{t('当前项目没有配置 MCP Server。', 'No MCP servers are configured for this project.')}</p>
            : mcpServers.map((server) => {
              const serverAllowed = draft.allowedMcpServers.includes(server.name);
              const loaded = mcpTools[server.name];
              const currentTools = loaded?.identityDigest === server.identityDigest ? loaded.tools : [];
              return <div className="grant-mcp-server" key={`${server.name}:${server.identityDigest}`}>
                <label className="grant-confirmation">
                  <input type="checkbox" checked={serverAllowed} disabled={!server.trust?.trusted && !serverAllowed}
                    onChange={(event) => toggleMcpServer(server.name, event.target.checked)} />
                  <span><strong>{server.name}</strong> · {server.trust?.trusted
                    ? t(`已信任：${server.trust.scope}`, `trusted: ${server.trust.scope}`)
                    : t('尚未在项目或用户范围信任', 'not trusted at project or user scope')}</span>
                </label>
                <button type="button" className="mini chip" disabled={!server.trust?.trusted || mcpLoading !== null}
                  onClick={() => void loadMcpTools(server)}>
                  {mcpLoading === server.name ? t('正在读取工具…', 'Loading tools…') : currentTools.length > 0 ? t('重新读取工具', 'Reload tools') : t('读取工具清单', 'Load tool list')}
                </button>
                {currentTools.map((tool) => {
                  const capability = `mcp:${server.name}/${tool.name}`;
                  return <label className="grant-mcp-tool" key={capability} title={tool.description}>
                    <input type="checkbox" checked={draft.allowedMcpTools.includes(capability)} disabled={!serverAllowed}
                      onChange={(event) => toggleMcpTool(capability, event.target.checked)} />
                    <code>{tool.name}</code>
                    {tool.description !== '' && <span>{tool.description}</span>}
                  </label>;
                })}
              </div>;
            })}
          {mcpLimitInvalid && <p className="grant-validation">{t('每个 MCP 工具都必须属于本授权允许启动的 Server。', 'Each MCP tool must belong to a server this grant can start.')}</p>}
        </details>

      </div>
      <div className="grant-actions">
        <button type="button" disabled={busy} onClick={() => setGrantStep(0)}>{t('返回：项目与名称', 'Back: project and name')}</button>
        <button type="button" disabled={!canContinueLimits} onClick={() => setGrantStep(2)}>{t('继续：风险确认', 'Continue: risk review')}</button>
        <button type="button" disabled={busy || !dirty} onClick={clearDraft}>{t('清除草稿', 'Clear draft')}</button>
      </div>
      </>}
      {grantStep === 2 && <>
        <section className="grant-review">
          <h4>{t('授权摘要', 'Grant summary')}</h4>
          <p><strong>{draft.name}</strong></p>
          <code>{project}</code>
          <p>{t('权限', 'Permission')}: {draft.defaultPermissionProfile} / {draft.maxPermissionProfile} · {t('网络', 'Network')}: {draft.defaultNetwork} / {draft.maxNetwork}</p>
          <p>Policy: {draft.defaultPolicy} · {draft.allowedPolicies.join(', ')}</p>
          <p>{t('MCP', 'MCP')}: {draft.allowedMcpServers.length} {t('Server', 'servers')} · {draft.allowedMcpTools.length} {t('工具', 'tools')} · {t('普通审批代答', 'Operator replies')}: {draft.allowOperator ? t('允许', 'allowed') : t('关闭', 'disabled')}</p>
        </section>
        <section className="grant-config-card grant-lifetime-card">
          <h4>{t('风险确认与期限', 'Risk confirmation and expiry')}</h4>
          <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmWorkspaceTrust} onChange={(event) => update('confirmWorkspaceTrust', event.target.checked)} />
            <span>{t('我信任上方项目目录中的项目代码；项目脚本和 Git 命令仍会逐次请求审批。', 'I trust project code in the directory above; project scripts and Git commands still require approval for each call.')}</span>
          </label>
          <label className="grant-field">
            <span>{t('到期时间（可留空）', 'Expires (optional)')}</span>
            <input type="datetime-local" value={draft.expiresAt} onChange={(event) => update('expiresAt', event.target.value)} />
          </label>
          {invalidExpiry && <p className="grant-validation">{t('到期时间格式无效。', 'The expiry time is invalid.')}</p>}
        </section>
        <div className="grant-actions">
          <button type="button" disabled={busy} onClick={() => setGrantStep(1)}>{t('返回：能力与上限', 'Back: capabilities and limits')}</button>
          <button type="button" disabled={!canSave} onClick={() => void save()}>{busy ? t('正在保存…', 'Saving…') : t('创建授权', 'Create grant')}</button>
          <button type="button" disabled={busy || !dirty} onClick={clearDraft}>{t('清除草稿', 'Clear draft')}</button>
        </div>
      </>}
      </section>
    </details>

    {confirmingRevoke !== null && <Modal title={t('撤销 Agent Control 授权', 'Revoke Agent Control grant')} className="confirm" onClose={() => setConfirmingRevoke(null)}>
      <h2 className="confirm-lead">{t(`撤销「${confirmingRevoke.name}」？`, `Revoke “${confirmingRevoke.name}”?`)}</h2>
      <p className="confirm-note">{t('MCP Host 会在下次操作或最多约半秒内发现撤销，取消正在运行的任务，并拒绝后续调用。已经完成的 OS 副作用无法收回。', 'The MCP Host detects revocation on the next operation or within about half a second, cancels active work, and rejects later calls. Completed OS side effects cannot be undone.')}</p>
      <div className="confirm-actions"><button type="button" onClick={() => setConfirmingRevoke(null)}>{t('保留授权', 'Keep grant')}</button><button type="button" className="danger" disabled={busy} onClick={() => void revoke()}>{t('确认撤销', 'Revoke')}</button></div>
    </Modal>}
  </div>;
}
