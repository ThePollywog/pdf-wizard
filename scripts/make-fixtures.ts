/**
 * Generates the test fixtures in fixtures/ (npm run fixtures).
 *
 *   sample.pdf        6-page report: headings, prose, numbered list, ruled table, linked TOC,
 *                     external link, nested outline, Helvetica + Times
 *   form.pdf          AcroForm with text/multiline/date/numeric fields, check boxes, radio group,
 *                     dropdown, list box and a signature field
 *   annotated.pdf     2 pages of existing annotations with appearance streams
 *   scanned.pdf       2 image-only pages (no text layer) for OCR
 *   encrypted.pdf     user password "secret", owner password "owner"
 *   rotated.pdf       /Rotate 0/90/180/270, offset MediaBox, CropBox
 *   mixed-sizes.pdf   Letter, A4, Legal, Letter landscape, A6
 *   large.pdf         300 pages
 *   images.pdf        3 pages with large embedded images (2 JPEG q95, 1 PNG)
 *   sample.docx/.xlsx/.csv/.png/.jpg/.txt/.html
 *   README.md         generated: documents every fixture and the facts tests rely on
 *
 * Content is deterministic (fixed dates, seeded noise); bytes may differ between runs (pdf-lib picks
 * random font resource names, encryption uses a random salt).
 * Every PDF is verified afterwards with pdftotext/pdftoppm when poppler is installed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  PDFDict,
  PDFArray,
  PDFStream,
  type PDFObject,
  StandardFonts,
  TextAlignment,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type Color,
  type RGB,
} from '@cantoo/pdf-lib';
import sharp from 'sharp';
import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { findExecutable, run, sofficeConvert, withTempDir } from './lib/exec';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'fixtures');

const FIXED_DATE = new Date('2026-01-15T10:00:00Z');
const pdfDate = (d: Date) => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

// ─────────────────────────────────────────────────────────────────────────────
// small utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (h: string): RGB => {
  const v = h.replace('#', '');
  return rgb(parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255);
};
const rgbArr = (c: RGB): [number, number, number] => [c.red, c.green, c.blue];
const num = (v: number) => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};
const escPdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const text = (s: string) => PDFHexString.fromText(s);
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

function setInfo(doc: PDFDocument, info: { title: string; author: string; subject?: string; keywords?: string[] }) {
  doc.setTitle(info.title);
  doc.setAuthor(info.author);
  if (info.subject) doc.setSubject(info.subject);
  if (info.keywords) doc.setKeywords(info.keywords);
  doc.setCreator('PDF Wizard fixtures (scripts/make-fixtures.ts)');
  doc.setProducer('@cantoo/pdf-lib');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
}

async function save(name: string, bytes: Uint8Array | Buffer | string) {
  const file = path.join(OUT, name);
  await fsp.writeFile(file, bytes);
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  console.log(`  ${name.padEnd(18)} ${(size / 1024).toFixed(size > 1024 * 1024 ? 0 : 1).padStart(8)} kB`);
  return file;
}

interface Fonts {
  helv: PDFFont;
  helvB: PDFFont;
  helvI: PDFFont;
  times: PDFFont;
  timesB: PDFFont;
  timesI: PDFFont;
  courier: PDFFont;
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  return {
    helv: await doc.embedFont(StandardFonts.Helvetica),
    helvB: await doc.embedFont(StandardFonts.HelveticaBold),
    helvI: await doc.embedFont(StandardFonts.HelveticaOblique),
    times: await doc.embedFont(StandardFonts.TimesRoman),
    timesB: await doc.embedFont(StandardFonts.TimesRomanBold),
    timesI: await doc.embedFont(StandardFonts.TimesRomanItalic),
    courier: await doc.embedFont(StandardFonts.Courier),
  };
}

function wrap(str: string, font: PDFFont, size: number, width: number): string[] {
  const words = str.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && font.widthOfTextAtSize(next, size) > width) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page writer (flowing layout + text bookkeeping)
// ─────────────────────────────────────────────────────────────────────────────

interface LaidLine {
  text: string;
  x: number;
  baseline: number;
  /** offset of this line in the paragraph string (words joined by single spaces) */
  start: number;
}
interface LaidParagraph {
  text: string;
  font: PDFFont;
  size: number;
  lines: LaidLine[];
}

/** Records every string drawn per page (for facts like "PDF Wizard appears N times"). */
class TextLog {
  pages: string[][] = [];
  add(page: number, s: string) {
    (this.pages[page] ??= []).push(s);
  }
  count(needle: string, page?: number) {
    const list = page === undefined ? this.pages.flat() : this.pages[page] ?? [];
    return list.reduce((n, s) => n + countOf(s, needle), 0);
  }
}

class PageWriter {
  y: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  anchors: Record<string, { page: number; top: number }> = {};

  constructor(
    readonly page: PDFPage,
    readonly index: number,
    readonly fonts: Fonts,
    readonly log: TextLog,
    opts: { left?: number; right?: number; top?: number; bottom?: number } = {},
  ) {
    this.left = opts.left ?? 72;
    this.right = opts.right ?? page.getWidth() - 72;
    this.y = opts.top ?? page.getHeight() - 72;
    this.bottom = opts.bottom ?? 72;
  }

  get width() {
    return this.right - this.left;
  }

  private check() {
    if (this.y < this.bottom) throw new Error(`page ${this.index + 1} overflows (y=${this.y.toFixed(1)})`);
  }

  text(s: string, x: number, y: number, font: PDFFont, size: number, color: Color = rgb(0.1, 0.1, 0.1)) {
    this.page.drawText(s, { x, y, font, size, color });
    this.log.add(this.index, s);
  }

  heading(s: string, level: 1 | 2, anchor = s) {
    const size = level === 1 ? 19 : 13.5;
    this.y -= level === 1 ? 22 : 14;
    const top = this.y + 4;
    this.y -= size;
    this.text(s, this.left, this.y, this.fonts.helvB, size, level === 1 ? hex('#1d1d1f') : hex('#2b3a55'));
    if (level === 1) {
      this.page.drawLine({
        start: { x: this.left, y: this.y - 7 },
        end: { x: this.right, y: this.y - 7 },
        thickness: 0.75,
        color: hex('#c9c9c9'),
      });
      this.y -= 18;
    } else this.y -= 9;
    this.anchors[anchor] = { page: this.index, top };
    this.check();
  }

  paragraph(
    s: string,
    opts: { font?: PDFFont; size?: number; leading?: number; indent?: number; after?: number; color?: Color; x?: number; width?: number } = {},
  ): LaidParagraph {
    const font = opts.font ?? this.fonts.times;
    const size = opts.size ?? 11.5;
    const leading = opts.leading ?? size * 1.42;
    const x = (opts.x ?? this.left) + (opts.indent ?? 0);
    const width = (opts.width ?? this.width) - (opts.indent ?? 0);
    const normalized = s.split(/\s+/).filter(Boolean).join(' ');
    const lines = wrap(normalized, font, size, width);
    const laid: LaidLine[] = [];
    let offset = 0;
    for (const line of lines) {
      this.y -= leading;
      this.text(line, x, this.y + (leading - size) * 0.35, font, size, opts.color);
      laid.push({ text: line, x, baseline: this.y + (leading - size) * 0.35, start: offset });
      offset += line.length + 1;
    }
    this.y -= opts.after ?? 7;
    this.check();
    return { text: normalized, font, size, lines: laid };
  }

  numberedList(items: string[], opts: { size?: number } = {}) {
    const size = opts.size ?? 11.5;
    const indent = 26;
    items.forEach((item, i) => {
      const label = `${i + 1}.`;
      const yBefore = this.y;
      const p = this.paragraph(item, { size, indent, after: 3 });
      const first = p.lines[0];
      this.text(label, this.left + 8, first.baseline, this.fonts.times, size);
      void yBefore;
    });
    this.y -= 5;
    this.check();
  }

  space(h: number) {
    this.y -= h;
    this.check();
  }
}

/** Quadrilaterals (conventional order: TL, TR, BL, BR) covering `phrase` inside a laid-out paragraph. */
function phraseQuads(p: LaidParagraph, phrase: string, occurrence = 0): number[][] {
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = p.text.indexOf(phrase, idx + 1);
    if (idx < 0) throw new Error(`phrase not found: ${phrase}`);
  }
  const end = idx + phrase.length;
  const quads: number[][] = [];
  for (const line of p.lines) {
    const ls = line.start;
    const le = line.start + line.text.length;
    const s = Math.max(idx, ls);
    const e = Math.min(end, le);
    if (s >= e) continue;
    const x0 = line.x + p.font.widthOfTextAtSize(line.text.slice(0, s - ls), p.size);
    const x1 = line.x + p.font.widthOfTextAtSize(line.text.slice(0, e - ls), p.size);
    const y0 = line.baseline - p.size * 0.22;
    const y1 = line.baseline + p.size * 0.8;
    quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  return quads;
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level PDF objects: outlines, links, annotations
// ─────────────────────────────────────────────────────────────────────────────

interface OutlineNode {
  title: string;
  page: number;
  top?: number;
  open?: boolean;
  bold?: boolean;
  italic?: boolean;
  color?: RGB;
  children?: OutlineNode[];
}

function addOutline(doc: PDFDocument, nodes: OutlineNode[]) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const rootRef = ctx.nextRef();
  const build = (list: OutlineNode[], parent: PDFRef): { first: PDFRef; last: PDFRef; visible: number } => {
    const refs = list.map(() => ctx.nextRef());
    let visible = 0;
    list.forEach((n, i) => {
      const page = pages[n.page];
      const dict: Record<string, unknown> = {
        Title: text(n.title),
        Parent: parent,
        Dest: [page.ref, 'XYZ', null, n.top ?? page.getHeight(), null],
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < list.length - 1) dict.Next = refs[i + 1];
      if (n.bold || n.italic) dict.F = (n.italic ? 1 : 0) | (n.bold ? 2 : 0);
      if (n.color) dict.C = rgbArr(n.color);
      visible += 1;
      if (n.children?.length) {
        const sub = build(n.children, refs[i]);
        dict.First = sub.first;
        dict.Last = sub.last;
        dict.Count = n.open ? sub.visible : -sub.visible;
        if (n.open) visible += sub.visible;
      }
      ctx.assign(refs[i], ctx.obj(dict as never));
    });
    return { first: refs[0], last: refs[refs.length - 1], visible };
  };
  const top = build(nodes, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.visible }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

function addLinkToPage(doc: PDFDocument, page: PDFPage, rect: number[], target: PDFPage, top: number) {
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect,
      Border: [0, 0, 0],
      F: 4,
      Dest: [target.ref, 'XYZ', null, top, null],
    }),
  );
  page.node.addAnnot(ref);
}

function addLinkToUrl(doc: PDFDocument, page: PDFPage, rect: number[], url: string) {
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect,
      Border: [0, 0, 0],
      F: 4,
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    }),
  );
  page.node.addAnnot(ref);
}

const AP_FONTS = {
  Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' },
  HeBo: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold', Encoding: 'WinAnsiEncoding' },
};

/** Register an annotation (with an optional normal appearance stream whose BBox = Rect, in page space). */
function addAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  dict: Record<string, unknown>,
  ap?: { ops: string; resources?: Record<string, unknown> },
): PDFRef {
  const ctx = doc.context;
  const full: Record<string, unknown> = { Type: 'Annot', F: 4, P: page.ref, ...dict };
  if (ap) {
    const rect = dict.Rect as number[];
    const stream = ctx.flateStream(ap.ops, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: rect,
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: (ap.resources ?? {}) as never,
    });
    full.AP = { N: ctx.register(stream) };
  }
  const ref = ctx.register(ctx.obj(full as never));
  page.node.addAnnot(ref);
  return ref;
}

