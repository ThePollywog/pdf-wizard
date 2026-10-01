/**
 * Content-stream interpreter: walks a page's content streams (and the Form XObjects they draw)
 * tracking the graphics / text state and records every glyph and every image draw with the exact
 * operation that produced it, so edits can later splice those operations.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject, type PDFPage } from '@cantoo/pdf-lib';
import { parseContent, num, nameOf, type Op, type Operand } from './parser';
import { loadFont, type FontInfo } from './fonts';
import { IDENTITY, apply, applyLinear, invert, mul, translate, quadBounds, type Matrix } from './matrix';
import { dictOf, nameOfObj, numOf, numsOf, resolve, streamBytes } from './pdfobj';

export interface Source {
  index: number;
  kind: 'page' | 'form';
  bytes: Uint8Array;
  ops: Op[];
  resources: PDFDict | undefined;
  /** The stream object (page content stream or form XObject). */
  stream: PDFStream | null;
  /** Its indirect reference (when it has one). */
  ref: PDFRef | null;
  /** Page sources: index in the page /Contents array (-1 when /Contents is a single stream). */
  contentIndex: number;
  /** Form sources: parent source, Do op index in the parent, and the resource name used. */
  parent?: number;
  parentOp?: number;
  xobjName?: string;
}

export interface Fill {
  space: 'gray' | 'rgb' | 'cmyk' | 'other';
  c: number[];
}

export interface Glyph {
  source: number;
  op: number;
  /** For TJ: index of the array element; otherwise 0. */
  arg: number;
  /** Byte range of the code inside the (decoded) string operand. */
  byteStart: number;
  byteLen: number;
  code: number;
  unicode: string;
  font: FontInfo;
  /** Resource name used by Tf and the resolved font entry (ref or dict). */
  fontName: string;
  fontObj: PDFObject | undefined;
  size: number;
  tc: number;
  tw: number;
  th: number;
  rise: number;
  render: number;
  /** Text matrix × CTM at the glyph origin (text space → user space, before size scaling). */
  textToUser: Matrix;
  /** Glyph box (descent..ascent × advance width) in user space: 4 points x0,y0,…,x3,y3. */
  quad: number[];
  origin: [number, number];
  /** User-space vector of the glyph's full advance (incl. Tc/Tw). */
  adv: [number, number];
  /** Glyph advance in text space (thousandths of an em; w0 × 1000). */
  w0: number;
  /** Word spacing applied (single-byte code 32). */
  spaceApplies: boolean;
  fill: Fill;
  seq: number;
}

export interface ImageDraw {
  source: number;
  op: number;
  name: string;
  xobj: PDFObject | undefined;
  /** Maps the unit square to user space. */
  ctm: Matrix;
  pxWidth: number;
  pxHeight: number;
  seq: number;
  /** `q (cm | re | W | W* | n)* /Name Do Q` group around the draw. */
  group?: { qOp: number; QOp: number; ctmAtQ: Matrix; clip?: [number, number, number, number] };
}

export interface PageContent {
  sources: Source[];
  glyphs: Glyph[];
  images: ImageDraw[];
  /** q-depth and CTM after the last page content stream. */
  endDepth: number;
  endCtm: Matrix;
  /** Page resources dict (may be inherited). */
  resources: PDFDict | undefined;
}

interface GState {
  ctm: Matrix;
  fill: Fill;
  fillCs: string;
  font: FontInfo | null;
  fontName: string;
  fontObj: PDFObject | undefined;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  render: number;
}

interface QFrame {
  qOp: number;
  source: number;
  ctmAtQ: Matrix;
  pure: boolean;
  clipRe: { rect: [number, number, number, number]; ctm: Matrix } | null;
  pendingRe: { rect: [number, number, number, number]; ctm: Matrix } | null;
  drew: boolean;
}

const BLACK: Fill = { space: 'gray', c: [0] };

function initialState(ctm: Matrix): GState {
  return { ctm, fill: BLACK, fillCs: 'DeviceGray', font: null, fontName: '', fontObj: undefined, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, render: 0 };
}

