/**
 * Readers: PDF annotations already in an opened file → editable comment objects.
 *   Text                                    → note
 *   Highlight / Underline / StrikeOut / Squiggly → text-markup
 *   Caret (+ grouped StrikeOut, "Replace text")  → caret
 *   FreeText (incl. /IT /FreeTextCallout)   → freetext
 *   FileAttachment (with an embedded file)  → file-attachment
 * Replies (/IRT) and review states are attached by the core; their /Popup children are removed.
 */
import { decodePDFRawStream, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import type { PdfObject, Point, Rect } from '@/core/types';
import { importedObject, registerAnnotationImporter, type AnnotationSource } from '@/core/annotations';
import { parsePdfDate } from '@/core/engine/lib';
import { rgb01ToHex } from '@/core/util';
import { calloutBounds, frameSizeOf, MIN_BOX } from './layout';
import { freeTextSig, FT_AUTO_WIDTH_KEY, FT_MIN_HEIGHT_KEY, MARKED_TEXT_KEY } from './pdfExport';
import { caretBounds } from './caret';
import { mimeFromName } from './attachment';
import { flattenQuads, quadFromRect, quadList, quadsBBox, type Quad } from './quads';
import {
  ATTACH_DEFAULTS, ATTACH_ICONS, MARKUP_COLORS, NOTE_DEFAULTS, NOTE_ICONS, NOTE_SIZE, normRotation, type AttachIcon, type AttachmentObject,
  type CaretData, type CaretObject, type FontFamily, type FreeTextData, type FreeTextIntent, type FreeTextObject, type MarkupObject,
  type MarkupType, type NoteIcon, type NoteObject, type TextAlign, type TextDir,
} from './model';

// ── helpers ─────────────────────────────────────────────────────────────────

const locked = (src: AnnotationSource) => ((src.common.flags & 128) !== 0 ? true : undefined);

/** QuadPoints in any corner order → TL, TR, BL, BR relative to the text direction. */
export function normalizeQuads(q: number[] | undefined): number[] {
  if (!q || q.length < 8) return [];
  const out: Quad[] = [];
  for (const [p0, p1, p2, p3] of quadList(q)) {
    // p0→p1 is an edge (along the text); p0's other neighbour is the nearer of p2 / p3.
    const d2 = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const d3 = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const n0 = d2 <= d3 ? p2 : p3; // neighbour of p0
    const n1 = d2 <= d3 ? p3 : p2; // neighbour of p1
    const v = { x: p1.x - p0.x, y: p1.y - p0.y };
    const up = { x: -v.y, y: v.x };
    const isTop = (p0.x - n0.x) * up.x + (p0.y - n0.y) * up.y >= 0;
    out.push(isTop ? [p0, p1, n0, n1] : [n0, n1, p0, p1]);
  }
  return flattenQuads(out);
}

function markedText(src: AnnotationSource): string | undefined {
  const t = src.text(MARKED_TEXT_KEY);
  return t === undefined ? undefined : t;
}

function textDir(src: AnnotationSource): TextDir {
  const r = src.num('Rotate');
  return normRotation(r ?? src.page.rotation) as TextDir;
}

function rotateOf(src: AnnotationSource): 0 | 90 | 180 | 270 {
  return normRotation(src.num('Rotate') ?? 0);
}

/** /Rect minus /RD. */
function innerRect(src: AnnotationSource): Rect {
  const r = src.common.rect;
  const rd = src.nums('RD');
  if (!rd || rd.length < 4) return r;
  const [l, b, rr, t] = rd.map((v) => Math.max(0, v));
  const width = r.width - l - rr;
  const height = r.height - b - t;
  if (width <= 1 || height <= 1) return r;
  return { x: r.x + l, y: r.y + b, width, height };
}

// ── Text → note ─────────────────────────────────────────────────────────────

const NOTE_NAMES = new Set<string>(NOTE_ICONS.map((i) => i.value));

function importNote(src: AnnotationSource): NoteObject | null {
  if (src.common.hidden) return null;
  const name = src.name('Name') ?? 'Note';
  const icon = (NOTE_NAMES.has(name) ? name : 'Note') as NoteIcon;
  const r = src.common.rect;
  const ok = (v: number) => v >= 8 && v <= 48;
  const rect = ok(r.width) && ok(r.height) ? r : { x: r.x, y: r.y + r.height - NOTE_SIZE, width: NOTE_SIZE, height: NOTE_SIZE };
  return importedObject<NoteObject>(src, {
    kind: 'note',
    rect,
    color: src.common.color ?? NOTE_DEFAULTS.color,
    fillColor: null,
    strokeWidth: undefined,
    locked: locked(src),
    // Always upright (NoRotate): a /Rotate entry doesn't apply to sticky notes.
    data: { icon },
  });
}

// ── markups ─────────────────────────────────────────────────────────────────

const MARKUP_OF: Record<string, MarkupType> = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly' };

function importMarkup(src: AnnotationSource): MarkupObject | null {
  if (src.common.hidden) return null;
  const type = MARKUP_OF[src.subtype];
  if (!type) return null;
  let quads = normalizeQuads(src.nums('QuadPoints'));
  if (!quads.length) {
    const r = src.common.rect;
    if (r.width <= 0 || r.height <= 0) return null;
    quads = quadFromRect(r, normRotation(src.page.rotation) as TextDir);
  }
  const text = markedText(src);
  return importedObject<MarkupObject>(src, {
    kind: 'text-markup',
    rect: quadsBBox(quads),
    color: src.common.color ?? MARKUP_COLORS[type],
    fillColor: null,
    strokeWidth: undefined,
    locked: locked(src),
    data: text !== undefined ? { type, quads, text } : { type, quads, text: '', textPending: true },
  });
}

// ── caret / replace text ────────────────────────────────────────────────────

function importCaret(src: AnnotationSource): CaretObject | null {
  if (src.common.hidden) return null;
  const caret = innerRect(src);
  if (caret.width <= 0 || caret.height <= 0) return null;
  const dir = textDir(src);
  const data: CaretData = { caret, dir: dir || undefined, symbol: src.name('Sy') === 'P' ? 'P' : 'None' };
  return importedObject<CaretObject>(src, {
    kind: 'caret',
    rect: caret,
    color: src.common.color ?? '#1473e6',
    fillColor: null,
    strokeWidth: undefined,
    locked: locked(src),
    data,
  });
}

function mergeStrike(primary: PdfObject, member: AnnotationSource): PdfObject | null {
  if (primary.kind !== 'caret' || member.subtype !== 'StrikeOut') return null;
  const p = primary as CaretObject;
  if (p.data.strike) return null;
  const quads = normalizeQuads(member.nums('QuadPoints'));
  if (!quads.length) return null;
  const text = markedText(member);
  const data: CaretData = {
    ...p.data,
    strike: text !== undefined ? { quads, text } : { quads, text: '', textPending: true },
  };
  return { ...p, data, rect: caretBounds(data) };
}

// ── FreeText ────────────────────────────────────────────────────────────────

function fontFamilyOf(s: string | undefined): FontFamily | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (/cour|mono/.test(v)) return 'Courier';
  if (/tiro|times|serif(?!.*sans)|tibo|tiit|georgia|minion/.test(v) && !/sans/.test(v)) return 'Times';
  if (/helv|arial|sans|myriad|verdana|tahoma|calibri/.test(v)) return 'Helvetica';
  return undefined;
}

