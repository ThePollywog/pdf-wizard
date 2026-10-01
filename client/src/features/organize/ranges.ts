/**
 * Strict page-range parsing for the organize dialogs ("1-3, 5, 8-"). Unlike core's
 * parsePageRanges (which silently drops bad parts) every problem is reported, so the dialogs can
 * show a precise message and keep the confirm button disabled.
 */
import { formatPageRanges } from '@/core/util';

export interface RangeGroupsResult {
  /** One group per comma-separated part, 0-based indices in the order written. */
  groups: number[][];
  error: string | null;
}

export interface RangeResult {
  /** Sorted unique 0-based indices. */
  indices: number[];
  error: string | null;
}

const PART = /^(\d+|last|end)?\s*(?:(-|–|to)\s*(\d+|last|end)?)?$/i;

function pageNumber(tok: string | undefined, count: number): number | null {
  if (!tok) return null;
  if (/^(last|end)$/i.test(tok)) return count;
  return parseInt(tok, 10);
}

/** Parse "1-3, 4-6, 7-" into groups. `-5` means 1-5 and `7-` means 7 to the last page. */
export function parseRangeGroups(input: string, count: number): RangeGroupsResult {
  const text = input.trim();
  if (!text) return { groups: [], error: 'Enter the pages, for example 1-3, 5, 8-.' };
  const parts = text.split(/[,;]+/).map((p) => p.trim());
  const groups: number[][] = [];
  for (const part of parts) {
    if (!part) continue;
    const m = PART.exec(part);
    if (!m || (!m[1] && !m[2])) return { groups: [], error: `“${part}” isn't a valid page range. Use page numbers like 1-3, 5, 8-.` };
    const a = pageNumber(m[1], count) ?? 1;
    const b = m[2] ? (pageNumber(m[3], count) ?? count) : a;
    for (const n of [a, b]) {
      if (n < 1 || n > count) {
        return { groups: [], error: `Page ${n} doesn't exist. The document has ${count} ${count === 1 ? 'page' : 'pages'}.` };
      }
    }
    if (b < a) return { groups: [], error: `“${part}” goes backwards. Write ranges from the lower page to the higher page.` };
    const g: number[] = [];
    for (let i = a; i <= b; i++) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) return { groups: [], error: 'Enter the pages, for example 1-3, 5, 8-.' };
  return { groups, error: null };
}

/** Parse ranges into a sorted set of page indices. */
export function parseRanges(input: string, count: number): RangeResult {
  const r = parseRangeGroups(input, count);
  if (r.error) return { indices: [], error: r.error };
  const set = new Set<number>();
  for (const g of r.groups) for (const i of g) set.add(i);
  return { indices: [...set].sort((a, b) => a - b), error: null };
}

/** "1-3, 5" for indices (empty string when none). */
export function formatRanges(indices: number[]): string {
  return formatPageRanges(indices);
}

/** Split groups for "every N pages". */
export function everyN(count: number, n: number): number[][] {
  const out: number[][] = [];
  const step = Math.max(1, Math.floor(n));
  for (let s = 0; s < count; s += step) out.push(Array.from({ length: Math.min(step, count - s) }, (_, k) => s + k));
  return out;
}

/** Groups starting at each index of `starts` (0 is always a start). */
export function groupsFromStarts(count: number, starts: number[]): number[][] {
  const s = [...new Set([0, ...starts.filter((i) => i > 0 && i < count)])].sort((a, b) => a - b);
  return s.map((start, k) => {
    const end = k + 1 < s.length ? s[k + 1] : count;
    return Array.from({ length: end - start }, (_, j) => start + j);
  });
}

/** Contiguous groups written as "1-3, 4-6, 7-" (the last open-ended). */
export function formatGroups(groups: number[][], count: number): string {
  return groups
    .map((g) => {
      if (!g.length) return '';
      const a = g[0] + 1;
      const b = g[g.length - 1] + 1;
      const contiguous = g.every((v, i) => i === 0 || v === g[i - 1] + 1);
      if (!contiguous) return formatPageRanges(g);
      if (a === b) return String(a);
      return b === count && g.length > 1 ? `${a}-` : `${a}-${b}`;
    })
    .filter(Boolean)
    .join(', ');
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
