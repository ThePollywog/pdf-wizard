/**
 * High-level page edits on a pdf-lib document (no UI / store dependencies — used inside
 * engine.withLib and by the Node verification scripts).
 */
import { PDFDict, PDFName, PDFRef, type PDFDocument, type PDFFont, type PDFObject, type PDFPage } from '@cantoo/pdf-lib';
import { interpretPage, type ImageDraw, type PageContent } from './interpreter';
import { buildBlocks, frameQuad, type Frame, type TextBlock, type TextStyle } from './blocks';
import { ContentEditor } from './editor';
import { imageSplice, removalSplices } from './rewrite';
import { encodeWinAnsi, stdCodeWidth, stdEmbedder, stdFontFor, type StdFontName } from './fonts';
import { reemitGlyphs, typeset, type LayoutFont } from './layout';
import { hexString, nameToken } from './parser';
import { apply, fmtMatrix, invert, mul, quadBounds, type Matrix } from './matrix';
import { dictOf, nameOfObj, resolve } from './pdfobj';

export interface ImageInfo {
  id: string;
  name: string;
  /** Unit square → user space (full image). */
  matrix: Matrix;
  /** Visible part in unit coordinates. */
  clip: [number, number, number, number];
  /** Visible region: unit square → user space. */
  visible: Matrix;
  quad: number[];
  bounds: { x: number; y: number; width: number; height: number };
  pxWidth: number;
  pxHeight: number;
  draw: ImageDraw;
}

export interface PageAnalysis {
  content: PageContent;
  blocks: TextBlock[];
  images: ImageInfo[];
}

export function analysePage(lib: PDFDocument, pageIndex: number): PageAnalysis {
  const page = lib.getPage(pageIndex);
  const content = interpretPage(lib.context, page);
  const blocks = buildBlocks(content.glyphs, `p${pageIndex}`);
  const images = content.images.map((d): ImageInfo => {
    const clip = d.group?.clip ?? [0, 0, 1, 1];
    const c: [number, number, number, number] = [
      Math.max(0, Math.min(1, clip[0])), Math.max(0, Math.min(1, clip[1])),
      Math.max(0, Math.min(1, clip[2])), Math.max(0, Math.min(1, clip[3])),
    ];
    const visible = mul([c[2] - c[0], 0, 0, c[3] - c[1], c[0], c[1]], d.ctm);
    const quad = [...apply(visible, 0, 0), ...apply(visible, 1, 0), ...apply(visible, 1, 1), ...apply(visible, 0, 1)];
    return {
      id: `p${pageIndex}:img:${d.source}:${d.op}`, name: d.name, matrix: d.ctm, clip: c, visible, quad,
      bounds: quadBounds(quad), pxWidth: d.pxWidth, pxHeight: d.pxHeight, draw: d,
    };
  });
  return { content, blocks, images };
}

export class EditError extends Error {}

function requireBlock(an: PageAnalysis, id: string, text?: string): TextBlock {
  const b = an.blocks.find((x) => x.id === id && (text === undefined || x.text === text))
    ?? (text !== undefined ? an.blocks.find((x) => x.text === text) : undefined);
  if (!b) throw new EditError('The text changed on the page. Try again.');
  return b;
}

function requireImage(an: PageAnalysis, id: string): ImageInfo {
  const im = an.images.find((x) => x.id === id);
  if (!im) throw new EditError('The image changed on the page. Try again.');
  return im;
}

// ── fonts ────────────────────────────────────────────────────────────────────

export interface CustomFontLoader {
  (style: { bold: boolean; italic: boolean }): Promise<PDFFont>;
}

export function stdLayoutFont(std: StdFontName, resName: string): LayoutFont {
  const f = stdEmbedder(std).font;
  return {
    resName,
    encode: (t) => {
      const b = encodeWinAnsi(t, std);
      return b ? hexString(b) : null;
    },
    width: (t) => {
      const b = encodeWinAnsi(t, std);
      if (!b) return 0;
      let w = 0;
      for (const c of b) w += stdCodeWidth(std, c);
      return w;
    },
    ascent: typeof f.Ascender === 'number' ? f.Ascender : 718,
    descent: typeof f.Descender === 'number' ? f.Descender : -207,
  };
}

