/**
 * pdf-lib (@cantoo fork) helpers shared by page operations and export:
 * loading, page geometry that mirrors pdf.js, page labels, garbage collection, page-tree
 * rebuilding, deep cloning of direct objects, AcroForm pruning and cross-document page import.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject,
  PDFObjectCopier, PDFPageLeaf, PDFRef, PDFStream, PDFString, type PDFContext,
} from '@cantoo/pdf-lib';
import type { LibDocument, PageInfo, Rotation } from '../types';

export const N = (name: string) => PDFName.of(name);

/** @cantoo/pdf-lib load (ignoreEncryption:false, updateMetadata:false). Throws EncryptedPDFError for encrypted files. */
export async function loadLib(bytes: Uint8Array): Promise<LibDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
}

export function isEncryptedError(e: unknown): boolean {
  return !!e && typeof e === 'object' && ((e as Error).name === 'EncryptedPDFError' || /is encrypted/i.test((e as Error).message ?? ''));
}

/** Save options used for every byte edit: never add pages, never regenerate field appearances. */
export const SAVE_OPTIONS = { useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false } as const;

// ── small object helpers ─────────────────────────────────────────────────────

export function lookup(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  if (o instanceof PDFRef) return ctx.lookup(o);
  return o;
}
export function lookupDict(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = lookup(ctx, o);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}
export function lookupArray(ctx: PDFContext, o: PDFObject | undefined): PDFArray | undefined {
  const v = lookup(ctx, o);
  return v instanceof PDFArray ? v : undefined;
}
export function numberOf(ctx: PDFContext, o: PDFObject | undefined): number | undefined {
  const v = lookup(ctx, o);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}
export function nameOf(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = lookup(ctx, o);
  return v instanceof PDFName ? v.decodeText() : undefined;
}
export function textOf(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = lookup(ctx, o);
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}
export function numbersOf(ctx: PDFContext, o: PDFObject | undefined): number[] | undefined {
  const a = lookupArray(ctx, o);
  if (!a) return undefined;
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const n = numberOf(ctx, a.get(i));
    if (n === undefined || !Number.isFinite(n)) return undefined;
    out.push(n);
  }
  return out;
}

/** Deep copy of direct objects (dicts/arrays); indirect references are kept as-is. */
export function cloneDirect<T extends PDFObject>(obj: T, ctx: PDFContext): T {
  if (obj instanceof PDFPageLeaf) {
    const leaf = PDFPageLeaf.fromMapWithContext(new Map(), ctx);
    for (const [k, v] of obj.entries()) leaf.set(k, cloneDirect(v, ctx));
    return leaf as unknown as T;
  }
  if (obj instanceof PDFDict) {
    const d = PDFDict.withContext(ctx);
    for (const [k, v] of obj.entries()) d.set(k, cloneDirect(v, ctx));
    return d as unknown as T;
  }
  if (obj instanceof PDFArray) {
    const a = PDFArray.withContext(ctx);
    for (let i = 0; i < obj.size(); i++) a.push(cloneDirect(obj.get(i), ctx));
    return a as unknown as T;
  }
  if (obj instanceof PDFStream) return obj.clone(ctx) as unknown as T;
  return obj;
}

/** Visit every value reachable *directly* inside `obj` (not following refs). Return a replacement to substitute. */
export function mapDirect(obj: PDFObject, fn: (v: PDFObject) => PDFObject | undefined): void {
  if (obj instanceof PDFDict || obj instanceof PDFStream) {
    const d = obj instanceof PDFStream ? obj.dict : obj;
    for (const [k, v] of d.entries()) {
      const r = fn(v);
      if (r !== undefined && r !== v) d.set(k, r);
      else mapDirect(v, fn);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      const r = fn(v);
      if (r !== undefined && r !== v) obj.set(i, r);
      else mapDirect(v, fn);
    }
  }
}

// ── dates ────────────────────────────────────────────────────────────────────

