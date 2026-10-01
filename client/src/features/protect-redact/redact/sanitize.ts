/**
 * "Remove hidden information" / "Sanitize document": finds and removes information that isn't
 * visible on the pages. Runs as ONE undoable step (engine.withLib + document-level state).
 *
 * The same code runs on a throw-away copy of the document to "examine" it (count what is there).
 */
import {
  PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, concatTransformationMatrix, decodePDFRawStream, drawObject, popGraphicsState,
  pushGraphicsState, type PDFObject, type PDFPageLeaf,
} from '@cantoo/pdf-lib';
import * as engine from '@/core/engine';
import {
  N, annotRefsOf, isWidget, leavesOf, lookup, lookupArray, lookupDict, mediaBoxOf, nameOf, numberOf, numbersOf, viewBoxOf,
} from '@/core/engine/lib';
import { reg } from '@/core/registry';
import { actions, getDoc } from '@/core/store';
import type { DocId, DocMeta, DocState, LibDocument, OutlineItem, PdfObject } from '@/core/types';
import { binaryToBytes, bytesToBinary, dropOutside, filterContent, type Box, type Matrix, type OutsideEnv } from './contentStream';
import { INVISIBLE_TEXT_TAG, isRedaction } from './types';

export type SanitizeKey =
  | 'metadata' | 'attachments' | 'comments' | 'forms' | 'hiddenText' | 'layers' | 'bookmarks' | 'links' | 'searchIndex' | 'cropped';

export interface SanitizeItem {
  key: SanitizeKey;
  label: string;
  description: string;
}

export const SANITIZE_ITEMS: SanitizeItem[] = [
  { key: 'metadata', label: 'Metadata', description: 'Title, author, subject, keywords and XMP metadata of the document and its objects.' },
  { key: 'attachments', label: 'File attachments', description: 'Files embedded in the document or attached to pages.' },
  { key: 'comments', label: 'Comments and markups', description: 'Sticky notes, highlights, drawings, stamps and other annotations.' },
  { key: 'forms', label: 'Form fields', description: 'Form fields are flattened: their current appearance becomes part of the page.' },
  { key: 'hiddenText', label: 'Hidden text', description: 'Invisible text (for example an OCR layer). The searchable text of redacted pages is kept.' },
  { key: 'layers', label: 'Hidden layers', description: 'Content of layers that are turned off; visible layers are merged into the page.' },
  { key: 'bookmarks', label: 'Bookmarks', description: 'The bookmark (outline) tree.' },
  { key: 'links', label: 'Links, actions and JavaScript', description: 'Web links, page and document actions and scripts.' },
  { key: 'searchIndex', label: 'Embedded search index and private data', description: 'Search index, page thumbnails and data other applications stored in the file.' },
  { key: 'cropped', label: 'Deleted or cropped content', description: 'Text, images and drawings outside the visible page area are deleted, pages are cut to their crop box and leftovers of earlier edits are dropped.' },
];

export type Findings = Record<SanitizeKey, number>;

const emptyFindings = (): Findings => ({
  metadata: 0, attachments: 0, comments: 0, forms: 0, hiddenText: 0, layers: 0, bookmarks: 0, links: 0, searchIndex: 0, cropped: 0,
});

// ── helpers ─────────────────────────────────────────────────────────────────

function arrayItems(lib: LibDocument, o: PDFObject | undefined): PDFObject[] {
  const a = lookupArray(lib.context, o);
  if (!a) return o === undefined ? [] : [o];
  const out: PDFObject[] = [];
  for (let i = 0; i < a.size(); i++) out.push(a.get(i));
  return out;
}

function setAnnots(lib: LibDocument, leaf: PDFPageLeaf, keep: PDFObject[]) {
  if (keep.length) leaf.set(N('Annots'), lib.context.obj(keep));
  else leaf.delete(N('Annots'));
}

