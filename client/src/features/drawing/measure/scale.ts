/** Measurement math: scale ratios, unit conversion, value formatting and the PDF /Measure dictionary. */
import type { Point } from '@/core/types';
import { pathLength, signedArea } from '../geom';
import type { DocUnit, MeasureScale, MeasureType, RealUnit } from '../model';
import { DOC_UNITS, REAL_UNITS } from '../model';

/** Points per document unit. */
const PT_PER: Record<DocUnit, number> = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54 };

export const DEFAULT_SCALE: MeasureScale = { docValue: 1, docUnit: 'in', realValue: 1, realUnit: 'in' };

/** Real-world units per PDF point. */
export function realPerPt(s: MeasureScale): number {
  const doc = s.docValue > 0 ? s.docValue : 1;
  const real = s.realValue > 0 ? s.realValue : 1;
  return real / (doc * PT_PER[s.docUnit]);
}

export function measureValue(type: MeasureType, pts: Point[], s: MeasureScale): number {
  const k = realPerPt(s);
  if (type === 'area') return pts.length >= 3 ? Math.abs(signedArea(pts)) * k * k : 0;
  if (type === 'distance') return pts.length >= 2 ? pathLength(pts.slice(0, 2)) * k : 0;
  return pathLength(pts) * k;
}

export function unitLabel(type: MeasureType, unit: RealUnit): string {
  return type === 'area' ? `sq ${unit}` : unit;
}

export function formatMeasure(value: number, type: MeasureType, unit: RealUnit, precision: number): string {
  const p = Math.max(0, Math.min(6, Math.round(precision)));
  return `${(Number.isFinite(value) ? value : 0).toFixed(p)} ${unitLabel(type, unit)}`;
}

const trim = (n: number) => String(Number(n.toFixed(6)));
export function ratioString(s: MeasureScale): string {
  return `${trim(s.docValue)} ${s.docUnit} = ${trim(s.realValue)} ${s.realUnit}`;
}

/** Parse "1 in = 10 ft" (the /R entry). */
export function parseRatio(r: string | undefined): MeasureScale | null {
  if (!r) return null;
  const m = /^\s*([\d.]+)\s*([a-z]+)\s*=\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(r);
  if (!m) return null;
  const docUnit = m[2].toLowerCase() as DocUnit;
  const realUnit = m[4].toLowerCase() as RealUnit;
  const docValue = Number(m[1]);
  const realValue = Number(m[3]);
  if (!DOC_UNITS.includes(docUnit) || !REAL_UNITS.includes(realUnit) || !(docValue > 0) || !(realValue > 0)) return null;
  return { docValue, docUnit, realValue, realUnit };
}

export const isRealUnit = (u: string): u is RealUnit => (REAL_UNITS as string[]).includes(u);