function colorFromOps(ops: string, which: 'fill' | 'stroke'): string | undefined {
  const re = which === 'fill' ? /((?:-?[\d.]+\s+){1,4})(rg|g|k)(?![\w])/g : /((?:-?[\d.]+\s+){1,4})(RG|G|K)(?![\w])/g;
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = re.exec(ops))) {
    const v = m[1].trim().split(/\s+/).map(Number);
    const op = m[2].toLowerCase();
    const cl = (x: number) => Math.min(1, Math.max(0, x));
    if (op === 'g' && v.length >= 1) {
      const g = cl(v[v.length - 1]);
      last = rgb01ToHex(g, g, g);
    } else if (op === 'rg' && v.length >= 3) {
      const [r, g, b] = v.slice(-3).map(cl);
      last = rgb01ToHex(r, g, b);
    } else if (op === 'k' && v.length >= 4) {
      const [c, mm, y, k] = v.slice(-4).map(cl);
      last = rgb01ToHex((1 - c) * (1 - k), (1 - mm) * (1 - k), (1 - y) * (1 - k));
    }
  }
  return last;
}

interface CssStyle {
  family?: FontFamily;
  size?: number;
  color?: string;
  align?: TextAlign;
}

function parseCssColor(v: string): string | undefined {
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (m) return rgb01ToHex(+m[1] / 255, +m[2] / 255, +m[3] / 255);
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000' };
  return named[s];
}