const bboxOfQuads = (quads: number[][], pad = 0): number[] => {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
};
const bboxOfPoints = (pts: number[][], pad: number): number[] => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
};
const ellipsePath = (x0: number, y0: number, x1: number, y1: number) => {
  const k = 0.5523;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  const n = num;
  return [
    `${n(cx + rx)} ${n(cy)} m`,
    `${n(cx + rx)} ${n(cy + k * ry)} ${n(cx + k * rx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
    `${n(cx - k * rx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + k * ry)} ${n(cx - rx)} ${n(cy)} c`,
    `${n(cx - rx)} ${n(cy - k * ry)} ${n(cx - k * rx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
    `${n(cx + k * rx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - k * ry)} ${n(cx + rx)} ${n(cy)} c`,
  ].join('\n');
};
const colorOps = (c: RGB, stroke = false) => `${num(c.red)} ${num(c.green)} ${num(c.blue)} ${stroke ? 'RG' : 'rg'}`;

// ─────────────────────────────────────────────────────────────────────────────
// sample.pdf
// ─────────────────────────────────────────────────────────────────────────────

const facts: Record<string, unknown> = {};

async function makeSample() {
  const doc = await PDFDocument.create();
  setInfo(doc, {
    title: 'PDF Wizard: Document Workflows in the Browser',
    author: 'Document Platform Team',
    subject: 'Technical overview and product report',
    keywords: ['PDF', 'workflow', 'browser', 'report'],
  });
  const f = await embedFonts(doc);
  const log = new TextLog();
  const pages = Array.from({ length: 6 }, () => doc.addPage([612, 792]));
  const W = new Map<number, PageWriter>();
  const writer = (i: number, opts?: ConstructorParameters<typeof PageWriter>[4]) => {
    const w = new PageWriter(pages[i], i, f, log, opts);
    W.set(i, w);
    return w;
  };
  const anchors: Record<string, { page: number; top: number }> = {};

  // Running header/footer (pages 2-6)
  for (let i = 1; i < 6; i++) {
    const p = pages[i];
    const w = new PageWriter(p, i, f, log);
    w.text('Document Workflows in the Browser', 72, 750, f.helv, 9, hex('#6e6e6e'));
    const right = 'January 2026';
    w.text(right, 540 - f.helv.widthOfTextAtSize(right, 9), 750, f.helv, 9, hex('#6e6e6e'));
    p.drawLine({ start: { x: 72, y: 743 }, end: { x: 540, y: 743 }, thickness: 0.5, color: hex('#d0d0d0') });
    const footer = `Page ${i + 1} of 6`;
    w.text(footer, 306 - f.helv.widthOfTextAtSize(footer, 9) / 2, 40, f.helv, 9, hex('#6e6e6e'));
  }

  // ── Page 1: title page ────────────────────────────────────────────────────
  {
    const p = pages[0];
    const w = writer(0);
    p.drawRectangle({ x: 0, y: 792 - 300, width: 612, height: 300, color: hex('#26262b') });
    p.drawRectangle({ x: 0, y: 792 - 308, width: 612, height: 8, color: hex('#eb1000') });
    // document glyph
    p.drawSvgPath('M0 0 L40 0 L56 16 L56 72 L0 72 Z', { x: 72, y: 792 - 70, color: hex('#eb1000') });
    p.drawSvgPath('M40 0 L40 16 L56 16 Z', { x: 72, y: 792 - 70, color: hex('#ff6a4d') });
    w.text('PDF Wizard', 72, 792 - 200, f.helvB, 46, rgb(1, 1, 1));
    w.text('Document Workflows in the Browser', 72, 792 - 238, f.helv, 21, hex('#e8e8ea'));
    anchors['Title'] = { page: 0, top: 792 };
    w.y = 792 - 350;
    w.text('Technical Overview and Product Report', 72, w.y, f.timesI, 17, hex('#333333'));
    w.y -= 26;
    w.text('Prepared by the Document Platform Team', 72, w.y, f.helv, 12, hex('#444444'));
    w.y -= 18;
    w.text('January 2026  |  Version 1.0', 72, w.y, f.helv, 12, hex('#6e6e6e'));
    w.y -= 30;
    w.heading('Abstract', 2);
    w.paragraph(
      `PDF Wizard brings the core capabilities of a desktop PDF editor to any modern browser. This report explains how
       documents are opened, rendered, annotated, filled, signed and exported without installing software, and how a
       small companion server handles the few tasks that browsers cannot perform well, such as converting office files,
       recognizing text in scans and compressing large documents. We describe the architecture, walk through common
       review and form workflows, summarize performance measurements and outline the work that remains.`,
      { size: 12 },
    );
    p.drawLine({ start: { x: 72, y: 96 }, end: { x: 540, y: 96 }, thickness: 0.5, color: hex('#d0d0d0') });
    w.text('For internal distribution. Sample document generated for automated tests.', 72, 80, f.helvI, 9, hex('#8a8a8a'));
  }

  // ── Pages 3-6 first (so TOC can link to heading anchors) ────────────────────
  {
    const w = writer(2, { top: 720 });
    w.heading('1 Introduction', 1);
    w.paragraph(`Portable Document Format files remain the common currency of business, government and education.
      Contracts, invoices, research papers and application forms are exchanged as PDF because the format preserves
      layout exactly, embeds fonts and images, and can be displayed identically on every device. Yet the tools used to
      work with these files have traditionally been desktop applications that must be installed, licensed and updated
      on each machine.`);
    w.paragraph(`PDF Wizard takes a different approach. The entire editor runs inside the browser tab, using a JavaScript
      rendering engine for display and a separate library for writing changes back into the file. Documents never leave
      the device unless the user explicitly saves them to the shared library or requests a server-side conversion.`);
    w.heading('1.1 Background', 2);
    w.paragraph(`Early browser viewers could display a PDF but offered little beyond scrolling and printing. Over the last
      decade, rendering engines have matured to the point where text selection, search, form filling and accurate font
      rendering are available in every major browser. At the same time, teams have moved their work into web
      applications, and switching to a separate desktop program just to comment on a document has become a noticeable
      interruption.`);
    w.paragraph(`Several needs appear again and again in interviews with users: reviewing a draft with colleagues, filling
      and signing a form, combining several files into one package, and removing sensitive information before a
      document is shared outside the organization.`);
    w.heading('1.2 Goals', 2);
    w.paragraph(`The project set out to deliver the familiar PDF Wizard experience with three guiding goals. First, fidelity:
      pages must look exactly as they do in the desktop product, including rotated pages, unusual page sizes and
      embedded fonts. Second, responsiveness: opening a large report should feel instant, and editing tools should
      react within a single animation frame. Third, safety: every change must be reversible until the user saves, and
      the original file must never be altered in place.`);
    Object.assign(anchors, w.anchors);
  }
  {
    const w = writer(3, { top: 720 });
    w.heading('2 Document Workflows', 1);
    w.paragraph(`A workflow is the sequence of steps a document passes through between its first draft and its final,
      approved form. PDF Wizard supports the workflows that users mentioned most often, and each one is available from
      the All tools page as well as from the quick tools rail beside the document.`);
    w.heading('2.1 Reviewing and Commenting', 2);
    w.paragraph(`Reviewers can highlight, underline or strike out text, attach sticky notes, draw shapes and add
      free-form ink. Every comment records its author and the time it was made, and replies are threaded under the
      original note. A typical review follows these steps:`);
    w.numberedList([
      'Open the draft from the library or drag it into the browser window.',
      'Select the Comment tool and highlight passages that need attention.',
      'Add sticky notes with questions, and reply to notes left by other reviewers.',
      'Filter the comment list by author or status to keep track of open issues.',
      'Save the reviewed copy, or export the comments as a summary for the author.',
    ]);
    w.paragraph(`Because comments are stored as standard PDF annotations, a document reviewed in PDF Wizard can be opened
      in any other conforming viewer and every note will appear in the expected place.`);
    w.heading('2.2 Preparing Forms', 2);
    w.paragraph(`Many organizations still distribute paper forms that have been scanned into PDF. The form preparation
      tool detects labels and boxes on such pages and proposes text fields, check boxes and signature areas. Authors
      can then adjust each field, set its name and tooltip, and mark it as required. Recipients fill the form directly
      in the browser, and the values are written into the file when it is saved.`);
    Object.assign(anchors, w.anchors);
  }
  {
    const p = pages[4];
    const w = writer(4, { top: 720 });
    w.heading('3 Performance', 1);
    w.paragraph(`Performance was measured on a mid-range laptop using a set of representative documents, ranging from a
      two-page letter to a three-hundred-page technical manual. Each operation was repeated twenty times after a
      warm-up run, and the median and 95th percentile durations were recorded. Table 1 summarizes the results.`);
    w.heading('3.1 Benchmarks', 2);
    // Table 1
    const cols = [200, 88, 90, 90];
    const rows = [
      ['Operation', 'Document', 'Median (ms)', '95th pct (ms)'],
      ['Open and render first page', '300 pages', '180', '240'],
      ['Render page at 200% zoom', '6 pages', '45', '70'],
      ['Full-text search', '300 pages', '310', '420'],
      ['Add 50 comments', '6 pages', '22', '35'],
      ['Export with annotations', '6 pages', '140', '190'],
      ['Compress (server)', '42 MB', '2,900', '3,600'],
    ];
    const rowH = 22;
    const tableTop = w.y - 6;
    anchors['Table 1'] = { page: 4, top: tableTop + 4 };
    const x0 = w.left;
    const tableW = cols.reduce((a, b) => a + b, 0);
    p.drawRectangle({ x: x0, y: tableTop - rowH, width: tableW, height: rowH, color: hex('#eceef3') });
    rows.forEach((row, r) => {
      const yb = tableTop - (r + 1) * rowH + 7;
      let cx = x0;
      row.forEach((cell, c) => {
        const font = r === 0 ? f.helvB : f.helv;
        const size = 10;
        const tw = font.widthOfTextAtSize(cell, size);
        const tx = c === 0 ? cx + 8 : c === 1 ? cx + 8 : cx + cols[c] - 8 - tw;
        w.text(cell, tx, yb, font, size, hex('#1d1d1f'));
        cx += cols[c];
      });
    });
    for (let r = 0; r <= rows.length; r++) {
      const y = tableTop - r * rowH;
      p.drawLine({
        start: { x: x0, y },
        end: { x: x0 + tableW, y },
        thickness: r === 0 || r === rows.length ? 1 : r === 1 ? 0.9 : 0.4,
        color: hex(r === 0 || r === rows.length || r === 1 ? '#555555' : '#b5b5b5'),
      });
    }
    let vx = x0;
    for (let c = 0; c <= cols.length; c++) {
      p.drawLine({
        start: { x: vx, y: tableTop },
        end: { x: vx, y: tableTop - rows.length * rowH },
        thickness: c === 0 || c === cols.length ? 1 : 0.4,
        color: hex(c === 0 || c === cols.length ? '#555555' : '#b5b5b5'),
      });
      vx += cols[c] ?? 0;
    }
    w.y = tableTop - rows.length * rowH - 4;
    w.paragraph('Table 1: Median and 95th percentile timings for common operations.', {
      font: f.timesI,
      size: 10,
      after: 10,
    });
    facts.sampleTable = { page: 5, rows: rows.length, cols: cols.length, rect: [x0, tableTop - rows.length * rowH, x0 + tableW, tableTop], header: rows[0] };
    w.paragraph(`Rendering dominates the cost of opening a document, so pages are drawn lazily as they scroll into view
      and thumbnails are generated in the background at low resolution. Text for search is extracted page by page and
      cached, which keeps the first search in a long document under half a second. Operations that rewrite the file,
      such as exporting or compressing, run away from the main thread so that scrolling stays smooth.`);
    w.paragraph(`The largest remaining cost is server-side compression of image-heavy scans, which is bounded by the time
      needed to re-encode each image. PDF Wizard shows progress for such tasks and lets the user continue working
      while they complete.`);
    Object.assign(anchors, w.anchors);
  }
  let externalLinkRect: number[] = [];
  {
    const p = pages[5];
    const w = writer(5, { top: 720 });
    w.heading('4 Conclusion', 1);
    w.paragraph(`PDF Wizard demonstrates that a complete document editor can live comfortably in the browser. Viewing,
      commenting, form filling, page organization and export all run locally, while a small server provides
      conversion, text recognition and compression when they are needed. Early users report that the tools feel
      familiar and that removing the installation step has made it easier to involve occasional reviewers.`);
    w.paragraph(`Future work will focus on accessibility tagging, side-by-side comparison of document versions, and
      deeper integration with electronic signature services. We also plan to publish the benchmark documents so that
      others can reproduce the measurements in Table 1.`);
    w.heading('4.1 Further Reading', 2);
    w.paragraph(`The PDF specification is maintained as the international standard ISO 32000. Additional material,
      including release notes and a list of supported features, is available on the project website:`);
    const url = 'https://example.com';
    w.y -= 16;
    const size = 11.5;
    const tw = f.helv.widthOfTextAtSize(url, size);
    w.text(url, w.left + 24, w.y, f.helv, size, hex('#0b57d0'));
    p.drawLine({ start: { x: w.left + 24, y: w.y - 1.5 }, end: { x: w.left + 24 + tw, y: w.y - 1.5 }, thickness: 0.6, color: hex('#0b57d0') });
    externalLinkRect = [w.left + 22, w.y - 4, w.left + 26 + tw, w.y + size + 1];
    addLinkToUrl(doc, p, externalLinkRect, url);
    w.y -= 12;
    w.paragraph(`Questions and feedback about this report can be sent to the Document Platform Team. Thank you for
      reading.`);
    Object.assign(anchors, w.anchors);
  }

  // ── Page 2: table of contents with internal links ─────────────────────────
  const tocLinks: { title: string; targetPage: number; rect: number[] }[] = [];
  {
    const p = pages[1];
    const w = writer(1, { top: 720 });
    w.heading('Contents', 1, 'Contents');
    Object.assign(anchors, w.anchors);
    const entries: [string, number][] = [
      ['1 Introduction', 1],
      ['1.1 Background', 2],
      ['1.2 Goals', 2],
      ['2 Document Workflows', 1],
      ['2.1 Reviewing and Commenting', 2],
      ['2.2 Preparing Forms', 2],
      ['3 Performance', 1],
      ['3.1 Benchmarks', 2],
      ['4 Conclusion', 1],
      ['4.1 Further Reading', 2],
    ];
    w.y -= 4;
    for (const [title, level] of entries) {
      const a = anchors[title];
      if (!a) throw new Error(`no anchor for ${title}`);
      const font = level === 1 ? f.helvB : f.helv;
      const size = level === 1 ? 12 : 11;
      w.y -= level === 1 ? 26 : 20;
      const x = w.left + (level === 1 ? 0 : 20);
      w.text(title, x, w.y, font, size, hex('#1d1d1f'));
      const pn = String(a.page + 1);
      const pw = font.widthOfTextAtSize(pn, size);
      w.text(pn, w.right - pw, w.y, font, size, hex('#1d1d1f'));
      p.drawLine({
        start: { x: x + font.widthOfTextAtSize(title, size) + 6, y: w.y + 2 },
        end: { x: w.right - pw - 6, y: w.y + 2 },
        thickness: 1,
        color: hex('#9a9a9a'),
        dashArray: [1, 3],
        lineCap: 1,
      });
      const rect = [x - 2, w.y - 5, w.right + 2, w.y + size + 3];
      addLinkToPage(doc, p, rect, pages[a.page], a.top);
      tocLinks.push({ title, targetPage: a.page + 1, rect });
    }
    w.y -= 36;
    w.heading('About this report', 2);
    w.paragraph(`This report is intended for product managers, engineers and administrators who are evaluating PDF Wizard
      Web for their organizations. Every entry in the list above is a link: select an entry to jump to the
      corresponding page. The bookmarks panel shows the same structure and can be expanded to reveal subsections.`);
  }

  // ── Outline ───────────────────────────────────────────────────────────────
  const A = (k: string) => anchors[k];
  const outline: OutlineNode[] = [
    { title: 'Title Page', page: 0, top: 792 },
    { title: 'Contents', page: 1, top: A('Contents').top, bold: true },
    {
      title: '1 Introduction',
      page: 2,
      top: A('1 Introduction').top,
      open: true,
      children: [
        { title: '1.1 Background', page: 2, top: A('1.1 Background').top },
        { title: '1.2 Goals', page: 2, top: A('1.2 Goals').top },
      ],
    },
    {
      title: '2 Document Workflows',
      page: 3,
      top: A('2 Document Workflows').top,
      open: true,
      children: [
        { title: '2.1 Reviewing and Commenting', page: 3, top: A('2.1 Reviewing and Commenting').top },
        { title: '2.2 Preparing Forms', page: 3, top: A('2.2 Preparing Forms').top },
      ],
    },
    {
      title: '3 Performance',
      page: 4,
      top: A('3 Performance').top,
      open: false,
      children: [
        {
          title: '3.1 Benchmarks',
          page: 4,
          top: A('3.1 Benchmarks').top,
          open: true,
          children: [{ title: 'Table 1: Timings', page: 4, top: A('Table 1').top, italic: true }],
        },
      ],
    },
    {
      title: '4 Conclusion',
      page: 5,
      top: A('4 Conclusion').top,
      open: false,
      color: hex('#0b57d0'),
      children: [{ title: '4.1 Further Reading', page: 5, top: A('4.1 Further Reading').top }],
    },
  ];
  addOutline(doc, outline);

  const bytes = await doc.save({ useObjectStreams: false });
  await save('sample.pdf', bytes);

  const perPage = log.pages.map((_, i) => log.count('Wizard', i));
  const lowerTotal = log.pages.flat().reduce((n, s) => n + countOf(s.toLowerCase(), 'wizard'), 0);
  facts.sample = {
    pages: 6,
    wizardTotal: log.count('Wizard'),
    wizardPerPage: perPage,
    wizardCaseInsensitive: lowerTotal,
    workflowTotal: log.pages.flat().reduce((n, s) => n + countOf(s.toLowerCase(), 'workflow'), 0),
    tocLinks,
    externalLink: { page: 6, url: 'https://example.com', rect: externalLinkRect.map(num).map(Number) },
    outline,
    pageText: log.pages.map((l) => l.join('\n')),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// form.pdf
// ─────────────────────────────────────────────────────────────────────────────

async function makeForm() {
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'Customer Registration Form', author: 'PDF Wizard', subject: 'AcroForm sample' });
  const f = await embedFonts(doc);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const ctx = doc.context;
  const dark = hex('#1d1d1f');
  const muted = hex('#5c5c66');
  const border = hex('#8c93a3');
  const fieldBg = hex('#f4f7fc');
  const accent = hex('#1473e6');

  // Header band
  page.drawRectangle({ x: 0, y: 700, width: 612, height: 92, color: hex('#1b3a6b') });
  page.drawRectangle({ x: 0, y: 696, width: 612, height: 4, color: hex('#eb1000') });
  page.drawText('Customer Registration Form', { x: 48, y: 748, size: 24, font: f.helvB, color: rgb(1, 1, 1) });
  page.drawText('PDF Wizard sample form  |  Fields marked * are required', {
    x: 48,
    y: 724,
    size: 11,
    font: f.helv,
    color: hex('#d6e2f5'),
  });
  page.drawText('Form ACW-100', { x: 470, y: 772, size: 9, font: f.helv, color: hex('#d6e2f5') });

  const L = 48;
  const R = 564;
  const fieldsInfo: { name: string; type: string; label: string; rect: number[]; options?: string[]; notes?: string }[] = [];
  const label = (s: string, x: number, y: number, size = 9.5) => page.drawText(s, { x, y, size, font: f.helvB, color: muted });
  const section = (s: string, y: number) => {
    page.drawText(s, { x: L, y, size: 13, font: f.helvB, color: dark });
    page.drawLine({ start: { x: L, y: y - 6 }, end: { x: R, y: y - 6 }, thickness: 0.8, color: hex('#c5cad6') });
  };
  const tooltip = (field: { acroField: { dict: PDFDict } }, tip: string) => field.acroField.dict.set(PDFName.of('TU'), text(tip));
  const js = (script: string) => ctx.obj({ S: 'JavaScript', JS: PDFString.of(script) });
  const fieldBox = { borderColor: border, borderWidth: 1, backgroundColor: fieldBg, textColor: dark, font: f.helv };

  const textField = (
    name: string,
    lbl: string,
    x: number,
    y: number,
    w: number,
    h: number,
    opts: { required?: boolean; multiline?: boolean; tip: string; maxLength?: number; align?: TextAlignment; fontSize?: number; notes?: string } ,
  ) => {
    label(lbl + (opts.required ? ' *' : ''), x, y + h + 5);
    const tf = form.createTextField(name);
    if (opts.multiline) tf.enableMultiline();
    if (opts.maxLength) tf.setMaxLength(opts.maxLength);
    if (opts.align !== undefined) tf.setAlignment(opts.align);
    tf.addToPage(page, { x, y, width: w, height: h, ...fieldBox });
    tf.setFontSize(opts.fontSize ?? 11);
    if (opts.required) tf.enableRequired();
    tooltip(tf, opts.tip);
    fieldsInfo.push({ name, type: opts.multiline ? 'text (multiline)' : 'text', label: lbl, rect: [x, y, x + w, y + h], notes: opts.notes });
    return tf;
  };

  // 1. Personal information
  section('1. Personal information', 670);
  textField('full_name', 'Full name', L, 618, R - L, 24, { required: true, tip: 'Your first and last name' });
  textField('email', 'Email address', L, 566, 250, 24, { required: true, tip: 'We will send the confirmation to this address' });
  textField('phone', 'Phone number', L + 266, 566, 150, 24, { tip: 'Including country code, e.g. +1 555 0100' });
  const age = textField('age', 'Age', L + 432, 566, R - (L + 432), 24, {
    tip: 'Age in years (numbers only)',
    maxLength: 3,
    align: TextAlignment.Right,
    notes: 'numeric: AFNumber_Keystroke/AFNumber_Format actions, MaxLen 3, right-aligned',
  });
  age.acroField.dict.set(
    PDFName.of('AA'),
    ctx.obj({ K: js('AFNumber_Keystroke(0, 0, 0, 0, "", true);'), F: js('AFNumber_Format(0, 0, 0, 0, "", true);') }),
  );
  fieldsInfo.find((x) => x.name === 'age')!.type = 'text (numeric)';

  // 2. Preferences
  section('2. Preferences', 526);
  label('Country', L, 497);
  const country = form.createDropdown('country');
  const countries = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Japan', 'Australia', 'India', 'Brazil', 'Other'];
  country.setOptions(countries);
  country.addToPage(page, { x: L, y: 468, width: 220, height: 24, ...fieldBox });
  country.setFontSize(11);
  tooltip(country, 'Country of residence');
  fieldsInfo.push({ name: 'country', type: 'dropdown (combo box)', label: 'Country', rect: [L, 468, L + 220, 492], options: countries });

  label('Areas of interest (select one or more)', L + 250, 497);
  const interests = form.createOptionList('interests');
  const interestOptions = ['Design', 'Engineering', 'Marketing', 'Sales', 'Support'];
  interests.setOptions(interestOptions);
  interests.enableMultiselect();
  interests.addToPage(page, { x: L + 250, y: 418, width: 180, height: 74, ...fieldBox });
  interests.setFontSize(10);
  tooltip(interests, 'Hold Ctrl/Cmd to select several');
  fieldsInfo.push({ name: 'interests', type: 'list box (multi-select)', label: 'Areas of interest', rect: [L + 250, 418, L + 430, 492], options: interestOptions });

  label('Preferred contact method', L, 446);
  const contact = form.createRadioGroup('contact_method');
  const radioOpts: [string, string][] = [
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['mail', 'Postal mail'],
  ];
  radioOpts.forEach(([value, lbl], i) => {
    const x = L + i * 72;
    contact.addOptionToPage(value, page, { x, y: 420, width: 14, height: 14, borderColor: border, borderWidth: 1, backgroundColor: rgb(1, 1, 1), textColor: accent });
    page.drawText(lbl, { x: x + 19, y: 423, size: 10, font: f.helv, color: dark });
  });
  tooltip(contact, 'How should we contact you?');
  fieldsInfo.push({ name: 'contact_method', type: 'radio group', label: 'Preferred contact method', rect: [L, 420, L + 158, 434], options: radioOpts.map((o) => o[0]) });

  const checkbox = (name: string, lbl: string, y: number, tip: string, required = false) => {
    const cb = form.createCheckBox(name);
    cb.addToPage(page, { x: L, y, width: 14, height: 14, borderColor: border, borderWidth: 1, backgroundColor: rgb(1, 1, 1), textColor: accent });
    if (required) cb.enableRequired();
    tooltip(cb, tip);
    page.drawText(lbl + (required ? ' *' : ''), { x: L + 21, y: y + 3, size: 10.5, font: f.helv, color: dark });
    fieldsInfo.push({ name, type: 'checkbox (export value "Yes")', label: lbl, rect: [L, y, L + 14, y + 14] });
  };
  checkbox('newsletter', 'Send me the monthly product newsletter', 388, 'Optional newsletter subscription');
  checkbox('agree_terms', 'I have read and agree to the terms and conditions', 364, 'Required to submit the form', true);

  // 3. Comments
  section('3. Comments', 330);
  textField('comments', 'Questions or comments', L, 222, R - L, 82, {
    multiline: true,
    tip: 'Anything else you would like us to know',
    fontSize: 10,
  });

  // 4. Signature
  section('4. Signature', 190);
  const sig = { x: L, y: 92, w: 300, h: 70 };
  page.drawRectangle({ x: sig.x, y: sig.y, width: sig.w, height: sig.h, color: hex('#fbfbfd'), borderColor: hex('#9aa3b5'), borderWidth: 1, borderDashArray: [4, 3] });
  page.drawText('X', { x: sig.x + 10, y: sig.y + 16, size: 16, font: f.helvB, color: hex('#9aa3b5') });
  page.drawLine({ start: { x: sig.x + 28, y: sig.y + 16 }, end: { x: sig.x + sig.w - 12, y: sig.y + 16 }, thickness: 0.8, color: hex('#9aa3b5') });
  page.drawText('Sign here', { x: sig.x + 10, y: sig.y + sig.h + 5, size: 9.5, font: f.helvB, color: muted });
  page.drawText('Signature of applicant', { x: sig.x + 28, y: sig.y + 4, size: 8, font: f.helvI, color: muted });
  // Unsigned signature field (FT /Sig) over the box
  const sigAp = ctx.register(ctx.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, sig.w, sig.h], Resources: {} }));
  const sigRef = ctx.register(
    ctx.obj({
      FT: 'Sig',
      T: PDFString.of('signature'),
      TU: text('Sign the form'),
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [sig.x, sig.y, sig.x + sig.w, sig.y + sig.h],
      F: 4,
      P: page.ref,
      MK: {},
      AP: { N: sigAp },
    }),
  );
  page.node.addAnnot(sigRef);
  form.acroForm.addField(sigRef);
  fieldsInfo.push({ name: 'signature', type: 'signature (unsigned /Sig)', label: 'Sign here', rect: [sig.x, sig.y, sig.x + sig.w, sig.y + sig.h] });

  const date = textField('date', 'Date (MM/DD/YYYY)', L + 330, 110, R - (L + 330), 24, {
    tip: 'Date of signature',
    maxLength: 10,
    notes: 'AFDate_KeystrokeEx/AFDate_FormatEx("mm/dd/yyyy") actions',
  });
  date.acroField.dict.set(
    PDFName.of('AA'),
    ctx.obj({ K: js('AFDate_KeystrokeEx("mm/dd/yyyy");'), F: js('AFDate_FormatEx("mm/dd/yyyy");') }),
  );
  fieldsInfo.find((x) => x.name === 'date')!.type = 'text (date)';

  page.drawText('Please return the completed form to registrations@example.com.', { x: L, y: 50, size: 8.5, font: f.helvI, color: muted });
  page.drawText('Page 1 of 1', { x: R - f.helv.widthOfTextAtSize('Page 1 of 1', 8.5), y: 50, size: 8.5, font: f.helv, color: muted });

  form.updateFieldAppearances(f.helv);
  const bytes = await doc.save({ useObjectStreams: false });
  await save('form.pdf', bytes);
  facts.form = { fields: fieldsInfo };
}

