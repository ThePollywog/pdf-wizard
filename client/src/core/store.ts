/**
 * Central application store (zustand). State is immutable: always replace, never mutate.
 *
 * - Read reactively in components:   useApp(s => s.activeDocId), useActiveDoc(d => d?.pages)
 * - Read imperatively anywhere:       getDoc(id), getActiveDoc(), useApp.getState()
 * - Mutate through `actions.*` only.
 *
 * Undo/redo: every mutating document action pushes a Snapshot of the previous document state
 * (bytes are shared by reference, so snapshots are cheap). Page content changes go through
 * `actions.commitBytes` (usually via the engine), overlay objects through the object actions.
 * The engine watches `doc.version !== doc.pdfVersion` and (re)loads the pdf.js document.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { ReactNode } from 'react';
import type {
  Decoration, DocId, DocMeta, DocState, FitMode, ObjectId, OutlineItem, PageInfo, PdfObject,
  Point, Rect, SecuritySettings, Snapshot, UpdateOptions, ViewState,
} from './types';
import { reg } from './registry';
import { clamp, uid } from './util';

// ─────────────────────────────────────────────────────────────────────────────
// State shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 'home'     — Home page: recent files / library / quick actions.
 * 'tools'    — "All tools" grid.
 * 'document' — Viewer for the active document (tabs). A task may be open in the left panel.
 * 'task'     — A standalone task's MainView without a document (e.g. Combine files, Create PDF).
 */
export type RouteName = 'home' | 'tools' | 'document' | 'task';

export interface ModalEntry {
  id: string;
  render: (close: (result?: unknown) => void) => ReactNode;
  resolve: (v: unknown) => void;
  /** Close when clicking the backdrop / pressing Escape (default true). */
  dismissable: boolean;
}

export interface Toast {
  id: string;
  message: string;
  kind: 'info' | 'success' | 'error' | 'warning';
  action?: { label: string; run(): void };
  duration: number;
}

export interface BusyState {
  label: string;
  /** 0..1, or null for indeterminate. */
  progress: number | null;
  cancel?: () => void;
}

export interface Prefs {
  userName: string;
  theme: 'light' | 'dark' | 'system';
  /** Default zoom behavior when opening documents. */
  defaultFit: 'width' | 'page' | 'auto';
  /** Show the left "All tools" panel when a document opens. */
  showToolsPanel: boolean;
  /** Show the text-selection popup (Highlight / Copy ...). */
  selectionPopup: boolean;
}

export interface AppState {
  docs: Record<DocId, DocState>;
  /** Open document tabs, in display order. */
  tabs: DocId[];
  activeDocId: DocId | null;
  route: RouteName;
  /** Task (All tools entry) currently open, shown in the left panel / main view. */
  activeTaskId: string | null;
  /** Left panel (All tools list or active task panel) visible. */
  leftPanelOpen: boolean;
  /** Right-rail panel open (panel id) or null. */
  rightPanelId: string | null;
  activeToolId: string;
  /** When true a one-shot tool stays active after creating an object. */
  toolLocked: boolean;
  toolOptions: Record<string, Record<string, unknown>>;
  prefs: Prefs;
  modals: ModalEntry[];
  toasts: Toast[];
  busy: BusyState | null;
}

const PREFS_KEY = 'pdfwizard.prefs';
const TOOLOPTS_KEY = 'pdfwizard.toolOptions';

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

const defaultPrefs: Prefs = {
  userName: 'Guest',
  theme: 'light',
  defaultFit: 'auto',
  showToolsPanel: true,
  selectionPopup: true,
};

export const useApp = create<AppState>()(
  subscribeWithSelector((): AppState => ({
    docs: {},
    tabs: [],
    activeDocId: null,
    route: 'home',
    activeTaskId: null,
    leftPanelOpen: true,
    rightPanelId: null,
    activeToolId: 'select',
    toolLocked: false,
    toolOptions: loadJSON<Record<string, Record<string, unknown>>>(TOOLOPTS_KEY, {}),
    prefs: loadJSON<Prefs>(PREFS_KEY, defaultPrefs),
    modals: [],
    toasts: [],
    busy: null,
  })),
);

useApp.subscribe((s) => s.prefs, (p) => localStorage.setItem(PREFS_KEY, JSON.stringify(p)));
useApp.subscribe((s) => s.toolOptions, (o) => localStorage.setItem(TOOLOPTS_KEY, JSON.stringify(o)));

