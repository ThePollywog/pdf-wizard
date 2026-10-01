/**
 * Pointer drags handled by comment objects themselves (callout box / anchor / box handles), with the
 * same feel as the viewer's own moves: 3 px threshold, one undo step, Esc cancels.
 */
import type { PointerEvent as RPointerEvent } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { DocId, ObjectId, PdfObject, Point } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import { viewerUi } from '@/core/viewer/viewerStore';

const THRESHOLD = 3;

export interface PdfDrag {
  docId: DocId;
  objectId: ObjectId;
  viewport: PageViewport;
  label: string;
  interaction?: 'move' | 'resize';
  /** Called with the PDF-space delta since the press and the current PDF point. */
  onMove(delta: Point, cur: Point, view: { dx: number; dy: number }): void;
  /** Plain click (no drag). */
  onClick?(): void;
}

/** Starts a drag from a React pointerdown. Returns false if it couldn't start. */
export function beginPdfDrag(e: RPointerEvent<Element>, opts: PdfDrag): boolean {
  const pageEl = (e.currentTarget as Element).closest<HTMLElement>('.pdfwizard-page');
  const doc = getDoc(opts.docId);
  const orig = doc?.objects[opts.objectId];
  if (!pageEl || !doc || !orig) return false;
  const toPdfPt = (cx: number, cy: number): Point => {
    const r = pageEl.getBoundingClientRect();
    const [x, y] = opts.viewport.convertToPdfPoint(cx - r.left, cy - r.top);
    return { x, y };
  };
  const pointerId = e.pointerId;
  const sx = e.clientX;
  const sy = e.clientY;
  const start = toPdfPt(sx, sy);
  let last = { x: sx, y: sy };
  let started = false;
  let raf = 0;
  let pastLen = 0;
  const ac = new AbortController();
  const apply = () => {
    raf = 0;
    const cur = toPdfPt(last.x, last.y);
    opts.onMove({ x: cur.x - start.x, y: cur.y - start.y }, cur, { dx: last.x - sx, dy: last.y - sy });
  };
  const finish = (cancelled: boolean) => {
    ac.abort();
    cancelAnimationFrame(raf);
    if (!started) {
      if (!cancelled) opts.onClick?.();
      return;
    }
    if (!cancelled) apply();
    viewerUi.set({ interaction: null });
    if (cancelled) cancelTo(opts.docId, opts.objectId, orig, pastLen);
  };
  const capture = { capture: true, signal: ac.signal };
  window.addEventListener(
    'pointermove',
    (ev) => {
      if (ev.pointerId !== pointerId) return;
      last = { x: ev.clientX, y: ev.clientY };
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        started = true;
        actions.checkpoint(opts.docId, opts.label);
        pastLen = getDoc(opts.docId)?.history.past.length ?? 0;
        viewerUi.set({ interaction: opts.interaction ?? 'move' });
      }
      ev.preventDefault();
      if (!raf) raf = requestAnimationFrame(apply);
    },
    capture,
  );
  window.addEventListener('pointerup', (ev) => ev.pointerId === pointerId && finish(false), capture);
  window.addEventListener('pointercancel', (ev) => ev.pointerId === pointerId && finish(true), capture);
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      finish(true);
    },
    capture,
  );
  return true;
}

/** Puts the object back and drops the drag's undo step. */
function cancelTo(docId: DocId, id: ObjectId, orig: PdfObject, pastLen: number) {
  actions.updateDoc(docId, (d) => {
    const objects = d.objects[id] ? { ...d.objects, [id]: orig } : d.objects;
    const past = d.history.past.length === pastLen ? d.history.past.slice(0, -1) : d.history.past;
    return { objects, history: { past, future: d.history.future } };
  });
}
