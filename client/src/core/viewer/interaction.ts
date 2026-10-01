/**
 * Pointer + keyboard interaction for a DocumentViewer: object selection / move / resize / marquee,
 * hand-tool and space-bar panning, text selection (popup / tool callback), context menus and the
 * viewer's keyboard shortcuts.
 *
 * Pointer handling is attached with React handlers on the scroll container, so object renderers
 * can opt out with `stopPropagation()` (or by marking an element `data-viewer-passthrough`).
 */
import type { PointerEvent as RPointerEvent, MouseEvent as RMouseEvent } from 'react';
import { ClipboardCopy } from 'lucide-react';
import type { DocId, ObjectId, PdfObject, TextSelectionInfo, ViewBox } from '../types';
import { actions, getDoc, useApp } from '../store';
import { reg } from '../registry';
import { rectToView, viewToRect } from '../geometry';
import { hasEscapeLayer, isEditableTarget, matchShortcut, showContextMenu, type MenuEntry } from '../ui';
import type { ViewerController } from './controller';
import { isPagedMode, spreadOf } from './layout';
import { viewDeltaToPdf } from './viewport';
import { viewerUi } from './viewerStore';
import { collectTextSelection, selectionClientBounds, selectPageText } from './textSelection';
import { copyObjects, cutObjects, duplicateObjects, hasClipboardObjects, pasteObjects, translatedPatch } from './clipboard';
import { deleteSelectedObjects, openObjectContextMenu, openPageContextMenu } from './contextMenus';

const DRAG_THRESHOLD = 3;
const AUTOSCROLL_EDGE = 28;
const AUTOSCROLL_MAX = 18;

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface DragSession {
  kind: 'move' | 'resize' | 'marquee' | 'pan';
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  lastX: number;
  lastY: number;
  started: boolean;
  shift: boolean;
  apply(): void;
  finish(cancelled: boolean): void;
}

const isAdditive = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => e.shiftKey || e.metaKey || e.ctrlKey;

function pageIndexOfEl(el: Element | null): number | null {
  const p = el?.closest<HTMLElement>('.pdfwizard-page');
  if (!p) return null;
  const n = Number(p.dataset.pageIndex);
  return Number.isFinite(n) ? n : null;
}

/** Copy text to the clipboard (execCommand inside the user gesture, async API as fallback). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (document.execCommand('copy')) return true;
  } catch {
    /* fall through */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function clearTextSelection() {
  const sel = document.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (anchor?.closest('.textLayer')) sel.removeAllRanges();
  }
  if (viewerUi.get().textPopup) viewerUi.set({ textPopup: null });
}

/** Menu entries for a text selection (registry actions + Copy). */
export function textSelectionEntries(selections: TextSelectionInfo[]): MenuEntry[] {
  const acts = reg.get().textSelectionActions;
  const text = selections.map((s) => s.text).join('\n');
  const out: MenuEntry[] = [
    {
      id: 'viewer.text.copy',
      label: 'Copy',
      icon: ClipboardCopy,
      shortcut: 'mod+c',
      run: () => {
        void copyText(text);
      },
    },
  ];
  for (const a of acts) {
    out.push({
      id: a.id,
      label: a.label,
      icon: a.icon,
      run: async () => {
        await a.run(selections);
        clearTextSelection();
      },
    });
  }
  return out;
}

export class ViewerInteraction {
  private session: DragSession | null = null;
  private suppressMouseDown = false;
  private raf = 0;
  private autoRaf = 0;
  private spaceDownAt = 0;
  private spaceUsed = false;
  private ac: AbortController | null = null;

  constructor(private readonly ctrl: ViewerController) {}

  /** Install the window / document listeners (keyboard, space panning, popup dismissal). */
  attach() {
    this.detach();
    const ac = new AbortController();
    this.ac = ac;
    const opts = { signal: ac.signal };
    const capture = { signal: ac.signal, capture: true };
    window.addEventListener('keydown', this.onKeyDown, capture);
    window.addEventListener('keyup', this.onKeyUp, capture);
    window.addEventListener('blur', this.onBlur, opts);
    document.addEventListener('selectionchange', this.onSelectionChange, opts);
    document.addEventListener('pointerdown', this.onDocPointerDown, capture);
  }

  get docId(): DocId {
    return this.ctrl.docId;
  }

