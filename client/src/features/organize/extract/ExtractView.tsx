/**
 * MainView of "Extract PDF pages": select pages in the grid or type a range (both stay in sync),
 * choose the options and extract into a new document or a download.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, FileOutput, MousePointerSquareDashed, X } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, useApp, useDoc } from '@/core/store';
import { Button, Checkbox, Dropdown, EmptyState, Select, TextField } from '@/core/ui';
import { PageGrid } from '../grid/PageGrid';
import { organize, selectedIndices, useOrganize, useSelection, type ExtractOutput } from '../store';
import { formatRanges, parseRanges, plural } from '../ranges';
import { readOnlyReason } from '../util';
import { selectMenu } from '../OrganizeToolbar';
import { runExtract } from './run';

export function ExtractView() {
  const docId = useApp((s) => s.activeDocId);
  const exists = useDoc(docId, (d) => !!d && !d.loadError);
  if (!docId || !exists) {
    return (
      <div className="organize-view organize-view-empty" data-testid="organize-extract-view">
        <EmptyState icon={FileOutput} title="No document open" description="Open a PDF to extract some of its pages into a new file." />
      </div>
    );
  }
  return <ExtractBody docId={docId} />;
}

function ExtractBody({ docId }: { docId: DocId }) {
  const doc = useDoc(docId, (d) => d);
  const sel = useSelection(docId);
  const opts = useOrganize((s) => s.extract);
  const indices = selectedIndices(doc, sel);
  const count = doc?.pages.length ?? 0;
  const [draft, setDraft] = useState(() => formatRanges(indices));
  const [running, setRunning] = useState(false);
  const editing = useRef(false);
  const errorId = useId();
  const selText = formatRanges(indices);

  // Grid selection → range text (unless the user is typing in it).
  useEffect(() => {
    if (!editing.current) setDraft(selText);
  }, [selText]);

  const parsed = draft.trim() ? parseRanges(draft, count) : { indices: [], error: null };
  const error = draft.trim() ? parsed.error : null;
  const n = indices.length;
  const ro = readOnlyReason(docId);
  const all = n >= count;
  const canDelete = !ro && !all;
  const multi = opts.separate && n > 1;

  const onRange = (v: string) => {
    setDraft(v);
    if (!v.trim()) {
      organize.clear(docId);
      return;
    }
    const r = parseRanges(v, count);
    if (!r.error) {
      organize.selectIndices(docId, r.indices);
      if (r.indices.length && doc) organize.reveal(docId, doc.pages[r.indices[0]].id);
    }
  };

  const run = async () => {
    if (!n || error || ro || running) return;
    setRunning(true);
    try {
      const ok = await runExtract(docId, { indices, deleteAfter: opts.deleteAfter && canDelete, separate: multi, output: opts.output });
      if (ok && opts.output === 'download') organize.clear(docId);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="organize-view organize-extract" data-testid="organize-extract-view">
      <div className="organize-toolbar organize-extract-bar" role="toolbar" aria-label="Extract options" data-testid="organize-extract-bar">
        <Dropdown
          label="Select pages"
          items={() => selectMenu(docId)}
          trigger={
            <Button variant="ghost" size="sm" icon={MousePointerSquareDashed} iconEnd={ChevronDown} aria-label="Select pages" tooltip="Select pages" data-testid="organize-select-menu">
              <span className="organize-tb-label">Select</span>
            </Button>
          }
        />
        <form
          className="organize-extract-range"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <TextField
            label="Pages"
            inline
            size="sm"
            value={draft}
            placeholder={`e.g. 1-3, 5 (of ${count})`}
            onChange={onRange}
            onFocus={() => (editing.current = true)}
            onBlur={() => {
              editing.current = false;
              if (!parsed.error) setDraft(selText);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            aria-label="Pages to extract"
            data-testid="organize-extract-range"
          />
        </form>
        <div data-testid="organize-extract-delete">
          <Checkbox
            label="Delete pages after extracting"
            checked={opts.deleteAfter && canDelete}
            disabled={!canDelete}
            onChange={(v) => organize.setExtract({ deleteAfter: v })}
          />
        </div>
        <div data-testid="organize-extract-separate">
          <Checkbox label="Extract as separate files" checked={opts.separate} onChange={(v) => organize.setExtract({ separate: v })} />
        </div>
        <Select<ExtractOutput>
          aria-label="Output"
          size="sm"
          value={opts.output}
          options={[
            { value: 'open', label: multi ? 'Open in new tabs' : 'Open in a new tab' },
            { value: 'download', label: multi ? 'Download as ZIP' : 'Download' },
          ]}
          onChange={(output) => organize.setExtract({ output })}
          data-testid="organize-extract-output"
        />
        <div className="organize-toolbar-spacer" />
        <div className="organize-toolbar-end">
          <Button variant="secondary" size="sm" icon={X} onClick={() => actions.openTask(null)} data-testid="organize-extract-cancel">
            Close
          </Button>
          <Button variant="primary" size="sm" icon={FileOutput} disabled={!n || !!error || running || !!ro} loading={running} onClick={() => void run()} data-testid="organize-extract-run">
            Extract
          </Button>
        </div>
      </div>
      {error && (
        <div className="organize-banner is-warning" role="alert" id={errorId} data-testid="organize-extract-error">
          <AlertTriangle size={16} aria-hidden />
          <span>{error}</span>
        </div>
      )}
      {ro && (
        <div className="organize-banner is-warning" role="status" data-testid="organize-readonly">
          <span>This document is read-only because {ro}. Its pages can't be copied into a new file.</span>
        </div>
      )}
      <PageGrid docId={docId} editable={false} ariaLabel="Pages to extract" />
      <div className="organize-status" data-testid="organize-status" aria-live="polite">
        <span data-testid="organize-status-count">
          {n ? `${n} of ${plural(count, 'page', 'pages')} selected for extraction` : 'Select the pages to extract'}
        </span>
        <span className="organize-status-tips">
          {multi ? `Creates ${n} one-page PDFs` : n ? 'Creates one PDF' : 'Click, Shift-click or drag a box around pages to select them'}
        </span>
      </div>
    </div>
  );
}