// ─────────────────────────────────────────────────────────────────────────────
// Selectors / accessors
// ─────────────────────────────────────────────────────────────────────────────

const get = useApp.getState;
const set = useApp.setState;

export const getDoc = (id: DocId | null | undefined): DocState | undefined => (id ? get().docs[id] : undefined);
export const getActiveDoc = (): DocState | undefined => getDoc(get().activeDocId);
/** Throws if there is no active document. */
export function requireActiveDoc(): DocState {
  const d = getActiveDoc();
  if (!d) throw new Error('No document is open');
  return d;
}

/** Reactive selector over the active document (returns undefined if none). */
export function useActiveDoc<T>(selector: (d: DocState | undefined) => T): T {
  return useApp((s) => selector(s.activeDocId ? s.docs[s.activeDocId] : undefined));
}
export function useDoc<T>(id: DocId | null | undefined, selector: (d: DocState | undefined) => T): T {
  return useApp((s) => selector(id ? s.docs[id] : undefined));
}

/** Tool options with defaults (reactive). Keep `defaults` referentially stable (module constant). */
export function useToolOptions<T extends Record<string, unknown>>(toolId: string, defaults: T): T {
  const opts = useApp((s) => s.toolOptions[toolId]);
  return opts ? ({ ...defaults, ...opts } as T) : defaults;
}
export function getToolOptions<T extends Record<string, unknown>>(toolId: string, defaults: T): T {
  return { ...defaults, ...(get().toolOptions[toolId] ?? {}) } as T;
}

export function pageIndexOf(doc: DocState, pageId: string): number {
  return doc.pages.findIndex((p) => p.id === pageId);
}

