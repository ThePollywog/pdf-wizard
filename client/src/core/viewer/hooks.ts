/**
 * Small public helpers around the mounted viewer.
 */
import { useMemo } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { DocId, ObjectId } from '../types';
import { actions, getDoc, pageIndexOf, useDoc } from '../store';
import { controllerFor } from './controller';
import { makeViewport, totalRotation } from './viewport';

/** Viewport for a page at the doc's current zoom / rotation (null when the page doesn't exist). */
export function usePageViewport(docId: DocId, pageIndex: number): PageViewport | null {
  const page = useDoc(docId, (d) => d?.pages[pageIndex]);
  const zoom = useDoc(docId, (d) => d?.view.zoom ?? 1);
  const viewRotation = useDoc(docId, (d) => d?.view.rotation ?? 0);
  return useMemo(() => (page ? makeViewport(page, zoom, totalRotation(page, viewRotation)) : null), [page, zoom, viewRotation]);
}

/** DOM element (`.pdfwizard-page`) of a rendered page, or null if not mounted / virtualized away. */
export function getPageElement(docId: DocId, pageIndex: number): HTMLElement | null {
  return controllerFor(docId)?.pageElement(pageIndex) ?? null;
}

/** Scroll an object into view (centered when possible) and select it. Returns false if it doesn't exist. */
export function scrollToObject(docId: DocId, objectId: ObjectId, opts: { select?: boolean; behavior?: 'auto' | 'smooth' } = {}): boolean {
  const d = getDoc(docId);
  const o = d?.objects[objectId];
  if (!d || !o) return false;
  const idx = pageIndexOf(d, o.pageId);
  if (idx < 0) return false;
  actions.goToPage(docId, idx, { rect: o.rect, behavior: opts.behavior ?? 'smooth' });
  if (opts.select !== false) {
    if (d.editingId && d.editingId !== objectId) actions.setEditing(docId, null);
    actions.setSelection(docId, [objectId]);
  }
  return true;
}
