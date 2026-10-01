/**
 * Link annotations: reading the ones already in a PDF (rect, action, border / color / highlight),
 * removing one from a page, and building the dictionary entries for export.
 */
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString,
  type PDFContext, type PDFDocument, type PDFObject,
} from '@cantoo/pdf-lib';
import { arrayOf, dictOf, nameOfObj, numOf, numsOf, resolve, strOf } from './pdfobj';

export type LinkHighlight = 'none' | 'invert' | 'outline' | 'push';
export type LinkLineStyle = 'solid' | 'dashed' | 'underline';

export interface LinkAppearance {
  visible: boolean;
  /** Border width in points (1 thin, 2 medium, 3 thick). */
  width: number;
  style: LinkLineStyle;
  color: string;
  highlight: LinkHighlight;
}

/** Page targets are stored by page index here; the app layer maps them to page ids. */
export type RawLinkAction =
  | { type: 'url'; url: string }
  | { type: 'page'; pageIndex: number; left: number | null; top: number | null; zoom: number | null }
  | { type: 'unsupported'; label: string };

export interface LinkInfo {
  /** `${pageIndex}:${annotIndex}` — valid for one version of the bytes. */
  id: string;
  annotIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  action: RawLinkAction | null;
  appearance: LinkAppearance;
}

export const DEFAULT_LINK_APPEARANCE: LinkAppearance = { visible: false, width: 1, style: 'solid', color: '#1473e6', highlight: 'invert' };

const N = (n: string) => PDFName.of(n);
const H_TO: Record<string, LinkHighlight> = { N: 'none', I: 'invert', O: 'outline', P: 'push' };
const H_FROM: Record<LinkHighlight, string> = { none: 'N', invert: 'I', outline: 'O', push: 'P' };

function colorHex(nums: number[] | undefined): string | null {
  if (!nums || nums.length === 0) return null;
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  if (nums.length === 1) return `#${c(nums[0]).repeat(3)}`;
  if (nums.length === 3) return `#${c(nums[0])}${c(nums[1])}${c(nums[2])}`;
  if (nums.length === 4) {
    const [C, M, Y, K] = nums;
    return `#${c((1 - C) * (1 - K))}${c((1 - M) * (1 - K))}${c((1 - Y) * (1 - K))}`;
  }
  return null;
}

function pageIndexOfRef(lib: PDFDocument, ref: PDFObject | undefined): number {
  if (!(ref instanceof PDFRef)) {
    const n = numOf(lib.context, ref);
    return n !== undefined && Number.isInteger(n) && n >= 0 && n < lib.getPageCount() ? n : -1;
  }
  const pages = lib.getPages();
  return pages.findIndex((p) => p.ref.objectNumber === ref.objectNumber && p.ref.generationNumber === ref.generationNumber);
}