/** Objects of a page in z-order. */
export function objectsOnPage(doc: DocState, pageId: string): PdfObject[] {
  return doc.order.map((id) => doc.objects[id]).filter((o) => o && o.pageId === pageId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

let versionCounter = 0;
/** Globally unique version number for new bytes. */
export const nextVersion = () => ++versionCounter;

export const defaultView = (): ViewState => ({
  zoom: 1,
  fit: 'width',
  layout: 'continuous',
  rotation: 0,
  currentPage: 0,
  scrollRequest: null,
  darkPages: false,
});

export function createDocState(init: {
  name: string;
  bytes: Uint8Array;
  pages: PageInfo[];
  id?: DocId;
  fileId?: string | null;
  meta?: DocMeta;
  outline?: OutlineItem[] | null;
  security?: SecuritySettings | null;
  openPassword?: string | null;
  pdf?: DocState['pdf'];
}): DocState {
  const version = nextVersion();
  return {
    id: init.id ?? uid('doc'),
    name: init.name,
    fileId: init.fileId ?? null,
    bytes: init.bytes,
    version,
    pdf: init.pdf ?? null,
    pdfVersion: init.pdf ? version : -1,
    loading: !init.pdf,
    loadError: null,
    pages: init.pages,
    objects: {},
    order: [],
    selection: [],
    editingId: null,
    history: { past: [], future: [] },
    dirty: false,
    view: defaultView(),
    meta: init.meta ?? {},
    outline: init.outline ?? null,
    security: init.security ?? null,
    openPassword: init.openPassword ?? null,
    decorations: {},
    ext: {},
    openedAt: Date.now(),
  };
}

/** Build a new overlay object with id/author/timestamps filled in. */
export function newObject<T extends PdfObject>(
  fields: Omit<T, 'id' | 'author' | 'createdAt' | 'modifiedAt'> & Partial<Pick<T, 'id' | 'author'>>,
): T {
  const now = Date.now();
  return {
    id: uid('obj'),
    author: get().prefs.userName || 'Guest',
    createdAt: now,
    modifiedAt: now,
    ...fields,
  } as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 60;
const COALESCE_MS = 1500;

function snapshotOf(d: DocState, label: string, coalesce?: string): Snapshot {
  return {
    label,
    bytes: d.bytes,
    version: d.version,
    pages: d.pages,
    objects: d.objects,
    order: d.order,
    meta: d.meta,
    outline: d.outline,
    coalesce,
    time: Date.now(),
  };
}

function patchDoc(id: DocId, fn: (d: DocState) => Partial<DocState> | null | undefined) {
  set((s) => {
    const d = s.docs[id];
    if (!d) return s;
    const patch = fn(d);
    if (!patch) return s;
    return { docs: { ...s.docs, [id]: { ...d, ...patch } } };
  });
}

/** Returns the history after pushing a checkpoint of `d` (or unchanged if coalesced). */
function pushed(d: DocState, label: string, coalesce?: string): DocState['history'] {
  const last = d.history.past[d.history.past.length - 1];
  if (coalesce && last && last.coalesce === coalesce && Date.now() - last.time < COALESCE_MS) {
    // Refresh the timestamp so continuous interactions keep coalescing.
    const past = d.history.past.slice(0, -1).concat({ ...last, time: Date.now() });
    return { past, future: [] };
  }
  const past = d.history.past.concat(snapshotOf(d, label, coalesce));
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [] };
}

function restore(d: DocState, s: Snapshot): Partial<DocState> {
  const pageIds = new Set(s.pages.map((p) => p.id));
  return {
    bytes: s.bytes,
    version: s.version,
    pages: s.pages,
    objects: s.objects,
    order: s.order,
    meta: s.meta,
    outline: s.outline,
    selection: d.selection.filter((id) => s.objects[id]),
    editingId: null,
    dirty: true,
    view: { ...d.view, currentPage: clamp(d.view.currentPage, 0, Math.max(0, s.pages.length - 1)) },
    decorations: Object.fromEntries(
      Object.entries(d.decorations).map(([k, v]) => [k, v.filter((x) => pageIds.has(x.pageId))]),
    ),
  };
}

let nonceCounter = 0;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.4, 8];
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export const actions = {
  // ── documents ────────────────────────────────────────────────────────────
  addDocument(doc: DocState, opts: { activate?: boolean } = {}) {
    set((s) => ({
      docs: { ...s.docs, [doc.id]: doc },
      tabs: s.tabs.includes(doc.id) ? s.tabs : [...s.tabs, doc.id],
      ...(opts.activate !== false
        ? { activeDocId: doc.id, route: 'document' as RouteName, activeToolId: 'select' }
        : {}),
    }));
  },

  /** Removes the document without asking. UI should confirm when dirty (see shell). */
  closeDocument(id: DocId) {
    const d = getDoc(id);
    if (!d) return;
    try {
      void d.pdf?.loadingTask.destroy();
    } catch {
      /* ignore */
    }
    set((s) => {
      const { [id]: _, ...docs } = s.docs;
      const idx = s.tabs.indexOf(id);
      const tabs = s.tabs.filter((t) => t !== id);
      let activeDocId = s.activeDocId;
      if (activeDocId === id) activeDocId = tabs[Math.min(idx, tabs.length - 1)] ?? null;
      return {
        docs,
        tabs,
        activeDocId,
        route: activeDocId ? s.route : s.route === 'document' ? 'home' : s.route,
        activeTaskId: activeDocId ? s.activeTaskId : null,
      };
    });
  },

  setActiveDoc(id: DocId) {
    if (!getDoc(id)) return;
    set({ activeDocId: id, route: 'document' });
  },

  reorderTabs(tabs: DocId[]) {
    set({ tabs });
  },

  /** Low-level patch; does NOT push history. */
  updateDoc(id: DocId, patch: Partial<DocState> | ((d: DocState) => Partial<DocState>)) {
    patchDoc(id, (d) => (typeof patch === 'function' ? patch(d) : patch));
  },

  markSaved(id: DocId, fileId?: string | null) {
    patchDoc(id, () => ({ dirty: false, ...(fileId !== undefined ? { fileId } : {}) }));
  },

  rename(id: DocId, name: string) {
    patchDoc(id, () => ({ name }));
  },

  // ── base bytes (page content) ────────────────────────────────────────────
  /**
   * Replace the base PDF bytes (after a page operation / bake). Pushes an undo checkpoint.
   * Objects whose page no longer exists are dropped unless `objects` is given explicitly.
   */
  commitBytes(
    id: DocId,
    next: {
      bytes: Uint8Array;
      pages: PageInfo[];
      label: string;
      objects?: Record<ObjectId, PdfObject>;
      order?: ObjectId[];
      meta?: DocMeta;
      outline?: OutlineItem[] | null;
    },
  ) {
    patchDoc(id, (d) => {
      const pageIds = new Set(next.pages.map((p) => p.id));
      const objects =
        next.objects ?? Object.fromEntries(Object.entries(d.objects).filter(([, o]) => pageIds.has(o.pageId)));
      const order = next.order ?? d.order.filter((oid) => objects[oid]);
      return {
        history: pushed(d, next.label),
        bytes: next.bytes,
        version: nextVersion(),
        pages: next.pages,
        objects,
        order,
        meta: next.meta ?? d.meta,
        outline: next.outline !== undefined ? next.outline : d.outline,
        selection: d.selection.filter((s) => objects[s]),
        editingId: null,
        dirty: true,
        view: { ...d.view, currentPage: clamp(d.view.currentPage, 0, Math.max(0, next.pages.length - 1)) },
        decorations: Object.fromEntries(
          Object.entries(d.decorations).map(([k, v]) => [k, v.filter((x) => pageIds.has(x.pageId))]),
        ),
      };
    });
  },

  /** Update metadata / outline with undo support. */
  setMeta(id: DocId, meta: Partial<DocMeta>, label = 'Edit properties') {
    patchDoc(id, (d) => ({ history: pushed(d, label), meta: { ...d.meta, ...meta }, dirty: true }));
  },
  setOutline(id: DocId, outline: OutlineItem[] | null, label = 'Edit bookmarks') {
    patchDoc(id, (d) => ({ history: pushed(d, label, 'outline'), outline, dirty: true }));
  },
  setSecurity(id: DocId, security: SecuritySettings | null) {
    patchDoc(id, () => ({ security, dirty: true }));
  },

  // ── history ──────────────────────────────────────────────────────────────
  /** Push an undo checkpoint of the current state (call before a multi-step change, e.g. drag start). */
  checkpoint(id: DocId, label: string, coalesce?: string) {
    patchDoc(id, (d) => ({ history: pushed(d, label, coalesce) }));
  },

  undo(id: DocId | null = get().activeDocId) {
    if (!id) return;
    patchDoc(id, (d) => {
      const prev = d.history.past[d.history.past.length - 1];
      if (!prev) return null;
      return {
        ...restore(d, prev),
        history: { past: d.history.past.slice(0, -1), future: [snapshotOf(d, prev.label), ...d.history.future] },
      };
    });
  },

  redo(id: DocId | null = get().activeDocId) {
    if (!id) return;
    patchDoc(id, (d) => {
      const next = d.history.future[0];
      if (!next) return null;
      return {
        ...restore(d, next),
        history: { past: [...d.history.past, snapshotOf(d, next.label)], future: d.history.future.slice(1) },
      };
    });
  },

  // ── overlay objects ──────────────────────────────────────────────────────
  addObject(
    id: DocId,
    obj: PdfObject,
    opts: { select?: boolean; edit?: boolean; checkpoint?: boolean; label?: string } = {},
  ) {
    actions.addObjects(id, [obj], opts);
  },

  addObjects(
    id: DocId,
    objs: PdfObject[],
    opts: { select?: boolean; edit?: boolean; checkpoint?: boolean; label?: string } = {},
  ) {
    if (objs.length === 0) return;
    patchDoc(id, (d) => {
      const objects = { ...d.objects };
      for (const o of objs) objects[o.id] = o;
      const newIds = objs.map((o) => o.id);
      return {
        history: opts.checkpoint === false ? d.history : pushed(d, opts.label ?? `Add ${reg.objectType(objs[0].kind)?.label ?? 'object'}`),
        objects,
        order: [...d.order.filter((x) => !newIds.includes(x)), ...newIds],
        selection: opts.select ? newIds : d.selection,
        editingId: opts.edit ? newIds[0] : d.editingId,
        dirty: true,
      };
    });
  },

  updateObject(id: DocId, objectId: ObjectId, patch: Partial<PdfObject>, opts: UpdateOptions = {}) {
    actions.updateObjects(id, { [objectId]: patch }, opts);
  },

  updateObjects(id: DocId, patches: Record<ObjectId, Partial<PdfObject>>, opts: UpdateOptions = {}) {
    patchDoc(id, (d) => {
      const objects = { ...d.objects };
      let changed = false;
      const now = Date.now();
      for (const [oid, p] of Object.entries(patches)) {
        const o = objects[oid];
        if (!o) continue;
        objects[oid] = { ...o, ...p, data: p.data !== undefined ? p.data : o.data, modifiedAt: now };
        changed = true;
      }
      if (!changed) return null;
      return {
        history: opts.checkpoint === false ? d.history : pushed(d, opts.label ?? 'Edit', opts.coalesce),
        objects,
        dirty: true,
      };
    });
  },

  deleteObjects(id: DocId, ids: ObjectId[], opts: { checkpoint?: boolean; label?: string } = {}) {
    if (ids.length === 0) return;
    patchDoc(id, (d) => {
      const objects = { ...d.objects };
      for (const oid of ids) delete objects[oid];
      return {
        history: opts.checkpoint === false ? d.history : pushed(d, opts.label ?? 'Delete'),
        objects,
        order: d.order.filter((x) => objects[x]),
        selection: d.selection.filter((x) => objects[x]),
        editingId: d.editingId && objects[d.editingId] ? d.editingId : null,
        dirty: true,
      };
    });
  },

  setSelection(id: DocId, ids: ObjectId[]) {
    patchDoc(id, (d) => {
      const same = ids.length === d.selection.length && ids.every((x, i) => x === d.selection[i]);
      return same ? null : { selection: ids, editingId: d.editingId && ids.includes(d.editingId) ? d.editingId : null };
    });
  },

  setEditing(id: DocId, objectId: ObjectId | null) {
    patchDoc(id, (d) => (d.editingId === objectId ? null : { editingId: objectId, selection: objectId ? [objectId] : d.selection }));
  },

  bringToFront(id: DocId, ids: ObjectId[]) {
    patchDoc(id, (d) => ({ history: pushed(d, 'Bring to front'), order: [...d.order.filter((x) => !ids.includes(x)), ...ids] }));
  },

  sendToBack(id: DocId, ids: ObjectId[]) {
    patchDoc(id, (d) => ({ history: pushed(d, 'Send to back'), order: [...ids, ...d.order.filter((x) => !ids.includes(x))] }));
  },

  // ── view ─────────────────────────────────────────────────────────────────
  setView(id: DocId, patch: Partial<ViewState>) {
    patchDoc(id, (d) => ({ view: { ...d.view, ...patch } }));
  },

  setZoom(id: DocId, zoom: number, fit: FitMode = null) {
    patchDoc(id, (d) => ({ view: { ...d.view, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), fit } }));
  },

  zoomIn(id: DocId | null = get().activeDocId) {
    const d = getDoc(id);
    if (!d) return;
    const z = ZOOM_STEPS.find((s) => s > d.view.zoom + 1e-3) ?? MAX_ZOOM;
    actions.setZoom(d.id, z);
  },

  zoomOut(id: DocId | null = get().activeDocId) {
    const d = getDoc(id);
    if (!d) return;
    const z = [...ZOOM_STEPS].reverse().find((s) => s < d.view.zoom - 1e-3) ?? MIN_ZOOM;
    actions.setZoom(d.id, z);
  },

  fit(id: DocId | null, fit: Exclude<FitMode, null>) {
    const d = getDoc(id ?? get().activeDocId);
    if (!d) return;
    patchDoc(d.id, (dd) => ({ view: { ...dd.view, fit } }));
  },

  rotateView(id: DocId | null, delta: 90 | -90) {
    const d = getDoc(id ?? get().activeDocId);
    if (!d) return;
    const rotation = (((d.view.rotation + delta) % 360) + 360) % 360;
    actions.setView(d.id, { rotation: rotation as ViewState['rotation'] });
  },

  /** Scroll the viewer to a page (and optionally a point/rect on it). */
  goToPage(id: DocId | null, pageIndex: number, opts: { point?: Point; rect?: Rect; behavior?: 'auto' | 'smooth' } = {}) {
    const d = getDoc(id ?? get().activeDocId);
    if (!d || d.pages.length === 0) return;
    const idx = clamp(Math.round(pageIndex), 0, d.pages.length - 1);
    actions.setView(d.id, {
      currentPage: idx,
      scrollRequest: { pageIndex: idx, point: opts.point, rect: opts.rect, behavior: opts.behavior, nonce: ++nonceCounter },
    });
  },

  setDecorations(id: DocId, key: string, decorations: Decoration[] | null) {
    patchDoc(id, (d) => {
      const next = { ...d.decorations };
      if (!decorations || decorations.length === 0) delete next[key];
      else next[key] = decorations;
      return { decorations: next };
    });
  },

  /** Per-feature scratch state on a document (not in undo history). */
  setExt<T>(id: DocId, key: string, value: T | ((prev: T | undefined) => T)) {
    patchDoc(id, (d) => ({
      ext: {
        ...d.ext,
        [key]: typeof value === 'function' ? (value as (p: T | undefined) => T)(d.ext[key] as T | undefined) : value,
      },
    }));
  },

  // ── navigation / tools ───────────────────────────────────────────────────
  setRoute(route: RouteName) {
    set({ route });
  },

  /** Open an "All tools" task (or close with null). */
  openTask(taskId: string | null) {
    const prev = get().activeTaskId;
    if (prev === taskId) return;
    if (prev) reg.task(prev)?.onClose?.();
    const task = taskId ? reg.task(taskId) : undefined;
    set((s) => ({
      activeTaskId: taskId,
      leftPanelOpen: taskId ? true : s.leftPanelOpen,
      route: task && !task.requiresDocument && !s.activeDocId ? 'task' : s.activeDocId ? 'document' : s.route,
      activeToolId: 'select',
    }));
    task?.onOpen?.();
  },

  setLeftPanelOpen(open: boolean) {
    set({ leftPanelOpen: open });
  },

  setRightPanel(panelId: string | null) {
    set({ rightPanelId: panelId });
  },

  toggleRightPanel(panelId: string) {
    set((s) => ({ rightPanelId: s.rightPanelId === panelId ? null : panelId }));
  },

  setTool(toolId: string) {
    const prev = get().activeToolId;
    if (prev === toolId) return;
    reg.tool(prev)?.onDeactivate?.();
    set({ activeToolId: toolId });
    reg.tool(toolId)?.onActivate?.();
    const d = getActiveDoc();
    if (d && toolId !== 'select' && d.selection.length) actions.setSelection(d.id, []);
  },

  /** Called by one-shot tools after they create an object. */
  toolDone() {
    const s = get();
    const tool = reg.tool(s.activeToolId);
    if (tool?.oneShot && !s.toolLocked) actions.setTool('select');
  },

  setToolLocked(locked: boolean) {
    set({ toolLocked: locked });
  },

  setToolOption(toolId: string, key: string, value: unknown) {
    set((s) => ({ toolOptions: { ...s.toolOptions, [toolId]: { ...(s.toolOptions[toolId] ?? {}), [key]: value } } }));
  },

  setPrefs(patch: Partial<Prefs>) {
    set((s) => ({ prefs: { ...s.prefs, ...patch } }));
  },

  // ── modals / toasts / busy ───────────────────────────────────────────────
  /**
   * Show a modal. `render(close)` returns the dialog element (use <Modal> from core/ui).
   * Resolves with the value passed to close(), or undefined if dismissed.
   */
  openModal<T = unknown>(render: (close: (result?: T) => void) => ReactNode, opts: { dismissable?: boolean } = {}): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const id = uid('modal');
      const close = (result?: unknown) => {
        set((s) => ({ modals: s.modals.filter((m) => m.id !== id) }));
        resolve(result as T | undefined);
      };
      const entry: ModalEntry = {
        id,
        render: () => render(close as (r?: T) => void),
        resolve: close,
        dismissable: opts.dismissable !== false,
      };
      set((s) => ({ modals: [...s.modals, entry] }));
    });
  },

  closeTopModal() {
    const m = get().modals[get().modals.length - 1];
    if (m?.dismissable) m.resolve(undefined);
  },

  toast(message: string, opts: Partial<Omit<Toast, 'id' | 'message'>> = {}) {
    const t: Toast = { id: uid('toast'), message, kind: opts.kind ?? 'info', action: opts.action, duration: opts.duration ?? (opts.kind === 'error' ? 7000 : 3500) };
    set((s) => ({ toasts: [...s.toasts.slice(-4), t] }));
    if (t.duration > 0) setTimeout(() => actions.dismissToast(t.id), t.duration);
    return t.id;
  },

  dismissToast(id: string) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setBusy(busy: BusyState | null) {
    set({ busy });
  },

  /**
   * Run an async job behind a blocking progress overlay. Errors are shown as a toast and rethrown
   * only if `rethrow` is set. `report(p)` updates progress (0..1).
   */
  async withBusy<T>(label: string, fn: (report: (p: number | null, label?: string) => void) => Promise<T>, opts: { rethrow?: boolean } = {}): Promise<T | undefined> {
    set({ busy: { label, progress: null } });
    try {
      return await fn((progress, l) => set((s) => ({ busy: s.busy ? { ...s.busy, progress, label: l ?? s.busy.label } : s.busy })));
    } catch (e) {
      console.error(e);
      actions.toast(e instanceof Error ? e.message : String(e), { kind: 'error' });
      if (opts.rethrow) throw e;
      return undefined;
    } finally {
      set({ busy: null });
    }
  },
};

export type Actions = typeof actions;

// Dev convenience
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__app = { useApp, actions, getActiveDoc, reg };
}
