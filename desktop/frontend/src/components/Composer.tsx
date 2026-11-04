import type { KeyboardEvent, RefObject } from 'react';
import { Popover } from 'radix-ui';
import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';
import { PolicyPicker } from './PolicyPicker';
import { PermissionPicker } from './PermissionPicker';
import { ScreenCaptureControl } from './ScreenCaptureControl';
import { SessionMenu } from './SessionMenu';
import { WorkspacePicker } from './WorkspacePicker';
import type { MentionState } from '../mentions';
import { CURRENT, formatKeys } from '../hotkeys';
import type { ModelSelection } from '../model-catalog';
import { useText } from '../locale';

type PolicyValue = 'always' | 'ask' | 'auto' | 'never';
import type { Client } from '../protocol';
import type { Status } from '../status';
import type { Settings } from '../settings';
import type { PermissionConfirmations, PermissionTarget } from '../permission-control';

export type MessageQueue = { items: string[]; paused: boolean };

export function Composer({ client, sessionId, projectRoot, status, settings, settingsReady, closing, reading, starting, running, inputOwner,
  draft, composerRef, queue, mention, sessionMenuOpen, initialMode, initialPolicy, initialPermission, initialPermissionConfirmations,
  newSessionSettingsRevision, modelCatalogRevision, workspaceRevision, othersRunning,
  onDraftChange, onCaretChange, onWalkChange, onDraftKeyDown, onSelectWorkspace, onToggleQueue, onRecoverQueueItem,
  onPickMention, onSelectModel, onSetThinking, onManageModel, onOpenSecurity, onSessionMenuChange, onSetMode, onSetPolicy,
  onInitialPermissionChange, onPermissionStatus, onStop, onSend,
}: {
  client: Client;
  sessionId: string | null;
  projectRoot: string;
  status: Status | null;
  settings: Settings;
  settingsReady: boolean;
  closing: boolean;
  reading: boolean;
  starting: boolean;
  running: boolean;
  inputOwner: string | null;
  draft: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  queue: MessageQueue;
  mention: MentionState | null;
  sessionMenuOpen: boolean;
  initialMode: string | null;
  initialPolicy: PolicyValue | null;
  initialPermission: PermissionTarget;
  initialPermissionConfirmations: PermissionConfirmations;
  newSessionSettingsRevision: number;
  modelCatalogRevision: number;
  workspaceRevision: number;
  othersRunning: number;
  onDraftChange: (draft: string) => void;
  onCaretChange: (caret: number) => void;
  onWalkChange: (walk: number) => void;
  onDraftKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelectWorkspace: (root: string) => Promise<void>;
  onToggleQueue: () => void;
  onRecoverQueueItem: (index: number, all: boolean) => void;
  onPickMention: (path: string) => void;
  onSelectModel: (selection: ModelSelection) => Promise<void>;
  onSetThinking: (effort: string | null) => Promise<void>;
  onManageModel: () => void;
  onOpenSecurity: () => void;
  onSessionMenuChange: (open: boolean) => void;
  onSetMode: (name: string | null) => void;
  onSetPolicy: (mode: PolicyValue | null) => Promise<void>;
  onInitialPermissionChange: (target: PermissionTarget, confirmations: PermissionConfirmations) => void;
  onPermissionStatus: (status: Status) => void;
  onStop: () => void;
  onSend: () => void;
}) {
  const t = useText();
  const disabled = closing || reading || starting || !settingsReady || (sessionId !== null && inputOwner !== sessionId);
  const selection = status?.selectedModel
    ? { provider: status.pendingServiceId ?? status.serviceId, model: status.pendingModel ?? status.selectedModel }
    : settings.newSelections[projectRoot] ?? null;

  return <>
    <footer className="composer">
      {sessionId === null && <WorkspacePicker client={client} directory={projectRoot} revision={workspaceRevision}
        disabled={disabled}
        onSelect={onSelectWorkspace} />}
      {queue.items.length === 0 ? null : <div className="queue">
        <div className="queue-head">
          <span className="mini">{t(`${queue.items.length} 条待发送`, `${queue.items.length} queued`)} · {queue.paused
            ? t('已暂停；本轮剩余消息不会自动发送', 'Paused; remaining messages will not send automatically')
            : running
              ? t('本轮结束后按顺序发送', 'Send in order after this turn')
              : t('会话空闲；收回消息后再发送', 'Conversation is idle; recover messages to send them')}</span>
          <button type="button" className="mini chip" title={queue.paused ? t('继续发送队列', 'Resume queue') : t('暂停发送队列', 'Pause queue')} onClick={onToggleQueue}>
            {queue.paused ? t('继续发送', 'Resume') : t('暂停发送', 'Pause')}
          </button>
          <button type="button" className="mini chip" disabled={draft !== ''}
            title={draft === '' ? t('将队列消息移回草稿', 'Move queued messages back to the draft') : t('请先发送或排入当前草稿', 'Send or queue the current draft first')}
            onClick={() => onRecoverQueueItem(0, true)}>{t('全部收回', 'Recover all')}</button>
        </div>
        {queue.items.map((item, index) => <div className="queue-item" key={`${index}:${item}`}>
          <span className="queue-text">{item}</span>
          <button type="button" className="mini chip" disabled={draft !== ''}
            title={draft === '' ? t('将此消息移回草稿', 'Move this message back to the draft') : t('请先发送或排入当前草稿', 'Send or queue the current draft first')}
            onClick={() => onRecoverQueueItem(index, false)}>{t('收回', 'Recover')}</button>
        </div>)}
      </div>}
      {mention === null ? null : <div className="queue" role="listbox" aria-label={t('项目文件', 'Project files')}>
        <span className="mini">{t('项目', 'Project')} {mention.root === '' ? t('无法读取目录', 'directory unavailable') : mention.root} · {t(`文件名包含“${mention.text}”`, `File names containing “${mention.text}”`)}</span>
        {mention.paths.length === 0
          ? <span className="mini">{mention.stopped === 'error'
            ? t(`无法列出项目文件：${mention.failed}`, `Could not list project files: ${mention.failed}`)
            : mention.stopped === 'pending'
              ? t('正在列出项目文件…', 'Listing project files…')
              : mention.stopped === 'budget'
                ? t(`已查过的文件中没有“${mention.text}”匹配项；可以缩小搜索范围。`, `No match for “${mention.text}” in the files checked. Narrow the search.`)
                : t(`没有文件名包含“${mention.text}”的项目文件。`, `No project file name contains “${mention.text}”.`)}</span>
          : mention.paths.map((path, index) => <div className="queue-item" key={path} role="option" aria-selected={index === mention.chosen}>
            <span className="queue-text">{path}</span>
            <button type="button" className="mini chip" onClick={() => onPickMention(path)}>{t('插入', 'Insert')}</button>
          </div>)}
        {mention.paths.length > 0 && mention.stopped === 'budget' && <span className="mini">{t('已达到搜索范围上限；请缩小搜索范围。', 'Search limit reached. Narrow the search.')}</span>}
        {mention.paths.length > 0 && mention.stopped === 'unreadable' && <span className="mini">{t('部分目录无法读取，结果可能不完整。', 'Some directories could not be read; results may be incomplete.')}</span>}
        {mention.paths.length > 0 && <span className="mini">{t(
          `${formatKeys(CURRENT['pick-candidate'])} 或 ${formatKeys(CURRENT['complete-candidate'])} 选择 · ${formatKeys(CURRENT['candidate-older'])}/${formatKeys(CURRENT['candidate-newer'])} 切换 · ${formatKeys(CURRENT['hide-candidate'])} 关闭`,
          `${formatKeys(CURRENT['pick-candidate'])} or ${formatKeys(CURRENT['complete-candidate'])} to select · ${formatKeys(CURRENT['candidate-older'])}/${formatKeys(CURRENT['candidate-newer'])} to move · ${formatKeys(CURRENT['hide-candidate'])} to close`,
        )}</span>}
      </div>}
      {/* 切换会话期间锁住输入，避免把草稿保存到另一具会话。 */}
      <textarea
        className="composer-input"
        ref={composerRef}
        rows={2}
        value={draft}
        readOnly={closing || reading || starting || inputOwner !== sessionId || !settingsReady}
        placeholder={t('描述任务，使用 @ 引用文件', 'Describe a task, use @ to reference a file')}
        onChange={(event) => {
          onDraftChange(event.target.value);
          onCaretChange(event.target.selectionStart ?? event.target.value.length);
          onWalkChange(-1);
        }}
        onSelect={(event) => onCaretChange(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onDraftKeyDown}
      />
      <div className="composer-bar">
        <ModelPicker key={`${projectRoot}:${modelCatalogRevision}`} client={client} projectRoot={projectRoot}
          disabled={disabled} pending={status?.pendingModel !== undefined && status.pendingModel !== null}
          selection={selection}
          thinking={sessionId === null ? null : status?.thinking ?? null}
          onSelect={onSelectModel} onThinking={onSetThinking} onManage={onManageModel} />
        <Popover.Root open={sessionMenuOpen} onOpenChange={onSessionMenuChange}>
          <Popover.Trigger asChild><button type="button" className="composer-choice" disabled={disabled} title={t('工具模式', 'Tool mode')}><span>{sessionId === null
            ? initialMode ?? t('默认工具', 'Default mode')
            : status?.mode ?? t('工具模式', 'Tool mode')}</span><Icon name="fold" size={12} /></button></Popover.Trigger>
          <SessionMenu key={`${sessionId ?? '$new'}:${newSessionSettingsRevision}`} status={status} selectedMode={initialMode} onSetMode={onSetMode} />
        </Popover.Root>
        <PermissionPicker key={`permission:${sessionId ?? '$new'}:${newSessionSettingsRevision}`} client={client} sessionId={sessionId} status={status} projectRoot={projectRoot}
          initialPermission={initialPermission} initialConfirmations={initialPermissionConfirmations}
          disabled={disabled || closing || reading || starting} running={running}
          onInitialChange={onInitialPermissionChange} onStatus={onPermissionStatus} onOpenSecurity={onOpenSecurity} />
        <PolicyPicker key={`${sessionId ?? '$new'}:${newSessionSettingsRevision}`} client={client} projectRoot={projectRoot} status={status} initialPolicy={initialPolicy} disabled={disabled || closing || reading || starting} onSelect={onSetPolicy} />
        <span className="bar-spacer" />
        <ScreenCaptureControl key={`screen:${sessionId ?? '$new'}`} client={client} sessionId={sessionId} status={status}
          disabled={disabled} running={running} onStatus={onPermissionStatus} />
        {running && <button className="icon-button stop-button" type="button" title={t('停止本轮', 'Stop this turn')} aria-label={t('停止本轮', 'Stop this turn')} onClick={onStop}><Icon name="stop" size={15} /></button>}
        <button className="send" type="button" title={running ? t('加入队列', 'Add to queue') : t('发送', 'Send')} aria-label={t('发送', 'Send')} disabled={disabled || draft.trim() === ''} onClick={onSend}><Icon name="send" size={19} /></button>
      </div>
    </footer>
    <div className="composer-hint"><span>{formatKeys(CURRENT.send)} {t('发送', 'to send')} · {formatKeys(CURRENT.newline)} {t('换行', 'for a new line')}</span>{othersRunning > 0 && <span>{othersRunning} {t('个后台任务', 'background tasks')}</span>}</div>
  </>;
}
