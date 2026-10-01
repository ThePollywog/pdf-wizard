/**
 * Document Properties → Fonts: every font referenced from page resources, form XObjects (nested),
 * Type 3 glyph resources and annotation appearance streams, with type, encoding and embedding.
 */
import { PDFDict, PDFName, PDFStream, type PDFContext } from '@cantoo/pdf-lib';
import type { DocId } from '@/core/types';
import * as engine from '@/core/engine';
import { N, inheritable, leavesOf, lookup, lookupArray, lookupDict, nameOf } from '@/core/engine/lib';
import { getDoc } from '@/core/store';

export interface FontInfo {
  name: string;
  type: string;
  encoding: string;
  embedded: 'embedded' | 'subset' | 'no';
  /** 1-based pages where the font is used (first few). */
  pages: number[];
}

const TYPE_LABEL: Record<string, string> = {
  Type1: 'Type 1',
  MMType1: 'Multiple Master Type 1',
  TrueType: 'TrueType',
  Type3: 'Type 3',
  Type0: 'Type 0',
  CIDFontType0: 'Type 1 (CID)',
  CIDFontType2: 'TrueType (CID)',
};
const ENCODING_LABEL: Record<string, string> = {
  WinAnsiEncoding: 'Ansi',
  MacRomanEncoding: 'Roman',
  MacExpertEncoding: 'Expert',
  StandardEncoding: 'Standard',
  PDFDocEncoding: 'PDFDoc',
};
const STANDARD_14 = new Set([
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique',
  'Helvetica-BoldOblique', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats',
]);

function describe(ctx: PDFContext, font: PDFDict): Omit<FontInfo, 'pages'> {
  const subtype = nameOf(ctx, font.get(N('Subtype'))) ?? 'Unknown';
  let base = nameOf(ctx, font.get(N('BaseFont'))) ?? (subtype === 'Type3' ? nameOf(ctx, font.get(N('Name'))) ?? 'Type 3 font' : 'Unnamed font');
  let type = TYPE_LABEL[subtype] ?? subtype;
  let descriptor = lookupDict(ctx, font.get(N('FontDescriptor')));
  if (subtype === 'Type0') {
    const desc = lookupDict(ctx, lookupArray(ctx, font.get(N('DescendantFonts')))?.get(0));
    if (desc) {
      const ds = nameOf(ctx, desc.get(N('Subtype')));
      type = ds === 'CIDFontType0' ? 'Type 1 (CID)' : ds === 'CIDFontType2' ? 'TrueType (CID)' : 'Type 0';
      descriptor = lookupDict(ctx, desc.get(N('FontDescriptor'))) ?? descriptor;
      if (descriptor) {
        const ff3 = lookup(ctx, descriptor.get(N('FontFile3')));
        const st = ff3 instanceof PDFStream ? nameOf(ctx, ff3.dict.get(N('Subtype'))) : undefined;
        if (st === 'OpenType') type = 'OpenType (CID)';
      }
    }
  } else if (descriptor) {
    const ff3 = lookup(ctx, descriptor.get(N('FontFile3')));
    const st = ff3 instanceof PDFStream ? nameOf(ctx, ff3.dict.get(N('Subtype'))) : undefined;
    if (st === 'Type1C') type = `${type} (CFF)`;
    else if (st === 'OpenType') type = 'OpenType';
  }
  const encRaw = lookup(ctx, font.get(N('Encoding')));
  let encoding: string;
  if (encRaw instanceof PDFName) encoding = ENCODING_LABEL[encRaw.decodeText()] ?? encRaw.decodeText();
  else if (encRaw instanceof PDFDict || encRaw instanceof PDFStream) {
    const baseEnc = nameOf(ctx, (encRaw instanceof PDFStream ? encRaw.dict : encRaw).get(N('BaseEncoding')));
    encoding = baseEnc ? `Custom (${ENCODING_LABEL[baseEnc] ?? baseEnc})` : 'Custom';
  } else encoding = subtype === 'Type3' ? 'Custom' : subtype === 'Type0' ? 'Identity-H' : 'Built-in';
  const embeddedFile =
    subtype === 'Type3' ||
    (!!descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => lookup(ctx, descriptor!.get(N(k))) instanceof PDFStream));
  const subset = /^[A-Z]{6}\+/.test(base);
  let embedded: FontInfo['embedded'] = embeddedFile ? (subset ? 'subset' : 'embedded') : 'no';
  if (subtype === 'Type3') embedded = 'embedded';
  if (subset) base = base.slice(7);
  if (!embeddedFile && STANDARD_14.has(base)) type = type === 'Type 1' ? 'Type 1 (Standard 14)' : type;
  return { name: base, type, encoding, embedded };
}

