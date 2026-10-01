/**
 * Document Properties → Initial View: catalog /PageLayout, /PageMode, /OpenAction and
 * /ViewerPreferences. Read with pdf.js, written by an export hook when edited (stored in
 * doc.meta.navInitialView so it's undoable), and honored when a document is opened.
 */
import { PDFArray, PDFBool, PDFDict, PDFNull, PDFNumber, type PDFObject } from '@cantoo/pdf-lib';
import type { DocId, DocMeta, DocState, ExportHook, ImportHook } from '@/core/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as engine from '@/core/engine';
import { N, lookup, lookupDict } from '@/core/engine/lib';
import { reg } from '@/core/registry';
import { actions, getDoc, useApp } from '@/core/store';
import { LAYERS_PANEL_ID, ensureLayersPanel } from '../layers/LayersPanel';

export type LayoutName = 'default' | 'SinglePage' | 'OneColumn' | 'TwoPageLeft' | 'TwoColumnLeft' | 'TwoPageRight' | 'TwoColumnRight';
export type PageModeName = 'UseNone' | 'UseOutlines' | 'UseThumbs' | 'UseAttachments' | 'UseOC';
export type Magnification = 'default' | 'actual' | 'fit' | 'fitWidth' | 'fitHeight' | 'fitVisible' | number;

export interface InitialView {
  layout: LayoutName;
  pageMode: PageModeName;
  fullScreen: boolean;
  /** 1-based page to open at. */
  openPage: number;
  magnification: Magnification;
  fitWindow: boolean;
  centerWindow: boolean;
  displayDocTitle: boolean;
  hideMenubar: boolean;
  hideToolbar: boolean;
  hideWindowUI: boolean;
  /** Existing /OpenAction is an action dictionary (JavaScript, named action…): keep it unless page / zoom change. */
  openActionIsAction?: boolean;
}

export type NavMeta = DocMeta & { navInitialView?: InitialView; navCustom?: Record<string, string> };

export const DEFAULT_VIEW: InitialView = {
  layout: 'default',
  pageMode: 'UseNone',
  fullScreen: false,
  openPage: 1,
  magnification: 'default',
  fitWindow: false,
  centerWindow: false,
  displayDocTitle: false,
  hideMenubar: false,
  hideToolbar: false,
  hideWindowUI: false,
};

const LAYOUTS = new Set<LayoutName>(['SinglePage', 'OneColumn', 'TwoPageLeft', 'TwoColumnLeft', 'TwoPageRight', 'TwoColumnRight']);
const MODES = new Set<PageModeName>(['UseNone', 'UseOutlines', 'UseThumbs', 'UseAttachments', 'UseOC']);

/** Plain object from a pdf.js Map-or-object return value. */
function plain(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (v instanceof Map) return Object.fromEntries(v.entries());
  if (typeof v === 'object') return v as Record<string, unknown>;
  return {};
}

const cache = new WeakMap<object, Promise<InitialView>>();

/** The initial view stored in the document the pdf.js proxy was loaded from. */
export function readInitialView(docId: DocId): Promise<InitialView> {
  return engine.awaitPdf(docId).then(readFromProxy);
}

function readFromProxy(pdf: PDFDocumentProxy): Promise<InitialView> {
  let job = cache.get(pdf);
  if (!job) {
    job = (async () => {
      const v: InitialView = { ...DEFAULT_VIEW };
      // One round trip to the worker: the panel is applied before the first paint when possible.
      const [layout, mode, rawPrefs, rawOpen] = await Promise.all([
        pdf.getPageLayout().catch(() => ''),
        pdf.getPageMode().catch(() => 'UseNone'),
        pdf.getViewerPreferences().catch(() => null),
        pdf.getOpenAction().catch(() => null),
      ]);
      if (LAYOUTS.has(layout as LayoutName)) v.layout = layout as LayoutName;
      const prefs = plain(rawPrefs);
      if (mode === 'FullScreen') {
        v.fullScreen = true;
        const nf = prefs.NonFullScreenPageMode as string | undefined;
        if (nf && MODES.has(nf as PageModeName)) v.pageMode = nf as PageModeName;
      } else if (MODES.has(mode as PageModeName)) v.pageMode = mode as PageModeName;
      v.fitWindow = !!prefs.FitWindow;
      v.centerWindow = !!prefs.CenterWindow;
      v.displayDocTitle = !!prefs.DisplayDocTitle;
      v.hideMenubar = !!prefs.HideMenubar;
      v.hideToolbar = !!prefs.HideToolbar;
      v.hideWindowUI = !!prefs.HideWindowUI;
      const open = plain(rawOpen);
      const dest = open.dest as unknown[] | undefined;
      if (Array.isArray(dest) && dest.length) {
        const target = dest[0];
        let idx = -1;
        if (typeof target === 'number') idx = target;
        else if (target && typeof target === 'object') idx = await pdf.getPageIndex(target as { num: number; gen: number }).catch(() => -1);
        if (idx >= 0) v.openPage = idx + 1;
        const kind = (dest[1] as { name?: string } | undefined)?.name;
        if (kind === 'XYZ') {
          const z = dest[4];
          if (typeof z === 'number' && z > 0) v.magnification = Math.abs(z - 1) < 1e-4 ? 'actual' : Math.round(z * 100);
        } else if (kind === 'Fit') v.magnification = 'fit';
        else if (kind === 'FitB') v.magnification = 'fitVisible';
        else if (kind === 'FitH' || kind === 'FitBH') v.magnification = 'fitWidth';
        else if (kind === 'FitV' || kind === 'FitBV') v.magnification = 'fitHeight';
      } else if (open.action) v.openActionIsAction = true;
      return v;
    })();
    cache.set(pdf, job);
  }
  return job;
}