/** Remove annotations accepted by `drop` (and popups of removed parents); returns the count (popups excluded). */
function removeAnnots(lib: LibDocument, drop: (d: PDFDict, subtype: string | undefined) => boolean): number {
  const ctx = lib.context;
  let n = 0;
  for (const { leaf } of leavesOf(lib)) {
    const refs = annotRefsOf(leaf);
    if (!refs.length) continue;
    const gone = new Set<PDFObject>();
    for (const r of refs) {
      const d = lookupDict(ctx, r);
      if (!d) {
        gone.add(r);
        continue;
      }
      const st = nameOf(ctx, d.get(N('Subtype')));
      if (st === 'Popup') continue;
      if (drop(d, st)) {
        gone.add(r);
        n++;
      }
    }
    for (const r of refs) {
      const d = lookupDict(ctx, r);
      if (d && nameOf(ctx, d.get(N('Subtype'))) === 'Popup') {
        const p = d.get(N('Parent'));
        if (p && gone.has(p)) gone.add(r);
      }
    }
    if (gone.size) setAnnots(lib, leaf, refs.filter((r) => !gone.has(r)));
  }
  return n;
}

function rewriteStream(lib: LibDocument, ref: PDFRef | null, old: PDFStream, content: string): PDFRawStream {
  const ns = lib.context.flateStream(binaryToBytes(content));
  for (const [k, v] of old.dict.entries()) {
    const key = k.asString();
    if (key === '/Filter' || key === '/DecodeParms' || key === '/Length' || key === '/DL') continue;
    ns.dict.set(k, v);
  }
  if (ref) lib.context.assign(ref, ns);
  return ns;
}

function decode(s: PDFObject | undefined): string | null {
  if (!(s instanceof PDFRawStream)) return null;
  try {
    return bytesToBinary(decodePDFRawStream(s).decode());
  } catch {
    return null;
  }
}

// ── optional content ────────────────────────────────────────────────────────

function hiddenOcgs(lib: LibDocument): { all: Set<PDFObject>; hidden: Set<PDFObject> } {
  const ctx = lib.context;
  const props = lookupDict(ctx, lib.catalog.get(N('OCProperties')));
  const all = new Set<PDFObject>(props ? arrayItems(lib, props.get(N('OCGs'))) : []);
  const hidden = new Set<PDFObject>();
  const d = props && lookupDict(ctx, props.get(N('D')));
  if (d) {
    if (nameOf(ctx, d.get(N('BaseState'))) === 'OFF') {
      const on = new Set(arrayItems(lib, d.get(N('ON'))));
      for (const g of all) if (!on.has(g)) hidden.add(g);
    }
    for (const g of arrayItems(lib, d.get(N('OFF')))) hidden.add(g);
  }
  return { all, hidden };
}

/** False when an /OC entry (OCG or OCMD) is turned off by the default configuration. */
function ocVisible(lib: LibDocument, oc: PDFObject | undefined, hidden: Set<PDFObject>): boolean {
  if (oc === undefined || !hidden.size) return true;
  const ctx = lib.context;
  const d = lookupDict(ctx, oc);
  if (!d) return true;
  if (nameOf(ctx, d.get(N('Type'))) === 'OCMD') {
    const groups = arrayItems(lib, d.get(N('OCGs')));
    if (!groups.length) return true;
    const vis = groups.map((g) => !hidden.has(g));
    switch (nameOf(ctx, d.get(N('P'))) ?? 'AnyOn') {
      case 'AllOn':
        return vis.every(Boolean);
      case 'AnyOff':
        return vis.some((v) => !v);
      case 'AllOff':
        return vis.every((v) => !v);
      default:
        return vis.some(Boolean);
    }
  }
  return !hidden.has(oc);
}

// ── content filtering (hidden text / hidden layers) ─────────────────────────

interface ContentCounts {
  hiddenText: number;
  hiddenLayers: number;
}

