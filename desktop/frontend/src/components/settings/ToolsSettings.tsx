import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../../protocol';
import { readSettingsCatalog, type SettingsCatalog } from '../../settings-catalog';
import { useText } from '../../locale';
import { McpServersPanel } from '../McpServersPanel';
import { McpTrustPanel } from '../McpTrustPanel';

export function ToolsSettings({ client, projectRoot, sessionId }: { client: Client; projectRoot: string; sessionId: string | null }) {
  const t = useText();
  const [catalog, setCatalog] = useState<SettingsCatalog | null>(null);
  const [selectedMode, setSelectedMode] = useState('');
  const [failure, setFailure] = useState('');

  const load = useCallback(async (mode?: string) => {
    try {
      const next = await readSettingsCatalog(client, projectRoot, sessionId, mode);
      setCatalog(next);
      setSelectedMode(next.mode?.name ?? mode ?? '');
      setFailure('');
    } catch (error) {
      setFailure(code(error));
    }
  }, [client, projectRoot, sessionId]);
  useEffect(() => { void load(); }, [load]);

  const chosen = catalog?.mode;
  const tools = catalog?.tools ?? [];
  const included = tools.filter((tool) => tool.includedInMode);
  const [busyExtension, setBusyExtension] = useState<string | null>(null);
  const [extensionNote, setExtensionNote] = useState('');

  const setExtension = async (name: string, enabled: boolean) => {
    setBusyExtension(name);
    setExtensionNote('');
    try {
      await client.call('extensions.set', {
        ...(projectRoot === '' ? {} : { projectRoot }),
        name,
        enabled,
      }, 30_000);
      await load(chosen?.name ?? selectedMode);
      setExtensionNote(t(`已${enabled ? '启用' : '停用'} ${name}：下一次启动 Host 时生效。`, `${name} was ${enabled ? 'enabled' : 'disabled'}: it takes effect the next time the Host starts.`));
    } catch (error) {
      setExtensionNote(code(error));
    } finally {
      setBusyExtension(null);
    }
  };

  const sourceText = (source: string) => source === 'extension' ? t('扩展', 'Extension')
    : source === 'skill' ? t('技能', 'Skill')
      : source === 'custom' ? t('自定义工具', 'Custom tool')
        : source === 'mcp' ? 'MCP' : t('内置', 'Built in');
  return <div className="tools-settings">
    {failure !== '' && <p className="session-note" data-tone="bad">{t('工具目录读取失败。', 'Could not read the tools catalog.')} <code>{failure}</code></p>}
    <section className="catalog-section">
      <h3>{t('查看工具模式', 'Inspect a tool mode')}</h3>
      <p className="sheet-note">{t('这里只切换设置页正在查看的模式，不会调用 mode.set，也不会修改当前会话。', 'This only changes which mode the settings page inspects. It does not call mode.set or change the current conversation.')}</p>
      <label className="catalog-select">
        <span>{t('查看模式', 'Mode to inspect')}</span>
        <select value={selectedMode} disabled={catalog === null} onChange={(event) => void load(event.target.value)}>
          {(catalog?.modes.modes ?? []).map((mode) => <option key={`${mode.name}:${mode.layer}`} value={mode.name}>{mode.name} · {mode.layer}</option>)}
        </select>
      </label>
      {catalog?.sessionMode !== null && catalog?.sessionMode !== undefined && <p className="catalog-current">{t(`当前会话：${catalog.sessionMode.name}（${catalog.sessionMode.layer}）`, `Current conversation: ${catalog.sessionMode.name} (${catalog.sessionMode.layer})`)}</p>}
      {catalog?.pendingMode !== null && catalog?.pendingMode !== undefined && <p className="catalog-current">{t(`待切换：${catalog.pendingMode}`, `Pending session change: ${catalog.pendingMode}`)}</p>}
      {catalog !== null && !catalog.sessionActive && <p className="catalog-current">{t('当前没有活动会话；列表显示 Host 基础工具及已发现的自定义工具元数据，实际可用工具以 Session 的 Permission 和 Mode 为准。', 'No conversation is active; the list shows Host base tools and discovered custom tool metadata. Actual availability depends on the Session Permission and Mode.')}</p>}
      {chosen !== null && chosen !== undefined ? <>
        <p className="catalog-current">{t(`来源：${chosen.layer} · 工具：${chosen.tools === '*' ? '全部已登记工具' : chosen.tools.length} · 提示片段：${chosen.prompt === '*' ? '全部' : chosen.prompt.length}`, `Source: ${chosen.layer} · Tools: ${chosen.tools === '*' ? 'all registered tools' : chosen.tools.length} · Prompt fragments: ${chosen.prompt === '*' ? 'all' : chosen.prompt.length}`)}</p>
        <details className="catalog-fold" open>
          <summary>{t(`此模式包含的工具（${chosen.tools === '*' ? included.length : chosen.tools.length}）`, `Tools in this mode (${chosen.tools === '*' ? included.length : chosen.tools.length})`)}</summary>
          {chosen.tools === '*'
              ? <CatalogToolList tools={included} sourceText={sourceText} empty={t('此模式未声明普通工具。', 'This mode declares no standard tools.')} />
              : <ul className="catalog-list catalog-tools">{chosen.tools.map((name) => {
                const tool = tools?.find((item) => item.name === name);
                return <li key={name} className="tool-row">
                  <div className="tool-line">
                    <code>{name}</code>
                    <span className="tool-access">{tool === undefined ? t('未登记', 'Not registered') : tool.access}</span>
                    {tool !== undefined && <span className="tool-source">{sourceText(tool.source)}</span>}
                  </div>
                  {tool !== undefined && <details className="tool-details">
                    <summary>{t('详情', 'Details')}</summary>
                    {tool.description !== '' && <small>{tool.description}</small>}
                    <div className="catalog-tags">
                      <span className="catalog-tag">{t('模式包含', 'In inspected mode')}</span>
                      <AvailabilityTag available={tool.currentlyAvailable} />
                    </div>
                  </details>}
                </li>;
              })}</ul>}
          <p className="sheet-note">{t('此处显示模式声明。当前会话的实际工具还会受权限、Policy、平台能力和 MCP 信任约束。', 'This is the mode declaration. The current conversation’s actual tools also depend on permissions, Policy, platform capabilities, and MCP trust.')}</p>
          <p className="catalog-current">{t(`提示片段：${chosen.prompt === '*' ? '全部已登记片段' : chosen.prompt.join('、') || '无'}`, `Prompt fragments: ${chosen.prompt === '*' ? 'all registered fragments' : chosen.prompt.join(', ') || 'none'}`)}</p>
        </details>
      </> : <p className="stub">{t('没有可读取的模式定义。', 'No readable mode definition is available.')}</p>}
      {(catalog?.modes.invalid.length ?? 0) > 0 && <details className="catalog-fold">
        <summary>{t(`无效模式（${catalog?.modes.invalid.length ?? 0}）`, `Invalid modes (${catalog?.modes.invalid.length ?? 0})`)}</summary>
        <ul>{catalog?.modes.invalid.map((mode) => <li key={mode.name}><code>{mode.name}</code> · <code>{mode.code}</code></li>)}</ul>
      </details>}
      {(catalog?.tools.some((tool) => tool.disclosure) ?? false) && <p className="sheet-note">{t(`固定披露入口不受模式工具清单过滤：${catalog?.tools.filter((tool) => tool.disclosure).map((tool) => tool.name).join('、') ?? ''}`, `Fixed disclosure tools are not filtered by mode: ${catalog?.tools.filter((tool) => tool.disclosure).map((tool) => tool.name).join(', ') ?? ''}`)}</p>}
    </section>
    {catalog?.modeError !== null && catalog?.modeError !== undefined && <p className="session-note" data-tone="bad">{t('所选模式暂不可读取。', 'The selected mode could not be read.')} <code>{catalog.modeError}</code></p>}
    <details className="catalog-fold all-tools">
      <summary>{t(`所有已登记工具（${tools?.length ?? 0}）`, `All registered tools (${tools?.length ?? 0})`)}</summary>
      <CatalogToolList tools={tools} sourceText={sourceText} empty={t('当前没有已登记工具。', 'No tools are registered in this runtime.')} />
      {(catalog?.customToolDiagnostics.length ?? 0) > 0 && <ul className="catalog-list">{catalog?.customToolDiagnostics.map((item, index) => <li key={`${item.code}:${item.source}:${index}`}><code>{item.code}</code><span>{item.source}</span></li>)}</ul>}
    </details>
    <details className="catalog-fold">
      <summary>{t(`扩展（${catalog?.extensions.length ?? 0}）`, `Extensions (${catalog?.extensions.length ?? 0})`)}</summary>
      <p className="sheet-note">{t('扩展代码运行在 Host 进程中，只有 full-access 且不受限网络的会话才会加载。用户安装的扩展可以停用或启用：登记在下一次启动 Host 时生效；配置层显式声明的路径不受登记影响。', 'Extensions run inside the Host process and load only in full-access sessions with unrestricted network. User-installed extensions can be disabled or enabled: the registry takes effect the next time the Host starts, while paths declared by configuration layers are unaffected.')}</p>
      {extensionNote !== '' && <p className="session-note">{extensionNote}</p>}
      {catalog?.extensions.length ? <ul className="catalog-list">{catalog.extensions.map((extension) => <li key={`${extension.source}:${extension.name}`}>
        <strong>{extension.name}</strong><span>{extension.source === 'user-installed' ? t('用户安装', 'User installed') : t('用户配置', 'User configured')}</span>
        <span>{!extension.enabled ? t('已停用（下次启动不加载）', 'Disabled (will not load next start)') : extension.loaded ? t('已加载', 'Loaded') : t('当前未加载', 'Not loaded in open sessions')}</span>
        {extension.registeredTools.length > 0 && <small>{t('工具', 'Tools')}: {extension.registeredTools.join(', ')}</small>}
        {extension.source === 'user-installed' && <div className="inline-field mcp-trust-actions">
          <button type="button" className="mini chip" disabled={busyExtension !== null}
            onClick={() => void setExtension(extension.name, !extension.enabled)}>
            {extension.enabled ? t('停用（下次启动生效）', 'Disable (next start)') : t('启用（下次启动生效）', 'Enable (next start)')}
          </button>
        </div>}
      </li>)}</ul> : <p className="stub">{t('没有已发现的用户扩展。', 'No user extensions were discovered.')}</p>}
      {(catalog?.extensionDiagnostics.length ?? 0) > 0 && <ul className="catalog-list">{catalog?.extensionDiagnostics.map((item, index) => <li key={`${item.code}:${item.source}:${index}`}><code>{item.code}</code><span>{item.source}</span></li>)}</ul>}
    </details>
    <details className="catalog-fold">
      <summary>{t(`Skills（${catalog?.skills.length ?? 0}）`, `Skills (${catalog?.skills.length ?? 0})`)}</summary>
      {catalog?.skills.length ? <ul className="catalog-list">{catalog.skills.map((skill) => <li key={`${skill.source}:${skill.name}`}>
        <strong>{skill.name}</strong><span>{skill.source}</span><small>{skill.description}</small>
        {skill.requires.length > 0 && <small>{t('需要', 'Requires')}: {skill.requires.join(', ')}</small>}
      </li>)}</ul> : <p className="stub">{t('没有发现 Skills。', 'No skills were discovered.')}</p>}
      {(catalog?.skillDiagnostics.length ?? 0) > 0 && <ul className="catalog-list">{catalog?.skillDiagnostics.map((item, index) => <li key={`${item.code}:${index}`}><code>{item.code}</code></li>)}</ul>}
    </details>
    <details className="catalog-fold">
      <summary>{t('MCP Server', 'MCP servers')}</summary>
      <McpServersPanel client={client} projectRoot={projectRoot} />
      <McpTrustPanel client={client} projectRoot={projectRoot} sessionId={sessionId} />
    </details>
  </div>;
}

