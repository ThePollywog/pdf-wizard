/**
 * Writers: overlay objects → standard PDF annotations with appearance streams.
 *   note            → /Text (/Name, /Popup via the core writer)
 *   text-markup     → /Highlight /Underline /StrikeOut /Squiggly (/QuadPoints)
 *   caret           → /Caret (+ grouped /StrikeOut with /IRT + /RT /Group for "Replace text")
 *   freetext        → /FreeText (/DA /DS /RC /Q /IT /CL /LE /BS /IC)
 *   file-attachment → /FileAttachment (/FS with an embedded file /EF)
 */
import { PDFDict, PDFHexString, PDFString, type PDFFont, type PDFRef } from '@cantoo/pdf-lib';
import type { AppearanceSpec, ExportContext, PdfObject, Point, Rect } from '@/core/types';
import { preservedAppearanceSpec } from '@/core/annotations';
import { pdfDate } from '@/core/engine/lib';
import { hexToRgb01 } from '@/core/util';
import { attachIconOps, cm, frameMatrix, n, noteIconOps, rgbOps } from './icons';
import { caretPath, markupBounds, markupShapes } from './geometry';
import { arrowHead, calloutBounds, CSS_FONT, frameSizeOf, layoutFreeText } from './layout';
import { covers, invisibleRuns, invisibleScale, rasterText } from './rasterText';
import {
  LIBERATION_URL, MARKUP_LABEL, MARKUP_SUBTYPE, fetchFont, normRotation, type AttachmentObject, type CaretObject, type FreeTextObject, type MarkupObject,
  type MarkupType, type NoteObject,
} from './model';
import { quadsBBox } from './quads';

/** Private key holding the marked-up text of a text markup (restored on import). */
export const MARKED_TEXT_KEY = 'AWMarkedText';
/** Private FreeText keys: the box width follows its text / the minimum height set by the user. */
export const FT_AUTO_WIDTH_KEY = 'AWAutoWidth';
export const FT_MIN_HEIGHT_KEY = 'AWMinHeight';

const hex = (s: string) => PDFHexString.fromText(s);

function pathOps(pts: Point[], close: boolean): string {
  if (!pts.length) return '';
  const out = [`${n(pts[0].x)} ${n(pts[0].y)} m`];
  for (let i = 1; i < pts.length; i++) out.push(`${n(pts[i].x)} ${n(pts[i].y)} l`);
  if (close) out.push('h');
  return out.join(' ');
}

// ── text markup ─────────────────────────────────────────────────────────────

export function markupAppearance(ctx: ExportContext, type: MarkupType, quads: number[], color: string): AppearanceSpec {
  const shapes = markupShapes(type, quads);
  const ops: string[] = [];
  let resources: PDFDict | undefined;
  if (type === 'highlight') {
    resources = ctx.pdfDoc.context.obj({ ExtGState: { GSm: ctx.pdfDoc.context.obj({ Type: 'ExtGState', BM: 'Multiply' }) } }) as PDFDict;
    ops.push('/GSm gs', rgbOps(color));
    for (const p of shapes.polys) ops.push(`${pathOps(p, true)} f`);
  } else {
    ops.push(rgbOps(color, true), '0 J 1 j');
    for (const l of shapes.lines) ops.push(`${n(l.width)} w ${pathOps(l.pts, false)} S`);
  }
  return { ops: ops.join('\n'), resources, bbox: markupBounds(quads) };
}

export function exportMarkup(obj: MarkupObject, ctx: ExportContext) {
  const d = obj.data;
  const color = obj.color ?? '#ffe14d';
  const bbox = quadsBBox(d.quads);
  ctx.annots.add(ctx.page(obj.pageId), obj, {
    subtype: MARKUP_SUBTYPE[d.type] ?? 'Highlight',
    rect: bbox,
    appearance: markupAppearance(ctx, d.type, d.quads, color),
    extra: {
      Subj: hex(d.type === 'highlight' && !d.text && !d.textPending ? 'Area Highlight' : MARKUP_LABEL[d.type] ?? 'Highlight'),
      QuadPoints: d.quads.map((v) => Math.round(v * 1000) / 1000),
      [MARKED_TEXT_KEY]: d.text ? hex(d.text) : undefined,
    },
  });
}

// ── note ─────────────────────────────────────────────────────────────────────

