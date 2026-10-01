/**
 * Page text with per-character positions (PDF user space), for Find & Redact and for deciding which
 * characters survive when redactions are applied.
 *
 * Items come from pdf.js getTextContent (same source as the viewer's text layer). Character
 * advances inside an item are estimated like the text layer does: the string is measured with the
 * item's CSS font family and scaled to the item's width, so marks made from a text selection and
 * from a search agree with each other.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as engine from '@/core/engine';
import type { DocId, Rect } from '@/core/types';

export interface ModelItem {
  str: string;
  /** Offset of the first char in PageModel.text. */
  start: number;
  /** Baseline origin, advance direction (u) and "up" direction (v). */
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  /** Advance length along u (points). */
  len: number;
  /** Extent below / above the baseline along v (points). */
  lo: number;
  hi: number;
  fontSize: number;
  vertical: boolean;
  line: number;
  /** Cumulative fractions of `len` (length str.length + 1, 0 … 1). */
  offsets: number[];
}

export interface PageModel {
  pageIndex: number;
  text: string;
  items: ModelItem[];
}

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

const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageModel>>>();

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, Map<string, number>>();

function charWidth(family: string, ch: string): number {
  let fam = widthCache.get(family);
  if (!fam) {
    fam = new Map();
    widthCache.set(family, fam);
  }
  let w = fam.get(ch);
  if (w === undefined) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (measureCtx) {
      measureCtx.font = `100px ${family || 'sans-serif'}`;
      w = measureCtx.measureText(ch).width;
    } else w = 50;
    if (!Number.isFinite(w) || w < 0) w = 0;
    fam.set(ch, w);
  }
  return w;
}

function offsetsFor(str: string, family: string): number[] {
  const n = str.length;
  const out = new Array<number>(n + 1);
  out[0] = 0;
  let total = 0;
  const widths = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const w = charWidth(family, str[i]);
    widths[i] = w;
    total += w;
  }
  if (total <= 0) {
    for (let i = 1; i <= n; i++) out[i] = i / n;
    return out;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += widths[i];
    out[i + 1] = acc / total;
  }
  out[n] = 1;
  return out;
}

function metrics(style: RawStyle | undefined) {
  const a = style?.ascent;
  const d = style?.descent;
  return {
    ascent: typeof a === 'number' && a > 0.2 && a <= 1.5 ? a : 0.8,
    descent: typeof d === 'number' && d < 0 && d > -1 ? d : -0.2,
  };
}

function build(pageIndex: number, raw: RawItem[], styles: Record<string, RawStyle>): PageModel {
  const items: ModelItem[] = [];
  let text = '';
  let prev: ModelItem | null = null;
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
      angle -= Math.PI / 2;
      len = it.height || it.width;
    }
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const { ascent, descent } = metrics(style);
    const item: ModelItem = {
      str: it.str,
      start: 0,
      ox: tx[4],
      oy: tx[5],
      ux,
      uy,
      vx: -uy,
      vy: ux,
      len: Math.max(0, len),
      lo: vertical ? -fs / 2 : descent * fs,
      hi: vertical ? fs / 2 : ascent * fs,
      fontSize: fs,
      vertical,
      line,
      offsets: vertical ? offsetsFor(it.str, '') : offsetsFor(it.str, style?.fontFamily ?? 'sans-serif'),
    };
    if (prev) {
      let sep = '';
      const dx = item.ox - prev.ox;
      const dy = item.oy - prev.oy;
      const along = dx * prev.ux + dy * prev.uy;
      const perp = dx * prev.vx + dy * prev.vy;
      const sameDir = Math.abs(prev.ux - ux) < 0.05 && Math.abs(prev.uy - uy) < 0.05;
      const size = Math.max(fs, prev.fontSize);
      const gap = along - prev.len;
      if (pendingBreak || !sameDir || Math.abs(perp) > size * 0.5 || gap < -(prev.len + size)) sep = '\n';
      else if (gap > size * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) sep = ' ';
      if (sep === '\n') {
        line += 1;
        item.line = line;
      }
      text += sep;
    }
    pendingBreak = !!it.hasEOL;
    item.start = text.length;
    items.push(item);
    text += it.str;
    prev = item;
  }
  return { pageIndex, text, items };
}

