/**
 * Bookmark destinations beyond the core model (page + top):
 *  - reads the full destination (fit mode, left, zoom) of imported bookmarks,
 *  - navigates to a destination like desktop viewers do,
 *  - captures the current view as a destination,
 *  - export hook (after core-outline) that rewrites /Dest with the full destination and the
 *    /Count signs with the panel's expansion state.
 */
import { PDFArray, PDFName, PDFNull, PDFNumber, type PDFContext, type PDFObject } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId, DocState, ExportHook, OutlineItem } from '@/core/types';
import { actions, getDoc, pageIndexOf, useApp } from '@/core/store';
import { controllerFor } from '@/core/viewer/controller';
import { N, lookup, lookupDict } from '@/core/engine/lib';
import { outlineEdited } from '@/core/engine/hooks';
import type { BmItem, DestMode, NavDest } from './model';

/** Destinations read from the file, keyed by outline item id (ids are unique per session). */
const importedDests = new Map<string, NavDest>();

export function destOf(item: BmItem): NavDest | null {
  if (item.navDest !== undefined) return item.navDest;
  return importedDests.get(item.id) ?? null;
}

const MODES: DestMode[] = ['XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV'];
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse an explicit pdf.js destination array into a NavDest. */
export function parseDestArray(d: unknown): NavDest | null {
  if (!Array.isArray(d) || d.length < 2) return null;
  const name = (d[1] as { name?: string } | undefined)?.name as DestMode | undefined;
  if (!name || !MODES.includes(name)) return null;
  const a = d.slice(2);
  switch (name) {
    case 'XYZ':
      return { mode: 'XYZ', left: num(a[0]), zoom: num(a[2]) };
    case 'FitV':
    case 'FitBV':
      return { mode: name, left: num(a[0]) };
    case 'FitR':
      return { mode: 'FitR', left: num(a[0]), bottom: num(a[1]), right: num(a[2]) };
    default:
      return { mode: name };
  }
}

interface JsNode {
  dest: string | unknown[] | null;
  items?: JsNode[];
  title?: string;
}

async function readImportedDests(pdf: PDFDocumentProxy, outline: OutlineItem[]) {
  let nodes: JsNode[] | null = null;
  try {
    nodes = (await pdf.getOutline()) as unknown as JsNode[] | null;
  } catch {
    return;
  }
  if (!nodes?.length) return;
  const walk = async (list: JsNode[], items: OutlineItem[], depth: number) => {
    if (depth > 64) return;
    for (let i = 0; i < Math.min(list.length, items.length); i++) {
      const n = list[i];
      const it = items[i];
      if ((n.title ?? '') !== it.title) continue;
      let d: unknown = n.dest;
      try {
        if (typeof d === 'string') d = await pdf.getDestination(d);
      } catch {
        d = null;
      }
      const dest = parseDestArray(d);
      if (dest && !isDefaultDest(dest)) importedDests.set(it.id, dest);
      if (n.items?.length && it.children?.length) await walk(n.items, it.children, depth + 1);
    }
  };
  await walk(nodes, outline, 0);
}

/** Watch for newly opened documents and remember their bookmarks' full destinations. */
export function startDestTracking() {
  const seen = new Set<DocId>();
  const scan = (docs: Record<DocId, DocState>) => {
    for (const d of Object.values(docs)) {
      // Wait for the proxy: a document is added to the store before pdf.js has loaded it.
      if (seen.has(d.id) || !d.pdf) continue;
      seen.add(d.id);
      if (d.outline?.length) void readImportedDests(d.pdf, d.outline);
    }
    for (const id of Array.from(seen)) if (!docs[id]) seen.delete(id);
  };
  scan(useApp.getState().docs);
  useApp.subscribe((s) => s.docs, scan);
}

export function isDefaultDest(d: NavDest | null | undefined): boolean {
  if (!d) return true;
  return d.mode === 'XYZ' && d.left == null && !d.zoom;
}