export function exportNote(obj: NoteObject, ctx: ExportContext) {
  const d = obj.data;
  // Text annotations are NoRotate (viewers keep them upright): the appearance is drawn upright,
  // except when flattened into the page content, where it has to counter the page rotation.
  const rot = ctx.options.flatten ? normRotation(ctx.pageInfo(obj.pageId).rotation) : 0;
  ctx.annots.add(ctx.page(obj.pageId), obj, {
    subtype: 'Text',
    appearance: { ops: noteIconOps(d.icon, obj.rect, obj.color ?? '#ffd400', rot || undefined), bbox: obj.rect },
    // Print | NoZoom | NoRotate (+ Locked), like the usual sticky notes.
    extra: { Name: d.icon || 'Comment', Open: false, F: 28 | (obj.locked ? 128 : 0) },
  });
}

// ── caret / replace text ────────────────────────────────────────────────────

function caretOps(r: Rect, dir: CaretObject['data']['dir'], color: string): string {
  const p = caretPath(r, dir);
  const segs = p.curves.map((c) => `${c.map((q) => `${n(q.x)} ${n(q.y)}`).join(' ')} c`).join(' ');
  return `${rgbOps(color)}\n${n(p.start.x)} ${n(p.start.y)} m ${segs} h f`;
}

export function exportCaret(obj: CaretObject, ctx: ExportContext) {
  const d = obj.data;
  const page = ctx.page(obj.pageId);
  const color = obj.color ?? '#1473e6';
  const subj = d.strike ? 'Replace Text' : 'Inserted Text';
  const caretRef = ctx.annots.add(page, obj, {
    subtype: 'Caret',
    rect: d.caret,
    appearance: { ops: caretOps(d.caret, d.dir, color), bbox: d.caret },
    extra: {
      Subj: hex(subj),
      Sy: d.symbol === 'P' ? 'P' : 'None',
      IT: d.strike ? 'Replace' : undefined,
      // Written as 0 on rotated pages too, so the import doesn't fall back to the page rotation.
      Rotate: d.dir ? d.dir : normRotation(ctx.pageInfo(obj.pageId).rotation) ? 0 : undefined,
    },
  });
  if (!d.strike || !d.strike.quads.length) return;
  const strikeColor = color;
  const member: PdfObject = { ...obj, id: `${obj.id}-strike`, contents: undefined, replies: undefined, status: undefined };
  ctx.annots.add(page, member, {
    subtype: 'StrikeOut',
    rect: quadsBBox(d.strike.quads),
    appearance: markupAppearance(ctx, 'strikeout', d.strike.quads, strikeColor),
    noContents: true,
    extra: {
      Subj: hex(subj),
      QuadPoints: d.strike.quads.map((v) => Math.round(v * 1000) / 1000),
      IT: 'StrikeOutTextEdit',
      IRT: caretRef ?? undefined,
      RT: caretRef ? 'Group' : undefined,
      [MARKED_TEXT_KEY]: d.strike.text ? hex(d.strike.text) : undefined,
    },
  });
}

// ── free text ───────────────────────────────────────────────────────────────

const PDF_FONT = { Helvetica: 'Helvetica', Times: 'Times-Roman', Courier: 'Courier' } as const;
const DA_FONT = { Helvetica: 'Helv', Times: 'TiRo', Courier: 'Cour' } as const;
const CSS_NAME = { Helvetica: 'Helvetica', Times: 'Times New Roman', Courier: 'Courier' } as const;

const rgb3 = (h: string) => hexToRgb01(h).map((v) => n(v)).join(' ');
const cssHex = (h: string) => h.toUpperCase();

/** Signature of everything that affects a FreeText's look (for preserved appearances). */
export function freeTextSig(o: FreeTextObject): string {
  const d = o.data;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const pts = d.callout ? d.callout.points.map((p) => [r2(p.x - o.rect.x), r2(p.y - o.rect.y)]) : null;
  return JSON.stringify([
    d.text, d.font, d.fontSize, d.textColor, d.align, d.intent, d.rotate ?? 0, o.color ?? null, o.fillColor ?? null,
    o.strokeWidth ?? 0, o.opacity ?? 1, r2(o.rect.width), r2(o.rect.height), pts, d.lineEnding ?? null,
  ]);
}

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function freeTextRichText(o: FreeTextObject): string {
  const d = o.data;
  const style = `font-size:${d.fontSize}pt;text-align:${d.align};color:${cssHex(d.textColor)};font-weight:normal;font-style:normal;font-family:${CSS_NAME[d.font]};font-stretch:normal`;
  const paras = d.text.replace(/\r\n?/g, '\n').split('\n').map((l) => `<p dir="ltr"><span>${escapeXml(l) || '&#8203;'}</span></p>`).join('');
  return `<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="PDFWizard:1.0.0" xfa:spec="2.0.2" style="${style}">${paras}</body>`;
}

