/** Small pdf-lib object helpers (kept local so the content engine has no app dependencies). */
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString,
  decodePDFRawStream, type PDFContext, type PDFObject,
} from '@cantoo/pdf-lib';

export const N = (n: string) => PDFName.of(n);

export function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  let v = o;
  for (let i = 0; i < 8 && v instanceof PDFRef; i++) v = ctx.lookup(v);
  return v instanceof PDFRef ? undefined : v;
}

export function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(ctx, o);
  if (v instanceof PDFStream) return v.dict;
  return v instanceof PDFDict ? v : undefined;
}

export function arrayOf(ctx: PDFContext, o: PDFObject | undefined): PDFArray | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFArray ? v : undefined;
}

export function numOf(ctx: PDFContext, o: PDFObject | undefined): number | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function nameOfObj(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function strOf(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}

export function numsOf(ctx: PDFContext, o: PDFObject | undefined): number[] | undefined {
  const a = arrayOf(ctx, o);
  if (!a) return undefined;
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const n = numOf(ctx, a.get(i));
    if (n === undefined || !Number.isFinite(n)) return undefined;
    out.push(n);
  }
  return out;
}

export function get(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFObject | undefined {
  return d ? resolve(ctx, d.get(N(key))) : undefined;
}

/** Decoded bytes of a stream (null when a filter isn't supported, e.g. DCT content — never for content). */
export function streamBytes(s: PDFObject | undefined): Uint8Array | null {
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    // pdf-lib content streams built in memory (pushOperators) hold unencoded operators
    const u = s as unknown as { getUnencodedContents?: () => Uint8Array };
    if (s instanceof PDFStream && typeof u.getUnencodedContents === 'function') return u.getUnencodedContents();
    if (s instanceof PDFStream) return s.getContents();
  } catch {
    return null;
  }
  return null;
}

export function refKey(r: PDFObject | undefined): string {
  return r instanceof PDFRef ? `${r.objectNumber} ${r.generationNumber}` : '';
}

/** A resource name not used yet in `sub` (e.g. "EdF1", "EdF2"…). */
export function freshName(sub: PDFDict, prefix: string): string {
  const used = new Set(sub.keys().map((k) => k.decodeText()));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}
