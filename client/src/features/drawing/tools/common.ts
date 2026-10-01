/** Pointer plumbing shared by the drawing tool overlays. */
import type { PointerEvent as RPointerEvent } from 'react';
import type { PageInfo, Point } from '@/core/types';
import { viewerUi } from '@/core/viewer/viewerStore';
import { hasEscapeLayer, isEditableTarget } from '@/core/ui';

/** Clamp a PDF point to the page's visible box. */
export function clampToPage(page: PageInfo, p: Point): Point {
  const [x0, y0, x1, y1] = page.view;
  return { x: Math.min(x1, Math.max(x0, p.x)), y: Math.min(y1, Math.max(y0, p.y)) };
}

/** True when a pointerdown should start a drawing gesture (left button, no space-pan). */
export function isDrawStart(e: RPointerEvent): boolean {
  if (e.button !== 0) return false;
  if (viewerUi.get().spacePan) return false;
  return true;
}

/** Keep keyboard shortcuts (Delete, arrows, tool keys) working after drawing. */
export function focusScroller(el: Element) {
  const s = el.closest<HTMLElement>('.pdfwizard-scroller');
  if (s && document.activeElement !== s) s.focus({ preventScroll: true });
}

export interface PointerHandlers {
  move?(ev: PointerEvent): void;
  up?(ev: PointerEvent): void;
  /** Esc, pointercancel or window blur. */
  cancel?(): void;
}

/**
 * Follow one pointer until it is released (window capture listeners + pointer capture).
 * Returns a function that stops tracking without calling any handler.
 */
export function trackPointer(e: RPointerEvent, h: PointerHandlers): () => void {
  const ctrl = new AbortController();
  const el = e.currentTarget as HTMLElement;
  const id = e.pointerId;
  try {
    el.setPointerCapture(id);
  } catch {
    /* synthetic events */
  }
  const o = { capture: true, signal: ctrl.signal };
  const stop = () => ctrl.abort();
  window.addEventListener('pointermove', (ev) => ev.pointerId === id && h.move?.(ev), o);
  window.addEventListener(
    'pointerup',
    (ev) => {
      if (ev.pointerId !== id) return;
      stop();
      h.up?.(ev);
    },
    o,
  );
  window.addEventListener(
    'pointercancel',
    (ev) => {
      if (ev.pointerId !== id) return;
      stop();
      h.cancel?.();
    },
    o,
  );
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
      h.cancel?.();
    },
    o,
  );
  window.addEventListener(
    'blur',
    () => {
      stop();
      h.cancel?.();
    },
    o,
  );
  return stop;
}

/** Points of a pointermove including coalesced events (smoother ink). */
export function coalesced(ev: PointerEvent): PointerEvent[] {
  const list = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
  return list.length ? list : [ev];
}

/** Whether a window keydown may be used by an in-progress drawing session. */
export function sessionKeyOk(ev: KeyboardEvent): boolean {
  if (ev.defaultPrevented || ev.isComposing) return false;
  if (hasEscapeLayer()) return false;
  const t = ev.target as Element | null;
  if (t && (isEditableTarget(t) || t.closest?.('[role="dialog"], [role="menu"]'))) return false;
  return true;
}