function filterResources(
  lib: LibDocument,
  resources: PDFDict | undefined,
  opts: { hiddenText: boolean; layers: boolean; hidden: Set<PDFObject> },
): { hiddenProperties: Set<string>; hiddenXObjects: Set<string> } {
  const ctx = lib.context;
  const hiddenProperties = new Set<string>();
  const hiddenXObjects = new Set<string>();
  if (!resources || !opts.layers || !opts.hidden.size) return { hiddenProperties, hiddenXObjects };
  const props = lookupDict(ctx, resources.get(N('Properties')));
  if (props) for (const [k, v] of props.entries()) if (!ocVisible(lib, v, opts.hidden)) hiddenProperties.add(k.asString().slice(1));
  const xo = lookupDict(ctx, resources.get(N('XObject')));
  if (xo) {
    for (const [k, v] of xo.entries()) {
      const s = lookup(ctx, v);
      if (s instanceof PDFStream && !ocVisible(lib, s.dict.get(N('OC')), opts.hidden)) hiddenXObjects.add(k.asString().slice(1));
    }
  }
  return { hiddenProperties, hiddenXObjects };
}

function processForms(
  lib: LibDocument,
  resources: PDFDict | undefined,
  opts: { hiddenText: boolean; layers: boolean; hidden: Set<PDFObject> },
  seen: Set<PDFObject>,
  counts: ContentCounts,
  depth: number,
) {
  if (!resources || depth > 12) return;
  const ctx = lib.context;
  const xo = lookupDict(ctx, resources.get(N('XObject')));
  if (!xo) return;
  for (const [, v] of xo.entries()) {
    if (seen.has(v)) continue;
    seen.add(v);
    const s = lookup(ctx, v);
    if (!(s instanceof PDFRawStream) || nameOf(ctx, s.dict.get(N('Subtype'))) !== 'Form') continue;
    const res = lookupDict(ctx, s.dict.get(N('Resources'))) ?? resources;
    const src = decode(s);
    if (src !== null) {
      const r = filterContent(src, { hiddenText: opts.hiddenText, keepTag: INVISIBLE_TEXT_TAG, ...filterResources(lib, res, opts) });
      counts.hiddenText += r.hiddenText;
      counts.hiddenLayers += r.hiddenLayers;
      if (r.content !== null && v instanceof PDFRef) rewriteStream(lib, v, s, r.content);
    }
    processForms(lib, res, opts, seen, counts, depth + 1);
  }
}

function processPageContent(lib: LibDocument, leaf: PDFPageLeaf, opts: { hiddenText: boolean; layers: boolean; hidden: Set<PDFObject> }, seen: Set<PDFObject>, counts: ContentCounts) {
  const ctx = lib.context;
  const resources = lookupDict(ctx, leaf.getInheritableAttribute(N('Resources')));
  const parts = arrayItems(lib, leaf.get(N('Contents')));
  const sources: string[] = [];
  for (const p of parts) {
    const src = decode(lookup(ctx, p));
    if (src === null) return; // unsupported filter: leave the page alone
    sources.push(src);
  }
  if (sources.length) {
    const r = filterContent(sources.join('\n'), { hiddenText: opts.hiddenText, keepTag: INVISIBLE_TEXT_TAG, ...filterResources(lib, resources, opts) });
    counts.hiddenText += r.hiddenText;
    counts.hiddenLayers += r.hiddenLayers;
    if (r.content !== null) leaf.set(N('Contents'), ctx.register(ctx.flateStream(binaryToBytes(r.content))));
  }
  processForms(lib, resources, opts, seen, counts, 0);
}

/**
 * Remove invisible text and/or hidden-layer content from the content of the pages `indices` of
 * `lib` (in place; form XObjects they draw included). Returns how much was removed.
 */
export function filterPagesContent(lib: LibDocument, indices: number[], what: { hiddenText: boolean; layers: boolean }): ContentCounts {
  const { hidden } = hiddenOcgs(lib);
  const opts = { hiddenText: what.hiddenText, layers: what.layers, hidden };
  const counts: ContentCounts = { hiddenText: 0, hiddenLayers: 0 };
  if (!opts.hiddenText && !(opts.layers && hidden.size)) return counts;
  const leaves = leavesOf(lib);
  const seen = new Set<PDFObject>();
  for (const i of indices) {
    const leaf = leaves[i]?.leaf;
    if (leaf) processPageContent(lib, leaf, opts, seen, counts);
  }
  return counts;
}

