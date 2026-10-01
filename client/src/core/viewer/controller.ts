/**
 * Per-viewer imperative context shared by DocumentViewer, its pages and the interaction code.
 * Holds the latest layout / scroll element so event handlers never read stale React state.
 */
import type { PageViewport } from 'pdfjs-dist';
import type { DocId, PageInfo, Point, ViewBox } from '../types';
import { getDoc } from '../store';
import type { Layout, Slot } from './layout';
import { makeViewport } from './viewport';
import type { PageRenderer } from './pageRenderer';

export type AnchorMode = { mode: 'pointer'; x: number; y: number } | { mode: 'center' } | { mode: 'top' };

const controllers = new Map<DocId, Set<ViewerController>>();

export class ViewerController {
  root: HTMLDivElement | null = null;
  scroller: HTMLDivElement | null = null;
  sizer: HTMLDivElement | null = null;
  layout: Layout | null = null;
  /** Scroll position last observed (before any DOM change clamps it). */
  scrollTop = 0;
  scrollLeft = 0;
  /** Anchor to use for the next layout change (set by wheel / pinch zoom). */
  pendingAnchor: AnchorMode | null = null;
  readonly renderers = new Map<string, PageRenderer>();
  readonly listeners = new Set<() => void>();

  constructor(public docId: DocId) {}

  attach() {
    let set = controllers.get(this.docId);
    if (!set) controllers.set(this.docId, (set = new Set()));
    set.add(this);
  }

  detach() {
    const set = controllers.get(this.docId);
    set?.delete(this);
    if (set && set.size === 0) controllers.delete(this.docId);
  }

  get viewportRect(): ViewBox {
    const s = this.scroller;
    return {
      left: this.scrollLeft,
      top: this.scrollTop,
      width: s?.clientWidth ?? 0,
      height: s?.clientHeight ?? 0,
    };
  }

  slot(pageIndex: number): Slot | undefined {
    return this.layout?.slots[pageIndex];
  }

  page(pageIndex: number): PageInfo | undefined {
    return getDoc(this.docId)?.pages[pageIndex];
  }

  viewport(pageIndex: number): PageViewport | null {
    const page = this.page(pageIndex);
    const slot = this.slot(pageIndex);
    const layout = this.layout;
    if (!page || !slot || !layout) return null;
    return makeViewport(page, layout.zoom, slot.rotation);
  }

  pageElement(pageIndex: number): HTMLElement | null {
    return (this.sizer?.querySelector(`.pdfwizard-page[data-page-index="${pageIndex}"]`) as HTMLElement | null) ?? null;
  }

  /** Client (screen) point → CSS px relative to the page's top-left. */
  clientToPage(pageIndex: number, clientX: number, clientY: number): { x: number; y: number } | null {
    const el = this.pageElement(pageIndex);
    if (el) {
      const r = el.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    }
    const slot = this.slot(pageIndex);
    const s = this.scroller;
    if (!slot || !s) return null;
    const sr = s.getBoundingClientRect();
    return { x: clientX - sr.left + s.scrollLeft - slot.left, y: clientY - sr.top + s.scrollTop - slot.top };
  }

  clientToPdf(pageIndex: number, clientX: number, clientY: number): Point | null {
    const vp = this.viewport(pageIndex);
    const p = this.clientToPage(pageIndex, clientX, clientY);
    if (!vp || !p) return null;
    const [x, y] = vp.convertToPdfPoint(p.x, p.y);
    return { x, y };
  }

  /** Render priority: visible pages first (closest to the viewport center), then neighbours. */
  pagePriority(pageIndex: number): number {
    const slot = this.slot(pageIndex);
    if (!slot) return 1e9;
    const v = this.viewportRect;
    const cy = v.top + v.height / 2;
    const cx = v.left + v.width / 2;
    const visible = slot.top < v.top + v.height && slot.top + slot.height > v.top;
    const dy = Math.max(0, Math.abs(slot.top + slot.height / 2 - cy) - slot.height / 2);
    const dx = Math.abs(slot.left + slot.width / 2 - cx) / 100;
    return (visible ? 0 : 1e6) + dy + dx;
  }

  /** Visible part of a page in page-local CSS px, or null when off screen. */
  visiblePageRect(pageIndex: number): ViewBox | null {
    const slot = this.slot(pageIndex);
    if (!slot) return null;
    const v = this.viewportRect;
    const left = Math.max(v.left, slot.left);
    const top = Math.max(v.top, slot.top);
    const right = Math.min(v.left + v.width, slot.left + slot.width);
    const bottom = Math.min(v.top + v.height, slot.top + slot.height);
    if (right <= left || bottom <= top) return null;
    return { left: left - slot.left, top: top - slot.top, width: right - left, height: bottom - top };
  }

  registerRenderer(pageId: string, r: PageRenderer | null) {
    if (r) this.renderers.set(pageId, r);
    else this.renderers.delete(pageId);
  }

  notify() {
    this.listeners.forEach((l) => l());
  }
}

/** The mounted controller for a document (the most recently attached one). */
export function controllerFor(docId: DocId): ViewerController | null {
  const set = controllers.get(docId);
  if (!set || set.size === 0) return null;
  let last: ViewerController | null = null;
  for (const c of set) last = c;
  return last;
}
