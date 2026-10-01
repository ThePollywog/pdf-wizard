/**
 * Bookmarks panel UI state (per document, not in the undo history): expansion overrides,
 * selection and inline rename. Edits to the outline itself go through actions.setOutline.
 */
import { create } from 'zustand';
import type { DocId } from '@/core/types';
import { actions, getDoc, useApp } from '@/core/store';
import { allItems, withExpansion, type BmItem } from './model';
import { setExpansionProvider } from './dest';
import { readLocal, writeLocal } from '../util';

interface PerDoc {
  expanded: Record<string, boolean>;
  selected: string | null;
  renaming: string | null;
}

interface BmUiState {
  docs: Record<DocId, PerDoc>;
  wrap: boolean;
}

const EMPTY: PerDoc = { expanded: {}, selected: null, renaming: null };
const WRAP_KEY = 'navigation.bookmarks.wrap';

export const useBmUi = create<BmUiState>(() => ({ docs: {}, wrap: readLocal(WRAP_KEY, '0') === '1' }));

export const bmUi = {
  of(docId: DocId): PerDoc {
    return useBmUi.getState().docs[docId] ?? EMPTY;
  },
  patch(docId: DocId, patch: Partial<PerDoc>) {
    useBmUi.setState((s) => ({ docs: { ...s.docs, [docId]: { ...(s.docs[docId] ?? EMPTY), ...patch } } }));
  },
  select(docId: DocId, id: string | null) {
    if (bmUi.of(docId).selected !== id) bmUi.patch(docId, { selected: id });
  },
  setExpanded(docId: DocId, id: string, open: boolean) {
    bmUi.patch(docId, { expanded: { ...bmUi.of(docId).expanded, [id]: open } });
  },
  setAll(docId: DocId, open: boolean) {
    const items = (getDoc(docId)?.outline ?? []) as BmItem[];
    const expanded: Record<string, boolean> = {};
    for (const it of allItems(items)) if (it.children?.length) expanded[it.id] = open;
    bmUi.patch(docId, { expanded });
  },
  setWrap(wrap: boolean) {
    writeLocal(WRAP_KEY, wrap ? '1' : '0');
    useBmUi.setState({ wrap });
  },
  forget(docId: DocId) {
    useBmUi.setState((s) => {
      const docs = { ...s.docs };
      delete docs[docId];
      return { docs };
    });
  },
};

export const isExpandedIn = (per: PerDoc) => (it: BmItem) => per.expanded[it.id] ?? !!it.open;

/** Commit an outline edit (bakes the panel's expansion state into the items' `open`). */
export function commitOutline(docId: DocId, next: BmItem[], label: string) {
  const per = bmUi.of(docId);
  const baked = withExpansion(next, per.expanded);
  actions.setOutline(docId, baked.length ? baked : [], label);
  separateUndoStep(docId);
  bmUi.patch(docId, { expanded: {} });
}

/**
 * setOutline coalesces edits made within ~1.5 s into one undo step (meant for continuous edits).
 * Bookmark commands are discrete (delete, move, rename…), so each one gets its own step: clear the
 * coalesce key of the checkpoint just pushed so the next edit can't merge into it.
 */
function separateUndoStep(docId: DocId) {
  useApp.setState((s) => {
    const d = s.docs[docId];
    const past = d?.history.past;
    const last = past?.[past.length - 1];
    if (!d || !last || last.coalesce !== 'outline') return s;
    const history = { ...d.history, past: past.slice(0, -1).concat({ ...last, coalesce: undefined }) };
    return { docs: { ...s.docs, [docId]: { ...d, history } } };
  });
}

setExpansionProvider((docId) => useBmUi.getState().docs[docId]?.expanded);