// ── cropped content ─────────────────────────────────────────────────────────

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function outsideEnv(lib: LibDocument, resources: PDFDict | undefined): OutsideEnv {
  const ctx = lib.context;
  const fonts = resources && lookupDict(ctx, resources.get(N('Font')));
  const xobjects = resources && lookupDict(ctx, resources.get(N('XObject')));
  const gstates = resources && lookupDict(ctx, resources.get(N('ExtGState')));
  return {
    font(name) {
      const f = fonts && lookupDict(ctx, fonts.get(N(name)));
      const st = f && nameOf(ctx, f.get(N('Subtype')));
      if (!f || !st || st === 'Type3') return null;
      if (st !== 'Type0') {
        const desc = lookupDict(ctx, f.get(N('FontDescriptor')));
        const widths = numbersOf(ctx, f.get(N('Widths'))) ?? [];
        const extra = [numberOf(ctx, desc?.get(N('MissingWidth'))) ?? 0, numberOf(ctx, desc?.get(N('MaxWidth'))) ?? 0];
        return { vertical: false, advance: Math.max(0, ...widths.map(Math.abs), ...extra.map(Math.abs)) / 1000 };
      }
      const enc = lookup(ctx, f.get(N('Encoding')));
      const cid = lookupDict(ctx, arrayItems(lib, f.get(N('DescendantFonts')))[0]);
      if (!cid) return null;
      // Embedded CMaps may be vertical: vertical bounds cover both writing modes.
      const vertical = !(enc instanceof PDFName && !enc.decodeText().endsWith('-V'));
      return { vertical, advance: cidMaxWidth(lib, cid, vertical) / 1000 };
    },
    xobject(name) {
      const s = xobjects && lookup(ctx, xobjects.get(N(name)));
      if (!(s instanceof PDFStream)) return null;
      const st = nameOf(ctx, s.dict.get(N('Subtype')));
      if (st === 'Image') return { bbox: [0, 0, 1, 1], matrix: IDENTITY };
      if (st !== 'Form') return null;
      const b = numbersOf(ctx, s.dict.get(N('BBox')));
      if (!b || b.length < 4) return null;
      const m = numbersOf(ctx, s.dict.get(N('Matrix')));
      const bbox: Box = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
      return { bbox, matrix: m && m.length >= 6 ? (m.slice(0, 6) as Matrix) : IDENTITY };
    },
    extGState(name) {
      const d = gstates && lookupDict(ctx, gstates.get(N(name)));
      if (!d) return null;
      return { lineWidth: numberOf(ctx, d.get(N('LW'))), miterLimit: numberOf(ctx, d.get(N('ML'))), font: d.get(N('Font')) !== undefined };
    },
  };
}

/** The widest glyph of a CIDFont (/W, /DW; /W2, /DW2 for vertical text), in glyph units. */
function cidMaxWidth(lib: LibDocument, cid: PDFDict, vertical: boolean): number {
  const ctx = lib.context;
  let max = Math.abs(numberOf(ctx, cid.get(N('DW'))) ?? 1000);
  const w = arrayItems(lib, cid.get(N('W')));
  for (let i = 0; i + 1 < w.length; ) {
    const list = numbersOf(ctx, w[i + 1]);
    if (list) {
      for (const v of list) max = Math.max(max, Math.abs(v));
      i += 2;
    } else {
      max = Math.max(max, Math.abs(numberOf(ctx, w[i + 2]) ?? 0));
      i += 3;
    }
  }
  if (vertical) {
    const dw2 = numbersOf(ctx, cid.get(N('DW2')));
    max = Math.max(max, ...(dw2 ?? [880, -1000]).map(Math.abs));
    // /W2 entries: c [w1y vx vy ...] or c_first c_last w1y vx vy.
    const w2 = arrayItems(lib, cid.get(N('W2')));
    for (let i = 0; i + 1 < w2.length; ) {
      const list = numbersOf(ctx, w2[i + 1]);
      if (list) {
        for (const v of list) max = Math.max(max, Math.abs(v));
        i += 2;
      } else {
        for (const k of [2, 3, 4]) max = Math.max(max, Math.abs(numberOf(ctx, w2[i + k]) ?? 0));
        i += 5;
      }
    }
  }
  return max;
}

