/**
 * Shared object renderer: draws a paint list inside the object wrapper (PDF → box-local px), with
 * transparent hit paths for `hit: 'shape'` kinds. Highlighter ink is portalled into the page's
 * blend layer (mix-blend-mode: multiply against the page canvas) and keeps only its hit paths here.
 */
import { useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ObjectRenderProps, PdfObject } from '@/core/types';
import { matMul, matOf, type Mat } from './geom';
import type { Paint } from './paint';
import { PaintSvg } from './svg';
import { usePageLayer } from './layers';
import { hitWidthFor } from './common';

export function useLocalMatrix(toLocal: ObjectRenderProps['toLocal']): Mat {
  return useMemo(() => matOf(toLocal), [toLocal]);
}

export function PaintObject<T extends PdfObject>({
  p,
  paints,
  blend,
  hit = true,
  children,
}: {
  p: ObjectRenderProps<T>;
  paints: Paint[];
  /** Multiply blend (highlighter). */
  blend?: boolean;
  /** Render hit paths (for hit: 'shape' kinds). */
  hit?: boolean;
  children?: ReactNode;
}) {
  const { obj, toLocal, box, scale } = p;
  const m = useLocalMatrix(toLocal);
  const anchor = useRef<HTMLSpanElement>(null);
  const layer = usePageLayer(anchor, 'blend', !!blend);
  const opacity = obj.opacity ?? 1;
  const hitWidth = hit ? hitWidthFor(scale) : undefined;
  const testid = `drawing-obj-${obj.kind}`;
  if (blend) {
    const pageM = matMul([1, 0, 0, 1, box.left, box.top], m);
    return (
      <>
        <span ref={anchor} hidden className="drawing-anchor" />
        {hitWidth !== undefined && <PaintSvg paints={paints} m={m} hitWidth={hitWidth} hitOnly data-testid={testid} />}
        {layer && createPortal(<PaintSvg paints={paints} m={pageM} opacity={opacity} className="drawing-blend" data-testid={`${testid}-blend`} />, layer)}
        {children}
      </>
    );
  }
  return (
    <>
      <PaintSvg paints={paints} m={m} opacity={opacity} hitWidth={hitWidth} data-testid={testid} />
      {children}
    </>
  );
}
