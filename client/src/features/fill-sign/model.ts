/**
 * Fill & Sign data model.
 *
 *  - object kinds: fill-text (typed text), fill-mark (check / cross / dot / line / circle), signature
 *  - "upright frame" math: every item remembers the on-screen rotation it was created at (`data.rot`),
 *    so it stays upright relative to the page content it was placed on — also on /Rotate pages and when
 *    the view is rotated later. The frame is described by the page-space unit vectors `du` (text
 *    direction, "right") and `dv` ("down"), and its upright size W×H (rect width/height swapped for 90/270).
 *  - text measuring (canvas, same font stack as the DOM rendering and metric-compatible with Helvetica)
 *  - default sizes, relative to the page size
 */
import type { PageInfo, PdfObject, Point, Rect, Rotation } from '@/core/types';

export const FEATURE_ID = 'fill-sign';
export const TASK_ID = 'fill-sign';

export const FILL_TEXT = 'fill-text';
export const FILL_MARK = 'fill-mark';
export const SIGNATURE = 'signature';
export const FILL_KINDS: ReadonlySet<string> = new Set([FILL_TEXT, FILL_MARK, SIGNATURE]);

export interface FillTextData {
  text: string;
  /** Font size in points. */
  fontSize: number;
  /** Extra space after every character, in points (comb-like spacing). */
  letterSpacing: number;
  /** On-screen rotation at creation (see file comment). */
  rot: Rotation;
}
export type FillTextObject = PdfObject<'fill-text', FillTextData>;

export type MarkKind = 'check' | 'cross' | 'dot' | 'line' | 'circle';
export const MARK_KINDS: MarkKind[] = ['cross', 'check', 'dot', 'line', 'circle'];
export const MARK_LABELS: Record<MarkKind, string> = {
  check: 'Check mark',
  cross: 'Cross mark',
  dot: 'Dot',
  line: 'Line',
  circle: 'Circle',
};
export interface FillMarkData {
  mark: MarkKind;
  rot: Rotation;
}
export type FillMarkObject = PdfObject<'fill-mark', FillMarkData>;

export type SigRole = 'signature' | 'initials';
export type SigSource = 'type' | 'draw' | 'image';
export interface SignatureData {
  /** PNG data URL with a transparent background (black ink for typed / drawn signatures). */
  src: string;
  role: SigRole;
  source: SigSource;
  /** Typed and drawn signatures are tinted with obj.color; uploaded images keep their colors. */
  recolorable: boolean;
  rot: Rotation;
}
export type SignatureObject = PdfObject<'signature', SignatureData>;

export type FillObject = FillTextObject | FillMarkObject | SignatureObject;

export const isFillObject = (o: PdfObject | undefined | null): o is FillObject => !!o && FILL_KINDS.has(o.kind);

// ── text constants ───────────────────────────────────────────────────────────

export const DEFAULT_TEXT_COLOR = '#000000';
export const DEFAULT_MARK_COLOR = '#000000';
export const DEFAULT_FONT_SIZE = 12;
/** Metric-compatible with the Helvetica used in the exported PDF. */
export const FONT_STACK = 'Helvetica, Arial, "Liberation Sans", "Helvetica Neue", sans-serif';
export const LINE_HEIGHT = 1.2;
/** Inner padding of a text box, in points. */
export const PAD_X = 2;
export const PAD_Y = 1;
export const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
export const MIN_FONT = 4;
export const MAX_FONT = 144;
export const LETTER_SPACINGS = [0, 1, 2, 3, 4, 6, 8, 10, 12, 15, 20, 25, 30];

export const clampFont = (fs: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(fs * 2) / 2));

export function nextFontSize(fs: number, dir: 1 | -1): number {
  if (dir > 0) return FONT_SIZES.find((s) => s > fs + 0.01) ?? Math.min(MAX_FONT, Math.round(fs * 1.25));
  for (let i = FONT_SIZES.length - 1; i >= 0; i--) if (FONT_SIZES[i] < fs - 0.01) return FONT_SIZES[i];
  return Math.max(MIN_FONT, Math.floor(fs * 0.8));
}

// ── upright frame ────────────────────────────────────────────────────────────

export function normRot(r: number): Rotation {
  return ((((Math.round(r / 90) * 90) % 360) + 360) % 360) as Rotation;
}

/** Page-space unit vectors of the upright frame: du = "right", dv = "down". */
export function frameDirs(rot: Rotation): { du: Point; dv: Point } {
  switch (rot) {
    case 90:
      return { du: { x: 0, y: 1 }, dv: { x: 1, y: 0 } };
    case 180:
      return { du: { x: -1, y: 0 }, dv: { x: 0, y: 1 } };
    case 270:
      return { du: { x: 0, y: -1 }, dv: { x: -1, y: 0 } };
    default:
      return { du: { x: 1, y: 0 }, dv: { x: 0, y: -1 } };
  }
}

