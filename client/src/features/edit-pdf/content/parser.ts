/**
 * Content-stream lexer + parser with byte offsets. Every operation keeps the byte range it
 * occupies in the (decoded) stream so edits can splice single operators while leaving every other
 * byte identical. Inline images (BI … ID … EI) are kept as one opaque operation.
 */

export type Operand =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'name'; v: string; s: number; e: number }
  | { t: 'str'; v: Uint8Array; hex: boolean; s: number; e: number }
  | { t: 'arr'; v: Operand[]; s: number; e: number }
  | { t: 'dict'; v: Map<string, Operand>; s: number; e: number }
  | { t: 'bool'; v: boolean; s: number; e: number }
  | { t: 'null'; s: number; e: number };

export interface Op {
  op: string;
  args: Operand[];
  /** Byte offset of the first operand (or of the operator when there are none). */
  start: number;
  /** Byte offset just past the operator keyword. */
  end: number;
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const isWs = (c: number) => WS[c] === 1;
const isRegular = (c: number) => WS[c] !== 1 && DELIM[c] !== 1;

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

class Lexer {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  skipWs(): void {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS[c]) this.pos++;
      else if (c === 37 /* % */) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** Next token: an operand, a structural marker or an operator keyword. */
  next(): Operand | { t: 'kw'; v: string; s: number; e: number } | { t: 'mark'; v: string; s: number; e: number } | null {
    this.skipWs();
    const b = this.b;
    if (this.pos >= b.length) return null;
    const s = this.pos;
    const c = b[s];
    if (c === 47 /* / */) {
      this.pos++;
      let name = '';
      while (this.pos < b.length && isRegular(b[this.pos])) {
        const ch = b[this.pos];
        if (ch === 35 /* # */ && this.pos + 2 < b.length && hexVal(b[this.pos + 1]) >= 0 && hexVal(b[this.pos + 2]) >= 0) {
          name += String.fromCharCode(hexVal(b[this.pos + 1]) * 16 + hexVal(b[this.pos + 2]));
          this.pos += 3;
        } else {
          name += String.fromCharCode(ch);
          this.pos++;
        }
      }
      return { t: 'name', v: name, s, e: this.pos };
    }
    if (c === 40 /* ( */) return this.literal();
    if (c === 60 /* < */) {
      if (b[s + 1] === 60) {
        this.pos += 2;
        return { t: 'mark', v: '<<', s, e: this.pos };
      }
      return this.hex();
    }
    if (c === 62 /* > */) {
      this.pos += b[s + 1] === 62 ? 2 : 1;
      return { t: 'mark', v: '>>', s, e: this.pos };
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) {
      this.pos++;
      return { t: 'mark', v: String.fromCharCode(c), s, e: this.pos };
    }
    if (c === 41) {
      // stray ')': skip
      this.pos++;
      return this.next();
    }
    // number or keyword
    let e = s;
    while (e < b.length && isRegular(b[e])) e++;
    if (e === s) {
      this.pos++;
      return this.next();
    }
    this.pos = e;
    let str = '';
    for (let i = s; i < e; i++) str += String.fromCharCode(b[i]);
    if (/^[+-]{0,2}(\d+\.?\d*|\.\d+)$/.test(str)) {
      const v = parseFloat(str.replace(/^[+-](?=[+-])/, ''));
      return { t: 'num', v: Number.isFinite(v) ? v : 0, s, e };
    }
    if (str === 'true' || str === 'false') return { t: 'bool', v: str === 'true', s, e };
    if (str === 'null') return { t: 'null', s, e };
    return { t: 'kw', v: str, s, e };
  }

