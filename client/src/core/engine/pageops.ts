/**
 * Page operations (Organize Pages, Crop, Insert, Replace, Extract...). Each one edits the base bytes
 * with pdf-lib inside a single document (shared resources stay shared), keeps page ids stable,
 * bakes pending form values first and commits exactly one undo step.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFNumber, PDFPageLeaf, PDFRef, PDFString, type PDFObject,
} from '@cantoo/pdf-lib';
import type { DocId, DocState, LibDocument, ObjectId, PageInfo, PdfObject, Rect } from '../types';
import { actions } from '../store';
import { baseName, readFileBytes, uid } from '../util';
import {
  N, SAVE_OPTIONS, annotRefsOf, cloneDirect, collectGarbage, importPages, isEncryptedError, isWidget, leafInfo,
  leavesOf, libPageInfo, loadLib, lookup, lookupArray, lookupDict, materializeInherited, mediaBoxOf, nameOf,
  normalizeRotation, nullifyRefs, dropDeadDestinations, pdfDate, pruneAcroForm, rebuildPageTree, remapLabels, rotationOf,
  splitMergedField, viewBoxOf,
} from './lib';
import { commitFormsNow } from './forms';
import { delayedBusy, enqueue, getReadOnly, requireDoc } from './state';
import { exportNow } from './export';
import { handlerFor, hasPdfHeader } from './open';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newPageId = () => uid('page');
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

interface EditResult {
  pages: PageInfo[];
  /** Objects to add (e.g. copies on duplicated pages). */
  addObjects?: PdfObject[];
}

function readOnlyError(doc: DocState, what: string) {
  const ro = getReadOnly(doc.id);
  return new Error(`“${doc.name}” is open read-only${ro ? ` because ${ro.reason}` : ''}, so ${what}.`);
}

/**
 * Load the bytes with pdf-lib, run `fn`, save and commit one undoable step. Runs in the document
 * queue so byte edits never interleave.
 */
function editLib(docId: DocId, label: string, fn: (lib: LibDocument, doc: DocState) => Promise<EditResult> | EditResult): Promise<void> {
  return enqueue(docId, () =>
    delayedBusy(`${label}…`, async () => {
      const d0 = requireDoc(docId);
      if (getReadOnly(docId)) throw readOnlyError(d0, "its pages can't be changed");
      await commitFormsNow(docId);
      const doc = requireDoc(docId);
      let lib: LibDocument;
      try {
        lib = await loadLib(doc.bytes);
      } catch (e) {
        throw new Error(`Couldn't read the document: ${errMsg(e)}`);
      }
      if (lib.getPageCount() !== doc.pages.length) throw new Error('The document pages are out of sync. Close and reopen the document.');
      const result = await fn(lib, doc);
      if (!result.pages.length) throw new Error('A document needs at least one page.');
      await lib.flush();
      collectGarbage(lib);
      const bytes = await lib.save(SAVE_OPTIONS);
      const cur = requireDoc(docId);
      if (cur.version !== doc.version) throw new Error('The document changed while the operation was running. Try again.');
      let objects: Record<ObjectId, PdfObject> | undefined;
      let order: ObjectId[] | undefined;
      if (result.addObjects?.length) {
        const pageIds = new Set(result.pages.map((p) => p.id));
        objects = Object.fromEntries(Object.entries(cur.objects).filter(([, o]) => pageIds.has(o.pageId)));
        for (const o of result.addObjects) objects[o.id] = o;
        order = [...cur.order.filter((id) => objects![id]), ...result.addObjects.map((o) => o.id)];
      }
      actions.commitBytes(docId, { bytes, pages: result.pages, label, objects, order });
    }),
  );
}

/** Generic byte edit (see ARCHITECTURE.md). */
export function withLib(
  docId: DocId,
  label: string,
  fn: (lib: LibDocument, pages: PageInfo[]) => Promise<PageInfo[] | void> | PageInfo[] | void,
): Promise<void> {
  return editLib(docId, label, async (lib, doc) => {
    const r = await fn(lib, doc.pages.map((p) => ({ ...p })));
    if (Array.isArray(r)) return { pages: r };
    return { pages: libPageInfo(lib, doc.pages.map((p) => p.id), newPageId) };
  });
}

