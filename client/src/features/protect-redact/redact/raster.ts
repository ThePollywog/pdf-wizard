/**
 * Rasterizing a page for redaction: render the page content (no annotations) with pdf.js, paint
 * the redacted boxes over it, and encode the result as a PDF image XObject (Flate with a PNG
 * predictor for text-like pages, JPEG for photo-like ones).
 */
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib } from '@/core/engine/pdfjs';
import type { Rect } from '@/core/types';

const MAX_SIDE = 10000;
const MAX_AREA = 40e6;

export interface RedactBox {
  rect: Rect;
  /** '#rrggbb' or null (painted white). */
  fill: string | null;
  /**
   * Text marks: character positions inside a text run are estimates, so a glyph can stick out of
   * the box. Grow the box sideways over ink that crosses its edge (see snapEdges).
   */
  snap?: boolean;
}

export interface EncodedImage {
  width: number;
  height: number;
  bytes: Uint8Array;
  /** Dictionary entries (besides Type/Subtype/Width/Height/Length/Filter). */
  dict: Record<string, unknown>;
  /** 'flate': `bytes` are raw (predicted) samples to be Flate-compressed; 'jpeg': DCT-encoded. */
  encoding: 'flate' | 'jpeg';
}

/** Resolution (dpi) for rasterizing `pageCount` pages: sharper when only a few pages are affected. */
export function dpiFor(pageCount: number): number {
  if (pageCount <= 10) return 240;
  if (pageCount <= 40) return 200;
  if (pageCount <= 120) return 150;
  return 110;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the page image.'))), type, quality));
}

/** Rough "is this a photo" test: many distinct colors on a sample grid. */
function isPhotoLike(data: Uint8ClampedArray, w: number, h: number): boolean {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  const seen = new Set<number>();
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
      if (seen.size > 1800) return true;
    }
  }
  return false;
}

function isGray(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4) if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) return false;
  return true;
}

/** PNG "Up" predictor rows, to be Flate-compressed (rows are highly repetitive on text pages). */
function flateImage(data: Uint8ClampedArray, w: number, h: number, gray: boolean): EncodedImage {
  const colors = gray ? 1 : 3;
  const rowLen = w * colors;
  const out = new Uint8Array((rowLen + 1) * h);
  const prev = new Uint8Array(rowLen);
  const cur = new Uint8Array(rowLen);
  for (let y = 0; y < h; y++) {
    let k = 0;
    const base = y * w * 4;
    if (gray) for (let x = 0; x < w; x++) cur[k++] = data[base + x * 4];
    else {
      for (let x = 0; x < w; x++) {
        const i = base + x * 4;
        cur[k++] = data[i];
        cur[k++] = data[i + 1];
        cur[k++] = data[i + 2];
      }
    }
    const o = y * (rowLen + 1);
    out[o] = 2; // PNG filter type "Up"
    for (let i = 0; i < rowLen; i++) out[o + 1 + i] = (cur[i] - prev[i]) & 0xff;
    prev.set(cur);
  }
  return {
    width: w,
    height: h,
    bytes: out,
    encoding: 'flate',
    dict: {
      ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB',
      BitsPerComponent: 8,
      DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: 8, Columns: w },
    },
  };
}

/** Is column `x` (rows y0…y1) free of ink, i.e. (nearly) one color? */
function uniformColumn(data: Uint8ClampedArray, w: number, x: number, y0: number, y1: number): boolean {
  if (x < 0 || x >= w) return true;
  let r0 = 255, g0 = 255, b0 = 255, r1 = 0, g1 = 0, b1 = 0;
  for (let y = y0; y <= y1; y++) {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
    if (g < g0) g0 = g;
    if (g > g1) g1 = g;
    if (b < b0) b0 = b;
    if (b > b1) b1 = b;
  }
  return r1 - r0 < 28 && g1 - g0 < 28 && b1 - b0 < 28;
}

/**
 * Horizontal pixel span [x0, x1) of a text box grown over glyph ink that crosses its left / right
 * edge, up to the next ink-free column (the gap before the neighbouring glyph). Edges without ink
 * crossing them, or where no gap is found within `maxExt` pixels (busy backgrounds), stay put.
 */
