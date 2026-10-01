/**
 * Keyboard and outside-click handling of the Edit PDF tools. The handler runs on window keydown in
 * the capture phase (before the viewer and the global shortcut manager) and consumes only the keys
 * it acts on:
 *
 *  - text editor open: Esc commits and selects the edited box; Save / Save as / Print commit first
 *  - crop mode: Esc cancels, Enter applies
 *  - item selected: Esc deselects, Delete / Backspace deletes, Enter edits the text / link,
 *    arrows nudge (Shift = 10 pt)
 *  - Undo / Redo wait for pending edits
 */
import { runCommand } from '@/core/registry';
import { getDoc, useApp } from '@/core/store';
import { hasEscapeLayer, isEditableTarget, matchShortcut } from '@/core/ui';
import { LAYER_ATTR } from '@/core/ui/layers';
import { deleteTarget } from './edits';
import { isEditTool } from './model';
import { commitEdit } from './sessions';
import { ui, useEditPdf, type Target } from './state';
import { applyCrop, cancelCrop, editLinkProperties, editTargetText, kindOfTarget } from './targetActions';
import { layoutTextBox } from './textbox';
import { arrowDelta, flushNudge, nudgePending, nudgeTarget, settleNudge } from './tools/nudge';
import { frameRect } from './viewmath';

/** Resolves once no byte edit started by this feature is running. */
export function whenIdle(): Promise<void> {
  if (!ui.get().working) return Promise.resolve();
  return new Promise((resolve) => {
    const un = useEditPdf.subscribe((s) => {
      if (!s.working) {
        un();
        resolve();
      }
    });
  });
}

/** Commits the editor and pending moves, then waits for the byte edits to finish. */
export async function settleAll(): Promise<void> {
  await commitEdit();
  await settleNudge();
  await whenIdle();
}

/** Esc in the text editor: commit and keep the edited box selected. */
export async function escapeEdit(): Promise<void> {
  const s = ui.get().edit;
  if (!s || s.phase !== 'editing') return;
  const bytes = getDoc(s.docId)?.bytes;
  const src = s.source;
  const text = s.text.replace(/\r\n?/g, '\n');
  const lay = layoutTextBox(text, s.style, s.frame.width, s.autoWidth);
  await commitEdit();
  const doc = getDoc(s.docId);
  if (!doc) return;
  if (src.type === 'object') {
    if (doc.objects[src.objectId]) ui.setTarget({ type: 'object', docId: s.docId, pageIndex: s.pageIndex, id: src.objectId });
  } else if (src.type === 'block') {
    if (doc.bytes === bytes) ui.setTarget({ type: 'block', docId: s.docId, pageIndex: s.pageIndex, id: src.blockId, text: src.expectText });
    else if (text.trim()) ui.setReselect({ type: 'block', docId: s.docId, pageIndex: s.pageIndex, text, bounds: frameRect({ ...s.frame, height: lay.height }) });
  }
}

/** Save / print / undo combos that must see the committed edit. */
const AFTER_EDIT: [string, string][] = [
  ['mod+s', 'core.save'],
  ['mod+shift+s', 'core.saveAs'],
  ['mod+p', 'core.print'],
];
const HISTORY: [string, string][] = [
  ['mod+z', 'core.undo'],
  ['mod+shift+z', 'core.redo'],
];

const WIDGETS = '[role="menu"], [role="listbox"], [role="combobox"], [role="spinbutton"], [role="slider"], [role="tablist"], [role="radiogroup"], [data-no-shortcuts]';

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const app = useApp.getState();
  if (!isEditTool(app.activeToolId) || app.modals.length > 0 || app.busy) return;
  const consume = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  const st = ui.get();
  const el = e.target instanceof Element ? e.target : null;
  const inEditor = !!el?.closest('.edit-pdf-editor');

  // commit before saving / printing
  for (const [combo, id] of AFTER_EDIT) {
    if (!matchShortcut(e, combo)) continue;
    if (st.edit?.phase === 'editing' || st.working || nudgePending()) {
      consume();
      if (e.repeat) return;
      void settleAll().then(() => runCommand(id));
    }
    return;
  }

  if (st.edit) {
    if (st.edit.phase === 'editing' && e.key === 'Escape' && plain && !hasEscapeLayer() && (inEditor || !isEditableTarget(e.target))) {
      consume();
      void escapeEdit();
    }
    return; // the editor owns the keyboard
  }

  // undo / redo after pending edits
  for (const [combo, id] of HISTORY) {
    if (!matchShortcut(e, combo)) continue;
    if (isEditableTarget(e.target)) return;
    if (st.working || nudgePending()) {
      consume();
      void settleAll().then(() => runCommand(id));
    }
    return;
  }

  if (isEditableTarget(e.target) || hasEscapeLayer() || el?.closest(`[${LAYER_ATTR}]`)) return;

  if (st.crop) {
    if (e.key === 'Escape' && plain) {
      consume();
      cancelCrop();
    } else if (e.key === 'Enter' && plain) {
      consume();
      void applyCrop();
    }
    return;
  }

  const t: Target | null = st.target && st.target.docId === app.activeDocId ? st.target : null;
  if (!t) return;
  if (el?.closest(WIDGETS)) return;

  if (e.key === 'Escape' && plain) {
    consume();
    flushNudge();
    ui.setTarget(null);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && plain && !e.shiftKey) {
    consume();
    if (e.repeat) return;
    flushNudge();
    void deleteTarget(t);
    return;
  }
  if (e.key === 'Enter' && plain && !e.shiftKey) {
    if (el?.closest('button, a[href], [role="button"]')) return; // activates the focused button
    const kind = kindOfTarget(t);
    if (kind === 'text') {
      consume();
      void editTargetText(t);
    } else if (kind === 'link') {
      consume();
      void editLinkProperties(t);
    }
    return;
  }
  const d = plain ? arrowDelta(e.key, e.shiftKey ? 10 : 1) : null;
  if (d) {
    consume();
    nudgeTarget(t, d.x, d.y);
  }
}

/** Clicks outside the pages and the Edit PDF controls commit the editor / crop / pending moves. */
function onPointerDownCapture(e: PointerEvent) {
  if (!isEditTool(useApp.getState().activeToolId)) return;
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  if (el.closest(`.edit-pdf-editor, .edit-pdf-overlay, [data-edit-pdf-keep], [${LAYER_ATTR}]`)) return;
  flushNudge();
  const st = ui.get();
  if (st.edit?.phase === 'editing') void commitEdit();
  if (st.crop) void applyCrop();
}

let installed = false;
export function installKeys(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDownCapture, true);
}