/** Text model of page `pageIndex` of any pdf.js document (uncached). */
export async function pageModelOf(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageModel> {
  const page = await pdf.getPage(pageIndex + 1);
  const content = await page.getTextContent({ includeMarkedContent: false });
  return build(pageIndex, content.items as unknown as RawItem[], content.styles as unknown as Record<string, RawStyle>);
}

/** Text model of a page (cached per pdf.js proxy, i.e. per document version). */
export async function getPageModel(docId: DocId, pageIndex: number, pdfIn?: PDFDocumentProxy): Promise<PageModel> {
  const pdf = pdfIn ?? (await engine.awaitPdf(docId));
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) throw new Error(`Page ${pageIndex + 1} doesn't exist.`);
  let perDoc = cache.get(pdf);
  if (!perDoc) {
    perDoc = new Map();
    cache.set(pdf, perDoc);
  }
  let job = perDoc.get(pageIndex);
  if (!job) {
    job = pageModelOf(pdf, pageIndex);
    perDoc.set(pageIndex, job);
    job.catch(() => perDoc!.delete(pageIndex));
  }
  return job;
}

/** Axis-aligned box of chars [i0, i1) of an item, optionally padded (points). */
export function charsBox(item: ModelItem, i0: number, i1: number, pad = 0): Rect {
  const a0 = item.offsets[Math.max(0, Math.min(i0, item.str.length))] * item.len - pad;
  const a1 = item.offsets[Math.max(0, Math.min(i1, item.str.length))] * item.len + pad;
  const lo = item.lo - pad;
  const hi = item.hi + pad;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const a of [a0, a1]) {
    for (const b of [lo, hi]) {
      xs.push(item.ox + item.ux * a + item.vx * b);
      ys.push(item.oy + item.uy * a + item.vy * b);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Rects covering chars [start, end) of the page text, merged per line (padded slightly so glyphs are fully covered). */
export function rangeRects(model: PageModel, start: number, end: number, padEm = 0.06): Rect[] {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(model.text.length, Math.max(start, end));
  if (hi <= lo) return [];
  const out: { rect: Rect; item: ModelItem }[] = [];
  for (const item of model.items) {
    const n = item.str.length;
    const s = Math.max(lo, item.start);
    const e = Math.min(hi, item.start + n);
    if (e <= s || !n) continue;
    // Don't start/end a rect on whitespace.
    let i0 = s - item.start;
    let i1 = e - item.start;
    while (i0 < i1 && /\s/.test(item.str[i0])) i0++;
    while (i1 > i0 && /\s/.test(item.str[i1 - 1])) i1--;
    if (i1 <= i0) continue;
    const rect = charsBox(item, i0, i1, item.fontSize * padEm);
    const last = out[out.length - 1];
    const axisAligned = Math.abs(item.uy) < 1e-3 || Math.abs(item.ux) < 1e-3;
    if (last && axisAligned && last.item.line === item.line && Math.abs(last.item.ux - item.ux) < 1e-3 && Math.abs(last.item.uy - item.uy) < 1e-3) {
      const horizontal = Math.abs(item.uy) < 1e-3;
      const a = last.rect;
      const tol = Math.max(item.hi - item.lo, 1);
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
    out.push({ rect, item });
  }
  return out.map((o) => o.rect);
}

function overlap1(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * True when character `i` of `item` is (mostly) under one of `boxes`: its center is inside a box,
 * or a box covers ≥ 30 % of its width and ≥ 30 % of its height.
 */
export function charRedacted(item: ModelItem, i: number, boxes: Rect[]): boolean {
  const r = charsBox(item, i, i + 1);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  for (const b of boxes) {
    if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height) return true;
    const ox = r.width > 0 ? overlap1(r.x, r.x + r.width, b.x, b.x + b.width) / r.width : cx >= b.x && cx <= b.x + b.width ? 1 : 0;
    const oy = r.height > 0 ? overlap1(r.y, r.y + r.height, b.y, b.y + b.height) / r.height : cy >= b.y && cy <= b.y + b.height ? 1 : 0;
    if (ox >= 0.3 && oy >= 0.3) return true;
  }
  return false;
}

/** Text of `model` under `boxes` (for mark summaries). */
export function textUnder(model: PageModel, boxes: Rect[]): string {
  let out = '';
  let lastLine = -1;
  for (const item of model.items) {
    let run = '';
    for (let i = 0; i < item.str.length; i++) if (charRedacted(item, i, boxes)) run += item.str[i];
    if (!run.trim()) continue;
    if (out) out += item.line !== lastLine ? ' ' : '';
    out += run;
    lastLine = item.line;
  }
  return out.replace(/\s+/g, ' ').trim();
}
