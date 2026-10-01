/**
 * Document changes made by Edit PDF. Base-content edits run as one undoable engine.withLib step each;
 * added content (text boxes, images, links) are overlay objects. Failures become toasts.
 */
import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib';
import { isReadOnly, withLib } from '@/core/engine';
import { actions, getDoc, newObject } from '@/core/store';
import type { DocId, ExportContext, ObjectId, Rect } from '@/core/types';
import { mul, quadBounds, unitQuad, type Matrix } from './content/matrix';
import { analysePage, arrangeImage, clipForRect, deleteImage, EditError, moveBlock, replaceBlock, replaceImage, transformImage, type CustomFontLoader, type ImageInfo } from './content/ops';
import { removeLink, type LinkInfo } from './content/links';
import type { TextBlock } from './content/blocks';
import { pageModel, type PageModel } from './analysis';
import { ui, type Target } from './state';
import { uprightImageMatrix } from './viewmath';
import { loadImageFile } from './images';
import { KIND_IMAGE, KIND_LINK, KIND_TEXT, type ContentImageObject, type LinkData, type LinkObject } from './model';
import { embedSubsetFont, fontkit } from './fontkit';
import { encodeWinAnsi, stdFontFor, type Family } from './content/fonts';
import { assetUrl } from '@/core/util';

// ── fonts for characters outside WinAnsi ─────────────────────────────────────

type Variant = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';
const variantOf = (s: { bold: boolean; italic: boolean }): Variant => (s.bold && s.italic ? 'BoldItalic' : s.bold ? 'Bold' : s.italic ? 'Italic' : 'Regular');
const fontBytes = new Map<Variant, Promise<ArrayBuffer>>();

function fetchFont(v: Variant): Promise<ArrayBuffer> {
  let p = fontBytes.get(v);
  if (!p) {
    p = fetch(assetUrl(`pdfjs/standard_fonts/LiberationSans-${v}.ttf`)).then((r) => {
      if (!r.ok) throw new EditError(`The font for these characters couldn’t be loaded (${r.status}).`);
      return r.arrayBuffer();
    });
    p.catch(() => fontBytes.delete(v));
    fontBytes.set(v, p);
  }
  return p;
}

/** Liberation Sans fonts embedded per document (one subset per variant). */
const embeddedFonts = new WeakMap<PDFDocument, Map<Variant, Promise<PDFFont>>>();

/** Custom font loader for a pdf-lib document (subset-embedded Liberation Sans). */
export function libFontLoader(lib: PDFDocument): CustomFontLoader {
  let embedded = embeddedFonts.get(lib);
  if (!embedded) {
    embedded = new Map();
    embeddedFonts.set(lib, embedded);
  }
  const fonts = embedded;
  return (style) => {
    const v = variantOf(style);
    let p = fonts.get(v);
    if (!p) {
      p = fetchFont(v).then((b) => embedSubsetFont(lib, b));
      p.catch(() => fonts.delete(v));
      fonts.set(v, p);
    }
    return p;
  };
}

interface GlyphCoverage {
  hasGlyphForCodePoint(cp: number): boolean;
}
const faces = new Map<Variant, Promise<GlyphCoverage>>();

/**
 * Characters of `text` that no font Edit PDF can write has: neither the standard font of the style
 * (WinAnsi) nor the embedded Unicode font (e.g. CJK, emoji). They are left out of the PDF.
 */
export async function unsupportedChars(text: string, style: { family: Family; bold: boolean; italic: boolean }): Promise<string[]> {
  const std = stdFontFor(style.family, style.bold, style.italic);
  const odd = [...new Set(text)].filter((ch) => ch !== '\n' && ch !== ' ' && !encodeWinAnsi(ch, std));
  if (!odd.length) return [];
  const v = variantOf(style);
  let face = faces.get(v);
  if (!face) {
    face = fetchFont(v).then((b) => fontkit.create(new Uint8Array(b)) as unknown as GlyphCoverage);
    face.catch(() => faces.delete(v));
    faces.set(v, face);
  }
  try {
    const f = await face;
    return odd.filter((ch) => !f.hasGlyphForCodePoint(ch.codePointAt(0)!));
  } catch {
    return [];
  }
}

