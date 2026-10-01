/**
 * Comments: sticky notes, text markups (highlight / underline / strikethrough / squiggly), insert
 * and replace text (caret), text boxes, callouts and file attachments; pop-up notes with replies and
 * review status; the Comments panel (search, filter, sort, XFDF import / export, summary); the
 * "Comment" task; PDF import / export of all of it as standard annotations.
 *
 *  - task: comment · panel: comments (right rail, order 30)
 *  - tools: comment-note (s), comment-highlight (u), comment-underline, comment-strikeout,
 *    comment-squiggly, comment-insert-text, comment-replace-text, comment-textbox (x),
 *    comment-callout, comment-attach
 *  - object kinds: note, text-markup, caret, freetext, file-attachment
 */
import { MessageSquare } from 'lucide-react';
import { registerObjectType, registerPanel, registerTask, registerTool, useRegistry } from '@/core/registry';
import { actions, getDoc, useApp } from '@/core/store';
import type { DocId, DocState, PdfObject } from '@/core/types';
import { useViewerUi, viewerUi } from '@/core/viewer/viewerStore';
import { noteType } from './note';
import { markupType } from './markup';
import { caretType } from './caret';
import { freeTextType } from './freetext';
import { attachmentType } from './attachment';
import { COMMENT_TOOLS } from './tools';
import { CommentsPanel, forgetPanelState } from './Panel';
import { CommentTaskPanel } from './TaskPanel';
import { registerCommentCommands } from './commands';
import { registerCommentImporters } from './importers';
import { installTextFill } from './textFill';
import { mountPopupRoot } from './popup';
import { resetMeasureCache } from './layout';
import { discardNew, settleNew } from './ops';
import { commentsUi, isCommentKind, showsPopupOnSelect, TOOL, useCommentsUi, type FreeTextData } from './model';
import './styles.css';

registerObjectType(noteType);
registerObjectType(markupType);
registerObjectType(caretType);
registerObjectType(freeTextType);
registerObjectType(attachmentType);
COMMENT_TOOLS.forEach(registerTool);

const TASK_TOOLBAR = [
  TOOL.note, TOOL.highlight, TOOL.underline, TOOL.strikeout, TOOL.squiggly, TOOL.insert, TOOL.replace, TOOL.textbox, TOOL.callout,
  'draw-pen', 'shape-rect', 'stamp', TOOL.attach,
];

registerTask({
  id: 'comment',
  label: 'Comment',
  description: 'Add sticky notes, highlights, text boxes and other comments, and review them with others.',
  icon: MessageSquare,
  color: '#e8a100',
  category: 'comment',
  order: 10,
  featured: 4,
  keywords: ['review', 'annotate', 'markup', 'note', 'highlight', 'sticky note', 'comment', 'underline', 'strikethrough', 'text box', 'callout', 'attach', 'xfdf'],
  requiresDocument: true,
  Panel: CommentTaskPanel,
  toolbar: TASK_TOOLBAR,
  onOpen: () => {
    actions.setRightPanel('comments');
    const d = useApp.getState().activeDocId;
    if (d && commentsUi.isHidden(d)) commentsUi.setHidden(d, false);
  },
});

function countComments(doc: DocState): number {
  let n = 0;
  for (const id of doc.order) {
    const o = doc.objects[id];
    if (o && isCommentKind(o.kind)) n++;
  }
  return n;
}

registerPanel({
  id: 'comments',
  label: 'Comments',
  icon: MessageSquare,
  order: 30,
  Component: CommentsPanel,
  badge: (doc) => countComments(doc) || undefined,
});

registerCommentCommands();
registerCommentImporters();
installTextFill();

// ── feature-wide wiring (DOM / store subscriptions) ─────────────────────────

if (typeof document !== 'undefined') {
  mountPopupRoot();

  // "Hide all comments": hide comment objects (and their under-page highlights) per document.
  const style = document.createElement('style');
  style.dataset.feature = 'comments-hidden';
  document.head.appendChild(style);
  const commentKinds = () =>
    Object.values(useRegistry.getState().objectTypes)
      .filter((t) => t.category === 'comment')
      .map((t) => t.kind);
  const renderHidden = () => {
    const docs = Object.keys(useCommentsUi.getState().hidden);
    const kinds = commentKinds();
    style.textContent = docs
      .map((id) => {
        const root = `.pdfwizard-viewer[data-doc-id="${CSS.escape(id)}"]`;
        const sels = [...kinds.map((k) => `${root} .pdfwizard-obj[data-kind="${CSS.escape(k)}"]`), `${root} .comments-portal`];
        return `${sels.join(',\n')} { display: none !important; }`;
      })
      .join('\n');
  };
  useCommentsUi.subscribe((s, p) => s.hidden !== p.hidden && renderHidden());
  useRegistry.subscribe((s, p) => s.objectTypes !== p.objectTypes && Object.keys(useCommentsUi.getState().hidden).length > 0 && renderHidden());

  // While a text selection is being dragged, comments must not catch the pointer: the browser
  // would otherwise extend the selection to the end of the text layer when crossing a highlight.
  const root = document.documentElement;
  const endDrag = () => root.classList.remove('comments-text-dragging');
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button === 0 && (e.target as Element | null)?.closest?.('.textLayer')) root.classList.add('comments-text-dragging');
    },
    true,
  );
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
  window.addEventListener('blur', endDrag);

  // Font used on screen for text boxes: widths change once it has loaded.
  void document.fonts?.load("16px 'comments-sans'").then(() => resetMeasureCache(), () => undefined);
  document.fonts?.addEventListener?.('loadingdone', () => resetMeasureCache());
}

