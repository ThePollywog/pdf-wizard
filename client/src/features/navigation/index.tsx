/**
 * Navigation feature: Bookmarks, Find / Advanced search, Attachments, Layers panels, Document
 * Properties and Read Out Loud.
 */
import './styles.css';
import {
  Bookmark, BookmarkPlus, FileAudio, FileText, Layers, ListEnd, Paperclip, Pause, Play, Search, SearchCode, Square, TextSearch,
  VolumeX, ChevronDown, ChevronUp,
} from 'lucide-react';
import type { CommandDef, DocState } from '@/core/types';
import {
  registerCommand, registerCommands, registerContextMenu, registerExportHook, registerImportHook, registerPanel, useRegistry,
} from '@/core/registry';
import { actions, getDoc, useApp } from '@/core/store';
import { isEditableTarget, matchShortcut } from '@/core/ui';
import { activeDocId, canEdit, inDocument } from './util';
import { BookmarksPanel } from './bookmarks/BookmarksPanel';
import { bookmarkDestHook, startDestTracking } from './bookmarks/dest';
import { newBookmark, selectedDocText } from './bookmarks/actions';
import { find, startFind, useFind } from './find/findStore';
import { FindBar } from './find/FindBar';
import { SearchPanel, openAdvancedSearch } from './find/SearchPanel';
import { ATTACH_EXT, ATTACHMENT_KIND, AttachmentsPanel } from './attachments/AttachmentsPanel';
import { countEmbeddedFiles } from './attachments/model';
import { openDocProperties } from './properties/DocPropertiesDialog';
import { initialViewHook, initialViewImportHook, startDocTitle, startInitialView } from './properties/initialView';
import { customInfoHook } from './properties/custom';
import { readAloud, speechSupported, startReadAloud, useReadAloud } from './readAloud/controller';
import { ReadAloudControl } from './readAloud/ReadAloudControl';
import { LAYERS_PANEL_ID, LayersPanel, startLayers } from './layers/LayersPanel';
import { mountOverlay, registerViewerOverlay } from './overlay';

// ── panels ──────────────────────────────────────────────────────────────────

registerPanel({ id: 'bookmarks', label: 'Bookmarks', icon: Bookmark, order: 20, Component: BookmarksPanel });

const attachmentCount = (doc: DocState) =>
  ((doc.ext[ATTACH_EXT] as number | undefined) ?? 0) + Object.values(doc.objects).filter((o) => o.kind === ATTACHMENT_KIND).length;
registerPanel({
  id: 'attachments',
  label: 'Attachments',
  icon: Paperclip,
  order: 40,
  Component: AttachmentsPanel,
  badge: (doc) => attachmentCount(doc) || undefined,
});

registerPanel({ id: 'search', label: 'Search', icon: TextSearch, order: 50, Component: SearchPanel });

// Layers: registered only while the active document has optional content.
startLayers({ id: LAYERS_PANEL_ID, label: 'Layers', icon: Layers, order: 60, Component: LayersPanel });

// ── export / import hooks ───────────────────────────────────────────────────

registerExportHook(bookmarkDestHook);
registerExportHook(initialViewHook);
registerExportHook(customInfoHook);
// Reads /PageMode, /PageLayout and /OpenAction while the file opens, so they apply before the first paint.
registerImportHook(initialViewImportHook);

// ── commands ────────────────────────────────────────────────────────────────

const docReady = () => {
  const id = activeDocId();
  const d = id ? getDoc(id) : undefined;
  return !!d && !d.loading && !d.loadError;
};
const ra = () => useReadAloud.getState();

