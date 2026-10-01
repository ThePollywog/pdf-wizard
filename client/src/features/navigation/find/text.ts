/**
 * Search text normalization and matching. Page text is normalized (ligatures expanded,
 * hyphenated line breaks joined, whitespace collapsed, typographic quotes straightened, optional
 * case folding) with a map back to offsets in the original PageText.text, so matches can be
 * highlighted with engine.rangeRects.
 */

export interface SearchOptions {
  matchCase: boolean;
  wholeWords: boolean;
}

export interface Normalized {
  text: string;
  /** map[i] = offset in the original text of normalized char i; map[text.length] = original length. */
  map: number[];
}

const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
  'Ĳ': 'IJ',
  'ĳ': 'ij',
  'Œ': 'OE',
  'œ': 'oe',
};
const QUOTES: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
};
const HYPHENS = new Set(['-', '­', '‐', '‑']);
const isSpace = (c: string) => /\s/.test(c) || c === ' ' || c === '​';
const WORD = /[\p{L}\p{N}_]/u;
export const isWordChar = (c: string | undefined) => !!c && WORD.test(c);

export function normalize(src: string, caseSensitive: boolean): Normalized {
  let text = '';
  const map: number[] = [];
  const push = (s: string, at: number) => {
    for (const ch of s) {
      let c = ch;
      if (!caseSensitive) {
        const l = ch.toLowerCase();
        if (l.length === ch.length) c = l;
      }
      text += c;
      for (let k = 0; k < c.length; k++) map.push(at);
    }
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    // Hyphenated line break: "work-\nflow" → "workflow" (letter + hyphen + newline).
    if (HYPHENS.has(ch) && i > 0 && WORD.test(src[i - 1])) {
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j < n && (src[j] === '\n' || src[j] === '\r')) {
        while (j < n && isSpace(src[j])) j++;
        if (j < n && WORD.test(src[j])) {
          i = j;
          continue;
        }
      }
      if (ch === '­') {
        i++;
        continue;
      }
    }
    if (ch === '­' || ch === '​' || ch === '﻿') {
      i++;
      continue;
    }
    if (isSpace(ch)) {
      const at = i;
      while (i < n && isSpace(src[i])) i++;
      if (text.length && text[text.length - 1] !== ' ') push(' ', at);
      continue;
    }
    const lig = LIGATURES[ch];
    if (lig) push(lig, i);
    else if (QUOTES[ch]) push(QUOTES[ch], i);
    else push(ch, i);
    i++;
  }
  map.push(n);
  return { text, map };
}

/** Normalized form of a query (trimmed). */
export function normalizeQuery(q: string, caseSensitive: boolean): string {
  return normalize(q, caseSensitive).text.trim();
}

/** Non-overlapping matches of `query` (already normalized) in `hay`; returns normalized [start, end) pairs. */
export function findAll(hay: string, query: string, wholeWords: boolean): [number, number][] {
  const out: [number, number][] = [];
  if (!query) return out;
  const startsWord = isWordChar(query[0]);
  const endsWord = isWordChar(query[query.length - 1]);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(query, from);
    if (at < 0) break;
    const end = at + query.length;
    if (wholeWords && ((startsWord && isWordChar(hay[at - 1])) || (endsWord && isWordChar(hay[end])))) {
      from = at + 1;
      continue;
    }
    out.push([at, end]);
    from = end;
  }
  return out;
}

/** Original [start, end) of a normalized [s, e) range. */
export function toOriginal(norm: Normalized, s: number, e: number): [number, number] {
  const start = norm.map[s];
  const end = e > s ? norm.map[e - 1] + 1 : start;
  return [start, end];
}

/** Context snippet around [start, end) of `text` (original offsets). */
export function snippet(text: string, start: number, end: number, radius = 40): { before: string; match: string; after: string } {
  const clean = (s: string) => s.replace(/\s+/g, ' ');
  let a = Math.max(0, start - radius);
  let b = Math.min(text.length, end + radius);
  // Don't cut words in half.
  while (a > 0 && a > start - radius - 12 && isWordChar(text[a - 1])) a--;
  while (b < text.length && b < end + radius + 12 && isWordChar(text[b])) b++;
  return {
    before: (a > 0 ? '…' : '') + clean(text.slice(a, start)).trimStart(),
    match: clean(text.slice(start, end)),
    after: clean(text.slice(end, b)).trimEnd() + (b < text.length ? '…' : ''),
  };
}