/** Warning toast about characters that were (or will be) left out of the PDF. */
export function warnMissingChars(chars: string[]): void {
  if (!chars.length) return;
  const list = chars.slice(0, 12).join(' ') + (chars.length > 12 ? ' …' : '');
  actions.toast(`No available font has these characters, so they are left out of the PDF: ${list}`, { kind: 'warning' });
}

/**
 * Custom font loader for the export pipeline. Embeds into the export document directly (not via
 * ctx.customFont, whose TrueType subsets fail to serialize with the registered fontkit).
 */
export function exportFontLoader(ctx: ExportContext): CustomFontLoader {
  return libFontLoader(ctx.pdfDoc);
}

// ── running byte edits ───────────────────────────────────────────────────────

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** True (with a toast) when the document can't be edited. */
export function readOnlyNotice(docId: DocId): boolean {
  if (!isReadOnly(docId)) return false;
  actions.toast('This document is read-only, so its content can’t be edited.', { kind: 'warning' });
  return true;
}

let pending = 0;

/**
 * Runs one undoable byte edit. Edits go through the engine's per-document queue (so they never
 * interleave with each other, saving or exporting, and run in the order they were started).
 * Resolves true on success; failures are reported as toasts.
 */
export async function runEdit(docId: DocId, label: string, fn: (lib: PDFDocument) => Promise<void> | void): Promise<boolean> {
  if (readOnlyNotice(docId)) return false;
  if (!getDoc(docId)) return false;
  pending++;
  ui.setWorking(true);
  try {
    await withLib(docId, label, async (lib) => {
      await fn(lib);
    });
    return true;
  } catch (e) {
    if (!(e instanceof EditError)) console.warn('[edit-pdf]', label, e);
    actions.toast(errText(e), { kind: 'error' });
    return false;
  } finally {
    pending--;
    if (!pending) ui.setWorking(false);
  }
}

/** Id of a block in `lib` — by id and text, else the block with the same text nearest to `bounds`. */
export function resolveBlockId(lib: PDFDocument, pageIndex: number, id: string, text: string, bounds?: Rect): string {
  const an = analysePage(lib, pageIndex);
  if (an.blocks.some((b) => b.id === id && b.text === text)) return id;
  const near = nearest(an.blocks.filter((b) => b.text === text), (b) => b.bounds, bounds);
  if (!near) throw new EditError('The text changed on the page. Select it again.');
  return near.id;
}

/** Id of an image in `lib` — by id, else the image with the same resource name nearest to `bounds`. */
export function resolveImageId(lib: PDFDocument, pageIndex: number, id: string, name?: string, bounds?: Rect): string {
  const an = analysePage(lib, pageIndex);
  const hit = an.images.find((x) => x.id === id);
  if (hit && (!name || hit.name === name)) return id;
  const near = nearest(an.images.filter((x) => !name || x.name === name), (x) => x.bounds, bounds);
  if (!near) throw new EditError('The image changed on the page. Select it again.');
  return near.id;
}

