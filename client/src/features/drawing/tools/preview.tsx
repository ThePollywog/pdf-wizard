/** Live previews drawn by the tool overlays (same paint lists as the final objects). */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Point } from '@/core/types';
import { matOf } from '../geom';
import type { Paint } from '../paint';
import { PaintSvg } from '../svg';
import { usePageLayer } from '../layers';

export function OverlayPaints({
  toView,
  paints,
  opacity = 1,
  blend,
  testid = 'drawing-preview',
  children,
}: {
  toView(p: Point): { x: number; y: number };
  paints: Paint[];
  opacity?: number;
  /** Multiply blend against the page (highlighter). */
  blend?: boolean;
  testid?: string;
  children?: ReactNode;
}) {
  const m = useMemo(() => matOf(toView), [toView]);
  const anchor = useRef<HTMLSpanElement>(null);
  const layer = usePageLayer(anchor, 'blend', !!blend);
  const svg = (
    <PaintSvg paints={paints} m={m} opacity={opacity} className={blend ? 'drawing-blend drawing-preview' : 'drawing-preview'} data-testid={testid}>
      {children}
    </PaintSvg>
  );
  return (
    <>
      <span ref={anchor} hidden className="drawing-anchor" />
      {blend ? layer && createPortal(svg, layer) : svg}
    </>
  );
}

/** Re-render at most once per animation frame. */
export function useFrameTick(): () => void {
  const [, setN] = useState(0);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setN((n) => n + 1);
    });
  }, []);
}