function CatalogToolList({ tools, sourceText, empty }: {
  tools: NonNullable<SettingsCatalog['tools']>;
  sourceText: (source: string) => string;
  empty: string;
}) {
  const t = useText();
  if (tools.length === 0) return <p className="stub">{empty}</p>;
  return <ul className="catalog-list catalog-tools">{tools.map((tool) => <li key={tool.name} className="tool-row">
    <div className="tool-line">
      <code>{tool.name}</code>
      <span className="tool-access">{tool.access}</span>
      <span className="tool-source">{sourceText(tool.source)}</span>
    </div>
    <details className="tool-details">
      <summary>{t('详情', 'Details')}</summary>
      {tool.description !== '' && <small>{tool.description}</small>}
      <div className="catalog-tags">
      {tool.disclosure
        ? <span className="catalog-tag">{t('固定披露入口', 'Fixed disclosure')}</span>
        : <span className="catalog-tag">{tool.includedInMode ? t('模式包含', 'In inspected mode') : t('模式未选中', 'Outside inspected mode')}</span>}
        <AvailabilityTag available={tool.currentlyAvailable} />
      </div>
    </details>
  </li>)}</ul>;
}

function AvailabilityTag({ available }: { available: boolean | null }) {
  const t = useText();
  if (available === null) return <span className="catalog-tag" data-tone="muted">{t('未运行会话', 'No active conversation')}</span>;
  return <span className="catalog-tag" data-tone={available ? 'ok' : 'muted'}>{available ? t('当前会话列出', 'Listed in current session') : t('当前会话未列出', 'Not listed in current session')}</span>;
}