/**
 * Replace the base bytes with `transform(bytes)` as one undo step (OCR, compression, digital
 * signing, PDF/A…, often done by the server). `bytes` has the pending form values baked in and
 * must not be kept. Page ids — and so overlay objects — are kept by index; objects on pages that
 * no longer exist are dropped. `dropObjects` clears the overlay objects instead (the transform
 * started from an export that already contains them, e.g. digital signing). Resolves with the
 * committed bytes.
 */
export function replaceBytes(
  docId: DocId,
  label: string,
  transform: (bytes: Uint8Array, doc: DocState) => Promise<Uint8Array> | Uint8Array,
  opts: { dropObjects?: boolean } = {},
): Promise<Uint8Array> {
  return enqueue(docId, () =>
    delayedBusy(`${label}…`, async () => {
      const d0 = requireDoc(docId);
      if (getReadOnly(docId)) throw readOnlyError(d0, "it can't be changed");
      await commitFormsNow(docId);
      const doc = requireDoc(docId);
      const bytes = await transform(doc.bytes.slice(), doc);
      if (!(bytes instanceof Uint8Array) || !hasPdfHeader(bytes)) throw new Error(`${label} didn't produce a PDF.`);
      let lib: LibDocument;
      try {
        lib = await loadLib(bytes);
      } catch (e) {
        throw new Error(`${label} produced a PDF that can't be read: ${errMsg(e)}`);
      }
      const pages = libPageInfo(lib, doc.pages.map((p) => p.id), newPageId);
      if (!pages.length) throw new Error('A document needs at least one page.');
      if (requireDoc(docId).version !== doc.version) throw new Error('The document changed while the operation was running. Try again.');
      actions.commitBytes(docId, { bytes, pages, label, ...(opts.dropObjects ? { objects: {}, order: [] } : {}) });
      return bytes;
    }),
  );
}

/** Sorted unique page indices, validated. */
function checkIndices(doc: DocState, indices: number[]): number[] {
  if (!indices?.length) throw new Error('No pages were selected.');
  const set = new Set<number>();
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= doc.pages.length) throw new Error(`Page ${Number.isFinite(i) ? i + 1 : i} doesn't exist.`);
    set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

// ── rotate ───────────────────────────────────────────────────────────────────

export async function rotatePages(docId: DocId, indices: number[], delta: 90 | -90 | 180): Promise<void> {
  const doc = requireDoc(docId);
  const idx = checkIndices(doc, indices);
  if (![90, -90, 180, 270, -180, -270].includes(delta)) return Promise.reject(new Error('Pages can only be rotated in steps of 90°.'));
  return editLib(docId, plural(idx.length, 'Rotate page', 'Rotate pages'), (lib, d) => {
    const leaves = leavesOf(lib);
    for (const i of idx) {
      const leaf = leaves[i].leaf;
      leaf.set(N('Rotate'), PDFNumber.of(normalizeRotation(rotationOf(leaf) + delta)));
    }
    return { pages: libPageInfo(lib, d.pages.map((p) => p.id), newPageId) };
  });
}

// ── delete ───────────────────────────────────────────────────────────────────

