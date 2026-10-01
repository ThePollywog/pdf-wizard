/** Panel notice for documents where markup is blocked (read-only) or kept in the user's copy (shared view only). */
import { Info, Lock } from 'lucide-react';
import type { DocId } from '@/core/types';
import { useApp, useDoc } from '@/core/store';
import { isReadOnly } from '@/core/engine';

export function ReadOnlyNotice() {
  const docId = useApp((s) => s.activeDocId) as DocId | null;
  const shared = useDoc(docId, (d) => d?.ext.readOnly === true);
  // The engine flag is set while opening; re-check whenever the document's PDF changes.
  useDoc(docId, (d) => d?.pdfVersion ?? 0);
  if (!docId) return null;
  if (isReadOnly(docId)) {
    return (
      <div className="drawing-notice is-warning" role="status" data-testid="drawing-readonly-notice">
        <Lock size={14} strokeWidth={2} aria-hidden />
        <span>This document is open read-only, so drawings, stamps and measurements can’t be added.</span>
      </div>
    );
  }
  if (shared) {
    return (
      <div className="drawing-notice" role="status" data-testid="drawing-shared-notice">
        <Info size={14} strokeWidth={2} aria-hidden />
        <span>Shared with you as view only. Your markup is kept in your own copy when you save.</span>
      </div>
    );
  }
  return null;
}
