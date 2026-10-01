/**
 * Page layout: where every page sits inside the scrollable "sizer" for a given zoom, rotation and
 * page layout mode. Sizes are snapped to device pixels so canvases map 1:1 to screen pixels.
 */
import type { FitMode, PageInfo, PageLayout, Rotation } from '../types';
import { MAX_ZOOM, MIN_ZOOM } from '../store';
import { totalRotation } from './viewport';

/** Gap between pages (CSS px). */
export const GAP = 12;
/** Padding around the pages. */
export const PAD_X = 16;
export const PAD_Y = 12;

export interface Slot {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Total rotation (page.rotation + view.rotation). */
  rotation: Rotation;
}

export interface Row {
  top: number;
  height: number;
  indices: number[];
}

export interface Layout {
  mode: PageLayout;
  zoom: number;
  viewRotation: Rotation;
  /** Laid-out slots by page index (undefined for pages not shown in single/two-page modes). */
  slots: (Slot | undefined)[];
  rows: Row[];
  width: number;
  height: number;
  pageIds: string[];
  pages: PageInfo[];
  dpr: number;
  containerWidth: number;
  containerHeight: number;
}

export const isSpreadMode = (m: PageLayout) => m === 'two-page' || m === 'two-page-continuous';
export const isPagedMode = (m: PageLayout) => m === 'single' || m === 'two-page';

/** Groups of page indices shown side by side, for the given mode. */
export function spreadGroups(count: number, mode: PageLayout): number[][] {
  const groups: number[][] = [];
  if (isSpreadMode(mode)) {
    for (let i = 0; i < count; i += 2) groups.push(i + 1 < count ? [i, i + 1] : [i]);
  } else {
    for (let i = 0; i < count; i++) groups.push([i]);
  }
  return groups;
}

/** The spread containing `pageIndex`. */
export function spreadOf(pageIndex: number, count: number, mode: PageLayout): number[] {
  if (!isSpreadMode(mode)) return [pageIndex];
  const first = pageIndex - (pageIndex % 2);
  return first + 1 < count ? [first, first + 1] : [first];
}

function pageSize(p: PageInfo, viewRotation: Rotation) {
  const r = totalRotation(p, viewRotation);
  const swap = r % 180 !== 0;
  return { w: swap ? p.height : p.width, h: swap ? p.width : p.height, r };
}

export function computeLayout(opts: {
  pages: PageInfo[];
  zoom: number;
  viewRotation: Rotation;
  mode: PageLayout;
  currentPage: number;
  containerWidth: number;
  containerHeight: number;
  dpr: number;
}): Layout {
  const { pages, zoom, viewRotation, mode, dpr } = opts;
  const floorPx = (v: number) => Math.max(1 / dpr, Math.floor(v * dpr + 1e-6) / dpr);
  const roundPx = (v: number) => Math.round(v * dpr) / dpr;
  const count = pages.length;
  const cur = Math.min(Math.max(0, opts.currentPage), Math.max(0, count - 1));
  const groups = count === 0 ? [] : isPagedMode(mode) ? [spreadOf(cur, count, mode)] : spreadGroups(count, mode);

  const sizes = new Map<number, { w: number; h: number; r: Rotation }>();
  let maxRowW = 0;
  const rowDims = groups.map((g) => {
    let w = 0;
    let h = 0;
    g.forEach((i, k) => {
      const s = pageSize(pages[i], viewRotation);
      const sz = { w: floorPx(s.w * zoom), h: floorPx(s.h * zoom), r: s.r };
      sizes.set(i, sz);
      w += sz.w + (k > 0 ? GAP : 0);
      h = Math.max(h, sz.h);
    });
    maxRowW = Math.max(maxRowW, w);
    return { w, h };
  });

  const width = Math.max(opts.containerWidth, maxRowW + 2 * PAD_X);
  const slots: (Slot | undefined)[] = new Array(count);
  const rows: Row[] = [];
  let y = PAD_Y;
  groups.forEach((g, gi) => {
    const { w: rowW, h: rowH } = rowDims[gi];
    let x = roundPx((width - rowW) / 2);
    const top = roundPx(y);
    g.forEach((i) => {
      const s = sizes.get(i)!;
      slots[i] = { index: i, left: x, top: roundPx(top + (rowH - s.h) / 2), width: s.w, height: s.h, rotation: s.r };
      x = roundPx(x + s.w + GAP);
    });
    rows.push({ top, height: rowH, indices: g });
    y = top + rowH + GAP;
  });
  let height = rows.length ? y - GAP + PAD_Y : PAD_Y * 2;
  // Paged modes: make short spreads fill the viewport so the page sits on a stable canvas.
  if (isPagedMode(mode)) height = Math.max(height, opts.containerHeight);
  return {
    mode,
    zoom,
    viewRotation,
    slots,
    rows,
    width,
    height,
    pageIds: pages.map((p) => p.id),
    pages,
    dpr,
    containerWidth: opts.containerWidth,
    containerHeight: opts.containerHeight,
  };
}

