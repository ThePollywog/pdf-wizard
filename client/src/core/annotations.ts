/**
 * Import of annotations that already exist in an opened PDF into editable overlay objects
 * (CONTRACT — shared by the comments, drawing, redact, attachments… features).
 *
 * Features register an importer per PDF annotation subtype. One core import hook walks every
 * page's /Annots once, asks the importers, attaches replies (/IRT Text annotations) and review
 * states to the imported parents, strips everything it consumed (incl. /Popup children) from the
 * base bytes and reloads pdf.js once. Annotations nobody imports stay in the base PDF untouched.
 *
 * Imported objects are exported again by their ObjectTypeDef.exportToPdf. For appearances that
 * can't be regenerated faithfully (stamps, rich FreeText…) call `src.preserveAppearance()` at import
 * time and `preservedAppearanceSpec(ctx, pa, obj.rect)` at export time: the original /AP /N form
 * is copied into the output and mapped onto the (possibly moved/resized) rect.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString,
  PDFObjectCopier, type PDFObject, type PDFPage,
} from '@cantoo/pdf-lib';
import { registerImportHook } from './registry';
import { newObject } from './store';
import { rgb01ToHex, uid } from './util';
import type { AppearanceSpec, ExportContext, ImportContext, PageInfo, PdfObject, Rect, Reply, ReviewStatus } from './types';
import { SAVE_OPTIONS, collectGarbage, parsePdfDate } from './engine/lib';

export interface AnnotationCommon {
  /** /Rect normalized, PDF user space. */
  rect: Rect;
  /** /C as '#rrggbb' (undefined when missing or empty = transparent). */
  color?: string;
  /** /IC as '#rrggbb'. */
  fillColor?: string;
  /** /CA (default 1). */
  opacity: number;
  /** /BS /W, else /Border[2], default 1. */
  strokeWidth: number;
  /** /BS /D dash array when /BS /S is /D. */
  dash?: number[];
  /** /T (author), '' when missing. */
  author: string;
  /** /Contents */
  contents?: string;
  /** /Subj */
  subject?: string;
  /** /NM */
  name?: string;
  /** /CreationDate, else /M, else now (epoch ms). */
  createdAt: number;
  /** /M, else createdAt (epoch ms). */
  modifiedAt: number;
  /** /F flags. */
  flags: number;
  /** F bit 2 (Hidden) or bit 6 (NoView). */
  hidden: boolean;
}

export interface AnnotationSource {
  lib: PDFDocument;
  dict: PDFDict;
  /** Indirect reference (null for a direct dict inside /Annots). */
  ref: PDFRef | null;
  /** /Subtype without the slash, e.g. 'Highlight'. */
  subtype: string;
  page: PageInfo;
  pageIndex: number;
  libPage: PDFPage;
  common: AnnotationCommon;
  /** Resolved value of a key (follows references). */
  get(key: string): PDFObject | undefined;
  text(key: string): string | undefined;
  num(key: string): number | undefined;
  nums(key: string): number[] | undefined;
  name(key: string): string | undefined;
  /** Color array → '#rrggbb' (gray, RGB or CMYK). */
  color(key: string): string | undefined;
  /** Copy the normal appearance (/AP /N, respecting /AS) into a standalone mini PDF. */
  preserveAppearance(): Promise<PreservedAppearance | null>;
}

/** Serializable copy of an annotation's normal appearance stream. */
export interface PreservedAppearance {
  /** One-page PDF whose page /Resources /XObject /Ap is the appearance form XObject. */
  pdf: Uint8Array;
  /** The form's BBox transformed by its /Matrix: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
}

export interface AnnotationImporter {
  id: string;
  /** PDF subtypes handled, e.g. ['Highlight', 'Underline', 'StrikeOut', 'Squiggly']. */
  subtypes: string[];
  /** When several importers claim a subtype, the highest priority is asked first (default 0). */
  priority?: number;
  /**
   * Return the overlay object (replies/status are attached by the core; you may leave them unset),
   * or null to leave the annotation in the base PDF. Use `importedObject(src, …)` to fill common fields.
   */
  import(src: AnnotationSource): PdfObject | null | Promise<PdfObject | null>;
  /**
   * [comments] Optional. Called for an annotation grouped with one this importer created
   * (`/IRT` → the primary, `/RT /Group`, e.g. the StrikeOut of a "Replace text" Caret).
   * Return the (updated) primary object to consume the member (it is then stripped from the base
   * PDF like the primary), or null/undefined to leave the member in the base PDF.
   */
  importGroupMember?(
    primary: PdfObject,
    member: AnnotationSource,
    primarySrc: AnnotationSource,
  ): PdfObject | null | undefined | Promise<PdfObject | null | undefined>;
}

const importers: AnnotationImporter[] = [];

