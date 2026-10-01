/**
 * Groups interpreted glyphs into editable text blocks: glyph runs → lines (same orientation,
 * baseline and size, continuing horizontally) → paragraphs (consistent baseline spacing and
 * horizontal overlap). Each block gets a local frame (text direction u, down direction d) so the
 * editor can be positioned exactly over rotated text.
 */
import type { Glyph } from './interpreter';
import { fillToHex } from './interpreter';
import type { FontInfo, Family } from './fonts';
import { applyLinear, quadBounds } from './matrix';
import { winAnsiCodeFor } from './encodings';

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface TextStyle {
  family: Family;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Font size in user-space points. */
  size: number;
  color: string;
  /** Baseline-to-baseline distance (points). */
  lineHeight: number;
  /** Character spacing (Tc, user-space points). */
  charSpacing: number;
  align: Align;
}

export interface TextLine {
  glyphs: Glyph[];
  text: string;
  /** Position along the down axis (baseline). */
  v: number;
  /** Extent along the text direction. */
  u0: number;
  u1: number;
  size: number;
}

export interface Frame {
  /** Top-left corner in user space. */
  origin: [number, number];
  /** Unit text direction (user space). */
  u: [number, number];
  /** Unit "down" direction (user space). */
  d: [number, number];
  width: number;
  height: number;
}

export interface TextBlock {
  id: string;
  glyphs: Glyph[];
  lines: TextLine[];
  text: string;
  frame: Frame;
  /** Distance from the frame top to the first baseline. */
  firstBaseline: number;
  style: TextStyle;
  /** Dominant font. */
  font: FontInfo;
  fontName: string;
  /** All glyphs can be removed from the content stream. */
  removable: boolean;
  /** Unicode of all glyphs is known. */
  textReliable: boolean;
  /** User-space bounding box. */
  bounds: { x: number; y: number; width: number; height: number };
}

interface G {
  g: Glyph;
  u0: number;
  u1: number;
  v: number;
  size: number;
  space: boolean;
}

interface Orient {
  key: string;
  u: [number, number];
  d: [number, number];
}

const norm = (x: number, y: number): [number, number] => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};

function orientationOf(g: Glyph): Orient & { scale: number } {
  const [ux, uy] = applyLinear(g.textToUser, 1, 0);
  const [vx, vy] = applyLinear(g.textToUser, 0, 1);
  const u = norm(ux, uy);
  // down = −(up projected orthogonal to u)
  const dot = vx * u[0] + vy * u[1];
  const up = norm(vx - dot * u[0], vy - dot * u[1]);
  const d: [number, number] = [-up[0], -up[1]];
  const ang = Math.round((Math.atan2(u[1], u[0]) * 180) / Math.PI);
  const flip = u[0] * d[1] - u[1] * d[0] > 0 ? 'n' : 'm';
  return { key: `${ang}${flip}`, u, d, scale: Math.hypot(vx, vy) };
}

const isWs = (s: string) => s.length > 0 && /^\s+$/.test(s);

/**
 * Glyphs that decide a line's / block's font: characters outside WinAnsi are often drawn with a
 * fallback font (e.g. Greek in an embedded Unicode font next to Times), so they only count when
 * nothing else is there.
 */
function styleGlyphs<T extends { g: Glyph }>(solid: T[]): T[] {
  const latin = solid.filter((x) => [...x.g.unicode].every((ch) => winAnsiCodeFor(ch.codePointAt(0)!) !== undefined));
  return latin.length ? latin : solid;
}

/** Builds the text blocks of a page. `pageKey` makes block ids unique per page. */
export function buildBlocks(glyphs: Glyph[], pageKey: string): TextBlock[] {
  const byOrient = new Map<string, { o: Orient; items: G[] }>();
  for (const g of glyphs) {
    if (g.render === 3 || g.render === 7) continue;
    const o = orientationOf(g);
    const size = Math.abs(g.size) * o.scale;
    if (!(size > 0.5) || !Number.isFinite(size)) continue;
    const pu = g.origin[0] * o.u[0] + g.origin[1] * o.u[1];
    const pv = g.origin[0] * o.d[0] + g.origin[1] * o.d[1];
    const w = (g.w0 / 1000) * g.size * g.th * o.scale;
    let bucket = byOrient.get(o.key);
    if (!bucket) byOrient.set(o.key, (bucket = { o, items: [] }));
    bucket.items.push({ g, u0: pu, u1: pu + Math.abs(w), v: pv, size, space: isWs(g.unicode) });
  }
  const blocks: TextBlock[] = [];
  for (const { o, items } of byOrient.values()) blocks.push(...blocksFor(items, o, pageKey));
  // reading order: top to bottom along each orientation's down axis
  return blocks;
}