/** Looks a key up in a name tree (/Names /Kids). */
function nameTreeLookup(ctx: PDFContext, node: PDFDict | undefined, key: string, depth = 0): PDFObject | undefined {
  if (!node || depth > 32) return undefined;
  const names = arrayOf(ctx, node.get(N('Names')));
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) if (strOf(ctx, names.get(i)) === key) return resolve(ctx, names.get(i + 1));
  }
  const kids = arrayOf(ctx, node.get(N('Kids')));
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = dictOf(ctx, kids.get(i));
      const limits = kid ? arrayOf(ctx, kid.get(N('Limits'))) : undefined;
      if (limits && limits.size() === 2) {
        const lo = strOf(ctx, limits.get(0)) ?? '';
        const hi = strOf(ctx, limits.get(1)) ?? '';
        if (key < lo || key > hi) continue;
      }
      const hit = nameTreeLookup(ctx, kid, key, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function resolveNamedDest(lib: PDFDocument, name: string): PDFObject | undefined {
  const ctx = lib.context;
  const dests = dictOf(ctx, lib.catalog.get(N('Dests')));
  const direct = dests ? resolve(ctx, dests.get(N(name))) : undefined;
  if (direct) return direct;
  const names = dictOf(ctx, lib.catalog.get(N('Names')));
  return nameTreeLookup(ctx, dictOf(ctx, names?.get(N('Dests'))), name);
}

function destToAction(lib: PDFDocument, dest: PDFObject | undefined, depth = 0): RawLinkAction | null {
  const ctx = lib.context;
  let d = resolve(ctx, dest);
  if (depth > 4) return null;
  if (d instanceof PDFName) d = resolveNamedDest(lib, d.decodeText());
  else if (d instanceof PDFString || d instanceof PDFHexString) d = resolveNamedDest(lib, d.decodeText());
  if (d instanceof PDFDict) return destToAction(lib, d.get(N('D')), depth + 1);
  if (!(d instanceof PDFArray) || d.size() < 1) return null;
  const pageIndex = pageIndexOfRef(lib, d.get(0));
  if (pageIndex < 0) return null;
  const kind = nameOfObj(ctx, d.get(1)) ?? 'Fit';
  const n = (i: number) => {
    const v = resolve(ctx, d instanceof PDFArray ? d.get(i) : undefined);
    return v instanceof PDFNumber ? v.asNumber() : null;
  };
  if (kind === 'XYZ') return { type: 'page', pageIndex, left: n(2), top: n(3), zoom: n(4) || null };
  if (kind === 'FitH' || kind === 'FitBH') return { type: 'page', pageIndex, left: null, top: n(2), zoom: null };
  if (kind === 'FitR') return { type: 'page', pageIndex, left: n(2), top: n(5), zoom: null };
  return { type: 'page', pageIndex, left: null, top: null, zoom: null };
}

function actionOf(lib: PDFDocument, annot: PDFDict): RawLinkAction | null {
  const ctx = lib.context;
  const a = dictOf(ctx, annot.get(N('A')));
  if (a) {
    const s = nameOfObj(ctx, a.get(N('S')));
    if (s === 'URI') {
      const uri = strOf(ctx, a.get(N('URI')));
      return uri !== undefined ? { type: 'url', url: uri } : null;
    }
    if (s === 'GoTo') return destToAction(lib, a.get(N('D')));
    return { type: 'unsupported', label: s ?? 'Unknown' };
  }
  const dest = annot.get(N('Dest'));
  return dest ? destToAction(lib, dest) : null;
}

function appearanceOf(ctx: PDFContext, annot: PDFDict): LinkAppearance {
  const border = arrayOf(ctx, annot.get(N('Border')));
  const bs = dictOf(ctx, annot.get(N('BS')));
  let width = 1;
  const bw = border ? numOf(ctx, border.get(2)) : undefined;
  if (bw !== undefined) width = bw;
  const w = numOf(ctx, bs?.get(N('W')));
  if (w !== undefined) width = w;
  const s = nameOfObj(ctx, bs?.get(N('S')));
  const dashed = s === 'D' || (border ? !!arrayOf(ctx, border.get(3)) : false);
  const style: LinkLineStyle = s === 'U' ? 'underline' : dashed ? 'dashed' : 'solid';
  const color = colorHex(numsOf(ctx, annot.get(N('C'))));
  const highlight = H_TO[nameOfObj(ctx, annot.get(N('H'))) ?? 'I'] ?? 'invert';
  const visible = width > 0 && !!color;
  return {
    visible,
    width: visible ? Math.max(1, Math.min(3, Math.round(width))) : 1,
    style,
    color: color ?? DEFAULT_LINK_APPEARANCE.color,
    highlight,
  };
}

/** All Link annotations of a page. */
export function readLinks(lib: PDFDocument, pageIndex: number): LinkInfo[] {
  const ctx = lib.context;
  const page = lib.getPage(pageIndex);
  const annots = arrayOf(ctx, page.node.get(N('Annots')));
  if (!annots) return [];
  const out: LinkInfo[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const d = dictOf(ctx, annots.get(i));
    if (!d || nameOfObj(ctx, d.get(N('Subtype'))) !== 'Link') continue;
    const r = numsOf(ctx, d.get(N('Rect')));
    if (!r || r.length !== 4) continue;
    const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]);
    const rect = { x: x0, y: y0, width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) };
    if (rect.width <= 0 || rect.height <= 0) continue;
    out.push({ id: `${pageIndex}:${i}`, annotIndex: i, rect, action: actionOf(lib, d), appearance: appearanceOf(ctx, d) });
  }
  return out;
}