export async function deletePages(docId: DocId, indices: number[]): Promise<void> {
  const doc = requireDoc(docId);
  const idx = checkIndices(doc, indices);
  if (idx.length >= doc.pages.length) return Promise.reject(new Error("You can't delete all pages. A document needs at least one page."));
  return editLib(docId, plural(idx.length, 'Delete page', 'Delete pages'), (lib, d) => {
    const ctx = lib.context;
    materializeInherited(lib);
    const leaves = leavesOf(lib);
    const del = new Set(idx);
    const keptIdx = range(leaves.length).filter((i) => !del.has(i));
    const removedRefs = new Set(idx.map((i) => leaves[i].ref));
    const deadWidgets = new Set<PDFObject>();
    for (const i of idx) {
      for (const a of annotRefsOf(leaves[i].leaf)) if (isWidget(ctx, lookupDict(ctx, a))) deadWidgets.add(a);
    }
    if (deadWidgets.size) pruneAcroForm(lib, (r) => !deadWidgets.has(r));
    const open = lookup(ctx, lib.catalog.get(N('OpenAction')));
    if (open instanceof PDFArray && open.size() && removedRefs.has(open.get(0) as PDFRef)) lib.catalog.delete(N('OpenAction'));
    rebuildPageTree(lib, keptIdx.map((i) => leaves[i].ref));
    for (const r of removedRefs) ctx.delete(r);
    nullifyRefs(lib, removedRefs);
    dropDeadDestinations(lib);
    remapLabels(lib, keptIdx);
    return { pages: libPageInfo(lib, keptIdx.map((i) => d.pages[i].id), newPageId) };
  });
}

// ── move ─────────────────────────────────────────────────────────────────────

function reorder(docId: DocId, order: number[], label: string): Promise<void> {
  return editLib(docId, label, (lib, d) => {
    if (order.length !== d.pages.length) throw new Error('The new page order is invalid.');
    materializeInherited(lib);
    const leaves = leavesOf(lib);
    rebuildPageTree(lib, order.map((i) => leaves[i].ref));
    remapLabels(lib, order);
    return { pages: libPageInfo(lib, order.map((i) => d.pages[i].id), newPageId) };
  });
}

function validOrder(order: number[], n: number): boolean {
  if (!Array.isArray(order) || order.length !== n) return false;
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

/** newOrder[i] = old index placed at position i. */
export async function movePages(docId: DocId, newOrder: number[]): Promise<void> {
  const doc = requireDoc(docId);
  if (!validOrder(newOrder, doc.pages.length)) throw new Error('The new page order is invalid.');
  if (newOrder.every((v, i) => v === i)) return;
  const moved = newOrder.filter((v, i) => v !== i).length;
  return reorder(docId, newOrder, plural(moved, 'Move page', 'Move pages'));
}

/** Move the pages `indices` so they sit (in document order) before the page currently at `targetIndex`. */
export async function movePagesTo(docId: DocId, indices: number[], targetIndex: number): Promise<void> {
  const doc = requireDoc(docId);
  const idx = checkIndices(doc, indices);
  const n = doc.pages.length;
  const target = Math.max(0, Math.min(n, Math.round(Number(targetIndex) || 0)));
  const sel = new Set(idx);
  const rest = range(n).filter((i) => !sel.has(i));
  const insertAt = rest.filter((i) => i < target).length;
  const order = [...rest.slice(0, insertAt), ...idx, ...rest.slice(insertAt)];
  if (order.every((v, i) => v === i)) return;
  return reorder(docId, order, plural(idx.length, 'Move page', 'Move pages'));
}

// ── insert ───────────────────────────────────────────────────────────────────

function checkPosition(doc: DocState, at: number): number {
  if (!Number.isInteger(at) || at < 0 || at > doc.pages.length) throw new Error(`Pages can't be inserted at position ${at + 1}.`);
  return at;
}

function spliceRefs(lib: LibDocument, at: number, inserted: PDFRef[]) {
  const refs = leavesOf(lib).map((l) => l.ref);
  const origin: (number | null)[] = range(refs.length);
  refs.splice(at, 0, ...inserted);
  origin.splice(at, 0, ...inserted.map(() => null));
  rebuildPageTree(lib, refs);
  remapLabels(lib, origin);
}

export async function insertBlankPages(docId: DocId, at: number, count = 1, size?: { width: number; height: number }): Promise<void> {
  const doc = requireDoc(docId);
  checkPosition(doc, at);
  if (!Number.isInteger(count) || count < 1 || count > 1000) return Promise.reject(new Error('Enter a number of pages between 1 and 1000.'));
  if (size && !(size.width >= 3 && size.height >= 3 && size.width <= 14400 && size.height <= 14400)) {
    return Promise.reject(new Error('The page size must be between 3 and 14400 points.'));
  }
  return editLib(docId, plural(count, 'Insert blank page', 'Insert blank pages'), (lib, d) => {
    const ctx = lib.context;
    materializeInherited(lib);
    const leaves = leavesOf(lib);
    let w = size?.width ?? 612;
    let h = size?.height ?? 792;
    if (!size) {
      // Match the neighbouring page as it is displayed.
      const near = leaves[at - 1] ?? leaves[at];
      if (near) {
        const info = leafInfo(near.leaf, '');
        const swap = info.rotation === 90 || info.rotation === 270;
        w = swap ? info.height : info.width;
        h = swap ? info.width : info.height;
      }
    }
    const rootRef = lib.catalog.get(N('Pages')) as PDFRef;
    const refs: PDFRef[] = [];
    for (let k = 0; k < count; k++) {
      const leaf = PDFPageLeaf.withContextAndParent(ctx, rootRef);
      leaf.set(N('MediaBox'), ctx.obj([0, 0, w, h]));
      refs.push(ctx.register(leaf));
    }
    spliceRefs(lib, at, refs);
    const ids = d.pages.map((p) => p.id);
    ids.splice(at, 0, ...refs.map(() => newPageId()));
    return { pages: libPageInfo(lib, ids, newPageId) };
  });
}

/** Load a PDF to take pages from (unencrypted, or encrypted without an open password). */
async function loadSource(bytes: Uint8Array, name: string): Promise<LibDocument> {
  if (!hasPdfHeader(bytes)) throw new Error(`“${name}” is not a PDF file or is damaged.`);
  let lib: LibDocument;
  try {
    lib = await loadLib(bytes);
  } catch (e) {
    if (!isEncryptedError(e)) throw new Error(`Couldn't read “${name}”: ${errMsg(e)}`);
    try {
      lib = await PDFDocument.load(bytes, { password: '', updateMetadata: false, throwOnInvalidObject: false });
    } catch {
      throw new Error(`“${name}” is password-protected. Open it and remove its security before inserting it.`);
    }
    (lib.context.trailerInfo as { Encrypt?: PDFObject }).Encrypt = undefined;
  }
  materializeInherited(lib);
  return lib;
}

function checkSourceIndices(src: LibDocument, indices: number[] | undefined, name: string): number[] {
  const n = src.getPageCount();
  if (!n) throw new Error(`“${name}” has no pages.`);
  if (!indices) return range(n);
  if (!indices.length) throw new Error('No pages were selected.');
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`“${name}” has no page ${Number.isFinite(i) ? i + 1 : i}.`);
  }
  return indices;
}

