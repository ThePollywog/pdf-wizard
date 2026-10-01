/**
 * Caret offsets from page points for the in-place editor: the text is laid out like the editor
 * shows it (same line breaking, alignment and baseline offset), then the nearest character
 * boundary is picked.
 */
import type { Point } from '@/core/types';
import type { Frame, TextStyle } from './content/blocks';
import { measureFont } from './fontMap';
import { layoutTextBox, firstBaselineOf } from './textbox';
import { toLocal } from './viewmath';

export interface CaretLayoutInput {
  text: string;
  style: TextStyle;
  frame: Frame;
  firstBaseline: number;
  autoWidth: boolean;
}

/** Text offset nearest to the user-space point `p`. */
export function caretOffsetAt(s: CaretLayoutInput, p: Point): number {
  const { text, style } = s;
  if (!text) return 0;
  const lay = layoutTextBox(text, style, s.frame.width, s.autoWidth);
  const [x, y] = toLocal(s.frame, p);
  const shift = s.firstBaseline - firstBaselineOf(style);
  const lh = style.lineHeight || style.size * 1.2;
  const i = Math.max(0, Math.min(lay.lines.length - 1, Math.floor((y - shift) / lh)));
  const start = rangesOf(text, lay.lines)[i]?.[0] ?? 0;
  const line = lay.lines[i];
  const W = lay.width;
  const lw = line.width;
  let x0 = 0;
  if (style.align === 'center') x0 = (W - lw) / 2;
  else if (style.align === 'right') x0 = W - lw;
  const font = measureFont(style);
  const chars = [...line.text];
  let best = 0;
  let bestD = Math.abs(x - x0);
  let acc = '';
  let units = 0;
  for (let c = 0; c < chars.length; c++) {
    acc += chars[c];
    units += chars[c].length;
    const w = (font.width(acc) / 1000) * style.size + style.charSpacing * (c + 1);
    const d = Math.abs(x - (x0 + w));
    if (d < bestD) {
      bestD = d;
      best = units;
    }
  }
  return Math.max(0, Math.min(text.length, start + best));
}

/** [start, end) offsets in `text` of each laid-out line. */
function rangesOf(text: string, lines: { text: string }[]): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k].text;
    const idx = t ? text.indexOf(t, pos) : pos;
    const at = idx < 0 ? pos : idx;
    pos = at + t.length;
    out.push([at, pos]);
    // skip the separator (space / newline) the line break consumed
    if (text[pos] === ' ' || text[pos] === '\n') pos++;
  }
  return out;
}

/** Start / end offsets of the displayed line holding `offset` (for Home / End in the editor). */
export function lineBoundsAt(s: Omit<CaretLayoutInput, 'firstBaseline'>, offset: number): [number, number] {
  const { text } = s;
  if (!text) return [0, 0];
  const lay = layoutTextBox(text, s.style, s.frame.width, s.autoWidth);
  const ranges = rangesOf(text, lay.lines);
  for (const r of ranges) if (offset >= r[0] && offset <= r[1]) return r;
  // inside a separator: the line after it
  const next = ranges.find((r) => r[0] >= offset);
  return next ?? [0, text.length];
}
