/**
 * Geometry helpers for the drawing feature: vectors, matrices, path smoothing / simplification,
 * Shift constraints, clouds, line endings and eraser splitting. Pure functions, PDF space.
 */
import type { Point, Rect, Rotation } from '@/core/types';

export type Mat = [number, number, number, number, number, number];
export type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const len = (a: Point) => Math.hypot(a.x, a.y);
export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export function norm(a: Point): Point {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}
/** Rotate a vector by `deg` degrees (counter-clockwise in y-up space). */
export function rot(a: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

// ── matrices ─────────────────────────────────────────────────────────────────
/** a ∘ b (apply b first). */
export function matMul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export const apply = (m: Mat, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export function matInvert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
/** Affine matrix of a point mapping function (e.g. toLocal / toView). */
export function matOf(f: (p: Point) => { x: number; y: number }): Mat {
  const o = f({ x: 0, y: 0 });
  const ex = f({ x: 1, y: 0 });
  const ey = f({ x: 0, y: 1 });
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y];
}

// ── display frames (page rotation) ───────────────────────────────────────────
/** PDF-space unit vectors pointing to display right (eu) and display down (ev) for a page rotation. */
export function displayAxes(rotation: Rotation): { eu: Point; ev: Point } {
  switch (rotation) {
    case 90:
      return { eu: { x: 0, y: 1 }, ev: { x: 1, y: 0 } };
    case 180:
      return { eu: { x: -1, y: 0 }, ev: { x: 0, y: 1 } };
    case 270:
      return { eu: { x: 0, y: -1 }, ev: { x: -1, y: 0 } };
    default:
      return { eu: { x: 1, y: 0 }, ev: { x: 0, y: -1 } };
  }
}
/** Size of `rect` as seen on a page displayed with `rotation`. */
export function displaySize(rect: Rect, rotation: Rotation) {
  return rotation % 180 === 0 ? { w: rect.width, h: rect.height } : { w: rect.height, h: rect.width };
}
/**
 * Matrix mapping a local display-oriented frame of `rect` (x right, y up on screen, origin at the
 * displayed bottom-left corner) to PDF user space.
 */
export function rectFrame(rect: Rect, rotation: Rotation): Mat {
  const { eu, ev } = displayAxes(rotation);
  const { h } = displaySize(rect, rotation);
  const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  const origin =
    rotation === 90 ? { x: x0, y: y0 } : rotation === 180 ? { x: x1, y: y0 } : rotation === 270 ? { x: x1, y: y1 } : { x: x0, y: y1 };
  const obl = add(origin, mul(ev, h));
  return [eu.x, eu.y, -ev.x, -ev.y, obl.x, obl.y];
}
/** Frame (x right, y up on screen) centered at `p`. */
export function pointFrame(p: Point, rotation: Rotation): Mat {
  const { eu, ev } = displayAxes(rotation);
  return [eu.x, eu.y, -ev.x, -ev.y, p.x, p.y];
}
/** Rect (PDF space) of a display-oriented box of w×h centered at p. */
export function displayRectAt(p: Point, w: number, h: number, rotation: Rotation): Rect {
  const W = rotation % 180 === 0 ? w : h;
  const H = rotation % 180 === 0 ? h : w;
  return { x: p.x - W / 2, y: p.y - H / 2, width: W, height: H };
}

// ── rects ────────────────────────────────────────────────────────────────────
export function bboxOf(points: Point[]): Rect | null {
  if (points.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d };
}
/** Inset that never inverts the rect. */
export function deflate(r: Rect, d: number): Rect {
  const dx = Math.min(d, r.width / 2);
  const dy = Math.min(d, r.height / 2);
  return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy };
}
export function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}
/** Map a point from rect `from` to rect `to` (degenerate dimensions translate only). */
export function mapBetween(p: Point, from: Rect, to: Rect): Point {
  const sx = from.width > 1e-6 ? to.width / from.width : 1;
  const sy = from.height > 1e-6 ? to.height / from.height : 1;
  const fx = from.width > 1e-6 ? to.x : to.x + to.width / 2 - from.width / 2;
  const fy = from.height > 1e-6 ? to.y : to.y + to.height / 2 - from.height / 2;
  return { x: fx + (p.x - from.x) * sx, y: fy + (p.y - from.y) * sy };
}
export const translatePts = (pts: Point[], dx: number, dy: number) => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));

