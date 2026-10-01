import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  CircleHelp, Download, Eye, FilePen, FileText, Info, Keyboard, Link2, Menu as MenuIcon, Monitor, Moon, Save, Search, Settings, Sun,
  UserRound, X,
} from 'lucide-react';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Dropdown, IconButton, Kbd, promptDialog, showContextMenu, type MenuEntry } from '@/core/ui';
import { WizardLogo } from './Logo';
import { appMenuEntries } from './menus';
import {
  closeAllDocs, closeOtherDocs, downloadDocument, promptRenameDocument, requestCloseDoc, saveDocument, shareDocument,
} from './docActions';
import { openAbout } from './dialogs/AboutDialog';
import { openPreferences } from './dialogs/PreferencesDialog';
import { openShortcuts } from './dialogs/ShortcutsDialog';
import { shell, useShell } from './uiStore';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const TAB_MIME = 'application/x-pdfwizard-tab';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

const AVATAR_COLORS = ['#1473e6', '#7e4cc7', '#d83790', '#12805c', '#e68619', '#0d66d0', '#6e49cb', '#c9252d'];
export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// ── Document tabs ───────────────────────────────────────────────────────────

function tabMenu(id: DocId): MenuEntry[] {
  const count = useApp.getState().tabs.length;
  const d = useApp.getState().docs[id];
  const readOnly = !!d?.ext.readOnly;
  return [
    { id: 'tab.rename', label: 'Rename…', icon: FilePen, disabled: readOnly, run: () => promptRenameDocument(id) },
    { id: 'tab.save', label: readOnly ? 'Save a copy' : 'Save', icon: Save, run: () => void saveDocument(id) },
    { id: 'tab.download', label: 'Download', icon: Download, run: () => downloadDocument(id) },
    { id: 'tab.share', label: 'Share link…', icon: Link2, run: () => shareDocument(id) },
    'divider',
    { id: 'tab.close', label: 'Close', icon: X, shortcut: 'alt+w', run: () => void requestCloseDoc(id) },
    { id: 'tab.closeOthers', label: 'Close other tabs', disabled: count < 2, run: () => void closeOtherDocs(id) },
    { id: 'tab.closeAll', label: 'Close all tabs', run: () => void closeAllDocs() },
  ];
}