function parseCss(css: string | undefined): CssStyle {
  const out: CssStyle = {};
  if (!css) return out;
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim();
    if (k === 'font') {
      // "Helvetica,sans-serif 12.0pt" / "italic bold 12pt Arial"
      const size = /([\d.]+)\s*pt/.exec(v);
      if (size) out.size = parseFloat(size[1]);
      out.family = fontFamilyOf(v.replace(/[\d.]+\s*pt/, '')) ?? out.family;
    } else if (k === 'font-family') out.family = fontFamilyOf(v) ?? out.family;
    else if (k === 'font-size') {
      const size = /([\d.]+)\s*(pt|px)?/.exec(v);
      if (size) out.size = parseFloat(size[1]);
    } else if (k === 'color') out.color = parseCssColor(v) ?? out.color;
    else if (k === 'text-align') {
      const a = v.toLowerCase();
      if (a === 'center' || a === 'right' || a === 'left') out.align = a;
      else if (a === 'end') out.align = 'right';
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(c) ? String.fromCodePoint(c) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text + base style of a /RC rich text string. */
export function parseRichText(rc: string | undefined): { text?: string; style: CssStyle } {
  if (!rc) return { style: {} };
  const body = /<body\b([^>]*)>/i.exec(rc);
  const bodyStyle = body ? /style\s*=\s*"([^"]*)"/i.exec(body[1])?.[1] : undefined;
  const firstSpan = /<(?:p|span)\b[^>]*style\s*=\s*"([^"]*)"/i.exec(rc)?.[1];
  const style = { ...parseCss(bodyStyle), ...parseCss(firstSpan) };
  let inner = body ? rc.slice(body.index + body[0].length) : rc;
  inner = inner.replace(/<\/body>[\s\S]*$/i, '');
  const text = decodeEntities(
    inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\u200b/g, '')
    .replace(/\n$/, '');
  return { text, style };
}

const normNewlines = (s: string) => s.replace(/\r\n?/g, '\n');

