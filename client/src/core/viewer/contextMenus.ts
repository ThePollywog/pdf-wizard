/**
 * Context menus for objects and pages. Items = type/registry contributions + core actions.
 */
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ClipboardPaste,
  Copy,
  CopyPlus,
  FilePlus2,
  Lock,
  LockOpen,
  MessageSquare,
  Maximize,
  PencilLine,
  RotateCcw,
  RotateCw,
  Scissors,
  StretchHorizontal,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { DocId, MenuItem, ObjectId, Point } from '../types';
import { actions, getDoc } from '../store';
import { reg } from '../registry';
import { confirmDialog, showContextMenu, type MenuEntry } from '../ui';
import * as engine from '../engine';
import { copyObjects, cutObjects, duplicateObjects, hasClipboardObjects, pasteObjects } from './clipboard';
import { viewerUi } from './viewerStore';

type Pointerish = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };

const mod = 'mod';

async function guard(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[viewer] ${label} failed`, e);
    actions.toast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
  }
}

function contributions(target: 'object' | 'page', ctx: { docId: DocId; pageIndex?: number; objectIds?: ObjectId[]; point?: Point }): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const c of reg.get().contextMenus) {
    if (c.target !== target) continue;
    try {
      const items = c.items(ctx);
      if (items.length) {
        out.push(...items);
        out.push('divider');
      }
    } catch (e) {
      console.error(`[viewer] context menu contribution "${c.id}" failed`, e);
    }
  }
  return out;
}

export function deleteSelectedObjects(docId: DocId, ids: ObjectId[]) {
  const d = getDoc(docId);
  if (!d) return;
  const deletable = ids.filter((id) => d.objects[id] && !d.objects[id].locked);
  if (deletable.length === 0) {
    if (ids.length) actions.toast('Locked items can’t be deleted. Unlock them first.', { kind: 'info' });
    return;
  }
  actions.deleteObjects(docId, deletable, { label: deletable.length > 1 ? `Delete ${deletable.length} items` : 'Delete' });
}

export function setLocked(docId: DocId, ids: ObjectId[], locked: boolean) {
  const patches: Record<string, { locked: boolean }> = {};
  for (const id of ids) patches[id] = { locked };
  actions.updateObjects(docId, patches, { label: locked ? 'Lock' : 'Unlock' });
}

export function objectCoreItems(docId: DocId, ids: ObjectId[]): MenuEntry[] {
  const d = getDoc(docId);
  if (!d) return [];
  const objs = ids.map((id) => d.objects[id]).filter(Boolean);
  const allLocked = objs.length > 0 && objs.every((o) => o.locked);
  const anyUnlocked = objs.some((o) => !o.locked);
  const single = objs.length === 1 ? objs[0] : null;
  const type = single ? reg.objectType(single.kind) : undefined;
  const entries: MenuEntry[] = [];
  if (single && type?.editable && !single.locked) {
    entries.push({ id: 'viewer.edit', label: 'Edit', icon: PencilLine, shortcut: 'enter', run: () => actions.setEditing(docId, single.id) });
  }
  if (single) {
    entries.push({
      id: 'viewer.comment',
      label: single.contents ? 'Edit comment' : 'Add comment',
      icon: MessageSquare,
      run: () => viewerUi.set({ commentFor: { docId, objectId: single.id } }),
    });
  }
  entries.push('divider');
  entries.push(
    { id: 'viewer.cut', label: 'Cut', icon: Scissors, shortcut: `${mod}+x`, disabled: !anyUnlocked, run: () => void cutObjects(docId, ids) },
    { id: 'viewer.copy', label: 'Copy', icon: Copy, shortcut: `${mod}+c`, run: () => void copyObjects(docId, ids) },
    { id: 'viewer.duplicate', label: 'Duplicate', icon: CopyPlus, shortcut: `${mod}+d`, run: () => void duplicateObjects(docId, ids) },
    { id: 'viewer.delete', label: 'Delete', icon: Trash2, shortcut: 'delete', danger: true, disabled: !anyUnlocked, run: () => deleteSelectedObjects(docId, ids) },
    'divider',
    { id: 'viewer.front', label: 'Bring to front', icon: ArrowUpToLine, run: () => actions.bringToFront(docId, ids) },
    { id: 'viewer.back', label: 'Send to back', icon: ArrowDownToLine, run: () => actions.sendToBack(docId, ids) },
    allLocked
      ? { id: 'viewer.unlock', label: 'Unlock', icon: LockOpen, run: () => setLocked(docId, ids, false) }
      : { id: 'viewer.lock', label: 'Lock', icon: Lock, run: () => setLocked(docId, ids, true) },
  );
  return entries;
}

export function openObjectContextMenu(e: Pointerish, docId: DocId, ids: ObjectId[], pageIndex: number, point?: Point) {
  const d = getDoc(docId);
  if (!d || ids.length === 0) return;
  const entries: MenuEntry[] = [];
  if (ids.length === 1) {
    const o = d.objects[ids[0]];
    const t = o ? reg.objectType(o.kind) : undefined;
    if (o && t?.contextMenu) {
      try {
        const items: MenuItem[] = t.contextMenu(o, docId);
        if (items.length) entries.push(...items, 'divider');
      } catch (err) {
        console.error(`[viewer] contextMenu of "${o.kind}" failed`, err);
      }
    }
  }
  entries.push(...contributions('object', { docId, pageIndex, objectIds: ids, point }));
  entries.push(...objectCoreItems(docId, ids));
  showContextMenu(e, entries);
}

export function blankPageSizeFor(docId: DocId, pageIndex: number): { width: number; height: number } | undefined {
  const p = getDoc(docId)?.pages[pageIndex];
  if (!p) return undefined;
  const swap = p.rotation % 180 !== 0;
  return swap ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

export async function confirmDeletePages(docId: DocId, indices: number[]): Promise<void> {
  const d = getDoc(docId);
  if (!d || indices.length === 0) return;
  if (indices.length >= d.pages.length) {
    actions.toast('A document must keep at least one page.', { kind: 'warning' });
    return;
  }
  const n = indices.length;
  const ok = await confirmDialog({
    title: n === 1 ? 'Delete page?' : `Delete ${n} pages?`,
    message:
      n === 1
        ? `Page ${indices[0] + 1} will be removed from the document. You can undo this action.`
        : `${n} pages will be removed from the document. You can undo this action.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await guard('Delete pages', () => engine.deletePages(docId, [...indices].sort((a, b) => a - b)));
}

