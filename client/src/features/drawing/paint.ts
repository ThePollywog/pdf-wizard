/**
 * Paint list: the single visual description of every drawing object, rendered both as SVG
 * (screen) and as PDF content-stream operators (appearance streams / flattening), so the screen
 * and the exported file match exactly. Coordinates are PDF user space unless inside a group frame.
 */
import type { Point, Rect } from '@/core/types';
import { apply, bboxOf, matMul, segPoints, type Mat, type Seg } from './geom';
import { cleanText, textWidth } from './fonts';

export type Cap = 'butt' | 'round' | 'square';
export type Join = 'miter' | 'round' | 'bevel';

export interface PathPaint {
  t: 'path';
  segs: Seg[];
  stroke?: string;
  fill?: string;
  width?: number;
  dash?: number[];
  cap?: Cap;
  join?: Join;
  strokeOpacity?: number;
  fillOpacity?: number;
  /** Not clickable on screen (decorations such as label backgrounds). */
  noHit?: boolean;
}
export interface TextPaint {
  t: 'text';
  /** Single-line text (any Unicode; see cleanText). */
  text: string;
  /** Baseline start in the current frame (y up). */
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  color: string;
  /** Advance width, used as SVG textLength so the screen matches the PDF. */
  width: number;
}
export interface ImagePaint {
  t: 'image';
  /** data: URL (PNG / JPEG). */
  src: string;
  /** Box in the current frame (y up). */
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A PDF page (base64 one-page PDF) drawn as a vector form, with a raster fallback for the screen. */
export interface PdfPagePaint {
  t: 'pdfpage';
  pdf: string;
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GroupPaint {
  t: 'group';
  /** Frame → parent space. */
  m: Mat;
  items: Paint[];
}
export type Paint = PathPaint | TextPaint | ImagePaint | PdfPagePaint | GroupPaint;

export function text(s: string, x: number, y: number, size: number, color: string, bold = false): TextPaint {
  const clean = cleanText(s);
  return { t: 'text', text: clean, x, y, size, bold, color, width: textWidth(clean, size, bold) };
}

/** Bounds of the paints in PDF space (strokes included). */
export function paintBounds(paints: Paint[], m: Mat = [1, 0, 0, 1, 0, 0]): Rect | null {
  const pts: Point[] = [];
  const walk = (list: Paint[], mm: Mat) => {
    for (const p of list) {
      if (p.t === 'group') {
        walk(p.items, matMul(mm, p.m));
        continue;
      }
      let local: Point[] = [];
      let pad = 0;
      if (p.t === 'path') {
        local = segPoints(p.segs);
        pad = p.stroke ? (p.width ?? 1) / 2 + (p.join === 'miter' || !p.join ? (p.width ?? 1) : 0) : 0;
      } else if (p.t === 'text') {
        local = [{ x: p.x, y: p.y - p.size * 0.25 }, { x: p.x + p.width, y: p.y + p.size * 0.8 }];
      } else {
        local = [{ x: p.x, y: p.y }, { x: p.x + p.w, y: p.y + p.h }];
      }
      const b = bboxOf(local);
      if (!b) continue;
      const corners = [
        { x: b.x - pad, y: b.y - pad },
        { x: b.x + b.width + pad, y: b.y - pad },
        { x: b.x - pad, y: b.y + b.height + pad },
        { x: b.x + b.width + pad, y: b.y + b.height + pad },
      ];
      for (const c of corners) pts.push(apply(mm, c));
    }
  };
  walk(paints, m);
  return bboxOf(pts);
}