// ── segments ─────────────────────────────────────────────────────────────────
export function segPoints(segs: Seg[]): Point[] {
  const out: Point[] = [];
  for (const s of segs) {
    if (s[0] === 'M' || s[0] === 'L') out.push({ x: s[1], y: s[2] });
    else if (s[0] === 'C') out.push({ x: s[1], y: s[2] }, { x: s[3], y: s[4] }, { x: s[5], y: s[6] });
  }
  return out;
}
export function polySegs(pts: Point[], closed = false): Seg[] {
  if (pts.length === 0) return [];
  const segs: Seg[] = [['M', pts[0].x, pts[0].y]];
  if (pts.length === 1) segs.push(['L', pts[0].x + 0.01, pts[0].y]);
  for (let i = 1; i < pts.length; i++) segs.push(['L', pts[i].x, pts[i].y]);
  if (closed) segs.push(['Z']);
  return segs;
}
/** Catmull-Rom spline through the points as cubic Beziers. */
export function smoothSegs(pts: Point[]): Seg[] {
  if (pts.length < 3) return polySegs(pts);
  const segs: Seg[] = [['M', pts[0].x, pts[0].y]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    segs.push([
      'C',
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    ]);
  }
  return segs;
}
export function rectSegs(r: Rect): Seg[] {
  return [
    ['M', r.x, r.y],
    ['L', r.x + r.width, r.y],
    ['L', r.x + r.width, r.y + r.height],
    ['L', r.x, r.y + r.height],
    ['Z'],
  ];
}
const KAPPA = 0.5522847498;
export function ellipseSegs(cx: number, cy: number, rx: number, ry: number): Seg[] {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ];
}
export function roundRectSegs(r: Rect, radius: number): Seg[] {
  const rr = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  if (rr < 0.01) return rectSegs(r);
  const k = rr * (1 - KAPPA);
  const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  return [
    ['M', x0 + rr, y0],
    ['L', x1 - rr, y0],
    ['C', x1 - k, y0, x1, y0 + k, x1, y0 + rr],
    ['L', x1, y1 - rr],
    ['C', x1, y1 - k, x1 - k, y1, x1 - rr, y1],
    ['L', x0 + rr, y1],
    ['C', x0 + k, y1, x0, y1 - k, x0, y1 - rr],
    ['L', x0, y0 + rr],
    ['C', x0, y0 + k, x0 + k, y0, x0 + rr, y0],
    ['Z'],
  ];
}
/** Circular arc as Beziers (≤ 90° per piece), continuing from the current point. */
export function arcSegs(c: Point, r: number, a0: number, sweep: number): Seg[] {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Seg[] = [];
  let a = a0;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const p0 = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
    const p3 = { x: c.x + r * Math.cos(b), y: c.y + r * Math.sin(b) };
    out.push([
      'C',
      p0.x - k * r * Math.sin(a),
      p0.y + k * r * Math.cos(a),
      p3.x + k * r * Math.sin(b),
      p3.y - k * r * Math.cos(b),
      p3.x,
      p3.y,
    ]);
    a = b;
  }
  return out;
}

// ── simplification ───────────────────────────────────────────────────────────
function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export { segDist as pointSegmentDistance };

