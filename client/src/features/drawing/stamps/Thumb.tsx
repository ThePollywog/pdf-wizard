/** Small, crisp preview of a stamp design (used by the stamp palette and the options bar). */
import { useMemo } from 'react';
import type { StampData } from '../model';
import { PaintSvg } from '../svg';
import { stampDesign } from './draw';

export function StampThumb({ data, maxW, maxH, className }: { data: StampData; maxW: number; maxH: number; className?: string }) {
  const design = useMemo(() => stampDesign({ ...data, rotation: 0 }), [data]);
  const k = Math.min(maxW / design.w, maxH / design.h, 2);
  const w = Math.max(1, design.w * k);
  const h = Math.max(1, design.h * k);
  return (
    <PaintSvg
      paints={design.paints}
      m={[k, 0, 0, -k, 0, h]}
      className={className ? `drawing-thumb ${className}` : 'drawing-thumb'}
      style={{ width: w, height: h }}
    />
  );
}
