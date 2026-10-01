/**
 * Shared helpers for writing Fill & Sign items into page content (flattened: text as real text,
 * marks as vector paths, signatures as images).
 */
import { PDFString, type PDFDict, type PDFDocument, type PDFRef } from '@cantoo/pdf-lib';
import type { ExportContext, PdfObject, Rect, Rotation } from '@/core/types';
import { hexToRgb01 } from '@/core/util';
import { uprightMatrix } from './model';

/** Compact number for content streams. */
export const f = (v: number) => {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return '0';
  return Number(v.toFixed(4)).toString();
};

export function rgb(hex: string | undefined, fallback = '#000000'): string {
  const [r, g, b] = hexToRgb01(hex || fallback);
  return `${f(r)} ${f(g)} ${f(b)}`;
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d };
}

/**
 * Draw `ops` expressed in the item's upright local frame (0..W × 0..H, y up) into the page content,
 * clipped to a slightly inflated rect so antialiasing / round caps are not cut off.
 */
export function drawLocal(ctx: ExportContext, obj: PdfObject, rot: Rotation, ops: string, resources?: PDFDict, margin = 2) {
  const page = ctx.page(obj.pageId);
  const m = uprightMatrix(obj.rect, rot);
  const body = `q\n${m.map(f).join(' ')} cm\n${ops}\nQ`;
  ctx.annots.drawAppearance(page, { ops: body, resources, bbox: inflate(obj.rect, margin) }, obj.opacity);
}

// Embedded images, cached per output document so a signature used many times is stored once.
const imageCache = new WeakMap<PDFDocument, Map<string, Promise<PDFRef>>>();

export function embedPngCached(doc: PDFDocument, key: string, bytes: () => Promise<Uint8Array>): Promise<PDFRef> {
  let cache = imageCache.get(doc);
  if (!cache) imageCache.set(doc, (cache = new Map()));
  let p = cache.get(key);
  if (!p) {
    p = bytes().then((b) => doc.embedPng(b)).then((img) => img.ref);
    p.catch(() => cache!.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Short stable hash for cache keys (FNV-1a over a sample of the string). */
export function hashKey(s: string): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(s.length / 4096));
  for (let i = 0; i < s.length; i += step) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

// ── custom fonts ─────────────────────────────────────────────────────────────

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const utf16Hex = (ch: string) => Array.from({ length: ch.length }, (_, i) => hex4(ch.charCodeAt(i))).join('');

/**
 * A glyph-less Type0 font for invisible (render mode 3) text over an image, like OCR output: the
 * text stays searchable, selectable and extractable (ToUnicode) when no embeddable font covers it.
 * One CID per distinct character; widths (1/1000 em) come from `advance`.
 */
export function invisibleTextFont(doc: PDFDocument, text: string, advance: (ch: string) => number): { ref: PDFRef; encode(line: string): string } {
  const chars = [...new Set([...text.replace(/\n/g, '')])].slice(0, 0xfffe);
  const cid = new Map<string, number>();
  chars.forEach((c, i) => cid.set(c, i + 1));
  const ctx = doc.context;
  const bf: string[] = [];
  for (let i = 0; i < chars.length; i += 100) {
    const chunk = chars.slice(i, i + 100);
    bf.push(`${chunk.length} beginbfchar`, ...chunk.map((c, j) => `<${hex4(i + j + 1)}> <${utf16Hex(c)}>`), 'endbfchar');
  }
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...bf,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const toUnicode = ctx.register(ctx.flateStream(cmap));
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'GlyphLessFont',
      Flags: 4,
      FontBBox: [0, -250, 1000, 950],
      ItalicAngle: 0,
      Ascent: 950,
      Descent: -250,
      CapHeight: 700,
      StemV: 80,
    }),
  );
  const cidFont = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'GlyphLessFont',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 1000,
      W: [1, chars.map((c) => Math.max(0, Math.round(advance(c))))],
      CIDToGIDMap: 'Identity',
    }),
  );
  const ref = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'GlyphLessFont', Encoding: 'Identity-H', DescendantFonts: [cidFont], ToUnicode: toUnicode }),
  );
  return { ref, encode: (line) => `<${[...line].map((c) => hex4(cid.get(c) ?? 0)).join('')}>` };
}