function blocksFor(items: G[], o: Orient, pageKey: string): TextBlock[] {
  // 1) lines
  interface L { items: G[]; v: number; u0: number; u1: number; size: number }
  const lines: L[] = [];
  for (const it of items) {
    let best: L | null = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 12; k--) {
      const L = lines[k];
      const s = Math.max(L.size, it.size);
      if (Math.abs(L.v - it.v) > 0.3 * s) continue;
      const ratio = it.size / L.size;
      if (ratio < 0.6 || ratio > 1.65) continue;
      const gap = it.u0 - L.u1;
      if (gap > Math.max(1.1 * s, 4) || gap < -0.6 * s - (it.u1 - it.u0)) {
        // allow glyphs that overlap the line (fake bold, kerning) but not ones far away
        if (!(it.u0 >= L.u0 - 0.1 * s && it.u1 <= L.u1 + 0.1 * s)) continue;
      }
      best = L;
      break;
    }
    if (!best) {
      if (it.space) continue; // whitespace never starts a line
      best = { items: [], v: it.v, u0: it.u0, u1: it.u1, size: it.size };
      lines.push(best);
    }
    best.items.push(it);
    best.u0 = Math.min(best.u0, it.u0);
    if (!it.space) best.u1 = Math.max(best.u1, it.u1);
  }
  // trim trailing whitespace from line extents, compute text
  const tlines: (TextLine & { items: G[]; styleKey: string })[] = [];
  for (const L of lines) {
    const sorted = [...L.items].sort((a, b) => a.u0 - b.u0 || a.g.seq - b.g.seq);
    const solid = sorted.filter((x) => !x.space);
    if (!solid.length) continue;
    const size = median(solid.map((x) => x.size));
    let text = '';
    let prev: G | null = null;
    for (const it of sorted) {
      if (prev) {
        if (!it.space && !prev.space && Math.abs(it.u0 - prev.u0) < 0.05 * size && it.g.unicode === prev.g.unicode) continue; // duplicate (fake bold)
        const gap = it.u0 - prev.u1;
        if (!it.space && !prev.space && gap > 0.18 * size && !text.endsWith(' ')) text += ' ';
      }
      const u = it.g.unicode || (it.g.font.removable ? '�' : '');
      if (it.space) {
        if (text && !text.endsWith(' ')) text += ' ';
      } else text += u;
      prev = it;
    }
    const baseV = median(solid.map((x) => x.v));
    const fc = new Map<string, number>();
    for (const x of styleGlyphs(solid)) {
      const k = `${x.g.font.family}${x.g.font.bold ? 'b' : ''}${x.g.font.italic ? 'i' : ''}`;
      fc.set(k, (fc.get(k) ?? 0) + 1);
    }
    tlines.push({
      styleKey: [...fc.entries()].sort((a, b) => b[1] - a[1])[0][0],
      items: sorted,
      glyphs: sorted.map((x) => x.g),
      text: text.trim(),
      v: baseV,
      u0: Math.min(...solid.map((x) => x.u0)),
      u1: Math.max(...solid.map((x) => x.u1)),
      size,
    });
  }

  // 2) paragraphs
  tlines.sort((a, b) => a.v - b.v || a.u0 - b.u0);
  interface B { lines: typeof tlines; leading: number; u0: number; u1: number; size: number }
  const paras: B[] = [];
  for (const line of tlines) {
    let best: B | null = null;
    let bestD = Infinity;
    for (const B of paras) {
      const last = B.lines[B.lines.length - 1];
      const dv = line.v - last.v;
      const s = Math.max(line.size, last.size);
      if (dv < 0.75 * s || dv > 1.7 * s) continue;
      const ratio = line.size / B.size;
      if (ratio < 0.95 || ratio > 1.05) continue;
      if (line.styleKey !== last.styleKey) continue;
      if (B.lines.length >= 2 && Math.abs(dv - B.leading) > 0.15 * B.leading + 0.5) continue;
      // horizontal relation: overlapping and aligned on the left, right or center
      if (line.u0 > B.u1 - 0.5 * s || line.u1 < B.u0 + 0.5 * s) continue;
      const leftOk = Math.abs(line.u0 - B.u0) < 2.5 * s;
      const rightOk = Math.abs(line.u1 - B.u1) < 1 * s;
      const centerOk = Math.abs((line.u0 + line.u1) / 2 - (B.u0 + B.u1) / 2) < 1 * s;
      if (!leftOk && !rightOk && !centerOk) continue;
      // no other line of another paragraph sits between (same column)
      if (dv < bestD) {
        best = B;
        bestD = dv;
      }
    }
    if (best) {
      const last = best.lines[best.lines.length - 1];
      const dv = line.v - last.v;
      best.leading = best.lines.length === 1 ? dv : (best.leading * (best.lines.length - 1) + dv) / best.lines.length;
      best.lines.push(line);
      best.u0 = Math.min(best.u0, line.u0);
      best.u1 = Math.max(best.u1, line.u1);
    } else paras.push({ lines: [line], leading: 0, u0: line.u0, u1: line.u1, size: line.size });
  }

  // 3) blocks
  return paras.map((B) => makeBlock(B.lines, B.leading, o, pageKey));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function makeBlock(lines: (TextLine & { items: G[]; styleKey: string })[], leading: number, o: Orient, pageKey: string): TextBlock {
  const all = lines.flatMap((l) => l.items);
  const solid = all.filter((x) => !x.space);
  // dominant font / style
  const counts = new Map<Glyph['font'], number>();
  const pool = styleGlyphs(solid);
  for (const x of pool) counts.set(x.g.font, (counts.get(x.g.font) ?? 0) + 1);
  let font = pool[0].g.font;
  let best = -1;
  for (const [f, c] of counts) if (c > best) [font, best] = [f, c];
  const rep = solid.find((x) => x.g.font === font) ?? solid[0];
  const size = median(solid.map((x) => x.size));
  const colorCounts = new Map<string, number>();
  for (const x of solid) {
    const c = fillToHex(x.g.fill);
    colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
  }
  const color = [...colorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '#000000';
  const scale = size / Math.abs(rep.g.size || 1);
  const charSpacing = rep.g.tc * scale * rep.g.th;

  const u0 = Math.min(...lines.map((l) => l.u0));
  const u1 = Math.max(...lines.map((l) => l.u1));
  const asc = (font.ascent / 1000) * size;
  const desc = (-font.descent / 1000) * size;
  const top = lines[0].v - asc;
  const bottom = lines[lines.length - 1].v + desc;
  const width = Math.max(1, u1 - u0);
  const origin: [number, number] = [u0 * o.u[0] + top * o.d[0], u0 * o.u[1] + top * o.d[1]];
  const frame: Frame = { origin, u: o.u, d: o.d, width, height: Math.max(1, bottom - top) };

  // alignment
  let align: Align = 'left';
  if (lines.length >= 2) {
    const tol = Math.max(0.6, 0.01 * width);
    const starts = lines.map((l) => l.u0);
    const ends = lines.map((l) => l.u1);
    const centers = lines.map((l) => (l.u0 + l.u1) / 2);
    const aligned = (xs: number[]) => Math.max(...xs) - Math.min(...xs) <= tol * 2;
    const leftA = aligned(starts);
    const rightA = aligned(ends);
    const rightButLast = lines.length >= 3 && aligned(ends.slice(0, -1)) && ends[ends.length - 1] < Math.max(...ends) - tol;
    if (leftA && (rightA || rightButLast) && lines.length >= 3) align = 'justify';
    else if (leftA) align = 'left';
    else if (rightA) align = 'right';
    else if (aligned(centers)) align = 'center';
  }

  let text = '';
  for (const l of lines) {
    if (!text) text = l.text;
    else if (/[-­]$/.test(text) && /^\p{Ll}/u.test(l.text)) text += l.text;
    else text += ' ' + l.text;
  }
  const quad = [
    ...pt(frame, 0, 0), ...pt(frame, width, 0), ...pt(frame, width, frame.height), ...pt(frame, 0, frame.height),
  ];
  const first = solid[0].g;
  const bold = font.bold;
  return {
    id: `${pageKey}:${first.source}:${first.op}:${first.arg}:${first.byteStart}`,
    glyphs: all.map((x) => x.g),
    lines: lines.map(({ glyphs, text: t, v, u0: a, u1: b, size: s }) => ({ glyphs, text: t, v, u0: a, u1: b, size: s })),
    text,
    frame,
    firstBaseline: asc,
    style: {
      family: font.family,
      bold,
      italic: font.italic,
      underline: false,
      size: round2(size),
      color,
      lineHeight: round2(lines.length >= 2 ? leading : size * 1.2),
      charSpacing: round2(charSpacing),
      align,
    },
    font,
    fontName: rep.g.fontName,
    removable: all.every((x) => x.g.font.removable),
    textReliable: solid.every((x) => !!x.g.unicode && x.g.unicode !== '�'),
    bounds: quadBounds(quad),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Frame-local (x along u, y along d) → user space. */
export function pt(f: Frame, x: number, y: number): [number, number] {
  return [f.origin[0] + x * f.u[0] + y * f.d[0], f.origin[1] + x * f.u[1] + y * f.d[1]];
}

/** User space → frame-local coordinates. */
export function toFrame(f: Frame, p: [number, number]): [number, number] {
  const dx = p[0] - f.origin[0];
  const dy = p[1] - f.origin[1];
  return [dx * f.u[0] + dy * f.u[1], dx * f.d[0] + dy * f.d[1]];
}

export function frameQuad(f: Frame): number[] {
  return [...pt(f, 0, 0), ...pt(f, f.width, 0), ...pt(f, f.width, f.height), ...pt(f, 0, f.height)];
}