async function insertSources(docId: DocId, at: number, sources: { name: string; bytes: Uint8Array; pages?: number[] }[]): Promise<void> {
  return editLib(docId, 'Insert pages', async (lib, d) => {
    const inserted: PDFRef[] = [];
    for (const s of sources) {
      const src = await loadSource(s.bytes, s.name);
      inserted.push(...importPages(lib, src, checkSourceIndices(src, s.pages, s.name)));
    }
    materializeInherited(lib);
    spliceRefs(lib, at, inserted);
    dropDeadDestinations(lib);
    const ids = d.pages.map((p) => p.id);
    ids.splice(at, 0, ...inserted.map(() => newPageId()));
    return { pages: libPageInfo(lib, ids, newPageId) };
  });
}

export async function insertPdfBytes(docId: DocId, at: number, bytes: Uint8Array, pageIndices?: number[]): Promise<void> {
  checkPosition(requireDoc(docId), at);
  return insertSources(docId, at, [{ name: 'The file', bytes: bytes.slice(), pages: pageIndices }]);
}

/** Convert a file to PDF bytes (PDFs as-is, other types through the registered file handlers). */
async function fileToPdf(file: File): Promise<Uint8Array> {
  const ext = (/\.([^./\\]+)$/.exec(file.name)?.[1] ?? '').toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') return readFileBytes(file);
  const handler = handlerFor(file);
  if (handler) {
    try {
      return await handler.convert(file);
    } catch (e) {
      throw new Error(`Couldn't convert “${file.name}” to PDF: ${errMsg(e)}`);
    }
  }
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (hasPdfHeader(head)) return readFileBytes(file);
  throw new Error(`“${file.name}” can't be inserted: this file type isn't supported.`);
}