export function registerAnnotationImporter(imp: AnnotationImporter): void {
  const i = importers.findIndex((x) => x.id === imp.id);
  if (i >= 0) importers.splice(i, 1);
  importers.push(imp);
  importers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  ensureHook();
}

export function getAnnotationImporters(): readonly AnnotationImporter[] {
  return importers;
}

/** newObject() prefilled from the annotation's common entries (author, dates, colors, contents, imported:true). */
export function importedObject<T extends PdfObject>(
  src: AnnotationSource,
  fields: Pick<T, 'kind' | 'data'> & Partial<Omit<T, 'kind' | 'data'>>,
): T {
  const c = src.common;
  return {
    ...newObject<PdfObject>({ kind: fields.kind, pageId: src.page.id, rect: c.rect, data: fields.data }),
    id: c.name && /^[\w-]{1,64}$/.test(c.name) ? c.name : uid('obj'),
    author: c.author || 'Unknown',
    createdAt: c.createdAt,
    modifiedAt: c.modifiedAt,
    color: c.color,
    fillColor: c.fillColor ?? null,
    opacity: c.opacity,
    strokeWidth: c.strokeWidth,
    contents: c.contents,
    imported: true,
    ...fields,
  } as T;
}

// ── export side ──────────────────────────────────────────────────────────────

/**
 * Appearance spec that draws a preserved appearance stretched onto `rect`
 * (use as `ctx.annots.add(page, obj, { subtype, appearance: await preservedAppearanceSpec(ctx, pa, obj.rect) })`).
 */
export async function preservedAppearanceSpec(ctx: ExportContext, pa: PreservedAppearance, rect: Rect): Promise<AppearanceSpec> {
  const src = await PDFDocument.load(pa.pdf, { updateMetadata: false });
  const page = src.getPage(0);
  const res = page.node.Resources();
  const xo = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const apRef = xo?.get(PDFName.of('Ap'));
  if (!apRef) return { ops: '', bbox: rect };
  const copied = PDFObjectCopier.for(src.context, ctx.pdfDoc.context).copy(apRef);
  const [x0, y0, x1, y1] = pa.bbox;
  const sx = x1 - x0 > 0 ? rect.width / (x1 - x0) : 1;
  const sy = y1 - y0 > 0 ? rect.height / (y1 - y0) : 1;
  const tx = rect.x - x0 * sx;
  const ty = rect.y - y0 * sy;
  const resources = ctx.pdfDoc.context.obj({ XObject: { Ap: copied } }) as PDFDict;
  return { ops: `q ${f(sx)} 0 0 ${f(sy)} ${f(tx)} ${f(ty)} cm /Ap Do Q`, resources, bbox: rect };
}

const f = (n: number) => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(5)).toString());

// ── import hook ──────────────────────────────────────────────────────────────

let hookRegistered = false;
function ensureHook() {
  if (hookRegistered) return;
  hookRegistered = true;
  registerImportHook({ id: 'core-annotations', order: 50, run: importAnnotations });
}

const N = (n: string) => PDFName.of(n);

function resolve(lib: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? lib.context.lookup(o) : o;
}
function asDict(lib: PDFDocument, o: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(lib, o);
  return v instanceof PDFDict ? v : v instanceof PDFStream ? v.dict : undefined;
}
function textOf(v: PDFObject | undefined): string | undefined {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}
function numsOf(lib: PDFDocument, v: PDFObject | undefined): number[] | undefined {
  const a = resolve(lib, v);
  if (!(a instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const n = resolve(lib, a.get(i));
    if (!(n instanceof PDFNumber)) return undefined;
    out.push(n.asNumber());
  }
  return out;
}
function colorOf(c: number[] | undefined): string | undefined {
  if (!c || c.length === 0) return undefined;
  const cl = (x: number) => Math.min(1, Math.max(0, x));
  if (c.length === 1) return rgb01ToHex(cl(c[0]), cl(c[0]), cl(c[0]));
  if (c.length === 3) return rgb01ToHex(cl(c[0]), cl(c[1]), cl(c[2]));
  if (c.length === 4) {
    const [C, M, Y, K] = c.map(cl);
    return rgb01ToHex((1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K));
  }
  return undefined;
}
function dateMs(s: string | undefined): number | undefined {
  const iso = parsePdfDate(s);
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : undefined;
}
function normRect(r: number[] | undefined): Rect {
  if (!r || r.length < 4) return { x: 0, y: 0, width: 0, height: 0 };
  const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]);
  return { x: x0, y: y0, width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) };
}

