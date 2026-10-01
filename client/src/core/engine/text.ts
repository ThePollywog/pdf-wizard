/**
 * Page text (for search, selection, copy, highlight/redact-by-text...). Items come from pdf.js
 * getTextContent; rects are in PDF user space (the same space as PdfObject.rect).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId, Rect } from '../types';
import { awaitPdf } from './sync';

export interface PageTextItem {
  str: string;
  rect: Rect;
  fontName: string;
  fontSize: number;
  dir: string;
  transform: number[];
  /** Offset of this item's first char in PageText.text */
  start: number;
}
export interface PageText {
  pageIndex: number;
  /** Items joined; '\n' between lines, ' ' where pdf.js reports hasEOL=false gaps. */
  text: string;
  items: PageTextItem[];
}

/** Local mirror of pdf.js' TextItem / TextStyle (their typings aren't exported from the package root). */
interface RawItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}
interface RawStyle {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
  fontFamily?: string;
}

/** Baseline frame of an item: origin, advance direction u, "up" direction v, extent. */
interface Geometry {
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  /** Length along u. */
  len: number;
  /** Extent along v (below / above the baseline, in points; lo <= 0 <= hi usually). */
  lo: number;
  hi: number;
  line: number;
}

const geometry = new WeakMap<PageTextItem, Geometry>();
const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageText>>>();

function metrics(style: RawStyle | undefined): { ascent: number; descent: number } {
  const a = style?.ascent;
  const d = style?.descent;
  return {
    ascent: typeof a === 'number' && a > 0.2 && a <= 1.5 ? a : 0.8,
    descent: typeof d === 'number' && d < 0 && d > -1 ? d : -0.2,
  };
}

