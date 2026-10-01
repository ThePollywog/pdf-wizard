/**
 * Fonts for text written into exported PDFs.
 *
 * The standard 14 fonts only encode WinAnsi (Latin-1 plus a few symbols). For user text use
 * `fontForText(ctx, text, 'Helvetica')`: it returns the standard font when it can encode the text,
 * else the first bundled Unicode fallback font that can (UNICODE_FONT_URLS: Noto Sans for Latin
 * Extended, Greek and Cyrillic, then Droid Sans Fallback for CJK), embedded as a subset CID font —
 * real, searchable, copyable text in every viewer. The fonts ship with the app (public/fonts) and
 * are only downloaded the first time they are needed. Pass the result through
 * `encodableText(font, text)` before drawing: characters no available font has become '?'.
 */
import type { PDFFont, StandardFonts } from '@cantoo/pdf-lib';
import type { ExportContext } from '../types';
import { assetUrl } from '../util';

export const UNICODE_FONT_URLS = [assetUrl('fonts/NotoSans-Regular.ttf'), assetUrl('fonts/DroidSansFallbackFull.ttf')] as const;
/** The primary fallback (kept for callers that embed a single Unicode font). */
export const UNICODE_FONT_URL = UNICODE_FONT_URLS[0];
/** After a failed fetch (offline before the font was ever cached) don't retry for a while. */
const RETRY_MS = 60_000;
const unavailableUntil = new Map<string, number>();

async function fallbackFont(ctx: ExportContext, url: string): Promise<PDFFont | null> {
  if (Date.now() < (unavailableUntil.get(url) ?? 0)) return null;
  try {
    return await ctx.customFont(url, async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Font unavailable (${res.status})`);
      return res.arrayBuffer();
    });
  } catch {
    unavailableUntil.set(url, Date.now() + RETRY_MS);
    return null;
  }
}

/** The primary Unicode fallback font embedded into this export (memoized per export), or null when it can't be loaded. */
export function unicodeFont(ctx: ExportContext): Promise<PDFFont | null> {
  return fallbackFont(ctx, UNICODE_FONT_URL);
}

const charSets = new WeakMap<PDFFont, Set<number>>();
function charSet(font: PDFFont): Set<number> {
  let set = charSets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charSets.set(font, set);
  }
  return set;
}

const isControl = (cp: number) => cp === 9 || cp === 10 || cp === 13;

/** Whether `font` has a glyph for every character of `text` (tabs and line breaks are ignored). */
export function canEncode(font: PDFFont, text: string): boolean {
  const set = charSet(font);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!isControl(cp) && !set.has(cp)) return false;
  }
  return true;
}

/** `text` with every character `font` can't draw replaced by '?' (safe to pass to drawText / encodeText). */
export function encodableText(font: PDFFont, text: string): string {
  if (canEncode(font, text)) return text;
  const set = charSet(font);
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += isControl(cp) || set.has(cp) ? ch : '?';
  }
  return out;
}

/**
 * `preferred` when it can encode `text`, else the Unicode fallback font when it covers more of the
 * text, else `preferred`. Note the fallback font has no bold/italic faces.
 */
export async function fontForText(
  ctx: ExportContext,
  text: string,
  preferred: StandardFonts | `${StandardFonts}` = 'Helvetica',
): Promise<PDFFont> {
  const std = await ctx.standardFont(preferred);
  if (canEncode(std, text)) return std;
  const covered = (f: PDFFont) => {
    const set = charSet(f);
    let n = 0;
    for (const ch of text) if (set.has(ch.codePointAt(0)!)) n++;
    return n;
  };
  let best = std;
  let bestCount = covered(std);
  for (const url of UNICODE_FONT_URLS) {
    const f = await fallbackFont(ctx, url);
    if (!f) continue;
    if (canEncode(f, text)) return f;
    const n = covered(f);
    if (n > bestCount) [best, bestCount] = [f, n];
  }
  return best;
}
