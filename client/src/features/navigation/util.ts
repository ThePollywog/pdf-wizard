/** Small helpers shared by the navigation feature (bookmarks, find, attachments, properties…). */
import type { DocId } from '@/core/types';
import { actions, getDoc, useApp } from '@/core/store';
import * as engine from '@/core/engine';
import { useRegistry } from '@/core/registry';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs `fn`, reporting failures as an error toast (and in the console). */
export async function guard<T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[navigation] ${label} failed`, e);
    actions.toast(`${label} failed: ${errMsg(e)}`, { kind: 'error' });
    return undefined;
  }
}

export const activeDocId = (): DocId | null => {
  const s = useApp.getState();
  return s.activeDocId && s.docs[s.activeDocId] ? s.activeDocId : null;
};

/** True when the document can be edited (not opened read-only). */
export function canEdit(docId: DocId | null | undefined): boolean {
  if (!docId || !getDoc(docId)) return false;
  try {
    return !engine.isReadOnly(docId);
  } catch {
    return false;
  }
}

/** "In a document workspace": an active document is shown. */
export function inDocument(): boolean {
  const s = useApp.getState();
  return s.route === 'document' && !!s.activeDocId && !!s.docs[s.activeDocId];
}

export function readLocal(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** Trim a string to `max` characters with an ellipsis. */
export function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Numeric-aware, case-insensitive compare. */
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The combo actually assigned to a command (optional shortcuts may be taken by another feature). */
export const shortcutOf = (id: string): string | undefined => useRegistry.getState().commands[id]?.shortcut;
