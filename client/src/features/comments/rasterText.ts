/**
 * Text that no embeddable font covers (CJK, emoji…). The repository ships only Liberation Sans, so
 * such a line is drawn as an image of the text rendered by the browser (with the same font stack as
 * on screen, so it looks like the app) and invisible text (render mode 3) with a ToUnicode CMap is put
 * on top, so the line stays searchable, selectable and extractable in every PDF viewer.
 */
import type { PDFDocument, PDFFont, PDFImage, PDFRef } from '@cantoo/pdf-lib';

/** Ascent / descent / side padding (em) of the rendered image around the line's baseline. */
const ASC = 1.05;
const DESC = 0.32;
const PAD = 0.08;
/** Device pixels per point of the rendered text (≈ 290 dpi). */
const SCALE = 4;
const MAX_PX = 8000;

const coverCache = new WeakMap<PDFFont, Set<number>>();

/** True when `font` has a glyph for every character of `s` (white space always passes). */
export function covers(font: PDFFont, s: string): boolean {
  let set = coverCache.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    coverCache.set(font, set);
  }
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x20 || c === 0x200b) continue;
    if (!set.has(c)) return false;
  }
  return true;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function canvas2d(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx;
}

/** Width in points of `text` as the browser renders it in `cssFont` at `size` (`style` e.g. 'italic 700'). */
export function renderedWidth(text: string, cssFont: string, size: number, style = ''): number {
  const c = canvas2d();
  if (!c) return text.length * size * 0.6;
  c.font = `${style ? `${style} ` : ''}100px ${cssFont}`;
  return (c.measureText(text).width * size) / 100;
}

export interface RasterText {
  image: PDFImage;
  /** Placement relative to the line's left edge / baseline, in points. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const imageCache = new WeakMap<PDFDocument, Map<string, Promise<RasterText | null>>>();

/**
 * PNG of a single line of text, embedded in `doc`. `width` = the laid-out width of the line in
 * points (the image is stretched to it so it lines up with the layout exactly).
 */
export function rasterText(
  doc: PDFDocument,
  text: string,
  opts: { cssFont: string; size: number; color: string; width?: number; weight?: number | string; italic?: boolean },
): Promise<RasterText | null> {
  let cache = imageCache.get(doc);
  if (!cache) {
    cache = new Map();
    imageCache.set(doc, cache);
  }
  const key = JSON.stringify([text, opts.cssFont, opts.size, opts.color, opts.width ?? null, opts.weight ?? 400, !!opts.italic]);
  let p = cache.get(key);
  if (!p) {
    p = render(doc, text, opts).catch((err) => {
      console.warn('[comments] could not render text as an image', err);
      return null;
    });
    cache.set(key, p);
  }
  return p;
}

async function render(
  doc: PDFDocument,
  text: string,
  opts: { cssFont: string; size: number; color: string; width?: number; weight?: number | string; italic?: boolean },
): Promise<RasterText | null> {
  if (typeof document === 'undefined' || !text.trim() || !(opts.size > 0)) return null;
  const font = `${opts.italic ? 'italic ' : ''}${opts.weight ?? 400} ${Math.round(opts.size * SCALE * 100) / 100}px ${opts.cssFont}`;
  try {
    await document.fonts?.load(font, text);
  } catch {
    /* system fallback fonts need no loading */
  }
  const natural = renderedWidth(text, opts.cssFont, opts.size, `${opts.italic ? 'italic ' : ''}${opts.weight ?? 400}`);
  const width = opts.width && opts.width > 0 ? opts.width : natural;
  const padPt = PAD * opts.size;
  const wPt = width + 2 * padPt;
  const hPt = (ASC + DESC) * opts.size;
  const scale = Math.min(SCALE, MAX_PX / Math.max(1, wPt), MAX_PX / Math.max(1, hPt));
  const cw = Math.max(1, Math.ceil(wPt * scale));
  const ch = Math.max(1, Math.ceil(hPt * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const c = canvas.getContext('2d');
  if (!c) return null;
  c.font = `${opts.italic ? 'italic ' : ''}${opts.weight ?? 400} ${opts.size * scale}px ${opts.cssFont}`;
  c.fillStyle = opts.color;
  c.textBaseline = 'alphabetic';
  // Squeeze / stretch to the laid-out width (they only differ by rounding).
  const sx = natural > 0 ? width / natural : 1;
  c.setTransform(sx, 0, 0, 1, padPt * scale, ASC * opts.size * scale);
  c.fillText(text, 0, 0);
  const png = await new Promise<Uint8Array | null>((resolve) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), () => resolve(null)) : resolve(null)), 'image/png'),
  );
  if (!png) return null;
  const image = await doc.embedPng(png);
  return { image, x: -padPt, y: -DESC * opts.size, width: wPt, height: hPt };
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const utf16Hex = (ch: string) => Array.from({ length: ch.length }, (_, i) => hex4(ch.charCodeAt(i))).join('');
const glyphName = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c > 0xffff ? `u${c.toString(16).toUpperCase()}` : `uni${hex4(c)}`;
};

export interface InvisibleRun {
  /** Font dictionary (simple font, never drawn). */
  ref: PDFRef;
  /** Hex string operand for Tj. */
  hex: string;
}

/** Glyph width (1/1000 em) of every character of the invisible fonts; stretch with Tz. */
export const INVISIBLE_ADVANCE = 500;

/**
 * Invisible text runs for `text`: simple fonts (the non-embedded standard Helvetica with a custom
 * encoding, ≤ 255 distinct characters each) whose ToUnicode CMap maps the codes back to the text.
 * Every character advances INVISIBLE_ADVANCE/1000 em.
 */
export function invisibleRuns(doc: PDFDocument, text: string): InvisibleRun[] {
  const ctx = doc.context;
  const runs: InvisibleRun[] = [];
  let codes = new Map<string, number>();
  let chars: string[] = [];
  let hex = '';
  const flush = () => {
    if (!hex) return;
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<00> <FF>',
      'endcodespacerange',
    ];
    for (let i = 0; i < chars.length; i += 100) {
      const chunk = chars.slice(i, i + 100);
      cmap.push(`${chunk.length} beginbfchar`, ...chunk.map((c, j) => `<${hex2(i + j + 1)}> <${utf16Hex(c)}>`), 'endbfchar');
    }
    cmap.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    const ref = ctx.register(
      ctx.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        FirstChar: 1,
        LastChar: chars.length,
        Widths: chars.map(() => INVISIBLE_ADVANCE),
        Encoding: { Type: 'Encoding', Differences: [1, ...chars.map(glyphName)] },
        ToUnicode: ctx.register(ctx.flateStream(cmap.join('\n'))),
      }),
    );
    runs.push({ ref, hex: `<${hex}>` });
    codes = new Map();
    chars = [];
    hex = '';
  };
  for (const ch of text) {
    let code = codes.get(ch);
    if (code === undefined) {
      if (chars.length >= 255) flush();
      chars.push(ch);
      code = chars.length;
      codes.set(ch, code);
    }
    hex += hex2(code);
  }
  flush();
  return runs;
}

/** Horizontal scaling (Tz, percent) that makes the invisible text of `text` span `width` points. */
export function invisibleScale(text: string, size: number, width: number): number {
  const n = Array.from(text).length;
  const natural = (n * INVISIBLE_ADVANCE * size) / 1000;
  return natural > 0 && width > 0 ? (100 * width) / natural : 100;
}