function boxOf(g: Geometry, a0 = 0, a1 = 1): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const a of [a0, a1]) {
    for (const b of [g.lo, g.hi]) {
      xs.push(g.ox + g.ux * g.len * a + g.vx * b);
      ys.push(g.oy + g.uy * g.len * a + g.vy * b);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function build(pageIndex: number, raw: RawItem[], styles: Record<string, RawStyle>): PageText {
  const items: PageTextItem[] = [];
  let text = '';
  let prev: { g: Geometry; fs: number; str: string } | null = null;
  let pendingBreak = false;
  let line = 0;

  for (const it of raw) {
    if (typeof it.str !== 'string') continue;
    if (!it.str) {
      if (it.hasEOL) pendingBreak = true;
      continue;
    }
    const tx = it.transform;
    const style = styles[it.fontName];
    const vertical = !!style?.vertical;
    const fs = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 1;
    let angle = Math.atan2(tx[1], tx[0]);
    let len = it.width;
    if (vertical) {
      // Vertical writing advances downwards (pdf.js reports the advance as `height`).
      angle -= Math.PI / 2;
      len = it.height || it.width;
    }
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const { ascent, descent } = metrics(style);
    const g: Geometry = {
      ox: tx[4],
      oy: tx[5],
      ux,
      uy,
      vx: -uy,
      vy: ux,
      len: Math.max(0, len),
      lo: vertical ? -fs / 2 : descent * fs,
      hi: vertical ? fs / 2 : ascent * fs,
      line,
    };

    if (prev) {
      let sep = '';
      const dx = g.ox - prev.g.ox;
      const dy = g.oy - prev.g.oy;
      const along = dx * prev.g.ux + dy * prev.g.uy;
      const perp = dx * prev.g.vx + dy * prev.g.vy;
      const sameDir = Math.abs(prev.g.ux - ux) < 0.05 && Math.abs(prev.g.uy - uy) < 0.05;
      const size = Math.max(fs, prev.fs);
      const gap = along - prev.g.len;
      if (pendingBreak || !sameDir || Math.abs(perp) > size * 0.5 || gap < -(prev.g.len + size)) {
        sep = '\n';
      } else if (gap > size * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) {
        sep = ' ';
      }
      if (sep === '\n') {
        line += 1;
        g.line = line;
      }
      text += sep;
    }
    pendingBreak = !!it.hasEOL;

    const item: PageTextItem = {
      str: it.str,
      rect: boxOf(g),
      fontName: it.fontName,
      fontSize: fs,
      dir: it.dir,
      transform: tx.slice(),
      start: text.length,
    };
    geometry.set(item, g);
    items.push(item);
    text += it.str;
    prev = { g, fs, str: it.str };
  }
  return { pageIndex, text, items };
}

/** Text of a page (cached per pdf.js proxy, so it's recomputed only when the bytes change). */
export async function getPageText(docId: DocId, pageIndex: number): Promise<PageText> {
  const pdf = await awaitPdf(docId);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) throw new Error(`Page ${pageIndex + 1} doesn't exist.`);
  let perDoc = cache.get(pdf);
  if (!perDoc) {
    perDoc = new Map();
    cache.set(pdf, perDoc);
  }
  let job = perDoc.get(pageIndex);
  if (!job) {
    job = (async () => {
      const page = await pdf.getPage(pageIndex + 1);
      const content = await page.getTextContent({ includeMarkedContent: false });
      return build(pageIndex, content.items as unknown as RawItem[], content.styles as unknown as Record<string, RawStyle>);
    })();
    perDoc.set(pageIndex, job);
    job.catch(() => perDoc!.delete(pageIndex));
  }
  return job;
}

/** Geometry for items that lost their WeakMap entry (e.g. a structured-cloned PageText): split the bounding box. */
function fallbackGeometry(item: PageTextItem): Geometry {
  const tx = item.transform ?? [1, 0, 0, 1, 0, 0];
  let ux = tx[0];
  let uy = tx[1];
  if (item.dir === 'ttb') [ux, uy] = [0, -1];
  const r = item.rect;
  if (Math.abs(ux) >= Math.abs(uy)) {
    const sx = ux < 0 ? -1 : 1;
    return { ox: sx > 0 ? r.x : r.x + r.width, oy: r.y, ux: sx, uy: 0, vx: 0, vy: 1, len: r.width, lo: 0, hi: r.height, line: 0 };
  }
  const sy = uy < 0 ? -1 : 1;
  return { ox: r.x, oy: sy > 0 ? r.y : r.y + r.height, ux: 0, uy: sy, vx: 1, vy: 0, len: r.height, lo: 0, hi: r.width, line: 0 };
}

/**
 * Rects covering the characters [start, end) of `pageText.text` (proportional by char count),
 * merged per line.
 */
export function rangeRects(pageText: PageText, start: number, end: number): Rect[] {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(pageText.text.length, Math.max(start, end));
  if (hi <= lo) return [];
  const out: { rect: Rect; line: number; g: Geometry }[] = [];
  for (const item of pageText.items) {
    const n = item.str.length;
    const s = Math.max(lo, item.start);
    const e = Math.min(hi, item.start + n);
    if (e <= s || !n) continue;
    const g = geometry.get(item) ?? fallbackGeometry(item);
    const a0 = (s - item.start) / n;
    const a1 = (e - item.start) / n;
    const rect = boxOf(g, a0, a1);
    const last = out[out.length - 1];
    const axisAligned = Math.abs(g.uy) < 1e-3 || Math.abs(g.ux) < 1e-3;
    if (last && axisAligned && last.line === g.line && Math.abs(last.g.ux - g.ux) < 1e-3 && Math.abs(last.g.uy - g.uy) < 1e-3) {
      const horizontal = Math.abs(g.uy) < 1e-3;
      const a = last.rect;
      const tol = Math.max(g.hi - g.lo, 1);
      const near = horizontal
        ? rect.x <= a.x + a.width + tol && rect.x + rect.width >= a.x - tol && Math.abs(rect.y - a.y) < tol * 0.5
        : rect.y <= a.y + a.height + tol && rect.y + rect.height >= a.y - tol && Math.abs(rect.x - a.x) < tol * 0.5;
      if (near) {
        const x = Math.min(a.x, rect.x);
        const y = Math.min(a.y, rect.y);
        last.rect = { x, y, width: Math.max(a.x + a.width, rect.x + rect.width) - x, height: Math.max(a.y + a.height, rect.y + rect.height) - y };
        continue;
      }
    }
    out.push({ rect, line: g.line, g });
  }
  return out.map((o) => o.rect);
}
