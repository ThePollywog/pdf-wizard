/**
 * QuadPoints helpers. A quad is 8 numbers: TL, TR, BL, BR in the *text's* frame (conventional order),
 * i.e. TL→TR runs along the text direction and BL→TL points "up" from the baseline.
 */
import type { DocId, Point, Rect, TextSelectionInfo } from '@/core/types';
import * as engine from '@/core/engine';
import { mapPoint, rectToQuad } from '@/core/geometry';
import type { TextDir } from './model';

export type Quad = [Point, Point, Point, Point]; // TL, TR, BL, BR

export function quadList(q: number[]): Quad[] {
  const out: Quad[] = [];
  for (let i = 0; i + 7 < q.length; i += 8) {
    out.push([
      { x: q[i], y: q[i + 1] },
      { x: q[i + 2], y: q[i + 3] },
      { x: q[i + 4], y: q[i + 5] },
      { x: q[i + 6], y: q[i + 7] },
    ]);
  }
  return out;
}

export function flattenQuads(quads: Quad[]): number[] {
  const out: number[] = [];
  for (const q of quads) for (const p of q) out.push(p.x, p.y);
  return out;
}

export function quadsBBox(q: number[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < q.length; i += 2) {
    x0 = Math.min(x0, q[i]);
    x1 = Math.max(x1, q[i]);
    y0 = Math.min(y0, q[i + 1]);
    y1 = Math.max(y1, q[i + 1]);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function translateQuads(q: number[], dx: number, dy: number): number[] {
  return q.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
}

export function mapQuads(q: number[], from: Rect, to: Rect): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < q.length; i += 2) {
    const p = mapPoint({ x: q[i], y: q[i + 1] }, from, to);
    out.push(p.x, p.y);
  }
  return out;
}

/** Quad of an axis-aligned rect for text running in direction `dir` (degrees CCW in user space). */
export function quadFromRect(r: Rect, dir: TextDir = 0): number[] {
  const x0 = r.x, x1 = r.x + r.width, y0 = r.y, y1 = r.y + r.height;
  switch (dir) {
    case 90: // text runs up (+y), "up" is -x
      return [x0, y0, x0, y1, x1, y0, x1, y1];
    case 180:
      return [x1, y0, x0, y0, x1, y1, x0, y1];
    case 270: // text runs down (-y), "up" is +x
      return [x1, y1, x1, y0, x0, y1, x0, y0];
    default:
      return rectToQuad(r);
  }
}

/** Direction of a quad (angle of TL→TR snapped to 90°). */
export function quadDir(q: Quad): TextDir {
  const a = (Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180) / Math.PI;
  return snapDir(a);
}

export function snapDir(angle: number): TextDir {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return a as TextDir;
}

const overlap = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/** Text direction of each selection rect, from the page's text items (falls back to the rect shape). */
export async function directionsFor(docId: DocId, pageIndex: number, rects: Rect[]): Promise<TextDir[]> {
  let items: { rect: Rect; transform: number[] }[] = [];
  try {
    items = (await engine.getPageText(docId, pageIndex)).items;
  } catch {
    items = [];
  }
  return rects.map((r) => {
    const votes = new Map<TextDir, number>();
    for (const it of items) {
      const o = overlap(r, it.rect);
      if (o <= 0) continue;
      const t = it.transform;
      const d = snapDir((Math.atan2(t[1], t[0]) * 180) / Math.PI);
      votes.set(d, (votes.get(d) ?? 0) + o);
    }
    let best: TextDir | null = null;
    let bestV = 0;
    for (const [d, v] of votes) if (v > bestV) (best = d), (bestV = v);
    if (best !== null) return best;
    return r.height > r.width * 1.5 ? 90 : 0;
  });
}

/**
 * Joins the fragments of one line (the text layer has one element per text run, so a line can
 * come in several pieces) into a single rect, like the usual one quad per line.
 */
export function mergeLineRects(rects: Rect[], dirs: TextDir[]): { rects: Rect[]; dirs: TextDir[] } {
  const outR: Rect[] = [];
  const outD: TextDir[] = [];
  rects.forEach((r, i) => {
    const dir = dirs[i];
    const vertical = dir === 90 || dir === 270;
    // across = the axis perpendicular to the text; along = the text direction
    const a0 = vertical ? r.x : r.y;
    const a1 = vertical ? r.x + r.width : r.y + r.height;
    const l0 = vertical ? r.y : r.x;
    const l1 = vertical ? r.y + r.height : r.x + r.width;
    const k = outR.findIndex((o, j) => {
      if (outD[j] !== dir) return false;
      const b0 = vertical ? o.x : o.y;
      const b1 = vertical ? o.x + o.width : o.y + o.height;
      const m0 = vertical ? o.y : o.x;
      const m1 = vertical ? o.y + o.height : o.x + o.width;
      const ov = Math.min(a1, b1) - Math.max(a0, b0);
      const minH = Math.min(a1 - a0, b1 - b0);
      if (ov < minH * 0.6) return false;
      const gap = Math.max(l0, m0) - Math.min(l1, m1);
      return gap <= Math.max(a1 - a0, b1 - b0) * 1.5;
    });
    if (k < 0) {
      outR.push({ ...r });
      outD.push(dir);
      return;
    }
    const o = outR[k];
    const x0 = Math.min(o.x, r.x);
    const y0 = Math.min(o.y, r.y);
    outR[k] = { x: x0, y: y0, width: Math.max(o.x + o.width, r.x + r.width) - x0, height: Math.max(o.y + o.height, r.y + r.height) - y0 };
  });
  return { rects: outR, dirs: outD };
}

/** Quads (one per line) for a text selection on one page. */
export async function quadsForSelection(sel: TextSelectionInfo): Promise<{ quads: number[]; dirs: TextDir[] }> {
  const raw = sel.rects.filter((r) => r.width > 0.2 && r.height > 0.2);
  const merged = mergeLineRects(raw, await directionsFor(sel.docId, sel.pageIndex, raw));
  const quads: number[] = [];
  merged.rects.forEach((r, i) => quads.push(...quadFromRect(r, merged.dirs[i])));
  return { quads, dirs: merged.dirs };
}

/** Insertion point at the end of the last quad: the point on its baseline-side end + line height. */
export function endOfQuads(q: number[]): { at: Point; height: number; dir: TextDir } | null {
  const list = quadList(q);
  const last = list[list.length - 1];
  if (!last) return null;
  const [, tr, , br] = last;
  const height = Math.hypot(tr.x - br.x, tr.y - br.y);
  return { at: { x: br.x, y: br.y }, height, dir: quadDir(last) };
}

/** Caret rect centered on a baseline point for the given direction. */
export function caretRectAt(at: Point, lineHeight: number, dir: TextDir = 0): Rect {
  const s = Math.max(7, Math.min(24, lineHeight * 0.62));
  // Tip slightly above the baseline, body below it (in text space).
  const up = s * 0.45;
  const down = s - up;
  switch (dir) {
    case 90: // "up" is -x
      return { x: at.x - up, y: at.y - s / 2, width: s, height: s };
    case 180:
      return { x: at.x - s / 2, y: at.y - up, width: s, height: s };
    case 270: // "up" is +x
      return { x: at.x - down, y: at.y - s / 2, width: s, height: s };
    default:
      return { x: at.x - s / 2, y: at.y - down, width: s, height: s };
  }
}