async function importFreeText(src: AnnotationSource): Promise<FreeTextObject | null> {
  if (src.common.hidden) return null;
  const c = src.common;
  const da = src.text('DA') ?? '';
  const ds = parseCss(src.text('DS'));
  const rc = parseRichText(src.text('RC'));
  const daFont = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da);
  const font: FontFamily = ds.family ?? rc.style.family ?? fontFamilyOf(daFont?.[1]) ?? 'Helvetica';
  const daSize = daFont ? parseFloat(daFont[2]) : NaN;
  const fontSize = Math.max(1, ds.size ?? rc.style.size ?? (daSize > 0 ? daSize : 12));
  const textColor = ds.color ?? rc.style.color ?? colorFromOps(da, 'fill') ?? '#000000';
  const q = src.num('Q');
  const align: TextAlign = q === 1 ? 'center' : q === 2 ? 'right' : q === 0 ? 'left' : ds.align ?? rc.style.align ?? 'left';
  const itName = src.name('IT');
  const text = normNewlines(c.contents ?? rc.text ?? '');
  const cl = src.nums('CL');
  const intent: FreeTextIntent = itName === 'FreeTextTypeWriter' ? 'FreeTextTypeWriter' : cl && cl.length >= 4 ? 'FreeTextCallout' : itName === 'FreeTextCallout' ? 'FreeTextCallout' : 'FreeText';
  const border = colorFromOps(da, 'stroke') ?? c.color;
  const bsW = src.get('BS');
  const hasWidth = bsW instanceof PDFDict ? bsW.get(PDFName.of('W')) instanceof PDFNumber : !!src.nums('Border');
  const strokeWidth = intent === 'FreeTextTypeWriter' ? 0 : hasWidth ? c.strokeWidth : 1;
  const rot = rotateOf(src);
  const le = src.get('LE');
  const leName = le instanceof PDFName ? le.decodeText() : undefined;
  const lineEnding = (['OpenArrow', 'ClosedArrow', 'Circle', 'Square', 'None'] as const).find((v) => v === leName);

  let rect = c.rect;
  let callout: FreeTextData['callout'];
  if (intent === 'FreeTextCallout' && cl && cl.length >= 4) {
    const pts: Point[] = [];
    for (let i = 0; i + 1 < cl.length && pts.length < 3; i += 2) pts.push({ x: cl[i], y: cl[i + 1] });
    callout = { box: innerRect(src), points: pts };
    if (!src.nums('RD')) {
      // No /RD: the box is the part of /Rect away from the leader's anchor (best effort).
      callout.box = boxAwayFromAnchor(c.rect, pts);
    }
    rect = c.rect;
  }
  const box = callout ? callout.box : rect;
  const { h } = frameSizeOf(box, rot);
  if (box.width < 1 || box.height < 1) return null;
  // Our own boxes remember how they size themselves; foreign ones keep their size as a minimum.
  const aw = src.get(FT_AUTO_WIDTH_KEY);
  const autoWidth = aw instanceof PDFBool && aw.asBoolean();
  const minH = src.num(FT_MIN_HEIGHT_KEY);
  const data: FreeTextData = {
    text,
    font,
    fontSize,
    textColor,
    align,
    intent,
    rotate: rot || undefined,
    autoWidth: autoWidth && !callout,
    minHeight: minH !== undefined ? minH : Math.max(MIN_BOX, h),
    callout,
    lineEnding: callout ? lineEnding ?? 'None' : undefined,
  };
  const obj = importedObject<FreeTextObject>(src, {
    kind: 'freetext',
    rect,
    color: border,
    fillColor: c.fillColor ?? null,
    strokeWidth,
    contents: text || undefined,
    locked: locked(src),
    data,
  });
  if (callout) {
    // Our own callouts always have /Rect = bounds of the drawing; keep foreign rects as they are.
    const b = calloutBounds(callout, strokeWidth ?? 1);
    if (Math.abs(b.width - rect.width) < 0.01 && Math.abs(b.height - rect.height) < 0.01) obj.rect = b;
  }
  try {
    const ap = await src.preserveAppearance();
    if (ap) obj.data = { ...obj.data, preserved: { ap, sig: freeTextSig(obj) } };
  } catch {
    /* regenerate on export */
  }
  return obj;
}

function boxAwayFromAnchor(r: Rect, pts: Point[]): Rect {
  const a = pts[0];
  const attach = pts[pts.length - 1];
  if (!a || !attach) return r;
  // Split /Rect at the attach point on the axis where the leader runs.
  const dx = Math.abs(attach.x - a.x);
  const dy = Math.abs(attach.y - a.y);
  if (dx >= dy) {
    if (a.x < attach.x) return { ...r, x: attach.x, width: Math.max(MIN_BOX, r.x + r.width - attach.x) };
    return { ...r, width: Math.max(MIN_BOX, attach.x - r.x) };
  }
  if (a.y < attach.y) return { ...r, y: attach.y, height: Math.max(MIN_BOX, r.y + r.height - attach.y) };
  return { ...r, height: Math.max(MIN_BOX, attach.y - r.y) };
}