/** A non-embedded standard-14 WinAnsi font dict on the page (existing one when possible). */
function standardFontName(lib: PDFDocument, ed: ContentEditor, std: StdFontName): string {
  const fonts = dictOf(lib.context, ed.content.resources?.get(PDFName.of('Font')));
  if (fonts) {
    for (const [k, v] of fonts.entries()) {
      const d = dictOf(lib.context, v);
      if (!d) continue;
      if (nameOfObj(lib.context, d.get(PDFName.of('Subtype'))) !== 'Type1') continue;
      if (nameOfObj(lib.context, d.get(PDFName.of('BaseFont'))) !== std) continue;
      if (nameOfObj(lib.context, d.get(PDFName.of('Encoding'))) !== 'WinAnsiEncoding') continue;
      if (d.get(PDFName.of('FontDescriptor'))) continue;
      void k;
      return ed.resourceName('Font', v, 'EdF');
    }
  }
  const ref = lib.context.register(
    lib.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: std, Encoding: 'WinAnsiEncoding' }),
  );
  return ed.resourceName('Font', ref, 'EdF');
}

async function layoutFontFor(
  lib: PDFDocument,
  ed: ContentEditor,
  style: TextStyle,
  text: string,
  original: TextBlock | null,
  custom?: CustomFontLoader,
): Promise<LayoutFont> {
  const std = stdFontFor(style.family, style.bold, style.italic);
  let primary: LayoutFont | null = null;
  if (original && original.font.isStandard14 && original.font.winAnsi && original.font.standard === std) {
    const g = original.glyphs.find((x) => x.font === original.font);
    const name = g ? ed.fontForPage(g.source, g.fontName, g.fontObj) : null;
    if (name) primary = stdLayoutFont(std, name);
  }
  primary ??= stdLayoutFont(std, standardFontName(lib, ed, std));
  const plain = text.replace(/\n/g, '');
  if (encodeWinAnsi(plain, std)) return primary;
  // characters outside WinAnsi need the embedded Unicode font (Liberation Sans)
  if (!custom) throw new EditError('This text contains characters that need an embedded font.');
  const pf = await custom({ bold: style.bold, italic: style.italic });
  const uni = customLayoutFont(pf, ed.resourceName('Font', pf.ref, 'EdF'));
  // sans: Liberation Sans is metric-compatible with Helvetica → the whole text in one font (clean
  // text extraction). Serif / mono keep their standard font; words it can't encode fall back.
  if (style.family === 'sans') return { ...uni, ascent: primary.ascent, descent: primary.descent };
  return { ...primary, fallback: uni };
}

/** Layout font for an embedded (subset) TrueType font; characters without a glyph can't be encoded. */
export function customLayoutFont(pf: PDFFont, resName: string): LayoutFont {
  const face = (pf as unknown as { embedder?: { font?: { hasGlyphForCodePoint?(cp: number): boolean } } }).embedder?.font;
  const has = (t: string) => !face?.hasGlyphForCodePoint || [...t].every((ch) => ch === ' ' || face.hasGlyphForCodePoint!(ch.codePointAt(0)!));
  return {
    resName,
    encode: (t) => {
      if (!has(t)) return null;
      try {
        return pf.encodeText(t).toString();
      } catch {
        return null;
      }
    },
    width: (t) => pf.widthOfTextAtSize(t, 1000),
    ascent: 905,
    descent: -212,
  };
}

// ── text ─────────────────────────────────────────────────────────────────────

export interface TextEdit {
  text: string;
  style: TextStyle;
  frame: Frame;
  /** Distance frame top → first baseline (defaults to the font ascent). */
  firstBaseline?: number;
  /** Wrap at frame.width (default true). */
  wrap?: boolean;
}