// ─────────────────────────────────────────────────────────────────────────────
// annotated.pdf
// ─────────────────────────────────────────────────────────────────────────────

interface AnnotFact {
  page: number;
  type: string;
  author: string;
  contents: string;
  color: string;
  rect: number[];
  extra?: string;
}

async function makeAnnotated() {
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'Design Review: Q3 Launch Plan', author: 'Jordan Lee', subject: 'Annotation sample' });
  const f = await embedFonts(doc);
  const log = new TextLog();
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  const list: AnnotFact[] = [];
  let seq = 0;
  // Indirect font objects for appearance streams (direct font dicts upset some tools, e.g. pdffonts).
  const apFonts = Object.fromEntries(Object.entries(AP_FONTS).map(([k, v]) => [k, doc.context.register(doc.context.obj(v))]));
  const M = PDFString.of(pdfDate(FIXED_DATE));
  const common = (author: string, contents: string, subj: string, color: RGB) => ({
    T: text(author),
    Contents: text(contents),
    Subj: text(subj),
    M,
    CreationDate: M,
    NM: PDFString.of(`fixture-annot-${++seq}`),
    C: rgbArr(color),
  });
  const colorHex = (c: RGB) =>
    '#' + rgbArr(c).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const record = (page: number, type: string, author: string, contents: string, color: RGB, rect: number[], extra?: string) =>
    list.push({ page, type, author, contents, color: colorHex(color), rect: rect.map((v) => Math.round(v * 10) / 10), extra });

  // ── Page 1: text + markup ─────────────────────────────────────────────────
  const w1 = new PageWriter(p1, 0, f, log, { top: 720 });
  w1.text('Design Review: Q3 Launch Plan', 72, 712, f.helvB, 20, hex('#1d1d1f'));
  w1.text('Draft 3  |  Circulated for comments', 72, 692, f.helv, 10, hex('#6e6e6e'));
  w1.y = 680;
  w1.heading('Summary', 2);
  const para1 = w1.paragraph(`The team proposes to open the public beta during the second week of September, which
    keeps the launch window clear of the quarterly earnings call. Marketing will prepare a short announcement, and
    support will publish updated help articles one day before the release.`);
  const para2 = w1.paragraph(`The largest open risk is customer onboarding for teams that migrate from the desktop
    product. We estimate that importing existing libraries will take three weeks of engineering time, including
    automated checks that every document opens and renders exactly as before.`);
  w1.heading('Open questions', 2);
  const para3 = w1.paragraph(`Reviewers should confirm whether administrators will recieve a weekly usage report and
    whether single sign-on must be available on day one. Pricing for education customers is still under discussion
    and will be finalized after the pilot program ends in August.`);
  w1.paragraph(`Please add your comments directly to this document. Use highlights for passages that need attention and
    sticky notes for general questions, and reply to existing notes instead of starting new threads.`);

  const markup = (
    page: PDFPage,
    pageNo: number,
    sub: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly',
    quads: number[][],
    color: RGB,
    author: string,
    contents: string,
  ) => {
    const rect = bboxOfQuads(quads, 1);
    const ops: string[] = [];
    let resources: Record<string, unknown> | undefined;
    if (sub === 'Highlight') {
      resources = { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } };
      ops.push('/GS0 gs', colorOps(color));
      for (const q of quads) {
        ops.push(`${num(q[0])} ${num(q[1])} m ${num(q[2])} ${num(q[3])} l ${num(q[6])} ${num(q[7])} l ${num(q[4])} ${num(q[5])} l h f`);
      }
    } else {
      ops.push(colorOps(color, true));
      for (const q of quads) {
        const h = q[1] - q[5];
        const lw = Math.max(0.75, h / 14);
        ops.push(`${num(lw)} w`);
        if (sub === 'Underline') {
          const y = q[5] + lw * 1.4;
          ops.push(`${num(q[4])} ${num(y)} m ${num(q[6])} ${num(y)} l S`);
        } else if (sub === 'StrikeOut') {
          const y = q[5] + h * 0.45;
          ops.push(`${num(q[4])} ${num(y)} m ${num(q[6])} ${num(y)} l S`);
        } else {
          const amp = h / 12;
          const step = amp * 2;
          const yb = q[5] + amp * 1.2;
          let x = q[4];
          const pts = [`${num(x)} ${num(yb)} m`];
          let up = true;
          while (x < q[6]) {
            x = Math.min(q[6], x + step);
            pts.push(`${num(x)} ${num(up ? yb + amp : yb)} l`);
            up = !up;
          }
          ops.push(pts.join(' '), 'S');
        }
      }
    }
    addAnnotation(
      doc,
      page,
      { Subtype: sub, Rect: rect, QuadPoints: quads.flat(), ...common(author, contents, sub, color), ...(sub === 'Highlight' ? { CA: 1 } : {}) },
      { ops: ops.join('\n'), resources },
    );
    record(pageNo, sub, author, contents, color, rect, `${quads.length} quad(s)`);
  };

  const yellow = hex('#ffe14d');
  markup(p1, 1, 'Highlight', phraseQuads(para1, 'launch window'), yellow, 'Jordan Lee', 'Confirm the launch window with marketing.');
  markup(p1, 1, 'Underline', phraseQuads(para2, 'customer onboarding'), hex('#1a9e3f'), 'Priya Natarajan', 'Who owns onboarding?');
  markup(p1, 1, 'StrikeOut', phraseQuads(para2, 'three weeks'), hex('#d92d20'), 'Sam Rivera', 'Replace with: two weeks');
  markup(p1, 1, 'Squiggly', phraseQuads(para3, 'recieve'), hex('#7a3ff2'), 'Sam Rivera', 'Typo: receive');
  // multi-line highlight (spans a line break in paragraph 2)
  {
    // last 3 words of line 2 + first 4 words of line 3, so the highlight wraps across a line break
    const l2 = para2.lines[1].text.split(' ');
    const l3 = para2.lines[2].text.split(' ');
    const words = [...l2.slice(-3), ...l3.slice(0, 4)].join(' ');
    const quads = phraseQuads(para2, words);
    if (quads.length !== 2) throw new Error('multi-line highlight should have 2 quads');
    markup(p1, 1, 'Highlight', quads, hex('#7fd3ff'), 'Priya Natarajan', 'Can we reuse the regression suite for this?');
  }

  // Sticky note with popup + reply
  {
    const color = hex('#ffd400');
    const rect = [548, 646, 568, 666];
    const [x0, y0, x1, y1] = rect;
    const icon = [
      colorOps(color),
      '0.35 0.3 0.05 RG 0.8 w',
      `${num(x0 + 1)} ${num(y0 + 5)} m ${num(x0 + 1)} ${num(y1 - 1)} l ${num(x1 - 1)} ${num(y1 - 1)} l ${num(x1 - 1)} ${num(y0 + 5)} l`,
      `${num(x0 + 9)} ${num(y0 + 5)} l ${num(x0 + 5)} ${num(y0 + 1)} l ${num(x0 + 6)} ${num(y0 + 5)} l h B`,
      `0.35 0.3 0.05 RG 0.9 w`,
      `${num(x0 + 4)} ${num(y1 - 5)} m ${num(x1 - 4)} ${num(y1 - 5)} l S`,
      `${num(x0 + 4)} ${num(y1 - 8.5)} m ${num(x1 - 4)} ${num(y1 - 8.5)} l S`,
      `${num(x0 + 4)} ${num(y1 - 12)} m ${num(x1 - 7)} ${num(y1 - 12)} l S`,
    ].join('\n');
    const contents = 'Overall this looks good. A few questions inline - see highlights.';
    const note = addAnnotation(
      doc,
      p1,
      { Subtype: 'Text', Rect: rect, Name: 'Comment', Open: false, ...common('Priya Natarajan', contents, 'Sticky Note', color) },
      { ops: icon },
    );
    const popup = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [400, 560, 600, 660], Parent: note, Open: false, F: 28 }),
    );
    p1.node.addAnnot(popup);
    (doc.context.lookup(note) as PDFDict).set(PDFName.of('Popup'), popup);
    record(1, 'Text (sticky note)', 'Priya Natarajan', contents, color, rect, 'Name /Comment, has Popup');

    const replyContents = "Thanks - I'll address these before Friday.";
    addAnnotation(
      doc,
      p1,
      { Subtype: 'Text', Rect: rect, Name: 'Comment', IRT: note, RT: 'R', Open: false, ...common('Jordan Lee', replyContents, 'Sticky Note', color) },
      { ops: icon },
    );
    record(1, 'Text (reply, IRT -> sticky note)', 'Jordan Lee', replyContents, color, rect, 'RT /R');
  }

  // ── Page 2: drawing annotations ───────────────────────────────────────────
  const w2 = new PageWriter(p2, 1, f, log, { top: 720 });
  w2.text('Architecture Sketch', 72, 712, f.helvB, 20, hex('#1d1d1f'));
  w2.y = 700;
  w2.paragraph(`The diagram below shows the main components. The browser renders and edits documents locally; the
    server stores the library and runs conversions. Reviewers marked up this page with shapes and ink.`);
  // Diagram boxes
  const box = (x: number, y: number, wd: number, ht: number, title: string, sub: string) => {
    p2.drawRectangle({ x, y, width: wd, height: ht, color: hex('#eef3fb'), borderColor: hex('#4a6fa5'), borderWidth: 1.2 });
    w2.text(title, x + (wd - f.helvB.widthOfTextAtSize(title, 12)) / 2, y + ht / 2 + 2, f.helvB, 12, hex('#1b3a6b'));
    w2.text(sub, x + (wd - f.helv.widthOfTextAtSize(sub, 9)) / 2, y + ht / 2 - 12, f.helv, 9, hex('#4a4a55'));
  };
  box(90, 520, 150, 70, 'Browser', 'viewer, editor, export');
  box(372, 520, 150, 70, 'Server', 'library, conversion, OCR');
  p2.drawLine({ start: { x: 240, y: 555 }, end: { x: 372, y: 555 }, thickness: 1.2, color: hex('#4a6fa5') });
  w2.text('REST / JSON', 272, 561, f.helv, 9, hex('#4a4a55'));
  box(231, 400, 150, 60, 'File storage', 'versions, thumbnails');
  p2.drawLine({ start: { x: 447, y: 520 }, end: { x: 330, y: 460 }, thickness: 1.2, color: hex('#4a6fa5') });
  w2.y = 380;
  w2.paragraph(`Open question: should thumbnails be generated by the browser instead of the server? The current design
    keeps the server stateless apart from file storage.`);

  // Square around the Server box
  {
    const color = hex('#d92d20');
    const rect = [362, 510, 532, 600];
    const bw = 2;
    const ops = `${colorOps(color, true)} ${bw} w ${rect[0] + bw / 2} ${rect[1] + bw / 2} ${rect[2] - rect[0] - bw} ${rect[3] - rect[1] - bw} re S`;
    addAnnotation(doc, p2, { Subtype: 'Square', Rect: rect, BS: { W: bw, S: 'S' }, ...common('Sam Rivera', 'Should this be split into two services?', 'Rectangle', color) }, { ops });
    record(2, 'Square', 'Sam Rivera', 'Should this be split into two services?', color, rect, 'border 2pt, no fill');
  }
  // Circle around "File storage"
  {
    const color = hex('#1a9e3f');
    const rect = [215, 385, 397, 475];
    const bw = 2;
    const ops = `${colorOps(color, true)} ${bw} w\n${ellipsePath(rect[0] + bw, rect[1] + bw, rect[2] - bw, rect[3] - bw)}\nS`;
    addAnnotation(doc, p2, { Subtype: 'Circle', Rect: rect, BS: { W: bw, S: 'S' }, ...common('Priya Natarajan', 'Nice - keep versions here.', 'Oval', color) }, { ops });
    record(2, 'Circle', 'Priya Natarajan', 'Nice - keep versions here.', color, rect, 'border 2pt');
  }
  // Line with open arrow pointing at the Browser box
  {
    const color = hex('#d92d20');
    const [xa, ya, xb, yb] = [120, 680 - 40, 160, 598];
    const bw = 1.5;
    const ang = Math.atan2(yb - ya, xb - xa);
    const len = 10;
    const spread = Math.PI / 7;
    const h1 = [xb - len * Math.cos(ang - spread), yb - len * Math.sin(ang - spread)];
    const h2 = [xb - len * Math.cos(ang + spread), yb - len * Math.sin(ang + spread)];
    const rect = bboxOfPoints([[xa, ya], [xb, yb], h1, h2], 4);
    const ops = [
      `${colorOps(color, true)} ${bw} w 1 J 1 j`,
      `${num(xa)} ${num(ya)} m ${num(xb)} ${num(yb)} l S`,
      `${num(h1[0])} ${num(h1[1])} m ${num(xb)} ${num(yb)} l ${num(h2[0])} ${num(h2[1])} l S`,
    ].join('\n');
    addAnnotation(
      doc,
      p2,
      { Subtype: 'Line', Rect: rect, L: [xa, ya, xb, yb], LE: ['None', 'OpenArrow'], BS: { W: bw, S: 'S' }, ...common('Sam Rivera', 'Start here', 'Arrow', color) },
      { ops },
    );
    record(2, 'Line (arrow)', 'Sam Rivera', 'Start here', color, rect, `L [${xa} ${ya} ${xb} ${yb}], LE [/None /OpenArrow]`);
  }
  // Ink: a check mark + underline scribble
  {
    const color = hex('#1473e6');
    const stroke1: number[][] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      stroke1.push(t < 0.35 ? [440 + t * 40, 290 - t * 30] : [454 + (t - 0.35) * 70, 279.5 + (t - 0.35) * 75]);
    }
    const stroke2: number[][] = [];
    for (let i = 0; i <= 24; i++) stroke2.push([400 + i * 6, 258 + Math.sin(i / 2) * 3]);
    const bw = 2.5;
    const rect = bboxOfPoints([...stroke1, ...stroke2], bw + 2);
    const path = (pts: number[][]) => pts.map((p, i) => `${num(p[0])} ${num(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' S';
    const ops = `${colorOps(color, true)} ${bw} w 1 J 1 j\n${path(stroke1)}\n${path(stroke2)}`;
    addAnnotation(
      doc,
      p2,
      { Subtype: 'Ink', Rect: rect, InkList: [stroke1.flat(), stroke2.flat()], BS: { W: bw, S: 'S' }, ...common('Jordan Lee', 'Approved with the changes above.', 'Pencil', color) },
      { ops },
    );
    record(2, 'Ink', 'Jordan Lee', 'Approved with the changes above.', color, rect, '2 strokes');
  }
  // FreeText
  {
    const color = hex('#d92d20');
    const rect = [72, 230, 300, 280];
    const lines = ['Draft - not for distribution.', 'Reviewed by Sam, pending sign-off.'];
    const size = 12;
    const ops = [
      `1 1 1 rg ${colorOps(color, true)} 1 w ${rect[0] + 0.5} ${rect[1] + 0.5} ${rect[2] - rect[0] - 1} ${rect[3] - rect[1] - 1} re B`,
      `BT /Helv ${size} Tf ${colorOps(color)}`,
      `${rect[0] + 6} ${rect[3] - 6 - size * 0.8} Td ${size * 1.25} TL`,
      ...lines.map((l, i) => `${i ? 'T* ' : ''}(${escPdf(l)}) Tj`),
      'ET',
    ].join('\n');
    const contents = lines.join('\r');
    addAnnotation(
      doc,
      p2,
      {
        Subtype: 'FreeText',
        Rect: rect,
        DA: PDFString.of(`/Helv ${size} Tf 0.851 0.176 0.125 rg`),
        DS: PDFString.of(`font: Helvetica ${size}pt; color: #d92d20`),
        Q: 0,
        BS: { W: 1, S: 'S' },
        ...common('Sam Rivera', contents, 'Text Box', color),
      },
      { ops, resources: { Font: apFonts } },
    );
    record(2, 'FreeText', 'Sam Rivera', lines.join(' / '), color, rect, 'DA /Helv 12 Tf, red, bordered');
  }
  // Stamp
  {
    const color = hex('#1a7f37');
    const rect = [360, 150, 540, 210];
    const [x0, y0, x1, y1] = rect;
    const r = 8;
    const rr = (a: number, b: number, c: number, d: number, rad: number) =>
      [
        `${num(a + rad)} ${num(b)} m ${num(c - rad)} ${num(b)} l ${num(c)} ${num(b)} ${num(c)} ${num(b + rad)} v`,
        `${num(c)} ${num(d - rad)} l ${num(c)} ${num(d)} ${num(c - rad)} ${num(d)} v`,
        `${num(a + rad)} ${num(d)} l ${num(a)} ${num(d)} ${num(a)} ${num(d - rad)} v`,
        `${num(a)} ${num(b + rad)} l ${num(a)} ${num(b)} ${num(a + rad)} ${num(b)} v h`,
      ].join(' ');
    const label = 'APPROVED';
    const size = 26;
    const tw = f.helvB.widthOfTextAtSize(label, size);
    const sub = 'Jordan Lee, 01/15/2026';
    const sw = f.helv.widthOfTextAtSize(sub, 9);
    const ops = [
      `q ${colorOps(color, true)} 3 w ${rr(x0 + 2, y0 + 2, x1 - 2, y1 - 2, r)} S`,
      `1 w ${rr(x0 + 6, y0 + 6, x1 - 6, y1 - 6, r - 3)} S Q`,
      `BT /HeBo ${size} Tf ${colorOps(color)} ${num((x0 + x1) / 2 - tw / 2)} ${num(y0 + 26)} Td (${label}) Tj ET`,
      `BT /Helv 9 Tf ${colorOps(color)} ${num((x0 + x1) / 2 - sw / 2)} ${num(y0 + 12)} Td (${escPdf(sub)}) Tj ET`,
    ].join('\n');
    addAnnotation(doc, p2, { Subtype: 'Stamp', Rect: rect, Name: 'Approved', ...common('Jordan Lee', 'Approved', 'Approved', color) }, { ops, resources: { Font: apFonts } });
    record(2, 'Stamp', 'Jordan Lee', 'Approved', color, rect, 'Name /Approved');
  }
  w2.text('Page 2 of 2', 306 - f.helv.widthOfTextAtSize('Page 2 of 2', 9) / 2, 40, f.helv, 9, hex('#6e6e6e'));
  w1.text('Page 1 of 2', 306 - f.helv.widthOfTextAtSize('Page 1 of 2', 9) / 2, 40, f.helv, 9, hex('#6e6e6e'));

  const bytes = await doc.save({ useObjectStreams: false });
  await save('annotated.pdf', bytes);
  facts.annotated = list;
}

