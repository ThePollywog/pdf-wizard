/**
 * Export pipeline: base bytes + overlay objects (+ outline / metadata / security hooks) → PDF bytes,
 * plus the flows built on it: bake, download, save to the library, save as, print.
 */
import * as fontkitNs from '@pdf-lib/fontkit';
import {
  PDFArray, PDFCatalog, PDFDict, PDFHexString, PDFName, PDFNumber, PDFObject, PDFOperator, PDFOperatorNames, PDFPageLeaf,
  PDFPageTree, PDFRawStream,
  PDFRef, PDFStream, PDFString, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState,
  type PDFContext, type PDFFont,
} from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
  AnnotationSpec, AnnotationWriter, AppearanceSpec, DocId, DocState, ExportContext, ExportHook, ExportOptions,
  LibDocument, LibPage, ObjectId, PageId, PageInfo, PdfObject, Rect, ReviewStatus,
} from '../types';
import { actions, getDoc, useApp } from '../store';
import { reg, useRegistry } from '../registry';
import { library, LibraryError, type FileMeta } from '../library';
import { downloadBlob, hexToRgb01 } from '../util';
import { inflateRect, unionRects } from '../geometry';
import {
  N, SAVE_OPTIONS, annotRefsOf, collectGarbage, inheritable, loadLib, lookup, lookupDict, mapDirect, nameOf, numberOf,
  numbersOf, pdfDate, viewBoxOf,
} from './lib';
import { commitFormsNow, formsModified } from './forms';
import { delayedBusy, enqueue, getOrigin, getReadOnly, isReadOnly, requireDoc } from './state';
import { BUILTIN_HOOK_IDS, builtinExportHooks, needsEncryption } from './hooks';
import { destroyProxy, loadPdfjs, pdfjsLib } from './pdfjs';
import { awaitPdf } from './sync';

const fontkit = ((fontkitNs as unknown as { default?: unknown }).default ?? fontkitNs) as Parameters<LibDocument['registerFontkit']>[0];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const rectArray = (r: Rect) => [r3(r.x), r3(r.y), r3(r.x + r.width), r3(r.y + r.height)];
const rgb = (hex: string) => hexToRgb01(hex).map(r3);
const isPdfObject = (v: unknown): v is PDFObject => v instanceof PDFObject;

export function ensurePdfExtension(name: string): string {
  const n = name.trim() || 'document';
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

// ── page preparation ─────────────────────────────────────────────────────────

const preparedLeaves = new WeakSet<PDFPageLeaf>();

function shallowDict(ctx: PDFContext, d: PDFDict): PDFDict {
  const out = PDFDict.withContext(ctx);
  for (const [k, v] of d.entries()) out.set(k, v);
  return out;
}

/**
 * Make a page safe to draw on / add annotations to: private (direct) Contents and Annots arrays and a
 * private Resources dictionary (shared or inherited resources are copied shallowly), then let pdf-lib
 * wrap the existing content in q … Q.
 */
export function preparePage(page: LibPage) {
  const leaf = page.node;
  if (preparedLeaves.has(leaf)) return;
  preparedLeaves.add(leaf);
  const ctx = leaf.context;
  const contents = leaf.get(N('Contents'));
  if (contents instanceof PDFRef) {
    const c = ctx.lookup(contents);
    if (c instanceof PDFArray) leaf.set(N('Contents'), ctx.obj(c.asArray()));
    else if (!(c instanceof PDFStream)) leaf.delete(N('Contents'));
  }
  const annots = leaf.get(N('Annots'));
  if (annots !== undefined && !(annots instanceof PDFArray)) {
    const a = lookup(ctx, annots);
    if (a instanceof PDFArray) leaf.set(N('Annots'), ctx.obj(a.asArray()));
    else leaf.delete(N('Annots'));
  }
  const res = lookupDict(ctx, inheritable(leaf, 'Resources'));
  const copy = res ? shallowDict(ctx, res) : PDFDict.withContext(ctx);
  for (const key of ['Font', 'XObject', 'ExtGState']) {
    const sub = lookupDict(ctx, copy.get(N(key)));
    if (sub) copy.set(N(key), shallowDict(ctx, sub));
    else copy.delete(N(key));
  }
  leaf.set(N('Resources'), copy);
  leaf.normalize();
}

// ── appearance helpers ───────────────────────────────────────────────────────

/** A form XObject drawing `ops` (user-space coordinates) clipped to `bbox`, with optional constant opacity. */
function formXObject(ctx: PDFContext, ops: string, bbox: Rect, resources: PDFDict | undefined, opacity: number | undefined): PDFRef {
  const res = resources ? shallowDict(ctx, resources) : PDFDict.withContext(ctx);
  let prefix = '';
  if (opacity !== undefined && Number.isFinite(opacity) && opacity < 1) {
    const a = r3(Math.max(0, opacity));
    const existing = lookupDict(ctx, res.get(N('ExtGState')));
    const gs = existing ? shallowDict(ctx, existing) : PDFDict.withContext(ctx);
    const key = gs.uniqueKey('GSo');
    gs.set(key, ctx.register(ctx.obj({ Type: 'ExtGState', CA: a, ca: a })));
    res.set(N('ExtGState'), gs);
    prefix = `${key.asString()} gs\n`;
  }
  const stream = ctx.flateStream(prefix + ops, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: rectArray(bbox),
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: res,
  });
  return ctx.register(stream);
}

