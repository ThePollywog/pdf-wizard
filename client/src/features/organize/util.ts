/** Small helpers shared by the organize feature. */
import { actions, getDoc, useApp } from '@/core/store';
import type { DocId } from '@/core/types';
import * as engine from '@/core/engine';
import { baseName } from '@/core/util';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Toast an expected failure (never console.error: the message is the report). */
export function toastError(e: unknown) {
  actions.toast(errMsg(e), { kind: 'error' });
}

/** Run a page operation; failures become an error toast. Resolves true on success. */
export async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/**
 * Run a job behind the blocking progress overlay. Errors become a toast (no console.error) and
 * resolve undefined.
 */
export async function runBusy<T>(label: string, fn: (report: (p: number | null, label?: string) => void) => Promise<T>): Promise<T | undefined> {
  actions.setBusy({ label, progress: null });
  const report = (progress: number | null, l?: string) => {
    const b = useApp.getState().busy;
    actions.setBusy({ label: l ?? b?.label ?? label, progress });
  };
  try {
    return await fn(report);
  } catch (e) {
    toastError(e);
    return undefined;
  } finally {
    actions.setBusy(null);
  }
}

export const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/** Engine read-only (couldn't be decrypted for editing): page operations are unavailable. */
export function readOnlyReason(docId: DocId | null | undefined): string | null {
  if (!docId || !engine.isReadOnly(docId)) return null;
  const ext = getDoc(docId)?.ext?.engine as { reason?: string } | undefined;
  return ext?.reason ?? 'its security settings prevent editing';
}

/** The document name without its extension. */
export function stem(name: string) {
  return baseName(name) || 'Document';
}

export const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;