/** Replaces a block with new text (or deletes it when `edit` is null). */
export async function replaceBlock(
  lib: PDFDocument,
  pageIndex: number,
  blockId: string,
  expectText: string | undefined,
  edit: TextEdit | null,
  custom?: CustomFontLoader,
): Promise<{ removedGlyphs: number; whiteout: boolean; missing: string[] }> {
  const an = analysePage(lib, pageIndex);
  const block = requireBlock(an, blockId, expectText);
  const ed = new ContentEditor(lib.context, lib.getPage(pageIndex), an.content);
  const whiteout = !block.removable;
  if (whiteout) ed.append(whiteoutOps(block.frame));
  else ed.splice(removalSplices(an.content, block.glyphs));
  let missing: string[] = [];
  if (edit && edit.text.trim()) {
    const font = await layoutFontFor(lib, ed, edit.style, edit.text, block, custom);
    const firstBaseline = edit.firstBaseline ?? (font.ascent / 1000) * edit.style.size;
    const res = typeset({ text: edit.text, frame: edit.frame, firstBaseline, style: edit.style, font, wrap: edit.wrap });
    // characters no available font has are left out (the caller tells the user) — unless the
    // original text has them: re-typesetting would lose existing content
    const lost = res.missing.filter((ch) => block.text.includes(ch));
    if (lost.length) throw new EditError(`This text can’t be re-typeset: no available font has ${lost.slice(0, 8).join(' ')}. You can still move or delete it.`);
    missing = res.missing;
    ed.append(res.ops);
  }
  ed.commit();
  return { removedGlyphs: block.glyphs.length, whiteout, missing };
}

/** Moves a block keeping its exact glyphs (fonts, codes, spacing). */
export function moveBlock(lib: PDFDocument, pageIndex: number, blockId: string, expectText: string | undefined, dx: number, dy: number): void {
  const an = analysePage(lib, pageIndex);
  const block = requireBlock(an, blockId, expectText);
  const ed = new ContentEditor(lib.context, lib.getPage(pageIndex), an.content);
  // glyphs that can't be cut out of the stream are covered instead (re-emitting them works for any font)
  if (block.removable) ed.splice(removalSplices(an.content, block.glyphs));
  else ed.append(whiteoutOps(block.frame));
  ed.append(reemitGlyphs(block.glyphs, dx, dy, (g) => ed.fontForPage(g.source, g.fontName, g.fontObj)));
  ed.commit();
}

function whiteoutOps(f: Frame): string {
  const q = frameQuad(f);
  return `q 1 1 1 rg ${q[0]} ${q[1]} m ${q[2]} ${q[3]} l ${q[4]} ${q[5]} l ${q[6]} ${q[7]} l h f Q`;
}

/** Draws new text onto a page (used for text boxes baked into content). */
export async function insertText(lib: PDFDocument, pageIndex: number, edit: TextEdit, custom?: CustomFontLoader): Promise<string[]> {
  return insertTextOnPage(lib, lib.getPage(pageIndex), edit, custom);
}

/** Same as insertText for a pdf-lib page object (export pipeline). Returns the characters left out. */
export async function insertTextOnPage(lib: PDFDocument, page: PDFPage, edit: TextEdit, custom?: CustomFontLoader): Promise<string[]> {
  if (!edit.text.trim()) return [];
  const content = interpretPage(lib.context, page);
  const ed = new ContentEditor(lib.context, page, content);
  const font = await layoutFontFor(lib, ed, edit.style, edit.text, null, custom);
  const firstBaseline = edit.firstBaseline ?? (font.ascent / 1000) * edit.style.size;
  const res = typeset({ text: edit.text, frame: edit.frame, firstBaseline, style: edit.style, font, wrap: edit.wrap });
  ed.append(res.ops);
  ed.commit();
  return res.missing;
}

/** Draws an image XObject (unit square → `matrix`, optional unit-space crop) on top of a page. */
export function drawImageOnPage(lib: PDFDocument, page: PDFPage, ref: PDFRef, matrix: Matrix, clip?: [number, number, number, number]): void {
  const content = interpretPage(lib.context, page);
  const ed = new ContentEditor(lib.context, page, content);
  const name = ed.resourceName('XObject', ref, 'EdIm');
  const c = clip ?? [0, 0, 1, 1];
  const cl = c[0] > 0 || c[1] > 0 || c[2] < 1 || c[3] < 1 ? `${c[0]} ${c[1]} ${c[2] - c[0]} ${c[3] - c[1]} re W n ` : '';
  ed.append(`q ${fmtMatrix(matrix)} cm ${cl}${nameToken(name)} Do Q`);
  ed.commit();
}

// ── images ───────────────────────────────────────────────────────────────────

