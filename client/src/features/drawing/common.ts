/** Small helpers shared by the drawing object types and tools. */
import { PDFHexString } from '@cantoo/pdf-lib';
import type { DocId, Point, Rect } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import { isReadOnly } from '@/core/engine';
import { bboxOf } from './geom';

/** Blocks drawing on documents whose bytes can't be written (undecryptable / read-only). */
export function canDraw(docId: DocId | null | undefined, quiet = false): boolean {
  if (!docId || !getDoc(docId)) return false;
  if (isReadOnly(docId)) {
    if (!quiet) actions.toast('This document is open read-only, so drawings and stamps can’t be added.', { kind: 'warning' });
    return false;
  }
  return true;
}

/** PDF text string (for /Subj, /Contents, /R … values in `extra`). */
export const pdfText = (s: string) => PDFHexString.fromText(s);

/** Flat [x0 y0 x1 y1 …] number array. */
export const flatPts = (pts: Point[]) => pts.flatMap((p) => [round(p.x), round(p.y)]);
export const round = (v: number) => Math.round(v * 1000) / 1000;

export function pairs(nums: number[] | undefined): Point[] {
  const out: Point[] = [];
  if (!nums) return out;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) out.push({ x: nums[i], y: nums[i + 1] });
  }
  return out;
}

/** Scale points from the content box of `from` to that of `to` (both padded by `pad`). */
export function mapPoints(pts: Point[], from: Rect, to: Rect, pad: number): Point[] {
  const f = shrink(from, pad);
  const t = shrink(to, pad);
  const sx = f.width > 1e-6 ? t.width / f.width : 1;
  const sy = f.height > 1e-6 ? t.height / f.height : 1;
  const ox = f.width > 1e-6 ? t.x : t.x + t.width / 2 - f.width / 2;
  const oy = f.height > 1e-6 ? t.y : t.y + t.height / 2 - f.height / 2;
  return pts.map((p) => ({ x: ox + (p.x - f.x) * sx, y: oy + (p.y - f.y) * sy }));
}
function shrink(r: Rect, d: number): Rect {
  const dx = Math.min(d, r.width / 2 - 0.01), dy = Math.min(d, r.height / 2 - 0.01);
  return { x: r.x + Math.max(0, dx), y: r.y + Math.max(0, dy), width: r.width - 2 * Math.max(0, dx), height: r.height - 2 * Math.max(0, dy) };
}

export const pointsBox = (pts: Point[]): Rect => bboxOf(pts) ?? { x: 0, y: 0, width: 0, height: 0 };

export function plural(n: number, word: string, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

/** Hit tolerance in PDF units for a screen tolerance of `px` CSS pixels. */
export const hitWidthFor = (scale: number, px = 8) => px / Math.max(0.05, scale);