async function collect(docId: DocId, report?: (p: number) => void): Promise<FontInfo[]> {
  const doc = getDoc(docId);
  if (!doc) return [];
  const lib = await engine.loadLib(doc.bytes);
  const ctx = lib.context;
  const byDict = new Map<PDFDict, { info: Omit<FontInfo, 'pages'>; pages: Set<number> }>();
  /** Resource dicts already walked, per page (shared resources are walked once per page). */
  const visited = new Map<PDFDict, Set<number>>();

  const walkResources = (res: PDFDict | undefined, page: number, depth: number) => {
    if (!res || depth > 12) return;
    let seen = visited.get(res);
    if (seen?.has(page)) return;
    if (!seen) visited.set(res, (seen = new Set()));
    seen.add(page);
    const fonts = lookupDict(ctx, res.get(N('Font')));
    if (fonts) {
      for (const k of fonts.keys()) {
        const f = lookupDict(ctx, fonts.get(k));
        if (!f) continue;
        let e = byDict.get(f);
        if (!e) byDict.set(f, (e = { info: describe(ctx, f), pages: new Set() }));
        e.pages.add(page);
        // Type 3 glyph procedures have their own resources.
        if (nameOf(ctx, f.get(N('Subtype'))) === 'Type3') walkResources(lookupDict(ctx, f.get(N('Resources'))), page, depth + 1);
      }
    }
    const xobjs = lookupDict(ctx, res.get(N('XObject')));
    if (!xobjs) return;
    for (const k of xobjs.keys()) {
      const x = lookup(ctx, xobjs.get(k));
      if (!(x instanceof PDFStream) || nameOf(ctx, x.dict.get(N('Subtype'))) !== 'Form') continue;
      walkResources(lookupDict(ctx, x.dict.get(N('Resources'))), page, depth + 1);
    }
  };

  const leaves = leavesOf(lib);
  for (let i = 0; i < leaves.length; i++) {
    if (report && i % 20 === 0) report(i / leaves.length);
    const leaf = leaves[i].leaf;
    const res = lookupDict(ctx, inheritable(leaf, 'Resources'));
    walkResources(res, i + 1, 0);
    // Annotation appearance streams.
    const annots = lookupArray(ctx, leaf.get(N('Annots')));
    if (!annots) continue;
    for (let a = 0; a < annots.size(); a++) {
      const ann = lookupDict(ctx, annots.get(a));
      const ap = ann ? lookupDict(ctx, ann.get(N('AP'))) : undefined;
      if (!ap) continue;
      for (const k of ['N', 'R', 'D']) {
        const v = lookup(ctx, ap.get(N(k)));
        const streams: PDFStream[] = [];
        if (v instanceof PDFStream) streams.push(v);
        else if (v instanceof PDFDict) for (const sk of v.keys()) {
          const s = lookup(ctx, v.get(sk));
          if (s instanceof PDFStream) streams.push(s);
        }
        for (const s of streams) walkResources(lookupDict(ctx, s.dict.get(N('Resources'))), i + 1, 1);
      }
    }
  }
  // AcroForm default resources (fonts used by form fields).
  const acro = lookupDict(ctx, lib.catalog.get(N('AcroForm')));
  const dr = acro ? lookupDict(ctx, acro.get(N('DR'))) : undefined;
  if (dr) {
    const fonts = lookupDict(ctx, dr.get(N('Font')));
    if (fonts) for (const k of fonts.keys()) {
      const f = lookupDict(ctx, fonts.get(k));
      if (f && !byDict.has(f)) byDict.set(f, { info: describe(ctx, f), pages: new Set() });
    }
  }

  // Merge identical descriptions (the same font embedded several times).
  const merged = new Map<string, FontInfo>();
  for (const { info, pages } of byDict.values()) {
    const k = `${info.name}|${info.type}|${info.encoding}|${info.embedded}`;
    const e = merged.get(k) ?? { ...info, pages: [] };
    e.pages = [...new Set([...e.pages, ...pages])].sort((a, b) => a - b);
    merged.set(k, e);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const cache = new WeakMap<Uint8Array, Promise<FontInfo[]>>();
export function listFonts(docId: DocId, report?: (p: number) => void): Promise<FontInfo[]> {
  const doc = getDoc(docId);
  if (!doc) return Promise.resolve([]);
  let job = cache.get(doc.bytes);
  if (!job) {
    job = collect(docId, report);
    cache.set(doc.bytes, job);
    job.catch(() => cache.delete(doc.bytes));
  }
  return job;
}