/** Remove what the page draws entirely outside `box`; returns the number of operations removed. */
function dropPageOutside(lib: LibDocument, leaf: PDFPageLeaf, box: Box): number {
  const ctx = lib.context;
  const parts = arrayItems(lib, leaf.get(N('Contents')));
  const sources: string[] = [];
  for (const p of parts) {
    const src = decode(lookup(ctx, p));
    if (src === null) return 0; // unsupported filter: leave the page alone
    sources.push(src);
  }
  if (!sources.length) return 0;
  const resources = lookupDict(ctx, leaf.getInheritableAttribute(N('Resources')));
  const r = dropOutside(sources.join('\n'), box, outsideEnv(lib, resources));
  if (r.content !== null) leaf.set(N('Contents'), ctx.register(ctx.flateStream(binaryToBytes(r.content))));
  return r.removed;
}

// ── form flattening ─────────────────────────────────────────────────────────

function transformBox(m: number[], b: number[]): [number, number, number, number] {
  const pts = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Draw every visible widget's appearance into its page, then remove widgets and the form. */
function flattenWidgets(lib: LibDocument): number {
  const ctx = lib.context;
  let n = 0;
  const pages = lib.getPages();
  for (const page of pages) {
    const leaf = page.node;
    const refs = annotRefsOf(leaf);
    if (!refs.some((r) => isWidget(ctx, lookupDict(ctx, r)))) continue;
    engine.preparePage(page);
    const keep: PDFObject[] = [];
    for (const r of annotRefsOf(leaf)) {
      const a = lookupDict(ctx, r);
      if (!a || !isWidget(ctx, a)) {
        if (a) keep.push(r);
        continue;
      }
      n++;
      const flags = numberOf(ctx, a.get(N('F'))) ?? 0;
      if (flags & (2 | 32)) continue;
      const ap = lookupDict(ctx, a.get(N('AP')));
      let nRef = ap?.get(N('N'));
      let s = lookup(ctx, nRef);
      if (s instanceof PDFDict && !(s instanceof PDFStream)) {
        const state = nameOf(ctx, a.get(N('AS')));
        nRef = state ? s.get(N(state)) : undefined;
        s = lookup(ctx, nRef);
      }
      if (!(s instanceof PDFStream) || !(nRef instanceof PDFRef)) continue;
      const rect = numbersOf(ctx, a.get(N('Rect')));
      const bbox = numbersOf(ctx, s.dict.get(N('BBox')));
      if (!rect || rect.length !== 4 || !bbox || bbox.length !== 4) continue;
      const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      const m = numbersOf(ctx, s.dict.get(N('Matrix')));
      const [bx0, by0, bx1, by1] = transformBox(m?.length === 6 ? m : [1, 0, 0, 1, 0, 0], bbox);
      if (bx1 - bx0 <= 0 || by1 - by0 <= 0 || rx1 - rx0 <= 0 || ry1 - ry0 <= 0) continue;
      if (s.dict.get(N('Subtype')) === undefined) s.dict.set(N('Subtype'), N('Form'));
      if (s.dict.get(N('Type')) === undefined) s.dict.set(N('Type'), N('XObject'));
      const sx = (rx1 - rx0) / (bx1 - bx0);
      const sy = (ry1 - ry0) / (by1 - by0);
      const name = leaf.newXObject('FW', nRef);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy), drawObject(name), popGraphicsState());
    }
    // Popups of removed widgets don't exist; keep the rest.
    setAnnots(lib, leaf, keep);
  }
  if (lib.catalog.get(N('AcroForm')) !== undefined) {
    const acro = lookupDict(ctx, lib.catalog.get(N('AcroForm')));
    const fields = acro && lookupArray(ctx, acro.get(N('Fields')));
    if (!n && fields) n = fields.size();
    lib.catalog.delete(N('AcroForm'));
  }
  return n;
}

