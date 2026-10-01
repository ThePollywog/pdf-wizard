/**
 * Per-page DOM layers owned by the drawing feature, mounted inside the viewer's `.pdfwizard-page`:
 *  - `drawing-blend-layer`: highlighter ink rendered with mix-blend-mode: multiply against the page
 *    canvas (`.pdfwizard-objects` is its own stacking context, so blending inside it would not reach it);
 *  - `drawing-vertex-layer`: vertex handles of selected lines / polygons / measurements (above the
 *    selection frame so individual points can be dragged).
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export type PageLayerKind = 'blend' | 'vertex';

const refCounts = new WeakMap<HTMLElement, number>();

function acquire(page: HTMLElement, kind: PageLayerKind): HTMLElement {
  const cls = `drawing-${kind}-layer`;
  let el = page.querySelector<HTMLElement>(`:scope > .${cls}`);
  if (!el) {
    el = document.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', kind === 'blend' ? 'true' : 'false');
    const objects = page.querySelector(':scope > .pdfwizard-objects');
    if (kind === 'blend' && objects) page.insertBefore(el, objects);
    else page.appendChild(el);
  }
  refCounts.set(el, (refCounts.get(el) ?? 0) + 1);
  return el;
}

function release(el: HTMLElement) {
  const n = (refCounts.get(el) ?? 1) - 1;
  refCounts.set(el, n);
  if (n <= 0 && el.childElementCount === 0) el.remove();
}

/** Returns the page layer element (after mount) for the page containing `anchor`. */
export function usePageLayer(anchor: RefObject<Element | null>, kind: PageLayerKind, enabled = true): HTMLElement | null {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      setLayer(null);
      return;
    }
    const page = anchor.current?.closest<HTMLElement>('.pdfwizard-page');
    if (!page) return;
    const el = acquire(page, kind);
    setLayer(el);
    return () => {
      // Children are removed by React after this cleanup; defer the empty check.
      queueMicrotask(() => release(el));
    };
  }, [anchor, kind, enabled]);
  return layer;
}