export function describeDest(item: BmItem, doc: DocState | undefined): string {
  if (item.url) return item.url;
  if (!item.pageId || !doc) return 'No destination';
  const idx = pageIndexOf(doc, item.pageId);
  if (idx < 0) return 'Destination page was deleted';
  const d = destOf(item);
  const page = `Page ${doc.pages[idx].label ?? idx + 1}`;
  if (!d || d.mode === 'XYZ') return d?.zoom ? `${page}, ${Math.round(d.zoom * 100)}%` : page;
  const labels: Record<DestMode, string> = {
    XYZ: '', Fit: 'Fit page', FitB: 'Fit visible', FitH: 'Fit width', FitBH: 'Fit width', FitV: 'Fit height', FitBV: 'Fit height', FitR: 'Fit rectangle',
  };
  return `${page}, ${labels[d.mode]}`;
}

// ── navigation ───────────────────────────────────────────────────────────────

export function goToBookmark(docId: DocId, item: BmItem) {
  if (item.url) {
    window.open(item.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const doc = getDoc(docId);
  if (!doc || !item.pageId) return;
  const idx = pageIndexOf(doc, item.pageId);
  if (idx < 0) {
    actions.toast('The destination page of this bookmark no longer exists.', { kind: 'warning' });
    return;
  }
  const page = doc.pages[idx];
  const d = destOf(item) ?? { mode: 'XYZ' as const };
  const top = typeof item.top === 'number' && Number.isFinite(item.top) ? item.top : null;
  const x0 = page.view[0];
  const yTop = page.view[3];
  switch (d.mode) {
    case 'Fit':
    case 'FitB':
    case 'FitV':
    case 'FitBV':
      actions.fit(docId, 'page');
      actions.goToPage(docId, idx);
      return;
    case 'FitH':
    case 'FitBH':
      actions.fit(docId, 'width');
      actions.goToPage(docId, idx, { point: { x: x0, y: top ?? yTop } });
      return;
    case 'FitR': {
      const left = d.left ?? x0;
      const right = d.right ?? page.view[2];
      const bottom = d.bottom ?? page.view[1];
      const t = top ?? yTop;
      const rect = { x: Math.min(left, right), y: Math.min(bottom, t), width: Math.abs(right - left), height: Math.abs(t - bottom) };
      const scroller = controllerFor(docId)?.scroller;
      if (scroller && rect.width > 1 && rect.height > 1) {
        const rot = (page.rotation + doc.view.rotation) % 180 !== 0;
        const w = rot ? rect.height : rect.width;
        const h = rot ? rect.width : rect.height;
        actions.setZoom(docId, Math.min((scroller.clientWidth - 24) / w, (scroller.clientHeight - 24) / h));
      }
      actions.goToPage(docId, idx, { rect });
      return;
    }
    default: {
      if (d.zoom && d.zoom > 0) actions.setZoom(docId, d.zoom);
      actions.goToPage(docId, idx, { point: { x: d.left ?? x0, y: top ?? yTop } });
    }
  }
}

/** The current view of the document as a bookmark destination. */
export function currentViewDest(docId: DocId): Pick<BmItem, 'pageId' | 'top' | 'navDest'> | null {
  const doc = getDoc(docId);
  if (!doc || !doc.pages.length) return null;
  const idx = Math.min(Math.max(0, doc.view.currentPage), doc.pages.length - 1);
  const page = doc.pages[idx];
  const ctrl = controllerFor(docId);
  const vp = ctrl?.viewport(idx);
  const vr = ctrl?.visiblePageRect(idx);
  let top: number | null = null;
  let left: number | null = null;
  if (vp && vr) {
    const [x, y] = vp.convertToPdfPoint(vr.left, vr.top) as [number, number];
    top = Math.round(y * 100) / 100;
    left = vr.left > 1 ? Math.round(x * 100) / 100 : null;
    // At the very top of the page: a page-level destination.
    if (vr.top <= 1) top = null;
  }
  const fit = doc.view.fit;
  if (fit === 'page') return { pageId: page.id, top: null, navDest: { mode: 'Fit' } };
  if (fit === 'width') return { pageId: page.id, top: top ?? page.view[3], navDest: { mode: 'FitH' } };
  return { pageId: page.id, top: top ?? page.view[3], navDest: { mode: 'XYZ', left, zoom: Math.round(doc.view.zoom * 1000) / 1000 } };
}

// ── export ───────────────────────────────────────────────────────────────────

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** UI expansion overrides provider (set by the panel store; avoids an import cycle). */
let expansionOf: (docId: DocId) => Record<string, boolean> | undefined = () => undefined;
export function setExpansionProvider(fn: typeof expansionOf) {
  expansionOf = fn;
}

function destArray(ctx: PDFContext, pageRef: PDFObject, d: NavDest, top: number | null): PDFArray {
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? PDFNumber.of(r3(v)) : PDFNull);
  const a = PDFArray.withContext(ctx);
  a.push(pageRef);
  a.push(PDFName.of(d.mode));
  switch (d.mode) {
    case 'XYZ':
      a.push(n(d.left));
      a.push(n(top));
      a.push(d.zoom && d.zoom > 0 ? PDFNumber.of(r3(d.zoom)) : PDFNull);
      break;
    case 'FitH':
    case 'FitBH':
      a.push(n(top));
      break;
    case 'FitV':
    case 'FitBV':
      a.push(n(d.left));
      break;
    case 'FitR':
      a.push(n(d.left));
      a.push(n(d.bottom));
      a.push(n(d.right));
      a.push(n(top));
      break;
    default:
      break;
  }
  return a;
}

export const bookmarkDestHook: ExportHook = {
  id: 'navigation-bookmark-dests',
  order: 110,
  // [lead] only writes what doc.meta / doc.outline hold, which are then unchanged.
  noopWhenUnchanged: true,
  run(ctx) {
    const { purpose } = ctx.options;
    if (purpose === 'print' || purpose === 'bake') return;
    const doc = ctx.doc;
    if (!outlineEdited(doc) || !doc.outline?.length) return;
    const lib = ctx.pdfDoc;
    const pctx = lib.context;
    const root = lookupDict(pctx, lib.catalog.get(N('Outlines')));
    if (!root) return;
    const overrides = expansionOf(doc.id) ?? {};
    const isOpen = (it: OutlineItem) => overrides[it.id] ?? !!it.open;
    const visible = (it: OutlineItem): number => {
      let c = 0;
      for (const k of it.children ?? []) c += 1 + (isOpen(k) ? visible(k) : 0);
      return c;
    };
    const walk = (first: PDFObject | undefined, items: OutlineItem[], depth: number) => {
      let cur = lookupDict(pctx, first);
      let i = 0;
      while (cur && i < items.length && depth < 64) {
        const it = items[i] as BmItem;
        const kids = it.children ?? [];
        if (kids.length) {
          const n = visible(it);
          cur.set(N('Count'), PDFNumber.of(isOpen(it) ? n : -n));
          walk(cur.get(N('First')), kids, depth + 1);
        }
        const d = destOf(it);
        if (!it.url && d && !isDefaultDest(d)) {
          const old = lookup(pctx, cur.get(N('Dest')));
          const pageRef = old instanceof PDFArray && old.size() > 0 ? old.get(0) : undefined;
          if (pageRef) {
            const top = typeof it.top === 'number' && Number.isFinite(it.top) ? it.top : null;
            cur.set(N('Dest'), destArray(pctx, pageRef, d, top));
          }
        }
        cur = lookupDict(pctx, cur.get(N('Next')));
        i++;
      }
    };
    walk(root.get(N('First')), doc.outline, 0);
    let total = 0;
    for (const it of doc.outline) total += 1 + (isOpen(it) ? visible(it) : 0);
    root.set(N('Count'), PDFNumber.of(total));
  },
};