// ── actions ─────────────────────────────────────────────────────────────────

function stripFieldActions(lib: LibDocument, o: PDFObject | undefined, depth = 0): number {
  const d = lookupDict(lib.context, o);
  if (!d || depth > 32) return 0;
  let n = 0;
  for (const k of ['A', 'AA']) if (d.get(N(k)) !== undefined) {
    d.delete(N(k));
    n++;
  }
  for (const kid of arrayItems(lib, d.get(N('Kids')))) n += stripFieldActions(lib, kid, depth + 1);
  return n;
}

function stripOutlineActions(lib: LibDocument): number {
  const ctx = lib.context;
  const root = lookupDict(ctx, lib.catalog.get(N('Outlines')));
  if (!root) return 0;
  let n = 0;
  const seen = new Set<PDFDict>();
  const walk = (o: PDFObject | undefined, depth: number) => {
    let cur = lookupDict(ctx, o);
    while (cur && !seen.has(cur) && depth < 64) {
      seen.add(cur);
      const a = lookupDict(ctx, cur.get(N('A')));
      if (a && nameOf(ctx, a.get(N('S'))) !== 'GoTo') {
        cur.delete(N('A'));
        n++;
      }
      walk(cur.get(N('First')), depth + 1);
      cur = lookupDict(ctx, cur.get(N('Next')));
    }
  };
  walk(root.get(N('First')), 0);
  return n;
}

function namesDict(lib: LibDocument): PDFDict | undefined {
  return lookupDict(lib.context, lib.catalog.get(N('Names')));
}

function nameTreeCount(lib: LibDocument, o: PDFObject | undefined, depth = 0): number {
  const d = lookupDict(lib.context, o);
  if (!d || depth > 32) return 0;
  const names = lookupArray(lib.context, d.get(N('Names')));
  let n = names ? Math.floor(names.size() / 2) : 0;
  for (const kid of arrayItems(lib, d.get(N('Kids')))) n += nameTreeCount(lib, kid, depth + 1);
  return n;
}

// ── the sanitizer ───────────────────────────────────────────────────────────