async function fontFor(ctx: ExportContext, family: keyof typeof PDF_FONT, unicode: boolean): Promise<PDFFont> {
  // ctx.customFont patches the fontkit subset; the URL key shares one embedded subset with the other features.
  if (unicode) return ctx.customFont(LIBERATION_URL.regular, () => fetchFont(LIBERATION_URL.regular));
  return ctx.standardFont(PDF_FONT[family]);
}

export async function freeTextAppearance(ctx: ExportContext, o: FreeTextObject): Promise<AppearanceSpec> {
  const d = o.data;
  const box = d.callout ? d.callout.box : o.rect;
  const rot = d.rotate;
  const sw = o.color ? Math.max(0, o.strokeWidth ?? 0) : 0;
  const { w: fw } = frameSizeOf(box, rot);
  const L = layoutFreeText(d, sw, fw);
  const { h: fh } = frameSizeOf(box, rot);
  const font = await fontFor(ctx, L.font, L.unicode);
  const ops: string[] = [];

  // leader line + arrow (user space)
  if (d.callout && d.callout.points.length >= 2 && o.color) {
    const pts = d.callout.points;
    const lw = Math.max(0.5, o.strokeWidth ?? 1);
    ops.push('q', rgbOps(o.color, true), `${n(lw)} w 1 J 1 j`, `${pathOps(pts, false)} S`);
    if ((d.lineEnding ?? 'OpenArrow') !== 'None') {
      const [a, b] = arrowHead(pts[0], pts[1], Math.max(6, lw * 4));
      ops.push(`${pathOps([a, pts[0], b], false)} S`);
    }
    ops.push('Q');
  }

  ops.push('q', cm(frameMatrix(box, rot)));
  if (o.fillColor) ops.push(rgbOps(o.fillColor), `0 0 ${n(fw)} ${n(fh)} re f`);
  if (sw > 0 && o.color) ops.push(rgbOps(o.color, true), `${n(sw)} w 0 j`, `${n(sw / 2)} ${n(sw / 2)} ${n(fw - sw)} ${n(fh - sw)} re S`);
  ops.push(`${n(sw)} ${n(sw)} ${n(Math.max(0, fw - 2 * sw))} ${n(Math.max(0, fh - 2 * sw))} re W n`);
  const lines = L.lines.filter((l) => l.text.trim().length > 0);
  // Lines the font covers are real text; others (CJK…) are an image with invisible text on top.
  const fonts: Record<string, PDFRef> = { F1: font.ref };
  const xobjects: Record<string, PDFRef> = {};
  const drawn = lines.filter((l) => covers(font, l.text));
  const raster = lines.filter((l) => !covers(font, l.text));
  if (drawn.length) {
    ops.push('BT', `/F1 ${n(L.fontSize)} Tf`, rgbOps(d.textColor));
    for (const l of drawn) {
      const enc = font.encodeText(l.text).toString();
      ops.push(`1 0 0 1 ${n(l.x)} ${n(fh - l.baseline)} Tm`, `${enc} Tj`);
    }
    ops.push('ET');
  }
  let img = 0;
  let inv = 0;
  for (const l of raster) {
    const base = fh - l.baseline;
    const r = await rasterText(ctx.pdfDoc, l.text, { cssFont: CSS_FONT[L.font], size: L.fontSize, color: d.textColor, width: l.width });
    if (r) {
      const name = `Im${img++}`;
      xobjects[name] = r.image.ref;
      ops.push('q', `${n(r.width)} 0 0 ${n(r.height)} ${n(l.x + r.x)} ${n(base + r.y)} cm`, `/${name} Do`, 'Q');
    }
    ops.push('BT', `${r ? 3 : 0} Tr`, rgbOps(d.textColor), `${n(invisibleScale(l.text, L.fontSize, l.width))} Tz`, `1 0 0 1 ${n(l.x)} ${n(base)} Tm`);
    for (const run of invisibleRuns(ctx.pdfDoc, l.text)) {
      const name = `G${inv++}`;
      fonts[name] = run.ref;
      ops.push(`/${name} ${n(L.fontSize)} Tf`, `${run.hex} Tj`);
    }
    ops.push('ET');
  }
  ops.push('Q');
  const resources = ctx.pdfDoc.context.obj({ Font: fonts, ...(img ? { XObject: xobjects } : {}) }) as PDFDict;
  const bbox = d.callout ? calloutBounds(d.callout, o.strokeWidth ?? 1) : o.rect;
  return { ops: ops.join('\n'), resources, bbox };
}