function snapEdges(data: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, maxExt: number): [number, number] {
  const bh = y1 - y0;
  const ry0 = Math.max(0, Math.round(y0 + bh * 0.15));
  const ry1 = Math.min(h - 1, Math.round(y1 - 1 - bh * 0.15));
  if (ry1 <= ry0) return [x0, x1];
  const col = (x: number) => uniformColumn(data, w, x, ry0, ry1);
  let nx1 = x1;
  if (!col(x1) && !col(x1 - 1)) {
    for (let x = x1 + 1; x <= Math.min(w, x1 + maxExt); x++) {
      if (col(x)) {
        nx1 = x;
        break;
      }
    }
  }
  let nx0 = x0;
  if (!col(x0 - 1) && !col(x0)) {
    for (let x = x0 - 2; x >= Math.max(-1, x0 - 1 - maxExt); x--) {
      if (col(x)) {
        nx0 = x + 1;
        break;
      }
    }
  }
  return [nx0, nx1];
}

/**
 * Render `page` (unrotated, its visible box) at `dpi` with `boxes` painted opaque, and encode it.
 * Only page content is rendered — annotations stay annotations. Returns the boxes as painted
 * (text boxes may have grown, see RedactBox.snap), in PDF user space.
 */
export async function rasterizeRedacted(page: PDFPageProxy, boxes: RedactBox[], dpi: number): Promise<EncodedImage & { rects: Rect[] }> {
  const [X0, Y0, X1, Y1] = page.view;
  const W = X1 - X0;
  const H = Y1 - Y0;
  let scale = dpi / 72;
  const shrink = Math.min(1, MAX_SIDE / (W * scale), MAX_SIDE / (H * scale), Math.sqrt(MAX_AREA / (W * scale * H * scale)));
  scale *= shrink;
  const viewport = page.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement('canvas');
  const cw = Math.max(1, Math.round(viewport.width));
  const ch = Math.max(1, Math.round(viewport.height));
  canvas.width = cw;
  canvas.height = ch;
  try {
    await page.render({
      canvas,
      viewport,
      intent: 'display',
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      background: '#ffffff',
    }).promise;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Could not create a drawing surface for the page.');
    g.setTransform(1, 0, 0, 1, 0, 0);
    const sx = cw / W;
    const sy = ch / H;
    const rendered = boxes.some((b) => b.snap) ? g.getImageData(0, 0, cw, ch).data : null;
    const rects: Rect[] = [];
    for (const b of boxes) {
      const r = b.rect;
      // Grow by a device pixel so anti-aliased glyph edges don't survive at the box border.
      let x0 = Math.floor((r.x - X0) * sx) - 1;
      const y0 = Math.floor((Y1 - (r.y + r.height)) * sy) - 1;
      let x1 = Math.ceil((r.x + r.width - X0) * sx) + 1;
      const y1 = Math.ceil((Y1 - r.y) * sy) + 1;
      let out = r;
      if (b.snap && rendered) {
        const [n0, n1] = snapEdges(rendered, cw, ch, x0, Math.max(0, y0), x1, Math.min(ch, y1), Math.ceil((y1 - y0) * 0.45));
        if (n0 !== x0 || n1 !== x1) {
          const left = n0 < x0 ? X0 + n0 / sx : r.x;
          const right = n1 > x1 ? X0 + n1 / sx : r.x + r.width;
          out = { x: left, y: r.y, width: right - left, height: r.height };
          if (n0 < x0) x0 = n0 - 1;
          if (n1 > x1) x1 = n1 + 1;
        }
      }
      rects.push(out);
      g.fillStyle = b.fill ?? '#ffffff';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    const img = g.getImageData(0, 0, cw, ch);
    if (isPhotoLike(img.data, cw, ch)) {
      const blob = await toBlob(canvas, 'image/jpeg', 0.9);
      return {
        width: cw,
        height: ch,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        encoding: 'jpeg',
        dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' },
        rects,
      };
    }
    return { ...flateImage(img.data, cw, ch, isGray(img.data)), rects };
  } finally {
    // Free the backing store right away (large pages add up quickly).
    canvas.width = 0;
    canvas.height = 0;
  }
}