/** Remove the selected kinds of hidden information from `lib` (in place). Returns what was found/removed. */
export function sanitizeLib(lib: LibDocument, keys: Set<SanitizeKey>): Findings {
  const ctx = lib.context;
  const out = emptyFindings();
  const catalog = lib.catalog;

  // Hidden layers and hidden text (content streams first, while /OCProperties is still there).
  const { all: ocgs, hidden } = hiddenOcgs(lib);
  if (keys.has('hiddenText') || keys.has('layers')) {
    const opts = { hiddenText: keys.has('hiddenText'), layers: keys.has('layers'), hidden };
    const seen = new Set<PDFObject>();
    const counts: ContentCounts = { hiddenText: 0, hiddenLayers: 0 };
    for (const { leaf } of leavesOf(lib)) processPageContent(lib, leaf, opts, seen, counts);
    out.hiddenText = counts.hiddenText;
    if (keys.has('layers')) {
      out.layers = hidden.size;
      removeAnnots(lib, (d) => !ocVisible(lib, d.get(N('OC')), hidden));
      if (ocgs.size || catalog.get(N('OCProperties')) !== undefined) catalog.delete(N('OCProperties'));
    }
  }

  if (keys.has('attachments')) {
    const names = namesDict(lib);
    if (names?.get(N('EmbeddedFiles')) !== undefined) {
      out.attachments += nameTreeCount(lib, names.get(N('EmbeddedFiles'))) || 1;
      names.delete(N('EmbeddedFiles'));
    }
    out.attachments += removeAnnots(lib, (_d, st) => st === 'FileAttachment');
    for (const k of ['AF', 'Collection']) catalog.delete(N(k));
    for (const { leaf } of leavesOf(lib)) leaf.delete(N('AF'));
  }

  if (keys.has('comments')) {
    out.comments += removeAnnots(lib, (_d, st) => st !== 'Link' && st !== 'Widget' && (st !== 'FileAttachment' || keys.has('attachments')));
  }

  if (keys.has('links')) {
    out.links += removeAnnots(lib, (_d, st) => st === 'Link');
    for (const k of ['OpenAction', 'AA', 'URI']) {
      if (catalog.get(N(k)) !== undefined) {
        catalog.delete(N(k));
        out.links++;
      }
    }
    const names = namesDict(lib);
    if (names?.get(N('JavaScript')) !== undefined) {
      out.links += nameTreeCount(lib, names.get(N('JavaScript'))) || 1;
      names.delete(N('JavaScript'));
    }
    for (const { leaf } of leavesOf(lib)) {
      if (leaf.get(N('AA')) !== undefined) {
        leaf.delete(N('AA'));
        out.links++;
      }
      for (const r of annotRefsOf(leaf)) {
        const d = lookupDict(ctx, r);
        if (!d) continue;
        for (const k of ['A', 'AA']) if (d.get(N(k)) !== undefined) {
          d.delete(N(k));
          out.links++;
        }
      }
    }
    const acro = lookupDict(ctx, catalog.get(N('AcroForm')));
    for (const f of arrayItems(lib, acro?.get(N('Fields')))) out.links += stripFieldActions(lib, f);
    if (!keys.has('bookmarks')) out.links += stripOutlineActions(lib);
  }

  if (keys.has('forms')) out.forms += flattenWidgets(lib);

  if (keys.has('bookmarks') && catalog.get(N('Outlines')) !== undefined) {
    const root = lookupDict(ctx, catalog.get(N('Outlines')));
    out.bookmarks += Math.max(1, Math.abs(numberOf(ctx, root?.get(N('Count'))) ?? 0));
    catalog.delete(N('Outlines'));
    if (nameOf(ctx, catalog.get(N('PageMode'))) === 'UseOutlines') catalog.delete(N('PageMode'));
  }

  if (keys.has('metadata')) {
    const t = ctx.trailerInfo as { Info?: PDFObject };
    const info = lookupDict(ctx, t.Info);
    if (info) {
      for (const k of info.keys()) {
        info.delete(k);
        out.metadata++;
      }
    }
    // XMP packets anywhere (catalog, pages, images, fonts...).
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      if (d && d.get(N('Metadata')) !== undefined) {
        d.delete(N('Metadata'));
        out.metadata++;
      }
    }
    if (catalog.get(N('Metadata')) !== undefined) {
      catalog.delete(N('Metadata'));
      out.metadata++;
    }
  }

  if (keys.has('searchIndex')) {
    for (const k of ['PieceInfo', 'Search', 'SpiderInfo', 'Threads']) {
      if (catalog.get(N(k)) !== undefined) {
        catalog.delete(N(k));
        out.searchIndex++;
      }
    }
    for (const { leaf } of leavesOf(lib)) {
      for (const k of ['PieceInfo', 'Thumb', 'B']) {
        if (leaf.get(N(k)) !== undefined) {
          leaf.delete(N(k));
          out.searchIndex++;
        }
      }
    }
  }

  if (keys.has('cropped')) {
    for (const { leaf } of leavesOf(lib)) {
      const media = mediaBoxOf(leaf);
      const view = viewBoxOf(leaf);
      const differs = media.some((v, i) => Math.abs(v - view[i]) > 0.01);
      const extra = ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox'].some((k) => leaf.get(N(k)) !== undefined);
      // Text, images and drawings entirely outside the visible area go (not just the box).
      const removed = dropPageOutside(lib, leaf, view);
      if (differs || removed) out.cropped++;
      if (differs || extra || leaf.get(N('MediaBox')) === undefined) {
        leaf.set(N('MediaBox'), ctx.obj(view));
        for (const k of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) leaf.delete(N(k));
      }
    }
  }

  return out;
}

