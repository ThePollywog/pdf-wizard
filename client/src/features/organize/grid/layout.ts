/**
 * Geometry of the virtualized page grid. Every cell has the same size (a size × 1.3·size frame
 * plus the label), so positions, the visible window, drop gaps and marquee hits are all computed
 * arithmetically — nothing needs to be measured, and off-screen pages never mount.
 */

export const PAD_X = 36;
export const PAD_TOP = 20;
export const PAD_BOTTOM = 48;
export const GAP_X = 32;
export const GAP_Y = 18;
const CELL_PAD = 8;
const LABEL_H = 30;

export interface GridMetrics {
  count: number;
  cols: number;
  rows: number;
  /** Thumbnail frame (the page is fitted inside). */
  boxW: number;
  boxH: number;
  cellW: number;
  cellH: number;
  /** X of the first column. */
  x0: number;
  /** Total scrollable height. */
  height: number;
  width: number;
}

export function gridMetrics(width: number, count: number, size: number): GridMetrics {
  const boxW = Math.round(size);
  const boxH = Math.round(size * 1.3);
  const cellW = boxW + CELL_PAD * 2;
  const cellH = boxH + CELL_PAD * 2 + LABEL_H;
  const inner = Math.max(cellW, width - PAD_X * 2);
  const cols = Math.max(1, Math.floor((inner + GAP_X) / (cellW + GAP_X)));
  const rows = Math.ceil(count / cols);
  const used = cols * cellW + (cols - 1) * GAP_X;
  const x0 = Math.max(PAD_X, Math.round((width - used) / 2));
  const height = PAD_TOP + PAD_BOTTOM + Math.max(0, rows * cellH + (rows - 1) * GAP_Y);
  return { count, cols, rows, boxW, boxH, cellW, cellH, x0, height, width };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cellBox(m: GridMetrics, i: number): Box {
  const row = Math.floor(i / m.cols);
  const col = i % m.cols;
  return { x: m.x0 + col * (m.cellW + GAP_X), y: PAD_TOP + row * (m.cellH + GAP_Y), w: m.cellW, h: m.cellH };
}

/** Frame of the thumbnail inside a cell (content coordinates). */
export function frameBox(m: GridMetrics, i: number): Box {
  const c = cellBox(m, i);
  return { x: c.x + CELL_PAD, y: c.y + CELL_PAD, w: m.boxW, h: m.boxH };
}

/** [first, last] rows intersecting the viewport, with overscan. */
export function visibleRows(m: GridMetrics, scrollTop: number, viewH: number, overscan = 2): [number, number] {
  if (!m.rows) return [0, -1];
  const pitch = m.cellH + GAP_Y;
  const first = Math.floor((scrollTop - PAD_TOP) / pitch);
  const last = Math.floor((scrollTop + viewH - PAD_TOP) / pitch);
  return [Math.max(0, first - overscan), Math.min(m.rows - 1, last + overscan)];
}

/** X (content coordinates) of the insertion gap before column `col` (col = cols → after the last). */
export function gapX(m: GridMetrics, col: number): number {
  return m.x0 + col * (m.cellW + GAP_X) - GAP_X / 2;
}

export interface GapHit {
  /** Insertion index 0..count: new pages go before the page at `gap`. */
  gap: number;
  row: number;
  col: number;
  x: number;
  y: number;
  h: number;
}

/** Nearest insertion gap to a point (content coordinates). */
export function gapAt(m: GridMetrics, x: number, y: number): GapHit | null {
  if (!m.count) return { gap: 0, row: 0, col: 0, x: gapX(m, 0), y: PAD_TOP, h: m.cellH };
  const pitch = m.cellH + GAP_Y;
  const row = Math.max(0, Math.min(m.rows - 1, Math.floor((y - PAD_TOP + GAP_Y / 2) / pitch)));
  const inRow = Math.min(m.cols, m.count - row * m.cols);
  const col = Math.max(0, Math.min(inRow, Math.round((x - m.x0 + GAP_X / 2) / (m.cellW + GAP_X))));
  return { gap: row * m.cols + col, row, col, x: gapX(m, col), y: PAD_TOP + row * pitch, h: m.cellH };
}

/** Index of the cell under a point, or -1. */
export function cellAt(m: GridMetrics, x: number, y: number): number {
  const pitchX = m.cellW + GAP_X;
  const pitchY = m.cellH + GAP_Y;
  const col = Math.floor((x - m.x0) / pitchX);
  const row = Math.floor((y - PAD_TOP) / pitchY);
  if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return -1;
  if (x - m.x0 - col * pitchX > m.cellW || y - PAD_TOP - row * pitchY > m.cellH) return -1;
  const i = row * m.cols + col;
  return i < m.count ? i : -1;
}

/** Cells intersecting a rectangle (content coordinates, any corner order). */
export function cellsInRect(m: GridMetrics, ax: number, ay: number, bx: number, by: number): number[] {
  const x1 = Math.min(ax, bx);
  const x2 = Math.max(ax, bx);
  const y1 = Math.min(ay, by);
  const y2 = Math.max(ay, by);
  const pitchX = m.cellW + GAP_X;
  const pitchY = m.cellH + GAP_Y;
  const out: number[] = [];
  const r0 = Math.max(0, Math.floor((y1 - PAD_TOP) / pitchY));
  const r1 = Math.min(m.rows - 1, Math.floor((y2 - PAD_TOP) / pitchY));
  const c0 = Math.max(0, Math.floor((x1 - m.x0) / pitchX));
  const c1 = Math.min(m.cols - 1, Math.floor((x2 - m.x0) / pitchX));
  for (let r = r0; r <= r1; r++) {
    const top = PAD_TOP + r * pitchY;
    if (y2 < top || y1 > top + m.cellH) continue;
    for (let c = c0; c <= c1; c++) {
      const left = m.x0 + c * pitchX;
      if (x2 < left || x1 > left + m.cellW) continue;
      const i = r * m.cols + c;
      if (i < m.count) out.push(i);
    }
  }
  return out;
}

/** Scroll position that brings cell `i` fully into view (null when it already is). */
export function scrollToReveal(m: GridMetrics, i: number, scrollTop: number, viewH: number): number | null {
  const b = cellBox(m, i);
  const top = b.y - 8;
  const bottom = b.y + b.h + 8;
  if (top < scrollTop) return Math.max(0, top);
  if (bottom > scrollTop + viewH) return Math.max(0, bottom - viewH);
  return null;
}
