/**
 * Floating-layer infrastructure shared by modals, menus, popovers and the command palette:
 *  - an Escape stack (the top-most layer consumes Escape; nothing below sees it),
 *  - a monotonically increasing layer order so "outside click" logic can ignore clicks inside
 *    layers that were opened later (e.g. a colour popover opened from inside a popover),
 *  - focus helpers (focusable elements, focus trap).
 */
import { useEffect, useRef } from 'react';

// ── Escape stack ────────────────────────────────────────────────────────────

interface EscEntry { id: number; handler: () => void }
const escStack: EscEntry[] = [];
let escId = 0;
let escInstalled = false;

function installEscape() {
  if (escInstalled || typeof document === 'undefined') return;
  escInstalled = true;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.isComposing || escStack.length === 0) return;
      const top = escStack[escStack.length - 1];
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      top.handler();
    },
    true,
  );
}

/** Register an Escape handler on top of the stack. Returns an unregister function. */
export function pushEscape(handler: () => void): () => void {
  installEscape();
  const entry = { id: ++escId, handler };
  escStack.push(entry);
  return () => {
    const i = escStack.indexOf(entry);
    if (i >= 0) escStack.splice(i, 1);
  };
}

/** True while at least one layer (modal, menu, popover…) is capturing Escape. */
export const hasEscapeLayer = () => escStack.length > 0;

/** Consume Escape while `active`, calling the latest `handler`. */
export function useEscapeLayer(active: boolean, handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return pushEscape(() => ref.current());
  }, [active]);
}

// ── Layer ordering ──────────────────────────────────────────────────────────

let layerCounter = 0;
export const nextLayerOrder = () => ++layerCounter;

/** Attribute put on every floating layer root (value = its order). */
export const LAYER_ATTR = 'data-layer';

/** Is `target` inside a floating layer opened after `order`? */
export function isInLaterLayer(target: EventTarget | null, order: number): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    const v = el.getAttribute?.(LAYER_ATTR);
    if (v != null && Number(v) > order) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Calls onClose when the user presses the pointer outside of `refs` (and outside of any layer
 * opened later than `order`).
 */
export function useOutsidePointerDown(
  active: boolean,
  getElements: () => (Element | null | undefined)[],
  onOutside: (e: PointerEvent) => void,
  order: number,
) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  const els = useRef(getElements);
  els.current = getElements;
  useEffect(() => {
    if (!active) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (els.current().some((el) => el && el.contains(t))) return;
      if (isInLaterLayer(t as Element, order)) return;
      cb.current(e);
    };
    // Defer so the event that opened the layer does not immediately close it.
    const id = window.setTimeout(() => document.addEventListener('pointerdown', h, true), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', h, true);
    };
  }, [active, order]);
}

// ── Focus helpers ───────────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0 && !el.closest('[inert]'),
  );
}

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t instanceof HTMLElement ? t : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}