export function pageCoreItems(docId: DocId, pageIndex: number): MenuEntry[] {
  const d = getDoc(docId);
  if (!d) return [];
  const entries: MenuEntry[] = [];
  if (hasClipboardObjects()) {
    entries.push(
      {
        id: 'viewer.paste',
        label: 'Paste',
        icon: ClipboardPaste,
        shortcut: `${mod}+v`,
        run: () => {
          actions.setView(docId, { currentPage: pageIndex });
          pasteObjects(docId);
        },
      },
      'divider',
    );
  }
  entries.push(
    { id: 'viewer.page.rotateCw', label: 'Rotate page clockwise', icon: RotateCw, run: () => guard('Rotate page', () => engine.rotatePages(docId, [pageIndex], 90)) },
    { id: 'viewer.page.rotateCcw', label: 'Rotate page counterclockwise', icon: RotateCcw, run: () => guard('Rotate page', () => engine.rotatePages(docId, [pageIndex], -90)) },
    {
      id: 'viewer.page.insertBlank',
      label: 'Insert blank page after',
      icon: FilePlus2,
      run: () => guard('Insert page', () => engine.insertBlankPages(docId, pageIndex + 1, 1, blankPageSizeFor(docId, pageIndex))),
    },
    {
      id: 'viewer.page.delete',
      label: 'Delete page',
      icon: Trash2,
      danger: true,
      disabled: d.pages.length <= 1,
      run: () => confirmDeletePages(docId, [pageIndex]),
    },
    'divider',
    { id: 'viewer.zoomIn', label: 'Zoom in', icon: ZoomIn, shortcut: `${mod}+=`, run: () => actions.zoomIn(docId) },
    { id: 'viewer.zoomOut', label: 'Zoom out', icon: ZoomOut, shortcut: `${mod}+-`, run: () => actions.zoomOut(docId) },
    { id: 'viewer.fitPage', label: 'Fit page', icon: Maximize, run: () => actions.fit(docId, 'page') },
    { id: 'viewer.fitWidth', label: 'Fit width', icon: StretchHorizontal, run: () => actions.fit(docId, 'width') },
  );
  return entries;
}

export function openPageContextMenu(e: Pointerish, docId: DocId, pageIndex: number, point?: Point) {
  const entries: MenuEntry[] = [...contributions('page', { docId, pageIndex, point }), ...pageCoreItems(docId, pageIndex)];
  showContextMenu(e, entries);
}
