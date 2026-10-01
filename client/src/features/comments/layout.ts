/**
 * Text measuring + FreeText layout shared by the on-screen renderer and the PDF appearance writer,
 * so line breaks are identical in the app, in the exported file and after re-import.
 *
 * WinAnsi text uses the AFM widths of the standard 14 fonts (exactly what the PDF uses). Other text
 * is drawn with Liberation Sans (embedded on export) and measured with a canvas in the same font.
 */
import { StandardFontEmbedder, StandardFonts } from '@cantoo/pdf-lib';
import type { PageInfo, Point, Rect, Rotation } from '@/core/types';
import { isWinAnsi, type Callout, type FontFamily, type FreeTextData, type TextAlign } from './model';

export const CSS_FONT: Record<FontFamily, string> = {
  Helvetica: "'comments-sans', Helvetica, Arial, sans-serif",
  Times: "'Times New Roman', Times, 'Liberation Serif', serif",
  Courier: "'Courier New', Courier, 'Liberation Mono', monospace",
};

/** Ascent / descent (em) of the on-screen fonts; the PDF baseline uses the same values. */
export const METRICS: Record<FontFamily, { asc: number; desc: number }> = {
  Helvetica: { asc: 0.905, desc: 0.212 },
  Times: { asc: 0.891, desc: 0.216 },
  Courier: { asc: 0.833, desc: 0.3 },
};
export const LINE_FACTOR = 1.2;

export const FONT_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Times', label: 'Times' },
  { value: 'Courier', label: 'Courier' },
];
export const FONT_SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

const embedders: Partial<Record<FontFamily, StandardFontEmbedder>> = {};
function afm(font: FontFamily): StandardFontEmbedder {
  let e = embedders[font];
  if (!e) {
    const name = font === 'Times' ? StandardFonts.TimesRoman : font === 'Courier' ? StandardFonts.Courier : StandardFonts.Helvetica;
    e = StandardFontEmbedder.for(name as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    embedders[font] = e;
  }
  return e;
}

let canvasCtx: CanvasRenderingContext2D | null | undefined;
function canvasWidth(s: string, size: number): number {
  if (canvasCtx === undefined) {
    try {
      canvasCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      canvasCtx = null;
    }
  }
  if (!canvasCtx) return s.length * size * 0.55;
  canvasCtx.font = `100px ${CSS_FONT.Helvetica}`;
  return (canvasCtx.measureText(s).width * size) / 100;
}

/** Font actually used for `text` (non-WinAnsi text falls back to the embedded sans font). */
export function effectiveFont(font: FontFamily, text: string): { font: FontFamily; unicode: boolean } {
  return isWinAnsi(text) ? { font, unicode: false } : { font: 'Helvetica', unicode: true };
}

const widthCache = new Map<string, number>();
/** Width in points of a single line. `unicode` = measured for the embedded Liberation Sans. */
export function measure(s: string, font: FontFamily, size: number, unicode = false): number {
  if (!s) return 0;
  const key = `${font}|${unicode ? 1 : 0}|${s}`;
  let w1 = widthCache.get(key);
  if (w1 === undefined) {
    if (!unicode) {
      w1 = afm(font).widthOfTextAtSize(s, 1);
    } else {
      // Liberation Sans is metric-compatible with Helvetica for WinAnsi glyphs.
      w1 = 0;
      let run = '';
      const flush = () => {
        if (run) w1! += canvasWidth(run, 1);
        run = '';
      };
      for (const ch of s) {
        if (isWinAnsi(ch)) {
          flush();
          w1 += afm('Helvetica').widthOfTextAtSize(ch, 1);
        } else run += ch;
      }
      flush();
    }
    if (widthCache.size > 4000) widthCache.clear();
    widthCache.set(key, w1);
  }
  return w1 * size;
}

/** Called when the web font finished loading (canvas widths change). */
export function resetMeasureCache() {
  widthCache.clear();
}

export function normalizeText(t: string): string {
  return t.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}

/** Ideographs / kana / hangul / full-width forms: a line may break after any of them (like desktop PDF editors). */
const CJK = '\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF';
const WRAP_TOKENS = new RegExp(`[${CJK}]\\s*|[^\\s${CJK}]+\\s*|\\s+`, 'g');

/** Greedy word wrap; long words are broken between characters. */
export function wrapText(text: string, font: FontFamily, size: number, maxWidth: number | null, unicode = false): string[] {
  const out: string[] = [];
  const m = (s: string) => measure(s, font, size, unicode);
  for (const para of normalizeText(text).split('\n')) {
    if (maxWidth == null || m(para.trimEnd()) <= maxWidth) {
      out.push(para);
      continue;
    }
    const tokens = para.match(WRAP_TOKENS) ?? [''];
    let line = '';
    for (const tok of tokens) {
      const cand = line + tok;
      if (m(cand.trimEnd()) <= maxWidth) {
        line = cand;
        continue;
      }
      if (line.trim()) {
        out.push(line.trimEnd());
        line = '';
      }
      let t = tok;
      while (t.length > 1 && m(t.trimEnd()) > maxWidth) {
        // longest prefix that fits (binary search on code units, kept on code point boundaries)
        const chars = Array.from(t);
        let lo = 1;
        let hi = chars.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (m(chars.slice(0, mid).join('')) <= maxWidth) lo = mid;
          else hi = mid - 1;
        }
        out.push(chars.slice(0, lo).join(''));
        t = chars.slice(lo).join('');
      }
      line = t;
    }
    out.push(line.trimEnd());
  }
  return out;
}