export function fillToHex(f: Fill): string {
  const cl = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  let r = 0, g = 0, b = 0;
  if (f.space === 'gray') r = g = b = cl(f.c[0] ?? 0);
  else if (f.space === 'rgb') [r, g, b] = [cl(f.c[0] ?? 0), cl(f.c[1] ?? 0), cl(f.c[2] ?? 0)];
  else if (f.space === 'cmyk') {
    const [c, m, y, k] = [0, 1, 2, 3].map((i) => cl(f.c[i] ?? 0));
    [r, g, b] = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  const h = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Page contents as a list of streams. */
export function pageStreams(ctx: PDFContext, page: PDFPage): { stream: PDFStream; ref: PDFRef | null; index: number }[] {
  const c = page.node.get(PDFName.of('Contents'));
  const v = resolve(ctx, c);
  if (v instanceof PDFStream) return [{ stream: v, ref: c instanceof PDFRef ? c : null, index: -1 }];
  if (v instanceof PDFArray) {
    const out: { stream: PDFStream; ref: PDFRef | null; index: number }[] = [];
    for (let i = 0; i < v.size(); i++) {
      const e = v.get(i);
      const s = resolve(ctx, e);
      if (s instanceof PDFStream) out.push({ stream: s, ref: e instanceof PDFRef ? e : null, index: i });
    }
    return out;
  }
  return [];
}

export function pageResources(page: PDFPage): PDFDict | undefined {
  try {
    return page.node.Resources();
  } catch {
    return undefined;
  }
}

function colorSpaceComps(ctx: PDFContext, resources: PDFDict | undefined, name: string): Fill['space'] {
  if (name === 'DeviceGray' || name === 'G' || name === 'CalGray') return 'gray';
  if (name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB') return 'rgb';
  if (name === 'DeviceCMYK' || name === 'CMYK') return 'cmyk';
  const csDict = dictOf(ctx, resources?.get(PDFName.of('ColorSpace')));
  const cs = resolve(ctx, csDict?.get(PDFName.of(name)));
  if (cs instanceof PDFName) return colorSpaceComps(ctx, undefined, cs.decodeText());
  if (cs instanceof PDFArray) {
    const kind = nameOfObj(ctx, cs.get(0));
    if (kind === 'ICCBased') {
      const s = resolve(ctx, cs.get(1));
      const n = s instanceof PDFStream ? numOf(ctx, s.dict.get(PDFName.of('N'))) : undefined;
      return n === 1 ? 'gray' : n === 4 ? 'cmyk' : 'rgb';
    }
    if (kind === 'CalRGB' || kind === 'Lab') return 'rgb';
    if (kind === 'CalGray') return 'gray';
  }
  return 'other';
}

/** Interprets the page content (all streams + nested forms). */
export function interpretPage(ctx: PDFContext, page: PDFPage): PageContent {
  const resources = pageResources(page);
  const sources: Source[] = [];
  const glyphs: Glyph[] = [];
  const images: ImageDraw[] = [];
  let seq = 0;
  let gs = initialState(IDENTITY);
  const stack: GState[] = [];
  let frames: QFrame[] = [];
  const formStack = new Set<PDFStream>();

  const run = (src: Source, depth: number) => {
    const ops = src.ops;
    const res = src.resources;
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;

    const setFont = (name: string, size: number) => {
      const fonts = dictOf(ctx, res?.get(PDFName.of('Font')));
      const entry = fonts?.get(PDFName.of(name));
      gs.font = loadFont(ctx, entry);
      gs.fontName = name;
      gs.fontObj = entry;
      gs.size = size;
    };

    const show = (str: Operand, opIndex: number, arg: number) => {
      if (str.t !== 'str') return;
      const font = gs.font ?? loadFont(ctx, undefined);
      const fs = gs.size;
      const th = gs.th;
      for (const c of font.codes(str.v)) {
        const w0 = font.width(c.code);
        const spaceApplies = font.bytesPerCode === 1 && c.code === 32;
        const textToUser = mul(tm, gs.ctm);
        const gm = mul([fs * th, 0, 0, fs, 0, gs.rise], textToUser);
        const w = w0 / 1000;
        const quad = [
          ...apply(gm, 0, font.descent / 1000), ...apply(gm, w, font.descent / 1000),
          ...apply(gm, w, font.ascent / 1000), ...apply(gm, 0, font.ascent / 1000),
        ];
        const tx = (w * fs + gs.tc + (spaceApplies ? gs.tw : 0)) * th;
        const origin = apply(gm, 0, 0);
        const adv = applyLinear(textToUser, tx, 0);
        glyphs.push({
          source: src.index, op: opIndex, arg, byteStart: c.start, byteLen: c.len, code: c.code,
          unicode: font.unicode(c.code), font, fontName: gs.fontName, fontObj: gs.fontObj, size: fs,
          tc: gs.tc, tw: gs.tw, th, rise: gs.rise, render: gs.render, textToUser, quad, origin,
          adv: [adv[0], adv[1]], w0, spaceApplies, fill: gs.fill, seq: seq++,
        });
        tm = mul(translate(tx, 0), tm);
      }
    };

    const markImpure = () => {
      const f = frames[frames.length - 1];
      if (f && f.source === src.index) f.pure = false;
    };

    for (let i = 0; i < ops.length; i++) {
      const { op, args } = ops[i];
      switch (op) {
        case 'q':
          stack.push({ ...gs });
          frames.push({ qOp: i, source: src.index, ctmAtQ: gs.ctm, pure: true, clipRe: null, pendingRe: null, drew: false });
          break;
        case 'Q': {
          const prev = stack.pop();
          if (prev) gs = prev;
          const f = frames.pop();
          if (f && f.source === src.index) {
            // close a pending image group
            const img = images[images.length - 1];
            if (img && img.source === src.index && img.group && img.group.qOp === f.qOp && img.group.QOp === -1) {
              if (img.op === i - 1) img.group.QOp = i;
              else img.group = undefined;
            }
          }
          break;
        }
        case 'cm':
          if (args.length >= 6) gs.ctm = mul(args.slice(0, 6).map((a) => num(a)) as Matrix, gs.ctm);
          break;
        case 're': {
          const f = frames[frames.length - 1];
          const rect: [number, number, number, number] = [num(args[0]), num(args[1]), num(args[2]), num(args[3])];
          if (f && f.source === src.index) f.pendingRe = { rect, ctm: gs.ctm };
          break;
        }
        case 'W':
        case 'W*': {
          const f = frames[frames.length - 1];
          if (f && f.source === src.index) {
            if (f.pendingRe && !f.clipRe) f.clipRe = f.pendingRe;
            else f.pure = false;
          }
          break;
        }
        case 'n': {
          const f = frames[frames.length - 1];
          if (f && f.source === src.index) f.pendingRe = null;
          break;
        }
        case 'g':
          markImpure();
          gs.fill = { space: 'gray', c: [num(args[0])] };
          gs.fillCs = 'DeviceGray';
          break;
        case 'rg':
          markImpure();
          gs.fill = { space: 'rgb', c: [num(args[0]), num(args[1]), num(args[2])] };
          gs.fillCs = 'DeviceRGB';
          break;
        case 'k':
          markImpure();
          gs.fill = { space: 'cmyk', c: [num(args[0]), num(args[1]), num(args[2]), num(args[3])] };
          gs.fillCs = 'DeviceCMYK';
          break;
        case 'cs': {
          markImpure();
          const n = nameOf(args[0]) ?? 'DeviceGray';
          gs.fillCs = n;
          const space = colorSpaceComps(ctx, res, n);
          gs.fill = { space, c: space === 'cmyk' ? [0, 0, 0, 1] : [0] };
          break;
        }
        case 'sc':
        case 'scn': {
          markImpure();
          const comps = args.filter((a) => a.t === 'num').map((a) => num(a));
          const space = colorSpaceComps(ctx, res, gs.fillCs);
          gs.fill = { space: space === 'other' ? 'other' : space, c: comps };
          break;
        }
        case 'BT':
          markImpure();
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case 'ET':
          break;
        case 'Tf':
          setFont(nameOf(args[0]) ?? '', num(args[1]));
          break;
        case 'Tc':
          gs.tc = num(args[0]);
          break;
        case 'Tw':
          gs.tw = num(args[0]);
          break;
        case 'Tz':
          gs.th = num(args[0], 100) / 100;
          break;
        case 'TL':
          gs.tl = num(args[0]);
          break;
        case 'Ts':
          gs.rise = num(args[0]);
          break;
        case 'Tr':
          gs.render = num(args[0]);
          break;
        case 'Td':
          tlm = mul(translate(num(args[0]), num(args[1])), tlm);
          tm = tlm;
          break;
        case 'TD':
          gs.tl = -num(args[1]);
          tlm = mul(translate(num(args[0]), num(args[1])), tlm);
          tm = tlm;
          break;
        case 'Tm':
          if (args.length >= 6) {
            tlm = args.slice(0, 6).map((a) => num(a)) as Matrix;
            tm = tlm;
          }
          break;
        case 'T*':
          tlm = mul(translate(0, -gs.tl), tlm);
          tm = tlm;
          break;
        case 'Tj':
          show(args[0], i, 0);
          break;
        case "'":
          tlm = mul(translate(0, -gs.tl), tlm);
          tm = tlm;
          show(args[0], i, 0);
          break;
        case '"':
          gs.tw = num(args[0]);
          gs.tc = num(args[1]);
          tlm = mul(translate(0, -gs.tl), tlm);
          tm = tlm;
          show(args[2], i, 0);
          break;
        case 'TJ': {
          const arr = args[0];
          if (arr?.t !== 'arr') break;
          arr.v.forEach((el, k) => {
            if (el.t === 'num') tm = mul(translate((-el.v / 1000) * gs.size * gs.th, 0), tm);
            else show(el, i, k);
          });
          break;
        }
        case 'Do': {
          const name = nameOf(args[0]);
          if (!name) break;
          const xdict = dictOf(ctx, res?.get(PDFName.of('XObject')));
          const entry = xdict?.get(PDFName.of(name));
          const xo = resolve(ctx, entry);
          if (!(xo instanceof PDFStream)) break;
          const st = nameOfObj(ctx, xo.dict.get(PDFName.of('Subtype')));
          const f = frames[frames.length - 1];
          if (st === 'Image') {
            const draw: ImageDraw = {
              source: src.index, op: i, name, xobj: entry, ctm: gs.ctm,
              pxWidth: numOf(ctx, xo.dict.get(PDFName.of('Width'))) ?? 1,
              pxHeight: numOf(ctx, xo.dict.get(PDFName.of('Height'))) ?? 1,
              seq: seq++,
            };
            if (f && f.source === src.index && f.pure && !f.drew) {
              let clip: [number, number, number, number] | undefined;
              if (f.clipRe) {
                const inv = invert(gs.ctm);
                if (inv) {
                  const [x, y, w, h] = f.clipRe.rect;
                  const m = mul(f.clipRe.ctm, inv);
                  const b = quadBounds([...apply(m, x, y), ...apply(m, x + w, y), ...apply(m, x + w, y + h), ...apply(m, x, y + h)]);
                  clip = [b.x, b.y, b.x + b.width, b.y + b.height];
                }
              }
              draw.group = { qOp: f.qOp, QOp: -1, ctmAtQ: f.ctmAtQ, clip };
            }
            if (f) f.drew = true;
            images.push(draw);
          } else if (st === 'Form' && depth < 8 && !formStack.has(xo)) {
            markImpure();
            const bytes = streamBytes(xo);
            if (!bytes) break;
            const fm = (numsOf(ctx, xo.dict.get(PDFName.of('Matrix'))) as Matrix | undefined) ?? IDENTITY;
            const formRes = dictOf(ctx, xo.dict.get(PDFName.of('Resources'))) ?? res;
            const child: Source = {
              index: sources.length, kind: 'form', bytes, ops: parseContent(bytes), resources: formRes,
              stream: xo, ref: entry instanceof PDFRef ? entry : null, contentIndex: -1,
              parent: src.index, parentOp: i, xobjName: name,
            };
            sources.push(child);
            const saved = { ...gs };
            const savedStack = stack.length;
            const savedFrames = frames;
            frames = [];
            gs = { ...gs, ctm: mul(fm, gs.ctm) };
            formStack.add(xo);
            run(child, depth + 1);
            formStack.delete(xo);
            stack.length = savedStack;
            frames = savedFrames;
            gs = saved;
          } else markImpure();
          break;
        }
        case 'BI':
        case 'sh':
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
        case 'gs': case 'd': case 'w': case 'J': case 'j': case 'M': case 'ri': case 'i':
        case 'G': case 'RG': case 'K': case 'CS': case 'SC': case 'SCN':
        case 'm': case 'l': case 'c': case 'v': case 'y': case 'h':
          markImpure();
          break;
        default:
          break;
      }
    }
  };

  for (const s of pageStreams(ctx, page)) {
    const bytes = streamBytes(s.stream) ?? new Uint8Array();
    const src: Source = {
      index: sources.length, kind: 'page', bytes, ops: parseContent(bytes), resources,
      stream: s.stream, ref: s.ref, contentIndex: s.index,
    };
    sources.push(src);
    run(src, 0);
    // frames don't span page streams for group detection purposes
    for (const f of frames) f.pure = false;
  }
  // unfinished groups (no Q) are not groups
  for (const img of images) if (img.group && img.group.QOp < 0) img.group = undefined;
  return { sources, glyphs, images, endDepth: stack.length, endCtm: gs.ctm, resources };
}

/** Unicode-aware check for whitespace glyphs. */
export const isSpaceText = (s: string) => s.length > 0 && /^\s+$/.test(s);
