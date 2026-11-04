import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { useText } from '../locale';
import { code, type Client } from '../protocol';
import { readSettingsCatalog } from '../settings-catalog';
import type { Status } from '../status';
import { Icon } from './Icon';
import { keepEscape, Modal } from './ui';

export type PolicyMode = 'always' | 'ask' | 'auto' | 'never';

export function PolicyPicker({ client, projectRoot, status, initialPolicy, disabled, onSelect }: {
  client: Client;
  projectRoot: string;
  status: Status | null;
  initialPolicy: PolicyMode | null;
  disabled: boolean;
  onSelect: (mode: PolicyMode | null) => Promise<void>;
}) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  // `never` 跳过整个 Policy 层，必须由人再确认一次；打字/点选都不算明确授权。
  const [confirmNever, setConfirmNever] = useState(false);
  // 新会话没有 status：项目默认档要从设置目录读，否则“使用默认”是空的。
  const [projectDefault, setProjectDefault] = useState<string | null | undefined>(undefined);
  const readRequest = useRef(0);
  useEffect(() => {
    if (!open || status !== null) return;
    const request = ++readRequest.current;
    void readSettingsCatalog(client, projectRoot, null)
      .then(catalog => { if (readRequest.current === request) setProjectDefault(catalog.policyDefault); })
      .catch(() => { if (readRequest.current === request) setProjectDefault(undefined); });
    return () => { readRequest.current += 1; };
  }, [client, open, projectRoot, status]);
  const defaultMode = status === null ? projectDefault : status.policyDefault;
  const active = status === null ? initialPolicy ?? 'default' : status.policySource === 'config' ? 'default' : status.policy;
  const title = status === null
    ? initialPolicy === null ? t('默认审批', 'Default approval') : policyLabel(initialPolicy, t)
    : policyLabel(status.policy, t);
  const choose = async (value: PolicyMode | null) => {
    setBusy(true);
    setFailure('');
    try { await onSelect(value); setOpen(false); }
    catch (error) { setFailure(code(error)); setOpen(true); }
    finally { setBusy(false); }
  };
  const choices = [
    { value: 'always', label: t('每次都要审批', 'Ask every time'), mode: 'always' as const },
    { value: 'ask', label: t('逐次审批', 'Ask each time'), mode: 'ask' as const },
    { value: 'auto', label: t('按规则审批', 'Rule-based approval'), mode: 'auto' as const },
    { value: 'never', label: t('完全不审批', 'Never ask'), mode: 'never' as const },
    { value: 'default', label: t('使用默认', 'Use default'), mode: null },
  ];
  return <>
  <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" className="composer-choice" disabled={disabled || busy} title={status === null ? t('新会话审批方式', 'Approval mode for the new conversation') : t('当前会话审批方式', 'Approval mode for this conversation')}><Icon name="check" size={14} /><span>{title}</span><Icon name="fold" size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu policy-picker" side="top" align="start" sideOffset={8} onEscapeKeyDown={keepEscape}>
      <DropdownMenu.Label className="model-group-name">{status === null ? t('新会话审批方式', 'New conversation approval mode') : status.policySource === 'session' ? t('审批方式 · 本会话覆盖', 'Approval mode · session override') : t('审批方式', 'Approval mode')}</DropdownMenu.Label>
      {choices.map(choice => <DropdownMenu.Item key={choice.value} disabled={busy || active === choice.value} onSelect={event => { event.preventDefault(); if (choice.mode === 'never') { setOpen(false); setConfirmNever(true); } else void choose(choice.mode); }}><span>{choice.label}</span>{active === choice.value && <Icon name="check" size={14} />}</DropdownMenu.Item>)}
      {defaultMode != null && <p className="policy-picker-note">{t(`项目默认：${policyLabel(defaultMode, t)}；选「使用默认」回到这一项。`, `Project default: ${policyLabel(defaultMode, t)}; pick "Use default" to return to it.`)}</p>}
      {busy && <p className="policy-picker-note" role="status">{t('正在更新审批方式…', 'Updating approval mode…')}</p>}
      {failure && <div className="workspace-picker-error" role="alert"><span>{t('审批方式未更新。', 'Approval mode was not updated.')}</span><code>{failure}</code></div>}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
  {confirmNever && <Modal title={t('确认完全不审批？', 'Skip all approvals?')} className="confirm" onClose={() => setConfirmNever(false)}><h2 className="confirm-lead">{t('工具调用不再等待批准，规则表中的 allow / ask / deny 也不再参与判定。', 'Tool calls stop waiting for approval and allow / ask / deny rules no longer take part.')}</h2><p className="confirm-note">{t('工作区边界、交互通道限制、脚本绑定、系统硬拒绝和权限隔离仍然生效。这一步立即改变当前会话。', 'Workspace boundaries, interactive-channel limits, script binding, hard denials, and permission isolation stay active. This changes the current conversation immediately.')}</p><div className="confirm-actions"><button type="button" onClick={() => setConfirmNever(false)}>{t('取消', 'Cancel')}</button><button type="button" className="primary-button" onClick={() => { setConfirmNever(false); void choose('never'); }}>{t('我确认跳过所有审批', 'Confirm skipping all approvals')}</button></div></Modal>}
  </>;
}

function policyLabel(mode: string, t: (chinese: string, english: string) => string): string {
  if (mode === 'always') return t('每次审批', 'Ask every time');
  if (mode === 'ask') return t('逐次审批', 'Ask each time');
  if (mode === 'auto') return t('按规则审批', 'Rule-based approval');
  if (mode === 'never') return t('完全不审批', 'Never ask');
  return mode;
}