// ── FreeText ─────────────────────────────────────────────────────────────────

export interface LaidLine {
  text: string;
  /** Left edge from the frame's left (points). */
  x: number;
  /** Baseline from the frame's top (points). */
  baseline: number;
  /** Line box top from the frame's top. */
  top: number;
  width: number;
}
export interface FreeTextLayout {
  font: FontFamily;
  unicode: boolean;
  fontSize: number;
  lineHeight: number;
  pad: { x: number; y: number };
  /** Frame (text box) size in the text's own orientation. */
  fw: number;
  fh: number;
  lines: LaidLine[];
}

export const padsFor = (sw: number) => ({ x: Math.max(0, sw) + 3, y: Math.max(0, sw) + 2 });

export const MIN_BOX = 16;

/**
 * Lays out the text of a FreeText box. `frameW` = fixed frame width (null = size to the text,
 * limited to `maxW`). The frame height always follows the text (at least `minH`).
 */
export function layoutFreeText(
  d: Pick<FreeTextData, 'text' | 'font' | 'fontSize' | 'align'>,
  sw: number,
  frameW: number | null,
  opts: { maxW?: number; minH?: number } = {},
): FreeTextLayout {
  const { font, unicode } = effectiveFont(d.font, d.text);
  const size = Math.max(1, d.fontSize);
  const pad = padsFor(sw);
  const lh = size * LINE_FACTOR;
  let fw: number;
  if (frameW == null) {
    const raw = wrapText(d.text, font, size, null, unicode);
    const longest = Math.max(0, ...raw.map((l) => measure(l.trimEnd(), font, size, unicode)));
    fw = Math.max(longest + 2 * pad.x + size * 0.35, size * 2 + 2 * pad.x, MIN_BOX);
    if (opts.maxW && fw > opts.maxW) fw = Math.max(MIN_BOX, opts.maxW);
  } else fw = Math.max(MIN_BOX, frameW);
  const inner = Math.max(1, fw - 2 * pad.x);
  const texts = wrapText(d.text, font, size, inner, unicode);
  const { asc, desc } = METRICS[font];
  const baseOff = (lh - (asc + desc) * size) / 2 + asc * size;
  const lines: LaidLine[] = texts.map((t, i) => {
    const w = measure(t, font, size, unicode);
    const x = alignX(d.align, pad.x, inner, w);
    const top = pad.y + i * lh;
    return { text: t, x, top, baseline: top + baseOff, width: w };
  });
  const fh = Math.max(opts.minH ?? 0, Math.max(1, lines.length) * lh + 2 * pad.y, MIN_BOX);
  return { font, unicode, fontSize: size, lineHeight: lh, pad, fw, fh, lines };
}

function alignX(align: TextAlign, padX: number, inner: number, w: number): number {
  if (align === 'center') return padX + (inner - w) / 2;
  if (align === 'right') return padX + inner - w;
  return padX;
}

// ── rotated frames ──────────────────────────────────────────────────────────

