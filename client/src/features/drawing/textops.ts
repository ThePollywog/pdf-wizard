/**
 * Text paints → PDF operators, for any Unicode text:
 *   1. text is set in embedded (subset) Liberation Sans — Helvetica-compatible metrics, covering
 *      Latin, Greek and Cyrillic — so every viewer shows the same glyphs;
 *   2. if the font file can't be loaded, WinAnsi text falls back to the standard Helvetica fonts;
 *   3. characters no available font covers (CJK, …) are drawn as an image of the line, rendered by
 *      the browser like the screen, with invisible text on top so it stays searchable and extractable.
 * Each variant is scaled horizontally (Tz / image width) to the paint's advance width, which is the
 * width the screen uses (SVG textLength), so the PDF lines up with what the user saw.
 */
import type { PDFDocument, PDFFont, PDFRef } from '@cantoo/pdf-lib';
import type { ExportContext } from '@/core/types';
import { hexToRgb01, assetUrl } from '@/core/util';
import type { TextPaint } from './paint';
import { charWidth, FONT_STACK } from './fonts';

const f = (v: number) => {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return '0';
  return Number(v.toFixed(3)).toString();
};
const rgb = (hex: string) => hexToRgb01(hex).map(f).join(' ');

export interface TextResources {
  /** Register a font resource; returns its resource name. */
  font(key: string, ref: PDFRef): string;
  /** Register an XObject resource; returns its resource name. */
  xobject(prefix: string, ref: PDFRef): string;
}

// ── fonts ────────────────────────────────────────────────────────────────────

const LIBERATION = {
  regular: assetUrl('pdfjs/standard_fonts/LiberationSans-Regular.ttf'),
  bold: assetUrl('pdfjs/standard_fonts/LiberationSans-Bold.ttf'),
};

const charSets = new WeakMap<PDFFont, Set<number>>();
function covers(font: PDFFont, text: string): boolean {
  let set = charSets.get(font);
  if (!set) {
    try {
      set = new Set(font.getCharacterSet());
    } catch {
      set = new Set();
    }
    charSets.set(font, set);
  }
  for (const ch of text) if (!set.has(ch.codePointAt(0)!)) return false;
  return true;
}

