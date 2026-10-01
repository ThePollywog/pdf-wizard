/**
 * Page labels (/PageLabels number tree, PDF 32000 §12.4.2). Labels are handled per page as
 * { style, prefix, value } so a section can be applied to any page range; they are compressed back
 * into the minimal set of label ranges when written.
 */
import { PDFDict, PDFHexString, PDFNumber, type PDFObject } from '@cantoo/pdf-lib';
import type { DocId, LibDocument } from '@/core/types';
import * as engine from '@/core/engine';
import { N, lookupArray, lookupDict, nameOf, numberOf, textOf } from '@/core/engine/lib';

/** '' = no number (prefix only). */
export type LabelStyle = 'D' | 'r' | 'R' | 'a' | 'A' | '';

export interface PageLabelSpec {
  style: LabelStyle;
  prefix: string;
  /** Numeric value of the page within its range (1-based). */
  value: number;
}

export const LABEL_STYLES: { value: LabelStyle; label: string }[] = [
  { value: 'D', label: '1, 2, 3, …' },
  { value: 'r', label: 'i, ii, iii, …' },
  { value: 'R', label: 'I, II, III, …' },
  { value: 'a', label: 'a, b, c, …' },
  { value: 'A', label: 'A, B, C, …' },
  { value: '', label: 'None' },
];

const STYLES = new Set(['D', 'r', 'R', 'a', 'A']);

function toRoman(n: number, lower: boolean): string {
  const map: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let s = '';
  let v = n;
  for (const [k, r] of map) while (v >= k) { s += r; v -= k; }
  return lower ? s.toLowerCase() : s;
}

export function formatNumber(style: LabelStyle, n: number): string {
  switch (style) {
    case 'D': return String(n);
    case 'R': return toRoman(n, false);
    case 'r': return toRoman(n, true);
    case 'A':
    case 'a': {
      const ch = String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
      return style === 'a' ? ch.toLowerCase() : ch;
    }
    default: return '';
  }
}

export function formatSpec(s: PageLabelSpec): string {
  return s.prefix + formatNumber(s.style, s.value);
}

/** "i, ii, iii" style preview of the first labels of a section. */
export function samplePreview(style: LabelStyle, prefix: string, start: number, count = 3): string {
  const out: string[] = [];
  for (let k = 0; k < count; k++) out.push(prefix + formatNumber(style, start + k));
  const text = out.filter((s) => s !== '').join(', ');
  return text ? `${text}, …` : '(no label)';
}

// ── reading ──────────────────────────────────────────────────────────────────

function readTree(lib: LibDocument, node: PDFDict | undefined, out: [number, PDFObject][], depth = 0) {
  if (!node || depth > 32) return;
  const ctx = lib.context;
  const nums = lookupArray(ctx, node.get(N('Nums')));
  if (nums) {
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const k = numberOf(ctx, nums.get(i));
      if (k !== undefined && k >= 0) out.push([Math.trunc(k), nums.get(i + 1)]);
    }
  }
  const kids = lookupArray(ctx, node.get(N('Kids')));
  if (kids) for (let i = 0; i < kids.size(); i++) readTree(lib, lookupDict(ctx, kids.get(i)), out, depth + 1);
}

export function hasLabels(lib: LibDocument): boolean {
  return !!lookupDict(lib.context, lib.catalog.get(N('PageLabels')));
}

