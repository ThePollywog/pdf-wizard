/**
 * Text layout for re-typeset blocks and new text boxes: greedy line breaking with the real font
 * widths, alignment (incl. justify through TJ adjustments), line spacing, character spacing and
 * underline — emitted as content-stream operators in the block's frame (any orientation).
 */
import type { Frame, TextStyle } from './blocks';
import { pt } from './blocks';
import type { Glyph } from './interpreter';
import { fillToHex } from './interpreter';
import { hexString, nameToken } from './parser';
import { fmt, fmtMatrix, mul, translate, type Matrix } from './matrix';

export interface LayoutFont {
  /** Resource name on the page. */
  resName: string;
  /** Hex string token for the text, or null when it can't be encoded. */
  encode(text: string): string | null;
  /** Advance width of the text in 1/1000 em (no character spacing). */
  width(text: string): number;
  ascent: number;
  descent: number;
  /** Font for the characters this one can't encode (e.g. an embedded Unicode font). */
  fallback?: LayoutFont;
}

/** A piece of text drawn with one font. */
export interface FontRun {
  font: LayoutFont;
  text: string;
}

/** The first font of the fallback chain that can encode `ch`, or null. */
export function fontFor(font: LayoutFont, ch: string): LayoutFont | null {
  for (let f: LayoutFont | undefined = font; f; f = f.fallback) if (f.encode(ch) !== null) return f;
  return null;
}

/**
 * Splits text into runs per font. A word is drawn in the first font of the chain that has all of
 * its characters, so fonts never switch inside a word (text extraction keeps the word whole);
 * only a word no single font covers falls back per character. Spaces stay with the current run.
 * Characters no font can encode are skipped (and collected).
 */
export function fontRuns(font: LayoutFont, text: string, missing?: Set<string>): FontRun[] {
  const runs: FontRun[] = [];
  const push = (f: LayoutFont, t: string) => {
    const prev = runs[runs.length - 1];
    if (prev && prev.font === f) prev.text += t;
    else runs.push({ font: f, text: t });
  };
  for (const part of text.split(/( +)/)) {
    if (!part) continue;
    if (part[0] === ' ') {
      const prev = runs[runs.length - 1];
      const f = prev && prev.font.encode(part) !== null ? prev.font : fontFor(font, ' ');
      if (f) push(f, part);
      else missing?.add(' ');
      continue;
    }
    let whole: LayoutFont | null = null;
    for (let f: LayoutFont | undefined = font; f && !whole; f = f.fallback) if (f.encode(part) !== null) whole = f;
    if (whole) {
      push(whole, part);
      continue;
    }
    for (const ch of part) {
      const f = fontFor(font, ch);
      if (f) push(f, ch);
      else missing?.add(ch);
    }
  }
  return runs;
}

function dropChars(line: string, drop: Set<string>): string {
  const words = line.split(' ');
  const kept = words.map((w) => [...w].filter((ch) => !drop.has(ch)).join(''));
  return kept.filter((w, i) => w !== '' || words[i] === '').join(' ');
}

/** Advance width (1/1000 em) of text drawn with the font and its fallbacks. */
export function textWidth(font: LayoutFont, s: string): number {
  if (!font.fallback) return font.width(s);
  let w = 0;
  for (const r of fontRuns(font, s)) w += r.font.width(r.text);
  return w;
}

export interface LaidLine {
  text: string;
  /** Width in points (incl. character spacing). */
  width: number;
  /** Last line of a paragraph (not justified). */
  last: boolean;
}

function measure(font: LayoutFont, s: string, style: TextStyle): number {
  if (!s) return 0;
  return (textWidth(font, s) / 1000) * style.size + style.charSpacing * [...s].length;
}

