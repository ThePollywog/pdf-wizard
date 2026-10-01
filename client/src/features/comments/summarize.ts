/**
 * "Create comment summary": a new PDF (opened in a new tab) with, for every page that has
 * comments, the page as it looks with its comments (flattened) and numbered markers next to a
 * list of the comments on that page — type, author, date, status, the marked-up text, the
 * comment and its replies. Long lists continue on further pages.
 */
import * as fontkitNs from '@pdf-lib/fontkit';
import {
  PDFDocument, PDFHexString, PDFName, StandardFonts, TextRenderingMode, beginText, degrees, endText, popGraphicsState, pushGraphicsState, rgb,
  setCharacterSqueeze, setFontAndSize, setTextMatrix, setTextRenderingMode, showText, type PDFFont, type PDFPage, type RGB,
} from '@cantoo/pdf-lib';
import type { DocId } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import * as engine from '@/core/engine';
import { baseName, hexToRgb01 } from '@/core/util';
import { fullTime, isWinAnsi, LIBERATION_URL, fetchFont, normRotation, STATUS_LABEL } from './model';
import { byPosition, commentItems, type Item } from './list';
import { CSS_FONT } from './layout';
import { covers, invisibleRuns, invisibleScale, rasterText, renderedWidth } from './rasterText';

const fontkit = ((fontkitNs as unknown as { default?: unknown }).default ?? fontkitNs) as Parameters<PDFDocument['registerFontkit']>[0];

const PAGE_W = 792;
const PAGE_H = 612;
const M = 32;
const GAP = 20;
const HEADER_H = 34;
const IMAGE_W = 360;
const ACCENT = rgb(0.078, 0.451, 0.902);
const TEXT = rgb(0.13, 0.13, 0.13);
const MUTED = rgb(0.43, 0.43, 0.43);
const RULE = rgb(0.85, 0.85, 0.85);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

/** How each font looks when text it doesn't cover (CJK…) is rendered by the browser instead. */
const cssStyle = new WeakMap<PDFFont, { weight: number; italic: boolean }>();

/** Width of `text`: the font's own metrics, or the browser's for text drawn as an image. */
function textWidth(font: PDFFont, text: string, size: number): number {
  if (covers(font, text)) return font.widthOfTextAtSize(text, size);
  const st = cssStyle.get(font);
  return renderedWidth(text, CSS_FONT.Helvetica, size, `${st?.italic ? 'italic ' : ''}${st?.weight ?? 400}`);
}

const cssColor = (c: RGB) => `rgb(${Math.round(c.red * 255)}, ${Math.round(c.green * 255)}, ${Math.round(c.blue * 255)})`;

/** page.drawText() that also handles text the font doesn't cover (image + invisible text). */
async function drawStr(page: PDFPage, text: string, o: { x: number; y: number; size: number; font: PDFFont; color: RGB }) {
  if (!text) return;
  if (covers(o.font, text)) {
    page.drawText(text, o);
    return;
  }
  const doc = page.doc;
  const st = cssStyle.get(o.font);
  const width = textWidth(o.font, text, o.size);
  const r = await rasterText(doc, text, { cssFont: CSS_FONT.Helvetica, size: o.size, color: cssColor(o.color), width, weight: st?.weight, italic: st?.italic });
  if (r) page.drawImage(r.image, { x: o.x + r.x, y: o.y + r.y, width: r.width, height: r.height });
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(r ? TextRenderingMode.Invisible : TextRenderingMode.Fill)];
  ops.push(setCharacterSqueeze(invisibleScale(text, o.size, width)), setTextMatrix(1, 0, 0, 1, o.x, o.y));
  invisibleRuns(doc, text).forEach((run, i) => {
    const name = PDFName.of(`CmInv${invCounter++}_${i}`);
    page.node.setFontDictionary(name, run.ref);
    ops.push(setFontAndSize(name, o.size), showText(PDFHexString.of(run.hex.slice(1, -1))));
  });
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}
let invCounter = 0;