/** Size of a user-space rect in the text's orientation (rotated CCW by `rot`). */
export function frameSizeOf(r: Rect, rot: Rotation | undefined): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: r.height, h: r.width } : { w: r.width, h: r.height };
}

/** User-space rect for a frame of fw×fh keeping the visual top-left corner of `r` fixed. */
export function anchorFrame(r: Rect, rot: Rotation | undefined, fw: number, fh: number): Rect {
  const xmax = r.x + r.width;
  const ymax = r.y + r.height;
  switch (rot) {
    case 90:
      return { x: r.x, y: r.y, width: fh, height: fw };
    case 180:
      return { x: xmax - fw, y: r.y, width: fw, height: fh };
    case 270:
      return { x: xmax - fh, y: ymax - fw, width: fh, height: fw };
    default:
      return { x: r.x, y: ymax - fh, width: fw, height: fh };
  }
}

/** User-space rect of a frame whose visual top-left corner is at `p`. */
export function frameAt(p: Point, rot: Rotation | undefined, fw: number, fh: number): Rect {
  switch (rot) {
    case 90:
      return { x: p.x, y: p.y, width: fh, height: fw };
    case 180:
      return { x: p.x - fw, y: p.y, width: fw, height: fh };
    case 270:
      return { x: p.x - fh, y: p.y - fw, width: fh, height: fw };
    default:
      return { x: p.x, y: p.y - fh, width: fw, height: fh };
  }
}

/** Room from the frame's start edge to the page edge in the text direction. */
export function availableWidth(page: PageInfo, r: Rect, rot: Rotation | undefined): number {
  const [x0, y0, x1, y1] = page.view;
  let w: number;
  switch (rot) {
    case 90:
      w = y1 - r.y;
      break;
    case 180:
      w = r.x + r.width - x0;
      break;
    case 270:
      w = r.y + r.height - y0;
      break;
    default:
      w = x1 - r.x;
  }
  return Math.max(40, w);
}

// ── callouts ────────────────────────────────────────────────────────────────

/** Attach point (midpoint of the box side nearest to the anchor) and knee for a callout. */
export function calloutLeader(box: Rect, anchor: Point): Point[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = anchor.x - cx;
  const dy = anchor.y - cy;
  const inside = anchor.x >= box.x && anchor.x <= box.x + box.width && anchor.y >= box.y && anchor.y <= box.y + box.height;
  let attach: Point;
  let dir: Point;
  // Pick the side facing the anchor (normalized by the box aspect).
  if (Math.abs(dx) / Math.max(1, box.width) >= Math.abs(dy) / Math.max(1, box.height)) {
    attach = dx < 0 ? { x: box.x, y: cy } : { x: box.x + box.width, y: cy };
    dir = { x: dx < 0 ? -1 : 1, y: 0 };
  } else {
    attach = dy < 0 ? { x: cx, y: box.y } : { x: cx, y: box.y + box.height };
    dir = { x: 0, y: dy < 0 ? -1 : 1 };
  }
  if (inside) return [anchor, attach, attach];
  const dist = Math.hypot(anchor.x - attach.x, anchor.y - attach.y);
  const k = Math.min(18, dist / 3);
  const knee = { x: attach.x + dir.x * k, y: attach.y + dir.y * k };
  return [anchor, knee, attach];
}

/** Bounding rect of a callout (box + leader + arrow head). */
export function calloutBounds(c: Callout, sw: number): Rect {
  const pad = 4 + sw * 2;
  let x0 = c.box.x, y0 = c.box.y, x1 = c.box.x + c.box.width, y1 = c.box.y + c.box.height;
  for (const p of c.points) {
    x0 = Math.min(x0, p.x - pad);
    y0 = Math.min(y0, p.y - pad);
    x1 = Math.max(x1, p.x + pad);
    y1 = Math.max(y1, p.y + pad);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Two points of an open arrow head at `tip`, pointing away from `from`. */
export function arrowHead(tip: Point, from: Point, size: number): [Point, Point] {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: tip.x - size * Math.cos(a - spread), y: tip.y - size * Math.sin(a - spread) },
    { x: tip.x - size * Math.cos(a + spread), y: tip.y - size * Math.sin(a + spread) },
  ];
}