function DocTab({ id, active, index }: { id: DocId; active: boolean; index: number }) {
  const name = useDoc(id, (d) => d?.name ?? '');
  const dirty = useDoc(id, (d) => !!d?.dirty);
  const readOnly = useDoc(id, (d) => !!d?.ext.readOnly);
  const loading = useDoc(id, (d) => !!d?.loading && !d?.pdf);
  const saving = useShell((s) => !!s.saving[id]);
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null);

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TAB_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const isTabDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(TAB_MIME);
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDropSide(e.clientX < r.left + r.width / 2 ? 'before' : 'after');
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    const src = e.dataTransfer.getData(TAB_MIME);
    const side = dropSide;
    setDropSide(null);
    if (!src || src === id) return;
    const tabs = useApp.getState().tabs.filter((t) => t !== src);
    let at = tabs.indexOf(id);
    if (side === 'after') at += 1;
    tabs.splice(at, 0, src);
    actions.reorderTabs(tabs);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = useApp.getState().tabs;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      if (next) {
        actions.setActiveDoc(next);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="doc-tab"][data-doc-id="${CSS.escape(next)}"]`)?.focus());
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      actions.setActiveDoc(id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      void requestCloseDoc(id);
    }
  };

  const status = saving ? 'Saving…' : dirty ? 'Unsaved changes' : readOnly ? 'Shared, view only' : '';
  return (
    <div
      className={cx('doc-tab', active && 'is-active', dirty && 'is-dirty', dropSide && `drop-${dropSide}`)}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable
      title={status ? `${name} — ${status}` : name}
      data-testid="doc-tab"
      data-doc-id={id}
      onClick={() => actions.setActiveDoc(id)}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void requestCloseDoc(id);
        }
      }}
      onContextMenu={(e) => showContextMenu(e, tabMenu(id))}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropSide(null)}
      onDrop={onDrop}
      onDragEnd={() => setDropSide(null)}
    >
      <span className={cx('doc-tab-icon', loading && 'is-loading')} aria-hidden>
        <FileText size={16} strokeWidth={1.75} />
      </span>
      <span className="doc-tab-name">{name}</span>
      {readOnly && (
        <span className="doc-tab-flag" aria-label="View only">
          <Eye size={13} />
        </span>
      )}
      <span className="doc-tab-end">
        {dirty && <span className="doc-tab-dirty" aria-label="Unsaved changes" data-testid="doc-tab-dirty" />}
        <button
          type="button"
          className="doc-tab-close"
          aria-label={`Close ${name}`}
          tabIndex={-1}
          data-testid="doc-tab-close"
          onClick={(e) => {
            e.stopPropagation();
            void requestCloseDoc(id);
          }}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </span>
    </div>
  );
}

function DocTabs() {
  const tabs = useApp((s) => s.tabs);
  const activeDocId = useApp((s) => s.activeDocId);
  const route = useApp((s) => s.route);
  const ref = useRef<HTMLDivElement>(null);
  if (!tabs.length) return <div className="doc-tabs is-empty" />;
  return (
    <div
      ref={ref}
      className="doc-tabs"
      role="tablist"
      aria-label="Open documents"
      onWheel={(e) => {
        const el = ref.current;
        if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((id, i) => (
        <DocTab key={id} id={id} index={i} active={route === 'document' && id === activeDocId} />
      ))}
    </div>
  );
}

// ── Account / help menus ────────────────────────────────────────────────────

async function changeName() {
  const current = useApp.getState().prefs.userName;
  const name = await promptDialog({
    title: 'Your name',
    label: 'Name',
    defaultValue: current,
    confirmLabel: 'Save',
    help: 'Shown as the author of your comments and markups.',
    validate: (v) => (v.trim().length > 60 ? 'Use 60 characters or fewer' : null),
  });
  if (name != null) actions.setPrefs({ userName: name.trim() });
}

function accountItems(): MenuEntry[] {
  const { userName, theme } = useApp.getState().prefs;
  return [
    { header: userName || 'Guest' },
    { id: 'account.name', label: 'Change name…', icon: UserRound, run: changeName },
    {
      id: 'account.theme',
      label: 'Theme',
      icon: theme === 'dark' ? Moon : theme === 'system' ? Monitor : Sun,
      submenu: () => [
        { id: 'theme.light', label: 'Light', checked: theme === 'light', run: () => actions.setPrefs({ theme: 'light' }) },
        { id: 'theme.dark', label: 'Dark', checked: theme === 'dark', run: () => actions.setPrefs({ theme: 'dark' }) },
        { id: 'theme.system', label: 'Match system', checked: theme === 'system', run: () => actions.setPrefs({ theme: 'system' }) },
      ],
    },
    'divider',
    { id: 'account.prefs', label: 'Preferences…', icon: Settings, run: () => void openPreferences() },
  ];
}

const helpItems = (): MenuEntry[] => [
  { id: 'help.search', label: 'Search tools and commands', icon: Search, shortcut: 'mod+k', run: () => shell.openPalette() },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, shortcut: '?', run: () => void openShortcuts() },
  'divider',
  { id: 'help.about', label: 'About PDF Wizard', icon: Info, run: () => void openAbout() },
];

// ── Top bar ─────────────────────────────────────────────────────────────────

export function TopBar() {
  const route = useApp((s) => s.route);
  const userName = useApp((s) => s.prefs.userName) || 'Guest';

  const nav = (r: 'home' | 'tools') => (
    <button
      type="button"
      className={cx('topbar-navlink', route === r && 'is-active')}
      aria-current={route === r ? 'page' : undefined}
      data-testid={r === 'home' ? 'nav-home' : 'nav-tools'}
      onClick={() => actions.setRoute(r)}
    >
      {r === 'home' ? 'Home' : 'All tools'}
    </button>
  );

  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar-start">
        <Dropdown
          trigger={<IconButton icon={MenuIcon} label="Menu" data-testid="app-menu" className="topbar-menu" />}
          items={appMenuEntries}
          minWidth={260}
          label="Menu"
        />
        <a
          className="topbar-brand"
          href="#/"
          aria-label="PDF Wizard home"
          onClick={(e) => {
            e.preventDefault();
            actions.setRoute('home');
          }}
        >
          <WizardLogo size={26} />
          <span className="topbar-wordmark">PDF Wizard</span>
        </a>
        <nav className="topbar-nav" aria-label="Main">
          {nav('home')}
          {nav('tools')}
        </nav>
      </div>
      <DocTabs />
      <div className="topbar-end">
        <button type="button" className="topbar-search" onClick={() => shell.openPalette()} data-testid="palette-trigger" aria-label="Search tools and commands">
          <Search size={16} strokeWidth={2} />
          <span className="topbar-search-label">Find tools, commands, files</span>
          <Kbd shortcut="mod+k" className="topbar-search-kbd" />
        </button>
        <Dropdown trigger={<IconButton icon={CircleHelp} label="Help" data-testid="help-menu" />} items={helpItems} align="end" minWidth={240} label="Help" />
        <Dropdown
          trigger={
            <button type="button" className="topbar-avatar" aria-label={`Account: ${userName}`} data-testid="account-menu" style={{ background: avatarColor(userName) }}>
              {initials(userName)}
            </button>
          }
          items={accountItems}
          align="end"
          minWidth={220}
          label="Account"
        />
      </div>
    </header>
  );
}