function viewRect(page: LibPage): Rect {
  const [x0, y0, x1, y1] = viewBoxOf(page.node);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function drawAppearance(page: LibPage, ap: AppearanceSpec, opacity?: number) {
  preparePage(page);
  const ctx = page.node.context;
  const bbox = ap.bbox ?? (() => {
    const m = numbersOf(ctx, inheritable(page.node, 'MediaBox')) ?? [0, 0, 612, 792];
    return { x: Math.min(m[0], m[2]), y: Math.min(m[1], m[3]), width: Math.abs(m[2] - m[0]), height: Math.abs(m[3] - m[1]) };
  })();
  const ref = formXObject(ctx, ap.ops, bbox, ap.resources, opacity);
  const name = page.node.newXObject('Fx', ref);
  page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
}

// ── annotation writer ────────────────────────────────────────────────────────

const MARKUP = new Set([
  'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly',
  'StrikeOut', 'Stamp', 'Caret', 'Ink', 'FileAttachment', 'Sound', 'Redact',
]);
const NO_BORDER = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Text', 'Popup', 'Caret', 'FileAttachment', 'Sound', 'Stamp']);
const INTERIOR = new Set(['Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Redact']);
const WITH_RD = new Set(['Square', 'Circle', 'FreeText', 'Caret']);
const STATUS: Record<Exclude<ReviewStatus, 'none'>, string> = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

const emptyAps = new WeakMap<PDFContext, PDFRef>();
function emptyAppearance(ctx: PDFContext): PDFRef {
  let ref = emptyAps.get(ctx);
  if (!ref) {
    ref = ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: {} }));
    emptyAps.set(ctx, ref);
  }
  return ref;
}

const text = (s: string) => PDFHexString.fromText(s);
const date = (t: number | undefined) => PDFString.of(pdfDate(new Date(Number.isFinite(t) && t ? t : Date.now())));