registerCommands([
  {
    id: 'navigation.find',
    label: 'Find text',
    icon: Search,
    shortcut: 'mod+f',
    menu: 'edit',
    group: '5-find',
    order: 0,
    requiresDocument: true,
    enabled: docReady,
    run: () => {
      const id = activeDocId();
      find.open(id ? selectedDocText(id) : null);
    },
  },
  {
    id: 'navigation.findNext',
    label: 'Find next',
    icon: ChevronDown,
    shortcut: 'mod+g',
    menu: 'edit',
    group: '5-find',
    order: 1,
    requiresDocument: true,
    enabled: docReady,
    run: () => find.step(1),
  },
  {
    id: 'navigation.findPrev',
    label: 'Find previous',
    icon: ChevronUp,
    shortcut: 'mod+shift+g',
    menu: 'edit',
    group: '5-find',
    order: 2,
    requiresDocument: true,
    enabled: docReady,
    run: () => find.step(-1),
  },
  {
    id: 'navigation.advancedSearch',
    label: 'Advanced search',
    icon: SearchCode,
    shortcut: 'mod+shift+f',
    menu: 'edit',
    group: '5-find',
    order: 3,
    requiresDocument: true,
    enabled: docReady,
    run: () => {
      const id = activeDocId();
      const st = useFind.getState();
      openAdvancedSearch((id && selectedDocText(id)) || (st.open ? st.query : '') || undefined);
    },
  },
  {
    id: 'navigation.newBookmark',
    label: 'Add bookmark',
    icon: BookmarkPlus,
    menu: 'document',
    group: '5-navigation',
    order: 0,
    requiresDocument: true,
    enabled: () => docReady() && canEdit(activeDocId()),
    run: () => {
      const id = activeDocId();
      if (id) newBookmark(id);
    },
  },
  {
    id: 'navigation.docProperties',
    label: 'Document properties…',
    icon: FileText,
    menu: 'file',
    group: '8-props',
    order: 0,
    requiresDocument: true,
    enabled: docReady,
    run: () => void openDocProperties(activeDocId()),
  },
  // Read Out Loud (View menu, like the usual View › Read Out Loud).
  {
    id: 'navigation.readAloud.activate',
    label: 'Activate Read Out Loud',
    icon: FileAudio,
    menu: 'view',
    group: '7-readaloud',
    order: 0,
    requiresDocument: true,
    enabled: () => !ra().active,
    run: () => readAloud.activate(),
  },
  {
    id: 'navigation.readAloud.deactivate',
    label: 'Deactivate Read Out Loud',
    icon: VolumeX,
    menu: 'view',
    group: '7-readaloud',
    order: 1,
    requiresDocument: true,
    enabled: () => ra().active,
    run: () => readAloud.deactivate(),
  },
  {
    id: 'navigation.readAloud.readPage',
    label: 'Read this page only',
    icon: Play,
    menu: 'view',
    group: '7-readaloud',
    order: 2,
    requiresDocument: true,
    enabled: () => speechSupported() && docReady(),
    run: () => readAloud.readPage(activeDocId()),
  },
  {
    id: 'navigation.readAloud.readToEnd',
    label: 'Read to end of document',
    icon: ListEnd,
    menu: 'view',
    group: '7-readaloud',
    order: 3,
    requiresDocument: true,
    enabled: () => speechSupported() && docReady(),
    run: () => readAloud.readToEnd(activeDocId()),
  },
  {
    id: 'navigation.readAloud.pause',
    label: 'Pause reading',
    icon: Pause,
    menu: 'view',
    group: '7-readaloud',
    order: 4,
    requiresDocument: true,
    enabled: () => ra().status === 'speaking',
    run: () => readAloud.pause(),
  },
  {
    id: 'navigation.readAloud.resume',
    label: 'Resume reading',
    icon: Play,
    menu: 'view',
    group: '7-readaloud',
    order: 5,
    requiresDocument: true,
    enabled: () => ra().status === 'paused',
    run: () => readAloud.resume(),
  },
  {
    id: 'navigation.readAloud.stop',
    label: 'Stop reading',
    icon: Square,
    menu: 'view',
    group: '7-readaloud',
    order: 6,
    requiresDocument: true,
    enabled: () => ra().status !== 'idle',
    run: () => readAloud.stop(),
  },
]);

