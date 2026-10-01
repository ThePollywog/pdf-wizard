/**
 * Organize actions in the context menu of the (core) Thumbnails panel: Replace, Extract and
 * Page labels for the right-clicked page, or for the panel's whole selection when the
 * right-clicked page is part of it.
 */
import { FileOutput, LayoutGrid, ListOrdered, Replace } from 'lucide-react';
import type { DocId } from '@/core/types';
import { registerContextMenu } from '@/core/registry';
import { actions } from '@/core/store';
import type { MenuItem } from '@/core/types';
import * as engine from '@/core/engine';
import * as ops from './ops';
import { organize } from './store';
import { THUMBNAIL_MENU_ID } from './menuIds';
import { TASK_ORGANIZE } from './tasks';

/** The thumbnails panel keeps its selection in component state; read it from the DOM. */
function panelTargets(pageIndex: number): number[] {
  const selected = Array.from(document.querySelectorAll<HTMLElement>('.thumbnails-item.is-selected[data-page-index]'))
    .map((el) => Number(el.dataset.pageIndex))
    .filter((n) => Number.isInteger(n));
  return selected.includes(pageIndex) ? [...new Set(selected)].sort((a, b) => a - b) : [pageIndex];
}

function items(docId: DocId, pageIndex: number): MenuItem[] {
  const t = panelTargets(pageIndex);
  const ro = engine.isReadOnly(docId);
  const pages = t.length > 1 ? `${t.length} pages` : 'page';
  return [
    { id: 'organize-thumb-replace', label: t.length > 1 ? `Replace ${pages}…` : 'Replace page…', icon: Replace, disabled: ro, run: () => ops.replace(docId, t) },
    { id: 'organize-thumb-extract', label: t.length > 1 ? `Extract ${pages} to a new file…` : 'Extract to a new file…', icon: FileOutput, disabled: ro, run: () => ops.extract(docId, t) },
    { id: 'organize-thumb-labels', label: 'Page labels…', icon: ListOrdered, disabled: ro, run: () => ops.pageLabels(docId, t) },
    {
      id: 'organize-thumb-organize',
      label: 'Organize pages',
      icon: LayoutGrid,
      run: () => {
        organize.selectIndices(docId, t);
        actions.openTask(TASK_ORGANIZE);
      },
    },
  ];
}

export function registerThumbnailMenu() {
  registerContextMenu({
    id: THUMBNAIL_MENU_ID,
    target: 'thumbnail',
    order: 50,
    items: ({ docId, pageIndex }) => (pageIndex === undefined ? [] : items(docId, pageIndex)),
  });
}