/** Zoom that fits the widest spread (fit 'width') or the current spread (fit 'page'). */
export function computeFitZoom(opts: {
  pages: PageInfo[];
  viewRotation: Rotation;
  mode: PageLayout;
  currentPage: number;
  fit: Exclude<FitMode, null>;
  containerWidth: number;
  containerHeight: number;
}): number | null {
  const { pages, viewRotation, mode, fit, containerWidth, containerHeight } = opts;
  if (pages.length === 0 || containerWidth <= 0 || containerHeight <= 0) return null;
  const availW = containerWidth - 2 * PAD_X;
  const availH = containerHeight - 2 * PAD_Y;
  const zoomFor = (g: number[]) => {
    let sumW = 0;
    let maxH = 0;
    for (const i of g) {
      const s = pageSize(pages[i], viewRotation);
      sumW += s.w;
      maxH = Math.max(maxH, s.h);
    }
    const zw = (availW - GAP * (g.length - 1)) / sumW;
    return fit === 'width' ? zw : Math.min(zw, availH / maxH);
  };
  let z: number;
  if (fit === 'width') {
    z = Infinity;
    for (const g of spreadGroups(pages.length, mode)) z = Math.min(z, zoomFor(g));
  } else {
    const cur = Math.min(Math.max(0, opts.currentPage), pages.length - 1);
    z = zoomFor(spreadOf(cur, pages.length, mode));
  }
  if (!Number.isFinite(z) || z <= 0) return null;
  z = Math.floor(z * 1000) / 1000;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Index of the first row whose bottom is below `y` (binary search). */
export function firstRowBelow(rows: Row[], y: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Page indices whose rows intersect [top, bottom]. */
export function indicesInRange(layout: Layout, top: number, bottom: number): number[] {
  const out: number[] = [];
  for (let r = firstRowBelow(layout.rows, top); r < layout.rows.length; r++) {
    const row = layout.rows[r];
    if (row.top > bottom) break;
    out.push(...row.indices);
  }
  return out;
}

/** The page with the largest visible area within the viewport rect (sizer coordinates). */
export function mostVisiblePage(layout: Layout, left: number, top: number, width: number, height: number): number | null {
  let best: number | null = null;
  let bestArea = 0;
  const bottom = top + height;
  const right = left + width;
  for (const i of indicesInRange(layout, top, bottom)) {
    const s = layout.slots[i];
    if (!s) continue;
    const ih = Math.min(bottom, s.top + s.height) - Math.max(top, s.top);
    const iw = Math.min(right, s.left + s.width) - Math.max(left, s.left);
    if (ih <= 0 || iw <= 0) continue;
    // Weight by the fraction of the viewport covered so a small page fully visible doesn't win
    // over a big one filling the screen, then prefer earlier pages on ties.
    const area = ih * iw;
    if (area > bestArea + 1) {
      bestArea = area;
      best = i;
    }
  }
  return best;
}