// ─────────────────────────────────────────────────────────────────────────────
// scanned.pdf
// ─────────────────────────────────────────────────────────────────────────────

const SCAN_PAGES: { heading?: string; lines: string[] }[] = [
  {
    heading: 'NORTHWIND LOGISTICS',
    lines: [
      '#MEMORANDUM',
      '',
      'To: All regional warehouse managers',
      'From: Dana Whitfield, Operations Manager',
      'Date: March 3, 2025',
      'Subject: Quarterly scanning audit',
      '',
      '~As part of our ongoing effort to reduce paper handling, every warehouse will complete a scanning audit before the end of the quarter. The audit confirms that delivery notes, customs declarations and signed receipts are digitized within two business days of arrival.',
      '',
      '~Please review the attached checklist with your team. Each site should nominate one coordinator who will collect the scanned files, verify that every page is legible and upload the batch to the shared archive. Pages that are skewed, cropped or too dark must be scanned again.',
      '',
      '~The results will be discussed at the regional meeting on April 14. Sites that complete the audit early will receive additional document scanners for the next fiscal year.',
    ],
  },
  {
    lines: [
      '#AUDIT CHECKLIST',
      '',
      '1. Count the delivery notes received during the audit week.',
      '2. Scan each note at 300 dots per inch in grayscale.',
      '3. Check that the reference number is readable on every page.',
      '4. Store the originals in the archive room for ninety days.',
      '5. Report the total number of pages to the regional office.',
      '',
      '~Questions about the audit can be sent to the operations desk at extension 4471. Thank you for your cooperation and for helping us build a faster, paperless process.',
      '',
      'Sincerely,',
      '',
      'Dana Whitfield',
      'Operations Manager, Northwind Logistics',
    ],
  },
];

