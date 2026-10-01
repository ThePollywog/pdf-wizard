/**
 * Byte-level rewrites of content-stream operations: removing glyphs from text-showing operators
 * (keeping the text position of everything that follows) and rewriting image placements.
 */
import type { Op, Operand } from './parser';
import { hexString, nameToken } from './parser';
import type { Glyph, ImageDraw, PageContent } from './interpreter';
import { fmt, fmtMatrix, invert, mul, type Matrix } from './matrix';

export interface Splice {
  source: number;
  start: number;
  end: number;
  text: string;
}

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);
const POSITION_OPS = new Set(["'", '"', 'Td', 'TD', 'Tm', 'T*', 'ET', 'BT', 'Q']);

/** True when the text position after op `i` is never used (the next text op repositions). */
function positionDiscarded(ops: Op[], i: number): boolean {
  for (let k = i + 1; k < ops.length; k++) {
    const o = ops[k].op;
    if (o === 'Tj' || o === 'TJ') return false;
    if (POSITION_OPS.has(o)) return true;
  }
  return true;
}

/** TJ adjustment (thousandths) that reproduces a glyph's advance. */
function advanceNumber(g: Glyph): number {
  const extra = g.tc + (g.spaceApplies ? g.tw : 0);
  return -(g.w0 + (g.size ? (extra * 1000) / g.size : 0));
}

/** Index of glyphs by `${source}:${op}`. */
export function glyphsByOp(content: PageContent): Map<string, Glyph[]> {
  const m = new Map<string, Glyph[]>();
  for (const g of content.glyphs) {
    const k = `${g.source}:${g.op}`;
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(g);
  }
  return m;
}

/** Splices removing `remove` glyphs from their operators. */
export function removalSplices(content: PageContent, remove: Iterable<Glyph>): Splice[] {
  const byOp = glyphsByOp(content);
  const removed = new Set(remove);
  const touched = new Set<string>();
  for (const g of removed) touched.add(`${g.source}:${g.op}`);
  const out: Splice[] = [];
  for (const key of touched) {
    const [si, oi] = key.split(':').map(Number);
    const src = content.sources[si];
    const op = src.ops[oi];
    if (!SHOW_OPS.has(op.op)) continue;
    const text = rebuildShowOp(op, byOp.get(key) ?? [], removed, positionDiscarded(src.ops, oi));
    out.push({ source: si, start: op.start, end: op.end, text: text ? `\n${text}\n` : '\n' });
  }
  return out;
}

function rebuildShowOp(op: Op, glyphs: Glyph[], removed: Set<Glyph>, discard: boolean): string {
  let prefix = '';
  let elements: Operand[] = [];
  if (op.op === 'TJ') elements = op.args[0]?.t === 'arr' ? op.args[0].v : [];
  else if (op.op === '"') {
    prefix = `${fmt(numArg(op.args[0]))} Tw ${fmt(numArg(op.args[1]))} Tc T*`;
    elements = op.args[2] ? [op.args[2]] : [];
  } else {
    if (op.op === "'") prefix = 'T*';
    elements = op.args[0] ? [op.args[0]] : [];
  }
  const byArg = new Map<number, Glyph[]>();
  for (const g of glyphs) {
    let a = byArg.get(g.arg);
    if (!a) byArg.set(g.arg, (a = []));
    a.push(g);
  }
  const parts: string[] = [];
  let anyKept = false;
  let num = 0;
  let kept: number[] = [];
  const flushKept = () => {
    if (kept.length) parts.push(hexString(kept));
    kept = [];
  };
  const flushNum = () => {
    if (Math.abs(num) > 1e-6) parts.push(fmt(num));
    num = 0;
  };
  elements.forEach((el, k) => {
    if (el.t === 'num') {
      flushKept();
      num += el.v;
      return;
    }
    if (el.t !== 'str') return;
    const gl = (byArg.get(op.op === 'TJ' ? k : 0) ?? []).slice().sort((a, b) => a.byteStart - b.byteStart);
    const b = el.v;
    let pos = 0;
    for (const g of gl) {
      if (g.byteStart > pos) {
        flushNum();
        for (let i = pos; i < g.byteStart; i++) kept.push(b[i]);
      }
      if (removed.has(g)) {
        flushKept();
        num += advanceNumber(g);
      } else {
        flushNum();
        for (let i = g.byteStart; i < g.byteStart + g.byteLen; i++) kept.push(b[i]);
        anyKept = true;
      }
      pos = g.byteStart + g.byteLen;
    }
    if (pos < b.length) {
      flushNum();
      for (let i = pos; i < b.length; i++) kept.push(b[i]);
    }
  });
  flushKept();
  if (!anyKept && discard) return prefix;
  flushNum();
  if (!parts.length) return prefix;
  return `${prefix ? prefix + ' ' : ''}[${parts.join(' ')}] TJ`;
}

const numArg = (o: Operand | undefined) => (o && o.t === 'num' ? o.v : 0);

export interface ImagePlacement {
  /** Unit square → user space (null = delete the image). */
  matrix: Matrix | null;
  /** Clip in unit-square coordinates [u0, v0, u1, v1]; undefined keeps none. */
  clip?: [number, number, number, number];
  /** XObject resource name (defaults to the current one). */
  name?: string;
}

/** Splice rewriting one image draw. */
export function imageSplice(content: PageContent, img: ImageDraw, p: ImagePlacement): Splice | null {
  const src = content.sources[img.source];
  const name = p.name ?? img.name;
  if (img.group) {
    const q = src.ops[img.group.qOp];
    const Q = src.ops[img.group.QOp];
    if (!q || !Q) return null;
    if (!p.matrix) return { source: img.source, start: q.start, end: Q.end, text: '\n' };
    const inv = invert(img.group.ctmAtQ);
    if (!inv) return null;
    return { source: img.source, start: q.start, end: Q.end, text: `\n${placementOps(mul(p.matrix, inv), p.clip, name)}\n` };
  }
  const d = src.ops[img.op];
  if (!d) return null;
  if (!p.matrix) return { source: img.source, start: d.start, end: d.end, text: '\n' };
  const inv = invert(img.ctm);
  if (!inv) return null;
  return { source: img.source, start: d.start, end: d.end, text: `\n${placementOps(mul(p.matrix, inv), p.clip, name)}\n` };
}

function placementOps(rel: Matrix, clip: [number, number, number, number] | undefined, name: string): string {
  const c = clip && !(clip[0] <= 0 && clip[1] <= 0 && clip[2] >= 1 && clip[3] >= 1)
    ? `${fmt(clip[0])} ${fmt(clip[1])} ${fmt(clip[2] - clip[0])} ${fmt(clip[3] - clip[1])} re W n `
    : '';
  return `q ${fmtMatrix(rel)} cm ${c}${nameToken(name)} Do Q`;
}
