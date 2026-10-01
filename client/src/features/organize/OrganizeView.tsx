/** MainView of "Organize pages" (and the lightweight page tasks): toolbar, hint, grid, status bar. */
import { useEffect } from 'react';
import { Info, Lock, X } from 'lucide-react';
import { useApp, useDoc } from '@/core/store';
import { EmptyState, IconButton } from '@/core/ui';
import { LayoutGrid } from 'lucide-react';
import { PageGrid } from './grid/PageGrid';
import { OrganizeToolbar } from './OrganizeToolbar';
import { organize, selectedIndices, useOrganize, useSelection } from './store';
import { FOCUS_HINTS, focusActionFor } from './tasks';
import { readOnlyReason } from './util';
import { formatRanges } from './ranges';
import { isMac } from '@/core/util';

export function OrganizeView() {
  const docId = useApp((s) => s.activeDocId);
  const taskId = useApp((s) => s.activeTaskId);
  const doc = useDoc(docId, (d) => d);
  const sel = useSelection(docId);
  const hintDismissed = useOrganize((s) => s.hintDismissed);
  const focusAction = focusActionFor(taskId);

  // Drop selections of documents that were closed.
  useEffect(() => {
    const docs = useApp.getState().docs;
    for (const id of Object.keys(useOrganize.getState().selection)) if (!docs[id]) organize.forget(id);
  }, [docId]);

  if (!docId || !doc) {
    return (
      <div className="organize-view organize-view-empty" data-testid="organize-view">
        <EmptyState icon={LayoutGrid} title="No document open" description="Open a PDF to reorder, rotate, insert and delete its pages." />
      </div>
    );
  }

  const targets = (() => {
    const s = selectedIndices(doc, sel);
    if (s.length) return s;
    return [];
  })();
  const count = doc.pages.length;
  const ro = readOnlyReason(docId);
  const hint = focusAction && !hintDismissed ? FOCUS_HINTS[focusAction] : null;
  const mod = isMac ? '⌘' : 'Ctrl';

  return (
    <div className="organize-view" data-testid="organize-view" data-doc-id={docId}>
      <OrganizeToolbar docId={docId} targets={targets} focusAction={focusAction} />
      {ro && (
        <div className="organize-banner is-warning" role="status" data-testid="organize-readonly">
          <Lock size={16} aria-hidden />
          <span>This document is read-only because {ro}. You can browse its pages, but not change, extract or split them.</span>
        </div>
      )}
      {hint && (
        <div className="organize-banner is-info" role="note" data-testid="organize-hint">
          <Info size={16} aria-hidden />
          <span>
            <strong>{hint.title}.</strong> {hint.text}
          </span>
          <IconButton size="sm" icon={X} label="Dismiss" onClick={() => organize.dismissHint()} data-testid="organize-hint-dismiss" />
        </div>
      )}
      <PageGrid docId={docId} />
      <div className="organize-status" data-testid="organize-status" aria-live="polite">
        <span data-testid="organize-status-count">
          {targets.length
            ? `${targets.length} of ${count} ${count === 1 ? 'page' : 'pages'} selected${targets.length <= 12 ? ` (${formatRanges(targets)})` : ''}`
            : `${count} ${count === 1 ? 'page' : 'pages'}`}
        </span>
        <span className="organize-status-tips">
          {ro ? 'Double-click a page to open it' : `Drag to reorder · Shift/${mod}-click to select several · Double-click to open`}
        </span>
      </div>
    </div>
  );
}