export async function insertFiles(docId: DocId, at: number, files: File[]): Promise<void> {
  checkPosition(requireDoc(docId), at);
  if (!files.length) return;
  const sources = await delayedBusy(plural(files.length, 'Converting file…', 'Converting files…'), async () => {
    const out: { name: string; bytes: Uint8Array }[] = [];
    for (const f of files) out.push({ name: f.name, bytes: await fileToPdf(f) });
    return out;
  });
  return insertSources(docId, at, sources);
}

// ── duplicate ────────────────────────────────────────────────────────────────

/** Copy a page leaf (content shared) with its own copies of the annotations; form widgets join the same fields. */
function duplicateLeaf(lib: LibDocument, leaf: PDFPageLeaf): PDFRef {
  const ctx = lib.context;
  const newRef = ctx.nextRef();
  const annots = annotRefsOf(leaf);
  // Merged field/widget dictionaries must be split first so the copy can become a sibling widget.
  for (const a of annots) {
    const ad = lookupDict(ctx, a);
    if (a instanceof PDFRef && isWidget(ctx, ad) && ad!.get(N('T')) !== undefined) splitMergedField(lib, a);
  }
  const copy = cloneDirect(leaf, ctx) as PDFPageLeaf;
  copy.delete(N('StructParents'));
  copy.delete(N('B'));
  copy.delete(N('Parent'));
  const contents = copy.get(N('Contents'));
  if (contents instanceof PDFRef) {
    const c = ctx.lookup(contents);
    if (c instanceof PDFArray) copy.set(N('Contents'), ctx.obj(c.asArray()));
  }
  const map = new Map<PDFRef, PDFRef>();
  for (const a of annots) if (a instanceof PDFRef) map.set(a, ctx.nextRef());
  const next: PDFObject[] = [];
  for (const a of annots) {
    if (!(a instanceof PDFRef)) continue;
    const ad = lookupDict(ctx, a);
    if (!ad) continue;
    const c = cloneDirect(ad, ctx);
    c.delete(N('StructParent'));
    c.set(N('P'), newRef);
    for (const key of ['Popup', 'Parent', 'IRT']) {
      const v = c.get(N(key));
      if (v instanceof PDFRef && map.has(v)) c.set(N(key), map.get(v)!);
    }
    if (c.get(N('NM')) !== undefined) c.set(N('NM'), PDFHexString.fromText(uid('annot')));
    const ref = map.get(a)!;
    if (isWidget(ctx, c)) {
      const parent = lookupDict(ctx, c.get(N('Parent')));
      const kids = parent && lookupArray(ctx, parent.get(N('Kids')));
      if (kids) kids.push(ref);
    }
    ctx.assign(ref, c);
    next.push(ref);
  }
  if (next.length) copy.set(N('Annots'), ctx.obj(next));
  else copy.delete(N('Annots'));
  ctx.assign(newRef, copy);
  return newRef;
}

function cloneObject<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}

