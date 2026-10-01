/**
 * Document text search shared by the Find bar and the Advanced Search panel: an incremental,
 * cancellable scan over engine.getPageText that reports matches batch by batch.
 */
import type { DocId, Rect } from '@/core/types';
import * as engine from '@/core/engine';
import type { PageText } from '@/core/engine/text';
import { getDoc } from '@/core/store';
import { findAll, normalize, normalizeQuery, toOriginal, type Normalized, type SearchOptions } from './text';

export interface TextMatch {
  key: string;
  pageIndex: number;
  /** Offsets in PageText.text. */
  start: number;
  end: number;
  rects: Rect[];
}

// ── glyph-aware highlight rects ─────────────────────────────────────────────
// engine.rangeRects splits a text item evenly by character count, so a match inside a long run of
// proportional text drifts ("Acroba|t"). Weight the partial first / last items by measured glyph
// widths instead: the fraction of the item before the offset is passed as a fractional offset.

type Measure = (ch: string) => number;
let measure: Measure | null | undefined;
function measurer(): Measure | null {
  if (measure !== undefined) return measure;
  measure = null;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (ctx) {
      ctx.font = '100px Helvetica, Arial, sans-serif';
      const widths = new Map<string, number>();
      measure = (ch) => {
        let w = widths.get(ch);
        if (w === undefined) {
          w = ctx.measureText(ch).width || 50;
          widths.set(ch, w);
        }
        return w;
      };
    }
  } catch {
    measure = null;
  }
  return measure;
}

type Item = PageText['items'][number];
const cumCache = new WeakMap<Item, Float64Array>();
/** Cumulative glyph widths of an item (cum[k] = width of the first k chars), or null. */
function cumulative(item: Item): Float64Array | null {
  let cum = cumCache.get(item);
  if (cum) return cum;
  const m = measurer();
  if (!m) return null;
  const chars = item.str;
  cum = new Float64Array(chars.length + 1);
  for (let i = 0; i < chars.length; i++) cum[i + 1] = cum[i] + m(chars[i]);
  cumCache.set(item, cum);
  return cum;
}

/** Offset `off` expressed as a (fractional) offset weighted by glyph widths within its item. */
function weighted(pt: PageText, off: number): number {
  for (const it of pt.items) {
    const n = it.str.length;
    // Offsets at an item's edges need no weighting.
    if (!(off > it.start && off < it.start + n)) {
      if (it.start > off) break;
      continue;
    }
    const cum = cumulative(it);
    if (!cum || !cum[n]) return off;
    return it.start + (cum[off - it.start] / cum[n]) * n;
  }
  return off;
}

/** Highlight rects of [start, end) in PDF user space, weighted by glyph widths. */
export function textRects(pt: PageText, start: number, end: number): Rect[] {
  if (end <= start) return [];
  try {
    return engine.rangeRects(pt, weighted(pt, start), weighted(pt, end));
  } catch {
    return engine.rangeRects(pt, start, end);
  }
}

const normCache = new WeakMap<PageText, { cs?: Normalized; ci?: Normalized }>();
export function normalizedPage(pt: PageText, matchCase: boolean): Normalized {
  let e = normCache.get(pt);
  if (!e) normCache.set(pt, (e = {}));
  if (matchCase) return (e.cs ??= normalize(pt.text, true));
  return (e.ci ??= normalize(pt.text, false));
}

export function matchesOnPage(pt: PageText, query: string, opts: SearchOptions): TextMatch[] {
  const q = normalizeQuery(query, opts.matchCase);
  if (!q) return [];
  const norm = normalizedPage(pt, opts.matchCase);
  return findAll(norm.text, q, opts.wholeWords).map(([s, e]) => {
    const [start, end] = toOriginal(norm, s, e);
    return { key: `${pt.pageIndex}:${start}`, pageIndex: pt.pageIndex, start, end, rects: textRects(pt, start, end) };
  });
}

export interface ScanProgress {
  matches: TextMatch[];
  /** Pages of this batch, with their text (for snippets). */
  pages: PageText[];
  scanned: number;
  total: number;
}

export interface ScanHandle {
  cancel(): void;
  readonly done: Promise<boolean>;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Scan all pages (starting at `startPage` and wrapping around) in small batches, yielding to the
 * UI between batches. `onBatch` is not called after cancel(). Resolves `done` with false if cancelled.
 */
export function scanDocument(
  docId: DocId,
  query: string,
  opts: SearchOptions,
  onBatch: (p: ScanProgress) => void,
  { startPage = 0, batch = 4 }: { startPage?: number; batch?: number } = {},
): ScanHandle {
  let cancelled = false;
  const done = (async () => {
    const doc = getDoc(docId);
    const total = doc?.pages.length ?? 0;
    if (!total || !normalizeQuery(query, opts.matchCase)) return true;
    const start = Math.min(Math.max(0, startPage), total - 1);
    const order = Array.from({ length: total }, (_, k) => (start + k) % total);
    let scanned = 0;
    for (let b = 0; b < order.length; b += batch) {
      const ids = order.slice(b, b + batch);
      const texts = await Promise.all(ids.map((i) => engine.getPageText(docId, i).catch(() => null)));
      if (cancelled) return false;
      const pages = texts.filter((t): t is PageText => !!t);
      const matches = pages.flatMap((pt) => matchesOnPage(pt, query, opts));
      scanned += ids.length;
      onBatch({ matches, pages, scanned, total });
      await yieldToUi();
      if (cancelled) return false;
    }
    return true;
  })().catch(() => !cancelled);
  return {
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}

/** Insert `add` into the (page, start)-sorted list `list` (returns a new array). */
export function mergeSorted(list: TextMatch[], add: TextMatch[]): TextMatch[] {
  if (!add.length) return list;
  const out = list.concat(add);
  out.sort((a, b) => a.pageIndex - b.pageIndex || a.start - b.start);
  return out;
}

export function unionRect(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
