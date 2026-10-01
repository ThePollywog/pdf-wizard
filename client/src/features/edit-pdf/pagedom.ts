/**
 * Reading pixels of the rendered pages: snapshots of page regions for drag previews and the paper
 * color behind text (used to cover the original glyphs while they are being edited).
 */
import type { ViewBox } from '@/core/types';

let activeDoc: string | null = null;
/** Scopes page lookups to the viewer of this document (set by the page overlays). */
export function setDomDoc(docId: string | null): void {
  activeDoc = docId;
}

export function pageElement(pageIndex: number): HTMLElement | null {
  const scoped = activeDoc ? `[data-testid="document-viewer"][data-doc-id="${CSS.escape(activeDoc)}"] ` : '[data-testid="document-viewer"] ';
  return document.querySelector<HTMLElement>(`${scoped}.pdfwizard-page[data-page-index="${pageIndex}"]`)
    ?? document.querySelector<HTMLElement>(`.pdfwizard-page[data-page-index="${pageIndex}"]`);
}

export function pageCanvas(pageIndex: number): HTMLCanvasElement | null {
  return pageElement(pageIndex)?.querySelector<HTMLCanvasElement>('canvas.pdfwizard-canvas') ?? null;
}

interface Mapped {
  canvas: HTMLCanvasElement;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
}

function mapCanvas(pageIndex: number): Mapped | null {
  const page = pageElement(pageIndex);
  const canvas = pageCanvas(pageIndex);
  if (!page || !canvas || !canvas.width) return null;
  const pr = page.getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  if (!cr.width || !cr.height) return null;
  return { canvas, sx: canvas.width / cr.width, sy: canvas.height / cr.height, ox: cr.left - pr.left, oy: cr.top - pr.top };
}

/** PNG data URL of a page region (CSS px relative to the page), or null. */
export function snapshot(pageIndex: number, box: ViewBox): string | null {
  const m = mapCanvas(pageIndex);
  if (!m || box.width < 1 || box.height < 1) return null;
  const w = Math.max(1, Math.round(box.width * m.sx));
  const h = Math.max(1, Math.round(box.height * m.sy));
  if (w * h > 16_000_000) return null;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(m.canvas, (box.left - m.ox) * m.sx, (box.top - m.oy) * m.sy, box.width * m.sx, box.height * m.sy, 0, 0, w, h);
    return out.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** Most common color on the border of `box` (the paper behind a text block); white by default. */
export function paperColor(pageIndex: number, box: ViewBox): string {
  const m = mapCanvas(pageIndex);
  if (!m) return '#ffffff';
  const ctx = m.canvas.getContext('2d', { willReadFrequently: false } as CanvasRenderingContext2DSettings);
  if (!ctx) return '#ffffff';
  const counts = new Map<string, { n: number; r: number; g: number; b: number }>();
  const sample = (x: number, y: number) => {
    const px = Math.round((x - m.ox) * m.sx);
    const py = Math.round((y - m.oy) * m.sy);
    if (px < 0 || py < 0 || px >= m.canvas.width || py >= m.canvas.height) return;
    try {
      const d = ctx.getImageData(px, py, 1, 1).data;
      if (d[3] < 200) return;
      const key = `${d[0] >> 4}.${d[1] >> 4}.${d[2] >> 4}`;
      const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++;
      c.r += d[0];
      c.g += d[1];
      c.b += d[2];
      counts.set(key, c);
    } catch {
      /* tainted / lost context */
    }
  };
  const pad = 2;
  const x0 = box.left - pad, y0 = box.top - pad, x1 = box.left + box.width + pad, y1 = box.top + box.height + pad;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    sample(x0 + (x1 - x0) * t, y0);
    sample(x0 + (x1 - x0) * t, y1);
    sample(x0, y0 + (y1 - y0) * t);
    sample(x1, y0 + (y1 - y0) * t);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const v of counts.values()) if (!best || v.n > best.n) best = v;
  if (!best) return '#ffffff';
  const hex = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, '0');
  const out = `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
  // near-white is paper white (anti-aliasing noise)
  return best.r / best.n > 250 && best.g / best.n > 250 && best.b / best.n > 250 ? '#ffffff' : out;
}

/** Top of the visible part of a page in PDF user space (unrotated pages only), or null. */
export function visibleTopOf(pageIndex: number, pageTop: number, zoom: number, rotation: number): number | null {
  if (rotation !== 0) return null;
  const page = pageElement(pageIndex);
  const scroller = page?.closest<HTMLElement>('[data-testid="document-viewer"]');
  if (!page || !scroller) return null;
  const pr = page.getBoundingClientRect();
  const sr = scroller.getBoundingClientRect();
  const offset = Math.max(0, sr.top - pr.top);
  if (offset >= pr.height) return null;
  return Math.round((pageTop - offset / zoom) * 100) / 100;
}
