/**
 * Page viewports without waiting for pdf.js pages.
 *
 * pdf.js does not export its `PageViewport` class, but the text/annotation layers check
 * `viewport instanceof PageViewport`. We therefore capture the real constructor from the first
 * loaded page (`page.getViewport().constructor`) and, until then, fall back to a mirror class
 * with identical math (placeholders, object overlays and tools only use the conversion methods).
 */
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { PageInfo, Rotation } from '../types';

interface ViewportInit {
  viewBox: number[];
  userUnit: number;
  scale: number;
  rotation: number;
  offsetX?: number;
  offsetY?: number;
  dontFlip?: boolean;
}
type ViewportCtor = new (init: ViewportInit) => PageViewport;

let RealViewport: ViewportCtor | null = null;
const readyListeners = new Set<() => void>();

/** Remember pdf.js' PageViewport class (idempotent). */
export function captureViewportClass(page: PDFPageProxy): void {
  if (RealViewport) return;
  try {
    RealViewport = page.getViewport({ scale: 1 }).constructor as ViewportCtor;
  } catch {
    return;
  }
  cache.clear();
  readyListeners.forEach((l) => l());
}

export const hasRealViewportClass = () => RealViewport !== null;

/** Subscribe to the moment the real class becomes available (for useSyncExternalStore). */
export function subscribeViewportClass(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

/** Same math as pdf.js' PageViewport (display/display_utils.js). */
class MirrorViewport {
  viewBox: number[];
  userUnit: number;
  scale: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
  transform: number[];
  width: number;
  height: number;

  constructor({ viewBox, userUnit, scale, rotation, offsetX = 0, offsetY = 0, dontFlip = false }: ViewportInit) {
    this.viewBox = viewBox;
    this.userUnit = userUnit;
    this.scale = scale;
    this.rotation = rotation;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    const s = scale * userUnit;
    const cx = (viewBox[2] + viewBox[0]) / 2;
    const cy = (viewBox[3] + viewBox[1]) / 2;
    let a: number, b: number, c: number, d: number;
    let r = rotation % 360;
    if (r < 0) r += 360;
    switch (r) {
      case 180: a = -1; b = 0; c = 0; d = 1; break;
      case 90: a = 0; b = 1; c = 1; d = 0; break;
      case 270: a = 0; b = -1; c = -1; d = 0; break;
      default: a = 1; b = 0; c = 0; d = -1; break;
    }
    if (dontFlip) {
      c = -c;
      d = -d;
    }
    let ox: number, oy: number, w: number, h: number;
    if (a === 0) {
      ox = Math.abs(cy - viewBox[1]) * s + offsetX;
      oy = Math.abs(cx - viewBox[0]) * s + offsetY;
      w = (viewBox[3] - viewBox[1]) * s;
      h = (viewBox[2] - viewBox[0]) * s;
    } else {
      ox = Math.abs(cx - viewBox[0]) * s + offsetX;
      oy = Math.abs(cy - viewBox[1]) * s + offsetY;
      w = (viewBox[2] - viewBox[0]) * s;
      h = (viewBox[3] - viewBox[1]) * s;
    }
    this.transform = [a * s, b * s, c * s, d * s, ox - a * s * cx - c * s * cy, oy - b * s * cx - d * s * cy];
    this.width = w;
    this.height = h;
  }

  get rawDims() {
    const v = this.viewBox;
    return { pageWidth: v[2] - v[0], pageHeight: v[3] - v[1], pageX: v[0], pageY: v[1] };
  }

  clone({ scale = this.scale, rotation = this.rotation, offsetX = this.offsetX, offsetY = this.offsetY, dontFlip = false } = {}) {
    return new MirrorViewport({ viewBox: this.viewBox.slice(), userUnit: this.userUnit, scale, rotation, offsetX, offsetY, dontFlip });
  }

  convertToViewportPoint(x: number, y: number): number[] {
    const m = this.transform;
    return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  }

  convertToViewportRectangle(rect: number[]): number[] {
    const tl = this.convertToViewportPoint(rect[0], rect[1]);
    const br = this.convertToViewportPoint(rect[2], rect[3]);
    return [tl[0], tl[1], br[0], br[1]];
  }

  convertToPdfPoint(x: number, y: number): number[] {
    const m = this.transform;
    const det = m[0] * m[3] - m[1] * m[2];
    const xt = x - m[4];
    const yt = y - m[5];
    return [(xt * m[3] - yt * m[2]) / det, (yt * m[0] - xt * m[1]) / det];
  }
}

export function normRotation(r: number): Rotation {
  const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return n as Rotation;
}

/** Total on-screen rotation of a page: intrinsic /Rotate + view rotation. */
export function totalRotation(page: Pick<PageInfo, 'rotation'>, viewRotation: number): Rotation {
  return normRotation((page.rotation || 0) + (viewRotation || 0));
}

const cache = new Map<string, PageViewport>();
const CACHE_MAX = 600;

/**
 * Viewport for `page` at `zoom` CSS px / pt and total rotation `rotation`. Referentially stable
 * for equal inputs (small LRU), so it can be used as a React dependency.
 */
export function makeViewport(page: Pick<PageInfo, 'view'>, zoom: number, rotation: Rotation): PageViewport {
  const v = page.view;
  const key = `${v[0]},${v[1]},${v[2]},${v[3]}|${zoom}|${rotation}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const init: ViewportInit = { viewBox: [v[0], v[1], v[2], v[3]], userUnit: 1, scale: zoom, rotation, offsetX: 0, offsetY: 0, dontFlip: false };
  const vp = RealViewport ? new RealViewport(init) : (new MirrorViewport(init) as unknown as PageViewport);
  cache.set(key, vp);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return vp;
}

/** Linear part of the viewport transform applied to a PDF-space delta → view px delta. */
export function pdfDeltaToView(vp: PageViewport, dx: number, dy: number): { x: number; y: number } {
  const m = vp.transform;
  return { x: dx * m[0] + dy * m[2], y: dx * m[1] + dy * m[3] };
}

/** Inverse of pdfDeltaToView: a view px delta → PDF-space delta. */
export function viewDeltaToPdf(vp: PageViewport, dx: number, dy: number): { x: number; y: number } {
  const m = vp.transform;
  const det = m[0] * m[3] - m[1] * m[2];
  return { x: (dx * m[3] - dy * m[2]) / det, y: (dy * m[0] - dx * m[1]) / det };
}