/** Ideographs / kana / hangul / full-width forms: lines may break between any two of them. */
const CJK = '\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF';
const TOKENS = new RegExp(`\\s+|[${CJK}]|[^\\s${CJK}]+`, 'g');

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const tok of para.match(TOKENS) ?? []) {
      if (!tok.trim()) {
        if (line) line += tok;
        continue;
      }
      if (textWidth(font, (line + tok).trimEnd(), size) <= width) {
        line += tok;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = tok;
      // A word longer than the line is broken by characters.
      if (textWidth(font, tok, size) > width) {
        let chunk = '';
        for (const ch of Array.from(tok)) {
          if (chunk && textWidth(font, chunk + ch, size) > width) {
            out.push(chunk);
            chunk = '';
          }
          chunk += ch;
        }
        line = chunk;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const rgbOf = (hex: string | null | undefined) => {
  if (!hex) return MUTED;
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
};

/** Maps a user-space point of a page (view box `view`, rotation `rot`) into the drawn image. */
function placer(view: [number, number, number, number], rot: number, x: number, y: number, s: number) {
  const w = view[2] - view[0];
  const h = view[3] - view[1];
  return (ux: number, uy: number) => {
    const px = ux - view[0];
    const py = uy - view[1];
    let dx: number, dy: number;
    switch (rot) {
      case 90:
        [dx, dy] = [py, w - px];
        break;
      case 180:
        [dx, dy] = [w - px, h - py];
        break;
      case 270:
        [dx, dy] = [h - py, px];
        break;
      default:
        [dx, dy] = [px, py];
    }
    return { x: x + dx * s, y: y + dy * s };
  };
}

interface Block {
  lines: { text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb>; indent: number }[];
  item: Item;
  n: number;
}

function blockFor(item: Item, n: number, f: Fonts, width: number): Block {
  const o = item.o;
  const lines: Block['lines'] = [];
  const add = (text: string, font: PDFFont, size: number, color: ReturnType<typeof rgb>, indent = 0) => {
    for (const l of wrap(text, font, size, width - indent)) lines.push({ text: l, font, size, color, indent });
  };
  const status = o.status && o.status !== 'none' ? `  ·  ${STATUS_LABEL[o.status]}` : '';
  add(`${item.label}  ·  ${o.author || 'Unknown'}`, f.bold, 9.5, TEXT);
  add(`${fullTime(o.modifiedAt || o.createdAt)}${status}`, f.regular, 8, MUTED);
  if (item.summary && item.summary !== o.contents) add(`“${item.summary}”`, f.italic, 9, MUTED);
  if (o.contents) add(o.contents, f.regular, 9.5, TEXT);
  for (const r of o.replies ?? []) {
    add(`${r.author || 'Unknown'} replied (${fullTime(r.createdAt)}):`, f.bold, 8.5, MUTED, 12);
    add(r.text, f.regular, 9, TEXT, 12);
  }
  return { lines, item, n };
}

const lineH = (size: number) => size * 1.3;
const blockHeight = (b: Block) => b.lines.reduce((h, l) => h + lineH(l.size), 0) + 10;

export async function summarizeComments(docId: DocId): Promise<DocId | null> {
  const doc = getDoc(docId);
  if (!doc) return null;
  const items = commentItems(doc).sort(byPosition);
  if (!items.length) {
    actions.toast('There are no comments to summarize.');
    return null;
  }
  const result = await actions.withBusy('Creating comment summary…', async (report) => {
    const flat = await engine.exportPdf(docId, { purpose: 'download', flatten: true, skipSecurity: true });
    const src = await PDFDocument.load(flat, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
    const out = await PDFDocument.create();
    out.setTitle(`Summary of comments on ${doc.name}`);
    out.setCreator('PDF Wizard');
    out.setProducer('PDF Wizard');

    const allText = [doc.name, ...items.flatMap((i) => [i.label, i.summary, i.o.author, i.o.contents ?? '', ...(i.o.replies ?? []).flatMap((r) => [r.author, r.text])])].join('\n');
    let fonts: Fonts;
    if (isWinAnsi(allText)) {
      fonts = {
        regular: await out.embedFont(StandardFonts.Helvetica),
        bold: await out.embedFont(StandardFonts.HelveticaBold),
        italic: await out.embedFont(StandardFonts.HelveticaOblique),
      };
    } else {
      out.registerFontkit(fontkit);
      const [reg, bold, italic] = await Promise.all([fetchFont(LIBERATION_URL.regular), fetchFont(LIBERATION_URL.bold), fetchFont(LIBERATION_URL.italic)]);
      fonts = {
        regular: engine.patchFontkitSubset(await out.embedFont(reg, { subset: true })),
        bold: engine.patchFontkitSubset(await out.embedFont(bold, { subset: true })),
        italic: engine.patchFontkitSubset(await out.embedFont(italic, { subset: true })),
      };
    }
    cssStyle.set(fonts.regular, { weight: 400, italic: false });
    cssStyle.set(fonts.bold, { weight: 700, italic: false });
    cssStyle.set(fonts.italic, { weight: 400, italic: true });

    const byPage = new Map<number, Item[]>();
    for (const it of items) byPage.set(it.pageIndex, [...(byPage.get(it.pageIndex) ?? []), it]);
    const srcPages = src.getPages();
    const listX = M + IMAGE_W + GAP;
    const listW = PAGE_W - listX - M;
    let n = 0;
    let done = 0;
    let first = true;

    for (const [pi, list] of byPage) {
      const info = doc.pages[pi];
      const sp = srcPages[pi];
      if (!info || !sp) continue;
      const view = info.view;
      const embedded = await out.embedPage(sp, { left: view[0], bottom: view[1], right: view[2], top: view[3] });
      // The summary shows pages as they are in the document (the view rotation is not part of it).
      const rot = normRotation(info.rotation || 0);
      const w = view[2] - view[0];
      const h = view[3] - view[1];
      const dispW = rot % 180 ? h : w;
      const dispH = rot % 180 ? w : h;
      const availH = PAGE_H - 2 * M - HEADER_H;
      const s = Math.min(IMAGE_W / dispW, availH / dispH);
      const imgW = dispW * s;
      const imgH = dispH * s;
      const imgX = M + (IMAGE_W - imgW) / 2;
      const imgY = PAGE_H - M - HEADER_H - imgH;
      const blocks = list.map((it) => blockFor(it, ++n, fonts, listW - 22));

      let bi = 0;
      let part = 0;
      while (bi < blocks.length) {
        const page = out.addPage([PAGE_W, PAGE_H]);
        await drawHeader(page, fonts, first ? `Summary of comments on ${doc.name}` : doc.name, `Page ${info.label || pi + 1}${part ? ' (continued)' : ''}`, first);
        first = false;
        drawPageImage(page, embedded, rot, imgX, imgY, imgW, imgH, s);
        // markers for every comment of the page
        const place = placer(view, rot, imgX, imgY, s);
        for (const b of blocks) drawMarker(page, fonts, b, place, imgX, imgY, imgW, imgH);
        // list
        let y = PAGE_H - M - HEADER_H;
        while (bi < blocks.length) {
          const b = blocks[bi];
          const bh = blockHeight(b);
          if (y - bh < M && y < PAGE_H - M - HEADER_H) break;
          await drawBlock(page, fonts, b, listX, y);
          y -= bh;
          bi++;
          done++;
        }
        part++;
        report(done / items.length);
      }
    }
    return out.save();
  });
  if (!result) return null;
  const id = await engine.newDocumentFromBytes(`${baseName(doc.name)} (comments summary).pdf`, result);
  if (id) actions.toast(`Created a summary of ${items.length} comment${items.length === 1 ? '' : 's'}.`, { kind: 'success' });
  return id;
}

async function drawHeader(page: PDFPage, f: Fonts, title: string, sub: string, first: boolean) {
  const y = PAGE_H - M - 14;
  const size = first ? 13 : 11;
  const maxW = PAGE_W - 2 * M - 120;
  let t = title;
  while (t.length > 4 && textWidth(f.bold, t, size) > maxW) t = `${Array.from(t).slice(0, -2).join('')}…`;
  await drawStr(page, t, { x: M, y, size, font: f.bold, color: TEXT });
  const sw = textWidth(f.regular, sub, 10);
  await drawStr(page, sub, { x: PAGE_W - M - sw, y, size: 10, font: f.regular, color: MUTED });
  page.drawLine({ start: { x: M, y: y - 10 }, end: { x: PAGE_W - M, y: y - 10 }, thickness: 0.75, color: RULE });
}

function drawPageImage(page: PDFPage, embedded: Awaited<ReturnType<PDFDocument['embedPage']>>, rot: number, x: number, y: number, w: number, h: number, s: number) {
  page.drawRectangle({ x: x - 0.5, y: y - 0.5, width: w + 1, height: h + 1, color: rgb(1, 1, 1), borderColor: RULE, borderWidth: 1 });
  // drawPage rotates counter-clockwise around (x, y): offset so the rotated page lands in the box.
  const ew = embedded.width * s;
  const eh = embedded.height * s;
  const at =
    rot === 90 ? { x, y: y + ew } : rot === 180 ? { x: x + ew, y: y + eh } : rot === 270 ? { x: x + eh, y } : { x, y };
  page.drawPage(embedded, { x: at.x, y: at.y, xScale: s, yScale: s, rotate: degrees(-rot) });
}

function drawMarker(
  page: PDFPage,
  f: Fonts,
  b: Block,
  place: (x: number, y: number) => { x: number; y: number },
  ix: number,
  iy: number,
  iw: number,
  ih: number,
) {
  const r = b.item.o.rect;
  const corners = [place(r.x, r.y), place(r.x + r.width, r.y), place(r.x, r.y + r.height), place(r.x + r.width, r.y + r.height)];
  // top-left corner of the comment as displayed
  const cx = Math.min(...corners.map((c) => c.x));
  const cy = Math.max(...corners.map((c) => c.y));
  const R = 6;
  const x = Math.min(ix + iw - R, Math.max(ix + R, cx));
  const y = Math.min(iy + ih - R, Math.max(iy + R, cy));
  page.drawCircle({ x, y, size: R, color: ACCENT, borderColor: rgb(1, 1, 1), borderWidth: 1 });
  const label = String(b.n);
  const size = label.length > 2 ? 5.5 : 7;
  const tw = f.bold.widthOfTextAtSize(label, size);
  page.drawText(label, { x: x - tw / 2, y: y - size * 0.36, size, font: f.bold, color: rgb(1, 1, 1) });
}

async function drawBlock(page: PDFPage, f: Fonts, b: Block, x: number, top: number) {
  const R = 7;
  const color = rgbOf(b.item.o.color ?? b.item.o.fillColor);
  page.drawCircle({ x: x + R, y: top - R - 1, size: R, color: ACCENT });
  const label = String(b.n);
  const size = label.length > 2 ? 6 : 7.5;
  const tw = f.bold.widthOfTextAtSize(label, size);
  page.drawText(label, { x: x + R - tw / 2, y: top - R - 1 - size * 0.36, size, font: f.bold, color: rgb(1, 1, 1) });
  // color chip of the comment
  page.drawRectangle({ x: x + 2 * R + 4, y: top - blockHeight(b) + 12, width: 2, height: blockHeight(b) - 12, color });
  let y = top;
  for (const l of b.lines) {
    y -= lineH(l.size);
    if (l.text) await drawStr(page, l.text, { x: x + 22 + l.indent, y: y + l.size * 0.25, size: l.size, font: l.font, color: l.color });
  }
  page.drawLine({ start: { x: x + 22, y: top - blockHeight(b) + 4 }, end: { x: PAGE_W - M, y: top - blockHeight(b) + 4 }, thickness: 0.5, color: RULE });
}
