/** Measure tool options, point snapping and the live readout shared by the measure tools and panel. */
import { create } from 'zustand';
import type { DocId, PageId, Point } from '@/core/types';
import { getDoc, getToolOptions, objectsOnPage, useToolOptions } from '@/core/store';
import { MEASURE_DEFAULTS, MEASURE_OPTS_KEY, type MeasureScale, type MeasureType } from '../model';
import { dist } from '../geom';
import { formatMeasure, measureValue } from './scale';

export type MeasureOptions = typeof MEASURE_DEFAULTS;
export const getMeasureOptions = (): MeasureOptions => getToolOptions(MEASURE_OPTS_KEY, MEASURE_DEFAULTS);
export const useMeasureOptions = (): MeasureOptions => useToolOptions(MEASURE_OPTS_KEY, MEASURE_DEFAULTS);
export const scaleOf = (o: Pick<MeasureOptions, 'docValue' | 'docUnit' | 'realValue' | 'realUnit'>): MeasureScale => ({
  docValue: o.docValue,
  docUnit: o.docUnit,
  realValue: o.realValue,
  realUnit: o.realUnit,
});

/** Live value while measuring (shown in the options bar, the Measure panel and next to the cursor). */
export const useMeasureLive = create<{ type: MeasureType | null; text: string | null }>(() => ({ type: null, text: null }));

export function liveText(type: MeasureType, pts: Point[], o: MeasureOptions = getMeasureOptions()): string {
  return formatMeasure(measureValue(type, pts, scaleOf(o)), type, o.realUnit, o.precision);
}
export function setLive(type: MeasureType | null, pts?: Point[]) {
  useMeasureLive.setState(type && pts ? { type, text: liveText(type, pts) } : { type: null, text: null });
}

/** Points worth snapping to on a page: vertices of lines, polygons, measurements and box corners. */
export function snapTargets(docId: DocId, pageId: PageId): Point[] {
  const doc = getDoc(docId);
  if (!doc) return [];
  const out: Point[] = [];
  for (const o of objectsOnPage(doc, pageId)) {
    const d = o.data as Record<string, unknown>;
    if (o.kind === 'line') out.push(d.start as Point, d.end as Point);
    else if (o.kind === 'poly') out.push(...(d.vertices as Point[]));
    else if (o.kind === 'measure') out.push(...(d.points as Point[]));
    else if (o.kind === 'shape' && (d.type as string) !== 'ellipse') {
      const r = o.rect;
      out.push({ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x, y: r.y + r.height }, { x: r.x + r.width, y: r.y + r.height });
    }
  }
  return out;
}

/** Snap `p` to the nearest target within `px` screen pixels. */
export function snapPoint(p: Point, targets: Point[], scale: number, px = 8): { p: Point; snapped: boolean } {
  const tol = px / Math.max(0.05, scale);
  let best: Point | null = null;
  let bd = tol;
  for (const t of targets) {
    const d = dist(p, t);
    if (d <= bd) {
      bd = d;
      best = t;
    }
  }
  return best ? { p: { x: best.x, y: best.y }, snapped: true } : { p, snapped: false };
}