const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, '0');
/** PDF date string D:YYYYMMDDHHmmSS+HH'mm' in local time. */
export function pdfDate(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off > 0 ? '+' : off < 0 ? '-' : 'Z';
  const tz = off === 0 ? 'Z' : `${sign}${pad(off / 60)}'${pad(off % 60)}'`;
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${tz}`;
}

/** Parse a PDF date string (D:YYYYMMDDHHmmSSOHH'mm') into an ISO string. */
export function parsePdfDate(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(s.trim());
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', o, oh = '00', om = '00'] = m;
  let t = Date.UTC(+y, Math.max(0, +mo - 1), Math.max(1, +d), +h, +mi, +se);
  if (o === '+' || o === '-') {
    const off = (+oh * 60 + +om) * 60_000;
    t += o === '+' ? -off : off;
  } else if (!o) {
    // No zone: treat as local time.
    t = new Date(+y, Math.max(0, +mo - 1), Math.max(1, +d), +h, +mi, +se).getTime();
  }
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// ── page geometry (mirrors pdf.js Page.view / Page.rotate) ───────────────────

const LETTER: [number, number, number, number] = [0, 0, 612, 792];

function normBox(b: number[] | undefined): [number, number, number, number] | undefined {
  if (!b || b.length !== 4) return undefined;
  const r: [number, number, number, number] = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  return r[2] - r[0] > 0 && r[3] - r[1] > 0 ? r : undefined;
}

export function inheritable(leaf: PDFPageLeaf, key: string): PDFObject | undefined {
  return leaf.getInheritableAttribute(N(key));
}

export function mediaBoxOf(leaf: PDFPageLeaf): [number, number, number, number] {
  return normBox(numbersOf(leaf.context, inheritable(leaf, 'MediaBox'))) ?? LETTER;
}

/** Visible box = CropBox ∩ MediaBox (falls back to MediaBox), like pdf.js `page.view`. */
export function viewBoxOf(leaf: PDFPageLeaf): [number, number, number, number] {
  const media = mediaBoxOf(leaf);
  const crop = normBox(numbersOf(leaf.context, inheritable(leaf, 'CropBox')));
  if (!crop) return media;
  const x0 = Math.max(crop[0], media[0]);
  const y0 = Math.max(crop[1], media[1]);
  const x1 = Math.min(crop[2], media[2]);
  const y1 = Math.min(crop[3], media[3]);
  return x1 - x0 > 0 && y1 - y0 > 0 ? [x0, y0, x1, y1] : media;
}

export function normalizeRotation(r: number | undefined | null): Rotation {
  let v = Number(r) || 0;
  if (v % 90 !== 0) return 0;
  v = ((v % 360) + 360) % 360;
  return v as Rotation;
}

export function rotationOf(leaf: PDFPageLeaf): Rotation {
  return normalizeRotation(numberOf(leaf.context, inheritable(leaf, 'Rotate')));
}

export function leafInfo(leaf: PDFPageLeaf, id: string, label?: string): PageInfo {
  const view = viewBoxOf(leaf);
  const info: PageInfo = { id, view, width: view[2] - view[0], height: view[3] - view[1], rotation: rotationOf(leaf) };
  if (label !== undefined) info.label = label;
  return info;
}

/** Leaves of the document in page order (with refs). */
export function leavesOf(lib: LibDocument): { leaf: PDFPageLeaf; ref: PDFRef }[] {
  const out: { leaf: PDFPageLeaf; ref: PDFRef }[] = [];
  lib.catalog.Pages().traverse((node, ref) => {
    if (node instanceof PDFPageLeaf) out.push({ leaf: node, ref });
  });
  return out;
}

/** PageInfo for every page of `lib`, keeping `ids` by index (new ids for extra pages come from `mkId`). */
export function libPageInfo(lib: LibDocument, ids: string[], mkId: () => string): PageInfo[] {
  const labels = readLabels(lib);
  return leavesOf(lib).map(({ leaf }, i) => leafInfo(leaf, ids[i] ?? mkId(), labels?.[i]));
}

// ── page labels ──────────────────────────────────────────────────────────────

interface LabelRange { start: number; style?: string; prefix?: string; st: number }

function readNumberTree(ctx: PDFContext, node: PDFDict | undefined, out: [number, PDFObject][], depth = 0) {
  if (!node || depth > 32) return;
  const nums = lookupArray(ctx, node.get(N('Nums')));
  if (nums) for (let i = 0; i + 1 < nums.size(); i += 2) {
    const k = numberOf(ctx, nums.get(i));
    if (k !== undefined) out.push([k, nums.get(i + 1)]);
  }
  const kids = lookupArray(ctx, node.get(N('Kids')));
  if (kids) for (let i = 0; i < kids.size(); i++) readNumberTree(ctx, lookupDict(ctx, kids.get(i)), out, depth + 1);
}

function readLabelRanges(lib: LibDocument): LabelRange[] | null {
  const ctx = lib.context;
  const tree = lookupDict(ctx, lib.catalog.get(N('PageLabels')));
  if (!tree) return null;
  const entries: [number, PDFObject][] = [];
  readNumberTree(ctx, tree, entries);
  if (!entries.length) return null;
  entries.sort((a, b) => a[0] - b[0]);
  return entries.map(([start, v]) => {
    const d = lookupDict(ctx, v);
    const st = d ? numberOf(ctx, d.get(N('St'))) : undefined;
    return {
      start,
      style: d ? nameOf(ctx, d.get(N('S'))) : undefined,
      prefix: d ? textOf(ctx, d.get(N('P'))) : undefined,
      st: st !== undefined && st >= 1 ? Math.trunc(st) : 1,
    };
  });
}

function toRoman(n: number, lower: boolean): string {
  const map: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  let v = n;
  for (const [k, r] of map) while (v >= k) { s += r; v -= k; }
  return lower ? s.toLowerCase() : s;
}

function formatLabel(r: LabelRange, n: number): string {
  let num = '';
  switch (r.style) {
    case 'D': num = String(n); break;
    case 'R': num = toRoman(n, false); break;
    case 'r': num = toRoman(n, true); break;
    case 'A':
    case 'a': {
      const ch = String.fromCharCode(65 + ((n - 1) % 26));
      num = ch.repeat(Math.floor((n - 1) / 26) + 1);
      if (r.style === 'a') num = num.toLowerCase();
      break;
    }
    default: num = '';
  }
  return (r.prefix ?? '') + num;
}

/** Page labels like pdf.js getPageLabels() (null when the document has none). */
export function readLabels(lib: LibDocument): string[] | null {
  const ranges = readLabelRanges(lib);
  if (!ranges) return null;
  const count = lib.getPageCount();
  const out: string[] = [];
  let ri = -1;
  for (let i = 0; i < count; i++) {
    while (ri + 1 < ranges.length && ranges[ri + 1].start <= i) ri++;
    if (ri < 0) { out.push(String(i + 1)); continue; }
    const r = ranges[ri];
    out.push(formatLabel(r, r.st + (i - r.start)));
  }
  return out;
}

/**
 * Rewrite /PageLabels after a structural change. `origin[i]` is the old index of the page now at
 * position i, or null for inserted pages (which join the preceding page's range).
 */
export function remapLabels(lib: LibDocument, origin: (number | null)[]) {
  const ranges = readLabelRanges(lib);
  if (!ranges) return;
  const rangeOfOld = (idx: number) => {
    let r = -1;
    for (let k = 0; k < ranges.length; k++) if (ranges[k].start <= idx) r = k;
    return Math.max(0, r);
  };
  const assigned: number[] = [];
  for (let i = 0; i < origin.length; i++) {
    const o = origin[i];
    if (o !== null) assigned.push(rangeOfOld(o));
    else assigned.push(i > 0 ? assigned[i - 1] : -1);
  }
  // Leading inserted pages join the first real range.
  const firstReal = assigned.find((a) => a >= 0) ?? 0;
  for (let i = 0; i < assigned.length && assigned[i] < 0; i++) assigned[i] = firstReal;
  const seen = new Map<number, number>();
  const nums: PDFObject[] = [];
  const ctx = lib.context;
  for (let i = 0; i < assigned.length; i++) {
    const rIdx = assigned[i];
    if (i > 0 && assigned[i - 1] === rIdx) continue;
    let runLen = 1;
    while (i + runLen < assigned.length && assigned[i + runLen] === rIdx) runLen++;
    const r = ranges[rIdx];
    const used = seen.get(rIdx) ?? 0;
    seen.set(rIdx, used + runLen);
    const d: Record<string, PDFObject> = {};
    if (r.style) d.S = N(r.style);
    if (r.prefix) d.P = PDFHexString.fromText(r.prefix);
    const st = r.st + used;
    if (st !== 1) d.St = PDFNumber.of(st);
    nums.push(PDFNumber.of(i), ctx.obj(d));
  }
  if (!nums.length) {
    lib.catalog.delete(N('PageLabels'));
    return;
  }
  lib.catalog.set(N('PageLabels'), ctx.obj({ Nums: nums }));
}

// ── page tree ────────────────────────────────────────────────────────────────

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

/** Copy inherited Resources/MediaBox/CropBox/Rotate onto every leaf so the tree can be restructured. */
export function materializeInherited(lib: LibDocument) {
  for (const { leaf } of leavesOf(lib)) {
    for (const k of INHERITABLE) {
      if (leaf.get(N(k)) !== undefined) continue;
      const v = inheritable(leaf, k);
      if (v !== undefined) leaf.set(N(k), v);
    }
    if (leaf.get(N('MediaBox')) === undefined) leaf.set(N('MediaBox'), lib.context.obj([...LETTER]));
  }
}

/** Replace the page tree with a flat root whose Kids are `refs` (materializeInherited first!). */
export function rebuildPageTree(lib: LibDocument, refs: PDFRef[]) {
  const ctx = lib.context;
  const rootRef = lib.catalog.get(N('Pages'));
  if (!(rootRef instanceof PDFRef)) throw new Error('The PDF page tree is damaged.');
  const root = ctx.lookup(rootRef, PDFDict);
  const intermediate: PDFRef[] = [];
  const walk = (node: PDFDict, depth: number) => {
    const kids = lookupArray(ctx, node.get(N('Kids')));
    if (!kids || depth > 64) return;
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.get(i);
      const kd = lookupDict(ctx, k);
      if (k instanceof PDFRef && kd && nameOf(ctx, kd.get(N('Type'))) === 'Pages' && k !== rootRef) {
        intermediate.push(k);
        walk(kd, depth + 1);
      }
    }
  };
  walk(root, 0);
  for (const ref of refs) {
    const leaf = ctx.lookup(ref);
    if (leaf instanceof PDFDict) leaf.set(N('Parent'), rootRef);
  }
  root.set(N('Kids'), ctx.obj(refs));
  root.set(N('Count'), PDFNumber.of(refs.length));
  for (const k of INHERITABLE) root.delete(N(k));
  for (const r of intermediate) ctx.delete(r);
  const anyLib = lib as unknown as { pageCount?: number; pageCache: { invalidate(): void } };
  anyLib.pageCount = refs.length;
  anyLib.pageCache.invalidate();
}

// ── garbage collection ───────────────────────────────────────────────────────

/** Delete every indirect object not reachable from the trailer (Root / Info / Encrypt). Call after flush(). */
export function collectGarbage(lib: LibDocument) {
  const ctx = lib.context;
  const seen = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo as { Root?: PDFObject; Info?: PDFObject; Encrypt?: PDFObject };
  for (const o of [t.Root, t.Info, t.Encrypt]) if (o) stack.push(o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o)) continue;
      seen.add(o);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const v of o.values()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      for (const v of o.dict.values()) stack.push(v);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref)) ctx.delete(ref);
}

// ── annotations & forms ──────────────────────────────────────────────────────

export function annotRefsOf(leaf: PDFPageLeaf): PDFObject[] {
  const a = lookupArray(leaf.context, leaf.get(N('Annots')));
  if (!a) return [];
  const out: PDFObject[] = [];
  for (let i = 0; i < a.size(); i++) out.push(a.get(i));
  return out;
}

const FIELD_KEYS = ['FT', 'T', 'TU', 'TM', 'Ff', 'V', 'DV', 'Opt', 'TI', 'I', 'MaxLen', 'RV', 'DS', 'Lock', 'SV', 'Parent', 'AA', 'Kids'];

export function isWidget(ctx: PDFContext, d: PDFDict | undefined) {
  return !!d && nameOf(ctx, d.get(N('Subtype'))) === 'Widget';
}

/**
 * Remove widgets not in `keep` (and fields left without widgets) from the field tree rooted at
 * `fieldRef`. Returns false when the whole field should be removed.
 */
export function pruneField(ctx: PDFContext, fieldRef: PDFObject, keep: (ref: PDFObject) => boolean, depth = 0): boolean {
  const field = lookupDict(ctx, fieldRef);
  if (!field || depth > 32) return false;
  const kids = lookupArray(ctx, field.get(N('Kids')));
  if (!kids) {
    // Terminal field merged with its single widget (or a bare widget).
    return isWidget(ctx, field) ? keep(fieldRef) : true;
  }
  const next: PDFObject[] = [];
  for (let i = 0; i < kids.size(); i++) {
    const k = kids.get(i);
    const kd = lookupDict(ctx, k);
    if (!kd) continue;
    const kidIsWidgetOnly = isWidget(ctx, kd) && kd.get(N('T')) === undefined && lookupArray(ctx, kd.get(N('Kids'))) === undefined;
    if (kidIsWidgetOnly ? keep(k) : pruneField(ctx, k, keep, depth + 1)) next.push(k);
  }
  if (next.length === kids.size()) return true;
  if (next.length === 0) return false;
  field.set(N('Kids'), ctx.obj(next));
  return true;
}

/** Prune the AcroForm (Fields tree and /CO) so only widgets accepted by `keep` remain. */
export function pruneAcroForm(lib: LibDocument, keep: (ref: PDFObject) => boolean) {
  const ctx = lib.context;
  const acro = lookupDict(ctx, lib.catalog.get(N('AcroForm')));
  if (!acro) return;
  const fields = lookupArray(ctx, acro.get(N('Fields')));
  if (!fields) return;
  const next: PDFObject[] = [];
  for (let i = 0; i < fields.size(); i++) if (pruneField(ctx, fields.get(i), keep)) next.push(fields.get(i));
  if (next.length !== fields.size()) acro.set(N('Fields'), ctx.obj(next));
  const alive = new Set<PDFObject>();
  const mark = (r: PDFObject, depth = 0) => {
    if (depth > 32) return;
    alive.add(r);
    const d = lookupDict(ctx, r);
    const kids = d && lookupArray(ctx, d.get(N('Kids')));
    if (kids) for (let i = 0; i < kids.size(); i++) mark(kids.get(i), depth + 1);
  };
  next.forEach((r) => mark(r));
  const co = lookupArray(ctx, acro.get(N('CO')));
  if (co) {
    const kept: PDFObject[] = [];
    for (let i = 0; i < co.size(); i++) if (alive.has(co.get(i))) kept.push(co.get(i));
    if (kept.length !== co.size()) acro.set(N('CO'), ctx.obj(kept));
  }
}

/**
 * A widget that is merged with its field (has /T or /FT and no /Parent) can't get a second widget
 * directly. Split it into a parent field + child widget and return the parent ref.
 */
export function splitMergedField(lib: LibDocument, widgetRef: PDFRef): PDFRef {
  const ctx = lib.context;
  const w = ctx.lookup(widgetRef, PDFDict);
  const parent = ctx.obj({}) as PDFDict;
  for (const k of FIELD_KEYS) {
    const v = w.get(N(k));
    if (v === undefined || k === 'Kids') continue;
    parent.set(N(k), v);
    w.delete(N(k));
  }
  // Keep appearance-related defaults on both (DA / Q are allowed on widgets and fields).
  for (const k of ['DA', 'Q']) {
    const v = w.get(N(k));
    if (v !== undefined) parent.set(N(k), v);
  }
  const parentRef = ctx.register(parent);
  parent.set(N('Kids'), ctx.obj([widgetRef]));
  w.set(N('Parent'), parentRef);
  // The old parent's Kids / the AcroForm Fields pointed at the widget: point them to the new parent.
  const grand = lookupDict(ctx, parent.get(N('Parent')));
  const replaceIn = (arr: PDFArray | undefined) => {
    if (!arr) return;
    for (let i = 0; i < arr.size(); i++) if (arr.get(i) === widgetRef) arr.set(i, parentRef);
  };
  if (grand) replaceIn(lookupArray(ctx, grand.get(N('Kids'))));
  const acro = lookupDict(ctx, lib.catalog.get(N('AcroForm')));
  if (acro) {
    replaceIn(lookupArray(ctx, acro.get(N('Fields'))));
    replaceIn(lookupArray(ctx, acro.get(N('CO'))));
  }
  return parentRef;
}

/** Root field (no /Parent) of a widget/field. */
export function rootFieldOf(ctx: PDFContext, ref: PDFObject): PDFObject {
  let cur = ref;
  for (let i = 0; i < 32; i++) {
    const d = lookupDict(ctx, cur);
    const p = d?.get(N('Parent'));
    if (!p || !lookupDict(ctx, p)) return cur;
    cur = p;
  }
  return cur;
}

// ── importing pages from another document ────────────────────────────────────

/**
 * Copy pages `indices` of `src` into `dest`'s context (not inserted into the tree). Page refs are
 * pre-mapped so /P and /Dest references point at the copies; pages that aren't copied and page-tree
 * nodes become null. Form fields of copied widgets are added to dest's AcroForm (pruned to the
 * copied widgets). Returns the new leaf refs in `indices` order.
 */
export function importPages(dest: LibDocument, src: LibDocument, indices: number[], opts: { forms?: boolean } = {}): PDFRef[] {
  const ctx = dest.context;
  const srcCtx = src.context;
  const srcLeaves = leavesOf(src);
  for (const i of indices) if (i < 0 || i >= srcLeaves.length) throw new Error(`Page ${i + 1} doesn't exist in the source document.`);
  const treeNodes: PDFRef[] = [];
  src.catalog.Pages().traverse((node, ref) => {
    if (!(node instanceof PDFPageLeaf)) treeNodes.push(ref);
  });
  const out: PDFRef[] = new Array(indices.length);
  const usedTimes = new Map<number, number>();
  // Group indices into batches without repeats: each batch shares a copier (shared fonts/images are copied once).
  const batches: number[][] = [];
  indices.forEach((srcIdx, pos) => {
    const n = usedTimes.get(srcIdx) ?? 0;
    usedTimes.set(srcIdx, n + 1);
    (batches[n] ??= []).push(pos);
  });
  const copiedWidgetRoots: PDFObject[] = [];
  const copiedWidgets = new Set<PDFObject>();
  for (const batch of batches) {
    const copier = PDFObjectCopier.for(srcCtx, ctx);
    // traversedObjects is private in the typings; pre-seeding it is how page refs get remapped.
    const tr = (copier as unknown as { traversedObjects: Map<PDFObject, PDFObject> }).traversedObjects;
    for (const r of treeNodes) tr.set(r, PDFNull);
    const inBatch = new Map<number, PDFRef>();
    for (const pos of batch) inBatch.set(indices[pos], ctx.nextRef());
    srcLeaves.forEach(({ ref }, i) => tr.set(ref, inBatch.get(i) ?? PDFNull));
    for (const pos of batch) {
      const srcIdx = indices[pos];
      const { leaf } = srcLeaves[srcIdx];
      const copy = copier.copy(leaf) as PDFPageLeaf;
      copy.delete(N('StructParents'));
      copy.delete(N('B'));
      copy.delete(N('Parent'));
      const newRef = inBatch.get(srcIdx)!;
      ctx.assign(newRef, copy);
      out[pos] = newRef;
      for (const a of annotRefsOf(copy)) {
        const ad = lookupDict(ctx, a);
        if (!ad) continue;
        ad.delete(N('StructParent'));
        if (ad.get(N('P')) !== undefined) ad.set(N('P'), newRef);
        if (isWidget(ctx, ad)) {
          copiedWidgets.add(a);
          copiedWidgetRoots.push(rootFieldOf(ctx, a));
        }
      }
    }
  }
  if (opts.forms !== false && copiedWidgetRoots.length) {
    const roots = [...new Set(copiedWidgetRoots)];
    const kept = roots.filter((r) => pruneField(ctx, r, (w) => copiedWidgets.has(w)));
    const acro = dest.catalog.getOrCreateAcroForm().dict;
    const fields = lookupArray(ctx, acro.get(N('Fields'))) ?? (() => {
      const a = ctx.obj([]) as PDFArray;
      acro.set(N('Fields'), a);
      return a;
    })();
    for (const r of kept) fields.push(r);
    const srcAcro = lookupDict(srcCtx, src.catalog.get(N('AcroForm')));
    if (srcAcro) mergeFormDefaults(dest, src, srcAcro, acro);
  }
  return out;
}