/** Ramer–Douglas–Peucker. */
export function simplify(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1, bi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > eps && bi > 0) {
      keep[bi] = 1;
      stack.push([s, bi], [bi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ── constraints ──────────────────────────────────────────────────────────────
/** Snap the direction anchor→p to a multiple of 45°, keeping the projected length. */
export function snap45(anchor: Point, p: Point): Point {
  const d = sub(p, anchor);
  const l = len(d);
  if (l < 1e-9) return p;
  const a = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4);
  const u = { x: Math.cos(a), y: Math.sin(a) };
  const proj = d.x * u.x + d.y * u.y;
  return { x: anchor.x + u.x * proj, y: anchor.y + u.y * proj };
}
/** Make the box anchor→p square (keeps the signs of both deltas). */
export function snapSquare(anchor: Point, p: Point): Point {
  const dx = p.x - anchor.x, dy = p.y - anchor.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: anchor.x + (dx < 0 ? -m : m), y: anchor.y + (dy < 0 ? -m : m) };
}

// ── polygons ─────────────────────────────────────────────────────────────────
export function signedArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
export function pathLength(pts: Point[], closed = false): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) l += dist(pts[pts.length - 1], pts[0]);
  return l;
}
export function centroid(pts: Point[]): Point {
  const a = signedArea(pts);
  if (Math.abs(a) < 1e-6) {
    const b = bboxOf(pts)!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, chord: number): Point[] {
  const perim = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const n = Math.max(6, Math.round(perim / Math.max(1, chord)));
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

// ── clouds ───────────────────────────────────────────────────────────────────
/** Nominal bump chord length for a cloud intensity. */
export const cloudChord = (intensity: number) => 9 * Math.max(0.5, Math.min(2, intensity || 1));
/** How far the cloud bumps extend outside their base polygon. */
export const cloudBulge = (intensity: number) => cloudChord(intensity) * 0.74;

/**
 * Cloudy border around a closed polygon: each edge is split into chords of about `cloudChord`,
 * and every chord gets an outward arc slightly larger than a half circle (cusps point inward).
 */
export function cloudSegs(poly: Point[], intensity: number): Seg[] {
  if (poly.length < 3) return polySegs(poly, true);
  const pts = signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
  const L = cloudChord(intensity);
  const nodes: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const n = Math.max(1, Math.ceil(dist(a, b) / L - 0.15));
    for (let k = 0; k < n; k++) nodes.push(lerp(a, b, k / n));
  }
  const segs: Seg[] = [['M', nodes[0].x, nodes[0].y]];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], b = nodes[(i + 1) % nodes.length];
    const d = dist(a, b);
    if (d < 1e-6) continue;
    const t = norm(sub(b, a));
    const outward = { x: t.y, y: -t.x };
    const h = 0.12 * d; // center pushed outward → arcs a bit larger than a half circle
    const m = lerp(a, b, 0.5);
    const c = add(m, mul(outward, h));
    const r = Math.hypot(d / 2, h);
    const a0 = Math.atan2(a.y - c.y, a.x - c.x);
    const a1 = Math.atan2(b.y - c.y, b.x - c.x);
    let sweep = a1 - a0;
    // Travel through the outward side: counter-clockwise for a CCW polygon.
    while (sweep <= 0) sweep += Math.PI * 2;
    segs.push(...arcSegs(c, r, a0, sweep));
  }
  segs.push(['Z']);
  return segs;
}

// ── line endings ─────────────────────────────────────────────────────────────
export const endingSize = (w: number) => Math.max(9, 3 * w + 6);

// ── eraser ───────────────────────────────────────────────────────────────────
/** Insert points so that consecutive points are at most `step` apart. */
export function densify(pts: Point[], step: number): Point[] {
  if (pts.length < 2) return pts.slice();
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.ceil(dist(a, b) / step);
    for (let k = 1; k < n; k++) out.push(lerp(a, b, k / n));
    out.push(b);
  }
  return out;
}
/** True when any segment of the polyline comes within `r` of the segment a→b. */
export function polylineHits(pts: Point[], a: Point, b: Point, r: number): boolean {
  if (pts.length === 1) return segDist(pts[0], a, b) <= r;
  for (let i = 1; i < pts.length; i++) {
    if (segSegDist(pts[i - 1], pts[i], a, b) <= r) return true;
  }
  return false;
}
function segSegDist(p1: Point, p2: Point, q1: Point, q2: Point): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.min(segDist(p1, q1, q2), segDist(p2, q1, q2), segDist(q1, p1, p2), segDist(q2, p1, p2));
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
/**
 * Remove the parts of `paths` inside the capsule a→b of radius r, splitting strokes.
 * Returns null when nothing was touched.
 */
export function erasePaths(paths: Point[][], a: Point, b: Point, r: number, simplifyEps: number): Point[][] | null {
  let changed = false;
  const out: Point[][] = [];
  for (const path of paths) {
    if (!polylineHits(path, a, b, r)) {
      out.push(path);
      continue;
    }
    changed = true;
    const dense = densify(path, Math.max(0.25, r / 3));
    let run: Point[] = [];
    const flush = () => {
      if (run.length >= 2) out.push(simplify(run, simplifyEps));
      run = [];
    };
    for (const p of dense) {
      if (segDist(p, a, b) <= r) flush();
      else run.push(p);
    }
    flush();
  }
  return changed ? out : null;
}