  private literal(): Operand {
    const b = this.b;
    const s = this.pos;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 92 /* \ */) {
        if (this.pos >= b.length) break;
        const n = b[this.pos++];
        switch (n) {
          case 110: out.push(10); break; // n
          case 114: out.push(13); break; // r
          case 116: out.push(9); break; // t
          case 98: out.push(8); break; // b
          case 102: out.push(12); break; // f
          case 13: if (b[this.pos] === 10) this.pos++; break; // line continuation
          case 10: break;
          default:
            if (n >= 48 && n <= 55) {
              let v = n - 48;
              for (let k = 0; k < 2 && this.pos < b.length && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + (b[this.pos++] - 48);
              out.push(v & 0xff);
            } else out.push(n);
        }
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { t: 'str', v: Uint8Array.from(out), hex: false, s, e: this.pos };
  }

  private hex(): Operand {
    const b = this.b;
    const s = this.pos;
    this.pos++;
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 62) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return { t: 'str', v: Uint8Array.from(out), hex: true, s, e: this.pos };
  }
}

/** Parses a decoded content stream into operations (tolerant: malformed input never throws). */
export function parseContent(bytes: Uint8Array): Op[] {
  const lx = new Lexer(bytes);
  const ops: Op[] = [];
  const stack: Operand[] = [];
  // containers under construction: arrays and dicts
  const containers: { kind: '[' | '<<'; items: Operand[]; s: number }[] = [];
  let opStart = -1;

  const push = (o: Operand) => {
    if (containers.length) containers[containers.length - 1].items.push(o);
    else {
      if (!stack.length) opStart = o.s;
      stack.push(o);
    }
  };

  for (;;) {
    const tok = lx.next();
    if (!tok) break;
    if (tok.t === 'mark') {
      if (tok.v === '[' || tok.v === '<<') {
        if (!containers.length && !stack.length) opStart = tok.s;
        containers.push({ kind: tok.v, items: [], s: tok.s });
      } else if (tok.v === ']' || tok.v === '>>') {
        const c = containers.pop();
        if (!c) continue;
        if (c.kind === '[') push({ t: 'arr', v: c.items, s: c.s, e: tok.e });
        else {
          const m = new Map<string, Operand>();
          for (let i = 0; i + 1 < c.items.length; i += 2) {
            const k = c.items[i];
            if (k.t === 'name') m.set(k.v, c.items[i + 1]);
          }
          push({ t: 'dict', v: m, s: c.s, e: tok.e });
        }
      }
      continue;
    }
    if (tok.t !== 'kw') {
      push(tok);
      continue;
    }
    if (containers.length) {
      // keyword inside an array (malformed) → treat as a name-like token and continue
      containers[containers.length - 1].items.push({ t: 'null', s: tok.s, e: tok.e });
      continue;
    }
    if (tok.v === 'BI') {
      const start = stack.length ? opStart : tok.s;
      stack.length = 0;
      const end = skipInlineImage(bytes, lx);
      ops.push({ op: 'BI', args: [], start, end });
      continue;
    }
    const start = stack.length && opStart >= 0 ? opStart : tok.s;
    ops.push({ op: tok.v, args: stack.splice(0), start, end: tok.e });
    opStart = -1;
  }
  return ops;
}

/** Advances the lexer past `… ID <data> EI`; returns the end offset of EI. */
function skipInlineImage(b: Uint8Array, lx: Lexer): number {
  // dictionary entries until ID
  for (;;) {
    const tok = lx.next();
    if (!tok) return b.length;
    if (tok.t === 'kw' && tok.v === 'ID') break;
  }
  let p = lx.pos + 1; // single whitespace after ID
  while (p + 1 < b.length) {
    if (b[p] === 69 && b[p + 1] === 73 && (p === 0 || isWs(b[p - 1])) && (p + 2 >= b.length || isWs(b[p + 2]) || DELIM[b[p + 2]])) {
      lx.pos = p + 2;
      return p + 2;
    }
    p++;
  }
  lx.pos = b.length;
  return b.length;
}

// ── helpers ───────────────────────────────────────────────────────────────────

export const num = (o: Operand | undefined, d = 0): number => (o && o.t === 'num' ? o.v : d);
export const nameOf = (o: Operand | undefined): string | undefined => (o && o.t === 'name' ? o.v : undefined);

export function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

export function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function hexString(bytes: Uint8Array | number[]): string {
  let s = '<';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
  return s + '>';
}

/** Serializes a name for content streams (escapes delimiters/whitespace/non-ASCII with #xx). */
export function nameToken(n: string): string {
  let s = '/';
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (c < 33 || c > 126 || DELIM[c] || c === 35) s += '#' + (c < 16 ? '0' : '') + c.toString(16);
    else s += n[i];
  }
  return s;
}
