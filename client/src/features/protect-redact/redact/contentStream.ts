/**
 * A small, lossless content-stream tokenizer/filter used by "Remove hidden information":
 *   - text drawn invisibly (text render mode 3 or 7) — except our own searchable layer of redacted
 *     pages (marked content /AcroWebText) — is removed;
 *   - marked content belonging to optional content groups that are off (hidden layers) is removed,
 *     and so are XObjects drawn with a hidden /OC.
 * Everything not removed is copied byte for byte.
 */

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export type TokType = 'num' | 'name' | 'str' | 'hex' | 'array' | 'dict' | 'kw';

export interface Tok {
  type: TokType;
  /** Raw source text. */
  raw: string;
  start: number;
  end: number;
}

export interface Op {
  op: string;
  operands: Tok[];
  /** Range of operands + operator in the source. */
  start: number;
  end: number;
}

/** Bytes → one char per byte (lossless, unlike TextDecoder('latin1') which is windows-1252). */
export function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  return s;
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

class Lexer {
  pos = 0;
  constructor(readonly s: string) {}

  private code(i: number) {
    return i < this.s.length ? this.s.charCodeAt(i) : -1;
  }

  skipSpace() {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < s.length && s.charCodeAt(this.pos) !== 0x0a && s.charCodeAt(this.pos) !== 0x0d) this.pos++;
      } else break;
    }
  }

  /** Next token (composite arrays/dicts are returned as one token), or null at the end. */
  next(): Tok | null {
    this.skipSpace();
    const s = this.s;
    if (this.pos >= s.length) return null;
    const start = this.pos;
    const c = s.charCodeAt(start);
    if (c === 0x28) {
      // literal string
      let depth = 0;
      let i = start;
      for (; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        if (ch === 0x5c) {
          i++;
          continue;
        }
        if (ch === 0x28) depth++;
        else if (ch === 0x29) {
          depth--;
          if (depth === 0) break;
        }
      }
      this.pos = Math.min(s.length, i + 1);
      return { type: 'str', raw: s.slice(start, this.pos), start, end: this.pos };
    }
    if (c === 0x3c && this.code(start + 1) !== 0x3c) {
      const i = s.indexOf('>', start + 1);
      this.pos = i < 0 ? s.length : i + 1;
      return { type: 'hex', raw: s.slice(start, this.pos), start, end: this.pos };
    }
    if (c === 0x3c || c === 0x5b) {
      // << dict >> or [ array ]
      const isDict = c === 0x3c;
      this.pos += isDict ? 2 : 1;
      for (;;) {
        this.skipSpace();
        if (this.pos >= s.length) break;
        const d = s.charCodeAt(this.pos);
        if (isDict && d === 0x3e && this.code(this.pos + 1) === 0x3e) {
          this.pos += 2;
          break;
        }
        if (!isDict && d === 0x5d) {
          this.pos += 1;
          break;
        }
        const t = this.next();
        if (!t) break;
      }
      return { type: isDict ? 'dict' : 'array', raw: s.slice(start, this.pos), start, end: this.pos };
    }
    if (c === 0x3e || c === 0x5d || c === 0x29 || c === 0x7b || c === 0x7d) {
      // stray delimiter: skip it
      this.pos++;
      return { type: 'kw', raw: s[start], start, end: this.pos };
    }
    if (c === 0x2f) {
      let i = start + 1;
      while (i < s.length && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
      this.pos = i;
      return { type: 'name', raw: s.slice(start, i), start, end: i };
    }
    let i = start;
    while (i < s.length && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
    if (i === start) i++;
    this.pos = i;
    const raw = s.slice(start, i);
    return { type: /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw) ? 'num' : 'kw', raw, start, end: i };
  }

  /** After the ID operator of an inline image: skip the binary data up to and including EI. */
  skipInlineImage(): number {
    const s = this.s;
    let i = this.pos + 1; // single whitespace after ID
    for (; i < s.length - 1; i++) {
      if (s[i] === 'E' && s[i + 1] === 'I' && (i === 0 || WS.has(s.charCodeAt(i - 1))) && (i + 2 >= s.length || WS.has(s.charCodeAt(i + 2)) || DELIM.has(s.charCodeAt(i + 2)))) {
        this.pos = i + 2;
        return this.pos;
      }
    }
    this.pos = s.length;
    return this.pos;
  }
}

