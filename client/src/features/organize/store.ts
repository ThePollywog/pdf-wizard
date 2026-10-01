/**
 * Organize feature state (not part of the document undo history): page selection per document
 * (by page id, so it survives reorders), grid thumbnail size, the action a lightweight task
 * focuses, the page clipboard and the split / extract options.
 */
import { create } from 'zustand';
import type { DocId, DocState, PageId } from '@/core/types';
import { getDoc } from '@/core/store';

export type FocusAction = 'insert' | 'rotate' | 'delete' | 'reorder' | 'reverse' | 'labels';

export interface PageSelection {
  ids: PageId[];
  /** Start of shift-click ranges. */
  anchor: PageId | null;
  /** Keyboard focus (focus ring). */
  focus: PageId | null;
}

export interface PageClip {
  docId: DocId;
  ids: PageId[];
  mode: 'cut' | 'copy';
}

export type SplitMethod = 'pages' | 'size' | 'bookmarks' | 'ranges';
export type SplitOutput = 'zip' | 'library' | 'tabs';

export interface SplitSettings {
  method: SplitMethod;
  pages: number;
  sizeMb: number;
  ranges: string;
  output: SplitOutput;
}

export type ExtractOutput = 'open' | 'download';
export interface ExtractSettings {
  deleteAfter: boolean;
  separate: boolean;
  output: ExtractOutput;
}

export interface RevealRequest {
  docId: DocId;
  id: PageId;
  nonce: number;
}

interface OrganizeState {
  selection: Record<DocId, PageSelection>;
  /** Scroll the grid to this page (after inserts, keyboard selection from the panel…). */
  reveal: RevealRequest | null;
  thumbSize: number;
  focusAction: FocusAction | null;
  hintDismissed: boolean;
  clip: PageClip | null;
  split: SplitSettings;
  extract: ExtractSettings;
}

const SIZE_KEY = 'pdfwizard.organize.thumbSize';
export const MIN_THUMB = 72;
export const MAX_THUMB = 320;
export const DEFAULT_THUMB = 150;

function loadSize(): number {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    return Number.isFinite(v) && v >= MIN_THUMB && v <= MAX_THUMB ? v : DEFAULT_THUMB;
  } catch {
    return DEFAULT_THUMB;
  }
}

const EMPTY: PageSelection = { ids: [], anchor: null, focus: null };

export const useOrganize = create<OrganizeState>(() => ({
  selection: {},
  reveal: null,
  thumbSize: loadSize(),
  focusAction: null,
  hintDismissed: false,
  clip: null,
  split: { method: 'pages', pages: 2, sizeMb: 1, ranges: '', output: 'zip' },
  extract: { deleteAfter: false, separate: false, output: 'open' },
}));

const set = useOrganize.setState;
const get = useOrganize.getState;

export const organize = {
  selection(docId: DocId): PageSelection {
    return get().selection[docId] ?? EMPTY;
  },
  setSelection(docId: DocId, patch: Partial<PageSelection>) {
    set((s) => ({ selection: { ...s.selection, [docId]: { ...(s.selection[docId] ?? EMPTY), ...patch } } }));
  },
  /** Select exactly these page indices of the document. */
  selectIndices(docId: DocId, indices: number[], focusIndex?: number) {
    const d = getDoc(docId);
    if (!d) return;
    const ids = [...new Set(indices)].filter((i) => i >= 0 && i < d.pages.length).sort((a, b) => a - b).map((i) => d.pages[i].id);
    const f = focusIndex !== undefined ? d.pages[focusIndex]?.id : ids[0];
    organize.setSelection(docId, { ids, anchor: ids[0] ?? null, focus: f ?? organize.selection(docId).focus });
  },
  /** Ask the grid to scroll a page into view. */
  reveal(docId: DocId, id: PageId) {
    set((s) => ({ reveal: { docId, id, nonce: (s.reveal?.nonce ?? 0) + 1 } }));
  },
  clear(docId: DocId) {
    organize.setSelection(docId, { ids: [], anchor: null });
  },
  forget(docId: DocId) {
    set((s) => {
      if (!s.selection[docId]) return s;
      const next = { ...s.selection };
      delete next[docId];
      return { selection: next };
    });
  },
  setThumbSize(size: number) {
    const v = Math.round(Math.min(MAX_THUMB, Math.max(MIN_THUMB, size)));
    set({ thumbSize: v });
    try {
      localStorage.setItem(SIZE_KEY, String(v));
    } catch {
      /* private mode */
    }
  },
  setFocusAction(a: FocusAction | null) {
    set({ focusAction: a, hintDismissed: false });
  },
  dismissHint() {
    set({ hintDismissed: true });
  },
  setClip(clip: PageClip | null) {
    set({ clip });
  },
  setSplit(patch: Partial<SplitSettings>) {
    set((s) => ({ split: { ...s.split, ...patch } }));
  },
  setExtract(patch: Partial<ExtractSettings>) {
    set((s) => ({ extract: { ...s.extract, ...patch } }));
  },
};

/** Sorted indices of the selected pages that still exist. */
export function selectedIndices(doc: DocState | undefined, sel: PageSelection | undefined): number[] {
  if (!doc || !sel || !sel.ids.length) return [];
  const idx = new Map(doc.pages.map((p, i) => [p.id, i]));
  const out: number[] = [];
  for (const id of sel.ids) {
    const i = idx.get(id);
    if (i !== undefined) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

export function useSelection(docId: DocId | null | undefined): PageSelection {
  return useOrganize((s) => (docId ? (s.selection[docId] ?? EMPTY) : EMPTY));
}

export function currentSelectedIndices(docId: DocId): number[] {
  return selectedIndices(getDoc(docId), organize.selection(docId));
}