function createAnnotationWriter(options: ExportOptions): AnnotationWriter {
  const keptWhenFlattened = (subtype: string) => (subtype === 'Link' || subtype === 'Widget') && options.purpose !== 'print';

  const add = (page: LibPage, obj: PdfObject, spec: AnnotationSpec): PDFRef | null => {
    preparePage(page);
    const ctx = page.node.context;
    const subtype = spec.subtype;
    const sw = Math.max(0, obj.strokeWidth ?? 0);
    const base = spec.rect ?? obj.rect;
    const apBox = spec.appearance ? spec.appearance.bbox ?? inflateRect(base, sw) : base;
    const final = spec.appearance ? unionRects([base, apBox]) : base;

    if (options.flatten && !keptWhenFlattened(subtype)) {
      if (spec.appearance) drawAppearance(page, { ...spec.appearance, bbox: final }, obj.opacity);
      return null;
    }

    const d = PDFDict.withContext(ctx);
    d.set(N('Type'), N('Annot'));
    d.set(N('Subtype'), N(subtype));
    d.set(N('Rect'), ctx.obj(rectArray(final)));
    d.set(N('P'), page.ref);
    d.set(N('F'), PDFNumber.of(4 | (obj.locked ? 128 : 0)));
    d.set(N('NM'), text(obj.id));
    d.set(N('M'), date(obj.modifiedAt));
    if (MARKUP.has(subtype)) {
      d.set(N('T'), text(obj.author ?? ''));
      d.set(N('CreationDate'), date(obj.createdAt));
      d.set(N('Subj'), text(reg.objectType(obj.kind)?.label ?? subtype));
    }
    if (!spec.noContents && obj.contents) d.set(N('Contents'), text(obj.contents));
    if (obj.color) d.set(N('C'), ctx.obj(rgb(obj.color)));
    if (INTERIOR.has(subtype) && obj.fillColor) d.set(N('IC'), ctx.obj(rgb(obj.fillColor)));
    if (obj.opacity !== undefined && obj.opacity < 1) d.set(N('CA'), PDFNumber.of(r3(Math.max(0, obj.opacity))));
    if (subtype === 'Link') {
      d.set(N('Border'), ctx.obj([0, 0, r3(sw)]));
      if (sw > 0) d.set(N('BS'), ctx.obj({ Type: 'Border', W: r3(sw), S: 'S' }));
    } else if (obj.strokeWidth !== undefined && !NO_BORDER.has(subtype)) {
      d.set(N('BS'), ctx.obj({ Type: 'Border', W: r3(sw), S: 'S' }));
    }
    if (WITH_RD.has(subtype)) {
      const rd = [
        base.x - final.x,
        base.y - final.y,
        final.x + final.width - (base.x + base.width),
        final.y + final.height - (base.y + base.height),
      ].map((v) => r3(Math.max(0, v)));
      if (rd.some((v) => v > 0)) d.set(N('RD'), ctx.obj(rd));
    }
    for (const [k, v] of Object.entries(spec.extra ?? {})) {
      if (v === undefined) d.delete(N(k));
      else d.set(N(k), isPdfObject(v) ? v : ctx.obj(v as never));
    }
    if (spec.appearance) {
      const ap = formXObject(ctx, spec.appearance.ops, final, spec.appearance.resources, obj.opacity);
      d.set(N('AP'), ctx.obj({ N: ap }));
    }
    const ref = ctx.register(d);
    page.node.addAnnot(ref);

    const replies = obj.replies ?? [];
    const wantsPopup = subtype === 'Text' || (MARKUP.has(subtype) && subtype !== 'FreeText' && (!!obj.contents || replies.length > 0));
    if (wantsPopup && d.get(N('Popup')) === undefined) {
      const view = viewRect(page);
      const w = Math.min(180, view.width);
      const h = Math.min(120, view.height);
      const x = Math.max(view.x, Math.min(final.x + final.width, view.x + view.width - w));
      const y = Math.max(view.y, Math.min(final.y + final.height - h, view.y + view.height - h));
      const popup = ctx.register(
        ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: rectArray({ x, y, width: w, height: h }), Parent: ref, Open: false, F: 28 }),
      );
      d.set(N('Popup'), popup);
      page.node.addAnnot(popup);
    }
    if (MARKUP.has(subtype)) {
      for (const r of replies) {
        const rd = ctx.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: rectArray(final),
          P: page.ref,
          IRT: ref,
          RT: 'R',
          F: 28,
          Name: 'Comment',
          Open: false,
          AP: { N: emptyAppearance(ctx) },
        }) as PDFDict;
        rd.set(N('T'), text(r.author ?? ''));
        rd.set(N('Contents'), text(r.text ?? ''));
        rd.set(N('M'), date(r.createdAt));
        rd.set(N('CreationDate'), date(r.createdAt));
        rd.set(N('NM'), text(r.id));
        page.node.addAnnot(ctx.register(rd));
      }
      if (obj.status && obj.status !== 'none' && STATUS[obj.status]) {
        const label = STATUS[obj.status];
        const sd = ctx.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: rectArray(final),
          P: page.ref,
          IRT: ref,
          F: 30,
          Name: 'Comment',
          Open: false,
          State: PDFString.of(label),
          StateModel: PDFString.of('Review'),
          AP: { N: emptyAppearance(ctx) },
        }) as PDFDict;
        sd.set(N('T'), text(obj.author ?? ''));
        sd.set(N('Contents'), text(`${label} set by ${obj.author || 'Unknown'}`));
        sd.set(N('M'), date(obj.modifiedAt));
        sd.set(N('CreationDate'), date(obj.modifiedAt));
        sd.set(N('NM'), text(`${obj.id}-status`));
        page.node.addAnnot(ctx.register(sd));
      }
    }
    return ref;
  };

  return { add, drawAppearance };
}

// ── flattening annotations already in the file ───────────────────────────────

