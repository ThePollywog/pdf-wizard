/**
 * CSS fonts matching the PDF standard fonts (Helvetica → Arial / Liberation Sans, Times →
 * Times New Roman / Liberation Serif, Courier → Courier New / Liberation Mono) and the metrics used
 * to put an HTML line box's baseline exactly where the PDF baseline is.
 */
import type { CSSProperties } from 'react';
import type { Family, StdFontName } from './content/fonts';
import { stdFontFor } from './content/fonts';
import type { TextStyle } from './content/blocks';
import { stdLayoutFont } from './content/ops';
import type { LayoutFont } from './content/layout';

export const CSS_FAMILY: Record<Family, string> = {
  sans: '"EditPdf Sans", Arial, "Liberation Sans", Helvetica, sans-serif',
  serif: '"Times New Roman", "Liberation Serif", Tinos, Times, serif',
  mono: '"Courier New", "Liberation Mono", Cousine, Courier, monospace',
};

/** hhea ascent / descent (em) of the CSS fonts above (Arial ≈ Liberation Sans, …). */
const METRICS: Record<Family, { ascent: number; descent: number }> = {
  sans: { ascent: 0.905, descent: 0.212 },
  serif: { ascent: 0.891, descent: 0.216 },
  mono: { ascent: 0.833, descent: 0.3 },
};

/** Distance from the top of a CSS line box (line-height `lineHeight`) to its baseline, in points. */
export function cssBaselineInLine(style: TextStyle): number {
  const m = METRICS[style.family];
  const content = (m.ascent + m.descent) * style.size;
  return (style.lineHeight - content) / 2 + m.ascent * style.size;
}

/** Inline CSS for text rendered at `zoom` CSS px per point. */
export function cssTextStyle(style: TextStyle, zoom: number): CSSProperties {
  return {
    fontFamily: CSS_FAMILY[style.family],
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    fontSize: `${style.size * zoom}px`,
    lineHeight: `${Math.max(1, style.lineHeight) * zoom}px`,
    letterSpacing: style.charSpacing ? `${style.charSpacing * zoom}px` : undefined,
    color: style.color,
    textAlign: style.align,
    textDecoration: style.underline ? 'underline' : 'none',
    textUnderlineOffset: style.underline ? '0.12em' : undefined,
    fontKerning: 'none',
    fontVariantLigatures: 'none',
  };
}

const layoutCache = new Map<StdFontName, LayoutFont>();
/** Standard-font metrics for measuring text like the PDF writer will. */
export function measureFont(style: Pick<TextStyle, 'family' | 'bold' | 'italic'>): LayoutFont {
  const std = stdFontFor(style.family, style.bold, style.italic);
  let f = layoutCache.get(std);
  if (!f) {
    const base = stdLayoutFont(std, 'F');
    // characters outside WinAnsi are measured as an average glyph (they are drawn with Liberation Sans)
    f = { ...base, width: (t) => [...t].reduce((w, ch) => w + (base.encode(ch) === null ? 556 : base.width(ch)), 0) };
    layoutCache.set(std, f);
  }
  return f;
}
