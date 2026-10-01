/**
 * Core commands ('core.*') and the built-in select / hand tools. Commands appear in the
 * hamburger menu (grouped by `menu`), the command palette and the shortcut manager.
 */
import {
  ArrowDownToLine, ArrowUpToLine, BookOpen, ChevronLeft, ChevronRight, Columns2, Download, Expand, FilePen, FilePlus2,
  FileStack, FolderOpen, Hand, House, Info, Keyboard, LayoutGrid, Maximize, Moon, MousePointer2, PanelLeft, PanelRight,
  Printer, Redo2, RotateCcw, RotateCw, Save, SaveAll, Search, Settings, SquareDashedMousePointer, StretchHorizontal,
  Trash2, Undo2, X, ZoomIn, ZoomOut, File, BookOpenText, Hash, Send,
} from 'lucide-react';
import { reg, registerCommands, registerTool, useRegistry } from '@/core/registry';
import { actions, getActiveDoc, useApp } from '@/core/store';
import type { CommandDef, DocState, MenuId, PageLayout } from '@/core/types';
import { promptDialog } from '@/core/ui';
import {
  closeAllDocs, downloadDocument, openFilePicker, printDocument, promptRenameDocument, requestCloseDoc, saveDocument,
  saveDocumentAs, shareDocument, toastError,
} from './docActions';
import { openAbout } from './dialogs/AboutDialog';
import { openPreferences } from './dialogs/PreferencesDialog';
import { openShortcuts } from './dialogs/ShortcutsDialog';
import { shell, useShell } from './uiStore';

export const MENU_ORDER: MenuId[] = ['file', 'edit', 'view', 'document', 'comment', 'tools', 'help'];
export const MENU_LABELS: Record<MenuId, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  document: 'Document',
  comment: 'Comment',
  tools: 'Tools',
  help: 'Help',
};

/** Shortcuts shown in menus but handled elsewhere (viewer / tool shortcuts). */
export const SHORTCUT_HINTS: Record<string, string> = {
  'core.deleteSelection': 'delete',
  'core.toolSelect': 'v',
  'core.toolHand': 'h',
};

/** Extra key combos that also trigger a command. */
export const SHORTCUT_ALIASES: Record<string, string[]> = {
  'core.redo': ['mod+y'],
};

/** "In a document workspace": an active document is shown. */
export function hasDocContext(): boolean {
  const s = useApp.getState();
  return s.route === 'document' && !!s.activeDocId && !!s.docs[s.activeDocId];
}

export function isCommandEnabled(c: CommandDef): boolean {
  if (c.requiresDocument && !hasDocContext()) return false;
  try {
    return c.enabled ? c.enabled() !== false : true;
  } catch {
    return false;
  }
}

export async function executeCommand(c: CommandDef | string | undefined): Promise<void> {
  const cmd = typeof c === 'string' ? reg.command(c) : c;
  if (!cmd || !isCommandEnabled(cmd)) return;
  try {
    await cmd.run();
  } catch (e) {
    toastError(e);
  }
}

const doc = (): DocState | undefined => getActiveDoc();
const view = () => doc()?.view;

/** Checkmark state for toggle-like commands (menus / palette). */
export const CHECKED: Record<string, () => boolean> = {
  'core.layoutSingle': () => view()?.layout === 'single',
  'core.layoutContinuous': () => view()?.layout === 'continuous',
  'core.layoutTwoPage': () => view()?.layout === 'two-page',
  'core.layoutTwoPageContinuous': () => view()?.layout === 'two-page-continuous',
  'core.nightMode': () => !!view()?.darkPages,
  'core.fullScreen': () => !!document.fullscreenElement,
  'core.readMode': () => useShell.getState().readMode,
  'core.toggleLeftPanel': () => hasDocContext() && useApp.getState().leftPanelOpen,
  'core.toggleRightPanel': () => hasDocContext() && !!useApp.getState().rightPanelId,
  'core.fitPage': () => view()?.fit === 'page',
  'core.fitWidth': () => view()?.fit === 'width',
  'core.toolSelect': () => useApp.getState().activeToolId === 'select',
  'core.toolHand': () => useApp.getState().activeToolId === 'hand',
};