/** Label spec of every page (defaults to 1, 2, 3… when the document has no labels). */
export function readLabelSpecs(lib: LibDocument): PageLabelSpec[] {
  const count = lib.getPageCount();
  const ctx = lib.context;
  const entries: [number, PDFObject][] = [];
  readTree(lib, lookupDict(ctx, lib.catalog.get(N('PageLabels'))), entries);
  entries.sort((a, b) => a[0] - b[0]);
  const ranges = entries.map(([start, v]) => {
    const d = lookupDict(ctx, v);
    const s = d ? nameOf(ctx, d.get(N('S'))) : undefined;
    const st = d ? numberOf(ctx, d.get(N('St'))) : undefined;
    return {
      start,
      style: (s && STYLES.has(s) ? s : '') as LabelStyle,
      prefix: (d ? textOf(ctx, d.get(N('P'))) : undefined) ?? '',
      st: st !== undefined && st >= 1 ? Math.trunc(st) : 1,
    };
  });
  const out: PageLabelSpec[] = [];
  let ri = -1;
  for (let i = 0; i < count; i++) {
    while (ri + 1 < ranges.length && ranges[ri + 1].start <= i) ri++;
    if (ri < 0) out.push({ style: 'D', prefix: '', value: i + 1 });
    else {
      const r = ranges[ri];
      out.push({ style: r.style, prefix: r.prefix, value: r.st + (i - r.start) });
    }
  }
  return out;
}

// ── editing ──────────────────────────────────────────────────────────────────

export type LabelChange =
  | { kind: 'new'; style: LabelStyle; prefix: string; start: number }
  | { kind: 'extend' };

/** Apply a section change to pages from..to (inclusive, 0-based). */
export function applyLabelChange(specs: PageLabelSpec[], from: number, to: number, change: LabelChange): PageLabelSpec[] {
  const out = specs.map((s) => ({ ...s }));
  if (change.kind === 'new') {
    for (let i = from, k = 0; i <= to; i++, k++) out[i] = { style: change.style, prefix: change.prefix, value: Math.max(1, change.start) + k };
  } else {
    const prev = from > 0 ? out[from - 1] : { style: 'D' as LabelStyle, prefix: '', value: 0 };
    for (let i = from, k = 1; i <= to; i++, k++) out[i] = { style: prev.style, prefix: prev.prefix, value: prev.value + k };
  }
  return out;
}

interface Range { start: number; style: LabelStyle; prefix: string; st: number }

/** Minimal label ranges for the per-page specs. */
export function compressSpecs(specs: PageLabelSpec[]): Range[] {
  const ranges: Range[] = [];
  specs.forEach((s, i) => {
    const prev = i > 0 ? specs[i - 1] : null;
    const cont =
      prev && prev.style === s.style && prev.prefix === s.prefix && (s.style === '' || s.value === prev.value + 1);
    if (!cont) ranges.push({ start: i, style: s.style, prefix: s.prefix, st: s.value });
  });
  return ranges;
}

export function isDefault(specs: PageLabelSpec[]): boolean {
  return specs.every((s, i) => s.style === 'D' && s.prefix === '' && s.value === i + 1);
}

/** Write /PageLabels for `specs` (removed when they are the default 1, 2, 3…). */
export function writeLabelSpecs(lib: LibDocument, specs: PageLabelSpec[]) {
  if (!specs.length || isDefault(specs)) {
    lib.catalog.delete(N('PageLabels'));
    return;
  }
  const ctx = lib.context;
  const nums: PDFObject[] = [];
  for (const r of compressSpecs(specs)) {
    const d: Record<string, PDFObject> = {};
    if (r.style) d.S = N(r.style);
    if (r.prefix) d.P = PDFHexString.fromText(r.prefix);
    if (r.style && r.st !== 1) d.St = PDFNumber.of(r.st);
    nums.push(PDFNumber.of(r.start), ctx.obj(d));
  }
  lib.catalog.set(N('PageLabels'), ctx.obj({ Nums: nums }));
}

/** Apply a label change to the open document (one undo step). */
export async function applyLabels(docId: DocId, from: number, to: number, change: LabelChange): Promise<void> {
  await engine.withLib(docId, 'Number pages', (lib) => {
    const specs = readLabelSpecs(lib);
    if (from < 0 || to >= specs.length || from > to) throw new Error('The page range is invalid.');
    writeLabelSpecs(lib, applyLabelChange(specs, from, to, change));
  });
}

/** Remove every page label from the open document. */
export async function removeAllLabels(docId: DocId): Promise<void> {
  await engine.withLib(docId, 'Remove page labels', (lib) => {
    lib.catalog.delete(N('PageLabels'));
  });
}
