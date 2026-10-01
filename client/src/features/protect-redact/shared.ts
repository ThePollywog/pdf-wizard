/**
 * Small helpers shared by the Protect and Redact halves of the feature.
 */
import * as engine from '@/core/engine';
import { actions, getDoc, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';

export const FEATURE = 'protect-redact';

/**
 * Why the document can't be changed (null when it can). View-only shared documents can still be
 * changed locally (like the rest of the app, saving them creates a copy), so only documents the
 * engine couldn't decrypt for editing are refused.
 */
export function readOnlyReason(docId: DocId | null | undefined): string | null {
  const d = getDoc(docId);
  if (!d) return 'No document is open.';
  if (engine.isReadOnly(d.id)) {
    const why = (d.ext.engine as { reason?: string } | undefined)?.reason;
    return `“${d.name}” is open read-only${why ? ` because ${why}` : ''}, so it can’t be changed.`;
  }
  return null;
}

/** Reactive variant (re-evaluated when the document state changes). */
export function useReadOnlyReason(docId: DocId | null | undefined): string | null {
  // Subscribe to the bits that can change; the engine flag is set before the document is shown.
  useDoc(docId, (d) => (d ? `${d.version}|${d.pdfVersion}` : ''));
  return readOnlyReason(docId);
}

/** True for documents shared with the user as view only (changes are saved to a copy). */
export function useSharedViewOnly(docId: DocId | null | undefined): boolean {
  return useDoc(docId, (d) => d?.ext.readOnly === true);
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run an async job and show failures as a toast (never throws). Returns false when it failed. */
export async function guard(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    console.warn(`[${FEATURE}] ${label} failed`, e);
    actions.toast(`${label} failed: ${errorMessage(e)}`, { kind: 'error' });
    return false;
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
