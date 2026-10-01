/**
 * Geometry between PDF user space, block frames and on-screen CSS pixels.
 */
import type { CSSProperties } from 'react';
import type { PageViewport, Point, Rect, Rotation, ViewBox } from '@/core/types';
import type { Frame } from './content/blocks';
import { apply, applyLinear, invert, mul, quadBounds, translate, type Matrix } from './content/matrix';

/** PDF user space → CSS px relative to the page's top-left. */
export const viewMatrix = (vp: PageViewport): Matrix => vp.transform as unknown as Matrix;

/** CSS for an element laid out in a frame's local coordinates (CSS px at the current zoom; x along the text, y down). */
export function frameCss(frame: Frame, vp: PageViewport, zoom: number): CSSProperties {
  const V = viewMatrix(vp);
  const [ax, ay] = applyLinear(V, frame.u[0], frame.u[1]);
  const [bx, by] = applyLinear(V, frame.d[0], frame.d[1]);
  const [tx, ty] = apply(V, frame.origin[0], frame.origin[1]);
  const z = zoom || 1;
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    transformOrigin: '0 0',
    transform: `matrix(${ax / z}, ${ay / z}, ${bx / z}, ${by / z}, ${tx}, ${ty})`,
  };
}

/** Frame-local point (points along u / d) of a user-space point. */
export function toLocal(frame: Frame, p: Point): [number, number] {
  const dx = p.x - frame.origin[0];
  const dy = p.y - frame.origin[1];
  return [dx * frame.u[0] + dy * frame.u[1], dx * frame.d[0] + dy * frame.d[1]];
}

export function frameContains(frame: Frame, p: Point, pad = 0): boolean {
  const [x, y] = toLocal(frame, p);
  return x >= -pad && x <= frame.width + pad && y >= -pad && y <= frame.height + pad;
}

export function translateFrame(f: Frame, dx: number, dy: number): Frame {
  return { ...f, origin: [f.origin[0] + dx, f.origin[1] + dy] };
}

/** Unit vectors for upright text on a page shown with `rotation` (text direction u, down d). */
export function uprightAxes(rotation: Rotation): { u: [number, number]; d: [number, number] } {
  switch (rotation) {
    case 90:
      return { u: [0, 1], d: [1, 0] };
    case 180:
      return { u: [-1, 0], d: [0, 1] };
    case 270:
      return { u: [0, -1], d: [-1, 0] };
    default:
      return { u: [1, 0], d: [0, -1] };
  }
}

/** Upright frame covering a user-space rect. */
export function frameForRect(r: Rect, rotation: Rotation): Frame {
  const { u, d } = uprightAxes(rotation);
  const corners: [number, number][] = [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]];
  // top-left on screen = the corner with the smallest (u, d) projection
  let best = corners[0];
  let bestScore = Infinity;
  for (const c of corners) {
    const s = c[0] * u[0] + c[1] * u[1] + c[0] * d[0] + c[1] * d[1];
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  const horizontal = rotation === 0 || rotation === 180;
  return { origin: best, u, d, width: horizontal ? r.width : r.height, height: horizontal ? r.height : r.width };
}

/** User-space rect of a frame (axis-aligned bounds). */
export function frameRect(f: Frame): Rect {
  const q = [
    f.origin[0], f.origin[1],
    f.origin[0] + f.u[0] * f.width, f.origin[1] + f.u[1] * f.width,
    f.origin[0] + f.u[0] * f.width + f.d[0] * f.height, f.origin[1] + f.u[1] * f.width + f.d[1] * f.height,
    f.origin[0] + f.d[0] * f.height, f.origin[1] + f.d[1] * f.height,
  ];
  return quadBounds(q);
}

/** Unit square → user space for an upright image filling `r`. */
export function uprightImageMatrix(r: Rect, rotation: Rotation): Matrix {
  const f = frameForRect(r, rotation);
  const bl: [number, number] = [f.origin[0] + f.d[0] * f.height, f.origin[1] + f.d[1] * f.height];
  return [f.u[0] * f.width, f.u[1] * f.width, -f.d[0] * f.height, -f.d[1] * f.height, bl[0], bl[1]];
}

/** Matrix mapping rect `a` onto rect `b` (user space). */
export function rectToRect(a: Rect, b: Rect): Matrix {
  const sx = a.width ? b.width / a.width : 1;
  const sy = a.height ? b.height / a.height : 1;
  return [sx, 0, 0, sy, b.x - a.x * sx, b.y - a.y * sy];
}

/**
 * A transform expressed on screen (CSS px, around the view-space center of `r`) converted to user space:
 * M = V · S · V⁻¹.
 */
export function viewTransformToUser(vp: PageViewport, r: Rect, screen: Matrix): Matrix {
  const V = viewMatrix(vp);
  const Vi = invert(V);
  if (!Vi) return [1, 0, 0, 1, 0, 0];
  const [cx, cy] = apply(V, r.x + r.width / 2, r.y + r.height / 2);
  const around = mul(mul(translate(-cx, -cy), screen), translate(cx, cy));
  return mul(mul(V, around), Vi);
}

export const FLIP_H: Matrix = [-1, 0, 0, 1, 0, 0];
export const FLIP_V: Matrix = [1, 0, 0, -1, 0, 0];
/** Clockwise quarter turn on screen (CSS y points down). */
export const ROT_CW: Matrix = [0, 1, -1, 0, 0, 0];
export const ROT_CCW: Matrix = [0, -1, 1, 0, 0, 0];

export function boxOfQuad(vp: PageViewport, quad: number[]): ViewBox {
  const V = viewMatrix(vp);
  const pts: number[] = [];
  for (let i = 0; i + 1 < quad.length; i += 2) pts.push(...apply(V, quad[i], quad[i + 1]));
  const b = quadBounds(pts);
  return { left: b.x, top: b.y, width: b.width, height: b.height };
}

/** CSS polygon points of a user-space quad (for outlines of rotated content). */
export function quadPoints(vp: PageViewport, quad: number[]): string {
  const V = viewMatrix(vp);
  const out: string[] = [];
  for (let i = 0; i + 1 < quad.length; i += 2) {
    const [x, y] = apply(V, quad[i], quad[i + 1]);
    out.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return out.join(' ');
}
