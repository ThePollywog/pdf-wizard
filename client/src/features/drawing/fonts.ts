/**
 * Helvetica / Helvetica-Bold advance widths (1/1000 em, ASCII 32..126 plus common WinAnsi characters)
 * so stamp and measurement labels are laid out identically on screen (SVG with textLength) and in
 * the exported PDF. Text keeps its Unicode characters; see pdfops.ts for how they are embedded.
 */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Helvetica widths of common non-ASCII WinAnsi characters (bold where it differs). */
const EXTRA: Record<string, [number, number]> = {
  '\u00a0': [278, 278], '¡': [333, 333], '¢': [556, 556], '£': [556, 556], '¤': [556, 556], '¥': [556, 556], '¦': [260, 280],
  '§': [556, 556], '¨': [333, 333], '©': [737, 737], 'ª': [370, 370], '«': [556, 556], '¬': [584, 584], '®': [737, 737],
  '¯': [333, 333], '°': [400, 400], '±': [584, 584], '²': [333, 333], '³': [333, 333], '´': [333, 333], 'µ': [556, 611],
  '¶': [537, 556], '·': [278, 278], '¸': [333, 333], '¹': [333, 333], 'º': [365, 365], '»': [556, 556], '¼': [834, 834],
  '½': [834, 834], '¾': [834, 834], '¿': [611, 611], 'Æ': [1000, 1000], 'Ð': [722, 722], '×': [584, 584], 'Ø': [778, 778],
  'Þ': [667, 667], 'ß': [611, 611], 'æ': [889, 889], 'ð': [556, 611], '÷': [584, 584], 'ø': [611, 611], 'þ': [556, 611],
  'Œ': [1000, 1000], 'œ': [944, 944], 'ƒ': [556, 556], '‘': [222, 278], '’': [222, 278], '‚': [222, 278], '“': [333, 500],
  '”': [333, 500], '„': [333, 500], '–': [556, 556], '—': [1000, 1000], '†': [556, 556], '‡': [556, 556], '•': [350, 350],
  '…': [1000, 1000], '‰': [1000, 1000], '‹': [333, 333], '›': [333, 333], '€': [556, 556], '™': [1000, 1000], 'ı': [278, 278],
};

/** East Asian wide characters (CJK, kana, Hangul, full-width forms) are one em wide. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
const COMBINING = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u200b-\u200f\ufe00-\ufe0f]/;

/**
 * Normalize text for drawing: keeps every printable character (Unicode included), turns tabs, line
 * breaks and typographic spaces (e.g. the narrow no-break space some locales put before "AM") into
 * plain spaces and drops control characters, zero-width spaces and byte-order marks.
 */
export function cleanText(s: string): string {
  return s
    .replace(/[\t\n\r\v\f\u2028\u2029\u2000-\u200a\u202f\u205f]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u2060\ufeff\ufffe\uffff]/g, '');
}

/** Advance of one character in 1/1000 em (as used by textWidth). */
export function charWidth(ch: string, bold = false): number {
  const c = ch.codePointAt(0) ?? 32;
  const t = bold ? HELV_BOLD : HELV;
  if (c >= 32 && c <= 126) return t[c - 32];
  const e = EXTRA[ch];
  if (e) return e[bold ? 1 : 0];
  if (COMBINING.test(ch)) return 0;
  if (WIDE.test(ch) || (c >= 0x20000 && c <= 0x3fffd)) return 1000;
  // Accented Latin letters take the width of their base letter.
  const base = ch.normalize('NFD').charCodeAt(0);
  if (base >= 32 && base <= 126 && base !== c) return t[base - 32];
  // Other scripts (Greek, Cyrillic, …): an average Helvetica-like advance.
  const upper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
  return upper ? (bold ? 722 : 667) : bold ? 611 : 556;
}

/**
 * Advance width of `text` in points at `size` (Helvetica metrics, estimated for other scripts).
 * Screen text is stretched to exactly this width (SVG textLength) and the exported text is scaled to
 * it (Tz), so both always agree even when the actual font differs.
 */
export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, bold);
  return (w / 1000) * size;
}

export const FONT_STACK = 'Helvetica, Arial, "Liberation Sans", sans-serif';