function transformBox(m: number[], b: number[]): [number, number, number, number] {
  const pts = [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[0], b[3]],
    [b[2], b[3]],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Draw every visible annotation (except links) into its page and remove the form. */
export function flattenExistingAnnotations(lib: LibDocument) {
  const ctx = lib.context;
  let flattenedWidgets = false;
  for (const page of lib.getPages()) {
    const leaf = page.node;
    const refs = annotRefsOf(leaf);
    if (!refs.length) continue;
    preparePage(page);
    const keep: PDFObject[] = [];
    for (const r of refs) {
      const a = lookupDict(ctx, r);
      if (!a) continue;
      const subtype = nameOf(ctx, a.get(N('Subtype')));
      if (subtype === 'Link') {
        keep.push(r);
        continue;
      }
      if (subtype === 'Widget') flattenedWidgets = true;
      if (subtype === 'Popup') continue;
      const flags = numberOf(ctx, a.get(N('F'))) ?? 0;
      if (flags & (2 | 32)) continue;
      const ap = lookupDict(ctx, a.get(N('AP')));
      let nRef = ap?.get(N('N'));
      let n = lookup(ctx, nRef);
      if (n instanceof PDFDict) {
        const state = nameOf(ctx, a.get(N('AS')));
        nRef = state ? n.get(N(state)) : undefined;
        n = lookup(ctx, nRef);
      }
      if (!(n instanceof PDFStream) || !(nRef instanceof PDFRef)) continue;
      const rect = numbersOf(ctx, a.get(N('Rect')));
      if (!rect || rect.length !== 4) continue;
      const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      const bboxRaw = numbersOf(ctx, n.dict.get(N('BBox')));
      if (!bboxRaw || bboxRaw.length !== 4) continue;
      const matrix = numbersOf(ctx, n.dict.get(N('Matrix')));
      const [bx0, by0, bx1, by1] = transformBox(matrix?.length === 6 ? matrix : [1, 0, 0, 1, 0, 0], bboxRaw);
      if (bx1 - bx0 <= 0 || by1 - by0 <= 0 || rx1 - rx0 <= 0 || ry1 - ry0 <= 0) continue;
      if (n.dict.get(N('Subtype')) === undefined) n.dict.set(N('Subtype'), N('Form'));
      if (n.dict.get(N('Type')) === undefined) n.dict.set(N('Type'), N('XObject'));
      const sx = (rx1 - rx0) / (bx1 - bx0);
      const sy = (ry1 - ry0) / (by1 - by0);
      const name = leaf.newXObject('Fa', nRef);
      const ops = [pushGraphicsState()];
      const ca = numberOf(ctx, a.get(N('CA')));
      if (ca !== undefined && ca < 1) {
        const gs = leaf.newExtGState('GSa', ctx.register(ctx.obj({ Type: 'ExtGState', CA: ca, ca })));
        ops.push(setGraphicsState(gs));
      }
      ops.push(concatTransformationMatrix(sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy), drawObject(name), popGraphicsState());
      page.pushOperators(...ops);
    }
    if (keep.length) leaf.set(N('Annots'), ctx.obj(keep));
    else leaf.delete(N('Annots'));
  }
  if (flattenedWidgets || lib.catalog.get(N('AcroForm')) !== undefined) lib.catalog.delete(N('AcroForm'));
}

function setGraphicsState(name: PDFName) {
  return PDFOperator.of(PDFOperatorNames.SetGraphicsStateParams, [name]);
}

// ── encryption of strings the fork leaves in the clear ───────────────────────

/**
 * @cantoo/pdf-lib encrypts streams (including object streams) but not strings inside objects that
 * are written outside object streams (page objects, catalog, stream dictionaries...). Encrypt those.
 */
function encryptLooseStrings(lib: LibDocument) {
  const ctx = lib.context;
  const security = ctx.security;
  if (!security) return;
  const encryptRef = (ctx.trailerInfo as { Encrypt?: PDFObject }).Encrypt;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === encryptRef) continue;
    const isSig = obj instanceof PDFDict && obj.lookup(N('Type')) === N('Sig');
    const uncompressed =
      obj instanceof PDFStream || obj instanceof PDFCatalog || obj instanceof PDFPageTree || obj instanceof PDFPageLeaf ||
      ref.generationNumber !== 0 || isSig;
    if (!uncompressed) continue;
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.lookup(N('Type'));
      if (type === N('XRef') || type === N('ObjStm')) continue;
    }
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const fn = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const enc = (v: PDFObject): PDFObject | undefined =>
      v instanceof PDFString || v instanceof PDFHexString ? PDFHexString.fromBytes(fn(v.asBytes())) : undefined;
    for (const [k, v] of dict.entries()) {
      if (isSig && k === N('Contents')) continue;
      const r = enc(v);
      if (r) dict.set(k, r);
      else mapDirect(v, enc);
    }
  }
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/** Objects that will be written, in z-order. */
export function exportableObjects(doc: DocState, opts: Pick<ExportOptions, 'objectIds' | 'skipObjects'>): PdfObject[] {
  if (opts.skipObjects) return [];
  const want = opts.objectIds ? new Set(opts.objectIds) : null;
  const pageIds = new Set(doc.pages.map((p) => p.id));
  const ids = new Set<ObjectId>([...doc.order, ...Object.keys(doc.objects)]);
  const out: PdfObject[] = [];
  for (const id of ids) {
    const o = doc.objects[id];
    if (!o || (want && !want.has(id)) || !pageIds.has(o.pageId)) continue;
    if (!reg.objectType(o.kind)?.exportToPdf) continue;
    out.push(o);
  }
  return out;
}

