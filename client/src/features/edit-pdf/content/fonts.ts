/**
 * Font model for the content interpreter: code splitting, glyph widths (/Widths, /W, standard-14
 * metrics), Unicode (ToUnicode, encodings, glyph names), style (family / bold / italic) and
 * vertical metrics. Only what text *removal* and re-typesetting need — no glyph outlines.
 */
import { PDFDict, PDFName, PDFStream, StandardFontEmbedder, parseToUnicode, type PDFContext, type PDFObject } from '@cantoo/pdf-lib';
import { arrayOf, dictOf, get, nameOfObj, numOf, numsOf, resolve, streamBytes } from './pdfobj';
import { encodingTable, glyphToUnicode, type EncodingName } from './encodings';
import { latin1 } from './parser';
import type { Matrix } from './matrix';

export type StdFontName =
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique'
  | 'Symbol' | 'ZapfDingbats';

export type Family = 'sans' | 'serif' | 'mono';

export interface FontInfo {
  /** Stable identity of the font dict within one document load. */
  id: number;
  baseFont: string;
  subtype: string;
  /** Standard-14 font this one is (or is metric-compatible with). */
  standard: StdFontName;
  /** True when the font program is not embedded and the font is a standard-14 font. */
  isStandard14: boolean;
  embedded: boolean;
  bytesPerCode: 1 | 2;
  vertical: boolean;
  /** Glyph removal is reliable (widths known, codes splittable). False for Type3 / unknown CMaps. */
  removable: boolean;
  /** Simple font whose codes map through WinAnsi/Standard encoding without /Differences. */
  plainEncoding: boolean;
  /** Simple font with plain WinAnsi encoding (codes = WinAnsi). */
  winAnsi: boolean;
  fontMatrix: Matrix;
  family: Family;
  bold: boolean;
  italic: boolean;
  /** Vertical metrics in 1/1000 em. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** Width of a code in 1/1000 text-space units. */
  width(code: number): number;
  /** Unicode for a code ('' when unknown). */
  unicode(code: number): string;
  /** Splits string bytes into codes. */
  codes(bytes: Uint8Array): { code: number; start: number; len: number }[];
}

// ── standard 14 ──────────────────────────────────────────────────────────────

const stdCache = new Map<StdFontName, StandardFontEmbedder>();
export function stdEmbedder(name: StdFontName): StandardFontEmbedder {
  let e = stdCache.get(name);
  if (!e) {
    e = StandardFontEmbedder.for(name as never);
    stdCache.set(name, e);
  }
  return e;
}

export function stdFontFor(family: Family, bold: boolean, italic: boolean): StdFontName {
  if (family === 'serif') return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  if (family === 'mono') return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier';
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica';
}

const STD_NAMES = new Set<string>([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold',
  'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
]);

/** Standard metrics for a glyph name (1/1000 em) or undefined. */
function stdWidth(std: StdFontName, glyph: string): number | undefined {
  if (!glyph) return undefined;
  const w = stdEmbedder(std).font.getWidthOfGlyph(glyph);
  return typeof w === 'number' ? w : undefined;
}