/** Breaks `text` into lines no wider than `maxWidth` (null = no wrapping). */
export function breakLines(text: string, font: LayoutFont, style: TextStyle, maxWidth: number | null): LaidLine[] {
  const out: LaidLine[] = [];
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  const limit = maxWidth === null ? Infinity : maxWidth + Math.max(0.5, style.size * 0.02);
  for (const para of paragraphs) {
    if (maxWidth === null) {
      out.push({ text: para, width: measure(font, para, style), last: true });
      continue;
    }
    const words = para.split(' ');
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (measure(font, candidate, style) <= limit || !line) {
        if (!line && measure(font, w, style) > limit) {
          // a single word wider than the box: break by characters
          let chunk = '';
          for (const ch of w) {
            if (chunk && measure(font, chunk + ch, style) > limit) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        lines.push(line);
        if (measure(font, w, style) > limit) {
          let chunk = '';
          for (const ch of w) {
            if (chunk && measure(font, chunk + ch, style) > limit) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = w;
      }
    }
    lines.push(line);
    lines.forEach((l, i) => out.push({ text: l, width: measure(font, l, style), last: i === lines.length - 1 }));
  }
  return out;
}

function rgbOps(hex: string, op: 'rg' | 'RG' = 'rg'): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${op}`;
}

export interface TypesetInput {
  text: string;
  frame: Frame;
  /** Distance from the frame top to the first baseline. */
  firstBaseline: number;
  style: TextStyle;
  font: LayoutFont;
  /** Wrap at frame.width (default true). */
  wrap?: boolean;
}

export interface TypesetResult {
  ops: string;
  lines: LaidLine[];
  /** Height from frame top to the last line's descent. */
  height: number;
  /** Some characters couldn't be encoded with any font (they are left out). */
  failed: boolean;
  /** The characters left out. */
  missing: string[];
}

/** Content operators drawing the text (user space, default graphics state). */
export function typeset(input: TypesetInput): TypesetResult {
  const { frame, style, font } = input;
  // characters no font of the chain has are left out (reported in `missing`)
  const missing = new Set<string>();
  for (const ch of input.text) if (ch !== '\n' && ch !== ' ' && !fontFor(font, ch)) missing.add(ch);
  // (a word made only of such characters leaves no double space behind)
  const text = missing.size ? input.text.split('\n').map((l) => dropChars(l, missing)).join('\n') : input.text;
  const lines = breakLines(text, font, style, input.wrap === false ? null : frame.width);
  const W = frame.width;
  const parts: string[] = ['q', 'BT', `${fmt(style.charSpacing)} Tc 0 Tw 100 Tz 0 Ts 0 Tr`, rgbOps(style.color)];
  const underline: string[] = [];
  let current: LayoutFont | null = null;
  const useFont = (f: LayoutFont) => {
    if (f === current) return;
    parts.push(`${nameToken(f.resName)} ${fmt(style.size)} Tf`);
    current = f;
  };
  if (!fontRuns(font, text).length) useFont(font);
  lines.forEach((line, i) => {
    const baseline = input.firstBaseline + i * style.lineHeight;
    const lw = line.width - (line.text ? style.charSpacing : 0);
    let x = 0;
    if (style.align === 'center') x = (W - lw) / 2;
    else if (style.align === 'right') x = W - lw;
    const p = pt(frame, x, baseline);
    const tm: Matrix = [frame.u[0], frame.u[1], -frame.d[0], -frame.d[1], p[0], p[1]];
    if (!line.text) return;
    parts.push(`${fmtMatrix(tm)} Tm`);
    const spaces = (line.text.match(/ /g) ?? []).length;
    const justify = style.align === 'justify' && !line.last && spaces > 0 && W > lw;
    // extra space after every space character (TJ adjustment, independent of the font)
    const adj = justify ? fmt((-((W - lw) / spaces) * 1000) / style.size) : null;
    for (const run of fontRuns(font, line.text)) {
      useFont(run.font);
      if (adj === null) {
        parts.push(`${run.font.encode(run.text)} Tj`);
        continue;
      }
      const words = run.text.split(' ');
      const arr: string[] = [];
      words.forEach((w, k) => {
        const piece = k < words.length - 1 ? `${w} ` : w;
        if (piece) arr.push(run.font.encode(piece) as string);
        if (k < words.length - 1) arr.push(adj);
      });
      parts.push(`[${arr.join(' ')}] TJ`);
    }
    if (style.underline) {
      const width = justify ? W : lw;
      const y = -0.1 * style.size;
      const th = Math.max(0.5, 0.05 * style.size);
      underline.push(`q ${fmtMatrix(tm)} cm 0 ${fmt(y - th / 2)} ${fmt(width)} ${fmt(th)} re f Q`);
    }
  });
  parts.push('ET');
  if (underline.length) parts.push(rgbOps(style.color), ...underline);
  parts.push('Q');
  const height = input.firstBaseline + (lines.length - 1) * style.lineHeight + (-font.descent / 1000) * style.size;
  return { ops: parts.join('\n'), lines, height, failed: missing.size > 0, missing: [...missing] };
}

/** Re-emits glyphs with their original font codes, translated by (dx, dy) in user space. */
export function reemitGlyphs(glyphs: Glyph[], dx: number, dy: number, fontName: (g: Glyph) => string | null): string {
  // runs: consecutive glyphs from the same string operand
  const sorted = [...glyphs].sort((a, b) => a.seq - b.seq);
  const out: string[] = ['q', 'BT'];
  let cur: { key: string; glyphs: Glyph[] } | null = null;
  const runs: Glyph[][] = [];
  for (const g of sorted) {
    const key = `${g.source}:${g.op}:${g.arg}`;
    const prev = cur?.glyphs[cur.glyphs.length - 1];
    if (cur && cur.key === key && prev && prev.byteStart + prev.byteLen === g.byteStart) cur.glyphs.push(g);
    else {
      cur = { key, glyphs: [g] };
      runs.push(cur.glyphs);
    }
  }
  let state = '';
  const T = translate(dx, dy);
  for (const run of runs) {
    const g = run[0];
    const name = fontName(g);
    if (!name) continue;
    const st = `${nameToken(name)} ${fmt(g.size)} Tf ${fmt(g.tc)} Tc ${fmt(g.tw)} Tw ${fmt(g.th * 100)} Tz ${fmt(g.rise)} Ts ${g.render} Tr ${fillOps(g)}`;
    if (st !== state) {
      out.push(st);
      state = st;
    }
    out.push(`${fmtMatrix(mul(g.textToUser, T))} Tm ${hexString(runBytes(run))} Tj`);
  }
  out.push('ET', 'Q');
  return out.join('\n');
}

function runBytes(run: Glyph[]): number[] {
  const out: number[] = [];
  for (const g of run) out.push(...codeBytes(g.code, g.byteLen));
  return out;
}

function codeBytes(code: number, len: number): number[] {
  return len === 2 ? [(code >> 8) & 255, code & 255] : [code & 255];
}

function fillOps(g: Glyph): string {
  const c = g.fill.c.map((x) => fmt(x));
  if (g.fill.space === 'gray' && c.length >= 1) return `${c[0]} g`;
  if (g.fill.space === 'rgb' && c.length >= 3) return `${c.slice(0, 3).join(' ')} rg`;
  if (g.fill.space === 'cmyk' && c.length >= 4) return `${c.slice(0, 4).join(' ')} k`;
  return rgbOps(fillToHex(g.fill));
}
