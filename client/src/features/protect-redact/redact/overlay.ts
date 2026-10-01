/**
 * Overlay text layout, shared by the on-screen preview (SVG) and the PDF writers (the /Redact
 * annotation appearance and applied redactions), so what you see is what gets written.
 *
 * Everything is computed in PDF user space. The text runs upright relative to the page's /Rotate
 * (like desktop PDF editors), i.e. rotated by the page rotation in user space.
 */
import { StandardFontEmbedder, StandardFonts } from '@cantoo/pdf-lib';
import type { Rect, Rotation } from '@/core/types';
import { hexToRgb01 } from '@/core/util';
import { overlayText, type OverlayFont, type OverlayProps } from './types';

const STD: Record<OverlayFont, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  Times: StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier,
};

const embedders = new Map<OverlayFont, StandardFontEmbedder>();
export function embedderFor(font: OverlayFont): StandardFontEmbedder {
  let e = embedders.get(font);
  if (!e) {
    e = StandardFontEmbedder.for((STD[font] ?? StandardFonts.Helvetica) as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    embedders.set(font, e);
  }
  return e;
}
export const stdFontName = (font: OverlayFont) => STD[font] ?? StandardFonts.Helvetica;

/** Keep only characters the WinAnsi-encoded standard fonts can show. */
export function winAnsiOnly(s: string): string {
  const enc = embedderFor('Helvetica').encoding;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\r' || ch === '\t') out += ' ';
    else if (enc.canEncodeUnicodeCodePoint(cp)) out += ch;
  }
  return out;
}

export function canEncode(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && embedderFor('Helvetica').encoding.canEncodeUnicodeCodePoint(cp);
}

/** Distinct characters of `s` the standard fonts can't show (they are left out of overlay text). */
export function unsupportedChars(s: string): string[] {
  const out = new Set<string>();
  for (const ch of s) if (!/\s/.test(ch) && !canEncode(ch)) out.add(ch);
  return [...out];
}

export function textWidth(font: OverlayFont, text: string, size: number): number {
  try {
    return embedderFor(font).widthOfTextAtSize(text, size);
  } catch {
    return text.length * size * 0.55;
  }
}

/** [a b c d e f]: user space = (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

export interface OverlayRun {
  text: string;
  size: number;
  /** Text-space → user-space matrix (baseline origin, upright for the page rotation). */
  matrix: Matrix;
}

export interface OverlayLayout {
  font: OverlayFont;
  color: string;
  /** Clip rect (user space). */
  clip: Rect;
  runs: OverlayRun[];
}

/** Base matrix mapping the visual box (origin bottom-left, x right, y up as seen on screen) to user space. */
function frame(r: Rect, rotation: Rotation): { m: Matrix; vw: number; vh: number } {
  const X1 = r.x + r.width;
  const Y1 = r.y + r.height;
  switch (rotation) {
    case 90:
      return { m: [0, 1, -1, 0, X1, r.y], vw: r.height, vh: r.width };
    case 180:
      return { m: [-1, 0, 0, -1, X1, Y1], vw: r.width, vh: r.height };
    case 270:
      return { m: [0, -1, 1, 0, r.x, Y1], vw: r.height, vh: r.width };
    default:
      return { m: [1, 0, 0, 1, r.x, r.y], vw: r.width, vh: r.height };
  }
}

function place(m: Matrix, x: number, y: number): Matrix {
  return [m[0], m[1], m[2], m[3], m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const MIN_SIZE = 2;
const MAX_SIZE = 144;

/** Layout of the overlay text of one redacted area, or null when there is no overlay text. */
export function layoutOverlay(o: OverlayProps, rect: Rect, rotation: Rotation): OverlayLayout | null {
  const raw = winAnsiOnly(overlayText(o));
  const text = raw.trim();
  if (!text || rect.width < 1 || rect.height < 1) return null;
  const { m, vw, vh } = frame(rect, rotation);
  const pad = Math.min(2, vw * 0.04, vh * 0.1);
  const w1 = Math.max(1e-3, textWidth(o.font, text, 1));
  let size: number;
  if (o.autoSize) {
    size = Math.min(vh * 0.72, (vw - 2 * pad) / w1, MAX_SIZE);
    if (o.repeat) size = Math.min(size, Math.max(MIN_SIZE, Math.min(vh * 0.72, 12)));
  } else size = Math.min(MAX_SIZE, Math.max(1, o.fontSize || 10));
  size = Math.max(Math.min(MIN_SIZE, vh), size);
  const runs: OverlayRun[] = [];
  const alignX = (w: number) => (o.align === 'left' ? pad : o.align === 'right' ? vw - pad - w : (vw - w) / 2);
  if (o.repeat) {
    const lineH = size * 1.2;
    const rows = Math.max(1, Math.floor((vh - pad) / lineH));
    const gap = textWidth(o.font, ' ', size);
    const unit = w1 * size;
    const per = Math.max(1, Math.floor((vw - 2 * pad + gap) / (unit + gap)));
    const line = Array.from({ length: per }, () => text).join(' ');
    const lw = textWidth(o.font, line, size);
    const blockH = rows * lineH;
    const top = vh - (vh - blockH) / 2;
    for (let i = 0; i < rows; i++) {
      const baseline = top - lineH * i - lineH + (lineH - size) / 2 + size * 0.22;
      runs.push({ text: line, size, matrix: place(m, alignX(lw), baseline) });
    }
  } else {
    const w = w1 * size;
    const baseline = vh / 2 - size * 0.35;
    runs.push({ text, size, matrix: place(m, alignX(w), baseline) });
  }
  return { font: o.font, color: o.textColor || '#ff0000', clip: rect, runs };
}

const fmt = (n: number) => (Math.abs(n) < 1e-7 ? '0' : Number(n.toFixed(4)).toString());

export function colorOps(hex: string, fill = true): string {
  const [r, g, b] = hexToRgb01(hex);
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${fill ? 'rg' : 'RG'}`;
}

export function rectOps(r: Rect): string {
  return `${fmt(r.x)} ${fmt(r.y)} ${fmt(r.width)} ${fmt(r.height)} re`;
}

/**
 * Content-stream operators drawing `layout` with the font resource `fontName`
 * (`encode` turns a string into a PDF string/hex token for that font).
 */
export function overlayOps(layout: OverlayLayout, fontName: string, encode: (s: string) => string): string {
  const parts = ['q', `${rectOps(layout.clip)} W n`, 'BT', colorOps(layout.color)];
  for (const run of layout.runs) {
    parts.push(`/${fontName} ${fmt(run.size)} Tf`, `${run.matrix.map(fmt).join(' ')} Tm`, `${encode(run.text)} Tj`);
  }
  parts.push('ET', 'Q');
  return parts.join('\n');
}

/** Hex string token for WinAnsi text in a standard font. */
export function encodeStd(font: OverlayFont, text: string): string {
  return embedderFor(font).encodeText(text).toString();
}

export { fmt };