/** Resolve "3", "iv" (page label) → 0-based page index. */
export function resolvePageInput(d: DocState, input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const byLabel = d.pages.findIndex((p) => p.label != null && p.label.toLowerCase() === lower);
  if (byLabel >= 0) return byLabel;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (n >= 1 && n <= d.pages.length) return n - 1;
  }
  return null;
}

let lastRightPanel: string | null = null;
useApp.subscribe(
  (s) => s.rightPanelId,
  (id) => {
    if (id) lastRightPanel = id;
  },
);

export function toggleRightPanel() {
  const s = useApp.getState();
  if (s.rightPanelId) {
    actions.setRightPanel(null);
    return;
  }
  const panels = Object.values(useRegistry.getState().panels).sort((a, b) => a.order - b.order);
  const target = (lastRightPanel && panels.find((p) => p.id === lastRightPanel)) || panels[0];
  if (target) actions.setRightPanel(target.id);
}

export function toggleFullScreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen?.().catch((e: unknown) => toastError(e, "Couldn't enter full screen"));
}

const setLayout = (layout: PageLayout) => {
  const d = doc();
  if (d) actions.setView(d.id, { layout });
};

const pageEnabled = (pred: (d: DocState) => boolean) => () => {
  const d = doc();
  return !!d && d.pages.length > 0 && pred(d);
};
const noSelection = (d: DocState) => d.selection.length === 0 && !d.editingId;

async function goToPageDialog() {
  const d = doc();
  if (!d || !d.pages.length) return;
  const hasLabels = d.pages.some((p, i) => p.label && p.label !== String(i + 1));
  const v = await promptDialog({
    title: 'Go to page',
    label: `Page number (1–${d.pages.length})`,
    defaultValue: String(d.view.currentPage + 1),
    confirmLabel: 'Go',
    help: hasLabels ? 'You can also type a page label.' : undefined,
    validate: (val) => (val.trim() === '' || resolvePageInput(getActiveDoc() ?? d, val) != null ? null : 'Enter a page that exists in this document'),
  });
  if (v == null) return;
  const cur = getActiveDoc();
  const idx = cur ? resolvePageInput(cur, v) : null;
  if (cur && idx != null) actions.goToPage(cur.id, idx);
}

export function registerCoreTools() {
  const tools = useRegistry.getState().tools;
  if (!tools.select) {
    registerTool({ id: 'select', label: 'Select', icon: MousePointer2, group: 'select', shortcut: 'v', quick: 0, order: 0 });
  }
  if (!tools.hand) {
    registerTool({ id: 'hand', label: 'Hand', icon: Hand, group: 'view', shortcut: 'h', quick: 1, order: 1, cursor: 'grab' });
  }
}

