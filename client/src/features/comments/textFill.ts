/**
 * Markups imported from other apps don't carry the marked-up text; fill it in from the page text
 * under the quads once the page text is available (not an edit: no undo step, no dirty flag).
 */
import { StandardFontEmbedder, StandardFonts } from '@cantoo/pdf-lib';
import type { DocId, PdfObject, Rect } from '@/core/types';
import { actions, getDoc, useApp } from '@/core/store';
import * as engine from '@/core/engine';
import { quadList, quadsBBox } from './quads';
import type { CaretObject, MarkupObject } from './model';
import { cleanSelectedText } from './markup';

const inFlight = new Set<string>();

function pending(o: PdfObject): number[] | null {
  if (o.kind === 'text-markup') {
    const d = (o as MarkupObject).data;
    return d.textPending ? d.quads : null;
  }
  if (o.kind === 'caret') {
    const s = (o as CaretObject).data.strike;
    return s?.textPending ? s.quads : null;
  }
  return null;
}

/** Relative advance of each character of a text item, in 1/size units. */
type Measure = (ch: string) => number;

const embedders = new Map<string, StandardFontEmbedder | null>();
const measures = new Map<string, Measure>();

/** Standard 14 font whose metrics best match a font called `name` (generic family as a hint). */
function standardFontFor(name: string, family: string): StandardFonts | null {
  const n = name.replace(/^[A-Z]{6}\+/, '');
  if (/symbol|dingbat|wingding/i.test(n)) return null;
  const bold = /bold|black|heavy|semibold|demi/i.test(n);
  const italic = /italic|oblique/i.test(n);
  const sans = /sans|arial|helv|grotesk/i.test(n);
  if (/courier|mono|consol|menlo/i.test(n) || (!sans && family === 'monospace')) {
    return bold ? (italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold) : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  }
  if (!sans && (/times|roman|serif|georgia|garamond|cambria|minion|palatino/i.test(n) || family === 'serif')) {
    return bold ? (italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold) : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  }
  return bold ? (italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

function measureFor(name: string, family: string): Measure {
  const key = `${name}|${family}`;
  const hit = measures.get(key);
  if (hit) return hit;
  const std = standardFontFor(name, family) ?? StandardFonts.Helvetica;
  let emb = embedders.get(std);
  if (emb === undefined) {
    try {
      emb = StandardFontEmbedder.for(std as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    } catch {
      emb = null;
    }
    embedders.set(std, emb);
  }
  const cache = new Map<string, number>();
  const m: Measure = (ch) => {
    let w = cache.get(ch);
    if (w !== undefined) return w;
    try {
      w = emb ? emb.widthOfTextAtSize(ch, 1) : 0;
    } catch {
      w = 0;
    }
    if (!(w > 0)) w = /\s/.test(ch) ? 0.278 : 0.556;
    cache.set(ch, w);
    return w;
  };
  measures.set(key, m);
  return m;
}

const fallbackMeasure: Measure = (ch) => measureFor('', 'sans-serif')(ch);

/** Font name (e.g. "Times-Roman") and generic family of every pdf.js font id used on a page. */
async function pageFonts(docId: DocId, pageIndex: number): Promise<Map<string, Measure>> {
  const out = new Map<string, Measure>();
  const pdf = getDoc(docId)?.pdf;
  if (!pdf) return out;
  try {
    const page = await pdf.getPage(pageIndex + 1);
    const tc = await page.getTextContent();
    const objs = (page as unknown as { commonObjs?: { has(id: string): boolean; get(id: string): unknown } }).commonObjs;
    for (const [id, style] of Object.entries(tc.styles ?? {})) {
      let name = '';
      try {
        const f = objs?.has(id) ? (objs.get(id) as { name?: string } | null) : null;
        name = typeof f?.name === 'string' ? f.name : '';
      } catch {
        name = '';
      }
      out.set(id, measureFor(name, (style as { fontFamily?: string }).fontFamily ?? ''));
    }
  } catch {
    /* page gone / document replaced: equal-ish widths */
  }
  return out;
}

/** Text of the page items under `quads` (character ranges along each item, by glyph widths). */
export function textUnderQuads(items: engine.PageTextItem[], quads: number[], fonts?: Map<string, Measure>): string {
  const parts: string[] = [];
  for (const q of quadList(quads)) {
    const r = quadsBBox([q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]);
    const line: string[] = [];
    for (const it of items) {
      if (!it.str) continue;
      const piece = sliceItem(it, r, fonts?.get(it.fontName) ?? fallbackMeasure);
      if (piece) line.push(piece);
    }
    const t = line.join('').trim();
    if (t) parts.push(t);
  }
  return cleanSelectedText(parts.join(' '));
}

function sliceItem(it: engine.PageTextItem, r: Rect, charWidth: Measure): string | null {
  const ir = it.rect;
  const t = it.transform;
  const angle = ((Math.round((Math.atan2(t[1], t[0]) * 180) / Math.PI / 90) * 90) % 360 + 360) % 360;
  const horizontal = angle === 0 || angle === 180;
  // Overlap across the line (must cover most of the smaller height) and along it.
  const across = horizontal
    ? Math.min(ir.y + ir.height, r.y + r.height) - Math.max(ir.y, r.y)
    : Math.min(ir.x + ir.width, r.x + r.width) - Math.max(ir.x, r.x);
  const acrossMin = horizontal ? Math.min(ir.height, r.height) : Math.min(ir.width, r.width);
  if (across <= 0 || across < acrossMin * 0.5) return null;
  const a0 = horizontal ? ir.x : ir.y;
  const len = horizontal ? ir.width : ir.height;
  const s0 = horizontal ? r.x : r.y;
  const s1 = horizontal ? r.x + r.width : r.y + r.height;
  if (len <= 0) return null;
  let f0 = (s0 - a0) / len;
  let f1 = (s1 - a0) / len;
  if (angle === 180 || angle === 270) [f0, f1] = [1 - f1, 1 - f0];
  f0 = Math.max(0, f0);
  f1 = Math.min(1, f1);
  if (f1 - f0 <= 0.01) return null;
  // A character is under the quad when its middle is.
  const chars = Array.from(it.str);
  const widths = chars.map(charWidth);
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  let out = '';
  chars.forEach((ch, i) => {
    const mid = (at + widths[i] / 2) / total;
    at += widths[i];
    if (mid >= f0 && mid <= f1) out += ch;
  });
  return out || null;
}

async function fill(docId: DocId, ids: string[]) {
  const doc = getDoc(docId);
  if (!doc) return;
  const byPage = new Map<number, string[]>();
  for (const id of ids) {
    const o = doc.objects[id];
    if (!o) continue;
    const pi = doc.pages.findIndex((p) => p.id === o.pageId);
    if (pi < 0) continue;
    byPage.set(pi, [...(byPage.get(pi) ?? []), id]);
  }
  for (const [pi, list] of byPage) {
    let items: engine.PageTextItem[] = [];
    try {
      items = (await engine.getPageText(docId, pi)).items;
    } catch {
      items = [];
    }
    const fonts = items.length ? await pageFonts(docId, pi) : undefined;
    const texts = new Map<string, string>();
    const cur = getDoc(docId);
    if (!cur) return;
    for (const id of list) {
      const o = cur.objects[id];
      const quads = o ? pending(o) : null;
      if (!o || !quads) continue;
      texts.set(id, textUnderQuads(items, quads, fonts));
    }
    if (!texts.size) continue;
    actions.updateDoc(docId, (d) => {
      const objects = { ...d.objects };
      for (const [id, text] of texts) {
        const o = objects[id];
        if (!o) continue;
        if (o.kind === 'text-markup') objects[id] = { ...o, data: { ...o.data, text, textPending: undefined } };
        else if (o.kind === 'caret' && o.data.strike) objects[id] = { ...o, data: { ...o.data, strike: { ...o.data.strike, text, textPending: undefined } } };
      }
      return { objects };
    });
  }
}

function scan() {
  const docs = useApp.getState().docs;
  for (const d of Object.values(docs)) {
    if (!d.pdf) continue;
    const ids: string[] = [];
    for (const id of d.order) {
      const o = d.objects[id];
      const key = `${d.id}:${id}:${d.pdfVersion}`;
      if (o && pending(o) && !inFlight.has(key)) {
        inFlight.add(key);
        ids.push(id);
      }
    }
    if (ids.length) void fill(d.id, ids);
  }
}

let installed = false;
export function installTextFill() {
  if (installed) return;
  installed = true;
  let t = 0;
  useApp.subscribe((s, prev) => {
    if (s.docs === prev.docs) return;
    if (t) return;
    t = window.setTimeout(() => {
      t = 0;
      scan();
    }, 300);
  });
}