/** Initial views read while a document is being opened (before it's shown), by doc id. */
const prefetched = new Map<DocId, InitialView>();

/**
 * Reads the file's initial view before the document is added, so the panel and page layout it asks
 * for are in place for the viewer's first layout and paint (no visible re-zoom afterwards).
 */
export const initialViewImportHook: ImportHook = {
  id: 'navigation-initial-view-read',
  order: 900,
  async run(ctx) {
    try {
      prefetched.set(ctx.docId, await readFromProxy(ctx.pdf));
    } catch {
      /* read again (asynchronously) once the document is open */
    }
  },
};

/** The initial view to show / write: the edited one if any, else the file's. */
export async function currentInitialView(docId: DocId): Promise<InitialView> {
  const edited = (getDoc(docId)?.meta as NavMeta | undefined)?.navInitialView;
  return edited ?? readInitialView(docId);
}

export function sameView(a: InitialView, b: InitialView): boolean {
  const keys = Object.keys(DEFAULT_VIEW) as (keyof InitialView)[];
  return keys.every((k) => a[k] === b[k]);
}

// ── export ──────────────────────────────────────────────────────────────────

function setFlag(d: PDFDict, key: string, on: boolean) {
  if (on) d.set(N(key), PDFBool.True);
  else d.delete(N(key));
}

function destItems(pageRef: PDFObject, m: Magnification): PDFObject[] {
  const items: PDFObject[] = [pageRef];
  switch (m) {
    case 'fit':
      items.push(N('Fit'));
      break;
    case 'fitVisible':
      items.push(N('FitB'));
      break;
    case 'fitWidth':
      items.push(N('FitH'), PDFNull);
      break;
    case 'fitHeight':
      items.push(N('FitV'), PDFNull);
      break;
    case 'actual':
      items.push(N('XYZ'), PDFNull, PDFNull, PDFNumber.of(1));
      break;
    case 'default':
      items.push(N('XYZ'), PDFNull, PDFNull, PDFNull);
      break;
    default:
      items.push(N('XYZ'), PDFNull, PDFNull, PDFNumber.of(Math.round(m * 10) / 1000));
  }
  return items;
}

export function writeInitialView(ctx: Parameters<ExportHook['run']>[0], v: InitialView) {
  const lib = ctx.pdfDoc;
  const c = lib.context;
  const cat = lib.catalog;
  if (v.layout === 'default') cat.delete(N('PageLayout'));
  else cat.set(N('PageLayout'), N(v.layout));
  if (v.fullScreen) cat.set(N('PageMode'), N('FullScreen'));
  else if (v.pageMode === 'UseNone') cat.delete(N('PageMode'));
  else cat.set(N('PageMode'), N(v.pageMode));

  let prefs = lookupDict(c, cat.get(N('ViewerPreferences')));
  if (!prefs) prefs = c.obj({}) as PDFDict;
  setFlag(prefs, 'FitWindow', v.fitWindow);
  setFlag(prefs, 'CenterWindow', v.centerWindow);
  setFlag(prefs, 'DisplayDocTitle', v.displayDocTitle);
  setFlag(prefs, 'HideMenubar', v.hideMenubar);
  setFlag(prefs, 'HideToolbar', v.hideToolbar);
  setFlag(prefs, 'HideWindowUI', v.hideWindowUI);
  if (v.fullScreen && v.pageMode !== 'UseNone') prefs.set(N('NonFullScreenPageMode'), N(v.pageMode));
  else prefs.delete(N('NonFullScreenPageMode'));
  if (prefs.keys().length) cat.set(N('ViewerPreferences'), prefs);
  else cat.delete(N('ViewerPreferences'));

  const existing = lookup(c, cat.get(N('OpenAction')));
  const keepAction = existing instanceof PDFDict && v.openPage === 1 && v.magnification === 'default';
  if (!keepAction) {
    const pages = ctx.doc.pages;
    const idx = Math.min(Math.max(1, Math.round(v.openPage)), pages.length) - 1;
    if (idx <= 0 && v.magnification === 'default') cat.delete(N('OpenAction'));
    else {
      const page = ctx.page(pages[idx].id);
      const arr = c.obj([]) as PDFArray;
      for (const it of destItems(page.ref, v.magnification)) arr.push(it);
      cat.set(N('OpenAction'), arr);
    }
  }
}

