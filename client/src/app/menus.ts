/** Builds menu entries (hamburger menu, tab context menus…) from registry commands. */
import { CircleHelp, Eye, FileClock, FileCog, FileText, MessageSquare, PenLine, Wrench } from 'lucide-react';
import type { IconType } from '@/core/types';
import { useRegistry } from '@/core/registry';
import type { CommandDef, MenuId } from '@/core/types';
import { cleanMenu, type MenuActionItem, type MenuEntry } from '@/core/ui';
import { CHECKED, executeCommand, isCommandEnabled, MENU_LABELS, MENU_ORDER, SHORTCUT_HINTS } from './commands';
import { openLibraryFile } from './docActions';
import { useShell } from './uiStore';

const MENU_ICONS: Partial<Record<MenuId, IconType>> = {
  edit: PenLine,
  view: Eye,
  document: FileCog,
  comment: MessageSquare,
  tools: Wrench,
  help: CircleHelp,
};

const byGroupOrder = (a: CommandDef, b: CommandDef) =>
  (a.group ?? '').localeCompare(b.group ?? '') || (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label);

export function commandItem(cmd: CommandDef, overrides: Partial<MenuActionItem> = {}): MenuActionItem {
  const checked = CHECKED[cmd.id] as (() => boolean) | undefined;
  return {
    id: cmd.id,
    label: cmd.label,
    icon: checked ? undefined : cmd.icon,
    shortcut: cmd.shortcut ?? SHORTCUT_HINTS[cmd.id],
    disabled: !isCommandEnabled(cmd),
    checked: checked ? checked() : undefined,
    run: () => executeCommand(cmd),
    ...overrides,
  };
}

/** Commands of one menu, sorted and separated by group. */
export function menuEntries(menu: MenuId): MenuEntry[] {
  const cmds = Object.values(useRegistry.getState().commands).filter((c) => c.menu === menu).sort(byGroupOrder);
  const out: MenuEntry[] = [];
  let group: string | undefined;
  for (const c of cmds) {
    if (out.length && c.group !== group) out.push('divider');
    group = c.group;
    out.push(commandItem(c));
  }
  return out;
}

function recentEntries(): MenuEntry[] {
  const recent = useShell.getState().recentFiles.slice(0, 8);
  if (!recent.length) return [{ id: 'recent.none', label: 'No recent files', disabled: true, run: () => {} }];
  return recent.map((f) => ({ id: `recent.${f.id}`, label: f.name, icon: FileText, run: () => void openLibraryFile(f.id) }));
}

/**
 * The hamburger "Menu": File commands at the top level (like a desktop app menu), then one submenu
 * per other MenuId that has commands (Edit, View, Document, Comment, Tools, Help).
 */
export function appMenuEntries(): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const m of MENU_ORDER) {
    const entries = menuEntries(m);
    if (m === 'file') {
      const openIdx = entries.findIndex((e) => e !== 'divider' && 'id' in e && e.id === 'core.open');
      entries.splice(openIdx + 1, 0, { id: 'file.recent', label: 'Open recent', icon: FileClock, submenu: recentEntries });
      out.push(...entries, 'divider');
      continue;
    }
    const clean = cleanMenu(entries);
    if (!clean.length) continue;
    out.push({ id: `menu.${m}`, label: MENU_LABELS[m], icon: MENU_ICONS[m], submenu: clean });
  }
  return cleanMenu(out);
}
