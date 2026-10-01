/**
 * Viewport-aware positioning for floating elements (menus, popovers, tooltips).
 * Positions are `position: fixed` coordinates computed from getBoundingClientRect, with flipping
 * to the opposite side when there is not enough room and clamping to the viewport.
 */
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';
export type Placement = Side | `${Side}-${'start' | 'end'}`;

export interface AnchorRect { left: number; top: number; width: number; height: number }

const MARGIN = 8;

export function rectOf(el: Element | AnchorRect | null | undefined): AnchorRect | null {
  if (!el) return null;
  if (el instanceof Element) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return el;
}

export function computePosition(
  anchor: AnchorRect,
  size: { width: number; height: number },
  placement: Placement,
  offset = 6,
): { left: number; top: number; side: Side } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let [side, alignRaw] = placement.split('-') as [Side, 'start' | 'end' | undefined];
  const align: Align = alignRaw ?? 'center';

  const room = {
    top: anchor.top - offset - MARGIN,
    bottom: vh - (anchor.top + anchor.height) - offset - MARGIN,
    left: anchor.left - offset - MARGIN,
    right: vw - (anchor.left + anchor.width) - offset - MARGIN,
  };
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const need = side === 'top' || side === 'bottom' ? size.height : size.width;
  if (room[side] < need && room[opposite[side]] > room[side]) side = opposite[side];

  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.top + anchor.height + offset : anchor.top - offset - size.height;
    if (align === 'start') left = anchor.left;
    else if (align === 'end') left = anchor.left + anchor.width - size.width;
    else left = anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    left = side === 'right' ? anchor.left + anchor.width + offset : anchor.left - offset - size.width;
    if (align === 'start') top = anchor.top;
    else if (align === 'end') top = anchor.top + anchor.height - size.height;
    else top = anchor.top + anchor.height / 2 - size.height / 2;
  }
  left = Math.max(MARGIN, Math.min(left, vw - size.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - size.height - MARGIN));
  return { left: Math.round(left), top: Math.round(top), side };
}

/**
 * Keeps a floating element positioned next to an anchor while open. Returns a ref for the
 * floating element and the style to spread on it. Recomputes on resize/scroll/content size.
 */
export function useFloating<T extends HTMLElement = HTMLDivElement>(opts: {
  open: boolean;
  anchor: () => Element | AnchorRect | null | undefined;
  placement: Placement;
  offset?: number;
  /** Set the floating min-width to the anchor width. */
  matchWidth?: boolean;
}) {
  const ref = useRef<T | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: Side; minWidth?: number } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const update = useCallback(() => {
    const el = ref.current;
    const { anchor, placement, offset, matchWidth } = optsRef.current;
    const a = rectOf(anchor());
    if (!el || !a) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const p = computePosition(a, size, placement, offset ?? 6);
    setPos((prev) =>
      prev && prev.left === p.left && prev.top === p.top && prev.side === p.side ? prev : { ...p, minWidth: matchWidth ? a.width : undefined },
    );
  }, []);

  useLayoutEffect(() => {
    if (!opts.open) {
      setPos(null);
      return;
    }
    update();
    const onWin = () => update();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onWin) : null;
    if (ref.current && ro) ro.observe(ref.current);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
      ro?.disconnect();
    };
  }, [opts.open, update]);

  const style: CSSProperties = pos
    ? { position: 'fixed', left: pos.left, top: pos.top, minWidth: pos.minWidth }
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };
  return { ref, style, side: pos?.side ?? (opts.placement.split('-')[0] as Side), update };
}