export const initialViewHook: ExportHook = {
  id: 'navigation-initial-view',
  order: 150,
  // [lead] only writes what doc.meta / doc.outline hold, which are then unchanged.
  noopWhenUnchanged: true,
  run(ctx) {
    const { purpose } = ctx.options;
    if (purpose === 'print' || purpose === 'bake') return;
    const v = (ctx.doc.meta as NavMeta).navInitialView;
    if (!v) return;
    writeInitialView(ctx, v);
  },
};

// ── honoring on open ────────────────────────────────────────────────────────

const LAYOUT_TO_VIEW: Record<Exclude<LayoutName, 'default'>, DocState['view']['layout']> = {
  SinglePage: 'single',
  OneColumn: 'continuous',
  TwoPageLeft: 'two-page',
  TwoPageRight: 'two-page',
  TwoColumnLeft: 'two-page-continuous',
  TwoColumnRight: 'two-page-continuous',
};
const MODE_TO_PANEL: Partial<Record<PageModeName, string>> = {
  UseOutlines: 'bookmarks',
  UseThumbs: 'thumbnails',
  UseAttachments: 'attachments',
  UseOC: 'layers',
};

const applied = new Set<DocId>();
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function honor(docId: DocId, panelAtOpen: string | null, pre?: InitialView) {
  let v: InitialView;
  if (pre) v = pre;
  else {
    try {
      await engine.awaitPdf(docId);
      v = await readInitialView(docId);
    } catch {
      return;
    }
  }
  let doc = getDoc(docId);
  if (!doc || useApp.getState().activeDocId !== docId) return;
  // Layout and panel first, usually before the first paint, so the viewer's initial fit already
  // accounts for them (no visible re-zoom once the page has been drawn).
  if (v.layout !== 'default') {
    const layout = LAYOUT_TO_VIEW[v.layout];
    if (layout !== doc.view.layout) actions.setView(docId, { layout });
  }
  const panel = MODE_TO_PANEL[v.pageMode];
  // The Layers panel is registered only once the document's optional content has been read.
  if (panel === LAYERS_PANEL_ID) await ensureLayersPanel(docId);
  // Don't override a panel the user picked while the document was loading.
  const untouched = useApp.getState().rightPanelId === panelAtOpen;
  if (panel && untouched && reg.get().panels[panel] && useApp.getState().activeDocId === docId) {
    if (panel !== 'bookmarks' || doc.outline?.length) actions.setRightPanel(panel);
  }
  // Let the viewer lay out with its initial fit first; then apply the magnification the file asks for.
  await frames();
  doc = getDoc(docId);
  if (!doc || useApp.getState().activeDocId !== docId) return;
  const m = v.magnification;
  if (m === 'fit' || m === 'fitVisible' || m === 'fitHeight') actions.fit(docId, 'page');
  else if (m === 'fitWidth') actions.fit(docId, 'width');
  else if (m === 'actual') actions.setZoom(docId, 1);
  else if (typeof m === 'number' && m > 0) actions.setZoom(docId, m / 100);
  if (v.openPage > 1 && v.openPage <= doc.pages.length) {
    await frames();
    actions.goToPage(docId, v.openPage - 1, { behavior: 'auto' });
  }
}

let started = false;
export function startInitialView() {
  if (started) return;
  started = true;
  useApp.subscribe((s, p) => {
    if (s.docs === p.docs) return;
    for (const id of Object.keys(s.docs)) {
      if (applied.has(id) || p.docs[id]) continue;
      applied.add(id);
      const pre = prefetched.get(id);
      prefetched.delete(id);
      const panelAtOpen = s.rightPanelId;
      // After the store update that added the document has been delivered to every subscriber.
      queueMicrotask(() => void honor(id, panelAtOpen, pre));
    }
    for (const id of applied) if (!s.docs[id]) applied.delete(id);
  });
}

// ── window title (DisplayDocTitle) ─────────────────────────────────────────

let titleObs: MutationObserver | null = null;
export function startDocTitle() {
  if (titleObs || typeof document === 'undefined') return;
  const apply = () => {
    const s = useApp.getState();
    if (s.route !== 'document' || !s.activeDocId) return;
    const d = s.docs[s.activeDocId];
    const title = d?.meta.title?.trim();
    if (!d || !title) return;
    void currentInitialView(d.id)
      .then((v) => {
        if (!v.displayDocTitle) return;
        if (document.title.includes(d.name) && !document.title.includes(title)) document.title = document.title.replace(d.name, title);
      })
      .catch(() => undefined);
  };
  titleObs = new MutationObserver(apply);
  const el = document.querySelector('title');
  if (el) titleObs.observe(el, { childList: true, characterData: true, subtree: true });
  useApp.subscribe((s, p) => {
    if (s.activeDocId !== p.activeDocId || s.route !== p.route) queueMicrotask(apply);
  });
}