  detach() {
    this.ac?.abort();
    this.ac = null;
    this.endSession(true);
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.autoRaf);
    if (viewerUi.get().spacePan) viewerUi.set({ spacePan: false });
  }

  get busy() {
    return !!this.session?.started;
  }

  // ── React handlers (attached to the scroll container) ─────────────────────

  onMouseDown = (e: RMouseEvent) => {
    if (this.suppressMouseDown) {
      e.preventDefault();
      this.suppressMouseDown = false;
    }
  };

  onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    this.suppressMouseDown = false;
    if (viewerUi.get().textPopup) viewerUi.set({ textPopup: null });
    const target = e.target as Element;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-viewer-passthrough]')) return;
    const doc = getDoc(this.docId);
    if (!doc) return;
    if (useApp.getState().activeDocId !== this.docId) actions.setActiveDoc(this.docId);

    // Middle button: pan like the hand tool.
    if (e.button === 1) {
      e.preventDefault();
      this.startPan(e);
      return;
    }
    if (e.button !== 0) return;
    // Touch: taps select objects; everything else is native scrolling / pinch (handled by the viewer).
    const touch = e.pointerType === 'touch';

    this.maybeEndEditing(target);

    const toolId = useApp.getState().activeToolId;
    const tool = reg.tool(toolId);
    const spacePan = viewerUi.get().spacePan;

    if (spacePan && !touch) {
      this.preventNative(e);
      this.startPan(e);
      return;
    }

    if (toolId !== 'select' && toolId !== 'hand') {
      // Tools with a page overlay handle their own pointer events. Text-selection tools let the
      // browser select text and receive the selection on pointer up.
      if (tool?.textSelection && target.closest('.pdfwizard-page')) this.watchTextSelection('tool', toolId);
      return;
    }

    // Links and form widgets keep working with both tools.
    if (target.closest('.annotationLayer section, .annotationLayer a')) return;
    if (isEditableTarget(target) || target.closest('.pdfwizard-obj.is-editing')) return;

    const handle = target.closest<HTMLElement>('.pdfwizard-handle');
    if (handle && toolId === 'select' && !touch) {
      const id = handle.dataset.objId;
      if (id) {
        this.preventNative(e);
        this.startResize(e, id, handle.dataset.handle as Handle);
      }
      return;
    }

    const objEl = target.closest<HTMLElement>('.pdfwizard-obj[data-obj-id], .pdfwizard-frame.is-hit[data-frame-for]');
    if (objEl) {
      const id = objEl.dataset.objId ?? objEl.dataset.frameFor!;
      if (doc.objects[id]) {
        this.preventNative(e);
        this.onObjectPointerDown(e, id);
        return;
      }
    }

    if (toolId === 'hand') {
      clearTextSelection();
      if (doc.selection.length) actions.setSelection(this.docId, []);
      if (touch) return;
      this.preventNative(e);
      this.startPan(e);
      return;
    }
    if (touch) {
      if (doc.selection.length) actions.setSelection(this.docId, []);
      return;
    }

    // Select tool on text → native text selection.
    const layer = target.closest('.textLayer');
    if (layer && target !== layer && !target.classList.contains('endOfContent')) {
      if (!isAdditive(e) && doc.selection.length) actions.setSelection(this.docId, []);
      this.focusScroller();
      this.watchTextSelection('popup', toolId);
      return;
    }

    // Empty page area / gap between pages → clear + marquee.
    this.preventNative(e);
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
    const pageIndex = pageIndexOfEl(target);
    if (!isAdditive(e) && doc.selection.length) actions.setSelection(this.docId, []);
    if (pageIndex != null) this.startMarquee(e, pageIndex, isAdditive(e));
  };

  onDoubleClick = (e: RMouseEvent) => {
    const target = e.target as Element;
    if (!(target instanceof Element) || target.closest('[data-viewer-passthrough]')) return;
    const toolId = useApp.getState().activeToolId;
    if (toolId !== 'select' && toolId !== 'hand') return;
    const objEl = target.closest<HTMLElement>('.pdfwizard-obj[data-obj-id], .pdfwizard-frame.is-hit[data-frame-for]');
    if (!objEl || objEl.classList.contains('is-editing')) return;
    const id = objEl.dataset.objId ?? objEl.dataset.frameFor!;
    const obj = getDoc(this.docId)?.objects[id];
    const type = obj ? reg.objectType(obj.kind) : undefined;
    if (obj && type?.editable && !obj.locked) {
      e.preventDefault();
      actions.setEditing(this.docId, id);
    }
  };

  onContextMenu = (e: RMouseEvent) => {
    const target = e.target as Element;
    if (!(target instanceof Element) || target.closest('[data-viewer-passthrough]')) return;
    if (isEditableTarget(target) || target.closest('.pdfwizard-obj.is-editing')) return;
    if (target.closest('.annotationLayer') && target.closest('input, textarea, select')) return;
    const doc = getDoc(this.docId);
    if (!doc) return;
    const objEl = target.closest<HTMLElement>('.pdfwizard-obj[data-obj-id], .pdfwizard-frame.is-hit[data-frame-for], .pdfwizard-handle[data-obj-id]');
    const pageIndex = pageIndexOfEl(target);
    const point = pageIndex != null ? this.ctrl.clientToPdf(pageIndex, e.clientX, e.clientY) ?? undefined : undefined;
    if (objEl) {
      const id = objEl.dataset.objId ?? objEl.dataset.frameFor!;
      if (doc.objects[id]) {
        let ids = doc.selection;
        if (!ids.includes(id)) {
          ids = [id];
          actions.setSelection(this.docId, ids);
        }
        const pi = doc.pages.findIndex((p) => p.id === doc.objects[id].pageId);
        openObjectContextMenu(e, this.docId, ids, pi, point);
        return;
      }
    }
    if (pageIndex == null) {
      e.preventDefault();
      return;
    }
    // Right-click inside a text selection → text actions first.
    const selections = collectTextSelection(this.ctrl);
    if (selections.length) {
      const bounds = selectionClientBounds();
      const inside = bounds && e.clientX >= bounds.union.left - 4 && e.clientX <= bounds.union.right + 4 && e.clientY >= bounds.union.top - 4 && e.clientY <= bounds.union.bottom + 4;
      if (inside) {
        showContextMenu(e, textSelectionEntries(selections));
        return;
      }
    }
    if (doc.selection.length) actions.setSelection(this.docId, []);
    openPageContextMenu(e, this.docId, pageIndex, point);
  };

  // ── helpers ───────────────────────────────────────────────────────────────

  private preventNative(e: RPointerEvent) {
    this.suppressMouseDown = true;
    this.focusScroller();
    void e;
  }

  private focusScroller() {
    const s = this.ctrl.scroller;
    if (s && document.activeElement !== s && !s.contains(document.activeElement)) s.focus({ preventScroll: true });
    else if (s && document.activeElement && s.contains(document.activeElement) && document.activeElement !== s) {
      const a = document.activeElement as HTMLElement;
      if (!isEditableTarget(a)) s.focus({ preventScroll: true });
    }
  }

  private maybeEndEditing(target: Element) {
    const d = getDoc(this.docId);
    if (!d?.editingId) return;
    const id = d.editingId;
    const inside = target.closest(`.pdfwizard-obj[data-obj-id="${CSS.escape(id)}"], [data-frame-for="${CSS.escape(id)}"]`);
    if (!inside) actions.setEditing(this.docId, null);
  }

  private scrollerRect() {
    return this.ctrl.scroller?.getBoundingClientRect() ?? null;
  }

  /** Pointer delta in content (sizer) px since the session started (accounts for scrolling). */
  private contentDelta(s: DragSession) {
    const sc = this.ctrl.scroller;
    const sl = sc?.scrollLeft ?? 0;
    const st = sc?.scrollTop ?? 0;
    return { dx: s.lastX + sl - (s.startX + s.startScrollLeft), dy: s.lastY + st - (s.startY + s.startScrollTop) };
  }

  private beginSession(e: RPointerEvent<HTMLElement>, s: Omit<DragSession, 'pointerId' | 'startX' | 'startY' | 'startScrollLeft' | 'startScrollTop' | 'lastX' | 'lastY' | 'started' | 'shift'>) {
    this.endSession(true);
    const sc = this.ctrl.scroller;
    const session: DragSession = {
      ...s,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScrollLeft: sc?.scrollLeft ?? 0,
      startScrollTop: sc?.scrollTop ?? 0,
      lastX: e.clientX,
      lastY: e.clientY,
      started: false,
      shift: e.shiftKey,
    };
    this.session = session;
    const sig = new AbortController();
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== session.pointerId) return;
      session.lastX = ev.clientX;
      session.lastY = ev.clientY;
      session.shift = ev.shiftKey;
      if (!session.started) {
        if (Math.hypot(ev.clientX - session.startX, ev.clientY - session.startY) < DRAG_THRESHOLD) return;
        session.started = true;
        try {
          sc?.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
      }
      ev.preventDefault();
      this.scheduleApply();
      if (session.kind !== 'pan') this.autoScroll();
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== session.pointerId) return;
      sig.abort();
      if (this.session === session) this.session = null;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (session.started) session.apply();
      session.finish(ev.type === 'pointercancel');
      try {
        sc?.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.session === session) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        sig.abort();
        this.session = null;
        session.finish(true);
      } else if (ev.key === 'Shift' && this.session === session) {
        session.shift = ev.type === 'keydown';
        if (session.started) this.scheduleApply();
      }
    };
    window.addEventListener('pointermove', move, { signal: sig.signal, capture: true });
    window.addEventListener('pointerup', up, { signal: sig.signal, capture: true });
    window.addEventListener('pointercancel', up, { signal: sig.signal, capture: true });
    window.addEventListener('keydown', key, { signal: sig.signal, capture: true });
    window.addEventListener('keyup', key, { signal: sig.signal, capture: true });
    session.finish = ((orig) => (cancelled: boolean) => {
      sig.abort();
      orig(cancelled);
    })(session.finish);
  }

  private endSession(cancelled: boolean) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.finish(cancelled);
  }

  private scheduleApply() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const s = this.session;
      if (s?.started) s.apply();
    });
  }

  /** Scroll while dragging near the edges of the viewport. */
  private autoScroll() {
    if (this.autoRaf) return;
    const step = () => {
      this.autoRaf = 0;
      const s = this.session;
      const sc = this.ctrl.scroller;
      const r = this.scrollerRect();
      if (!s || !s.started || !sc || !r) return;
      const speed = (d: number) => (d < AUTOSCROLL_EDGE ? Math.ceil(((AUTOSCROLL_EDGE - d) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX) : 0);
      const vy = speed(s.lastY - r.top) ? -speed(s.lastY - r.top) : speed(r.bottom - s.lastY);
      const vx = speed(s.lastX - r.left) ? -speed(s.lastX - r.left) : speed(r.right - s.lastX);
      if (!vx && !vy) return;
      const before = sc.scrollTop + sc.scrollLeft;
      sc.scrollTop += vy;
      sc.scrollLeft += vx;
      if (sc.scrollTop + sc.scrollLeft !== before) s.apply();
      this.autoRaf = requestAnimationFrame(step);
    };
    this.autoRaf = requestAnimationFrame(step);
  }

  // ── objects: select / move ────────────────────────────────────────────────

  private onObjectPointerDown(e: RPointerEvent<HTMLElement>, id: ObjectId) {
    const doc = getDoc(this.docId)!;
    clearTextSelection();
    const additive = isAdditive(e);
    const wasSelected = doc.selection.includes(id);
    let selection = doc.selection;
    if (additive) {
      selection = wasSelected ? doc.selection.filter((x) => x !== id) : [...doc.selection, id];
      actions.setSelection(this.docId, selection);
      if (wasSelected) return; // toggled off: no drag
    } else if (!wasSelected) {
      selection = [id];
      actions.setSelection(this.docId, selection);
    }
    this.startMove(e, selection, () => {
      // Plain click on an already selected item of a multi-selection → select only it.
      if (!additive && wasSelected && selection.length > 1) actions.setSelection(this.docId, [id]);
    });
  }

  private startMove(e: RPointerEvent<HTMLElement>, ids: ObjectId[], onClick: () => void) {
    const doc = getDoc(this.docId);
    if (!doc) return;
    const originals = new Map<ObjectId, PdfObject>();
    for (const id of ids) {
      const o = doc.objects[id];
      if (!o || o.locked) continue;
      if (reg.objectType(o.kind)?.movable === false) continue;
      originals.set(id, o);
    }
    const docId = this.docId;
    let checkpointed = false;
    this.beginSession(e, {
      kind: 'move',
      apply: () => {
        const s = this.session;
        if (!s || originals.size === 0) return;
        if (!checkpointed) {
          checkpointed = true;
          actions.checkpoint(docId, originals.size > 1 ? `Move ${originals.size} items` : 'Move');
          viewerUi.set({ interaction: 'move' });
        }
        let { dx, dy } = this.contentDelta(s);
        // Shift constrains to the dominant axis.
        if (s.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const c = this.clampViewDelta(originals, dx, dy);
        this.applyTranslation(originals, c.dx, c.dy);
      },
      finish: (cancelled) => {
        if (!checkpointed) {
          if (!cancelled) onClick();
          return;
        }
        viewerUi.set({ interaction: null });
        if (cancelled) {
          const patches: Record<ObjectId, Partial<PdfObject>> = {};
          for (const [id, o] of originals) patches[id] = { rect: o.rect, data: o.data };
          actions.updateObjects(docId, patches, { checkpoint: false });
        }
      },
    });
  }

  /** Clamp a view-space delta so every moved object stays inside its page. */
  private clampViewDelta(originals: Map<ObjectId, PdfObject>, dx: number, dy: number) {
    const doc = getDoc(this.docId);
    if (!doc) return { dx: 0, dy: 0 };
    let minX = -Infinity;
    let maxX = Infinity;
    let minY = -Infinity;
    let maxY = Infinity;
    for (const o of originals.values()) {
      const i = doc.pages.findIndex((p) => p.id === o.pageId);
      const vp = this.ctrl.viewport(i);
      const slot = this.ctrl.slot(i);
      if (!vp || !slot) continue;
      const b = rectToView(vp, o.rect);
      minX = Math.max(minX, Math.min(0, -b.left));
      maxX = Math.min(maxX, Math.max(0, slot.width - (b.left + b.width)));
      minY = Math.max(minY, Math.min(0, -b.top));
      maxY = Math.min(maxY, Math.max(0, slot.height - (b.top + b.height)));
    }
    return { dx: Math.min(maxX, Math.max(minX, dx)), dy: Math.min(maxY, Math.max(minY, dy)) };
  }

  private applyTranslation(originals: Map<ObjectId, PdfObject>, dxView: number, dyView: number, opts: { checkpoint?: boolean; coalesce?: string; label?: string } = { checkpoint: false }) {
    const doc = getDoc(this.docId);
    if (!doc) return;
    const patches: Record<ObjectId, Partial<PdfObject>> = {};
    for (const [id, o] of originals) {
      const i = doc.pages.findIndex((p) => p.id === o.pageId);
      const vp = this.ctrl.viewport(i);
      if (!vp) continue;
      const d = viewDeltaToPdf(vp, dxView, dyView);
      patches[id] = translatedPatch(o, d.x, d.y);
    }
    actions.updateObjects(this.docId, patches, opts);
  }

  // ── objects: resize ───────────────────────────────────────────────────────

  private startResize(e: RPointerEvent<HTMLElement>, id: ObjectId, handle: Handle) {
    const doc = getDoc(this.docId);
    const orig = doc?.objects[id];
    if (!doc || !orig || orig.locked) return;
    const type = reg.objectType(orig.kind);
    if (type?.resizable === false || type?.movable === false) return;
    const pageIndex = doc.pages.findIndex((p) => p.id === orig.pageId);
    const docId = this.docId;
    let checkpointed = false;
    clearTextSelection();
    this.beginSession(e, {
      kind: 'resize',
      apply: () => {
        const s = this.session;
        const vp = this.ctrl.viewport(pageIndex);
        const slot = this.ctrl.slot(pageIndex);
        if (!s || !vp || !slot) return;
        if (!checkpointed) {
          checkpointed = true;
          actions.checkpoint(docId, 'Resize');
          viewerUi.set({ interaction: 'resize' });
        }
        const { dx, dy } = this.contentDelta(s);
        const b0 = rectToView(vp, orig.rect);
        const swap = slot.rotation % 180 !== 0;
        const min = type?.minSize ?? { width: 2, height: 2 };
        const minW = Math.max(2, (swap ? min.height : min.width) * vp.scale);
        const minH = Math.max(2, (swap ? min.width : min.height) * vp.scale);
        const corner = handle.length === 2;
        const keepAspect = !!type?.keepAspectRatio || (corner && s.shift);
        const box = resizeBox(b0, handle, dx, dy, { minW, minH, maxW: slot.width, maxH: slot.height, keepAspect });
        const rect = viewToRect(vp, box);
        const extra = type?.resize ? type.resize(orig, rect) : {};
        actions.updateObjects(docId, { [id]: { rect, ...extra } }, { checkpoint: false });
      },
      finish: (cancelled) => {
        if (!checkpointed) return;
        viewerUi.set({ interaction: null });
        if (cancelled) actions.updateObjects(docId, { [id]: { rect: orig.rect, data: orig.data } }, { checkpoint: false });
      },
    });
  }

  // ── marquee ───────────────────────────────────────────────────────────────

  private startMarquee(e: RPointerEvent<HTMLElement>, pageIndex: number, additive: boolean) {
    const doc = getDoc(this.docId);
    if (!doc) return;
    const base = additive ? doc.selection : [];
    const start = this.ctrl.clientToPage(pageIndex, e.clientX, e.clientY);
    if (!start) return;
    const docId = this.docId;
    const pageId = doc.pages[pageIndex]?.id;
    this.beginSession(e, {
      kind: 'marquee',
      apply: () => {
        const s = this.session;
        const slot = this.ctrl.slot(pageIndex);
        const vp = this.ctrl.viewport(pageIndex);
        const cur = this.ctrl.clientToPage(pageIndex, s?.lastX ?? 0, s?.lastY ?? 0);
        if (!s || !slot || !vp || !cur) return;
        const x0 = clampN(start.x, 0, slot.width);
        const y0 = clampN(start.y, 0, slot.height);
        const x1 = clampN(cur.x, 0, slot.width);
        const y1 = clampN(cur.y, 0, slot.height);
        const box: ViewBox = { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
        viewerUi.set({ marquee: { docId, pageIndex, box }, interaction: 'marquee' });
        const d = getDoc(docId);
        if (!d) return;
        const hits: ObjectId[] = [];
        for (const oid of d.order) {
          const o = d.objects[oid];
          if (!o || o.pageId !== pageId) continue;
          const b = rectToView(vp, o.rect);
          if (b.left < box.left + box.width && box.left < b.left + b.width && b.top < box.top + box.height && box.top < b.top + b.height) hits.push(oid);
        }
        const next = [...base, ...hits.filter((h) => !base.includes(h))];
        actions.setSelection(docId, next);
      },
      finish: () => {
        viewerUi.set({ marquee: null, interaction: null });
      },
    });
  }

  // ── panning ───────────────────────────────────────────────────────────────

  private startPan(e: RPointerEvent<HTMLElement>) {
    const sc = this.ctrl.scroller;
    if (!sc) return;
    const sl = sc.scrollLeft;
    const st = sc.scrollTop;
    this.spaceUsed = true;
    this.beginSession(e, {
      kind: 'pan',
      apply: () => {
        const s = this.session;
        if (!s) return;
        if (viewerUi.get().interaction !== 'pan') viewerUi.set({ interaction: 'pan' });
        sc.scrollLeft = sl - (s.lastX - s.startX);
        sc.scrollTop = st - (s.lastY - s.startY);
      },
      finish: () => {
        if (viewerUi.get().interaction === 'pan') viewerUi.set({ interaction: null });
      },
    });
    viewerUi.set({ interaction: 'pan' });
  }

  // ── text selection ────────────────────────────────────────────────────────

  private watchTextSelection(mode: 'popup' | 'tool', toolId: string) {
    const sig = new AbortController();
    viewerUi.set({ interaction: 'text' });
    const up = (ev: PointerEvent) => {
      sig.abort();
      if (viewerUi.get().interaction === 'text') viewerUi.set({ interaction: null });
      // Let the browser finish updating the selection (double / triple clicks).
      setTimeout(() => this.finishTextSelection(mode, toolId, ev.clientX, ev.clientY), 0);
    };
    window.addEventListener('pointerup', up, { signal: sig.signal, capture: true });
    window.addEventListener('pointercancel', () => {
      sig.abort();
      viewerUi.set({ interaction: null });
    }, { signal: sig.signal, capture: true });
  }

  private finishTextSelection(mode: 'popup' | 'tool', toolId: string, clientX: number, clientY: number) {
    const selections = collectTextSelection(this.ctrl);
    if (selections.length === 0) return;
    if (mode === 'tool') {
      const tool = reg.tool(toolId);
      if (useApp.getState().activeToolId !== toolId || !tool?.onTextSelected) return;
      try {
        tool.onTextSelected(selections);
      } catch (e) {
        console.error(`[viewer] ${toolId}.onTextSelected failed`, e);
      }
      document.getSelection()?.removeAllRanges();
      return;
    }
    if (useApp.getState().prefs.selectionPopup === false) return;
    this.showTextPopup(selections, clientX, clientY);
  }

  showTextPopup(selections: TextSelectionInfo[], clientX?: number, clientY?: number) {
    const root = this.ctrl.root;
    const bounds = selectionClientBounds();
    if (!root || !bounds) return;
    const rr = root.getBoundingClientRect();
    const u = bounds.union;
    const x = clampN(clientX ?? u.left + u.width / 2, u.left, u.right);
    const roomAbove = u.top - rr.top;
    const placement: 'above' | 'below' = roomAbove > 56 ? 'above' : 'below';
    let top = placement === 'above' ? u.top - rr.top - 8 : u.bottom - rr.top + 8;
    if (placement === 'below' && top > rr.height - 48) top = Math.max(8, (clientY ?? u.bottom) - rr.top + 16);
    viewerUi.set({ textPopup: { docId: this.docId, left: x - rr.left, top, placement, selections } });
  }

  private onSelectionChange = () => {
    const pop = viewerUi.get().textPopup;
    if (!pop || pop.docId !== this.docId) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) viewerUi.set({ textPopup: null });
  };

  private onDocPointerDown = (e: PointerEvent) => {
    const pop = viewerUi.get().textPopup;
    if (!pop || pop.docId !== this.docId) return;
    const t = e.target as Element | null;
    if (t?.closest?.('.pdfwizard-text-popup')) return;
    viewerUi.set({ textPopup: null });
  };

  // ── keyboard ──────────────────────────────────────────────────────────────

  private keyTargetOk(e: KeyboardEvent): boolean {
    const app = useApp.getState();
    if (app.activeDocId !== this.docId) return false;
    if (app.modals.length > 0 || hasEscapeLayer()) return false;
    const t = e.target;
    if (isEditableTarget(t)) return false;
    const el = t instanceof Element ? t : null;
    if (el?.closest('.annotationLayer, [data-viewer-passthrough]')) return false;
    const root = this.ctrl.root;
    if (!root || !root.isConnected) return false;
    if (!el || el === document.body || el === document.documentElement) return true;
    return root.contains(el);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === ' ' || e.code === 'Space') {
      this.onSpaceDown(e);
      return;
    }
    if (!this.keyTargetOk(e)) return;
    const doc = getDoc(this.docId);
    if (!doc) return;
    const toolId = useApp.getState().activeToolId;
    const sel = doc.selection;
    const editing = !!doc.editingId;
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;

    if (e.key === 'Escape' && plain) {
      if (this.session) return;
      if (editing) {
        actions.setEditing(this.docId, null);
        return consume();
      }
      if (sel.length) {
        actions.setSelection(this.docId, []);
        return consume();
      }
      const ds = document.getSelection();
      if (viewerUi.get().textPopup || (ds && !ds.isCollapsed && ds.anchorNode && this.ctrl.sizer?.contains(ds.anchorNode))) {
        clearTextSelection();
        ds?.removeAllRanges();
        return consume();
      }
      return;
    }

    if (editing) return; // the editor owns the keyboard while editing

    if ((e.key === 'Delete' || e.key === 'Backspace') && plain && sel.length) {
      deleteSelectedObjects(this.docId, sel);
      return consume();
    }

    if (e.key.startsWith('Arrow') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (sel.length) {
        this.nudge(e.key, e.shiftKey ? 10 : 1);
        return consume();
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        this.keyScroll('line', e.key === 'ArrowDown' ? 1 : -1);
        return consume();
      }
      return;
    }

    if ((e.key === 'PageDown' || e.key === 'PageUp') && plain && !e.shiftKey) {
      this.keyScroll('page', e.key === 'PageDown' ? 1 : -1);
      return consume();
    }

    if (e.key === 'Enter' && plain && !e.shiftKey && sel.length === 1) {
      const o = doc.objects[sel[0]];
      if (o && !o.locked && reg.objectType(o.kind)?.editable) {
        actions.setEditing(this.docId, o.id);
        return consume();
      }
      return;
    }

    if (matchShortcut(e, 'mod+c')) {
      const ds = document.getSelection();
      const hasText = !!ds && !ds.isCollapsed && ds.toString().trim().length > 0;
      if (sel.length && !hasText) {
        copyObjects(this.docId, sel);
        return consume();
      }
      return;
    }
    if (matchShortcut(e, 'mod+x') && sel.length) {
      cutObjects(this.docId, sel);
      return consume();
    }
    if (matchShortcut(e, 'mod+v') && hasClipboardObjects()) {
      pasteObjects(this.docId);
      return consume();
    }
    if (matchShortcut(e, 'mod+d') && sel.length) {
      duplicateObjects(this.docId, sel);
      return consume();
    }
    if (matchShortcut(e, 'mod+a') && (toolId === 'select' || toolId === 'hand')) {
      const page = doc.pages[doc.view.currentPage];
      const ids = page ? doc.order.filter((id) => doc.objects[id]?.pageId === page.id) : [];
      if (ids.length) {
        clearTextSelection();
        actions.setSelection(this.docId, ids);
      } else {
        selectPageText(this.ctrl.pageElement(doc.view.currentPage));
      }
      return consume();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (!viewerUi.get().spacePan || this.spaceDownAt === 0) return;
    const quick = performance.now() - this.spaceDownAt < 220 && !this.spaceUsed;
    const shift = e.shiftKey;
    this.spaceDownAt = 0;
    viewerUi.set({ spacePan: false });
    if (quick && this.keyTargetOk(e)) this.keyScroll('page', shift ? -1 : 1);
  };

  private onBlur = () => {
    this.spaceDownAt = 0;
    if (viewerUi.get().spacePan) viewerUi.set({ spacePan: false });
  };

  private onSpaceDown(e: KeyboardEvent) {
    if (!this.keyTargetOk(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('button, a[href], [role="button"], [role="menuitem"]')) return;
    if (getDoc(this.docId)?.editingId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || this.spaceDownAt) return;
    this.spaceDownAt = performance.now();
    this.spaceUsed = false;
    viewerUi.set({ spacePan: true });
  }

  private nudge(key: string, step: number) {
    const doc = getDoc(this.docId);
    if (!doc) return;
    const originals = new Map<ObjectId, PdfObject>();
    for (const id of doc.selection) {
      const o = doc.objects[id];
      if (!o || o.locked || reg.objectType(o.kind)?.movable === false) continue;
      originals.set(id, o);
    }
    if (originals.size === 0) {
      if (doc.selection.length) actions.toast('Locked items can’t be moved.', { kind: 'info' });
      return;
    }
    const z = this.ctrl.layout?.zoom ?? doc.view.zoom;
    const px = step * z;
    const dx = key === 'ArrowLeft' ? -px : key === 'ArrowRight' ? px : 0;
    const dy = key === 'ArrowUp' ? -px : key === 'ArrowDown' ? px : 0;
    const c = this.clampViewDelta(originals, dx, dy);
    if (Math.abs(c.dx) < 1e-6 && Math.abs(c.dy) < 1e-6) return;
    this.applyTranslation(originals, c.dx, c.dy, { coalesce: 'nudge', label: 'Nudge' });
  }

  /** Keyboard scrolling (line / screen). Paged layouts flip spreads at the edges. */
  keyScroll(kind: 'line' | 'page', dir: 1 | -1) {
    const sc = this.ctrl.scroller;
    const layout = this.ctrl.layout;
    const doc = getDoc(this.docId);
    if (!sc || !layout || !doc) return;
    const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
    const atStart = sc.scrollTop <= 1;
    if (isPagedMode(layout.mode) && kind === 'page' && ((dir > 0 && atEnd) || (dir < 0 && atStart))) {
      const spread = spreadOf(doc.view.currentPage, doc.pages.length, layout.mode);
      const target = dir > 0 ? spread[spread.length - 1] + 1 : spread[0] - 1;
      if (target >= 0 && target < doc.pages.length) actions.goToPage(this.docId, target);
      return;
    }
    const amount = kind === 'line' ? 48 : Math.max(48, sc.clientHeight - 48);
    sc.scrollBy({ top: dir * amount, behavior: kind === 'page' ? 'smooth' : 'auto' });
  }
}

function clampN(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/** Resize a view-space box by dragging `handle` by (dx, dy). Keeps the opposite edge fixed. */
export function resizeBox(
  b0: ViewBox,
  handle: Handle,
  dx: number,
  dy: number,
  o: { minW: number; minH: number; maxW: number; maxH: number; keepAspect: boolean },
): ViewBox {
  let left = b0.left;
  let top = b0.top;
  let right = b0.left + b0.width;
  let bottom = b0.top + b0.height;
  const hasW = handle.includes('w');
  const hasE = handle.includes('e');
  const hasN = handle.includes('n');
  const hasS = handle.includes('s');
  if (hasW) left = clampN(left + dx, 0, right - o.minW);
  if (hasE) right = clampN(right + dx, left + o.minW, o.maxW);
  if (hasN) top = clampN(top + dy, 0, bottom - o.minH);
  if (hasS) bottom = clampN(bottom + dy, top + o.minH, o.maxH);
  if (!o.keepAspect || b0.width <= 0 || b0.height <= 0) {
    return { left, top, width: right - left, height: bottom - top };
  }
  const ratio = b0.width / b0.height;
  let w = right - left;
  let h = bottom - top;
  const corner = (hasW || hasE) && (hasN || hasS);
  if (corner) {
    if (w / ratio > h) h = w / ratio;
    else w = h * ratio;
    const maxW = hasW ? b0.left + b0.width : o.maxW - b0.left;
    const maxH = hasN ? b0.top + b0.height : o.maxH - b0.top;
    const s = Math.min(1, maxW / w, maxH / h);
    w *= s;
    h *= s;
    w = Math.max(w, o.minW, o.minH * ratio);
    h = w / ratio;
    left = hasW ? b0.left + b0.width - w : b0.left;
    top = hasN ? b0.top + b0.height - h : b0.top;
    return { left, top, width: w, height: h };
  }
  if (hasW || hasE) {
    // Horizontal edge: height follows, centred on the original box.
    h = w / ratio;
    const cy = b0.top + b0.height / 2;
    const s = Math.min(1, o.maxH / h, (2 * Math.min(cy, o.maxH - cy)) / h);
    if (s < 1) {
      h *= s;
      w = h * ratio;
      if (hasW) left = right - w;
      else right = left + w;
    }
    return { left, top: cy - h / 2, width: w, height: h };
  }
  w = h * ratio;
  const cx = b0.left + b0.width / 2;
  const s = Math.min(1, o.maxW / w, (2 * Math.min(cx, o.maxW - cx)) / w);
  if (s < 1) {
    w *= s;
    h = w / ratio;
    if (hasN) top = bottom - h;
    else bottom = top + h;
  }
  return { left: cx - w / 2, top, width: w, height: h };
}
