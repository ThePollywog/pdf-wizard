/**
 * The split plan of the active document: the page groups the current Split settings produce
 * (every N pages, by estimated file size, by top-level bookmark, or custom ranges) plus the
 * decoration the preview grid draws.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DocId, OutlineItem, PageInfo } from '@/core/types';
import { useDoc } from '@/core/store';
import { useOrganize, type SplitSettings } from '../store';
import { bookmarkStarts, groupsBySize } from '../splitter';
import { everyN, formatGroups, groupsFromStarts, parseRangeGroups } from '../ranges';
import { errMsg, readOnlyReason, stem } from '../util';

export interface SplitPlan {
  groups: number[][];
  /** Why no (useful) split can be made. */
  error: string | null;
  /** Size-based groups are being estimated. */
  computing: boolean;
  /** Output file names, one per group. */
  names: string[];
  /** Bookmark title of each group (bookmark method only). */
  titles: (string | null)[];
  /** Part index of every page (-1 when a page isn't in any part). */
  partOf: number[];
  /** First page of every part except the first one (split points shown in the grid). */
  starts: Set<number>;
  /** Groups are a partition of all pages in order (split points can be toggled). */
  contiguous: boolean;
  /** Pages that aren't in any part (custom ranges). */
  skipped: number;
}

export const MB = 1024 * 1024;

export function partNames(docName: string, n: number): string[] {
  const s = stem(docName);
  return Array.from({ length: n }, (_, k) => `${s}_Part${k + 1}.pdf`);
}

function isPartition(groups: number[][], count: number): boolean {
  let next = 0;
  for (const g of groups) for (const i of g) if (i !== next++) return false;
  return next === count;
}

/** Custom ranges with a split point toggled at `gap` (derived from the current groups). */
export function toggledRanges(groups: number[][], count: number, contiguous: boolean, gap: number): string {
  const starts = new Set(contiguous ? groups.slice(1).map((g) => g[0]) : groups.map((g) => g[0]).filter((i) => i > 0));
  if (starts.has(gap)) starts.delete(gap);
  else starts.add(gap);
  return formatGroups(groupsFromStarts(count, [...starts]), count);
}

export function useSplitPlan(docId: DocId | null): SplitPlan {
  const settings = useOrganize((s) => s.split);
  const count = useDoc(docId, (d) => d?.pages.length ?? 0);
  const version = useDoc(docId, (d) => d?.version ?? 0);
  const name = useDoc(docId, (d) => d?.name ?? '');
  const outline = useDoc(docId, (d) => d?.outline ?? null);
  const pages = useDoc(docId, (d) => d?.pages);

  const [sized, setSized] = useState<{ key: string; groups: number[][] | null; error: string | null } | null>(null);
  const sizeKey = `${docId}:${version}:${settings.sizeMb}`;
  const wantSize = settings.method === 'size' && !!docId && count > 0;

  useEffect(() => {
    if (!wantSize || !docId) return;
    if (readOnlyReason(docId)) return;
    let live = true;
    const t = setTimeout(() => {
      groupsBySize(docId, Math.max(0.05, settings.sizeMb) * MB)
        .then((groups) => live && setSized({ key: sizeKey, groups, error: null }))
        .catch((e) => live && setSized({ key: sizeKey, groups: null, error: errMsg(e) }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [wantSize, docId, sizeKey, settings.sizeMb]);

  return useMemo(() => {
    const base = compute(settings, count, pages, outline, wantSize ? (sized?.key === sizeKey ? sized : null) : null);
    const ro = readOnlyReason(docId);
    const error = ro ? `This document can't be split because ${ro}.` : base.error;
    const partOf = new Array<number>(count).fill(-1);
    base.groups.forEach((g, k) => g.forEach((i) => partOf[i] === -1 && (partOf[i] = k)));
    const contiguous = isPartition(base.groups, count);
    const starts = new Set(contiguous ? base.groups.slice(1).map((g) => g[0]) : base.groups.map((g) => g[0]).filter((i) => i > 0));
    return {
      ...base,
      error,
      names: partNames(name, base.groups.length),
      partOf,
      starts,
      contiguous,
      skipped: partOf.filter((p) => p < 0).length,
    };
  }, [settings, count, pages, outline, sized, sizeKey, wantSize, name, docId]);
}

function compute(
  s: SplitSettings,
  count: number,
  pages: PageInfo[] | undefined,
  outline: OutlineItem[] | null,
  sized: { groups: number[][] | null; error: string | null } | null,
): Pick<SplitPlan, 'groups' | 'error' | 'computing' | 'titles'> {
  const none = { groups: [] as number[][], titles: [] as (string | null)[], computing: false };
  if (!pages || !count) return { ...none, error: 'The document has no pages.' };
  switch (s.method) {
    case 'pages': {
      const n = Math.floor(s.pages);
      if (!(n >= 1)) return { ...none, error: 'Enter how many pages each file should have.' };
      const groups = everyN(count, n);
      return { groups, titles: groups.map(() => null), computing: false, error: groups.length < 2 ? `The document has only ${count} ${count === 1 ? 'page' : 'pages'}, so splitting every ${n} ${n === 1 ? 'page' : 'pages'} creates a single file.` : null };
    }
    case 'size': {
      if (!(s.sizeMb > 0)) return { ...none, error: 'Enter the maximum file size.' };
      if (!sized) return { ...none, computing: true, error: null };
      if (sized.error || !sized.groups) return { ...none, error: sized.error ?? 'The file size could not be estimated.' };
      const groups = sized.groups;
      return {
        groups,
        titles: groups.map(() => null),
        computing: false,
        error: groups.length < 2 ? `The whole document fits in ${s.sizeMb} MB, so it wouldn't be split. Choose a smaller size.` : null,
      };
    }
    case 'bookmarks': {
      const { starts, titles } = bookmarkStarts({ pages, outline });
      if (!titles.size) return { ...none, error: "This document has no top-level bookmarks that point to its pages. Add bookmarks or choose another split method." };
      const groups = groupsFromStarts(count, starts);
      return {
        groups,
        titles: groups.map((g) => titles.get(g[0]) ?? null),
        computing: false,
        error: groups.length < 2 ? 'All top-level bookmarks point to the first page, so the document would not be split.' : null,
      };
    }
    case 'ranges': {
      const r = parseRangeGroups(s.ranges, count);
      if (r.error) return { ...none, error: r.error };
      return { groups: r.groups, titles: r.groups.map(() => null), computing: false, error: null };
    }
  }
}
