/**
 * Commands (menu "Comment"), text-selection actions (Highlight / Underline / Strikethrough /
 * Add comment) and the page context-menu entries of the comments feature.
 */
import { EyeOff, FileDown, FileText, FileUp, Highlighter, MessageSquare, MessageSquarePlus, Strikethrough, Underline } from 'lucide-react';
import type { DocId, MenuItem, TextSelectionInfo } from '@/core/types';
import { registerCommands, registerContextMenu, registerTextSelectionAction } from '@/core/registry';
import { actions, getActiveDoc, getDoc, useApp } from '@/core/store';
import { viewerUi } from '@/core/viewer/viewerStore';
import { controllerFor } from '@/core/viewer/controller';
import { collectTextSelection } from '@/core/viewer/textSelection';
import { canAnnotate, commentsUi, isCommentKind, TOOL, type MarkupType } from './model';
import { createMarkups } from './markup';
import { createNote } from './note';
import { toggleCommentsHidden } from './Panel';
import { exportXfdf, importXfdf } from './xfdf';
import { summarizeComments } from './summarize';
import { TextBoxIcon } from './icons';
import { createTextBox } from './freetext';

const activeId = (): DocId | null => getActiveDoc()?.id ?? null;
const hasDoc = () => !!getActiveDoc();
const commentCount = (docId: DocId | null) => {
  const d = docId ? getDoc(docId) : undefined;
  return d ? d.order.reduce((n, id) => (d.objects[id] && isCommentKind(d.objects[id].kind) ? n + 1 : n), 0) : 0;
};

/** The text currently selected in the active document's viewer, if any. */
function currentSelection(docId: DocId): TextSelectionInfo[] {
  const popup = viewerUi.get().textPopup;
  if (popup && popup.docId === docId && popup.selections.length) return popup.selections;
  const ctrl = controllerFor(docId);
  return ctrl ? collectTextSelection(ctrl) : [];
}

function clearTextSelection() {
  document.getSelection()?.removeAllRanges();
  viewerUi.set({ textPopup: null });
}

async function markupSelection(type: MarkupType, selections: TextSelectionInfo[], withComment = false) {
  const docId = selections[0]?.docId;
  if (!docId || !canAnnotate(docId)) return;
  if (commentsUi.isHidden(docId)) commentsUi.setHidden(docId, false);
  const objs = await createMarkups(type, selections, { select: true, label: withComment ? 'Add comment' : undefined });
  clearTextSelection();
  if (!objs.length) {
    actions.toast('Couldn’t find the selected text on the page.', { kind: 'error' });
    return;
  }
  if (withComment) commentsUi.openPopup({ docId, objectId: objs[objs.length - 1].id, focus: true, source: 'create' });
}

function highlightSelected() {
  const docId = activeId();
  if (!docId || !canAnnotate(docId)) return;
  const sel = currentSelection(docId);
  if (sel.length) {
    void markupSelection('highlight', sel);
    return;
  }
  actions.setTool(TOOL.highlight);
  actions.toast('Select the text you want to highlight.');
}