/** Removes the link at `annotIndex` (checked against its rect) from the page's /Annots. */
export function removeLink(lib: PDFDocument, pageIndex: number, annotIndex: number, rect: LinkInfo['rect']): boolean {
  const ctx = lib.context;
  const page = lib.getPage(pageIndex);
  const raw = page.node.get(N('Annots'));
  const annots = arrayOf(ctx, raw);
  if (!annots) return false;
  const matches = (i: number) => {
    const d = dictOf(ctx, annots.get(i));
    if (!d || nameOfObj(ctx, d.get(N('Subtype'))) !== 'Link') return false;
    const r = numsOf(ctx, d.get(N('Rect')));
    if (!r || r.length !== 4) return false;
    return Math.abs(Math.min(r[0], r[2]) - rect.x) < 0.01 && Math.abs(Math.min(r[1], r[3]) - rect.y) < 0.01;
  };
  let idx = annotIndex < annots.size() && matches(annotIndex) ? annotIndex : -1;
  if (idx < 0) for (let i = 0; i < annots.size() && idx < 0; i++) if (matches(i)) idx = i;
  if (idx < 0) return false;
  // private copy so an /Annots array shared between pages isn't changed for the others
  const copy = ctx.obj(annots.asArray().filter((_, i) => i !== idx));
  page.node.set(N('Annots'), copy);
  return true;
}

function rgbArray(ctx: PDFContext, hex: string): PDFArray {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  const f = (x: number) => Math.round((x / 255) * 1000) / 1000;
  return ctx.obj([f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)]);
}

export interface ExportLinkTarget {
  /** Page object for GoTo targets. */
  pageRef?: PDFRef;
  url?: string;
  left?: number | null;
  top?: number | null;
  zoom?: number | null;
}

/** Extra annotation entries for a Link (for ExportContext.annots.add `extra`). */
export function linkExtra(ctx: PDFContext, ap: LinkAppearance, target: ExportLinkTarget): Record<string, PDFObject | undefined> {
  const extra: Record<string, PDFObject | undefined> = {};
  if (ap.visible && ap.width > 0) {
    const w = ap.width;
    extra.Border = ap.style === 'dashed' ? ctx.obj([0, 0, w, [3, 2]]) : ctx.obj([0, 0, w]);
    const bs = ctx.obj({ Type: 'Border', W: w, S: ap.style === 'dashed' ? 'D' : ap.style === 'underline' ? 'U' : 'S' }) as PDFDict;
    if (ap.style === 'dashed') bs.set(N('D'), ctx.obj([3, 2]));
    extra.BS = bs;
    extra.C = rgbArray(ctx, ap.color);
  } else {
    extra.Border = ctx.obj([0, 0, 0]);
    extra.BS = undefined;
    extra.C = undefined;
  }
  extra.H = N(H_FROM[ap.highlight] ?? 'I');
  if (target.url !== undefined) {
    extra.A = ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(target.url) });
    extra.Dest = undefined;
  } else if (target.pageRef) {
    const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? PDFNull : PDFNumber.of(Math.round(v * 100) / 100));
    extra.Dest = ctx.obj([target.pageRef, N('XYZ'), num(target.left), num(target.top), num(target.zoom)]);
    extra.A = undefined;
  }
  return extra;
}
