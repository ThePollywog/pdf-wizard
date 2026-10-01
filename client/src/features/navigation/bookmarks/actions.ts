/** Bookmark editing operations shared by the panel, its menus and the global commands. */
import type { DocId } from '@/core/types';
import { actions, getDoc, useApp } from '@/core/store';
import { confirmDialog } from '@/core/ui';
import { controllerFor } from '@/core/viewer/controller';
import { useViewerUi } from '@/core/viewer/viewerStore';
import { canEdit, ellipsize } from '../util';
import { countDescendants, findItem, insertItem, newItem, parentOf, removeItem, updateItem, visibleRows, type BmItem } from './model';
import { currentViewDest } from './dest';
import { bmUi, commitOutline, isExpandedIn } from './store';

export const outlineOf = (docId: DocId): BmItem[] => (getDoc(docId)?.outline ?? []) as BmItem[];

function ensureEditable(docId: DocId): boolean {
  if (canEdit(docId)) return true;
  actions.toast('This document is open read-only, so its bookmarks can’t be changed.', { kind: 'warning' });
  return false;
}

/** Text selected in the document (for the title of a new bookmark). */
export function selectedDocText(docId: DocId): string | null {
  const pop = useViewerUi.getState().textPopup;
  let t = pop && pop.docId === docId ? pop.selections.map((s) => s.text).join(' ') : '';
  if (!t) {
    const sel = window.getSelection();
    const root = controllerFor(docId)?.root;
    if (sel && !sel.isCollapsed && sel.anchorNode && root?.contains(sel.anchorNode)) t = sel.toString();
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t ? ellipsize(t, 128) : null;
}

export function newBookmark(docId: DocId, opts: { title?: string; rename?: boolean } = {}): string | null {
  if (!getDoc(docId) || !ensureEditable(docId)) return null;
  const dest = currentViewDest(docId);
  const title = opts.title ?? selectedDocText(docId) ?? 'Untitled';
  const item = newItem({ title, ...(dest ?? {}) });
  const items = outlineOf(docId);
  const sel = bmUi.of(docId).selected;
  const target = sel && findItem(items, sel) ? sel : null;
  commitOutline(docId, insertItem(items, item, target, 'after'), 'New bookmark');
  bmUi.patch(docId, { selected: item.id, renaming: opts.rename === false ? null : item.id });
  if (useApp.getState().rightPanelId !== 'bookmarks') actions.setRightPanel('bookmarks');
  return item.id;
}

export function renameBookmark(docId: DocId, id: string, title: string) {
  const items = outlineOf(docId);
  const it = findItem(items, id);
  const t = title.replace(/[\r\n]+/g, ' ').trim();
  if (!it || !t || t === it.title || !ensureEditable(docId)) return;
  commitOutline(docId, updateItem(items, id, (x) => ({ ...x, title: t })), 'Rename bookmark');
}

/** Loose equality for bookmark fields: missing, null and false mean the same; objects compare by value. */
function sameField(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null || v === false ? null : v);
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x && y && typeof x === 'object' && typeof y === 'object') return JSON.stringify(x) === JSON.stringify(y);
  return false;
}

/** True when applying `patch` would not change `item` (so nothing needs committing). */
export function isNoopPatch(item: BmItem, patch: Partial<BmItem>): boolean {
  return (Object.keys(patch) as (keyof BmItem)[]).every((k) => sameField(item[k], patch[k]));
}

export function patchBookmark(docId: DocId, id: string, patch: Partial<BmItem>, label = 'Edit bookmark') {
  const items = outlineOf(docId);
  const it = findItem(items, id);
  if (!it || isNoopPatch(it, patch)) return;
  if (!ensureEditable(docId)) return;
  commitOutline(docId, updateItem(items, id, (x) => ({ ...x, ...patch })), label);
}

export async function deleteBookmark(docId: DocId, id: string) {
  const items = outlineOf(docId);
  const it = findItem(items, id);
  if (!it || !ensureEditable(docId)) return;
  const n = countDescendants(it);
  if (n > 0) {
    const ok = await confirmDialog({
      title: 'Delete bookmark',
      message: `Are you sure you want to delete “${ellipsize(it.title || 'Untitled', 60)}” and ${n === 1 ? 'its child bookmark' : `its ${n} child bookmarks`}?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
  }
  // Pick the row to select afterwards: next visible, else previous, else parent.
  const per = bmUi.of(docId);
  const rows = visibleRows(items, isExpandedIn(per));
  const at = rows.findIndex((r) => r.item.id === id);
  let nextSel: string | null = null;
  for (let i = at + 1; i < rows.length; i++) {
    if (!(rows[i].item.id === id || findItem([it], rows[i].item.id))) {
      nextSel = rows[i].item.id;
      break;
    }
  }
  if (!nextSel && at > 0) nextSel = rows[at - 1].item.id;
  if (!nextSel) nextSel = parentOf(items, id)?.id ?? null;
  commitOutline(docId, removeItem(items, id), 'Delete bookmark');
  bmUi.patch(docId, { selected: nextSel, renaming: null });
}

export async function setDestinationToView(docId: DocId, id: string, ask = true) {
  const items = outlineOf(docId);
  if (!findItem(items, id) || !ensureEditable(docId)) return;
  if (ask) {
    const ok = await confirmDialog({
      title: 'Set destination',
      message: 'Are you sure you want to set the destination of the selected bookmark to the current location?',
      confirmLabel: 'Yes',
    });
    if (!ok) return;
  }
  const dest = currentViewDest(docId);
  if (!dest) return;
  commitOutline(docId, updateItem(items, id, (x) => ({ ...x, ...dest, url: null })), 'Set bookmark destination');
  actions.toast('Bookmark destination updated.', { kind: 'success' });
}
