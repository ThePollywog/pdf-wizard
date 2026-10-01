/**
 * Geometry of added text boxes (content-text objects): the box's frame follows its rect and the
 * page rotation; its height follows the laid-out lines.
 */
import type { Rect, Rotation } from '@/core/types';
import type { Frame, TextStyle } from './content/blocks';
import { breakLines, type LaidLine } from './content/layout';
import { cssBaselineInLine, measureFont } from './fontMap';
import { frameForRect, frameRect } from './viewmath';
import type { ContentTextObject } from './model';

export interface TextBoxLayout {
  lines: LaidLine[];
  /** Box width (points along the text direction). */
  width: number;
  /** Box height (points). */
  height: number;
}

/** Extra width for auto-width boxes so the browser and the PDF writer never wrap. */
const AUTO_PAD = 2;

export function layoutTextBox(text: string, style: TextStyle, width: number, autoWidth: boolean): TextBoxLayout {
  const font = measureFont(style);
  const lines = breakLines(text || ' ', font, style, autoWidth ? null : Math.max(1, width));
  const w = autoWidth ? Math.max(8, ...lines.map((l) => l.width)) + AUTO_PAD : width;
  return { lines, width: w, height: Math.max(1, lines.length) * style.lineHeight };
}

/** Frame of a text box with the given top-left corner. */
export function boxFrame(origin: [number, number], rotation: Rotation, width: number, height: number): Frame {
  const f = frameForRect({ x: 0, y: 0, width: 1, height: 1 }, rotation);
  return { origin, u: f.u, d: f.d, width, height };
}

export function objectFrame(obj: ContentTextObject): Frame {
  return frameForRect(obj.rect, obj.data.rotation ?? 0);
}

export const firstBaselineOf = (style: TextStyle) => cssBaselineInLine(style);

/** Rect of a text box whose frame keeps `origin` and gets the laid-out size. */
export function boxRect(frame: Frame, text: string, style: TextStyle, autoWidth: boolean): { rect: Rect; frame: Frame } {
  const lay = layoutTextBox(text, style, frame.width, autoWidth);
  const f: Frame = { ...frame, width: lay.width, height: lay.height };
  return { rect: frameRect(f), frame: f };
}