export async function duplicatePages(docId: DocId, indices: number[]): Promise<void> {
  const doc = requireDoc(docId);
  const idx = checkIndices(doc, indices);
  return editLib(docId, plural(idx.length, 'Duplicate page', 'Duplicate pages'), (lib, d) => {
    materializeInherited(lib);
    const leaves = leavesOf(lib);
    // Contiguous runs are duplicated as a block right after the run (like desktop PDF editors).
    const runs: number[][] = [];
    for (const i of idx) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    }
    const refs = leaves.map((l) => l.ref);
    const ids = d.pages.map((p) => p.id);
    const origin: (number | null)[] = range(refs.length);
    const newIdOf = new Map<string, string[]>();
    for (const run of [...runs].reverse()) {
      const copies = run.map((i) => duplicateLeaf(lib, leaves[i].leaf));
      const copyIds = run.map((i) => {
        const id = newPageId();
        const list = newIdOf.get(d.pages[i].id) ?? [];
        list.push(id);
        newIdOf.set(d.pages[i].id, list);
        return id;
      });
      const after = refs.indexOf(leaves[run[run.length - 1]].ref) + 1;
      refs.splice(after, 0, ...copies);
      ids.splice(after, 0, ...copyIds);
      origin.splice(after, 0, ...run);
    }
    rebuildPageTree(lib, refs);
    remapLabels(lib, origin);
    const addObjects: PdfObject[] = [];
    for (const oid of new Set([...d.order, ...Object.keys(d.objects)])) {
      const o = d.objects[oid];
      const targets = o && newIdOf.get(o.pageId);
      if (!targets) continue;
      for (const pageId of targets) {
        const c = cloneObject(o);
        c.id = uid('obj');
        c.pageId = pageId;
        if (c.replies) c.replies = c.replies.map((r) => ({ ...r, id: uid('reply') }));
        addObjects.push(c);
      }
    }
    return { pages: libPageInfo(lib, ids, newPageId), addObjects };
  });
}

// ── replace ──────────────────────────────────────────────────────────────────

const REPLACED_KEYS = ['Contents', 'Resources', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'Group', 'UserUnit'];

/**
 * Replace the content of pages `indices` with pages of another PDF (`sourceIndices`, default 0, 1, …).
 * Like desktop PDF editors, links, form fields, bookmarks and comments of the original pages are kept and the
 * comments of the new pages are added.
 */
export async function replacePages(docId: DocId, indices: number[], bytes: Uint8Array, sourceIndices?: number[]): Promise<void> {
  const doc = requireDoc(docId);
  if (!indices?.length) throw new Error('No pages were selected.');
  const seen = new Set<number>();
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= doc.pages.length) throw new Error(`Page ${Number.isFinite(i) ? i + 1 : i} doesn't exist.`);
    if (seen.has(i)) throw new Error(`Page ${i + 1} is listed twice.`);
    seen.add(i);
  }
  if (sourceIndices && sourceIndices.length !== indices.length) throw new Error('Select as many replacement pages as pages to replace.');
  const input = bytes.slice();
  return editLib(docId, plural(indices.length, 'Replace page', 'Replace pages'), async (lib, d) => {
    const ctx = lib.context;
    const src = await loadSource(input, 'The replacement file');
    const n = src.getPageCount();
    const from = sourceIndices ?? indices.map((_, k) => k);
    if (!sourceIndices && n < indices.length) {
      throw new Error(`The replacement file has only ${n} ${plural(n, 'page', 'pages')}, but ${indices.length} pages are being replaced.`);
    }
    for (const i of from) if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`The replacement file has no page ${i + 1}.`);
    materializeInherited(lib);
    const leaves = leavesOf(lib);
    const imported = importPages(lib, src, from, { forms: false });
    indices.forEach((target, k) => {
      const { leaf, ref } = leaves[target];
      const fresh = ctx.lookup(imported[k], PDFDict) as PDFPageLeaf;
      for (const key of REPLACED_KEYS) {
        const v = fresh.get(N(key));
        if (v !== undefined) leaf.set(N(key), v);
        else leaf.delete(N(key));
      }
      const annots = annotRefsOf(leaf);
      for (const a of annotRefsOf(fresh)) {
        const ad = lookupDict(ctx, a);
        const sub = ad && nameOf(ctx, ad.get(N('Subtype')));
        if (!ad || sub === 'Link' || sub === 'Widget') continue;
        ad.set(N('P'), ref);
        annots.push(a);
      }
      if (annots.length) leaf.set(N('Annots'), ctx.obj(annots));
      ctx.delete(imported[k]);
    });
    return { pages: libPageInfo(lib, d.pages.map((p) => p.id), newPageId) };
  });
}

// ── crop ─────────────────────────────────────────────────────────────────────

type Margins = { top: number; right: number; bottom: number; left: number };

