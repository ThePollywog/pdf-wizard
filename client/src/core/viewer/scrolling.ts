/**
 * Scroll management for a DocumentViewer: scroll anchoring across layout changes, scroll requests,
 * current-page tracking (without feedback loops), virtualization range, Ctrl/Cmd+wheel and pinch
 * zoom anchored at the pointer, and page flipping in the paged layouts.
 */
import type { DocId, ScrollRequest } from '../types';
import { actions, getDoc, MAX_ZOOM, MIN_ZOOM } from '../store';
import { rectToView } from '../geometry';
import type { AnchorMode, ViewerController } from './controller';
import { GAP, firstRowBelow, indicesInRange, isPagedMode, mostVisiblePage, spreadOf, type Layout } from './layout';
import { makeViewport } from './viewport';
import { renderQueue } from './renderQueue';
import { viewerUi } from './viewerStore';

/** A position expressed as "this PDF point of this page sits at (x, y) of the viewport". */
export interface ScrollAnchor {
  pageId: string;
  pdf: [number, number];
  x: number;
  y: number;
}

const savedAnchors = new Map<DocId, ScrollAnchor>();
const handledNonces = new Map<DocId, number>();

export function forgetViewerState(docId: DocId) {
  savedAnchors.delete(docId);
  handledNonces.delete(docId);
}