function nearest<T>(items: T[], rect: (t: T) => Rect, to?: Rect, tol = 3): T | null {
  if (!to) return items.length === 1 ? items[0] : null;
  let best: T | null = null;
  let bestD = Infinity;
  for (const it of items) {
    const r = rect(it);
    const d = Math.abs(r.x - to.x) + Math.abs(r.y - to.y) + Math.abs(r.width - to.width) + Math.abs(r.height - to.height);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return bestD <= tol * 4 ? best : null;
}

export function undoToast(message: string, docId: DocId) {
  actions.toast(message, { kind: 'success', action: { label: 'Undo', run: () => actions.undo(docId) } });
}

/** Page model for the document's current bytes (null when unavailable). */
export async function currentModel(docId: DocId, pageIndex: number): Promise<PageModel | null> {
  const doc = getDoc(docId);
  if (!doc) return null;
  try {
    return await pageModel(docId, doc.bytes, pageIndex);
  } catch {
    return null;
  }
}

export async function findBlock(t: Extract<Target, { type: 'block' }>): Promise<TextBlock | null> {
  const model = await currentModel(t.docId, t.pageIndex);
  return model?.blocks.find((b) => b.id === t.id && b.text === t.text) ?? null;
}

// ── blocks ───────────────────────────────────────────────────────────────────

export async function moveTextBlock(t: Extract<Target, { type: 'block' }>, dx: number, dy: number): Promise<boolean> {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;
  // targets selected after editing carry no bounds: take them from the model so the moved block stays selected
  const bounds = t.bounds ?? (await findBlock(t))?.bounds;
  const ok = await runEdit(t.docId, 'Move text', (lib) => moveBlock(lib, t.pageIndex, resolveBlockId(lib, t.pageIndex, t.id, t.text, bounds), t.text, dx, dy));
  if (ok && bounds) ui.setReselect({ type: 'block', docId: t.docId, pageIndex: t.pageIndex, text: t.text, bounds: { ...bounds, x: bounds.x + dx, y: bounds.y + dy } });
  return ok;
}

// ── images ───────────────────────────────────────────────────────────────────

/** Geometry shared by base images and image objects. */
export interface ImageGeom {
  matrix: Matrix;
  clip: [number, number, number, number];
  bounds: Rect;
  quad: number[];
}

export function geomOfObject(o: ContentImageObject): ImageGeom {
  const { matrix, clip } = o.data;
  const q = unitQuad(matrix, clip[0], clip[1], clip[2], clip[3]);
  return { matrix, clip, bounds: quadBounds(q), quad: q };
}

export const geomOfInfo = (im: ImageInfo): ImageGeom => ({ matrix: im.matrix, clip: im.clip, bounds: im.bounds, quad: im.quad });

function transformedBounds(g: ImageGeom, m: Matrix, clip?: [number, number, number, number]): Rect {
  const mm = mul(g.matrix, m);
  const c = clip ?? g.clip;
  return quadBounds(unitQuad(mm, c[0], c[1], c[2], c[3]));
}

export async function findImage(t: Extract<Target, { type: 'image' }>): Promise<ImageInfo | null> {
  const model = await currentModel(t.docId, t.pageIndex);
  return model?.images.find((x) => x.id === t.id) ?? null;
}

/** Applies a user-space transform (and optional new crop) to the selected image. One undo step. */
export async function transformTarget(t: Target, m: Matrix, label: string, clip?: [number, number, number, number]): Promise<boolean> {
  if (t.type === 'image') {
    const im = await findImage(t);
    if (!im) {
      actions.toast('The image changed on the page. Select it again.', { kind: 'warning' });
      return false;
    }
    const ok = await runEdit(t.docId, label, (lib) => transformImage(lib, t.pageIndex, resolveImageId(lib, t.pageIndex, t.id, im.name, im.bounds), m, clip));
    if (ok) ui.setReselect({ type: 'image', docId: t.docId, pageIndex: t.pageIndex, name: im.name, bounds: transformedBounds(geomOfInfo(im), m, clip) });
    return ok;
  }
  if (t.type === 'object') {
    const o = getDoc(t.docId)?.objects[t.id] as ContentImageObject | undefined;
    if (o?.kind !== KIND_IMAGE) return false;
    if (readOnlyNotice(t.docId)) return false;
    const matrix = mul(o.data.matrix, m);
    const data = { ...o.data, matrix, clip: clip ?? o.data.clip };
    const q = unitQuad(matrix, data.clip[0], data.clip[1], data.clip[2], data.clip[3]);
    actions.updateObject(t.docId, o.id, { rect: quadBounds(q), data }, { label });
    return true;
  }
  return false;
}

/** Transform moving/scaling the rect `from` onto `to`. */
export function boundsTransform(from: Rect, to: Rect): Matrix {
  const sx = from.width ? to.width / from.width : 1;
  const sy = from.height ? to.height / from.height : 1;
  return [sx, 0, 0, sy, to.x - from.x * sx, to.y - from.y * sy];
}

export async function cropTarget(t: Target, rect: Rect): Promise<boolean> {
  if (t.type === 'image') {
    const im = await findImage(t);
    if (!im) return false;
    return transformTarget(t, [1, 0, 0, 1, 0, 0], 'Crop image', clipForRect(im, rect));
  }
  const o = getDoc(t.docId)?.objects[t.id] as ContentImageObject | undefined;
  if (o?.kind !== KIND_IMAGE) return false;
  const clip = clipForRect({ matrix: o.data.matrix, clip: o.data.clip } as ImageInfo, rect);
  return transformTarget(t, [1, 0, 0, 1, 0, 0], 'Crop image', clip);
}

export async function replaceTargetImage(t: Target, file: File): Promise<boolean> {
  let img: Awaited<ReturnType<typeof loadImageFile>>;
  try {
    img = await loadImageFile(file);
  } catch (e) {
    actions.toast(errText(e), { kind: 'error' });
    return false;
  }
  if (t.type === 'image') {
    const im = await findImage(t);
    if (!im) return false;
    const ok = await runEdit(t.docId, 'Replace image', async (lib) => {
      const embedded = img.mime === 'image/png' ? await lib.embedPng(img.bytes) : await lib.embedJpg(img.bytes);
      replaceImage(lib, t.pageIndex, resolveImageId(lib, t.pageIndex, t.id, im.name, im.bounds), embedded.ref, img.width, img.height);
    });
    if (ok) {
      const b = im.bounds;
      const s = Math.min(b.width / img.width, b.height / img.height);
      const w = img.width * s, h = img.height * s;
      ui.setReselect({ type: 'image', docId: t.docId, pageIndex: t.pageIndex, name: '', bounds: { x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h } });
    }
    return ok;
  }
  const doc = getDoc(t.docId);
  const o = doc?.objects[t.id] as ContentImageObject | undefined;
  if (!doc || o?.kind !== KIND_IMAGE) return false;
  if (readOnlyNotice(t.docId)) return false;
  const b = geomOfObject(o).bounds;
  const s = Math.min(b.width / img.width, b.height / img.height);
  const w = img.width * s, h = img.height * s;
  const rect = { x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h };
  const matrix = uprightImageMatrix(rect, doc.pages[t.pageIndex]?.rotation ?? 0);
  actions.updateObject(t.docId, o.id, { rect, data: { src: img.dataUrl, mime: img.mime, pxWidth: img.width, pxHeight: img.height, matrix, clip: [0, 0, 1, 1] } }, { label: 'Replace image' });
  return true;
}

export async function arrangeTarget(t: Target, where: 'front' | 'back'): Promise<boolean> {
  const label = where === 'front' ? 'Bring to front' : 'Send to back';
  if (t.type === 'image') {
    const im = await findImage(t);
    if (!im) return false;
    const ok = await runEdit(t.docId, label, (lib) => arrangeImage(lib, t.pageIndex, resolveImageId(lib, t.pageIndex, t.id, im.name, im.bounds), where));
    if (ok) ui.setReselect({ type: 'image', docId: t.docId, pageIndex: t.pageIndex, name: im.name, bounds: im.bounds });
    return ok;
  }
  if (t.type === 'object') {
    if (where === 'front') actions.bringToFront(t.docId, [t.id]);
    else actions.sendToBack(t.docId, [t.id]);
    return true;
  }
  return false;
}

// ── delete ───────────────────────────────────────────────────────────────────

export async function deleteTarget(t: Target): Promise<boolean> {
  const doc = getDoc(t.docId);
  if (!doc) return false;
  let ok = false;
  let what = 'Item';
  if (t.type === 'block') {
    what = 'Text';
    ok = await runEdit(t.docId, 'Delete text', async (lib) => {
      await replaceBlock(lib, t.pageIndex, resolveBlockId(lib, t.pageIndex, t.id, t.text, t.bounds), t.text, null);
    });
  } else if (t.type === 'image') {
    what = 'Image';
    ok = await runEdit(t.docId, 'Delete image', (lib) => deleteImage(lib, t.pageIndex, resolveImageId(lib, t.pageIndex, t.id, t.name, t.bounds)));
  } else if (t.type === 'link') {
    what = 'Link';
    const info = await baseLink(t);
    if (!info) return false;
    ok = await runEdit(t.docId, 'Delete link', (lib) => {
      if (!removeLink(lib, t.pageIndex, info.annotIndex, info.rect)) throw new EditError('The link changed on the page. Try again.');
    });
  } else {
    const o = doc.objects[t.id];
    if (!o) return false;
    what = o.kind === KIND_TEXT ? 'Text' : o.kind === KIND_IMAGE ? 'Image' : o.kind === KIND_LINK ? 'Link' : 'Item';
    if (readOnlyNotice(t.docId)) return false;
    actions.deleteObjects(t.docId, [t.id], { label: `Delete ${what.toLowerCase()}` });
    ok = true;
  }
  if (ok) {
    ui.setTarget(null);
    undoToast(`${what} deleted`, t.docId);
  }
  return ok;
}

// ── links ────────────────────────────────────────────────────────────────────

export async function baseLink(t: Target): Promise<LinkInfo | null> {
  if (t.type !== 'link') return null;
  const model = await currentModel(t.docId, t.pageIndex);
  return model?.links.find((l) => l.id === t.id) ?? null;
}

/** LinkData for a base link (null when its action can't be edited here). */
export function linkDataOf(docId: DocId, info: LinkInfo): LinkData | null {
  const doc = getDoc(docId);
  const a = info.action;
  if (!doc) return null;
  if (!a) return { action: { type: 'url', url: '' }, appearance: info.appearance };
  if (a.type === 'unsupported') return null;
  if (a.type === 'url') return { action: { type: 'url', url: a.url }, appearance: info.appearance };
  const p = doc.pages[a.pageIndex];
  if (!p) return null;
  return { action: { type: 'page', pageId: p.id, left: a.left, top: a.top, zoom: a.zoom }, appearance: info.appearance };
}

/**
 * Turns a base link into an editable link object with `patch` applied — one undo step (the
 * annotation is removed from the bytes and the object added without a separate checkpoint).
 */
export async function convertBaseLink(t: Extract<Target, { type: 'link' }>, patch: { rect?: Rect; data?: LinkData }, label = 'Edit link'): Promise<ObjectId | null> {
  const info = await baseLink(t);
  const doc = getDoc(t.docId);
  if (!info || !doc) return null;
  const data = patch.data ?? linkDataOf(t.docId, info);
  if (!data) {
    actions.toast('This link runs an action that can’t be edited here.', { kind: 'warning' });
    return null;
  }
  const page = doc.pages[t.pageIndex];
  const obj = newObject<LinkObject>({ kind: KIND_LINK, pageId: page.id, rect: patch.rect ?? info.rect, data });
  const ok = await runEdit(t.docId, label, (lib) => {
    if (!removeLink(lib, t.pageIndex, info.annotIndex, info.rect)) throw new EditError('The link changed on the page. Try again.');
  });
  if (!ok) return null;
  actions.addObject(t.docId, obj, { checkpoint: false });
  ui.setTarget({ type: 'object', docId: t.docId, pageIndex: t.pageIndex, id: obj.id });
  return obj.id;
}

export function createLink(docId: DocId, pageIndex: number, rect: Rect, data: LinkData): ObjectId | null {
  const page = getDoc(docId)?.pages[pageIndex];
  if (!page || readOnlyNotice(docId)) return null;
  const obj = newObject<LinkObject>({ kind: KIND_LINK, pageId: page.id, rect, data });
  actions.addObject(docId, obj, { label: 'Add link' });
  ui.setTarget({ type: 'object', docId, pageIndex, id: obj.id });
  return obj.id;
}

/** Follows a link action (hand / select tool, "Open link"). */
export function followLink(docId: DocId, data: LinkData): void {
  const a = data.action;
  if (a.type === 'url') {
    if (!a.url) return;
    window.open(a.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const doc = getDoc(docId);
  const idx = doc ? doc.pages.findIndex((p) => p.id === a.pageId) : -1;
  if (idx < 0) {
    actions.toast('The page this link points to no longer exists.', { kind: 'warning' });
    return;
  }
  if (a.zoom) actions.setZoom(docId, a.zoom);
  actions.goToPage(docId, idx, a.top !== null ? { point: { x: a.left ?? 0, y: a.top } } : {});
}