function exportHooks(): ExportHook[] {
  const list = [...useRegistry.getState().exportHooks];
  for (const h of builtinExportHooks) if (!list.some((x) => x.id === h.id)) list.push(h);
  return list.sort((a, b) => a.order - b.order);
}

const fontBytesCache = new Map<string, Promise<Uint8Array>>();
function cachedFontBytes(key: string, get: () => Promise<ArrayBuffer>): Promise<Uint8Array> {
  let p = fontBytesCache.get(key);
  if (p) {
    fontBytesCache.delete(key);
    fontBytesCache.set(key, p);
    return p;
  }
  p = Promise.resolve()
    .then(get)
    .then((b) => new Uint8Array(b));
  p.catch(() => {
    if (fontBytesCache.get(key) === p) fontBytesCache.delete(key);
  });
  fontBytesCache.set(key, p);
  while (fontBytesCache.size > 16) fontBytesCache.delete(fontBytesCache.keys().next().value!);
  return p;
}

const isOpenTypeCff = (b: Uint8Array) => b.length > 4 && b[0] === 0x4f && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x4f;

interface FontkitSubset {
  encode?: (stream?: unknown) => unknown;
  encodeStream?: () => { on(ev: string, cb: (x?: unknown) => void): void };
}

/**
 * @cantoo/pdf-lib serializes subsets with a stream-less `subset.encode()` (fontkit v2) when it exists,
 * but @pdf-lib/fontkit v1's `encode(stream)` needs a stream and throws at save time. Make `encode()`
 * without a stream collect `encodeStream()` instead (encodeStream itself calls `this.encode(stream)`).
 */
export function patchFontkitSubset(font: PDFFont): PDFFont {
  const sub = (font as unknown as { embedder?: { subset?: FontkitSubset } }).embedder?.subset;
  if (!sub || Object.prototype.hasOwnProperty.call(sub, 'encode')) return font;
  const proto = Object.getPrototypeOf(sub) as FontkitSubset;
  const encodeWithStream = proto.encode;
  const encodeStream = proto.encodeStream;
  if (typeof encodeWithStream !== 'function' || typeof encodeStream !== 'function' || encodeWithStream.length === 0) return font;
  sub.encode = function (this: FontkitSubset, stream?: unknown) {
    if (stream) return encodeWithStream.call(this, stream);
    return new Promise<Uint8Array>((resolve, reject) => {
      const parts: Uint8Array[] = [];
      const s = encodeStream.call(this);
      s.on('data', (c) => parts.push(c as Uint8Array));
      s.on('error', (e) => reject(e));
      s.on('end', () => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        resolve(out);
      });
    });
  };
  return font;
}

/**
 * Run the export pipeline. Must be called inside the document queue. Returns the bytes and the
 * document state they were produced from.
 */