export function stripSubset(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

export function styleFromName(name: string, flags = 0, weight = 0, italicAngle = 0): { family: Family; bold: boolean; italic: boolean } {
  const n = stripSubset(name);
  const lower = n.toLowerCase();
  let family: Family = 'sans';
  if ((flags & 1) !== 0 || /courier|mono|consol|menlo|typewriter|inconsolata|lucida ?console|fixed/.test(lower)) family = 'mono';
  else if (
    /times|georgia|garamond|cambria|palatino|minion|bookman|baskerville|caslon|century|serif|roman|charter|didot|bodoni|constantia|book ?antiqua|liberation ?serif|nimbus ?rom|dejavu ?serif|pt ?serif|noto ?serif|source ?serif|tinos/.test(lower) &&
    !/sans/.test(lower)
  )
    family = 'serif';
  else if ((flags & 2) !== 0 && !/sans|arial|helvet|verdana|tahoma|calibri|segoe|roboto|inter|open ?sans/.test(lower)) family = 'serif';
  const bold = /bold|black|heavy|semibold|demibold|extrabold|ultrabold|,bd|-bd\b/.test(lower) || weight >= 600 || (flags & (1 << 18)) !== 0;
  const italic = /italic|oblique|slanted|,it\b|-it\b/.test(lower) || Math.abs(italicAngle) > 0.5 || (flags & (1 << 6)) !== 0;
  return { family, bold, italic };
}

/** Standard-14 equivalent (exact name or common aliases like ArialMT / TimesNewRomanPS-BoldMT). */
export function standardFor(baseFont: string, style: { family: Family; bold: boolean; italic: boolean }): { std: StdFontName; exact: boolean } {
  const n = stripSubset(baseFont);
  if (STD_NAMES.has(n)) return { std: n as StdFontName, exact: true };
  const alias: Record<string, StdFontName> = {
    Arial: 'Helvetica', ArialMT: 'Helvetica', 'Arial,Bold': 'Helvetica-Bold', 'Arial-BoldMT': 'Helvetica-Bold',
    'Arial,Italic': 'Helvetica-Oblique', 'Arial-ItalicMT': 'Helvetica-Oblique', 'Arial,BoldItalic': 'Helvetica-BoldOblique',
    'Arial-BoldItalicMT': 'Helvetica-BoldOblique', 'Helvetica,Bold': 'Helvetica-Bold', 'Helvetica,Italic': 'Helvetica-Oblique',
    TimesNewRoman: 'Times-Roman', TimesNewRomanPSMT: 'Times-Roman', 'TimesNewRoman,Bold': 'Times-Bold',
    'TimesNewRomanPS-BoldMT': 'Times-Bold', 'TimesNewRoman,Italic': 'Times-Italic', 'TimesNewRomanPS-ItalicMT': 'Times-Italic',
    'TimesNewRoman,BoldItalic': 'Times-BoldItalic', 'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
    CourierNew: 'Courier', CourierNewPSMT: 'Courier', 'CourierNew,Bold': 'Courier-Bold', 'CourierNewPS-BoldMT': 'Courier-Bold',
    'CourierNew,Italic': 'Courier-Oblique', 'CourierNewPS-ItalicMT': 'Courier-Oblique',
  };
  if (alias[n]) return { std: alias[n], exact: true };
  if (/symbol/i.test(n)) return { std: 'Symbol', exact: false };
  if (/dingbat/i.test(n)) return { std: 'ZapfDingbats', exact: false };
  return { std: stdFontFor(style.family, style.bold, style.italic), exact: false };
}

// ── loading ──────────────────────────────────────────────────────────────────

let nextId = 1;
const fontCache = new WeakMap<object, FontInfo>();

const DEFAULT_FM: Matrix = [0.001, 0, 0, 0.001, 0, 0];

/** FontInfo for a font dict (cached per dict object). */
export function loadFont(ctx: PDFContext, fontObj: PDFObject | undefined): FontInfo {
  const dict = dictOf(ctx, fontObj);
  if (dict) {
    const hit = fontCache.get(dict);
    if (hit) return hit;
  }
  const info = dict ? buildFont(ctx, dict) : fallbackFont();
  if (dict) fontCache.set(dict, info);
  return info;
}

function fallbackFont(): FontInfo {
  const std: StdFontName = 'Helvetica';
  const table = encodingTable('WinAnsi');
  return {
    id: nextId++, baseFont: 'Helvetica', subtype: 'Type1', standard: std, isStandard14: true, embedded: false,
    bytesPerCode: 1, vertical: false, removable: true, plainEncoding: true, winAnsi: true, fontMatrix: DEFAULT_FM,
    family: 'sans', bold: false, italic: false, ascent: 718, descent: -207, capHeight: 718,
    width: (c) => stdWidth(std, table[c]) ?? 0,
    unicode: (c) => glyphToUnicode(table[c]),
    codes: singleByteCodes,
  };
}

function singleByteCodes(bytes: Uint8Array) {
  const out: { code: number; start: number; len: number }[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = { code: bytes[i], start: i, len: 1 };
  return out;
}

function doubleByteCodes(bytes: Uint8Array) {
  const out: { code: number; start: number; len: number }[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) out.push({ code: (bytes[i] << 8) | bytes[i + 1], start: i, len: 2 });
  return out;
}

function toUnicodeMap(ctx: PDFContext, dict: PDFDict): Map<number, string> | null {
  const tu = resolve(ctx, dict.get(PDFName.of('ToUnicode')));
  if (!(tu instanceof PDFStream)) return null;
  const bytes = streamBytes(tu);
  if (!bytes) return null;
  try {
    return parseToUnicode(latin1(bytes));
  } catch {
    return null;
  }
}

function descriptorOf(ctx: PDFContext, dict: PDFDict): PDFDict | undefined {
  return dictOf(ctx, dict.get(PDFName.of('FontDescriptor')));
}

function isEmbedded(ctx: PDFContext, fd: PDFDict | undefined): boolean {
  if (!fd) return false;
  return !!(fd.get(PDFName.of('FontFile')) || fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3')));
}

function buildFont(ctx: PDFContext, dict: PDFDict): FontInfo {
  const subtype = nameOfObj(ctx, dict.get(PDFName.of('Subtype'))) ?? 'Type1';
  if (subtype === 'Type0') return buildType0(ctx, dict);
  const baseFont = stripSubset(nameOfObj(ctx, dict.get(PDFName.of('BaseFont'))) ?? (subtype === 'Type3' ? 'Type3' : 'Unknown'));
  const fd = descriptorOf(ctx, dict);
  const flags = numOf(ctx, fd?.get(PDFName.of('Flags'))) ?? 0;
  const style = styleFromName(baseFont, flags, numOf(ctx, fd?.get(PDFName.of('FontWeight'))) ?? 0, numOf(ctx, fd?.get(PDFName.of('ItalicAngle'))) ?? 0);
  const { std, exact } = standardFor(baseFont, style);
  const embedded = isEmbedded(ctx, fd);
  const isStandard14 = exact && !embedded && subtype !== 'Type3';

  // encoding → glyph names per code
  const encObj = get(ctx, dict, 'Encoding');
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  let baseEnc: EncodingName | null = null;
  let hasDifferences = false;
  const encName = encObj instanceof PDFName ? encObj.decodeText() : encObj instanceof PDFDict ? nameOfObj(ctx, encObj.get(PDFName.of('BaseEncoding'))) : undefined;
  if (encName === 'WinAnsiEncoding') baseEnc = 'WinAnsi';
  else if (encName === 'MacRomanEncoding') baseEnc = 'MacRoman';
  else if (encName === 'StandardEncoding') baseEnc = 'Standard';
  else if (std !== 'Symbol' && std !== 'ZapfDingbats' && !symbolic) baseEnc = subtype === 'TrueType' ? 'WinAnsi' : 'Standard';
  const names: string[] = baseEnc ? encodingTable(baseEnc).slice() : new Array<string>(256).fill('');
  if (encObj instanceof PDFDict) {
    const diffs = arrayOf(ctx, encObj.get(PDFName.of('Differences')));
    if (diffs) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const v = resolve(ctx, diffs.get(i));
        const n = numOf(ctx, v);
        if (n !== undefined) code = n;
        else if (v instanceof PDFName) {
          if (code >= 0 && code < 256) names[code] = v.decodeText();
          code++;
          hasDifferences = true;
        }
      }
    }
  }
  if (!baseEnc && (std === 'Symbol' || std === 'ZapfDingbats') && isStandard14) {
    // built-in encodings of Symbol/Dingbats: glyph names unknown here → widths via /Widths only
  }

  const tu = toUnicodeMap(ctx, dict);
  const firstChar = numOf(ctx, dict.get(PDFName.of('FirstChar'))) ?? 0;
  const widths = numsOf(ctx, dict.get(PDFName.of('Widths')));
  const missing = numOf(ctx, fd?.get(PDFName.of('MissingWidth'))) ?? 0;
  const fm = (numsOf(ctx, dict.get(PDFName.of('FontMatrix'))) as Matrix | undefined) ?? DEFAULT_FM;
  const fmScale = subtype === 'Type3' ? (fm[0] || 0.001) * 1000 : 1;

  const width = (code: number): number => {
    if (widths && code >= firstChar && code - firstChar < widths.length) return widths[code - firstChar] * fmScale;
    if (subtype !== 'Type3') {
      const w = stdWidth(std, names[code]);
      if (w !== undefined && (!widths || isStandard14)) return w;
    }
    return missing * fmScale;
  };
  const unicode = (code: number): string => {
    const t = tu?.get(code);
    if (t !== undefined) return t;
    const g = names[code];
    const u = g ? glyphToUnicode(g) : '';
    if (u) return u;
    if (!baseEnc && !hasDifferences && code >= 32 && code < 127) return String.fromCharCode(code);
    return '';
  };
  const std14Asc = stdEmbedder(std).font.Ascender;
  const std14Desc = stdEmbedder(std).font.Descender;
  const std14Cap = stdEmbedder(std).font.CapHeight;
  const bbox = numsOf(ctx, fd?.get(PDFName.of('FontBBox')));
  let ascent = numOf(ctx, fd?.get(PDFName.of('Ascent'))) ?? (typeof std14Asc === 'number' ? std14Asc : bbox?.[3] ?? 750);
  let descent = numOf(ctx, fd?.get(PDFName.of('Descent'))) ?? (typeof std14Desc === 'number' ? std14Desc : bbox?.[1] ?? -250);
  if (subtype === 'Type3') {
    ascent = 800;
    descent = -200;
  }
  if (!(ascent > 0)) ascent = 750;
  if (!(descent < 0)) descent = -Math.abs(descent || 250);
  const capHeight = numOf(ctx, fd?.get(PDFName.of('CapHeight'))) ?? (typeof std14Cap === 'number' ? std14Cap : ascent * 0.9);

  return {
    id: nextId++,
    baseFont,
    subtype,
    standard: std,
    isStandard14,
    embedded,
    bytesPerCode: 1,
    vertical: false,
    removable: subtype !== 'Type3' && (!!widths || isStandard14 || exact),
    plainEncoding: !hasDifferences && (baseEnc === 'WinAnsi' || (baseEnc === 'Standard' && !embedded)),
    winAnsi: !hasDifferences && baseEnc === 'WinAnsi',
    fontMatrix: subtype === 'Type3' ? fm : DEFAULT_FM,
    ...style,
    ascent,
    descent,
    capHeight,
    width,
    unicode,
    codes: singleByteCodes,
  };
}

function buildType0(ctx: PDFContext, dict: PDFDict): FontInfo {
  const baseFont = stripSubset(nameOfObj(ctx, dict.get(PDFName.of('BaseFont'))) ?? 'Unknown');
  const descendants = arrayOf(ctx, dict.get(PDFName.of('DescendantFonts')));
  const cid = dictOf(ctx, descendants?.get(0));
  const fd = cid ? descriptorOf(ctx, cid) : undefined;
  const flags = numOf(ctx, fd?.get(PDFName.of('Flags'))) ?? 0;
  const style = styleFromName(baseFont, flags, numOf(ctx, fd?.get(PDFName.of('FontWeight'))) ?? 0, numOf(ctx, fd?.get(PDFName.of('ItalicAngle'))) ?? 0);
  const { std } = standardFor(baseFont, style);
  const encObj = get(ctx, dict, 'Encoding');
  const encName = encObj instanceof PDFName ? encObj.decodeText() : '';
  let twoByte = /-(H|V)$/.test(encName) && /Identity|UCS2|UTF16|UniGB-UCS2|UniJIS-UCS2|UniKS-UCS2|UniCNS-UCS2/.test(encName);
  let removable = twoByte;
  if (encObj instanceof PDFStream) {
    const bytes = streamBytes(encObj);
    const text = bytes ? latin1(bytes) : '';
    const ranges = [...text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)].map((m) => m[1]).join(' ');
    const lens = [...ranges.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1].length / 2);
    twoByte = lens.length > 0 && lens.every((l) => l === 2);
    removable = twoByte;
  }
  const vertical = /-V$/.test(encName);
  const dw = numOf(ctx, cid?.get(PDFName.of('DW'))) ?? 1000;
  const wmap = new Map<number, number>();
  const W = arrayOf(ctx, cid?.get(PDFName.of('W')));
  if (W) {
    let i = 0;
    while (i < W.size()) {
      const first = numOf(ctx, W.get(i));
      const next = resolve(ctx, W.get(i + 1));
      if (first === undefined) break;
      const arr = arrayOf(ctx, next);
      if (arr) {
        for (let k = 0; k < arr.size(); k++) wmap.set(first + k, numOf(ctx, arr.get(k)) ?? dw);
        i += 2;
      } else {
        const last = numOf(ctx, next);
        const w = numOf(ctx, W.get(i + 2));
        if (last === undefined || w === undefined) break;
        for (let c = first; c <= last && c - first < 65536; c++) wmap.set(c, w);
        i += 3;
      }
    }
  }
  // CID ↔ code: Identity only (other CMaps: codes are used as CIDs approximately)
  const tu = toUnicodeMap(ctx, dict);
  const bbox = numsOf(ctx, fd?.get(PDFName.of('FontBBox')));
  let ascent = numOf(ctx, fd?.get(PDFName.of('Ascent'))) ?? bbox?.[3] ?? 880;
  let descent = numOf(ctx, fd?.get(PDFName.of('Descent'))) ?? bbox?.[1] ?? -120;
  if (!(ascent > 0)) ascent = 880;
  if (!(descent < 0)) descent = -Math.abs(descent || 120);
  return {
    id: nextId++,
    baseFont,
    subtype: 'Type0',
    standard: std,
    isStandard14: false,
    embedded: isEmbedded(ctx, fd),
    bytesPerCode: twoByte ? 2 : 1,
    vertical,
    removable: removable && !vertical,
    plainEncoding: false,
    winAnsi: false,
    fontMatrix: DEFAULT_FM,
    ...style,
    ascent,
    descent,
    capHeight: numOf(ctx, fd?.get(PDFName.of('CapHeight'))) ?? ascent * 0.8,
    width: (code) => wmap.get(code) ?? dw,
    unicode: (code) => tu?.get(code) ?? '',
    codes: twoByte ? doubleByteCodes : singleByteCodes,
  };
}

/** Encodes text for a standard-14 font with WinAnsi encoding; null when a character isn't encodable. */
export function encodeWinAnsi(text: string, std: StdFontName): Uint8Array | null {
  const enc = stdEmbedder(std).encoding;
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!enc.canEncodeUnicodeCodePoint(cp)) return null;
    out.push(enc.encodeUnicodeCodePoint(cp).code);
  }
  return Uint8Array.from(out);
}

/** Width (1/1000 em) of a WinAnsi code in a standard-14 font. */
export function stdCodeWidth(std: StdFontName, code: number): number {
  return stdWidth(std, encodingTable('WinAnsi')[code]) ?? 0;
}
