/**
 * Geometry helpers between PDF user space (points, y-up, unrotated) and view space
 * (CSS px relative to the rendered page's top-left, including zoom + rotation).
 */
import type { PageViewport } from 'pdfjs-dist';
import type { Point, Rect, ViewBox } from './types';

export function toView(viewport: PageViewport, p: Point): { x: number; y: number } {
  const [x, y] = viewport.convertToViewportPoint(p.x, p.y);
  return { x, y };
}

export function toPdf(viewport: PageViewport, x: number, y: number): Point {
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return { x: px, y: py };
}

/** PDF rect → axis-aligned CSS box on the rendered page (works for any 90° rotation). */
export function rectToView(viewport: PageViewport, r: Rect): ViewBox {
  const [x1, y1] = viewport.convertToViewportPoint(r.x, r.y);
  const [x2, y2] = viewport.convertToViewportPoint(r.x + r.width, r.y + r.height);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return { left, top, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** CSS box on the rendered page → PDF rect. */
export function viewToRect(viewport: PageViewport, b: ViewBox): Rect {
  const a = toPdf(viewport, b.left, b.top);
  const c = toPdf(viewport, b.left + b.width, b.top + b.height);
  return rectFromPoints(a, c);
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function rectOfPoints(points: Point[], pad = 0): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX - pad, y: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}

export function unionRects(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function inflateRect(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Map a point from one rect to another (used when resizing objects that store coordinates). */
export function mapPoint(p: Point, from: Rect, to: Rect): Point {
  const sx = from.width === 0 ? 1 : to.width / from.width;
  const sy = from.height === 0 ? 1 : to.height / from.height;
  return { x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy };
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { ...r, x: r.x + dx, y: r.y + dy };
}

/** PDF QuadPoints for a rect in conventional order: TL, TR, BL, BR. */
export function rectToQuad(r: Rect): number[] {
  const x1 = r.x, x2 = r.x + r.width, yb = r.y, yt = r.y + r.height;
  return [x1, yt, x2, yt, x1, yb, x2, yb];
}

/** Inverse of rectToQuad (tolerant of any corner order). */
export function quadToRect(q: number[]): Rect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