export async function exportNow(docId: DocId, opts: ExportOptions): Promise<{ bytes: Uint8Array; doc: DocState }> {
  await commitFormsNow(docId);
  const doc = requireDoc(docId);
  const purpose = opts.purpose;
  const options: ExportOptions = { ...opts, flatten: !!opts.flatten || purpose === 'print' || purpose === 'bake' };
  const objs = exportableObjects(doc, opts);
  const origin = getOrigin(docId);
  const edited = !origin || doc.meta !== origin.meta || doc.outline !== origin.outline;

  const ro = getReadOnly(docId);
  if (ro) {
    if (objs.length || opts.flatten || edited) {
      throw new Error(`“${doc.name}” is open read-only because ${ro.reason}, so changes can't be written into it.`);
    }
    if (doc.pdf && doc.pdfVersion === doc.version && (await formsModified(doc.pdf))) {
      return { bytes: new Uint8Array(await doc.pdf.saveDocument()), doc };
    }
    return { bytes: ro.bytes.slice(), doc };
  }

  const hooks = exportHooks();
  // Nothing changed since the file was opened (imported annotations untouched too): hand back the
  // file itself, byte for byte — keeps digital signatures, incremental updates and structure intact.
  const file = origin?.file;
  if (
    file && origin && !opts.flatten && !opts.skipObjects && !opts.objectIds && !edited &&
    doc.version === origin.version && doc.objects === file.objects && doc.order === file.order &&
    doc.security === origin.security && hooks.every((h) => BUILTIN_HOOK_IDS.has(h.id) || h.noopWhenUnchanged)
  ) {
    const secure = !opts.skipSecurity && purpose !== 'print' && purpose !== 'bake';
    if (secure || !file.encrypted) return { bytes: file.bytes.slice(), doc };
  }
  // Only form values changed since then: pdf.js wrote them as an incremental update appended to
  // the file, so hand that back instead of rewriting everything — digital signatures made before
  // the form was filled stay valid (e.g. the second signer of a routed form).
  if (
    file && origin && !file.encrypted && !opts.flatten && !opts.skipObjects && !opts.objectIds && !edited &&
    doc.objects === file.objects && doc.order === file.order && doc.security === origin.security &&
    hooks.every((h) => BUILTIN_HOOK_IDS.has(h.id) || h.noopWhenUnchanged) && extendsBytes(doc.bytes, file.bytes)
  ) {
    return { bytes: doc.bytes.slice(), doc };
  }
  const untouched =
    !objs.length && !opts.flatten && !edited && origin && doc.version === origin.version && hooks.every((h) => BUILTIN_HOOK_IDS.has(h.id));
  if (untouched) {
    const secure = !opts.skipSecurity && purpose !== 'print' && purpose !== 'bake';
    if (secure && origin.sourceBytes && doc.security === origin.security) return { bytes: origin.sourceBytes.slice(), doc };
    if (!secure || !needsEncryption(doc.security)) return { bytes: doc.bytes.slice(), doc };
  }

  let lib: LibDocument;
  try {
    lib = await loadLib(doc.bytes);
  } catch (e) {
    throw new Error(`Couldn't read the document: ${errMsg(e)}`);
  }
  lib.registerFontkit(fontkit);
  const libPages = lib.getPages();
  if (libPages.length !== doc.pages.length) throw new Error('The document pages are out of sync. Close and reopen the document.');
  const indexOf = new Map<PageId, number>(doc.pages.map((p, i) => [p.id, i]));
  const pageIndex = (pageId: PageId) => {
    const i = indexOf.get(pageId);
    if (i === undefined) throw new Error('The page no longer exists.');
    return i;
  };
  const fonts = new Map<string, Promise<PDFFont>>();
  const memo = (key: string, make: () => Promise<PDFFont>) => {
    let p = fonts.get(key);
    if (!p) {
      p = make();
      p.catch(() => fonts.delete(key));
      fonts.set(key, p);
    }
    return p;
  };
  const ctx: ExportContext = {
    pdfDoc: lib,
    doc,
    options,
    page(pageId: PageId) {
      const p = libPages[pageIndex(pageId)];
      preparePage(p);
      return p;
    },
    pageInfo(pageId: PageId): PageInfo {
      return doc.pages[pageIndex(pageId)];
    },
    standardFont: (name) => memo(`std:${name}`, () => lib.embedFont(name)),
    customFont: (key, bytes) =>
      memo(`custom:${key}`, async () => {
        const b = await cachedFontBytes(key, bytes);
        return patchFontkitSubset(await lib.embedFont(b, { subset: !isOpenTypeCff(b) }));
      }),
    annots: createAnnotationWriter(options),
  };

  const run = async (h: ExportHook) => {
    try {
      await h.run(ctx);
    } catch (e) {
      console.error(`[engine] export hook "${h.id}" failed`, e);
      throw new Error(`Export step “${h.id}” failed: ${errMsg(e)}`);
    }
  };
  for (const h of hooks) if (h.order < 0) await run(h);
  if (opts.flatten) flattenExistingAnnotations(lib);
  for (const obj of objs) {
    const def = reg.objectType(obj.kind)!;
    try {
      await def.exportToPdf!(obj, ctx);
    } catch (e) {
      console.error(`[engine] exporting ${obj.kind} ${obj.id} failed`, e);
      throw new Error(`Couldn't export ${def.label || obj.kind} on page ${pageIndex(obj.pageId) + 1}: ${errMsg(e)}`);
    }
  }
  for (const h of hooks) if (h.order >= 0) await run(h);

  await lib.flush();
  collectGarbage(lib);
  encryptLooseStrings(lib);
  const bytes = await lib.save(SAVE_OPTIONS);
  return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), doc };
}