export function registerCommentCommands() {
  registerCommands([
    {
      id: 'comments-add-note',
      label: 'Add sticky note',
      icon: MessageSquarePlus,
      menu: 'comment',
      group: 'comments',
      order: 10,
      requiresDocument: true,
      enabled: hasDoc,
      run: () => {
        const docId = activeId();
        if (!docId || !canAnnotate(docId)) return;
        actions.setTool(TOOL.note);
      },
    },
    {
      id: 'comments-highlight-selection',
      label: 'Highlight selected text',
      icon: Highlighter,
      menu: 'comment',
      group: 'comments',
      order: 11,
      requiresDocument: true,
      enabled: hasDoc,
      run: highlightSelected,
    },
    {
      id: 'comments-add-textbox',
      label: 'Add text box',
      icon: TextBoxIcon,
      group: 'comments',
      order: 12,
      requiresDocument: true,
      enabled: hasDoc,
      run: () => {
        const docId = activeId();
        if (docId && canAnnotate(docId)) actions.setTool(TOOL.textbox);
      },
    },
    {
      id: 'comments-show-panel',
      label: 'Show comments panel',
      icon: MessageSquare,
      menu: 'comment',
      group: 'comments-list',
      order: 20,
      requiresDocument: true,
      enabled: hasDoc,
      run: () => actions.setRightPanel('comments'),
    },
    {
      id: 'comments-export-xfdf',
      label: 'Export comments…',
      icon: FileDown,
      menu: 'comment',
      group: 'comments-list',
      order: 21,
      requiresDocument: true,
      enabled: () => commentCount(activeId()) > 0,
      run: () => {
        const docId = activeId();
        if (docId) void exportXfdf(docId);
      },
    },
    {
      id: 'comments-import-xfdf',
      label: 'Import comments…',
      icon: FileUp,
      menu: 'comment',
      group: 'comments-list',
      order: 22,
      requiresDocument: true,
      enabled: hasDoc,
      run: () => {
        const docId = activeId();
        if (docId) void importXfdf(docId);
      },
    },
    {
      id: 'comments-summarize',
      label: 'Summarize comments',
      icon: FileText,
      menu: 'comment',
      group: 'comments-list',
      order: 23,
      requiresDocument: true,
      enabled: () => commentCount(activeId()) > 0,
      run: () => {
        const docId = activeId();
        if (docId) void summarizeComments(docId);
      },
    },
    {
      id: 'comments-toggle-hidden',
      label: 'Hide all comments',
      icon: EyeOff,
      menu: 'comment',
      group: 'comments-list',
      order: 24,
      requiresDocument: true,
      enabled: () => {
        const docId = activeId();
        return !!docId && (commentCount(docId) > 0 || commentsUi.isHidden(docId));
      },
      run: () => {
        const docId = activeId();
        if (docId) toggleCommentsHidden(docId);
      },
    },
  ]);

  // ── text-selection pop-up ──────────────────────────────────────────────
  const tsa: { id: string; label: string; icon: typeof Highlighter; type: MarkupType; comment?: boolean; order: number }[] = [
    { id: 'comments-tsa-highlight', label: 'Highlight', icon: Highlighter, type: 'highlight', order: 10 },
    { id: 'comments-tsa-underline', label: 'Underline', icon: Underline, type: 'underline', order: 11 },
    { id: 'comments-tsa-strikeout', label: 'Strikethrough', icon: Strikethrough, type: 'strikeout', order: 12 },
    { id: 'comments-tsa-comment', label: 'Add comment', icon: MessageSquarePlus, type: 'highlight', comment: true, order: 13 },
  ];
  for (const a of tsa) {
    registerTextSelectionAction({ id: a.id, label: a.label, icon: a.icon, order: a.order, run: (selections) => markupSelection(a.type, selections, a.comment) });
  }

  // ── page context menu ──────────────────────────────────────────────────
  registerContextMenu({
    id: 'comments-ctx-page',
    target: 'page',
    order: 20,
    items({ docId, pageIndex, point }) {
      if (pageIndex == null || !point) return [];
      const d = getDoc(docId);
      const page = d?.pages[pageIndex];
      if (!page) return [];
      const reveal = () => commentsUi.isHidden(docId) && commentsUi.setHidden(docId, false);
      // Read-only documents: comments can't be added, but they can still be hidden / shown.
      const editable = canAnnotate(docId, true);
      const items: MenuItem[] = !editable ? [] : [
        {
          id: 'comments-ctx-add-note',
          label: 'Add sticky note here',
          icon: MessageSquarePlus,
          run: () => {
            reveal();
            if (useApp.getState().activeToolId !== 'select') actions.setTool('select');
            createNote(docId, page, point, { label: 'Add sticky note' });
          },
        },
        {
          id: 'comments-ctx-add-textbox',
          label: 'Add text box here',
          icon: TextBoxIcon,
          run: () => {
            reveal();
            if (useApp.getState().activeToolId !== 'select') actions.setTool('select');
            createTextBox(docId, page, { at: point });
          },
        },
      ];
      if (commentCount(docId) > 0) {
        items.push({
          id: 'comments-ctx-toggle-hidden',
          label: commentsUi.isHidden(docId) ? 'Show all comments' : 'Hide all comments',
          icon: EyeOff,
          run: () => toggleCommentsHidden(docId),
        });
      }
      return items;
    },
  });
}