/** Find the page nearest to content point (ax, ay) and express the point in its PDF space. */
export function captureAnchor(layout: Layout, scrollLeft: number, scrollTop: number, x: number, y: number): ScrollAnchor | null {
  const rows = layout.rows;
  if (rows.length === 0) return null;
  const ax = scrollLeft + x;
  const ay = scrollTop + y;
  let r = Math.min(firstRowBelow(rows, ay), rows.length - 1);
  if (r > 0 && ay < rows[r].top) {
    const prev = rows[r - 1];
    if (ay - (prev.top + prev.height) < rows[r].top - ay) r -= 1;
  }
  const row = rows[r];
  let best = -1;
  let bestD = Infinity;
  for (const i of row.indices) {
    const s = layout.slots[i];
    if (!s) continue;
    const d = ax < s.left ? s.left - ax : ax > s.left + s.width ? ax - (s.left + s.width) : 0;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return null;
  const slot = layout.slots[best]!;
  const page = layout.pages[best];
  const vp = makeViewport(page, layout.zoom, slot.rotation);
  const [px, py] = vp.convertToPdfPoint(ax - slot.left, ay - slot.top);
  return { pageId: page.id, pdf: [px, py], x, y };
}

export function resolveAnchor(layout: Layout, a: ScrollAnchor): { left: number; top: number } | null {
  const i = layout.pageIds.indexOf(a.pageId);
  const slot = i >= 0 ? layout.slots[i] : undefined;
  if (!slot) return null;
  const vp = makeViewport(layout.pages[i], layout.zoom, slot.rotation);
  const [vx, vy] = vp.convertToViewportPoint(a.pdf[0], a.pdf[1]);
  return { left: slot.left + vx - a.x, top: slot.top + vy - a.y };
}

interface Programmatic {
  top: number;
  left: number;
  smooth: boolean;
  at: number;
}

const sameArr = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export class ViewerScroll {
  /** Called with the page indices to keep mounted (visible ±1 screen). */
  onRange: ((indices: number[]) => void) | null = null;
  private programmatic: Programmatic | null = null;
  private raf = 0;
  private zoomRaf = 0;
  private zoomFactor = 1;
  private zoomAbs: number | null = null;
  private zoomPt = { x: 0, y: 0 };
  private flipAcc = 0;
  private flipLockUntil = 0;
  private pinch: { d0: number; z0: number } | null = null;
  private gesture: { z0: number } | null = null;
  private range: number[] = [];
  private ac: AbortController | null = null;

  constructor(private readonly ctrl: ViewerController) {}

  get docId() {
    return this.ctrl.docId;
  }

  attach(scroller: HTMLDivElement) {
    this.detach();
    const ac = new AbortController();
    this.ac = ac;
    const o = { signal: ac.signal };
    scroller.addEventListener('scroll', this.onScroll, { signal: ac.signal, passive: true });
    scroller.addEventListener('scrollend', this.onScrollEnd, o);
    scroller.addEventListener('wheel', this.onWheel, { signal: ac.signal, passive: false });
    scroller.addEventListener('touchstart', this.onTouchStart, { signal: ac.signal, passive: true });
    scroller.addEventListener('touchmove', this.onTouchMove, { signal: ac.signal, passive: false });
    scroller.addEventListener('touchend', this.onTouchEnd, o);
    scroller.addEventListener('touchcancel', this.onTouchEnd, o);
    scroller.addEventListener('gesturestart', this.onGestureStart as EventListener, { signal: ac.signal, passive: false });
    scroller.addEventListener('gesturechange', this.onGestureChange as EventListener, { signal: ac.signal, passive: false });
    scroller.addEventListener('gestureend', this.onGestureEnd as EventListener, { signal: ac.signal, passive: false });
  }

  detach() {
    this.ac?.abort();
    this.ac = null;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.zoomRaf);
    this.raf = 0;
    this.zoomRaf = 0;
  }

  // ── layout changes ────────────────────────────────────────────────────────

  /**
   * Called (in a layout effect) after a new layout was committed to the DOM. Keeps the content
   * under the anchor point still, then applies a pending scroll request.
   */
  layoutChanged(prev: Layout | null, next: Layout, req: ScrollRequest | null, opts: { resized: boolean; fit: boolean }) {
    const s = this.ctrl.scroller;
    if (!s) return;
    const reqPending = !!req && handledNonces.get(this.docId) !== req.nonce;
    if (!prev) {
      if (!reqPending) {
        const saved = savedAnchors.get(this.docId);
        const pos = saved ? resolveAnchor(next, saved) : null;
        const cur = getDoc(this.docId)?.view.currentPage ?? 0;
        if (pos) this.apply(pos.left, pos.top, 'auto', false);
        else if (cur > 0) this.scrollToPage(next, cur, 'auto');
      }
    } else if (prev !== next) {
      const zoomChanged = Math.abs(prev.zoom - next.zoom) > 1e-9;
      let mode: AnchorMode;
      if (zoomChanged && this.ctrl.pendingAnchor) mode = this.ctrl.pendingAnchor;
      else if (zoomChanged && !(opts.resized && opts.fit)) mode = { mode: 'center' };
      else mode = { mode: 'top' };
      const w = s.clientWidth;
      const h = s.clientHeight;
      const x = mode.mode === 'pointer' ? mode.x : w / 2;
      const y = mode.mode === 'pointer' ? mode.y : mode.mode === 'center' ? h / 2 : 0;
      const a = captureAnchor(prev, this.ctrl.scrollLeft, this.ctrl.scrollTop, x, y);
      const pos = a ? resolveAnchor(next, a) : null;
      if (pos) {
        // Keep the horizontal position when nothing overflows horizontally.
        this.apply(pos.left, pos.top, 'auto', false);
      } else if (isPagedMode(next.mode)) {
        this.apply(this.ctrl.scrollLeft, 0, 'auto', false);
      } else {
        this.apply(this.ctrl.scrollLeft, this.ctrl.scrollTop, 'auto', false);
      }
    }
    this.ctrl.pendingAnchor = null;
    if (req && reqPending && this.handleRequest(next, req)) handledNonces.set(this.docId, req.nonce);
    this.update();
  }

  private apply(left: number, top: number, behavior: ScrollBehavior, programmatic: boolean) {
    const s = this.ctrl.scroller;
    if (!s) return;
    const maxTop = Math.max(0, s.scrollHeight - s.clientHeight);
    const maxLeft = Math.max(0, s.scrollWidth - s.clientWidth);
    const t = Math.round(Math.min(maxTop, Math.max(0, top)));
    const l = Math.round(Math.min(maxLeft, Math.max(0, left)));
    if (behavior === 'smooth') {
      s.scrollTo({ left: l, top: t, behavior: 'smooth' });
    } else {
      s.scrollLeft = l;
      s.scrollTop = t;
      this.ctrl.scrollLeft = s.scrollLeft;
      this.ctrl.scrollTop = s.scrollTop;
    }
    if (programmatic) this.programmatic = { top: t, left: l, smooth: behavior === 'smooth', at: performance.now() };
  }

  private scrollToPage(layout: Layout, index: number, behavior: ScrollBehavior) {
    const slot = layout.slots[index];
    const s = this.ctrl.scroller;
    if (!slot || !s) return false;
    const top = isPagedMode(layout.mode) ? slot.top - GAP : slot.top - GAP;
    let left = this.ctrl.scrollLeft;
    if (slot.left < left || slot.left + slot.width > left + s.clientWidth) left = slot.left + slot.width / 2 - s.clientWidth / 2;
    this.apply(left, top, behavior, true);
    return true;
  }

  /** Returns false when the target page isn't laid out yet (paged modes) so it's retried. */
  private handleRequest(layout: Layout, req: ScrollRequest): boolean {
    const s = this.ctrl.scroller;
    const doc = getDoc(this.docId);
    if (!s || !doc) return false;
    const slot = layout.slots[req.pageIndex];
    const page = layout.pages[req.pageIndex];
    if (!slot || !page) {
      if (isPagedMode(layout.mode) && doc.view.currentPage !== req.pageIndex && req.pageIndex < doc.pages.length) {
        actions.setView(this.docId, { currentPage: req.pageIndex });
        return false;
      }
      return true;
    }
    const behavior: ScrollBehavior = req.behavior === 'smooth' ? 'smooth' : 'auto';
    const vp = makeViewport(page, layout.zoom, slot.rotation);
    const cw = s.clientWidth;
    const ch = s.clientHeight;
    const curL = this.ctrl.scrollLeft;
    const curT = this.ctrl.scrollTop;
    if (req.rect) {
      const b = rectToView(vp, req.rect);
      const bx = slot.left + b.left;
      const by = slot.top + b.top;
      const margin = Math.min(48, ch * 0.1);
      const fullyVisible = by >= curT + margin && by + b.height <= curT + ch - margin && bx >= curL && bx + b.width <= curL + cw;
      if (fullyVisible) {
        this.programmatic = { top: curT, left: curL, smooth: false, at: performance.now() };
        return true;
      }
      const top = b.height > ch - 2 * margin ? by - margin : by + b.height / 2 - ch / 2;
      let left = curL;
      if (bx < curL || bx + b.width > curL + cw) left = b.width > cw ? bx - 16 : bx + b.width / 2 - cw / 2;
      this.apply(left, top, behavior, true);
      return true;
    }
    if (req.point) {
      const [vx, vy] = vp.convertToViewportPoint(req.point.x, req.point.y);
      const px = slot.left + vx;
      let left = curL;
      if (px < curL || px > curL + cw) left = px - cw / 2;
      this.apply(left, slot.top + vy, behavior, true);
      return true;
    }
    return this.scrollToPage(layout, req.pageIndex, behavior);
  }

  // ── scrolling ─────────────────────────────────────────────────────────────

  private onScroll = () => {
    const s = this.ctrl.scroller;
    if (!s) return;
    this.ctrl.scrollTop = s.scrollTop;
    this.ctrl.scrollLeft = s.scrollLeft;
    const pop = viewerUi.get().textPopup;
    if (pop && pop.docId === this.docId) viewerUi.set({ textPopup: null });
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
      this.trackCurrentPage();
    });
  };

  private onScrollEnd = () => {
    const s = this.ctrl.scroller;
    const p = this.programmatic;
    if (s && p?.smooth) this.programmatic = { ...p, smooth: false, top: s.scrollTop, left: s.scrollLeft };
    this.update();
    this.trackCurrentPage();
  };

  /** Recompute the mounted range + visible pages; nudge renders and detail canvases. */
  update() {
    const s = this.ctrl.scroller;
    const l = this.ctrl.layout;
    if (!s || !l) return;
    const h = s.clientHeight;
    const w = s.clientWidth;
    const top = this.ctrl.scrollTop;
    const left = this.ctrl.scrollLeft;
    const range = indicesInRange(l, top - h, top + 2 * h);
    if (!sameArr(range, this.range)) {
      this.range = range;
      this.onRange?.(range);
    }
    const visible = indicesInRange(l, top, top + h).filter((i) => {
      const sl = l.slots[i];
      return !!sl && sl.left < left + w && sl.left + sl.width > left;
    });
    viewerUi.setVisible(this.docId, visible);
    renderQueue.poke();
    for (const i of visible) {
      const id = l.pageIds[i];
      this.ctrl.renderers.get(id)?.onScroll();
    }
    const a = captureAnchor(l, left, top, 0, 0);
    if (a) savedAnchors.set(this.docId, a);
  }

  get mountedRange() {
    return this.range;
  }

  private trackCurrentPage() {
    const s = this.ctrl.scroller;
    const l = this.ctrl.layout;
    const doc = getDoc(this.docId);
    if (!s || !l || !doc) return;
    const p = this.programmatic;
    if (p) {
      if (p.smooth && performance.now() - p.at < 1200) return;
      if (!p.smooth && Math.abs(s.scrollTop - p.top) <= 2 && Math.abs(s.scrollLeft - p.left) <= 2) return;
      this.programmatic = null;
    }
    const idx = mostVisiblePage(l, s.scrollLeft, s.scrollTop, s.clientWidth, s.clientHeight);
    if (idx != null && idx !== doc.view.currentPage) actions.setView(this.docId, { currentPage: idx });
  }

  // ── zoom (wheel / pinch / gesture) ────────────────────────────────────────

  private queueZoom(clientX: number, clientY: number) {
    const s = this.ctrl.scroller;
    if (!s) return;
    const r = s.getBoundingClientRect();
    this.zoomPt = { x: clientX - r.left, y: clientY - r.top };
    if (!this.zoomRaf) this.zoomRaf = requestAnimationFrame(this.flushZoom);
  }

  private flushZoom = () => {
    this.zoomRaf = 0;
    const doc = getDoc(this.docId);
    const cur = this.ctrl.layout?.zoom ?? doc?.view.zoom;
    if (!doc || cur == null) return;
    let z = this.zoomAbs ?? cur * this.zoomFactor;
    this.zoomFactor = 1;
    this.zoomAbs = null;
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    z = Math.round(z * 1000) / 1000;
    if (Math.abs(z - cur) < 1e-4) return;
    this.ctrl.pendingAnchor = { mode: 'pointer', x: this.zoomPt.x, y: this.zoomPt.y };
    actions.setZoom(this.docId, z, null);
  };

  private onWheel = (e: WheelEvent) => {
    const s = this.ctrl.scroller;
    if (!s) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? s.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const dy = e.deltaY * unit;
      if (dy === 0) return;
      // Mouse wheel notches (±100 / 3 lines) step like desktop viewers; trackpad pinches are continuous.
      const factor = Math.abs(dy) >= 40 ? Math.pow(1.15, -Math.sign(dy) * Math.min(3, Math.round(Math.abs(dy) / 100) || 1)) : Math.exp(-dy * 0.01);
      this.zoomFactor *= factor;
      this.queueZoom(e.clientX, e.clientY);
      return;
    }
    const l = this.ctrl.layout;
    if (!l || !isPagedMode(l.mode) || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
      this.flipAcc = 0;
      return;
    }
    const dy = e.deltaY * unit;
    const atEnd = s.scrollTop + s.clientHeight >= s.scrollHeight - 1;
    const atStart = s.scrollTop <= 0;
    if (!((dy > 0 && atEnd) || (dy < 0 && atStart))) {
      this.flipAcc = 0;
      return;
    }
    e.preventDefault();
    const now = performance.now();
    if (now < this.flipLockUntil) {
      this.flipLockUntil = now + 250; // inertia keeps the lock alive
      return;
    }
    this.flipAcc += dy;
    if (Math.abs(this.flipAcc) < 60) return;
    const dir = this.flipAcc > 0 ? 1 : -1;
    this.flipAcc = 0;
    this.flipLockUntil = now + 250;
    this.flip(dir);
  };

  /** Paged layouts: go to the next / previous spread (previous shows its bottom). */
  flip(dir: 1 | -1) {
    const doc = getDoc(this.docId);
    const l = this.ctrl.layout;
    const s = this.ctrl.scroller;
    if (!doc || !l || !s) return;
    const spread = spreadOf(doc.view.currentPage, doc.pages.length, l.mode);
    const target = dir > 0 ? spread[spread.length - 1] + 1 : spread[0] - 1;
    if (target < 0 || target >= doc.pages.length) return;
    if (dir > 0) {
      actions.goToPage(this.docId, target);
      return;
    }
    const page = doc.pages[target];
    const rot = l.slots[spread[0]]?.rotation ?? 0;
    const vp = makeViewport(page, l.zoom, ((page.rotation + l.viewRotation) % 360) as typeof rot);
    const y = Math.max(0, vp.height + GAP - s.clientHeight + GAP);
    const [px, py] = vp.convertToPdfPoint(0, y);
    actions.goToPage(this.docId, target, { point: { x: px, y: py } });
  }

  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      this.pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, z0: this.ctrl.layout?.zoom ?? 1 };
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    if (!this.pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.zoomAbs = this.pinch.z0 * (d / this.pinch.d0);
    this.queueZoom((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  };

  private onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) this.pinch = null;
  };

  private onGestureStart = (e: Event & { scale?: number }) => {
    e.preventDefault();
    this.gesture = { z0: this.ctrl.layout?.zoom ?? 1 };
  };

  private onGestureChange = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
    e.preventDefault();
    if (!this.gesture || !e.scale) return;
    this.zoomAbs = this.gesture.z0 * e.scale;
    const s = this.ctrl.scroller!;
    const r = s.getBoundingClientRect();
    this.queueZoom(e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top + r.height / 2);
  };

  private onGestureEnd = (e: Event) => {
    e.preventDefault();
    this.gesture = null;
  };
}