export async function exportPdf(docId: DocId, opts: ExportOptions): Promise<Uint8Array> {
  const { bytes } = await enqueue(docId, () => delayedBusy('Preparing document…', () => exportNow(docId, opts)));
  return bytes;
}

/** True when `bytes` is `prefix` followed by more data (an incremental update of it). */
function extendsBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length <= prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/** True when nothing that is written into the file changed since `then`. */
function unchangedSince(cur: DocState, then: DocState): boolean {
  return (
    cur.version === then.version && cur.objects === then.objects && cur.order === then.order && cur.meta === then.meta &&
    cur.outline === then.outline && cur.security === then.security
  );
}

/** Permanently merge objects into the page content (one undo step) and remove them. */
export function bakeObjects(docId: DocId, objectIds: ObjectId[], label: string): Promise<void> {
  return enqueue(docId, () =>
    delayedBusy(`${label}…`, async () => {
      const d = requireDoc(docId);
      if (isReadOnly(docId)) throw new Error(`“${d.name}” is read-only, so changes can't be applied to its pages.`);
      if (!objectIds.length) return;
      const { bytes, doc } = await exportNow(docId, { purpose: 'bake', objectIds, skipSecurity: true });
      const baked = new Set(exportableObjects(doc, { objectIds }).map((o) => o.id));
      if (!baked.size) return;
      const cur = requireDoc(docId);
      if (cur.version !== doc.version) throw new Error('The document changed while the operation was running. Try again.');
      const objects = Object.fromEntries(Object.entries(cur.objects).filter(([id]) => !baked.has(id)));
      actions.commitBytes(docId, {
        bytes,
        pages: cur.pages,
        objects,
        order: cur.order.filter((id) => objects[id]),
        label,
      });
    }),
  );
}

// ── download / save / print ──────────────────────────────────────────────────

/** Blocking progress overlay; errors propagate to the caller (the shell shows them). */
async function busy<T>(label: string, fn: (report: (p: number | null, label?: string) => void) => Promise<T>): Promise<T> {
  actions.setBusy({ label, progress: null });
  try {
    return await fn((progress, l) => {
      const b = useApp.getState().busy;
      actions.setBusy({ label: l ?? b?.label ?? label, progress });
    });
  } finally {
    actions.setBusy(null);
  }
}

export async function downloadDoc(docId: DocId, opts: { flatten?: boolean; filename?: string } = {}): Promise<void> {
  requireDoc(docId);
  await busy('Preparing download…', async () => {
    const { bytes, doc } = await enqueue(docId, () => exportNow(docId, { purpose: 'download', flatten: !!opts.flatten }));
    downloadBlob(bytes, ensurePdfExtension(opts.filename ?? doc.name));
    const cur = getDoc(docId);
    if (cur && !opts.flatten && unchangedSince(cur, doc)) actions.markSaved(docId);
  });
}

async function uploadNew(name: string, bytes: Uint8Array): Promise<FileMeta> {
  return library.createFile(name, bytes);
}

export async function saveDoc(docId: DocId): Promise<void> {
  const d0 = requireDoc(docId);
  await busy(`Saving “${d0.name}”…`, async () => {
    const { bytes, doc } = await enqueue(docId, () => exportNow(docId, { purpose: 'save' }));
    let meta: FileMeta;
    if (doc.fileId) {
      try {
        meta = await library.saveFileBytes(doc.fileId, bytes, doc.name);
      } catch (e) {
        if (!(e instanceof LibraryError && e.notFound)) throw e;
        meta = await uploadNew(doc.name, bytes);
      }
    } else {
      meta = await uploadNew(doc.name, bytes);
    }
    const cur = getDoc(docId);
    if (cur) {
      if (unchangedSince(cur, doc)) actions.markSaved(docId, meta.id);
      else actions.updateDoc(docId, { fileId: meta.id });
      if (meta.name && meta.name !== cur.name) actions.rename(docId, meta.name);
    }
    actions.toast(`Saved “${meta.name || doc.name}” to your files.`, { kind: 'success' });
  });
}