/** Parse a content stream into operations (inline images become one 'BI' op). */
export function parseOps(src: string): Op[] {
  const lx = new Lexer(src);
  const ops: Op[] = [];
  let operands: Tok[] = [];
  for (;;) {
    const t = lx.next();
    if (!t) break;
    if (t.type !== 'kw' || t.raw === 'true' || t.raw === 'false' || t.raw === 'null') {
      operands.push(t);
      continue;
    }
    const start = operands.length ? operands[0].start : t.start;
    if (t.raw === 'BI') {
      // key/value pairs up to ID, then binary data up to EI
      for (;;) {
        const k = lx.next();
        if (!k || (k.type === 'kw' && k.raw === 'ID')) break;
      }
      const end = lx.skipInlineImage();
      ops.push({ op: 'BI', operands: [], start, end });
      operands = [];
      continue;
    }
    ops.push({ op: t.raw, operands, start, end: t.end });
    operands = [];
  }
  return ops;
}

export interface FilterOptions {
  hiddenText: boolean;
  /** Marked-content property names (in this stream's /Properties) whose content is hidden. */
  hiddenProperties?: Set<string>;
  /** XObject names drawn with a hidden /OC. */
  hiddenXObjects?: Set<string>;
  /** Marked-content tag whose invisible text is kept. */
  keepTag?: string;
}

export interface FilterResult {
  /** New content, or null when nothing changed. */
  content: string | null;
  hiddenText: number;
  hiddenLayers: number;
}

const SHOW = new Set(['Tj', 'TJ', "'", '"']);

/** Remove hidden text / hidden-layer content from a content stream. */
export function filterContent(src: string, opts: FilterOptions): FilterResult {
  const ops = parseOps(src);
  const remove = new Map<number, string>(); // op index → replacement ('' = drop)
  let hiddenLayers = 0;
  let hiddenText = 0;

  // 1) hidden optional content: BDC with a hidden /OC property → drop through the matching EMC
  if (opts.hiddenProperties?.size || opts.hiddenXObjects?.size) {
    const stack: { i: number; hidden: boolean }[] = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.op === 'BMC' || o.op === 'BDC') {
        const tag = o.operands[0]?.raw;
        const prop = o.operands[1];
        const hidden = o.op === 'BDC' && tag === '/OC' && prop?.type === 'name' && !!opts.hiddenProperties?.has(prop.raw.slice(1));
        stack.push({ i, hidden });
      } else if (o.op === 'EMC') {
        const open = stack.pop();
        if (open?.hidden && !stack.some((x) => x.hidden)) {
          // Only drop balanced regions (q/Q and BT/ET must pair up inside).
          let q = 0;
          let bt = 0;
          let ok = true;
          for (let k = open.i + 1; k < i; k++) {
            const op = ops[k].op;
            if (op === 'q') q++;
            else if (op === 'Q') q--;
            else if (op === 'BT') bt++;
            else if (op === 'ET') bt--;
            if (q < 0 || bt < 0) ok = false;
          }
          if (ok && q === 0 && bt === 0) {
            for (let k = open.i; k <= i; k++) remove.set(k, '');
            hiddenLayers++;
          }
        }
      } else if (o.op === 'Do' && o.operands[0]?.type === 'name' && opts.hiddenXObjects?.has(o.operands[0].raw.slice(1))) {
        if (!remove.has(i)) {
          remove.set(i, '');
          hiddenLayers++;
        }
      }
    }
  }

  // 2) invisible text
  if (opts.hiddenText) {
    let tr = 0;
    const gs: number[] = [];
    const tags: string[] = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      switch (o.op) {
        case 'q':
          gs.push(tr);
          break;
        case 'Q':
          tr = gs.length ? gs.pop()! : 0;
          break;
        case 'Tr': {
          const v = Number(o.operands[0]?.raw);
          if (Number.isFinite(v)) tr = v;
          break;
        }
        case 'BMC':
        case 'BDC':
          tags.push(o.operands[0]?.raw ?? '');
          break;
        case 'EMC':
          tags.pop();
          break;
        default:
          if (SHOW.has(o.op) && (tr === 3 || tr === 7) && !remove.has(i)) {
            if (opts.keepTag && tags.includes(`/${opts.keepTag}`)) break;
            hiddenText++;
            if (o.op === "'") remove.set(i, 'T*');
            else if (o.op === '"') {
              const [aw, ac] = o.operands;
              remove.set(i, `${aw?.raw ?? '0'} Tw ${ac?.raw ?? '0'} Tc T*`);
            } else remove.set(i, '');
          }
      }
    }
  }

  if (!remove.size) return { content: null, hiddenText, hiddenLayers };
  let out = '';
  let last = 0;
  for (let i = 0; i < ops.length; i++) {
    const rep = remove.get(i);
    if (rep === undefined) continue;
    out += src.slice(last, ops[i].start);
    if (rep) out += `${rep}\n`;
    last = ops[i].end;
  }
  out += src.slice(last);
  return { content: out, hiddenText, hiddenLayers };
}