/** Crop box in user space from margins measured on the page as displayed (rotation applied). */
function boxFromMargins(view: [number, number, number, number], rotation: number, m: Margins): [number, number, number, number] {
  let [x0, y0, x1, y1] = view;
  const { top, right, bottom, left } = m;
  switch (rotation) {
    case 90:
      x0 += top; y1 -= right; x1 -= bottom; y0 += left;
      break;
    case 180:
      y0 += top; x0 += right; y1 -= bottom; x1 -= left;
      break;
    case 270:
      x1 -= top; y0 += right; x0 += bottom; y1 -= left;
      break;
    default:
      y1 -= top; x1 -= right; y0 += bottom; x0 += left;
  }
  return [x0, y0, x1, y1];
}

export async function cropPages(docId: DocId, indices: number[], box: Rect | Margins): Promise<void> {
  const doc = requireDoc(docId);
  const idx = checkIndices(doc, indices);
  const values = 'width' in box ? [box.x, box.y, box.width, box.height] : [box.top, box.right, box.bottom, box.left];
  if (!values.every((v) => Number.isFinite(v))) return Promise.reject(new Error('Enter valid crop values.'));
  return editLib(docId, plural(idx.length, 'Crop page', 'Crop pages'), (lib, d) => {
    const leaves = leavesOf(lib);
    for (const i of idx) {
      const leaf = leaves[i].leaf;
      const media = mediaBoxOf(leaf);
      let r: [number, number, number, number] =
        'width' in box
          ? [box.x, box.y, box.x + box.width, box.y + box.height]
          : boxFromMargins(viewBoxOf(leaf), rotationOf(leaf), box);
      r = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      r = [Math.max(r[0], media[0]), Math.max(r[1], media[1]), Math.min(r[2], media[2]), Math.min(r[3], media[3])];
      if (r[2] - r[0] < 1 || r[3] - r[1] < 1) throw new Error(`The crop area is too small${idx.length > 1 ? ` for page ${i + 1}` : ''}.`);
      const round = (v: number) => Math.round(v * 1000) / 1000;
      leaf.set(N('CropBox'), lib.context.obj(r.map(round)));
    }
    return { pages: libPageInfo(lib, d.pages.map((p) => p.id), newPageId) };
  });
}

// ── extract ──────────────────────────────────────────────────────────────────

/** A new PDF made of pages `indices` (document order). With includeObjects, overlay objects are written in. */
export async function extractPagesToBytes(docId: DocId, indices: number[], opts: { includeObjects?: boolean } = {}): Promise<Uint8Array> {
  return enqueue(docId, () =>
    delayedBusy('Extracting pages…', async () => {
      const d0 = requireDoc(docId);
      const idx = checkIndices(d0, indices);
      if (getReadOnly(docId)) throw readOnlyError(d0, "pages can't be extracted from it");
      let bytes: Uint8Array;
      if (opts.includeObjects) {
        bytes = (await exportNow(docId, { purpose: 'download', skipSecurity: true })).bytes;
      } else {
        await commitFormsNow(docId);
        bytes = requireDoc(docId).bytes;
      }
      const doc = requireDoc(docId);
      const src = await loadLib(bytes);
      materializeInherited(src);
      const out = await PDFDocument.create({ updateMetadata: false });
      const refs = importPages(out, src, idx);
      rebuildPageTree(out, refs);
      dropDeadDestinations(out);
      const now = new Date();
      const info: Record<string, PDFObject> = {
        Producer: PDFHexString.fromText('PDF Wizard'),
        Creator: PDFHexString.fromText(doc.meta.creator || 'PDF Wizard'),
        CreationDate: PDFString.of(pdfDate(now)),
        ModDate: PDFString.of(pdfDate(now)),
      };
      const title = doc.meta.title || baseName(doc.name);
      if (title) info.Title = PDFHexString.fromText(title);
      if (doc.meta.author) info.Author = PDFHexString.fromText(doc.meta.author);
      (out.context.trailerInfo as { Info?: PDFObject }).Info = out.context.register(out.context.obj(info));
      await out.flush();
      collectGarbage(out);
      return out.save(SAVE_OPTIONS);
    }),
  );
}
