/**
 * Undoable security changes.
 *
 * The core `actions.setSecurity` doesn't touch the undo history and Snapshot doesn't include
 * `security`. We push a checkpoint ourselves and remember which security value belongs before /
 * after that history entry; a store subscription detects when the entry is undone / redone and
 * re-applies the matching value. (Snapshots are immutable objects, so they work as WeakMap keys.)
 */
import { actions, getDoc, useApp } from '@/core/store';
import type { DocId, SecuritySettings, Snapshot } from '@/core/types';

interface Change {
  before: SecuritySettings | null;
  after: SecuritySettings | null;
}

/** Entries in `history.past`: undoing them restores `before`. */
const undoable = new WeakMap<Snapshot, Change>();
/** Entries in `history.future`: redoing them restores `after`. */
const redoable = new WeakMap<Snapshot, Change>();

let applying = false;
let installed = false;

export function setSecurityUndoable(docId: DocId, security: SecuritySettings | null, label: string) {
  install();
  const d = getDoc(docId);
  if (!d) return;
  const change: Change = { before: d.security, after: security };
  actions.checkpoint(docId, label);
  const after = getDoc(docId)!;
  const top = after.history.past[after.history.past.length - 1];
  if (top) undoable.set(top, change);
  apply(docId, security);
}

function apply(docId: DocId, security: SecuritySettings | null) {
  applying = true;
  try {
    actions.setSecurity(docId, security);
  } finally {
    applying = false;
  }
}

export function install() {
  if (installed) return;
  installed = true;
  useApp.subscribe(
    (s) => s.docs,
    (docs, prevDocs) => {
      if (applying) return;
      for (const id of Object.keys(docs)) {
        const cur = docs[id]?.history;
        const prev = prevDocs[id]?.history;
        if (!cur || !prev || cur === prev) continue;
        // Undo: the last past entry moved to the front of the future.
        if (cur.past.length === prev.past.length - 1 && cur.future.length === prev.future.length + 1 && cur.future[1] === prev.future[0]) {
          const popped = prev.past[prev.past.length - 1];
          const change = popped && undoable.get(popped);
          if (change) {
            if (cur.future[0]) redoable.set(cur.future[0], change);
            apply(id, change.before);
          }
          continue;
        }
        // Redo: the first future entry moved to the end of the past.
        if (cur.past.length === prev.past.length + 1 && cur.future.length === prev.future.length - 1 && cur.future[0] === prev.future[1]) {
          const shifted = prev.future[0];
          const change = shifted && redoable.get(shifted);
          if (change) {
            const top = cur.past[cur.past.length - 1];
            if (top) undoable.set(top, change);
            apply(id, change.after);
          }
        }
      }
    },
  );
}
