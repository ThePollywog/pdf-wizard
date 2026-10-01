/**
 * Keeps the edit UI state (open text editor, selection, drag ghosts, crop) in step with the
 * document when its pages or bytes change underneath it — pages deleted / moved / rotated from the
 * thumbnails or Organize pages, or another feature's edit finishing while the editor is open.
 *
 * - The open editor follows its page to the new index and is rebased on the new bytes, so the
 *   commit still happens (the block is found again by text and position). If its page was
 *   removed, the editor closes with a notice instead of dropping the text silently.
 * - The selection, re-selection and ghosts follow their page or disappear with it.
 * - Crop mode is cancelled on any page structure change.
 */
import { actions, useApp } from '@/core/store';
import type { DocId, PageInfo } from '@/core/types';
import { ui, type Ghost, type Target } from './state';

interface Seen {
  pages: PageInfo[];
  bytes: Uint8Array;
}

const seen = new Map<DocId, Seen>();

const samePage = (a: PageInfo, b: PageInfo) =>
  a.id === b.id && a.rotation === b.rotation && a.width === b.width && a.height === b.height && a.view.every((v, i) => v === b.view[i]);

function sameStructure(a: PageInfo[], b: PageInfo[]): boolean {
  if (a === b) return true;
  return a.length === b.length && a.every((p, i) => samePage(p, b[i]));
}

/** Old page index → new page index (null when the page is gone). */
function indexMap(prev: PageInfo[], next: PageInfo[]): (i: number) => number | null {
  const byId = new Map(next.map((p, i) => [p.id, i]));
  return (i) => {
    const p = prev[i];
    if (!p) return null;
    return byId.get(p.id) ?? null;
  };
}

function remapTarget(t: Target, to: number): Target {
  return t.pageIndex === to ? t : { ...t, pageIndex: to };
}

function onPagesChanged(docId: DocId, prev: PageInfo[], next: PageInfo[], bytes: Uint8Array): void {
  const map = indexMap(prev, next);
  const st = ui.get();

  const e = st.edit;
  if (e && e.docId === docId) {
    const to = map(e.pageIndex);
    if (to === null) {
      ui.endEdit(e.nonce);
      if (e.phase === 'editing' && e.text !== e.original.text) actions.toast('The page you were editing was removed, so the text edit was discarded.', { kind: 'warning' });
    } else if (to !== e.pageIndex || (e.phase === 'editing' && e.bytes !== bytes)) {
      ui.patchEdit(e.phase === 'editing' ? { pageIndex: to, bytes } : { pageIndex: to });
    }
  }

  const t = st.target;
  if (t && t.docId === docId) {
    const to = map(t.pageIndex);
    if (to === null) ui.setTarget(null);
    else if (to !== t.pageIndex) ui.patch({ target: remapTarget(t, to) });
  }

  const r = ui.get().reselect;
  if (r && r.docId === docId) {
    const to = map(r.pageIndex);
    ui.setReselect(to === null ? null : { ...r, pageIndex: to });
  }

  const ghosts = ui.get().ghosts;
  if (ghosts.some((g) => g.docId === docId)) {
    const out: Ghost[] = [];
    for (const g of ghosts) {
      if (g.docId !== docId) out.push(g);
      else {
        const to = map(g.pageIndex);
        if (to !== null) out.push(to === g.pageIndex ? g : { ...g, pageIndex: to });
      }
    }
    ui.patch({ ghosts: out });
  }

  const c = ui.get().crop;
  if (c && c.docId === docId) ui.setCrop(null);
}

/** Bytes changed without a page structure change: keep an open editor committable. */
function onBytesChanged(docId: DocId, bytes: Uint8Array): void {
  const e = ui.get().edit;
  if (e && e.docId === docId && e.phase === 'editing' && e.bytes !== bytes) ui.patchEdit({ bytes });
}

function sync(docs: ReturnType<typeof useApp.getState>['docs']): void {
  for (const [id, doc] of Object.entries(docs)) {
    const prev = seen.get(id);
    if (prev && prev.pages === doc.pages && prev.bytes === doc.bytes) continue;
    seen.set(id, { pages: doc.pages, bytes: doc.bytes });
    if (!prev) continue;
    if (!sameStructure(prev.pages, doc.pages)) onPagesChanged(id, prev.pages, doc.pages, doc.bytes);
    else if (prev.bytes !== doc.bytes) onBytesChanged(id, doc.bytes);
  }
  for (const id of [...seen.keys()]) if (!docs[id]) seen.delete(id);
}

let prevDocs = useApp.getState().docs;
sync(prevDocs);
useApp.subscribe((s) => {
  if (s.docs === prevDocs) return;
  prevDocs = s.docs;
  sync(s.docs);
});