/** Kinds whose "edit" (double click / Enter) opens the pop-up note instead of in-place editing. */
const POPUP_EDIT_KINDS = new Set(['note', 'text-markup', 'caret', 'file-attachment']);

// A click on a comment that is already selected (its pop-up closed after posting, or closed by
// the user) shows the pop-up again. Clicks that end a move are ignored.
if (typeof document !== 'undefined') {
  let down: { x: number; y: number } | null = null;
  document.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }), true);
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.metaKey || e.ctrlKey) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) return;
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('.pdfwizard-obj[data-obj-id]');
    const docId = el?.closest<HTMLElement>('.pdfwizard-viewer[data-doc-id]')?.dataset.docId;
    const objectId = el?.dataset.objId;
    if (!docId || !objectId) return;
    queueMicrotask(() => {
      const d = getDoc(docId);
      if (!d || d.selection.length !== 1 || d.selection[0] !== objectId || d.editingId) return;
      if (!showsPopupOnSelect(d.objects[objectId]) || commentsUi.isHidden(docId)) return;
      const p = commentsUi.get().popup;
      if (p && p.docId === docId && p.objectId === objectId) return;
      commentsUi.openPopup({ docId, objectId, focus: false, source: 'select' });
    });
  });
}

const prevEditing: Record<DocId, string | null> = {};
const prevSelection: Record<DocId, readonly string[]> = {};

useApp.subscribe(
  (s) => s.docs,
  (docs, before) => {
    for (const id of Object.keys(before)) {
      if (!docs[id]) {
        forgetPanelState(id);
        commentsUi.setHidden(id, false);
        if (commentsUi.get().popup?.docId === id) commentsUi.closePopup();
        delete prevEditing[id];
        delete prevSelection[id];
      }
    }
    for (const d of Object.values(docs)) {
      if (d === before[d.id]) continue;
      // Editing ended on a text box left empty: remove it (like desktop PDF editors).
      const wasEditing = prevEditing[d.id] ?? null;
      if (wasEditing !== d.editingId) {
        prevEditing[d.id] = d.editingId;
        if (wasEditing) {
          const o = d.objects[wasEditing];
          if (o?.kind === 'freetext' && !(o.data as FreeTextData).text?.trim() && !o.replies?.length && !o.locked) {
            queueMicrotask(() => discardNew(d.id, wasEditing));
          } else if (o?.kind === 'freetext') {
            // Later edits of the text are undo steps of their own.
            settleNew(wasEditing);
          }
        }
        const e = d.editingId ? d.objects[d.editingId] : undefined;
        if (e && POPUP_EDIT_KINDS.has(e.kind)) {
          const docId = d.id;
          const objectId = e.id;
          queueMicrotask(() => {
            actions.setEditing(docId, null);
            commentsUi.openPopup({ docId, objectId, focus: !e.locked, source: 'edit' });
          });
        }
      }
      // Selecting a single sticky note (or a markup with a comment) shows its pop-up.
      if (prevSelection[d.id] !== d.selection) {
        prevSelection[d.id] = d.selection;
        if (d.selection.length === 1) {
          const o = d.objects[d.selection[0]];
          if (showsPopupOnSelect(o) && !commentsUi.isHidden(d.id)) {
            const docId = d.id;
            const objectId = o.id;
            queueMicrotask(() => {
              const cur = getDoc(docId);
              if (!cur || cur.selection.length !== 1 || cur.selection[0] !== objectId) return;
              if (useViewerUi.getState().interaction === 'marquee') return;
              const p = commentsUi.get().popup;
              if (p && p.docId === docId && p.objectId === objectId) return;
              commentsUi.openPopup({ docId, objectId, focus: false, source: 'select' });
            });
          }
        }
      }
    }
  },
);

// The core comment popover (properties bar "Comment" button, context menu) → our pop-up note.
useViewerUi.subscribe((s, p) => {
  const t = s.commentFor;
  if (!t || t === p.commentFor) return;
  const o = getDoc(t.docId)?.objects[t.objectId];
  // Only our kinds: other comment kinds (drawings, stamps…) keep the core popover.
  if (!o || !(POPUP_EDIT_KINDS.has(o.kind) || o.kind === 'freetext')) return;
  viewerUi.set({ commentFor: null });
  if (commentsUi.isHidden(t.docId)) commentsUi.setHidden(t.docId, false);
  commentsUi.openPopup({ docId: t.docId, objectId: t.objectId, focus: true, source: 'explicit' });
});