// ── FileAttachment ──────────────────────────────────────────────────────────

function asDict(src: AnnotationSource, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? src.lib.context.lookup(o) : o;
  return v instanceof PDFStream ? v.dict : v instanceof PDFDict ? v : undefined;
}
function strOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
}

function streamBytes(src: AnnotationSource, o: PDFObject | undefined): { bytes: Uint8Array; dict: PDFDict } | null {
  const v = o instanceof PDFRef ? src.lib.context.lookup(o) : o;
  if (!(v instanceof PDFStream)) return null;
  try {
    const bytes = v instanceof PDFRawStream ? decodePDFRawStream(v).decode() : v.getContents();
    return { bytes: new Uint8Array(bytes), dict: v.dict };
  } catch (err) {
    console.warn('[comments] could not decode an embedded file', err);
    return null;
  }
}

const ATTACH_NAMES = new Set<string>(ATTACH_ICONS.map((i) => i.value));

function importAttachment(src: AnnotationSource): AttachmentObject | null {
  if (src.common.hidden) return null;
  const fs = asDict(src, src.dict.get(PDFName.of('FS')));
  if (!fs) return null;
  const ef = asDict(src, fs.get(PDFName.of('EF')));
  if (!ef) return null;
  const file = streamBytes(src, ef.get(PDFName.of('UF')) ?? ef.get(PDFName.of('F')));
  if (!file) return null;
  const lookup = (d: PDFDict, k: string) => {
    const v = d.get(PDFName.of(k));
    return v instanceof PDFRef ? src.lib.context.lookup(v) : v;
  };
  const fileName = strOf(lookup(fs, 'UF')) || strOf(lookup(fs, 'F')) || 'attachment';
  const description = strOf(lookup(fs, 'Desc')) || undefined;
  const st = lookup(file.dict, 'Subtype');
  const mime = st instanceof PDFName ? st.decodeText() : undefined;
  const params = asDict(src, file.dict.get(PDFName.of('Params')));
  const mod = params ? strOf(lookup(params, 'ModDate')) : undefined;
  const modIso = mod ? parsePdfDate(mod) : undefined;
  const modMs = modIso ? Date.parse(modIso) : NaN;
  const name = src.name('Name');
  const icon = (name && ATTACH_NAMES.has(name) ? name : 'PushPin') as AttachIcon;
  const rot = rotateOf(src);
  return importedObject<AttachmentObject>(src, {
    kind: 'file-attachment',
    color: src.common.color ?? ATTACH_DEFAULTS.color,
    fillColor: null,
    strokeWidth: undefined,
    locked: locked(src),
    data: {
      fileName: baseFileName(fileName),
      mimeType: mime && mime.includes('/') ? mime : mimeFromName(fileName),
      size: file.bytes.length,
      bytes: file.bytes,
      description,
      icon,
      rotate: rot || undefined,
      fileModified: Number.isFinite(modMs) ? modMs : undefined,
    },
  });
}

function baseFileName(s: string): string {
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

// ── registration ────────────────────────────────────────────────────────────

let registered = false;
export function registerCommentImporters() {
  if (registered) return;
  registered = true;
  registerAnnotationImporter({ id: 'comments-note', subtypes: ['Text'], import: importNote });
  registerAnnotationImporter({ id: 'comments-markup', subtypes: ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'], import: importMarkup });
  registerAnnotationImporter({ id: 'comments-caret', subtypes: ['Caret'], import: importCaret, importGroupMember: (primary, member) => mergeStrike(primary, member) });
  registerAnnotationImporter({ id: 'comments-freetext', subtypes: ['FreeText'], import: importFreeText });
  registerAnnotationImporter({ id: 'comments-attachment', subtypes: ['FileAttachment'], import: importAttachment });
}