function mergeFormDefaults(dest: LibDocument, src: LibDocument, srcAcro: PDFDict, acro: PDFDict) {
  const ctx = dest.context;
  const copier = PDFObjectCopier.for(src.context, ctx);
  const srcDR = lookupDict(src.context, srcAcro.get(N('DR')));
  if (srcDR) {
    let dr = lookupDict(ctx, acro.get(N('DR')));
    if (!dr) {
      dr = ctx.obj({}) as PDFDict;
      acro.set(N('DR'), dr);
    }
    const srcFonts = lookupDict(src.context, srcDR.get(N('Font')));
    if (srcFonts) {
      let fonts = lookupDict(ctx, dr.get(N('Font')));
      if (!fonts) {
        fonts = ctx.obj({}) as PDFDict;
        dr.set(N('Font'), fonts);
      }
      for (const [k, v] of srcFonts.entries()) if (!fonts.has(k)) fonts.set(k, copier.copy(v));
    }
  }
  if (acro.get(N('DA')) === undefined && srcAcro.get(N('DA')) !== undefined) acro.set(N('DA'), copier.copy(srcAcro.get(N('DA'))!));
  if (srcAcro.get(N('NeedAppearances')) !== undefined && acro.get(N('NeedAppearances')) === undefined) {
    acro.set(N('NeedAppearances'), copier.copy(srcAcro.get(N('NeedAppearances'))!));
  }
}

