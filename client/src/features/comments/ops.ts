/**
 * Comment operations shared by the pop-up notes, the Comments panel, context menus and commands.
 * Every mutation goes through the store actions (undoable, marks the document dirty).
 */
import type { DocId, DocState, PdfObject, Reply, ReviewStatus } from '@/core/types';
import { actions, getDoc, useApp } from '@/core/store';
import { uid } from '@/core/util';
import { scrollToObject } from '@/core/viewer';
import { canAnnotate, commentsUi, isComment, kindLabel, STATUS_LABEL, typeOf, type FreeTextData } from './model';
import { relayoutFreeText } from './freetextLayout';

export function getObj(docId: DocId, id: string): PdfObject | undefined {
  return getDoc(docId)?.objects[id];
}

/** Text shown for a comment: its contents, else the type summary (e.g. highlighted text). */
export function commentText(o: PdfObject): string {
  if (o.contents && o.contents.trim()) return o.contents;
  try {
    return typeOf(o)?.summary?.(o) ?? '';
  } catch {
    return '';
  }
}

/** Sets the comment text. For text boxes the text *is* the comment, so both stay in sync. */
export function setContents(docId: DocId, id: string, text: string, label = 'Edit comment') {
  const o = getObj(docId, id);
  if (!o || !canAnnotate(docId)) return;
  if ((o.contents ?? '') === text && o.kind !== 'freetext') return;
  // The first text of a comment that was just added is part of its "Add …" undo step.
  const checkpoint = !isFresh(docId, id);
  if (o.kind === 'freetext') {
    const d = o.data as FreeTextData;
    if (d.text === text && (o.contents ?? '') === text) return;
    const doc = getDoc(docId)!;
    const page = doc.pages.find((p) => p.id === o.pageId);
    actions.updateObject(docId, id, { contents: text, ...relayoutFreeText(o as never, { text }, page) }, { label, checkpoint });
    settleNew(id);
    return;
  }
  actions.updateObject(docId, id, { contents: text || undefined }, { label, checkpoint });
  settleNew(id);
}

/**
 * Undoable change of a comment's thread (replies / review status) that keeps the comment's own
 * modification date: in a PDF those are separate annotations (/IRT) and don't touch the parent's /M.
 */
function patchThread(docId: DocId, id: string, patch: Pick<PdfObject, 'replies' | 'status'>, label: string) {
  if (!getObj(docId, id)) return;
  actions.checkpoint(docId, label);
  actions.updateDoc(docId, (d) => {
    const o = d.objects[id];
    return o ? { objects: { ...d.objects, [id]: { ...o, ...patch } }, dirty: true } : {};
  });
}

export function setStatus(docId: DocId, id: string, status: ReviewStatus) {
  const o = getObj(docId, id);
  if (!o || (o.status ?? 'none') === status || !canAnnotate(docId)) return;
  patchThread(docId, id, { status: status === 'none' ? undefined : status }, `Set status: ${STATUS_LABEL[status]}`);
}

export function addReply(docId: DocId, id: string, text: string): Reply | null {
  const o = getObj(docId, id);
  const t = text.trim();
  if (!o || !t || !canAnnotate(docId)) return null;
  const reply: Reply = { id: uid('rp'), author: userName(), text: t, createdAt: Date.now() };
  patchThread(docId, id, { replies: [...(o.replies ?? []), reply] }, 'Add reply');
  return reply;
}

export function editReply(docId: DocId, id: string, replyId: string, text: string) {
  const o = getObj(docId, id);
  if (!o || !canAnnotate(docId)) return;
  const t = text.trim();
  const prev = o.replies?.find((r) => r.id === replyId);
  if (!prev || prev.text === t) return;
  // An emptied reply is removed, like in desktop PDF editors.
  if (!t) return deleteReply(docId, id, replyId);
  const replies = (o.replies ?? []).map((r) => (r.id === replyId ? { ...r, text: t } : r));
  patchThread(docId, id, { replies }, 'Edit reply');
}

export function deleteReply(docId: DocId, id: string, replyId: string) {
  const o = getObj(docId, id);
  if (!o || !canAnnotate(docId)) return;
  const replies = (o.replies ?? []).filter((r) => r.id !== replyId);
  if (replies.length === (o.replies ?? []).length) return;
  patchThread(docId, id, { replies: replies.length ? replies : undefined }, 'Delete reply');
}