function makeSource(lib: PDFDocument, dict: PDFDict, ref: PDFRef | null, page: PageInfo, pageIndex: number, libPage: PDFPage): AnnotationSource {
  const get = (k: string) => resolve(lib, dict.get(N(k)));
  const text = (k: string) => textOf(get(k));
  const num = (k: string) => {
    const v = get(k);
    return v instanceof PDFNumber ? v.asNumber() : undefined;
  };
  const nums = (k: string) => numsOf(lib, dict.get(N(k)));
  const name = (k: string) => {
    const v = get(k);
    return v instanceof PDFName ? v.decodeText() : undefined;
  };
  const bs = asDict(lib, dict.get(N('BS')));
  const bsW = bs?.get(N('W'));
  const border = nums('Border');
  const flags = num('F') ?? 0;
  const created = dateMs(text('CreationDate'));
  const modified = dateMs(text('M'));
  const now = Date.now();
  const bsStyle = bs?.get(N('S'));
  const common: AnnotationCommon = {
    rect: normRect(nums('Rect')),
    color: colorOf(nums('C')),
    fillColor: colorOf(nums('IC')),
    opacity: Math.min(1, Math.max(0, num('CA') ?? 1)),
    strokeWidth: bsW instanceof PDFNumber ? bsW.asNumber() : border && border.length >= 3 ? border[2] : 1,
    dash: bsStyle instanceof PDFName && bsStyle.decodeText() === 'D' ? numsOf(lib, bs?.get(N('D'))) ?? [3] : undefined,
    author: text('T') ?? '',
    contents: text('Contents') || undefined,
    subject: text('Subj') || undefined,
    name: text('NM') || undefined,
    createdAt: created ?? modified ?? now,
    modifiedAt: modified ?? created ?? now,
    flags,
    hidden: (flags & 2) !== 0 || (flags & 32) !== 0,
  };
  return {
    lib, dict, ref, subtype: name('Subtype') ?? '', page, pageIndex, libPage, common,
    get, text, num, nums, name,
    color: (k) => colorOf(nums(k)),
    preserveAppearance: () => preserve(lib, dict),
  };
}

async function preserve(lib: PDFDocument, dict: PDFDict): Promise<PreservedAppearance | null> {
  const ap = asDict(lib, dict.get(N('AP')));
  if (!ap) return null;
  let nRef: PDFObject | undefined = ap.get(N('N'));
  const n = resolve(lib, nRef);
  if (n instanceof PDFDict && !(n instanceof PDFStream)) {
    const as = resolve(lib, dict.get(N('AS')));
    nRef = as instanceof PDFName ? n.get(as) : undefined;
  }
  const stream = resolve(lib, nRef);
  if (!(stream instanceof PDFStream)) return null;
  const bb = numsOf(lib, stream.dict.get(N('BBox')));
  if (!bb || bb.length < 4) return null;
  const m = numsOf(lib, stream.dict.get(N('Matrix'))) ?? [1, 0, 0, 1, 0, 0];
  const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]].map(([x, y]) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bbox: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const out = await PDFDocument.create({ updateMetadata: false });
  const copied = PDFObjectCopier.for(lib.context, out.context).copy(nRef instanceof PDFRef ? nRef : lib.context.register(stream));
  const page = out.addPage([Math.max(1, bbox[2] - bbox[0]), Math.max(1, bbox[3] - bbox[1])]);
  page.node.set(N('Resources'), out.context.obj({ XObject: { Ap: copied } }));
  return { pdf: await out.save({ useObjectStreams: false }), bbox };
}

const STATE_MAP: Record<string, ReviewStatus> = {
  Accepted: 'accepted', Rejected: 'rejected', Cancelled: 'cancelled', Completed: 'completed', None: 'none',
};

interface Entry {
  src: AnnotationSource;
  key: PDFObject;
  irt?: PDFObject;
  obj?: PdfObject | null;
  /** [comments] Importer that produced `obj`. */
  importer?: AnnotationImporter;
}

/**
 * [comments] Runs the importers over every page of `lib` (steps 1–2 of the import hook: objects,
 * grouped members, replies and review states) without touching the document.
 */