export async function saveDocAs(docId: DocId, name: string): Promise<void> {
  requireDoc(docId);
  const fileName = ensurePdfExtension(name);
  await busy(`Saving “${fileName}”…`, async () => {
    const { bytes, doc } = await enqueue(docId, () => exportNow(docId, { purpose: 'save' }));
    const meta = await uploadNew(fileName, bytes);
    const cur = getDoc(docId);
    if (cur) {
      actions.rename(docId, meta.name || fileName);
      if (unchangedSince(cur, doc)) actions.markSaved(docId, meta.id);
      else actions.updateDoc(docId, { fileId: meta.id });
    }
    actions.toast(`Saved “${meta.name || fileName}” to your files.`, { kind: 'success' });
  });
}

const PRINT_DPI = 150;

interface PrintPage {
  url: string;
  /** Size in points as printed (rotation applied). */
  width: number;
  height: number;
}

async function renderForPrint(pdf: PDFDocumentProxy, report: (p: number | null, label?: string) => void): Promise<PrintPage[]> {
  const out: PrintPage[] = [];
  const n = pdf.numPages;
  try {
    for (let i = 1; i <= n; i++) {
      report((i - 1) / n, `Preparing page ${i} of ${n} for printing…`);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // Keep very large pages within canvas limits.
      const scale = Math.min(PRINT_DPI / 72, 8000 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({
        canvas,
        viewport,
        intent: 'print',
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
        background: 'rgb(255,255,255)',
      }).promise;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      canvas.width = canvas.height = 0;
      page.cleanup();
      if (!blob) throw new Error('The page could not be rendered for printing.');
      out.push({ url: URL.createObjectURL(blob), width: base.width, height: base.height });
    }
    report(1);
    return out;
  } catch (e) {
    for (const p of out) URL.revokeObjectURL(p.url);
    throw e;
  }
}

function printPages(pages: PrintPage[], title: string): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.dataset.enginePrint = '';
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const idoc = iframe.contentDocument;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
    for (const p of pages) URL.revokeObjectURL(p.url);
  };
  if (!win || !idoc) {
    cleanup();
    return Promise.reject(new Error('Printing is not available in this browser.'));
  }
  const sizes = new Map<string, string>();
  const pt = (v: number) => `${r3(v)}pt`;
  const css = [
    '@page { margin: 0; }',
    'html, body { margin: 0; padding: 0; background: #fff; }',
    '.sheet { overflow: hidden; break-after: page; page-break-after: always; }',
    '.sheet:last-child { break-after: auto; page-break-after: auto; }',
    '.sheet img { display: block; width: 100%; height: 100%; }',
  ];
  idoc.title = title;
  for (const p of pages) {
    const key = `${r3(p.width)}x${r3(p.height)}`;
    if (!sizes.has(key)) {
      const name = `size${sizes.size}`;
      sizes.set(key, name);
      css.push(`@page ${name} { size: ${pt(p.width)} ${pt(p.height)}; margin: 0; }`, `.${name} { page: ${name}; width: ${pt(p.width)}; height: ${pt(p.height)}; }`);
    }
  }
  const style = idoc.createElement('style');
  style.textContent = css.join('\n');
  idoc.head.appendChild(style);
  const imgs: HTMLImageElement[] = [];
  for (const p of pages) {
    const sheet = idoc.createElement('div');
    sheet.className = `sheet ${sizes.get(`${r3(p.width)}x${r3(p.height)}`)}`;
    const img = idoc.createElement('img');
    img.src = p.url;
    img.alt = '';
    sheet.appendChild(img);
    idoc.body.appendChild(sheet);
    imgs.push(img);
  }
  return Promise.all(imgs.map((img) => img.decode().catch(() => undefined))).then(() => {
    win.addEventListener('afterprint', () => setTimeout(cleanup, 500), { once: true });
    // Browsers without a blocking print() keep the frame until the dialog is dismissed.
    setTimeout(cleanup, 10 * 60_000);
    win.focus();
    win.print();
  });
}

let printing = false;

export async function printDoc(docId: DocId): Promise<void> {
  const d = requireDoc(docId);
  if (printing) return;
  printing = true;
  try {
    const pages = await busy(`Preparing “${d.name}” for printing…`, async (report) => {
      let pdf: PDFDocumentProxy;
      let temporary = false;
      if (isReadOnly(docId)) {
        pdf = await awaitPdf(docId);
      } else {
        const { bytes } = await enqueue(docId, () => exportNow(docId, { purpose: 'print' }));
        pdf = await loadPdfjs(bytes);
        temporary = true;
      }
      try {
        return await renderForPrint(pdf, report);
      } finally {
        if (temporary) destroyProxy(pdf);
      }
    });
    await printPages(pages, d.name);
  } finally {
    printing = false;
  }
}