async function makeScanned(fonts: { times: PDFFont; timesB: PDFFont }) {
  const DPI = 200;
  const Wpx = Math.round(8.5 * DPI);
  const Hpx = Math.round(11 * DPI);
  const px = (pt: number) => (pt * DPI) / 72;
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'Scanned memo', author: 'Scanner', subject: 'Image-only pages for OCR tests' });
  const rand = prng(20260115);
  const ocrText: string[] = [];

  for (let pi = 0; pi < SCAN_PAGES.length; pi++) {
    const spec = SCAN_PAGES[pi];
    const size = px(12);
    const lead = size * 1.5;
    const left = px(72);
    const width = Wpx - 2 * left;
    let y = px(90);
    const parts: string[] = [];
    const pageText: string[] = [];
    if (spec.heading) {
      parts.push(`<text x="${left}" y="${y}" font-family="Helvetica" font-weight="bold" font-size="${px(18)}" fill="#111">${spec.heading}</text>`);
      parts.push(`<rect x="${left}" y="${y + px(8)}" width="${width}" height="${px(1.5)}" fill="#222"/>`);
      pageText.push(spec.heading);
      y += px(40);
    }
    for (const raw of spec.lines) {
      if (raw === '') {
        y += lead * 0.6;
        continue;
      }
      if (raw.startsWith('#')) {
        const s = raw.slice(1);
        parts.push(`<text x="${left}" y="${y}" font-family="Times New Roman" font-weight="bold" font-size="${px(16)}" fill="#111">${s}</text>`);
        pageText.push(s);
        y += lead * 1.2;
        continue;
      }
      const isPara = raw.startsWith('~');
      const s = isPara ? raw.slice(1) : raw;
      const lines = isPara ? wrap(s, fonts.times, size, width) : [s];
      for (const line of lines) {
        const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        parts.push(`<text x="${left}" y="${y}" font-family="Times New Roman" font-size="${size}" fill="#161616">${esc}</text>`);
        pageText.push(line);
        y += lead;
      }
    }
    parts.push(`<text x="${Wpx / 2}" y="${Hpx - px(40)}" font-family="Times New Roman" font-size="${px(10)}" fill="#333" text-anchor="middle">Page ${pi + 1} of ${SCAN_PAGES.length}</text>`);
    ocrText.push(pageText.join('\n'));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wpx}" height="${Hpx}"><rect width="100%" height="100%" fill="#fff"/>${parts.join('')}</svg>`;

    // Rasterize → grayscale, soften, rotate slightly, add paper tint + noise + specks
    const base = await sharp(Buffer.from(svg), { density: 72 })
      .flatten({ background: '#ffffff' })
      .grayscale()
      .blur(0.7)
      .rotate(pi === 0 ? 0.45 : -0.35, { background: '#ffffff' })
      .resize(Wpx, Hpx, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data, info } = base;
    const ch = info.channels;
    const out = Buffer.alloc(info.width * info.height);
    for (let i = 0, j = 0; j < out.length; i += ch, j++) {
      let v = data[i] * 0.955 + 4; // paper tint
      v += (rand() - 0.5) * 26;
      if (rand() < 0.0004) v -= 120 + rand() * 80; // dust specks
      out[j] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    const jpg = await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } })
      .jpeg({ quality: 72, chromaSubsampling: '4:2:0' })
      .toBuffer();
    const img = await doc.embedJpg(jpg);
    const page = doc.addPage([612, 792]);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  const bytes = await doc.save({ useObjectStreams: false });
  await save('scanned.pdf', bytes);
  facts.scanned = { pages: 2, dpi: DPI, pixelSize: [Wpx, Hpx], text: ocrText };
}

// ─────────────────────────────────────────────────────────────────────────────
// encrypted.pdf
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Work around @cantoo/pdf-lib: doc.encrypt() + save() only encrypts *streams*; string objects
 * (Info /Title, annotation /Contents, field values, outline titles...) are written in plain text,
 * which conforming readers then "decrypt" into garbage. Encrypt every string in every indirect
 * object (except the /Encrypt dictionary itself) in place, before save().
 */
function encryptStrings(doc: PDFDocument) {
  const ctx = doc.context;
  const security = (ctx as unknown as { security?: { getEncryptFn(obj: number, gen: number): (b: Uint8Array) => Uint8Array } }).security;
  if (!security) throw new Error('encryptStrings: call doc.encrypt() first');
  const encryptRef = ctx.trailerInfo.Encrypt as PDFRef | undefined;
  const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (encryptRef && ref === encryptRef) continue;
    const enc = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const visit = (o: PDFObject): PDFObject | undefined => {
      if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of(toHex(enc(o.asBytes())));
      if (o instanceof PDFDict) {
        for (const [k, v] of o.entries()) {
          const r = visit(v);
          if (r) o.set(k, r);
        }
      } else if (o instanceof PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const r = visit(o.get(i));
          if (r) o.set(i, r);
        }
      } else if (o instanceof PDFStream) visit(o.dict);
      return undefined;
    };
    visit(obj);
  }
}