export function uprightSize(rect: Rect, rot: Rotation): { w: number; h: number } {
  return rot % 180 ? { w: rect.height, h: rect.width } : { w: rect.width, h: rect.height };
}

/** Page-space point of the upright top-left corner. */
export function uprightOrigin(rect: Rect, rot: Rotation): Point {
  switch (rot) {
    case 90:
      return { x: rect.x, y: rect.y };
    case 180:
      return { x: rect.x + rect.width, y: rect.y };
    case 270:
      return { x: rect.x + rect.width, y: rect.y + rect.height };
    default:
      return { x: rect.x, y: rect.y + rect.height };
  }
}

/** Page-space rect of an upright W×H box whose upright top-left is `o`. */
export function rectFromOrigin(o: Point, w: number, h: number, rot: Rotation): Rect {
  const { du, dv } = frameDirs(rot);
  const xs = [o.x, o.x + du.x * w, o.x + dv.x * h, o.x + du.x * w + dv.x * h];
  const ys = [o.y, o.y + du.y * w, o.y + dv.y * h, o.y + du.y * w + dv.y * h];
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

/** Page-space rect of an upright W×H box centred on `c`. */
export function rectAround(c: Point, w: number, h: number, rot: Rotation): Rect {
  const swap = rot % 180 !== 0;
  const rw = swap ? h : w;
  const rh = swap ? w : h;
  return { x: c.x - rw / 2, y: c.y - rh / 2, width: rw, height: rh };
}

/** Upright local coordinates (u right, v down, points) of a page-space point. */
export function toUpright(rect: Rect, rot: Rotation, p: Point): { u: number; v: number } {
  const { du, dv } = frameDirs(rot);
  const o = uprightOrigin(rect, rot);
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  return { u: dx * du.x + dy * du.y, v: dx * dv.x + dy * dv.y };
}

/** Content-stream matrix mapping the local frame (0..W × 0..H, y up) to page user space. */
export function uprightMatrix(rect: Rect, rot: Rotation): [number, number, number, number, number, number] {
  const { du, dv } = frameDirs(rot);
  const { h } = uprightSize(rect, rot);
  const o = uprightOrigin(rect, rot);
  const bl = { x: o.x + dv.x * h, y: o.y + dv.y * h };
  return [du.x, du.y, -dv.x, -dv.y, bl.x, bl.y];
}

/** Clockwise CSS rotation to apply to upright content shown at `total` screen rotation. */
export function viewRotation(total: number, rot: number): Rotation {
  return normRot(total - rot);
}

/** Keep `r` inside the page's visible box. */
export function clampRectToPage(r: Rect, page: Pick<PageInfo, 'view'>): Rect {
  const [x0, y0, x1, y1] = page.view;
  const x = r.width > x1 - x0 ? x0 + (x1 - x0 - r.width) / 2 : Math.min(Math.max(r.x, x0), x1 - r.width);
  const y = r.height > y1 - y0 ? y0 + (y1 - y0 - r.height) / 2 : Math.min(Math.max(r.y, y0), y1 - r.height);
  return { ...r, x, y };
}

/**
 * Shift `r` back onto the page where it sticks out (text growing past the right or bottom edge);
 * when it is larger than the page it is pinned to the page's left / bottom edge.
 */
export function keepOnPage(r: Rect, page: Pick<PageInfo, 'view'>): Rect {
  const [x0, y0, x1, y1] = page.view;
  const x = Math.min(Math.max(r.x, x0), Math.max(x0, x1 - r.width));
  const y = Math.min(Math.max(r.y, y0), Math.max(y0, y1 - r.height));
  return x === r.x && y === r.y ? r : { ...r, x, y };
}

/**
 * Place a width×height rect so that the edges which stayed put between `before` and `proposed`
 * (the resize anchor) stay put; if neither edge of an axis stayed, centre on the proposal.
 */
export function anchorRect(before: Rect, proposed: Rect, width: number, height: number): Rect {
  const eps = 0.05;
  const lf = Math.abs(proposed.x - before.x) < eps;
  const rf = Math.abs(proposed.x + proposed.width - (before.x + before.width)) < eps;
  const bf = Math.abs(proposed.y - before.y) < eps;
  const tf = Math.abs(proposed.y + proposed.height - (before.y + before.height)) < eps;
  const x = lf && !rf ? proposed.x : rf && !lf ? proposed.x + proposed.width - width : proposed.x + (proposed.width - width) / 2;
  const y = bf && !tf ? proposed.y : tf && !bf ? proposed.y + proposed.height - height : proposed.y + (proposed.height - height) / 2;
  return { x, y, width, height };
}

// ── text measuring ───────────────────────────────────────────────────────────

let mctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d')!;
  return mctx;
}

