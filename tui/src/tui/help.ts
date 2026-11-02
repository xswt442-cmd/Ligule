import type { Locale } from '@ligule/core/tui.js';
import { localizedCommand, UI_COMMANDS, type TemplateCommand } from './commands.js';
import { CURRENT, ENGLISH_LABELS, ENGLISH_VIEWS, formatKeys, KEYMAP, type Binding, type KeyView, type TerminalAction } from './keymap.js';

export const HELP_TABS = ['commands', 'keys', 'templates'] as const;

export type HelpTab = typeof HELP_TABS[number];
export interface HelpEntry {
  readonly key: string;
  readonly description: string;
}

const COMMAND_CATEGORIES = [
  { title: ['会话', 'Sessions'], commands: ['new', 'sessions', 'find', 'resume', 'takeover', 'branch', 'rename', 'archive', 'unarchive', 'show', 'sub'] },
  { title: ['运行与工具', 'Runtime and tools'], commands: ['mode', 'model', 'think', 'policy', 'status', 'compact', 'tools', 'queue', 'browser'] },
  { title: ['输入与设置', 'Input and settings'], commands: ['help', 'bind', 'credentials', 'mcp', 'extensions', 'permission', 'screen', 'control', 'trust', 'copy', 'export', 'quit'] },
] as const;

const EMPTY_TEMPLATES: readonly HelpEntry[] = [
  { key: '（无）', description: '没有可用提示模板' },
];

function titleOf(tab: HelpTab, locale: Locale): string {
  if (locale === 'zh') {
    if (tab === 'commands') return '命令';
    if (tab === 'keys') return '按键';
    return '提示模板';
  }
  if (tab === 'commands') return 'Commands';
  if (tab === 'keys') return 'Keys';
  return 'Prompt templates';
}

export function helpTabTitle(tab: HelpTab, locale: Locale): string {
  return titleOf(tab, locale);
}

function commandEntries(locale: Locale): HelpEntry[] {
  return COMMAND_CATEGORIES.flatMap((category) => {
    const title = category.title[locale === 'zh' ? 0 : 1];
    const entries = UI_COMMANDS
      .filter((command) => (category.commands as readonly string[]).includes(command.name))
      .map((command) => {
        const localized = localizedCommand(command, locale);
        return { key: localized.usage, description: localized.text };
      });
    return [{ key: title, description: '' }, ...entries];
  });
}

function keyEntries(locale: Locale): HelpEntry[] {
  const actions = Object.entries(KEYMAP) as [TerminalAction, Binding][];
  return (Object.keys(ENGLISH_VIEWS) as KeyView[]).flatMap((view) => {
    const title = locale === 'zh' ? view : ENGLISH_VIEWS[view];
    const entries = actions
      .filter(([, binding]) => binding.view === view)
      .map(([action, binding]) => ({
        key: formatKeys(CURRENT[action]),
        description: locale === 'zh' ? binding.label : ENGLISH_LABELS[action],
      }));
    return [{ key: title, description: '' }, ...entries];
  });
}

function templateEntries(templates: readonly TemplateCommand[], locale: Locale): HelpEntry[] {
  if (templates.length === 0) {
    return locale === 'zh' ? [...EMPTY_TEMPLATES] : [{ key: '(none)', description: 'No prompt templates' }];
  }
  return templates.map((template) => ({
    key: `/${template.command}`,
    description: template.description ?? '',
  }));
}

export function helpEntries(
  tab: HelpTab,
  templates: readonly TemplateCommand[],
  locale: Locale,
): readonly HelpEntry[] {
  if (tab === 'commands') return commandEntries(locale);
  if (tab === 'keys') return keyEntries(locale);
  return templateEntries(templates, locale);
}