async function makeEncrypted() {
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'Confidential Budget Summary', author: 'Finance Office', subject: 'Password-protected sample' });
  const f = await embedFonts(doc);
  const log = new TextLog();
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([612, 792]);
    const w = new PageWriter(page, i, f, log, { top: 720 });
    page.drawRectangle({ x: 0, y: 752, width: 612, height: 40, color: hex('#5c2d91') });
    w.text('CONFIDENTIAL', 72, 766, f.helvB, 14, rgb(1, 1, 1));
    w.y = 720;
    if (i === 0) {
      w.heading('Confidential Budget Summary', 1);
      w.paragraph(`This document is protected with a password. It was generated to test opening encrypted files: the user
        password is required to view it, and the owner password grants full access to change its security settings.`);
      w.paragraph(`The operating budget for the next fiscal year is planned at 4.2 million, an increase of six percent
        over the current year. Most of the increase is allocated to cloud infrastructure and customer support.`);
    } else {
      w.heading('Allocation by Department', 1);
      for (const [dep, amt] of [
        ['Engineering', '1,850,000'],
        ['Customer Support', '910,000'],
        ['Marketing', '640,000'],
        ['Operations', '480,000'],
        ['Administration', '320,000'],
      ]) {
        w.y -= 22;
        w.text(dep, 90, w.y, f.times, 13);
        w.text(amt, 400 - f.times.widthOfTextAtSize(amt, 13), w.y, f.times, 13);
      }
    }
    w.text(`Page ${i + 1} of 2`, 290, 40, f.helv, 9, hex('#6e6e6e'));
  }
  doc.encrypt({
    userPassword: 'secret',
    ownerPassword: 'owner',
    permissions: {
      printing: 'highResolution',
      modifying: true,
      copying: true,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: true,
    },
  });
  encryptStrings(doc);
  const bytes = await doc.save({ useObjectStreams: false });
  await save('encrypted.pdf', bytes);

  // Check the fork can re-open it with the password.
  const reopened = await PDFDocument.load(bytes, { password: 'secret', updateMetadata: false });
  if (reopened.getPageCount() !== 2) throw new Error('encrypted.pdf: reopened page count mismatch');
  let rejected = false;
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    rejected = true;
  }
  facts.encrypted = {
    pages: 2,
    reopenedTitle: reopened.getTitle(),
    loadWithoutPasswordRejected: rejected,
    text: log.pages.map((l) => l.join('\n')),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// rotated.pdf
// ─────────────────────────────────────────────────────────────────────────────

async function makeRotated() {
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'Rotation and page box test', author: 'PDF Wizard', subject: 'Orientation fixtures' });
  const f = await embedFonts(doc);
  type Spec = { rotate: 0 | 90 | 180 | 270; media: number[]; crop?: number[]; note: string };
  const specs: Spec[] = [
    { rotate: 0, media: [0, 0, 612, 792], note: 'Portrait page, no rotation.' },
    { rotate: 90, media: [0, 0, 612, 792], note: 'Portrait MediaBox shown as landscape via /Rotate 90.' },
    { rotate: 180, media: [0, 0, 612, 792], note: 'Upside-down storage, /Rotate 180.' },
    { rotate: 270, media: [0, 0, 612, 792], note: 'Portrait MediaBox shown as landscape via /Rotate 270.' },
    { rotate: 0, media: [100, 100, 712, 892], note: 'MediaBox with non-zero origin (100, 100).' },
    { rotate: 0, media: [0, 0, 612, 792], crop: [72, 108, 540, 684], note: 'CropBox [72 108 540 684] inside a Letter MediaBox.' },
    { rotate: 90, media: [100, 100, 712, 892], note: 'Non-zero origin combined with /Rotate 90.' },
  ];
  const cornerColors = { TL: hex('#d92d20'), TR: hex('#1a9e3f'), BL: hex('#1473e6'), BR: hex('#e8870e') };
  const pagesFacts: unknown[] = [];

  specs.forEach((s, i) => {
    const [mx0, my0, mx1, my1] = s.media;
    const page = doc.addPage([mx1 - mx0, my1 - my0]);
    page.setMediaBox(mx0, my0, mx1 - mx0, my1 - my0);
    const box = s.crop ?? s.media;
    if (s.crop) page.setCropBox(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    page.setRotation(degrees(s.rotate));
    const [bx, by, bx1, by1] = box;
    const w = bx1 - bx;
    const h = by1 - by;
    const R = s.rotate;
    // visual (u, v) → user space, so the page reads upright when /Rotate is honored
    const m: [number, number, number, number, number, number] =
      R === 0 ? [1, 0, 0, 1, bx, by] : R === 90 ? [0, 1, -1, 0, bx + w, by] : R === 180 ? [-1, 0, 0, -1, bx + w, by + h] : [0, -1, 1, 0, bx, by + h];
    const toUser = (u: number, v: number) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
    const VW = R % 180 === 0 ? w : h;
    const VH = R % 180 === 0 ? h : w;
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
    // frame
    page.drawRectangle({ x: 8, y: 8, width: VW - 16, height: VH - 16, borderColor: hex('#9aa3b5'), borderWidth: 1.5, borderDashArray: [6, 4] });
    // TOP marker
    const top = 'TOP';
    page.drawText(top, { x: VW / 2 - f.helvB.widthOfTextAtSize(top, 36) / 2, y: VH - 70, size: 36, font: f.helvB, color: hex('#d92d20') });
    page.drawSvgPath('M0 0 L14 20 L5 20 L5 40 L-5 40 L-5 20 L-14 20 Z', { x: VW / 2, y: VH - 78, color: hex('#d92d20') });
    // corner markers
    const cs = 26;
    const corners: [keyof typeof cornerColors, number, number][] = [
      ['TL', 0, VH],
      ['TR', VW, VH],
      ['BL', 0, 0],
      ['BR', VW, 0],
    ];
    const cornerFacts: Record<string, number[]> = {};
    for (const [name, cx, cy] of corners) {
      const x = cx === 0 ? 14 : cx - 14 - cs;
      const y = cy === 0 ? 14 : cy - 14 - cs;
      page.drawRectangle({ x, y, width: cs, height: cs, color: cornerColors[name] });
      page.drawText(name, { x: x + 4, y: y + 8, size: 11, font: f.helvB, color: rgb(1, 1, 1) });
      const user = toUser(cx, cy).map((v) => Math.round(v));
      cornerFacts[name] = user;
      const lbl = `${name} = user (${user[0]}, ${user[1]})`;
      const lw = f.helv.widthOfTextAtSize(lbl, 9);
      page.drawText(lbl, { x: cx === 0 ? x + cs + 6 : x - 6 - lw, y: y + 9, size: 9, font: f.helv, color: hex('#333333') });
    }
    // centre text
    const center = (s2: string, y: number, font: PDFFont, size: number, color: RGB = hex('#1d1d1f')) =>
      page.drawText(s2, { x: VW / 2 - font.widthOfTextAtSize(s2, size) / 2, y, size, font, color });
    center(`Page ${i + 1}`, VH / 2 + 40, f.helvB, 40);
    center(`/Rotate ${R}`, VH / 2 + 8, f.helv, 18, hex('#1473e6'));
    center(`MediaBox [${s.media.join(' ')}]${s.crop ? `  CropBox [${s.crop.join(' ')}]` : ''}`, VH / 2 - 16, f.courier, 10, hex('#444444'));
    center(s.note, VH / 2 - 36, f.times, 12, hex('#444444'));
    center('If this text reads upright, the page is displayed correctly.', VH / 2 - 56, f.timesI, 12, hex('#444444'));
    page.pushOperators(popGraphicsState());
    pagesFacts.push({ page: i + 1, rotate: R, mediaBox: s.media, cropBox: s.crop ?? s.media, displayed: `${VW}x${VH}`, corners: cornerFacts });
  });
  const bytes = await doc.save({ useObjectStreams: false });
  await save('rotated.pdf', bytes);
  facts.rotated = pagesFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// mixed-sizes.pdf
// ─────────────────────────────────────────────────────────────────────────────

async function makeMixedSizes() {
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'Mixed page sizes', author: 'PDF Wizard', subject: 'Letter, A4, Legal, Letter landscape, A6' });
  const f = await embedFonts(doc);
  const sizes: [string, number, number][] = [
    ['US Letter', 612, 792],
    ['A4', 595.28, 841.89],
    ['US Legal', 612, 1008],
    ['US Letter landscape', 792, 612],
    ['A6', 297.64, 419.53],
  ];
  const colors = ['#1473e6', '#1a9e3f', '#7a3ff2', '#e8870e', '#d92d20'];
  sizes.forEach(([name, w, h], i) => {
    const page = doc.addPage([w, h]);
    const c = hex(colors[i]);
    page.drawRectangle({ x: 12, y: 12, width: w - 24, height: h - 24, borderColor: c, borderWidth: 3 });
    // light grid every inch
    for (let x = 72; x < w; x += 72) page.drawLine({ start: { x, y: 12 }, end: { x, y: h - 12 }, thickness: 0.3, color: hex('#dde3ee') });
    for (let y = 72; y < h; y += 72) page.drawLine({ start: { x: 12, y }, end: { x: w - 12, y }, thickness: 0.3, color: hex('#dde3ee') });
    const scale = Math.min(1, w / 612);
    const center = (s: string, y: number, font: PDFFont, size: number, color: RGB = hex('#1d1d1f')) =>
      page.drawText(s, { x: w / 2 - font.widthOfTextAtSize(s, size) / 2, y, size, font, color });
    center(name, h / 2 + 30 * scale, f.helvB, 36 * scale, c);
    center(`${num(w)} x ${num(h)} pt`, h / 2 - 6 * scale, f.helv, 16 * scale);
    center(`${(w / 72).toFixed(2)} x ${(h / 72).toFixed(2)} in  |  ${Math.round((w / 72) * 25.4)} x ${Math.round((h / 72) * 25.4)} mm`, h / 2 - 30 * scale, f.helv, 12 * scale, hex('#555555'));
    center(`Page ${i + 1} of ${sizes.length}`, 30, f.helv, 10, hex('#6e6e6e'));
    page.drawText('TOP', { x: w / 2 - f.helvB.widthOfTextAtSize('TOP', 14) / 2, y: h - 36, size: 14, font: f.helvB, color: c });
  });
  const bytes = await doc.save({ useObjectStreams: false });
  await save('mixed-sizes.pdf', bytes);
  facts.mixed = sizes.map(([name, w, h], i) => ({ page: i + 1, name, width: w, height: h }));
}

// ─────────────────────────────────────────────────────────────────────────────
// large.pdf
// ─────────────────────────────────────────────────────────────────────────────

const LARGE_CHAPTERS = [
  'Getting Started',
  'Opening Documents',
  'Navigating Pages',
  'Searching Text',
  'Comments and Markup',
  'Filling Forms',
  'Signing Documents',
  'Organizing Pages',
  'Exporting and Printing',
  'Protecting Documents',
  'Optimizing Files',
  'Administration',
];
const SENTENCES = [
  'Each page of this manual is numbered in large type so that scrolling and navigation can be verified at a glance.',
  'Thumbnails in the page panel should match the number printed in the center of the page.',
  'Rendering must remain responsive while the user jumps between distant pages of the document.',
  'The search index is built progressively and should find the reference code printed on every page.',
  'Bookmarks for each chapter point to the first page of that chapter.',
  'Selecting text on this page should produce the same characters that are printed here.',
  'Long documents are a good test for memory usage, lazy loading and cancellation of stale work.',
  'Zooming in and out should keep the current page in view without visible jumps.',
];

async function makeLarge() {
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'PDF Wizard Reference Manual (300 pages)', author: 'PDF Wizard', subject: 'Large document fixture' });
  const f = await embedFonts(doc);
  const N = 300;
  const perChapter = N / LARGE_CHAPTERS.length;
  const rand = prng(300);
  for (let i = 0; i < N; i++) {
    const page = doc.addPage([612, 792]);
    const chapter = Math.floor(i / perChapter);
    const first = i % perChapter === 0;
    page.drawText(`Reference Manual  |  Chapter ${chapter + 1}: ${LARGE_CHAPTERS[chapter]}`, { x: 72, y: 750, size: 9, font: f.helv, color: hex('#6e6e6e') });
    page.drawLine({ start: { x: 72, y: 743 }, end: { x: 540, y: 743 }, thickness: 0.5, color: hex('#d0d0d0') });
    if (first) {
      page.drawText(`Chapter ${chapter + 1}`, { x: 72, y: 690, size: 14, font: f.helvB, color: hex('#eb1000') });
      page.drawText(LARGE_CHAPTERS[chapter], { x: 72, y: 660, size: 26, font: f.helvB, color: hex('#1d1d1f') });
    }
    const label = String(i + 1);
    const size = 150;
    page.drawText(label, { x: 306 - f.helvB.widthOfTextAtSize(label, size) / 2, y: 400, size, font: f.helvB, color: hex('#d5dbe6') });
    const code = `Reference code R-${String(i + 1).padStart(4, '0')}`;
    page.drawText(code, { x: 306 - f.courier.widthOfTextAtSize(code, 12) / 2, y: 360, size: 12, font: f.courier, color: hex('#333333') });
    let y = 300;
    const body = [0, 1, 2].map(() => SENTENCES[Math.floor(rand() * SENTENCES.length)]).join(' ');
    for (const line of wrap(body, f.times, 11.5, 468)) {
      page.drawText(line, { x: 72, y, size: 11.5, font: f.times, color: hex('#222222') });
      y -= 16;
    }
    const footer = `Page ${i + 1} of ${N}`;
    page.drawText(footer, { x: 306 - f.helv.widthOfTextAtSize(footer, 9) / 2, y: 40, size: 9, font: f.helv, color: hex('#6e6e6e') });
  }
  addOutline(
    doc,
    LARGE_CHAPTERS.map((t, c) => ({ title: `Chapter ${c + 1}: ${t}`, page: c * perChapter, top: 792 })),
  );
  const bytes = await doc.save({ useObjectStreams: true });
  await save('large.pdf', bytes);
  facts.large = { pages: N, chapters: LARGE_CHAPTERS.map((t, c) => ({ title: `Chapter ${c + 1}: ${t}`, page: c * perChapter + 1 })) };
}

// ─────────────────────────────────────────────────────────────────────────────
// images.pdf, sample.png, sample.jpg
// ─────────────────────────────────────────────────────────────────────────────

