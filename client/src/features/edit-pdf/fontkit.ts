/**
 * fontkit for pdf-lib font subsetting.
 *
 * @cantoo/pdf-lib serializes a subset with `subset.encode()` whenever the method exists, expecting
 * the newer fontkit API that returns the bytes. The @pdf-lib/fontkit subset has an internal
 * `encode(stream)` that needs a stream, so subsetting a TrueType font fails at save time
 * ("Cannot read properties of undefined (reading 'pos')"). This wrapper makes `encode()` with no
 * argument collect the bytes from `encodeStream()`. pdf-lib accepts a promise there.
 */
import * as fontkitNs from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib';

type Fontkit = Parameters<PDFDocument['registerFontkit']>[0];

const base = ((fontkitNs as unknown as { default?: unknown }).default ?? fontkitNs) as Fontkit;

interface ByteStream {
  on(event: string, cb: (data: Uint8Array) => void): ByteStream;
}
interface LegacySubset {
  encode(stream?: unknown): unknown;
  encodeStream(): ByteStream;
}
interface PatchableFont {
  createSubset(): unknown;
}

function merge(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function patchSubset(s: LegacySubset): void {
  if (typeof s.encode !== 'function' || typeof s.encodeStream !== 'function') return;
  const encode = s.encode.bind(s);
  s.encode = (stream?: unknown) => {
    if (stream !== undefined) return encode(stream);
    return new Promise<Uint8Array>((resolve, reject) => {
      const parts: Uint8Array[] = [];
      try {
        s.encodeStream()
          .on('data', (d) => parts.push(d))
          .on('end', () => resolve(merge(parts)))
          .on('error', (e) => reject(e));
      } catch (e) {
        reject(e);
      }
    });
  };
}

function patchFont<T>(font: T): T {
  const f = font as unknown as PatchableFont | null;
  if (!f || typeof f.createSubset !== 'function') return font;
  const make = f.createSubset.bind(f);
  f.createSubset = () => {
    const s = make();
    patchSubset(s as LegacySubset);
    return s;
  };
  return font;
}

/** @pdf-lib/fontkit whose subsets serialize correctly with @cantoo/pdf-lib. */
export const fontkit: Fontkit = {
  create(buffer, postscriptName) {
    const r = base.create(buffer, postscriptName);
    return r instanceof Promise ? r.then(patchFont) : patchFont(r);
  },
};

/** Subset-embeds a TrueType font with the fixed fontkit, leaving the document's own fontkit in place. */
export function embedSubsetFont(lib: PDFDocument, bytes: ArrayBuffer): Promise<PDFFont> {
  const holder = lib as unknown as { fontkit?: Fontkit };
  const prev = holder.fontkit;
  lib.registerFontkit(fontkit);
  try {
    // pdf-lib reads the fontkit synchronously when the call starts
    return lib.embedFont(bytes, { subset: true });
  } finally {
    if (prev) lib.registerFontkit(prev);
  }
}