/** Replace every reference to one of `refs` anywhere in the document with null. */
export function nullifyRefs(lib: LibDocument, refs: Set<PDFRef>) {
  const ctx = lib.context;
  const fn = (v: PDFObject) => (v instanceof PDFRef && refs.has(v) ? PDFNull : undefined);
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (refs.has(ref)) continue;
    mapDirect(obj, fn as (v: PDFObject) => PDFObject | undefined);
  }
  mapDirect(lib.catalog, fn as (v: PDFObject) => PDFObject | undefined);
}

/** True when `dest` is an explicit destination array whose page is gone (null / missing / not a page dict). */
function isDeadExplicitDest(ctx: PDFContext, dest: PDFObject | undefined): boolean {
  const arr = lookupArray(ctx, dest);
  if (!arr) return false;
  if (arr.size() === 0) return true;
  const target = arr.get(0);
  if (target instanceof PDFNumber) return false; // page number (remote-style) destinations are left alone
  if (target === PDFNull || target === undefined) return true;
  const page = lookupDict(ctx, target);
  return !page || nameOf(ctx, page.get(N('Type'))) !== 'Page';
}

/** Strip dead GoTo targets from a link annotation / outline item dict. Returns true when it has no target left. */
function stripDeadTarget(ctx: PDFContext, d: PDFDict): boolean {
  if (isDeadExplicitDest(ctx, d.get(N('Dest')))) d.delete(N('Dest'));
  const action = lookupDict(ctx, d.get(N('A')));
  if (action && nameOf(ctx, action.get(N('S'))) === 'GoTo' && isDeadExplicitDest(ctx, action.get(N('D')))) d.delete(N('A'));
  return d.get(N('Dest')) === undefined && d.get(N('A')) === undefined;
}

