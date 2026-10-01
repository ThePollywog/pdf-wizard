/**
 * 2D affine matrices in PDF convention: [a b c d e f] maps (x, y) to
 * (a·x + c·y + e, b·x + d·y + f). Row-vector semantics: `mul(a, b)` applies `a` first, then `b`
 * (so `cm` is CTM' = mul(M, CTM), text rendering matrix is mul(mul(P, Tm), CTM)).
 */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Linear part only (direction vectors). */
export function applyLinear(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export const translate = (tx: number, ty: number): Matrix => [1, 0, 0, 1, tx, ty];
export const scaling = (sx: number, sy: number): Matrix => [sx, 0, 0, sy, 0, 0];
export function rotation(rad: number): Matrix {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

/** Maps the unit square through `m`: corners in order (0,0) (1,0) (1,1) (0,1). */
export function unitQuad(m: Matrix, u0 = 0, v0 = 0, u1 = 1, v1 = 1): number[] {
  const p = [apply(m, u0, v0), apply(m, u1, v0), apply(m, u1, v1), apply(m, u0, v1)];
  return p.flat();
}

export function quadBounds(q: number[]): { x: number; y: number; width: number; height: number } {
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

export function almostEqual(a: Matrix, b: Matrix, eps = 1e-6): boolean {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > eps * (i >= 4 ? 100 : 1)) return false;
  return true;
}

/** Compact number formatting for content streams (no exponents, ≤ 5 decimals). */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100000) / 100000;
  if (Object.is(r, -0) || Math.abs(r) < 1e-9) return '0';
  return String(r);
}

export const fmtMatrix = (m: Matrix) => m.map(fmt).join(' ');