/** A synthetic "photo": sky gradient, sun, layered hills, textured foreground, sensor noise. */
function landscape(width: number, height: number, seed: number, palette: 'sunset' | 'ocean', noise = 10): Buffer {
  const rand = prng(seed);
  const buf = Buffer.alloc(width * height * 3);
  const sunX = width * (palette === 'sunset' ? 0.68 : 0.3);
  const sunY = height * (palette === 'sunset' ? 0.42 : 0.28);
  const sunR = height * 0.09;
  const phases = [rand() * 6, rand() * 6, rand() * 6, rand() * 6];
  const horizon = (x: number, layer: number) =>
    height *
    (0.5 + layer * 0.1 + 0.06 * Math.sin((x / width) * (3 + layer) * Math.PI + phases[layer]) + 0.025 * Math.sin((x / width) * 17 * Math.PI + phases[(layer + 1) % 4]));
  const sky = palette === 'sunset'
    ? [[34, 26, 74], [196, 72, 88], [252, 176, 86]]
    : [[18, 60, 128], [80, 150, 210], [196, 226, 244]];
  const hills = palette === 'sunset'
    ? [[92, 52, 88], [60, 38, 70], [36, 26, 48]]
    : [[40, 110, 120], [24, 82, 96], [12, 52, 64]];
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
  for (let y = 0; y < height; y++) {
    const t = y / height;
    const skyC = t < 0.5 ? lerp(sky[0], sky[1], t / 0.5) : lerp(sky[1], sky[2], Math.min(1, (t - 0.5) / 0.3));
    for (let x = 0; x < width; x++) {
      let c = skyC;
      const d = Math.hypot(x - sunX, y - sunY);
      if (d < sunR) c = palette === 'sunset' ? [255, 226, 150] : [255, 250, 230];
      else if (d < sunR * 3) {
        const g = 1 - (d - sunR) / (sunR * 2);
        c = lerp(c, [255, 230, 170], g * g * 0.6);
      }
      for (let l = 0; l < 3; l++) if (y > horizon(x, l)) c = hills[l];
      if (y > height * 0.86) {
        const tex = 0.75 + 0.25 * Math.sin(x * 0.9 + Math.sin(y * 0.35) * 3);
        c = [c[0] * tex, c[1] * tex, c[2] * tex];
      }
      const n = (rand() - 0.5) * noise;
      const o = (y * width + x) * 3;
      buf[o] = Math.max(0, Math.min(255, c[0] + n));
      buf[o + 1] = Math.max(0, Math.min(255, c[1] + n));
      buf[o + 2] = Math.max(0, Math.min(255, c[2] + n));
    }
  }
  return buf;
}

/** Flat-colour illustration (compresses well as PNG). */
function illustrationSvg(w: number, h: number, title: string, transparent = false) {
  const shapes: string[] = [];
  const rand = prng(77);
  const cols = ['#1473e6', '#eb1000', '#1a9e3f', '#ffb000', '#7a3ff2', '#00a3bf'];
  for (let i = 0; i < 26; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = 40 + rand() * (h / 6);
    const c = cols[i % cols.length];
    shapes.push(i % 3 === 0
      ? `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" fill-opacity="0.55"/>`
      : i % 3 === 1
        ? `<rect x="${x - r}" y="${y - r / 2}" width="${r * 2}" height="${r}" rx="${r / 6}" fill="${c}" fill-opacity="0.5"/>`
        : `<polygon points="${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}" fill="${c}" fill-opacity="0.45"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f7fc"/><stop offset="1" stop-color="#dfe7f5"/></linearGradient></defs>
    ${transparent ? '' : '<rect width="100%" height="100%" fill="url(#g)"/>'}${shapes.join('')}
    <text x="${w / 2}" y="${h / 2}" font-family="Helvetica" font-weight="bold" font-size="${h / 9}" fill="#1d1d1f" text-anchor="middle">${title}</text>
  </svg>`;
}

async function makeImages() {
  const doc = await PDFDocument.create();
  setInfo(doc, { title: 'Image-heavy document', author: 'PDF Wizard', subject: 'Compression test fixture' });
  const f = await embedFonts(doc);
  const W = 3000;
  const H = 2000;
  const jpg1 = await sharp(landscape(W, H, 11, 'sunset', 12), { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  const jpg2 = await sharp(landscape(W, H, 23, 'ocean', 12), { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  const PW = 2400;
  const PH = 1600;
  // Photo-like PNG (lossless, so it is the biggest win for "compress"): landscape + translucent shapes.
  const png = await sharp(landscape(PW, PH, 37, 'ocean', 6), { raw: { width: PW, height: PH, channels: 3 } })
    .composite([{ input: Buffer.from(illustrationSvg(PW, PH, 'PNG image', true)) }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const imgs = [
    { title: 'Evening landscape', img: await doc.embedJpg(jpg1), desc: `JPEG, ${W} x ${H} px, quality 95, ${(jpg1.length / 1048576).toFixed(1)} MB` },
    { title: 'Coastal morning', img: await doc.embedJpg(jpg2), desc: `JPEG, ${W} x ${H} px, quality 95, ${(jpg2.length / 1048576).toFixed(1)} MB` },
    { title: 'Harbor collage (PNG)', img: await doc.embedPng(png), desc: `PNG, ${PW} x ${PH} px, ${(png.length / 1048576).toFixed(1)} MB` },
  ];
  imgs.forEach(({ title, img, desc }, i) => {
    const page = doc.addPage([612, 792]);
    page.drawText(title, { x: 72, y: 700, size: 22, font: f.helvB, color: hex('#1d1d1f') });
    const dw = 468;
    const dh = (dw * img.height) / img.width;
    page.drawImage(img, { x: 72, y: 680 - 16 - dh, width: dw, height: dh });
    page.drawText(`Figure ${i + 1}: ${desc}. Displayed at ${Math.round((img.width / dw) * 72)} ppi.`, { x: 72, y: 680 - 32 - dh, size: 10, font: f.timesI, color: hex('#444444') });
    page.drawText('Downsampling this image to 150 ppi should reduce the file size substantially without visible loss at 100% zoom.', {
      x: 72,
      y: 680 - 52 - dh,
      size: 10,
      font: f.times,
      color: hex('#444444'),
      maxWidth: 468,
    });
    page.drawText(`Page ${i + 1} of 3`, { x: 290, y: 40, size: 9, font: f.helv, color: hex('#6e6e6e') });
  });
  const bytes = await doc.save({ useObjectStreams: false });
  await save('images.pdf', bytes);
  facts.images = imgs.map((x, i) => ({ page: i + 1, desc: x.desc }));

  // sample.jpg / sample.png
  const sj = await sharp(landscape(1600, 1067, 5, 'sunset', 8), { raw: { width: 1600, height: 1067, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  await save('sample.jpg', sj);
  const sp = await sharp(Buffer.from(illustrationSvg(1200, 800, 'PDF Wizard sample image'))).png({ compressionLevel: 9 }).toBuffer();
  await save('sample.png', sp);
}

// ─────────────────────────────────────────────────────────────────────────────
// Office / text fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SALES = [
  ['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'],
  ['North', 12500, 14200, 13900, 16800],
  ['South', 9800, 10150, 11020, 12400],
  ['East', 15300, 14900, 16250, 17100],
  ['West', 11200, 12750, 12100, 13900],
] as const;

async function makeDocx() {
  const cell = (s: string, header = false, align: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT) =>
    new TableCell({
      children: [new Paragraph({ alignment: align, children: [new TextRun({ text: s, bold: header })] })],
      shading: header ? { fill: 'D9E2F3', type: ShadingType.CLEAR, color: 'auto' } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
    });
  const rows = SALES.map((r, i) => {
    const values = i === 0 ? (r as readonly string[]).slice() : [String(r[0]), ...(r.slice(1) as number[]).map((v) => v.toLocaleString('en-US')), (r.slice(1) as number[]).reduce((a, b) => a + b, 0).toLocaleString('en-US')];
    return new TableRow({ tableHeader: i === 0, children: values.map((v, c) => cell(v, i === 0, c === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT)) });
  });
  const doc = new DocxDocument({
    creator: 'PDF Wizard fixtures',
    title: 'Quarterly Operations Report',
    description: 'Sample Word document for conversion tests',
    numbering: {
      config: [
        {
          reference: 'steps',
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
        },
      ],
    },
    sections: [
      {
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Quarterly Operations Report', color: '777777', size: 18 })] })] }) },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 18, color: '777777' })] })],
          }),
        },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Quarterly Operations Report')] }),
          new Paragraph({ children: [new TextRun({ text: 'Prepared for the PDF Wizard conversion tests', italics: true, color: '555555' })] }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('1. Overview')] }),
          new Paragraph({
            spacing: { after: 160 },
            children: [
              new TextRun('This document exercises the most common Word features: '),
              new TextRun({ text: 'bold', bold: true }),
              new TextRun(', '),
              new TextRun({ text: 'italic', italics: true }),
              new TextRun(' and '),
              new TextRun({ text: 'underlined', underline: {} }),
              new TextRun(' text, headings, bulleted and numbered lists, and a table with a shaded header row. When converted to PDF, the layout, fonts and table borders should be preserved.'),
            ],
          }),
          new Paragraph({
            spacing: { after: 160 },
            children: [new TextRun('Revenue grew in every region during the year, with the strongest results in the East. The table below lists quarterly revenue in US dollars.')],
          }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('2. Revenue by Region')] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 6, color: '555555' },
              bottom: { style: BorderStyle.SINGLE, size: 6, color: '555555' },
              left: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
              right: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
              insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' },
              insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' },
            },
            rows,
          }),
          new Paragraph({ spacing: { before: 120, after: 200 }, children: [new TextRun({ text: 'Table 1: Quarterly revenue (USD).', italics: true, size: 20 })] }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('3. Highlights')] }),
          ...[
            'Opened two new distribution centers.',
            'Reduced average delivery time by 11 percent.',
            'Digitized all incoming delivery notes.',
          ].map((t) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(t)] })),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('3.1 Next steps')] }),
          ...[
            'Review the regional targets with each manager.',
            'Publish the updated scanning guidelines.',
            'Schedule the annual audit for March.',
          ].map((t) => new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [new TextRun(t)] })),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('4. Conclusion')] }),
          new Paragraph({
            children: [new TextRun('The operations team met its targets for the year. Questions about this report can be sent to the operations desk.')],
          }),
        ],
      },
    ],
  });
  await save('sample.docx', await Packer.toBuffer(doc));
}

async function makeCsvXlsx() {
  const lines = SALES.map((r, i) =>
    i === 0 ? (r as readonly string[]).join(',') : [r[0], ...r.slice(1), (r.slice(1) as number[]).reduce((a, b) => a + b, 0)].join(','),
  );
  const csv = lines.join('\n') + '\n';
  await save('sample.csv', csv);
  if (!findExecutable('soffice')) {
    console.warn('  sample.xlsx        skipped (soffice not found)');
    return false;
  }
  await withTempDir(async (dir) => {
    const src = path.join(dir, 'sample.csv');
    await fsp.writeFile(src, csv);
    const out = await sofficeConvert(src, 'xlsx:Calc MS Excel 2007 XML', path.join(dir, 'out'), {
      infilter: 'CSV:44,34,76,1',
    });
    await save('sample.xlsx', await fsp.readFile(out));
  });
  return true;
}