/**
 * After pages were removed (or only some pages were imported), internal links and bookmarks can point
 * at a null page. Remove such link annotations entirely and drop the dead target from outline items,
 * so viewers don't report "bad annotation destination" and links don't jump nowhere.
 */
export function dropDeadDestinations(lib: LibDocument) {
  const ctx = lib.context;
  for (const { leaf } of leavesOf(lib)) {
    const annots = lookupArray(ctx, leaf.get(N('Annots')));
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.get(i);
      const d = lookupDict(ctx, a);
      if (!d) {
        if (a === PDFNull) annots.remove(i);
        continue;
      }
      if (nameOf(ctx, d.get(N('Subtype'))) !== 'Link') continue;
      if (stripDeadTarget(ctx, d)) annots.remove(i); // the orphaned dict is garbage-collected on save
    }
  }
  const outlines = lookupDict(ctx, lib.catalog.get(N('Outlines')));
  const seen = new Set<PDFDict>();
  const walk = (first: PDFObject | undefined, depth: number) => {
    let cur = lookupDict(ctx, first);
    while (cur && !seen.has(cur) && depth < 64) {
      seen.add(cur);
      stripDeadTarget(ctx, cur);
      walk(cur.get(N('First')), depth + 1);
      cur = lookupDict(ctx, cur.get(N('Next')));
    }
  };
  if (outlines) walk(outlines.get(N('First')), 0);
}
