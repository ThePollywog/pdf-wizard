/**
 * Per-document signature state: the signature fields shown on the pages (from `doc.bytes`) and the
 * verification of the signatures in the file (from the file bytes as opened / last signed).
 * Both are recomputed when the document's bytes change.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import * as engine from '@/core/engine';
import { getDoc, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { listSignatureFields, type SignatureField } from './pdf';
import { verifyDocument, type SignatureReport } from './sign';

export const TASK_ID = 'digital-sign';
export const TOOL_PLACE = 'digital-sign-place';
export const PANEL_ID = 'signatures';

interface DocSigState {
  version: number;
  fields: SignatureField[];
  reports: SignatureReport[] | null;
  /** Verification is running. */
  checking: boolean;
}

interface SigStore {
  docs: Record<DocId, DocSigState | undefined>;
}

export const useSigStore = create<SigStore>(() => ({ docs: {} }));

const running = new Map<DocId, number>();

/** (Re)load fields and verification for the document's current version. */
export async function refresh(docId: DocId): Promise<void> {
  const d = getDoc(docId);
  if (!d) return;
  const version = d.version;
  if (running.get(docId) === version) return;
  running.set(docId, version);
  const prev = useSigStore.getState().docs[docId];
  useSigStore.setState((s) => ({ docs: { ...s.docs, [docId]: { version, fields: prev?.fields ?? [], reports: prev?.reports ?? null, checking: true } } }));
  try {
    const fields = await listSignatureFields(d.bytes);
    const file = engine.getFileBytes(docId);
    const reports = await verifyDocument(file ?? d.bytes);
    if (getDoc(docId)?.version !== version) return;
    useSigStore.setState((s) => ({ docs: { ...s.docs, [docId]: { version, fields, reports, checking: false } } }));
  } catch (e) {
    console.error('[digital-sign] reading signatures failed', e);
    useSigStore.setState((s) => ({ docs: { ...s.docs, [docId]: { version, fields: [], reports: [], checking: false } } }));
  } finally {
    if (running.get(docId) === version) running.delete(docId);
  }
}

/** Signature state of a document, refreshed whenever its bytes change. */
export function useSignatures(docId: DocId | null | undefined): DocSigState | undefined {
  const version = useDoc(docId ?? null, (d) => d?.version);
  const ready = useDoc(docId ?? null, (d) => !!d && !d.loadError && d.pages.length > 0);
  const st = useSigStore((s) => (docId ? s.docs[docId] : undefined));
  useEffect(() => {
    if (docId && ready && version !== undefined && st?.version !== version) void refresh(docId);
  }, [docId, version, ready, st?.version]);
  return st;
}
