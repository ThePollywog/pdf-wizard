/**
 * Shapes of text markups and carets in PDF user space, shared by the SVG renderer and the PDF
 * appearance streams (so both always match).
 */
import type { Point, Rect } from '@/core/types';
import type { MarkupType, TextDir } from './model';
import { quadList, quadsBBox } from './quads';

export interface MarkupShapes {
  /** Filled polygons (highlight). */
  polys: Point[][];
  /** Stroked polylines (underline, strikeout, squiggly). */
  lines: { pts: Point[]; width: number }[];
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function markupShapes(type: MarkupType, quads: number[]): MarkupShapes {
  const polys: Point[][] = [];
  const lines: MarkupShapes['lines'] = [];
  for (const [tl, tr, bl, br] of quadList(quads)) {
    if (type === 'highlight') {
      polys.push([tl, tr, br, bl]);
      continue;
    }
    const len = Math.hypot(br.x - bl.x, br.y - bl.y);
    const h = Math.hypot(tl.x - bl.x, tl.y - bl.y);
    if (len <= 0 || h <= 0) continue;
    const u = { x: (br.x - bl.x) / len, y: (br.y - bl.y) / len };
    const v = { x: (tl.x - bl.x) / h, y: (tl.y - bl.y) / h };
    const P = (a: number, b: number): Point => ({ x: bl.x + a * u.x + b * v.x, y: bl.y + a * u.y + b * v.y });
    const w = clampN(h / 14, 0.6, 3);
    if (type === 'underline') {
      const b = w / 2 + h * 0.05;
      lines.push({ pts: [P(0, b), P(len, b)], width: w });
    } else if (type === 'strikeout') {
      const b = h * 0.42;
      lines.push({ pts: [P(0, b), P(len, b)], width: w });
    } else {
      const amp = clampN(h / 12, 0.6, 4);
      const period = clampN(h / 4, 2, 10);
      const base = amp + w / 2;
      const pts: Point[] = [];
      let up = false;
      for (let a = 0; a < len; a += period / 2) {
        pts.push(P(a, up ? base + amp : base - amp));
        up = !up;
      }
      pts.push(P(len, up ? base + amp : base - amp));
      lines.push({ pts, width: Math.max(0.5, w * 0.85) });
    }
  }
  return { polys, lines };
}

/** Bounding box of the markup drawing (quads + stroke). */
export function markupBounds(quads: number[]): Rect {
  const r = quadsBBox(quads);
  return { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 };
}

/**
 * Caret glyph (filled "^" with curved sides) inside `r`, pointing into the text line for `dir`.
 * Returns cubic segments: start + 2 curves (closed).
 */
export function caretPath(r: Rect, dir: TextDir = 0): { start: Point; curves: [Point, Point, Point][] } {
  // Upright caret in unit space (0..1, y up): tip at (0.5, 1), feet at (0,0) and (1,0).
  const unit: { start: Point; curves: [Point, Point, Point][] } = {
    start: { x: 0, y: 0 },
    curves: [
      [{ x: 0.35, y: 0.2 }, { x: 0.45, y: 0.6 }, { x: 0.5, y: 1 }],
      [{ x: 0.55, y: 0.6 }, { x: 0.65, y: 0.2 }, { x: 1, y: 0 }],
    ],
  };
  const map = (p: Point): Point => {
    let q: Point;
    switch (dir) {
      case 90: // text runs +y, "up" is -x
        q = { x: 1 - p.y, y: p.x };
        break;
      case 180:
        q = { x: 1 - p.x, y: 1 - p.y };
        break;
      case 270:
        q = { x: p.y, y: 1 - p.x };
        break;
      default:
        q = p;
    }
    return { x: r.x + q.x * r.width, y: r.y + q.y * r.height };
  };
  return { start: map(unit.start), curves: unit.curves.map((c) => c.map(map) as [Point, Point, Point]) };
}