let metrics: { ascent: number; descent: number } | null = null;
/** Ascent / descent of the text font as fractions of the font size (what CSS uses for line boxes). */
export function fontMetrics(): { ascent: number; descent: number } {
  if (!metrics) {
    const c = measureCtx();
    c.font = `100px ${FONT_STACK}`;
    const m = c.measureText('Hg');
    const a = Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0 ? m.fontBoundingBoxAscent / 100 : 0.77;
    const d = Number.isFinite(m.fontBoundingBoxDescent) && m.fontBoundingBoxDescent > 0 ? m.fontBoundingBoxDescent / 100 : 0.23;
    metrics = { ascent: a, descent: d };
  }
  return metrics;
}

const widthCache = new Map<string, number>();
/** Advance width of `s` at 1pt (without letter spacing). */
function unitWidth(s: string): number {
  let w = widthCache.get(s);
  if (w === undefined) {
    const c = measureCtx();
    c.font = `100px ${FONT_STACK}`;
    w = c.measureText(s).width / 100;
    if (widthCache.size > 2000) widthCache.clear();
    widthCache.set(s, w);
  }
  return w;
}

export function lineWidth(s: string, fontSize: number, letterSpacing: number): number {
  return unitWidth(s) * fontSize + letterSpacing * [...s].length;
}

export interface TextLayout {
  lines: string[];
  widths: number[];
  /** Line height (pt). */
  lh: number;
  /** Upright box size (pt), padding included. */
  w: number;
  h: number;
  /** Baseline offset from the top of a line box (pt). */
  baseline: number;
}

export function textLayout(d: Pick<FillTextData, 'text' | 'fontSize' | 'letterSpacing'>): TextLayout {
  const lines = d.text.split('\n');
  const lh = d.fontSize * LINE_HEIGHT;
  const widths = lines.map((l) => lineWidth(l, d.fontSize, d.letterSpacing));
  const w = Math.max(d.fontSize * 0.5, ...widths) + 2 * PAD_X;
  const h = lines.length * lh + 2 * PAD_Y;
  const m = fontMetrics();
  const baseline = (lh - (m.ascent + m.descent) * d.fontSize) / 2 + m.ascent * d.fontSize;
  return { lines, widths, lh, w, h, baseline };
}

/** Rect for text data, keeping the upright top-left corner of `anchor`. */
export function textRect(anchor: Point, d: FillTextData): Rect {
  const lay = textLayout(d);
  return rectFromOrigin(anchor, lay.w, lay.h, d.rot);
}

/** Caret index in `d.text` closest to the upright local point (u, v) in points. */
export function caretIndexAt(d: FillTextData, u: number, v: number): number {
  const lay = textLayout(d);
  const li = Math.max(0, Math.min(lay.lines.length - 1, Math.floor((v - PAD_Y) / lay.lh)));
  let index = 0;
  for (let i = 0; i < li; i++) index += lay.lines[i].length + 1;
  const line = lay.lines[li];
  const chars = [...line];
  let best = 0;
  let bestD = Math.abs(u - PAD_X);
  let prefix = '';
  for (let i = 0; i < chars.length; i++) {
    prefix += chars[i];
    const x = PAD_X + lineWidth(prefix, d.fontSize, d.letterSpacing);
    const dist = Math.abs(u - x);
    if (dist < bestD) {
      bestD = dist;
      best = prefix.length;
    }
  }
  return index + best;
}

/** Normalise typed / pasted text (tabs → spaces, CRLF → LF). */
export const normalizeText = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');

// ── default sizes ────────────────────────────────────────────────────────────

/** Base symbol size: ~2.2% of the shorter page side (≈13.5 pt on Letter). */
export function markBaseSize(page: Pick<PageInfo, 'width' | 'height'>): number {
  return Math.max(8, Math.min(page.width, page.height) * 0.022);
}

/** Default upright size of a symbol. */
export function markDefaultSize(mark: MarkKind, page: Pick<PageInfo, 'width' | 'height'>): { w: number; h: number } {
  const s = markBaseSize(page);
  switch (mark) {
    case 'dot':
      return { w: s * 0.55, h: s * 0.55 };
    case 'line':
      return { w: s * 4, h: Math.max(4, s * 0.45) };
    case 'circle':
      return { w: s * 2.4, h: s * 1.5 };
    default:
      return { w: s, h: s };
  }
}

export const markKeepsAspect = (m: MarkKind) => m === 'check' || m === 'cross' || m === 'dot';
export const markHasStroke = (m: MarkKind) => m === 'line' || m === 'circle';
export const DEFAULT_MARK_STROKE = 1.5;

/** Default upright size of a placed signature (height fixed, width from the image aspect, capped). */
export function signatureDefaultSize(role: SigRole, aspect: number, page: Pick<PageInfo, 'width' | 'height' | 'rotation'>, rot: Rotation) {
  const uprightPageW = rot % 180 ? page.height : page.width;
  let h = role === 'initials' ? 24 : 36;
  let w = h * aspect;
  const maxW = uprightPageW * (role === 'initials' ? 0.2 : 0.4);
  if (w > maxW) {
    w = maxW;
    h = w / aspect;
  }
  return { w, h };
}