async function liberation(ctx: ExportContext, bold: boolean): Promise<PDFFont | null> {
  const url = bold ? LIBERATION.bold : LIBERATION.regular;
  try {
    // ctx.customFont patches the fontkit subset; the URL key shares one embedded subset with the other features.
    return await ctx.customFont(url, async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Font ${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  } catch {
    return null;
  }
}

/** Tz operator that scales `actual` to `target` (empty when they already agree). */
function tz(target: number, actual: number): string[] {
  if (!(actual > 0) || !(target > 0)) return [];
  const pct = (target / actual) * 100;
  return Math.abs(pct - 100) < 0.05 ? [] : [`${f(pct)} Tz`];
}

// ── raster fallback ──────────────────────────────────────────────────────────

const rasterCache = new WeakMap<PDFDocument, Map<string, Promise<PDFRef | null>>>();

/** Margins of the raster box around the advance box, in em. */
const ASC = 1.0;
const DESC = 0.3;
const PAD = 0.15;

async function rasterize(p: TextPaint): Promise<Uint8Array | null> {
  if (typeof document === 'undefined') return null;
  const W = p.width + 2 * PAD * p.size;
  const H = (ASC + DESC) * p.size;
  const S = Math.max(1, Math.min(8, 4096 / Math.max(1, W), 4096 / Math.max(1, H)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(W * S));
  canvas.height = Math.max(1, Math.ceil(H * S));
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.font = `${p.bold ? 700 : 400} ${p.size * S}px ${FONT_STACK}`;
  g.fillStyle = p.color;
  g.textBaseline = 'alphabetic';
  const natural = g.measureText(p.text).width;
  const sx = natural > 0 ? (p.width * S) / natural : 1;
  g.setTransform(sx, 0, 0, 1, PAD * p.size * S, ASC * p.size * S);
  g.fillText(p.text, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

function rasterImage(doc: PDFDocument, p: TextPaint): Promise<PDFRef | null> {
  let cache = rasterCache.get(doc);
  if (!cache) rasterCache.set(doc, (cache = new Map()));
  const key = JSON.stringify([p.text, p.size, !!p.bold, p.color, Math.round(p.width * 100)]);
  let hit = cache.get(key);
  if (!hit) {
    hit = rasterize(p).then((png) => (png ? doc.embedPng(png).then((img) => img.ref) : null));
    hit.catch(() => cache!.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const utf16Hex = (ch: string) => Array.from({ length: ch.length }, (_, i) => hex4(ch.charCodeAt(i))).join('');
const glyphName = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c > 0xffff ? `u${c.toString(16).toUpperCase()}` : `uni${hex4(c)}`;
};

/**
 * Invisible (render mode 3) text runs for `text`: simple fonts based on the (non-embedded) standard
 * Helvetica with a custom encoding — up to 255 distinct characters each — whose ToUnicode CMap maps
 * the codes back to the characters and whose widths are the layout advances. Viewers never draw the
 * glyphs; the text stays searchable, selectable and extractable.
 */
function invisibleRuns(doc: PDFDocument, text: string, bold: boolean): { runs: { ref: PDFRef; hex: string }[]; width: number } {
  const ctx = doc.context;
  const adv = (c: string) => Math.max(0, Math.round(charWidth(c, bold)));
  const runs: { ref: PDFRef; hex: string }[] = [];
  let width = 0;
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
        BaseFont: bold ? 'Helvetica-Bold' : 'Helvetica',
        FirstChar: 1,
        LastChar: chars.length,
        Widths: chars.map(adv),
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
    width += adv(ch);
  }
  flush();
  return { runs, width: width / 1000 };
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Operators (wrapped in q/Q) drawing a text paint; resources are registered through `res`. */
export async function textOps(ctx: ExportContext, p: TextPaint, res: TextResources): Promise<string[]> {
  if (!p.text || !(p.size > 0)) return [];
  const bold = !!p.bold;
  const pos = `${f(p.x)} ${f(p.y)} Td`;

  // 1. Embedded Liberation Sans (Helvetica-compatible metrics; looks the same in every viewer).
  const lib = await liberation(ctx, bold);
  if (lib && covers(lib, p.text)) {
    const name = res.font(bold ? 'DLSB' : 'DLS', lib.ref);
    const hex = lib.encodeText(p.text).toString();
    return ['q', 'BT', `/${name} ${f(p.size)} Tf`, ...tz(p.width, lib.widthOfTextAtSize(p.text, p.size)), `${rgb(p.color)} rg`, pos, `${hex} Tj`, 'ET', 'Q'];
  }

  // 2. Standard Helvetica (WinAnsi), if the font file is unavailable.
  const std = await ctx.standardFont(bold ? 'Helvetica-Bold' : 'Helvetica');
  if (covers(std, p.text)) {
    const name = res.font(bold ? 'HeBo' : 'Helv', std.ref);
    const hex = std.encodeText(p.text).toString();
    return ['q', 'BT', `/${name} ${f(p.size)} Tf`, ...tz(p.width, std.widthOfTextAtSize(p.text, p.size)), `${rgb(p.color)} rg`, pos, `${hex} Tj`, 'ET', 'Q'];
  }

  // 3. Image of the line + invisible text.
  const out: string[] = [];
  const img = await rasterImage(ctx.pdfDoc, p);
  if (img) {
    const name = res.xobject('Tx', img);
    const x = p.x - PAD * p.size;
    const y = p.y - DESC * p.size;
    out.push('q', `${f(p.width + 2 * PAD * p.size)} 0 0 ${f((ASC + DESC) * p.size)} ${f(x)} ${f(y)} cm`, `/${name} Do`, 'Q');
  }
  const inv = invisibleRuns(ctx.pdfDoc, p.text, bold);
  out.push('q', 'BT', `${img ? 3 : 0} Tr`, ...tz(p.width, inv.width * p.size), `${rgb(p.color)} rg`, pos);
  for (const r of inv.runs) out.push(`/${res.font('GL', r.ref)} ${f(p.size)} Tf`, `${r.hex} Tj`);
  out.push('ET', 'Q');
  return out;
}