export async function exportFreeText(obj: FreeTextObject, ctx: ExportContext) {
  const d = obj.data;
  const page = ctx.page(obj.pageId);
  const box = d.callout ? d.callout.box : obj.rect;
  const sw = obj.color ? Math.max(0, obj.strokeWidth ?? 0) : 0;
  const keep = !!d.preserved && d.preserved.sig === freeTextSig(obj);
  const appearance = keep ? await preservedAppearanceSpec(ctx, d.preserved!.ap, obj.rect) : await freeTextAppearance(ctx, obj);
  // An untouched imported annotation keeps its original /Rect; otherwise the rect follows the drawing.
  const rect = keep || !d.callout ? obj.rect : calloutBounds(d.callout, obj.strokeWidth ?? 1);
  const da = `/${DA_FONT[d.font]} ${n(d.fontSize)} Tf ${rgb3(d.textColor)} rg${obj.color ? ` ${rgb3(obj.color)} RG` : ''}`;
  const ds = `font: ${CSS_NAME[d.font]} ${n(d.fontSize)}pt; text-align:${d.align}; color:${cssHex(d.textColor)}`;
  const extra: Record<string, unknown> = {
    DA: PDFString.of(da),
    DS: PDFString.of(ds),
    RC: hex(freeTextRichText(obj)),
    Q: d.align === 'center' ? 1 : d.align === 'right' ? 2 : 0,
    IT: d.intent,
    IC: obj.fillColor ? hexToRgb01(obj.fillColor).map((v) => Math.round(v * 1000) / 1000) : undefined,
    Rotate: d.rotate ? d.rotate : undefined,
    BS: ctx.pdfDoc.context.obj({ Type: 'Border', W: Math.round(sw * 1000) / 1000, S: 'S' }),
    // Private keys (ignored by other readers): how the box sizes itself while its text is edited.
    [FT_AUTO_WIDTH_KEY]: d.autoWidth ? true : undefined,
    [FT_MIN_HEIGHT_KEY]: Math.round(Math.max(0, d.minHeight ?? 0) * 1000) / 1000,
  };
  if (d.callout && d.callout.points.length >= 2) {
    const pts = d.callout.points;
    extra.CL = pts.flatMap((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]);
    extra.LE = d.lineEnding ?? 'OpenArrow';
    extra.IT = 'FreeTextCallout';
  }
  // /RD: the text box inside the annotation rect (the writer computes it for spec.rect vs. final rect)
  const rd = [box.x - rect.x, box.y - rect.y, rect.x + rect.width - (box.x + box.width), rect.y + rect.height - (box.y + box.height)].map(
    (v) => Math.round(Math.max(0, v) * 1000) / 1000,
  );
  extra.RD = rd.some((v) => v > 0) ? rd : undefined;
  ctx.annots.add(page, obj, { subtype: 'FreeText', rect, appearance: { ...appearance, bbox: rect }, extra });
}

// ── file attachment ─────────────────────────────────────────────────────────

export function exportAttachment(obj: AttachmentObject, ctx: ExportContext) {
  const d = obj.data;
  const page = ctx.page(obj.pageId);
  const appearance: AppearanceSpec = { ops: attachIconOps(d.icon ?? 'PushPin', obj.rect, obj.color ?? '#1473e6', d.rotate), bbox: obj.rect };
  if (ctx.options.flatten) {
    ctx.annots.add(page, obj, { subtype: 'FileAttachment', appearance });
    return;
  }
  const c = ctx.pdfDoc.context;
  const bytes = d.bytes instanceof Uint8Array ? d.bytes : new Uint8Array(d.bytes ?? []);
  const params: Record<string, unknown> = { Size: bytes.length, CreationDate: PDFString.of(pdfDate(new Date(obj.createdAt))) };
  if (d.fileModified) params.ModDate = PDFString.of(pdfDate(new Date(d.fileModified)));
  const ef = c.register(c.flateStream(bytes, { Type: 'EmbeddedFile', Subtype: d.mimeType || 'application/octet-stream', Params: params as never }));
  const fsDict: Record<string, unknown> = {
    Type: 'Filespec',
    F: PDFString.of(asciiName(d.fileName)),
    UF: hex(d.fileName),
    EF: { F: ef, UF: ef },
  };
  if (d.description) fsDict.Desc = hex(d.description);
  const fsRef: PDFRef = c.register(c.obj(fsDict as never));
  ctx.annots.add(page, obj, {
    subtype: 'FileAttachment',
    appearance,
    extra: { FS: fsRef, Name: d.icon ?? 'PushPin', Rotate: d.rotate ? d.rotate : undefined },
  });
}

function asciiName(s: string): string {
  const a = s.replace(/[^\x20-\x7e]/g, '_');
  return a || 'attachment';
}