export function deleteComment(docId: DocId, id: string) {
  const o = getObj(docId, id);
  if (!o || !canAnnotate(docId)) return;
  if (o.locked) {
    actions.toast('Locked comments can’t be deleted. Unlock them first.', { kind: 'info' });
    return;
  }
  if (commentsUi.get().popup?.objectId === id) commentsUi.closePopup();
  actions.deleteObjects(docId, [id], { label: `Delete ${kindLabel(o).toLowerCase()}` });
}

/** Same rule as newObject(): prefs.userName or 'Guest'. */
export function userName(): string {
  return useApp.getState().prefs.userName || 'Guest';
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    actions.toast('Copied to clipboard');
  } catch {
    actions.toast('Couldn’t access the clipboard.', { kind: 'error' });
  }
}

/** Scroll to a comment, select it and open its pop-up note. */
export function revealComment(docId: DocId, id: string, opts: { popup?: boolean; focus?: boolean } = {}) {
  const o = getObj(docId, id);
  if (!o) return;
  if (commentsUi.isHidden(docId)) commentsUi.setHidden(docId, false);
  if (useApp.getState().activeToolId !== 'select') actions.setTool('select');
  scrollToObject(docId, id);
  actions.setSelection(docId, [id]);
  if (opts.popup) commentsUi.openPopup({ docId, objectId: id, focus: !!opts.focus, source: 'explicit' });
}

type Snapshot = DocState['history']['past'][number];
/** Objects added by addNewObject(): the undo step that added them and whether the doc was dirty before. */
const created = new Map<string, { step: Snapshot | undefined; wasDirty: boolean }>();

/**
 * actions.addObject() for objects that may be discarded right away if left empty (sticky notes,
 * text boxes, carets): remembers how to undo the addition without a trace (see discardNew).
 */
export function addNewObject(docId: DocId, obj: PdfObject, opts: Parameters<typeof actions.addObject>[2]) {
  const wasDirty = !!getDoc(docId)?.dirty;
  actions.addObject(docId, obj, opts);
  const d = getDoc(docId);
  if (!d?.objects[obj.id]) return;
  if (created.size > 50) created.clear();
  created.set(obj.id, { step: d.history.past[d.history.past.length - 1], wasDirty });
}

/**
 * True while nothing else was recorded in the history since `id` was added with addNewObject(): its
 * first text then belongs to the "Add …" step (one undo removes the new comment with its text).
 */
export function isFresh(docId: DocId, id: string): boolean {
  const rec = created.get(id);
  const d = getDoc(docId);
  return !!rec && !!d && !!rec.step && d.history.past[d.history.past.length - 1] === rec.step;
}

/** Ends the "just added" state of `id` (see isFresh). */
export function settleNew(id: string) {
  created.delete(id);
}

/**
 * Removes an object that was just created and never filled in (e.g. a sticky note whose pop-up was
 * cancelled), together with its "Add …" undo step, so no empty step is left in the history and a
 * document that was saved before stays unmodified.
 */
export function discardNew(docId: DocId, id: string) {
  const d = getDoc(docId);
  const rec = created.get(id);
  created.delete(id);
  if (!d || !d.objects[id]) return;
  const last = d.history.past[d.history.past.length - 1];
  if (last && !last.objects[id]) {
    const clean = !!rec && rec.step === last && !rec.wasDirty;
    actions.updateDoc(docId, (doc) => {
      const objects = { ...doc.objects };
      delete objects[id];
      return {
        objects,
        order: doc.order.filter((x) => x !== id),
        selection: doc.selection.filter((x) => x !== id),
        editingId: doc.editingId === id ? null : doc.editingId,
        history: { past: doc.history.past.slice(0, -1), future: doc.history.future },
        ...(clean ? { dirty: false } : {}),
      };
    });
    return;
  }
  actions.deleteObjects(docId, [id], { checkpoint: false });
}

export function allComments(docId: DocId): PdfObject[] {
  const d = getDoc(docId);
  if (!d) return [];
  return d.order.map((x) => d.objects[x]).filter((o): o is PdfObject => isComment(o));
}