// ── content outside the visible page area ("cropped content") ────────────────

export type Matrix = [number, number, number, number, number, number];
export type Box = [number, number, number, number];

export interface OutsideEnv {
  /**
   * How text of the font resource `name` advances: writing mode and an upper bound of the advance
   * of one character code, in em. null when unknown (Type 3, missing...): such text is never removed.
   */
  font(name: string): { vertical: boolean; advance: number } | null;
  /** Bounding box and matrix of the XObject resource `name` (images: the unit square); null: never removed. */
  xobject(name: string): { bbox: Box; matrix: Matrix } | null;
  /** Graphics state parameters of the ExtGState resource `name` this filter cares about. */
  extGState(name: string): { lineWidth?: number; miterLimit?: number; font?: boolean } | null;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** a × b (a applied first). */
function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function boxOf(m: Matrix, b: Box): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  return [x0, y0, x1, y1];
}

/** True when `b` lies entirely outside `area` (by more than `eps`). Anything not finite counts as inside. */
function isOutside(b: Box, area: Box, eps = 0.5): boolean {
  if (!b.every(Number.isFinite)) return false;
  return b[2] < area[0] - eps || b[0] > area[2] + eps || b[3] < area[1] - eps || b[1] > area[3] + eps;
}

/** Number of bytes (= character codes of 1 byte, an upper bound for multi-byte fonts) in a string token. */
function stringBytes(t: Tok): number {
  if (t.type === 'hex') return Math.ceil(t.raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '').length / 2);
  if (t.type !== 'str') return 0;
  const s = t.raw;
  const end = s.endsWith(')') ? s.length - 1 : s.length;
  let n = 0;
  for (let i = 1; i < end; i++) {
    if (s[i] !== '\\') {
      n++;
      continue;
    }
    const d = s[i + 1];
    if (d === '\r') {
      i += s[i + 2] === '\n' ? 2 : 1; // line continuation
    } else if (d === '\n') {
      i++;
    } else if (d !== undefined && d >= '0' && d <= '7') {
      let k = 1;
      while (k < 3 && s[i + 1 + k] >= '0' && s[i + 1 + k] <= '7') k++;
      i += k;
      n++;
    } else {
      i++;
      n++;
    }
  }
  return n;
}

const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const STROKES = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const TEXT_POSITION = new Set(['Td', 'TD', 'Tm', 'T*', "'", '"', 'ET', 'BT']);

interface OutsideState {
  ctm: Matrix;
  font: string | null;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  scale: number;
  leading: number;
  rise: number;
  lineWidth: number;
  miterLimit: number;
}

/**
 * Remove what a page draws entirely outside `area` (its visible box, in the coordinates of the
 * content): text runs, paths, images and form XObjects. The bounds used are conservative (text:
 * at least 1.5 em per character code) and anything uncertain — unknown fonts, text whose position depends on
 * the width of earlier text, clipping paths, content of form XObjects — is kept.
 */