async function makeTextFiles() {
  const txt = `PDF Wizard - Sample Text File
==============================

This plain text file is used to test converting text documents to PDF.
It contains several paragraphs, a list and some longer lines that must wrap.

Document workflows usually begin with a draft. The draft is reviewed,
commented on, revised and finally approved. At each step the document
may be converted between formats, combined with other files, or signed.

Checklist:
  - Open the file
  - Convert it to PDF
  - Verify that every line appears in the output

A very long line follows so that the converter has to wrap it: Lorem ipsum is not used here; instead this sentence simply keeps going for a while, describing how a converter should break long lines at word boundaries rather than cutting words in half.

Special characters: café, naïve, résumé, 25 °C, 10 € - these should survive conversion.

End of file.
`;
  await save('sample.txt', txt);
  const rowsHtml = SALES.slice(1)
    .map((r) => `<tr><td>${r[0]}</td>${(r.slice(1) as number[]).map((v) => `<td class="n">${v.toLocaleString('en-US')}</td>`).join('')}<td class="n"><b>${(r.slice(1) as number[]).reduce((a, b) => a + b, 0).toLocaleString('en-US')}</b></td></tr>`)
    .join('\n        ');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PDF Wizard - Sample HTML Page</title>
  <style>
    body { font-family: Helvetica, Arial, sans-serif; margin: 40px; color: #1d1d1f; line-height: 1.5; }
    h1 { color: #eb1000; border-bottom: 2px solid #eb1000; padding-bottom: 6px; }
    h2 { color: #1b3a6b; margin-top: 28px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #b5b5b5; padding: 6px 10px; }
    th { background: #eceef3; text-align: left; }
    td.n { text-align: right; }
    .note { background: #fff8d6; border-left: 4px solid #ffb000; padding: 8px 12px; }
  </style>
</head>
<body>
  <h1>PDF Wizard Sample Page</h1>
  <p>This HTML page is used to test converting web pages to PDF. It includes headings, paragraphs,
     <strong>bold</strong> and <em>italic</em> text, a <a href="https://example.com">link</a>, lists and a table.</p>
  <h2>Features</h2>
  <ul>
    <li>View and search documents</li>
    <li>Comment and mark up text</li>
    <li>Fill and sign forms</li>
  </ul>
  <h2>Steps</h2>
  <ol>
    <li>Open the page</li>
    <li>Convert it to PDF</li>
    <li>Check the output</li>
  </ol>
  <h2>Quarterly revenue</h2>
  <table>
    <thead><tr><th>Region</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>Total</th></tr></thead>
    <tbody>
        ${rowsHtml}
    </tbody>
  </table>
  <p class="note">Note: numbers are in US dollars.</p>
</body>
</html>
`;
  await save('sample.html', html);
}

// ─────────────────────────────────────────────────────────────────────────────
// verification
// ─────────────────────────────────────────────────────────────────────────────

const verification: string[] = [];

async function verify() {
  const havePdftotext = !!findExecutable('pdftotext');
  const havePdftoppm = !!findExecutable('pdftoppm');
  if (!havePdftotext || !havePdftoppm) {
    console.warn('  poppler not found - skipping verification');
    return;
  }
  const pdfs = ['sample.pdf', 'form.pdf', 'annotated.pdf', 'scanned.pdf', 'encrypted.pdf', 'rotated.pdf', 'mixed-sizes.pdf', 'large.pdf', 'images.pdf'];
  const previewDir = path.join(os.tmpdir(), 'pdfwizard-fixture-previews');
  await fsp.mkdir(previewDir, { recursive: true });
  for (const name of pdfs) {
    const file = path.join(OUT, name);
    const pw = name === 'encrypted.pdf' ? ['-upw', 'secret'] : [];
    const txt = await run('pdftotext', [...pw, '-layout', file, '-'], { timeoutMs: 60_000 });
    await run('pdftoppm', [...pw, '-png', '-r', '50', '-f', '1', '-l', '2', file, path.join(previewDir, name.replace('.pdf', ''))], { timeoutMs: 60_000 });
    const pages = txt.stdout.split('\f').length - 1;
    verification.push(`${name}: pdftotext OK (${pages} pages), pdftoppm OK`);
    if (name === 'sample.pdf') {
      const s = facts.sample as { wizardTotal: number };
      const found = countOf(txt.stdout, 'Wizard');
      if (found !== s.wizardTotal) throw new Error(`sample.pdf: pdftotext finds "Wizard" ${found}x, expected ${s.wizardTotal}`);
    }
    if (name === 'scanned.pdf' && txt.stdout.replace(/\s/g, '') !== '') throw new Error('scanned.pdf unexpectedly has a text layer');
    if (name === 'large.pdf' && pages !== 300) throw new Error(`large.pdf has ${pages} pages`);
  }
  // encrypted.pdf must not open without the password, and must open with the owner password
  let failedWithout = false;
  try {
    await run('pdftotext', [path.join(OUT, 'encrypted.pdf'), '-'], { timeoutMs: 30_000 });
  } catch {
    failedWithout = true;
  }
  if (!failedWithout) throw new Error('encrypted.pdf opened without a password');
  const owner = await run('pdftotext', ['-opw', 'owner', path.join(OUT, 'encrypted.pdf'), '-']);
  if (!owner.stdout.includes('Confidential Budget Summary')) throw new Error('encrypted.pdf: owner password did not decrypt');
  verification.push('encrypted.pdf: rejected without password; opens with -upw secret and -opw owner');
  // OCR smoke test of the scan
  if (findExecutable('tesseract')) {
    await withTempDir(async (dir) => {
      await run('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '1', path.join(OUT, 'scanned.pdf'), path.join(dir, 'scan')]);
      const img = (await fsp.readdir(dir)).find((f) => f.endsWith('.png'))!;
      const ocr = await run('tesseract', [path.join(dir, img), '-', '-l', 'eng'], { timeoutMs: 120_000 });
      const words = ['MEMORANDUM', 'scanning', 'audit', 'Whitfield'];
      const missing = words.filter((w) => !ocr.stdout.includes(w));
      if (missing.length) throw new Error(`scanned.pdf OCR is missing: ${missing.join(', ')}\n${ocr.stdout}`);
      verification.push(`scanned.pdf: tesseract recognizes ${words.map((w) => `"${w}"`).join(', ')} on page 1`);
    });
  }
  console.log(`  previews (50 dpi) in ${previewDir}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// README
// ─────────────────────────────────────────────────────────────────────────────

async function writeReadme(hasXlsx: boolean) {
  const s = facts.sample as {
    wizardTotal: number;
    wizardPerPage: number[];
    wizardCaseInsensitive: number;
    workflowTotal: number;
    tocLinks: { title: string; targetPage: number; rect: number[] }[];
    externalLink: { page: number; url: string; rect: number[] };
    outline: OutlineNode[];
  };
  const outlineMd = (nodes: OutlineNode[], depth = 0): string =>
    nodes
      .map((n) => {
        const flags = [n.children?.length ? (n.open ? 'open' : 'closed') : '', n.bold ? 'bold' : '', n.italic ? 'italic' : '', n.color ? 'blue' : ''].filter(Boolean).join(', ');
        return `${'  '.repeat(depth)}- ${n.title} -> page ${n.page + 1}${flags ? ` (${flags})` : ''}\n${n.children ? outlineMd(n.children, depth + 1) : ''}`;
      })
      .join('');
  const form = facts.form as { fields: { name: string; type: string; label: string; rect: number[]; options?: string[]; notes?: string }[] };
  const ann = facts.annotated as AnnotFact[];
  const rot = facts.rotated as { page: number; rotate: number; mediaBox: number[]; cropBox: number[]; displayed: string; corners: Record<string, number[]> }[];
  const mixed = facts.mixed as { page: number; name: string; width: number; height: number }[];
  const large = facts.large as { chapters: { title: string; page: number }[] };
  const scanned = facts.scanned as { text: string[]; pixelSize: number[]; dpi: number };
  const images = facts.images as { page: number; desc: string }[];
  const table = facts.sampleTable as { rect: number[]; rows: number; cols: number };
  const r = (a: number[]) => `[${a.map((v) => num(v)).join(', ')}]`;

  const md = `# Test fixtures

Generated by \`npm run fixtures\` (scripts/make-fixtures.ts). Do not edit by hand: re-run the script.
Content is deterministic (fixed dates, seeded noise); bytes can differ between runs (random font resource
names, encryption salt), so compare text/geometry rather than hashes. All coordinates are PDF
user space (points, origin bottom-left, y up). Page numbers are 1-based.

| File | Pages | Purpose |
|---|---|---|
| sample.pdf | 6 | report with headings, prose, numbered list, ruled table, linked TOC, external link, nested outline |
| form.pdf | 1 | AcroForm with every common field type |
| annotated.pdf | 2 | existing annotations of 12 kinds, all with appearance streams |
| scanned.pdf | 2 | image-only pages (no text layer) for OCR |
| encrypted.pdf | 2 | user password \`secret\`, owner password \`owner\` (AES-256) |
| rotated.pdf | 7 | /Rotate 0/90/180/270, offset MediaBox, CropBox |
| mixed-sizes.pdf | 5 | Letter, A4, Legal, Letter landscape, A6 |
| large.pdf | 300 | big page numbers, per-page reference codes, chapter bookmarks |
| images.pdf | 3 | large embedded images for compression |
| sample.docx | - | Word: title, headings, formatted runs, table, bullet + numbered list, header/footer |
| sample.xlsx | - | ${hasXlsx ? 'Excel workbook converted by LibreOffice from sample.csv' : '(not generated: soffice missing)'} |
| sample.csv | - | the same sales table as CSV |
| sample.png / sample.jpg | - | 1200x800 flat PNG illustration / 1600x1067 photo-like JPEG |
| sample.txt / sample.html | - | text and HTML documents for conversion (UTF-8, include accented characters) |

## sample.pdf

- 6 Letter pages (612 x 792). Fonts: Helvetica, Helvetica-Bold, Helvetica-Oblique, Times-Roman, Times-Italic (standard 14, not embedded).
- Metadata: Title "PDF Wizard: Document Workflows in the Browser", Author "Document Platform Team",
  Subject "Technical overview and product report", Keywords "PDF workflow browser report".
- Page 1 title page ("PDF Wizard" / "Document Workflows in the Browser" + abstract); page 2 "Contents";
  pages 3-6 sections 1-4. Pages 2-6 have the running header "Document Workflows in the Browser" / "January 2026"
  and footer "Page N of 6".
- **"Wizard" (case-sensitive) appears ${s.wizardTotal} times** in the page text; per page: ${s.wizardPerPage.map((n, i) => `p${i + 1}: ${n}`).join(', ')}.
  Case-insensitive "wizard": ${s.wizardCaseInsensitive}. Case-insensitive "workflow" (incl. "workflows"): ${s.workflowTotal}.
- Numbered list (5 items, "1." to "5.") on page 4 under "2.1 Reviewing and Commenting".
- Ruled table "Table 1" on page 5: ${table.rows} rows (incl. header) x ${table.cols} columns, bounds ${r(table.rect)};
  header: Operation | Document | Median (ms) | 95th pct (ms).
- Page 2 has ${s.tocLinks.length} internal link annotations (GoTo /XYZ destinations):
${s.tocLinks.map((l) => `  - "${l.title}" -> page ${l.targetPage}, rect ${r(l.rect)}`).join('\n')}
- Page 6 has 1 external link (URI action) to ${s.externalLink.url}, rect ${r(s.externalLink.rect)}.
- No other annotations. PageMode /UseOutlines. Outline (bookmarks):
${outlineMd(s.outline)}
## form.pdf

1 Letter page titled "Customer Registration Form". All fields have appearance streams
(\`form.updateFieldAppearances\`), are empty/unchecked initially and have tooltips (/TU).
Required fields: full_name, email, agree_terms.

| Field name | Type | Label | Rect [x0, y0, x1, y1] | Options / notes |
|---|---|---|---|---|
${form.fields.map((x) => `| \`${x.name}\` | ${x.type} | ${x.label} | ${r(x.rect)} | ${[x.options?.join(', '), x.notes].filter(Boolean).join('; ')} |`).join('\n')}

Checkbox on-state export value is \`Yes\`; radio export values are the option names (\`email\`, \`phone\`, \`mail\`).
The signature box is also drawn on the page content (dashed rectangle with "X" line and "Sign here").

## annotated.pdf

2 Letter pages ("Design Review: Q3 Launch Plan" / "Architecture Sketch"). Every annotation has /AP /N,
/T (author), /M and /CreationDate (${pdfDate(FIXED_DATE)}), /Contents, /Subj, /NM (\`fixture-annot-N\`) and /F 4 (print).
Page 1 also contains one /Popup annotation (child of the sticky note). The word "recieve" on page 1 is a deliberate typo.

| Page | Type | Author | Contents | Color | Rect | Notes |
|---|---|---|---|---|---|---|
${ann.map((a) => `| ${a.page} | ${a.type} | ${a.author} | ${a.contents} | ${a.color} | ${r(a.rect)} | ${a.extra ?? ''} |`).join('\n')}

Counts: page 1 = ${ann.filter((a) => a.page === 1).length} markup/note annotations + 1 Popup; page 2 = ${ann.filter((a) => a.page === 2).length}.

## scanned.pdf

2 Letter pages, each a single grayscale JPEG (${scanned.pixelSize.join(' x ')} px = ${scanned.dpi} dpi, slight rotation
of +0.45 / -0.35 degrees, noise and dust specks). No fonts, no text layer (pdftotext returns nothing).
Text rendered on the images (what OCR should find):

Page 1:
\`\`\`
${scanned.text[0]}
\`\`\`
Page 2:
\`\`\`
${scanned.text[1]}
\`\`\`

## encrypted.pdf

2 pages, AES-256 (V5/R6). User password \`secret\` (needed to open), owner password \`owner\`. All permissions granted
(print high-res, modify, copy, annotate, fill forms, accessibility, assemble). Title (encrypted in Info):
"Confidential Budget Summary". Page 1 heading "Confidential Budget Summary"; page 2 "Allocation by Department".
\`PDFDocument.load(bytes, { password: 'secret' })\` works with @cantoo/pdf-lib; pdf.js asks for a password.

## rotated.pdf

Content is drawn counter-rotated so that **every page reads upright with "TOP" at the visual top when /Rotate is honored**.
Colored squares mark the visual corners: TL red, TR green, BL blue, BR orange; each is labelled with the user-space
coordinate of that corner of the visible box.

| Page | /Rotate | MediaBox | CropBox | Displayed (w x h) | TL | TR | BL | BR |
|---|---|---|---|---|---|---|---|---|
${rot.map((p) => `| ${p.page} | ${p.rotate} | ${r(p.mediaBox)} | ${r(p.cropBox)} | ${p.displayed} | ${r(p.corners.TL)} | ${r(p.corners.TR)} | ${r(p.corners.BL)} | ${r(p.corners.BR)} |`).join('\n')}

## mixed-sizes.pdf

| Page | Size | Width x Height (pt) |
|---|---|---|
${mixed.map((m) => `| ${m.page} | ${m.name} | ${num(m.width)} x ${num(m.height)} |`).join('\n')}

## large.pdf

300 Letter pages. Each page shows its number in 150pt type, the string \`Reference code R-NNNN\` (zero-padded page
number, e.g. \`R-0123\` on page 123, Courier) and "Page N of 300" in the footer. 12 chapters of 25 pages; the outline
has one bookmark per chapter:
${large.chapters.map((c) => `- ${c.title} -> page ${c.page}`).join('\n')}

## images.pdf

${images.map((i) => `- Page ${i.page}: ${i.desc}`).join('\n')}

Each image is drawn 468pt wide (about 460/370 ppi), so downsampling to 150 ppi shrinks the file substantially.

## Verification (last run)

${verification.map((v) => `- ${v}`).join('\n') || '- (poppler not available; not verified)'}
`;
  await save('README.md', md);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const t0 = Date.now();
  console.log(`Writing fixtures to ${path.relative(process.cwd(), OUT) || OUT}/`);
  const tmpDoc = await PDFDocument.create();
  const metricFonts = { times: await tmpDoc.embedFont(StandardFonts.TimesRoman), timesB: await tmpDoc.embedFont(StandardFonts.TimesRomanBold) };
  await makeSample();
  await makeForm();
  await makeAnnotated();
  await makeScanned(metricFonts);
  await makeEncrypted();
  await makeRotated();
  await makeMixedSizes();
  await makeLarge();
  await makeImages();
  await makeDocx();
  const hasXlsx = await makeCsvXlsx().catch((e) => {
    console.warn(`  sample.xlsx        failed: ${(e as Error).message}`);
    return false;
  });
  await makeTextFiles();
  console.log('Verifying…');
  await verify();
  await writeReadme(hasXlsx);
  for (const v of verification) console.log(`  ${v}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!fs.existsSync(path.join(OUT, 'sample.pdf'))) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
