/**
 * Stamp appearance: a design in a local display-oriented frame (w × h, y up), placed into the
 * object's rect upright for the page rotation it was stamped on.
 */
import type { Rect } from '@/core/types';
import { displaySize, ellipseSegs, matMul, polySegs, rectFrame, roundRectSegs, type Mat } from '../geom';
import { textWidth } from '../fonts';
import { text, type Paint } from '../paint';
import type { StampData } from '../model';
import { TONES, toneOf } from './catalog';

export interface StampDesign {
  w: number;
  h: number;
  paints: Paint[];
}

const BOX_H = 44;
const BOX_H_SUB = 58;

function fitSize(label: string, maxW: number, max: number, bold = true) {
  const unit = textWidth(label, 1, bold);
  return unit > 0 ? Math.min(max, maxW / unit) : max;
}

function boxDesign(label: string, subline: string | undefined, color: string): StampDesign {
  const h = subline ? BOX_H_SUB : BOX_H;
  const labelW = textWidth(label, 22, true);
  const subW = subline ? textWidth(subline, 8.5, false) : 0;
  const w = Math.max(120, labelW + 36, subW + 28);
  const paints: Paint[] = [
    { t: 'path', segs: roundRectSegs({ x: 1.25, y: 1.25, width: w - 2.5, height: h - 2.5 }, 8), stroke: color, width: 2.5, fill: color, fillOpacity: 0.08, join: 'round' },
    { t: 'path', segs: roundRectSegs({ x: 4.75, y: 4.75, width: w - 9.5, height: h - 9.5 }, 5), stroke: color, width: 0.75, join: 'round' },
  ];
  const size = fitSize(label, w - 24, 22);
  const lw = textWidth(label, size, true);
  if (subline) {
    paints.push(text(label, (w - lw) / 2, h - 12 - size * 0.72, size, color, true));
    const ss = fitSize(subline, w - 20, 8.5, false);
    const sw = textWidth(subline, ss, false);
    paints.push(text(subline, (w - sw) / 2, 12, ss, color, false));
  } else {
    paints.push(text(label, (w - lw) / 2, h / 2 - size * 0.36, size, color, true));
  }
  return { w, h, paints };
}

function arrowDesign(label: string, color: string): StampDesign {
  const h = 40;
  const tip = 20;
  const size0 = 16;
  const w = Math.max(130, textWidth(label, size0, true) + tip + 24);
  const paints: Paint[] = [
    {
      t: 'path',
      segs: polySegs([{ x: 1, y: h / 2 }, { x: tip, y: h - 1 }, { x: w - 1, y: h - 1 }, { x: w - 1, y: 1 }, { x: tip, y: 1 }], true),
      fill: color,
      stroke: color,
      width: 1.5,
      join: 'round',
    },
  ];
  const size = fitSize(label, w - tip - 16, size0);
  const lw = textWidth(label, size, true);
  paints.push(text(label, tip + (w - tip - 8 - lw) / 2, h / 2 - size * 0.36, size, '#ffffff', true));
  return { w, h, paints };
}

function markDesign(kind: 'check' | 'cross', color: string): StampDesign {
  const s = 48;
  const ring: Paint = { t: 'path', segs: ellipseSegs(s / 2, s / 2, s / 2 - 2, s / 2 - 2), stroke: color, width: 2.5, fill: color, fillOpacity: 0.08 };
  const mark: Paint =
    kind === 'check'
      ? { t: 'path', segs: polySegs([{ x: 13, y: 25 }, { x: 21, y: 16 }, { x: 36, y: 33 }]), stroke: color, width: 5.5, cap: 'round', join: 'round' }
      : {
          t: 'path',
          segs: [...polySegs([{ x: 16, y: 16 }, { x: 32, y: 32 }]), ...polySegs([{ x: 16, y: 32 }, { x: 32, y: 16 }])],
          stroke: color,
          width: 5.5,
          cap: 'round',
        };
  return { w: s, h: s, paints: [ring, mark] };
}

/** Natural design of a stamp (catalog / custom). Imported stamps use their preserved appearance instead. */
export function stampDesign(d: StampData): StampDesign {
  if (d.image) {
    const { w, h } = naturalImageSize(d.image.w, d.image.h);
    if (d.pdf) return { w, h, paints: [{ t: 'pdfpage', pdf: d.pdf, src: d.image.src, x: 0, y: 0, w, h }] };
    return { w, h, paints: [{ t: 'image', src: d.image.src, x: 0, y: 0, w, h }] };
  }
  const color = TONES[toneOf(d)];
  if (d.shape === 'arrow') return arrowDesign(d.label, color);
  if (d.shape === 'check' || d.shape === 'cross') return markDesign(d.shape, color);
  return boxDesign(d.label, d.subline, color);
}

/** Fit image pixels into at most 200 × 140 pt (keeping the aspect ratio). */
export function naturalImageSize(pw: number, ph: number) {
  const w0 = Math.max(1, pw), h0 = Math.max(1, ph);
  const k = Math.min(200 / w0, 140 / h0);
  return { w: w0 * k, h: h0 * k };
}

/** Paints of the stamp placed into `rect` (PDF space). */
export function stampPaints(d: StampData, rect: Rect): Paint[] {
  const design = stampDesign(d);
  return [{ t: 'group', m: stampMatrix(rect, d.rotation, design), items: design.paints }];
}

export function stampMatrix(rect: Rect, rotation: StampData['rotation'], design: { w: number; h: number }): Mat {
  const { w, h } = displaySize(rect, rotation);
  const scale: Mat = [w / design.w, 0, 0, h / design.h, 0, 0];
  return matMul(rectFrame(rect, rotation), scale);
}