async function collectImports(lib: PDFDocument, pages: PageInfo[]): Promise<{ libPages: PDFPage[]; imported: Entry[]; consumedChildren: Entry[] }> {
  const libPages = lib.getPages();
  const entries: Entry[] = [];
  const byKey = new Map<PDFObject, Entry>();

  libPages.forEach((libPage, pageIndex) => {
    const page = pages[pageIndex];
    if (!page) return;
    const annots = resolve(lib, libPage.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = asDict(lib, raw);
      if (!dict) continue;
      const src = makeSource(lib, dict, raw instanceof PDFRef ? raw : null, page, pageIndex, libPage);
      if (!src.subtype || src.subtype === 'Popup') continue;
      const e: Entry = { src, key: raw instanceof PDFRef ? raw : dict, irt: dict.get(N('IRT')) };
      entries.push(e);
      byKey.set(e.key, e);
    }
  });

  // 1) top-level annotations → importers
  for (const e of entries) {
    if (e.irt) continue;
    for (const imp of importers) {
      if (!imp.subtypes.includes(e.src.subtype)) continue;
      try {
        const obj = await imp.import(e.src);
        if (obj) {
          e.obj = obj;
          e.importer = imp;
          break;
        }
      } catch (err) {
        console.warn(`[annotations] importer "${imp.id}" failed on ${e.src.subtype}`, err);
      }
    }
  }

  // 2) replies + review states (/IRT chains resolve to the top-level parent; threads are flat)
  const rootOf = (e: Entry, depth = 0): Entry | undefined => {
    if (!e.irt) return e;
    const parent = byKey.get(e.irt);
    return parent && depth < 32 ? rootOf(parent, depth + 1) : undefined;
  };
  const consumedChildren: Entry[] = [];

  // [comments] 1b) /RT /Group members → the importer of their primary
  for (const e of entries) {
    if (!e.irt || e.src.name('RT') !== 'Group') continue;
    const root = rootOf(e);
    if (!root?.obj || !root.importer?.importGroupMember) continue;
    try {
      const merged = await root.importer.importGroupMember(root.obj, e.src, root.src);
      if (merged) {
        root.obj = merged;
        consumedChildren.push(e);
      }
    } catch (err) {
      console.warn(`[annotations] importer "${root.importer.id}" failed on grouped ${e.src.subtype}`, err);
    }
  }

  const states = new Map<PdfObject, { at: number; status: ReviewStatus }>();
  for (const e of entries) {
    if (!e.irt) continue;
    if (e.src.name('RT') === 'Group') continue;
    const root = rootOf(e);
    if (!root?.obj) continue;
    const stateModel = e.src.text('StateModel');
    const state = e.src.text('State');
    consumedChildren.push(e);
    if (stateModel || state) {
      if ((stateModel ?? 'Review') === 'Review' && state && STATE_MAP[state]) {
        const prev = states.get(root.obj);
        if (!prev || e.src.common.modifiedAt >= prev.at) states.set(root.obj, { at: e.src.common.modifiedAt, status: STATE_MAP[state] });
      }
      continue;
    }
    const reply: Reply = {
      id: e.src.common.name || uid('rp'),
      author: e.src.common.author || 'Unknown',
      text: e.src.common.contents ?? '',
      createdAt: e.src.common.createdAt,
    };
    root.obj.replies = [...(root.obj.replies ?? []), reply];
  }
  for (const [obj, s] of states) obj.status = s.status;

  const imported = entries.filter((e) => e.obj);
  const ids = new Set<string>();
  for (const e of imported) {
    if (ids.has(e.obj!.id)) e.obj!.id = uid('obj');
    ids.add(e.obj!.id);
  }
  for (const e of imported) e.obj!.replies?.sort((a, b) => a.createdAt - b.createdAt);
  return { libPages, imported, consumedChildren };
}

/**
 * [comments] Convert the annotations of an arbitrary pdf-lib document (e.g. one built from an
 * XFDF file) into overlay objects with the registered importers, attaching replies / review
 * states and grouped members. `pages[i]` is the PageInfo the objects of lib page i belong to.
 * The document is not modified.
 */
export async function importObjectsFromLib(lib: PDFDocument, pages: PageInfo[]): Promise<PdfObject[]> {
  if (!importers.length) return [];
  const { imported } = await collectImports(lib, pages);
  return imported.map((e) => e.obj!);
}

async function importAnnotations(ctx: ImportContext): Promise<void> {
  if (!importers.length) return;
  const lib = await PDFDocument.load(ctx.bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
  const { libPages, imported, consumedChildren } = await collectImports(lib, ctx.pages);
  if (!imported.length) return;

  // 3) strip consumed annotations (+ their popups) from the pages
  const drop = new Set<PDFObject>();
  for (const e of [...imported, ...consumedChildren]) {
    drop.add(e.key);
    const popup = e.src.dict.get(N('Popup'));
    if (popup) drop.add(popup);
  }
  for (const libPage of libPages) {
    const annots = resolve(lib, libPage.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    const keep = PDFArray.withContext(lib.context);
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = asDict(lib, raw);
      const key = raw instanceof PDFRef ? raw : dict;
      if (key && drop.has(key)) continue;
      // popups whose parent was consumed
      const parent = dict?.get(N('Parent'));
      const st = dict ? resolve(lib, dict.get(N('Subtype'))) : undefined;
      if (parent && drop.has(parent) && st instanceof PDFName && st.decodeText() === 'Popup') continue;
      keep.push(raw);
    }
    if (keep.size() === 0) libPage.node.delete(N('Annots'));
    else libPage.node.set(N('Annots'), keep);
  }
  await lib.flush();
  collectGarbage(lib);
  ctx.setBytes(await lib.save(SAVE_OPTIONS));
  ctx.addObjects(imported.map((e) => e.obj!));
}