/**
 * Shortcuts that aren't reserved for navigation by convention: take them only if no other feature
 * registered them (checked once every feature has loaded).
 */
const OPTIONAL_SHORTCUTS: Record<string, string> = {
  'navigation.newBookmark': 'mod+b',
  'navigation.docProperties': 'mod+alt+p',
  'navigation.readAloud.activate': 'mod+shift+y',
  'navigation.readAloud.deactivate': 'mod+shift+y',
  'navigation.readAloud.readPage': 'mod+shift+v',
  'navigation.readAloud.readToEnd': 'mod+shift+b',
  'navigation.readAloud.pause': 'mod+shift+c',
  'navigation.readAloud.resume': 'mod+shift+c',
  'navigation.readAloud.stop': 'mod+shift+e',
};
const normCombo = (c: string) => c.toLowerCase().split('+').sort().join('+');
function assignOptionalShortcuts() {
  const { commands, tools } = useRegistry.getState();
  const taken = new Set<string>();
  for (const c of Object.values(commands)) if (c.shortcut && !c.id.startsWith('navigation.')) taken.add(normCombo(c.shortcut));
  for (const t of Object.values(tools)) if (t.shortcut) taken.add(normCombo(t.shortcut));
  for (const [id, combo] of Object.entries(OPTIONAL_SHORTCUTS)) {
    const c = commands[id] as CommandDef | undefined;
    if (!c || c.shortcut === combo || taken.has(normCombo(combo))) continue;
    registerCommand({ ...c, shortcut: combo });
  }
}
if (useRegistry.getState().ready) assignOptionalShortcuts();
else {
  const unsub = useRegistry.subscribe((s) => {
    if (!s.ready) return;
    unsub();
    assignOptionalShortcuts();
  });
}

// Ctrl/Cmd+F while typing in a field of the document workspace (e.g. a comment) still opens Find
// instead of the browser's find bar — the global shortcut manager ignores it while typing.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !matchShortcut(e, 'mod+f')) return;
  if (!isEditableTarget(e.target) || !inDocument() || useApp.getState().modals.length) return;
  if (e.target instanceof Element && e.target.closest('.navigation-findbar, .navigation-search')) return;
  e.preventDefault();
  find.open();
});

// ── context menu ────────────────────────────────────────────────────────────

registerContextMenu({
  id: 'navigation-page-menu',
  target: 'page',
  order: 60,
  items: ({ docId }) => [
    { id: 'navigation.ctx.bookmark', label: 'Add bookmark', icon: BookmarkPlus, disabled: !canEdit(docId), run: () => void newBookmark(docId) },
    {
      id: 'navigation.ctx.readPage',
      label: 'Read this page out loud',
      icon: FileAudio,
      disabled: !speechSupported(),
      run: () => readAloud.readPage(docId),
    },
  ],
});

// ── attachment count (panel badge) ──────────────────────────────────────────

const counted = new WeakMap<object, true>();
function refreshAttachmentCounts() {
  for (const d of Object.values(useApp.getState().docs)) {
    if (!d.pdf || d.pdfVersion !== d.version || counted.has(d.pdf)) continue;
    counted.set(d.pdf, true);
    const id = d.id;
    void countEmbeddedFiles(id)
      .then((n) => {
        const cur = getDoc(id);
        if (cur && cur.ext[ATTACH_EXT] !== n) actions.setExt(id, ATTACH_EXT, n);
      })
      .catch(() => undefined);
  }
}
useApp.subscribe((s, p) => {
  if (s.docs !== p.docs) refreshAttachmentCounts();
});

// ── startup ─────────────────────────────────────────────────────────────────

startDestTracking();
startFind();
startInitialView();
startDocTitle();
startReadAloud();
registerViewerOverlay('find', FindBar);
registerViewerOverlay('read-aloud', ReadAloudControl);
mountOverlay();
