/**
 * Rendering helpers for comment objects.
 *
 * `PageUnderlay` portals content into the object's `.pdfwizard-page`, between the page canvas (z 0) and
 * the objects layer (z 3). Blend modes only reach the page from there: the objects layer is its own
 * stacking context, so a `mix-blend-mode: multiply` inside it would blend with nothing.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PageViewport } from 'pdfjs-dist';
import type { Point } from '@/core/types';
import { toView } from '@/core/geometry';

export function PageUnderlay({ children, className, style, objId }: { children: ReactNode; className?: string; style?: CSSProperties; objId: string }) {
  const probe = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(probe.current?.closest<HTMLElement>('.pdfwizard-page') ?? null);
  }, []);
  return (
    <>
      <span ref={probe} hidden />
      {host &&
        createPortal(
          <div className={`comments-portal ${className ?? ''}`} style={style} data-underlay-for={objId} aria-hidden="true">
            {children}
          </div>,
          host,
        )}
    </>
  );
}

export const fmt = (v: number) => (Math.abs(v) < 1e-4 ? '0' : Number(v.toFixed(2)).toString());

export function svgPoints(pts: { x: number; y: number }[]): string {
  return pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
}

export function svgPolyline(pts: { x: number; y: number }[], close = false): string {
  if (!pts.length) return '';
  return `M${pts.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' L')}${close ? ' Z' : ''}`;
}

/** Page-local CSS px of a PDF point. */
export function viewPt(vp: PageViewport, p: Point): { x: number; y: number } {
  return toView(vp, p);
}