export function registerCoreCommands() {
  const cmds: CommandDef[] = [
    // ── File ──
    { id: 'core.open', label: 'Open…', icon: FolderOpen, shortcut: 'mod+o', menu: 'file', group: '1-open', order: 0, run: () => void openFilePicker() },
    { id: 'core.save', label: 'Save', icon: Save, shortcut: 'mod+s', menu: 'file', group: '2-save', order: 0, requiresDocument: true, enabled: () => !!doc() && !useShell.getState().saving[doc()!.id], run: () => void saveDocument() },
    { id: 'core.saveAs', label: 'Save as…', icon: SaveAll, shortcut: 'mod+shift+s', menu: 'file', group: '2-save', order: 1, requiresDocument: true, run: () => void saveDocumentAs() },
    { id: 'core.download', label: 'Download', icon: Download, menu: 'file', group: '2-save', order: 2, requiresDocument: true, run: () => downloadDocument() },
    { id: 'core.share', label: 'Send a copy…', icon: Send, menu: 'file', group: '2-save', order: 3, requiresDocument: true, run: () => shareDocument() },
    { id: 'core.rename', label: 'Rename…', icon: FilePen, menu: 'file', group: '2-save', order: 4, requiresDocument: true, run: () => promptRenameDocument() },
    { id: 'core.print', label: 'Print…', icon: Printer, shortcut: 'mod+p', menu: 'file', group: '3-print', order: 0, requiresDocument: true, run: () => printDocument() },
    { id: 'core.close', label: 'Close', icon: X, shortcut: 'alt+w', menu: 'file', group: '9-close', order: 0, requiresDocument: true, run: () => void requestCloseDoc() },
    { id: 'core.closeAll', label: 'Close all', icon: FileStack, menu: 'file', group: '9-close', order: 1, enabled: () => useApp.getState().tabs.length > 0, run: () => void closeAllDocs() },

    // ── Edit ──
    { id: 'core.undo', label: 'Undo', icon: Undo2, shortcut: 'mod+z', menu: 'edit', group: '1-history', order: 0, requiresDocument: true, enabled: () => (doc()?.history.past.length ?? 0) > 0, run: () => actions.undo() },
    { id: 'core.redo', label: 'Redo', icon: Redo2, shortcut: 'mod+shift+z', menu: 'edit', group: '1-history', order: 1, requiresDocument: true, enabled: () => (doc()?.history.future.length ?? 0) > 0, run: () => actions.redo() },
    {
      id: 'core.selectAll', label: 'Select all objects', icon: SquareDashedMousePointer, menu: 'edit', group: '2-select', order: 0, requiresDocument: true,
      enabled: () => (doc()?.order.length ?? 0) > 0,
      run: () => {
        const d = doc();
        if (!d) return;
        actions.setTool('select');
        actions.setSelection(d.id, d.order.filter((id) => d.objects[id] && !d.objects[id].locked));
      },
    },
    {
      id: 'core.deleteSelection', label: 'Delete selection', icon: Trash2, menu: 'edit', group: '2-select', order: 1, requiresDocument: true,
      enabled: () => (doc()?.selection.length ?? 0) > 0,
      run: () => {
        const d = doc();
        if (d && d.selection.length) actions.deleteObjects(d.id, d.selection, { label: 'Delete' });
      },
    },
    { id: 'core.preferences', label: 'Preferences…', icon: Settings, menu: 'edit', group: '9-prefs', order: 0, run: () => void openPreferences() },

    // ── View ──
    { id: 'core.zoomIn', label: 'Zoom in', icon: ZoomIn, shortcut: 'mod+=', menu: 'view', group: '1-zoom', order: 0, requiresDocument: true, run: () => actions.zoomIn() },
    { id: 'core.zoomOut', label: 'Zoom out', icon: ZoomOut, shortcut: 'mod+-', menu: 'view', group: '1-zoom', order: 1, requiresDocument: true, run: () => actions.zoomOut() },
    { id: 'core.actualSize', label: 'Actual size', icon: File, shortcut: 'mod+0', menu: 'view', group: '1-zoom', order: 2, requiresDocument: true, run: () => { const d = doc(); if (d) actions.setZoom(d.id, 1); } },
    { id: 'core.fitPage', label: 'Fit page', icon: Maximize, shortcut: 'mod+alt+1', menu: 'view', group: '1-zoom', order: 3, requiresDocument: true, run: () => actions.fit(null, 'page') },
    { id: 'core.fitWidth', label: 'Fit width', icon: StretchHorizontal, shortcut: 'mod+alt+2', menu: 'view', group: '1-zoom', order: 4, requiresDocument: true, run: () => actions.fit(null, 'width') },
    { id: 'core.rotateCw', label: 'Rotate view clockwise', icon: RotateCw, shortcut: 'mod+shift+=', menu: 'view', group: '2-rotate', order: 0, requiresDocument: true, run: () => actions.rotateView(null, 90) },
    { id: 'core.rotateCcw', label: 'Rotate view counterclockwise', icon: RotateCcw, shortcut: 'mod+shift+-', menu: 'view', group: '2-rotate', order: 1, requiresDocument: true, run: () => actions.rotateView(null, -90) },
    { id: 'core.prevPage', label: 'Previous page', icon: ChevronLeft, shortcut: 'arrowleft', menu: 'view', group: '3-nav', order: 0, requiresDocument: true, enabled: pageEnabled((d) => noSelection(d) && d.view.currentPage > 0), run: () => { const d = doc(); if (d) actions.goToPage(d.id, d.view.currentPage - 1); } },
    { id: 'core.nextPage', label: 'Next page', icon: ChevronRight, shortcut: 'arrowright', menu: 'view', group: '3-nav', order: 1, requiresDocument: true, enabled: pageEnabled((d) => noSelection(d) && d.view.currentPage < d.pages.length - 1), run: () => { const d = doc(); if (d) actions.goToPage(d.id, d.view.currentPage + 1); } },
    { id: 'core.firstPage', label: 'First page', icon: ArrowUpToLine, shortcut: 'home', menu: 'view', group: '3-nav', order: 2, requiresDocument: true, enabled: pageEnabled(noSelection), run: () => { const d = doc(); if (d) actions.goToPage(d.id, 0); } },
    { id: 'core.lastPage', label: 'Last page', icon: ArrowDownToLine, shortcut: 'end', menu: 'view', group: '3-nav', order: 3, requiresDocument: true, enabled: pageEnabled(noSelection), run: () => { const d = doc(); if (d) actions.goToPage(d.id, d.pages.length - 1); } },
    { id: 'core.goToPage', label: 'Go to page…', icon: Hash, shortcut: 'mod+alt+g', menu: 'view', group: '3-nav', order: 4, requiresDocument: true, enabled: pageEnabled(() => true), run: () => void goToPageDialog() },
    { id: 'core.layoutSingle', label: 'Single page', icon: File, menu: 'view', group: '4-layout', order: 0, requiresDocument: true, run: () => setLayout('single') },
    { id: 'core.layoutContinuous', label: 'Continuous scrolling', icon: FileStack, menu: 'view', group: '4-layout', order: 1, requiresDocument: true, run: () => setLayout('continuous') },
    { id: 'core.layoutTwoPage', label: 'Two pages', icon: Columns2, menu: 'view', group: '4-layout', order: 2, requiresDocument: true, run: () => setLayout('two-page') },
    { id: 'core.layoutTwoPageContinuous', label: 'Two pages scrolling', icon: BookOpen, menu: 'view', group: '4-layout', order: 3, requiresDocument: true, run: () => setLayout('two-page-continuous') },
    { id: 'core.nightMode', label: 'Night mode', icon: Moon, menu: 'view', group: '5-display', order: 0, requiresDocument: true, run: () => { const d = doc(); if (d) actions.setView(d.id, { darkPages: !d.view.darkPages }); } },
    { id: 'core.readMode', label: 'Read mode', icon: BookOpenText, shortcut: 'mod+alt+r', menu: 'view', group: '5-display', order: 1, requiresDocument: true, run: () => shell.setReadMode(!useShell.getState().readMode) },
    { id: 'core.fullScreen', label: 'Full screen', icon: Expand, shortcut: 'mod+alt+f', menu: 'view', group: '5-display', order: 2, run: toggleFullScreen },
    { id: 'core.toggleLeftPanel', label: 'Show left panel', icon: PanelLeft, shortcut: 'f4', menu: 'view', group: '6-panels', order: 0, requiresDocument: true, run: () => actions.setLeftPanelOpen(!useApp.getState().leftPanelOpen) },
    { id: 'core.toggleRightPanel', label: 'Show right panel', icon: PanelRight, shortcut: 'shift+f4', menu: 'view', group: '6-panels', order: 1, requiresDocument: true, enabled: () => Object.keys(useRegistry.getState().panels).length > 0, run: toggleRightPanel },

    // ── Tools ──
    { id: 'core.toolSelect', label: 'Select tool', icon: MousePointer2, menu: 'tools', group: '0-basic', order: 0, requiresDocument: true, run: () => actions.setTool('select') },
    { id: 'core.toolHand', label: 'Hand tool', icon: Hand, menu: 'tools', group: '0-basic', order: 1, requiresDocument: true, run: () => actions.setTool('hand') },
    { id: 'core.allTools', label: 'All tools', icon: LayoutGrid, menu: 'tools', group: '9-nav', order: 0, run: () => actions.setRoute('tools') },
    { id: 'core.home', label: 'Home', icon: House, menu: 'tools', group: '9-nav', order: 1, run: () => actions.setRoute('home') },
    { id: 'core.newFromFiles', label: 'Create PDF from files…', icon: FilePlus2, menu: 'file', group: '1-open', order: 1, enabled: () => useRegistry.getState().fileHandlers.length > 0, run: () => void openFilePicker() },

    // ── Help ──
    { id: 'core.palette', label: 'Search tools and commands', icon: Search, shortcut: 'mod+k', menu: 'help', group: '1-find', order: 0, run: () => (useShell.getState().paletteOpen ? shell.closePalette() : shell.openPalette()) },
    { id: 'core.shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, shortcut: '?', menu: 'help', group: '1-find', order: 1, run: () => void openShortcuts() },
    { id: 'core.about', label: 'About PDF Wizard', icon: Info, menu: 'help', group: '9-about', order: 0, run: () => void openAbout() },
  ];
  registerCommands(cmds);
}
