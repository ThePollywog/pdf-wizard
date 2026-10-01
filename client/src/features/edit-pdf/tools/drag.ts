/**
 * Pointer tracking for drags started on the page overlay (move, resize, crop, rubber band):
 * window-level listeners, a movement threshold, Escape to cancel and a global cursor while dragging.
 */

export interface DragHandlers {
  /** CSS px the pointer must travel before the drag starts (default 3). */
  threshold?: number;
  /** Cursor shown everywhere while dragging. */
  cursor?: string;
  onStart?(ev: PointerEvent): void;
  /** Client-px offsets from the pointer-down position. */
  onMove?(ev: PointerEvent, dx: number, dy: number): void;
  /** Pointer released; `moved` is false for a plain click. */
  onEnd?(ev: PointerEvent, moved: boolean): void;
  /** Escape pressed / pointer cancelled during the drag. */
  onCancel?(): void;
}

let active: (() => void) | null = null;

/** True while a drag started here is in progress. */
export const isDragging = () => active !== null;

export function trackPointer(down: { clientX: number; clientY: number; pointerId: number }, h: DragHandlers): void {
  active?.();
  const x0 = down.clientX;
  const y0 = down.clientY;
  const id = down.pointerId;
  const threshold = h.threshold ?? 3;
  let moved = false;
  const root = document.documentElement;

  const cleanup = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    root.classList.remove('edit-pdf-dragging');
    root.style.removeProperty('--edit-pdf-drag-cursor');
    if (active === cleanup) active = null;
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved) {
      if (Math.hypot(dx, dy) < threshold) return;
      moved = true;
      if (h.cursor) {
        root.style.setProperty('--edit-pdf-drag-cursor', h.cursor);
        root.classList.add('edit-pdf-dragging');
      }
      h.onStart?.(ev);
    }
    ev.preventDefault();
    h.onMove?.(ev, dx, dy);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    cleanup();
    h.onEnd?.(ev, moved);
  };
  const cancel = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    cleanup();
    h.onCancel?.();
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    cleanup();
    h.onCancel?.();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
  active = cleanup;
}