export function dropOutside(src: string, area: Box, env: OutsideEnv): { content: string | null; removed: number } {
  const ops = parseOps(src);
  const remove = new Map<number, string>();
  let g: OutsideState = { ctm: IDENTITY, font: null, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0, lineWidth: 1, miterLimit: 10 };
  const stack: OutsideState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let inText = false;
  let posKnown = false;
  /** Set when the state can't be followed any more (malformed operands): nothing more is removed. */
  let lost = false;
  let path: { start: number; box: Box | null; clip: boolean; ok: boolean } | null = null;

  const num = (o: Op, k: number) => {
    const t = o.operands[k];
    const v = t?.type === 'num' ? Number(t.raw) : NaN;
    if (!Number.isFinite(v)) lost = true;
    return Number.isFinite(v) ? v : 0;
  };
  const matrixOf = (o: Op): Matrix | null => {
    if (o.operands.length < 6) {
      lost = true;
      return null;
    }
    const m = [0, 1, 2, 3, 4, 5].map((k) => num(o, k)) as Matrix;
    return lost ? null : m;
  };
  const moveLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    posKnown = true;
  };
  /** The next text-showing operator after `i` starts at a position set explicitly (not after `i`'s text). */
  const repositionedAfter = (i: number) => {
    for (let k = i + 1; k < ops.length; k++) {
      const op = ops[k].op;
      if (op === 'Tj' || op === 'TJ') return false;
      if (TEXT_POSITION.has(op)) return true;
    }
    return true;
  };
  const showText = (i: number, items: Tok[], replacement: string) => {
    const can = !lost && inText && posKnown && g.font !== null && repositionedAfter(i);
    posKnown = false; // the text advances by widths we don't know exactly
    if (!can) return;
    const font = env.font(g.font!);
    if (!font) return;
    const size = Math.abs(g.size);
    const th = Math.abs(g.scale);
    // Vertical text doesn't use the horizontal scaling; a factor of at least 1 keeps the (square)
    // bounds a superset of the horizontal ones as well, for fonts we're not sure about.
    const f = font.vertical ? Math.max(th, 1) : g.scale;
    const perCode = (Math.max(1.5, font.advance) * size + Math.abs(g.charSpacing) + Math.abs(g.wordSpacing)) * Math.abs(f);
    let lo = 0;
    let hi = 0;
    let min = 0;
    let max = 0;
    for (const t of items) {
      if (t.type === 'num') {
        const shift = (-Number(t.raw) / 1000) * g.size * f;
        if (!Number.isFinite(shift)) return;
        lo += shift;
        hi += shift;
      } else {
        const n = stringBytes(t);
        lo -= n * perCode;
        hi += n * perCode;
      }
      min = Math.min(min, lo);
      max = Math.max(max, hi);
    }
    const pad = 2 * size * Math.max(th, 1);
    let rect: Box;
    if (font.vertical) {
      const ext = Math.max(-min, max) + pad;
      rect = [-ext, g.rise - ext, ext, g.rise + ext];
    } else {
      rect = [min - pad, g.rise - 2 * size, max + pad, g.rise + 2 * size];
    }
    if (isOutside(boxOf(mul(tm, g.ctm), rect), area)) remove.set(i, replacement);
  };
  const addPoints = (pts: number[]) => {
    if (!path) return;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const [x, y] = [pts[k], pts[k + 1]];
      const px = g.ctm[0] * x + g.ctm[2] * y + g.ctm[4];
      const py = g.ctm[1] * x + g.ctm[3] * y + g.ctm[5];
      const b = path.box;
      path.box = b ? [Math.min(b[0], px), Math.min(b[1], py), Math.max(b[2], px), Math.max(b[3], py)] : [px, py, px, py];
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const op = o.op;
    if (path && !PATH_BUILD.has(op) && !PATH_PAINT.has(op) && op !== 'W' && op !== 'W*') path.ok = false;
    if (PATH_BUILD.has(op)) {
      if (!path) path = { start: i, box: null, clip: false, ok: !lost };
      const n = o.operands.map((_, k) => num(o, k));
      if (lost) path.ok = false;
      if (op === 're' && n.length >= 4) addPoints([n[0], n[1], n[0] + n[2], n[1], n[0], n[1] + n[3], n[0] + n[2], n[1] + n[3]]);
      else if (op !== 'h') addPoints(n);
      continue;
    }
    if (op === 'W' || op === 'W*') {
      if (path) path.clip = true;
      continue;
    }
    if (PATH_PAINT.has(op)) {
      if (path && path.ok && !path.clip && path.box && op !== 'n' && !lost) {
        const s = Math.max(Math.hypot(g.ctm[0], g.ctm[1]), Math.hypot(g.ctm[2], g.ctm[3]));
        const pad = STROKES.has(op) ? (Math.max(g.miterLimit, 2) / 2) * Math.max(g.lineWidth, 1) * s + 1 : 0.5;
        const b = path.box;
        if (isOutside([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], area)) for (let k = path.start; k <= i; k++) remove.set(k, '');
      }
      path = null;
      continue;
    }
    switch (op) {
      case 'q':
        stack.push({ ...g });
        break;
      case 'Q':
        if (stack.length) g = stack.pop()!;
        break;
      case 'cm': {
        const m = matrixOf(o);
        if (m) g.ctm = mul(m, g.ctm);
        break;
      }
      case 'w':
        g.lineWidth = Math.abs(num(o, 0));
        break;
      case 'M':
        g.miterLimit = Math.abs(num(o, 0));
        break;
      case 'gs': {
        const p = o.operands[0]?.type === 'name' ? env.extGState(o.operands[0].raw.slice(1)) : null;
        if (p?.lineWidth !== undefined) g.lineWidth = Math.abs(p.lineWidth);
        if (p?.miterLimit !== undefined) g.miterLimit = Math.abs(p.miterLimit);
        if (p?.font) g.font = null; // a font we don't follow
        break;
      }
      case 'BT':
        inText = true;
        tm = tlm = IDENTITY;
        posKnown = true;
        break;
      case 'ET':
        inText = false;
        break;
      case 'Tf':
        g.font = o.operands[0]?.type === 'name' ? o.operands[0].raw.slice(1) : null;
        g.size = num(o, 1);
        break;
      case 'Tc':
        g.charSpacing = num(o, 0);
        break;
      case 'Tw':
        g.wordSpacing = num(o, 0);
        break;
      case 'Tz':
        g.scale = num(o, 0) / 100;
        break;
      case 'TL':
        g.leading = num(o, 0);
        break;
      case 'Ts':
        g.rise = num(o, 0);
        break;
      case 'Td':
        moveLine(num(o, 0), num(o, 1));
        break;
      case 'TD': {
        const [tx, ty] = [num(o, 0), num(o, 1)];
        g.leading = -ty;
        moveLine(tx, ty);
        break;
      }
      case 'Tm': {
        const m = matrixOf(o);
        if (m) {
          tm = tlm = m;
          posKnown = true;
        }
        break;
      }
      case 'T*':
        moveLine(0, -g.leading);
        break;
      case 'Tj':
        showText(i, o.operands.slice(0, 1), '');
        break;
      case 'TJ': {
        const arr = o.operands[0];
        if (arr?.type !== 'array') {
          posKnown = false;
          break;
        }
        const lx = new Lexer(arr.raw.slice(1, arr.raw.endsWith(']') ? -1 : undefined));
        const items: Tok[] = [];
        for (let t = lx.next(); t; t = lx.next()) items.push(t);
        showText(i, items, '');
        break;
      }
      case "'":
        moveLine(0, -g.leading);
        showText(i, o.operands.slice(0, 1), 'T*');
        break;
      case '"': {
        const [aw, ac] = o.operands;
        g.wordSpacing = num(o, 0);
        g.charSpacing = num(o, 1);
        moveLine(0, -g.leading);
        showText(i, o.operands.slice(2, 3), `${aw?.raw ?? '0'} Tw ${ac?.raw ?? '0'} Tc T*`);
        break;
      }
      case 'Do': {
        const name = o.operands[0]?.type === 'name' ? o.operands[0].raw.slice(1) : null;
        const x = name !== null && !lost ? env.xobject(name) : null;
        if (x && isOutside(boxOf(mul(x.matrix, g.ctm), x.bbox), area)) remove.set(i, '');
        break;
      }
      case 'BI':
        if (!lost && isOutside(boxOf(g.ctm, [0, 0, 1, 1]), area)) remove.set(i, '');
        break;
      default:
        break;
    }
  }

  if (!remove.size) return { content: null, removed: 0 };
  let out = '';
  let last = 0;
  let removed = 0;
  for (let i = 0; i < ops.length; i++) {
    const rep = remove.get(i);
    if (rep === undefined) continue;
    out += src.slice(last, ops[i].start);
    if (rep) out += `${rep}\n`;
    last = ops[i].end;
    if (!PATH_BUILD.has(ops[i].op)) removed++;
  }
  out += src.slice(last);
  return { content: out, removed };
}
