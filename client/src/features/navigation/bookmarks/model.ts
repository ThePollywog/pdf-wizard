/**
 * Bookmark (outline) tree operations. All functions are pure: they return new arrays and never
 * mutate the input (doc.outline is part of the undo history).
 *
 * Items may carry an extra `navDest` (see dest.ts) describing the destination view (fit mode,
 * zoom, left). It lives on the item object so it follows edits and undo/redo.
 */
import type { OutlineItem } from '@/core/types';
import { uid } from '@/core/util';

export type DestMode = 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitR' | 'FitB' | 'FitBH' | 'FitBV';

/** Destination parameters besides the page and `top` (which live on OutlineItem itself). */
export interface NavDest {
  mode: DestMode;
  left?: number | null;
  /** XYZ zoom factor (1 = 100%); null / 0 = inherit. */
  zoom?: number | null;
  /** FitR only. */
  bottom?: number | null;
  right?: number | null;
}

export type BmItem = OutlineItem & { navDest?: NavDest | null };

export interface Row {
  item: BmItem;
  depth: number;
  parentId: string | null;
  /** Index among siblings. */
  index: number;
  hasChildren: boolean;
  expanded: boolean;
}

export type DropZone = 'before' | 'after' | 'inside';

export function newItem(fields: Partial<BmItem> = {}): BmItem {
  return { id: uid('bm'), title: 'Untitled', pageId: null, top: null, children: [], open: false, ...fields };
}

/** Visible rows (children of collapsed items are skipped). */
export function visibleRows(items: BmItem[], isExpanded: (it: BmItem) => boolean): Row[] {
  const out: Row[] = [];
  const walk = (list: BmItem[], depth: number, parentId: string | null) => {
    list.forEach((item, index) => {
      const kids = (item.children ?? []) as BmItem[];
      const expanded = kids.length > 0 && isExpanded(item);
      out.push({ item, depth, parentId, index, hasChildren: kids.length > 0, expanded });
      if (expanded) walk(kids, depth + 1, item.id);
    });
  };
  walk(items, 0, null);
  return out;
}

/** Depth-first list of every item. */
export function allItems(items: BmItem[]): BmItem[] {
  const out: BmItem[] = [];
  const walk = (list: BmItem[]) => {
    for (const it of list) {
      out.push(it);
      if (it.children?.length) walk(it.children as BmItem[]);
    }
  };
  walk(items);
  return out;
}

export function findItem(items: BmItem[], id: string): BmItem | null {
  for (const it of items) {
    if (it.id === id) return it;
    const r = it.children?.length ? findItem(it.children as BmItem[], id) : null;
    if (r) return r;
  }
  return null;
}

/** Chain of ancestors (outermost first) of `id`, or null when not found. */
export function ancestorsOf(items: BmItem[], id: string): BmItem[] | null {
  for (const it of items) {
    if (it.id === id) return [];
    if (it.children?.length) {
      const r = ancestorsOf(it.children as BmItem[], id);
      if (r) return [it, ...r];
    }
  }
  return null;
}

export function parentOf(items: BmItem[], id: string): BmItem | null {
  const a = ancestorsOf(items, id);
  return a && a.length ? a[a.length - 1] : null;
}

export function contains(item: BmItem, id: string): boolean {
  return item.id === id || (item.children ?? []).some((c) => contains(c as BmItem, id));
}

export function countDescendants(item: BmItem): number {
  let n = 0;
  for (const c of item.children ?? []) n += 1 + countDescendants(c as BmItem);
  return n;
}

export function updateItem(items: BmItem[], id: string, fn: (it: BmItem) => BmItem): BmItem[] {
  let changed = false;
  const walk = (list: BmItem[]): BmItem[] => {
    let out: BmItem[] | null = null;
    list.forEach((it, i) => {
      let next = it;
      if (it.id === id) next = fn(it);
      else if (it.children?.length) {
        const kids = walk(it.children as BmItem[]);
        if (kids !== it.children) next = { ...it, children: kids };
      }
      if (next !== it) {
        changed = true;
        if (!out) out = list.slice();
        out[i] = next;
      }
    });
    return out ?? list;
  };
  const r = walk(items);
  return changed ? r : items;
}

export function removeItem(items: BmItem[], id: string): BmItem[] {
  const walk = (list: BmItem[]): BmItem[] => {
    const idx = list.findIndex((it) => it.id === id);
    if (idx >= 0) return [...list.slice(0, idx), ...list.slice(idx + 1)];
    let out: BmItem[] | null = null;
    list.forEach((it, i) => {
      if (!it.children?.length) return;
      const kids = walk(it.children as BmItem[]);
      if (kids !== it.children) {
        if (!out) out = list.slice();
        out[i] = { ...it, children: kids };
      }
    });
    return out ?? list;
  };
  return walk(items);
}

/** Insert `item` relative to `targetId` (or at the end of the top level when targetId is null). */
export function insertItem(items: BmItem[], item: BmItem, targetId: string | null, zone: DropZone): BmItem[] {
  if (!targetId) return [...items, item];
  if (zone === 'inside') {
    return updateItem(items, targetId, (t) => ({ ...t, open: true, children: [...((t.children ?? []) as BmItem[]), item] }));
  }
  const walk = (list: BmItem[]): BmItem[] | null => {
    const idx = list.findIndex((it) => it.id === targetId);
    if (idx >= 0) {
      const at = zone === 'before' ? idx : idx + 1;
      return [...list.slice(0, at), item, ...list.slice(at)];
    }
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it.children?.length) continue;
      const kids = walk(it.children as BmItem[]);
      if (kids) {
        const out = list.slice();
        out[i] = { ...it, children: kids };
        return out;
      }
    }
    return null;
  };
  return walk(items) ?? [...items, item];
}

/** Move `id` relative to `targetId`. Returns null when the move is impossible / a no-op. */
export function moveItem(items: BmItem[], id: string, targetId: string, zone: DropZone): BmItem[] | null {
  if (id === targetId) return null;
  const item = findItem(items, id);
  if (!item || contains(item, targetId)) return null;
  const without = removeItem(items, id);
  const next = insertItem(without, item, targetId, zone);
  return sameShape(items, next) ? null : next;
}

function sameShape(a: BmItem[], b: BmItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id && sameShape((x.children ?? []) as BmItem[], (b[i].children ?? []) as BmItem[]));
}

/** Apply per-item expansion overrides (UI state) to the stored `open` flags. */
export function withExpansion(items: BmItem[], overrides: Record<string, boolean> | undefined): BmItem[] {
  if (!overrides || Object.keys(overrides).length === 0) return items;
  const walk = (list: BmItem[]): BmItem[] => {
    let out: BmItem[] | null = null;
    list.forEach((it, i) => {
      let next = it;
      const o = overrides[it.id];
      if (o !== undefined && !!it.open !== o && it.children?.length) next = { ...next, open: o };
      if (it.children?.length) {
        const kids = walk(it.children as BmItem[]);
        if (kids !== it.children) next = { ...next, children: kids };
      }
      if (next !== it) {
        if (!out) out = list.slice();
        out[i] = next;
      }
    });
    return out ?? list;
  };
  return walk(items);
}

/** Deep copy with fresh ids (paste / duplicate). */
export function cloneTree(item: BmItem): BmItem {
  return { ...item, id: uid('bm'), children: (item.children ?? []).map((c) => cloneTree(c as BmItem)) };
}