// ── document-level state ────────────────────────────────────────────────────

function countOutline(items: OutlineItem[] | null | undefined): number {
  let n = 0;
  for (const it of items ?? []) n += 1 + countOutline(it.children);
  return n;
}

function stripUrls(items: OutlineItem[]): { items: OutlineItem[]; count: number } {
  let count = 0;
  const walk = (list: OutlineItem[]): OutlineItem[] =>
    list.map((it) => {
      const children = walk(it.children ?? []);
      if (it.url) {
        count++;
        return { ...it, url: null, children };
      }
      return { ...it, children };
    });
  const next = walk(items);
  return { items: next, count };
}

const META_TEXT: (keyof DocMeta)[] = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'];

function metaCount(meta: DocMeta): number {
  return META_TEXT.filter((k) => typeof meta[k] === 'string' && (meta[k] as string).trim()).length;
}

function objectCategory(o: PdfObject): string | undefined {
  return reg.objectType(o.kind)?.category;
}

/** Overlay objects removed by the selected keys. */
function objectsToRemove(doc: DocState, keys: Set<SanitizeKey>): { comments: string[]; attachments: string[] } {
  const comments: string[] = [];
  const attachments: string[] = [];
  for (const id of doc.order) {
    const o = doc.objects[id];
    if (!o || isRedaction(o)) continue;
    if (o.kind === 'file-attachment') {
      if (keys.has('attachments')) attachments.push(id);
      continue;
    }
    const cat = objectCategory(o);
    if (keys.has('comments') && (cat === 'comment' || cat === 'measure')) comments.push(id);
  }
  return { comments, attachments };
}

/** Count the hidden information in the document (on a throw-away copy; nothing is changed). */
export async function examineDocument(docId: DocId): Promise<Findings> {
  const doc = getDoc(docId);
  if (!doc) throw new Error('The document is no longer open.');
  const lib = await engine.loadLib(doc.bytes);
  const all = new Set(SANITIZE_ITEMS.map((i) => i.key));
  const f = sanitizeLib(lib, all);
  const objs = objectsToRemove(doc, all);
  // Document-level state (doc.meta) is what gets written to the Info dictionary on save.
  f.metadata = Math.max(f.metadata, metaCount(doc.meta));
  f.comments += objs.comments.length;
  f.attachments += objs.attachments.length;
  f.bookmarks = countOutline(doc.outline) || f.bookmarks;
  f.links += stripUrls(doc.outline ?? []).count;
  return f;
}

/**
 * Remove the selected kinds of hidden information, as one undoable step.
 * Returns what was removed.
 */
export async function sanitizeDocument(docId: DocId, keys: SanitizeKey[]): Promise<Findings> {
  const sel = new Set(keys);
  let found = emptyFindings();
  await engine.withLib(docId, 'Remove hidden information', (lib) => {
    found = sanitizeLib(lib, sel);
  });
  const doc = getDoc(docId);
  if (!doc) return found;
  const patch: Partial<DocState> = {};
  if (sel.has('metadata')) {
    const meta: DocMeta = { ...doc.meta };
    for (const k of META_TEXT) delete meta[k];
    delete meta.creationDate;
    delete meta.modificationDate;
    found.metadata = Math.max(found.metadata, metaCount(doc.meta));
    patch.meta = meta;
  }
  if (sel.has('bookmarks')) {
    found.bookmarks = Math.max(found.bookmarks, countOutline(doc.outline));
    patch.outline = [];
  } else if (sel.has('links') && doc.outline) {
    const s = stripUrls(doc.outline);
    if (s.count) {
      patch.outline = s.items;
      found.links += s.count;
    }
  }
  if (Object.keys(patch).length) actions.updateDoc(docId, patch);
  const objs = objectsToRemove(getDoc(docId)!, sel);
  const ids = [...objs.comments, ...objs.attachments];
  found.comments += objs.comments.length;
  found.attachments += objs.attachments.length;
  if (ids.length) actions.deleteObjects(docId, ids, { checkpoint: false });
  return found;
}