/** Applies a user-space transform to an image (and optionally a new crop in unit coordinates). */
export function transformImage(
  lib: PDFDocument,
  pageIndex: number,
  imageId: string,
  m: Matrix,
  clip?: [number, number, number, number],
): void {
  const an = analysePage(lib, pageIndex);
  const im = requireImage(an, imageId);
  const ed = new ContentEditor(lib.context, lib.getPage(pageIndex), an.content);
  ed.splice(imageSplice(an.content, im.draw, { matrix: mul(im.matrix, m), clip: clip ?? im.clip }));
  ed.commit();
}

export function deleteImage(lib: PDFDocument, pageIndex: number, imageId: string): void {
  const an = analysePage(lib, pageIndex);
  const im = requireImage(an, imageId);
  const ed = new ContentEditor(lib.context, lib.getPage(pageIndex), an.content);
  ed.splice(imageSplice(an.content, im.draw, { matrix: null }));
  ed.commit();
}

/** Replaces the image with another one, fitted (aspect kept) into the visible box. */
export function replaceImage(lib: PDFDocument, pageIndex: number, imageId: string, ref: PDFRef, width: number, height: number): void {
  const an = analysePage(lib, pageIndex);
  const im = requireImage(an, imageId);
  const ed = new ContentEditor(lib.context, lib.getPage(pageIndex), an.content);
  const name = ed.resourceName('XObject', ref, 'EdIm');
  const b = im.bounds;
  const s = Math.min(b.width / width, b.height / height);
  const w = width * s, h = height * s;
  const x = b.x + (b.width - w) / 2, y = b.y + (b.height - h) / 2;
  const src = an.content.sources[im.draw.source];
  if (src.kind === 'page') ed.splice(imageSplice(an.content, im.draw, { matrix: [w, 0, 0, h, x, y], name }));
  else {
    // the image lives in a form: remove it there, draw the new one on the page
    ed.splice(imageSplice(an.content, im.draw, { matrix: null }));
    ed.append(`q ${fmtMatrix([w, 0, 0, h, x, y])} cm ${nameToken(name)} Do Q`);
  }
  ed.commit();
}

/** Moves an image to the top (front) or bottom (back) of the page's drawing order. */
export function arrangeImage(lib: PDFDocument, pageIndex: number, imageId: string, where: 'front' | 'back'): void {
  const an = analysePage(lib, pageIndex);
  const im = requireImage(an, imageId);
  const ed = new ContentEditor(lib.context, lib.getPage(pageIndex), an.content);
  const xobj = im.draw.xobj;
  if (!xobj) throw new EditError('The image could not be found.');
  const name = ed.resourceName('XObject', xobj, 'EdIm');
  ed.splice(imageSplice(an.content, im.draw, { matrix: null }));
  const c = im.clip;
  const clip = c[0] > 0 || c[1] > 0 || c[2] < 1 || c[3] < 1 ? `${c[0]} ${c[1]} ${c[2] - c[0]} ${c[3] - c[1]} re W n ` : '';
  const ops = `q ${fmtMatrix(im.matrix)} cm ${clip}${nameToken(name)} Do Q`;
  if (where === 'front') ed.append(ops);
  else ed.prepend(ops);
  ed.commit();
}

/** Unit-space crop for a user-space visible rect of an image. */
export function clipForRect(im: ImageInfo, r: { x: number; y: number; width: number; height: number }): [number, number, number, number] {
  const inv = invert(im.matrix);
  if (!inv) return im.clip;
  const pts = [apply(inv, r.x, r.y), apply(inv, r.x + r.width, r.y), apply(inv, r.x + r.width, r.y + r.height), apply(inv, r.x, r.y + r.height)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cl = (v: number) => Math.max(0, Math.min(1, v));
  return [cl(Math.min(...xs)), cl(Math.min(...ys)), cl(Math.max(...xs)), cl(Math.max(...ys))];
}

export function isImageXObject(lib: PDFDocument, o: PDFObject | undefined): boolean {
  const v = resolve(lib.context, o);
  const d = v instanceof PDFDict ? v : undefined;
  return !!d && nameOfObj(lib.context, d.get(PDFName.of('Subtype'))) === 'Image';
}
