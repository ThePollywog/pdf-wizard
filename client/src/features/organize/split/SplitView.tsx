/**
 * MainView of "Split a PDF": split options bar, a preview grid showing where the document is
 * split (click between two pages to add / remove a split point) and the list of output files.
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, FileStack, Scissors, X } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, useApp, useDoc } from '@/core/store';
import { Button, Divider, EmptyState, NumberField, Select, Spinner, TextField } from '@/core/ui';
import { PageGrid, type SplitDecoration } from '../grid/PageGrid';
import { organize, useOrganize, type SplitMethod, type SplitOutput } from '../store';
import { formatRanges, plural } from '../ranges';
import { MAX_TABS, runSplit } from './run';
import { toggledRanges, useSplitPlan, type SplitPlan } from './plan';

const METHODS: { value: SplitMethod; label: string }[] = [
  { value: 'pages', label: 'Number of pages' },
  { value: 'size', label: 'File size' },
  { value: 'bookmarks', label: 'Top-level bookmarks' },
  { value: 'ranges', label: 'Page ranges' },
];

export function SplitView() {
  const docId = useApp((s) => s.activeDocId);
  const exists = useDoc(docId, (d) => !!d && !d.loadError);
  if (!docId || !exists) {
    return (
      <div className="organize-view organize-view-empty" data-testid="organize-split">
        <EmptyState icon={Scissors} title="No document open" description="Open a PDF to split it into several files." />
      </div>
    );
  }
  return <SplitBody docId={docId} />;
}

function SplitBody({ docId }: { docId: DocId }) {
  const s = useOrganize((st) => st.split);
  const count = useDoc(docId, (d) => d?.pages.length ?? 0);
  const plan = useSplitPlan(docId);
  const [rangesDraft, setRangesDraft] = useState(s.ranges);
  const [running, setRunning] = useState(false);

  // Keep the text box in sync when split points are toggled in the grid.
  useEffect(() => setRangesDraft(s.ranges), [s.ranges]);

  const tooManyTabs = plan.groups.length > MAX_TABS;
  const output: SplitOutput = s.output === 'tabs' && tooManyTabs ? 'zip' : s.output;
  const canRun = !plan.error && !plan.computing && plan.groups.length >= 1 && !running;

  const onToggle = (gap: number) => {
    const groups = plan.groups.length ? plan.groups : [Array.from({ length: count }, (_, i) => i)];
    organize.setSplit({ method: 'ranges', ranges: toggledRanges(groups, count, plan.contiguous || !plan.groups.length, gap) });
  };
  const decoration: SplitDecoration = { partOf: plan.partOf, starts: plan.starts, onToggle: plan.computing ? undefined : onToggle };

  const run = async () => {
    setRunning(true);
    try {
      await runSplit(docId, plan.groups, plan.names, output);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="organize-view organize-split" data-testid="organize-split">
      <div className="organize-toolbar organize-split-bar" role="toolbar" aria-label="Split options" data-testid="organize-split-bar">
        <Select<SplitMethod>
          label="Split by"
          inline
          size="sm"
          value={s.method}
          options={METHODS}
          onChange={(method) => {
            if (method === 'ranges' && !s.ranges && plan.groups.length && plan.contiguous) {
              organize.setSplit({ method, ranges: toggledRanges(plan.groups, count, true, -1) });
            } else organize.setSplit({ method });
          }}
          data-testid="organize-split-method"
        />
        {s.method === 'pages' && (
          <div data-testid="organize-split-pages">
            <NumberField label="Pages per file" inline size="sm" value={s.pages} min={1} max={Math.max(1, count)} width={76} onChange={(pages) => organize.setSplit({ pages })} />
          </div>
        )}
        {s.method === 'size' && (
          <div data-testid="organize-split-size">
            <NumberField label="Max size" inline size="sm" value={s.sizeMb} min={0.1} max={2000} step={0.5} precision={1} suffix="MB" width={96} onChange={(sizeMb) => organize.setSplit({ sizeMb })} />
          </div>
        )}
        {s.method === 'bookmarks' && (
          <span className="organize-split-note" data-testid="organize-split-bookmarks">
            {plan.titles.filter(Boolean).length ? `${plural(plan.titles.filter(Boolean).length, 'bookmark', 'bookmarks')}` : 'No top-level bookmarks'}
          </span>
        )}
        {s.method === 'ranges' && (
          <form
            className="organize-split-ranges"
            onSubmit={(e) => {
              e.preventDefault();
              organize.setSplit({ ranges: rangesDraft });
            }}
          >
            <TextField
              label="Ranges"
              inline
              size="sm"
              value={rangesDraft}
              placeholder="1-3, 4-6, 7-"
              onChange={setRangesDraft}
              onBlur={() => organize.setSplit({ ranges: rangesDraft })}
              aria-label="Page ranges, one file per range"
              data-testid="organize-split-ranges"
            />
          </form>
        )}
        <Divider vertical className="organize-toolbar-divider" />
        <Select<SplitOutput>
          label="Output"
          inline
          size="sm"
          value={output}
          options={[
            { value: 'zip', label: 'Download as ZIP' },
            { value: 'library', label: 'Save to your files' },
            { value: 'tabs', label: tooManyTabs ? `Open as tabs (max ${MAX_TABS} files)` : 'Open as tabs', disabled: tooManyTabs },
          ]}
          onChange={(o) => organize.setSplit({ output: o })}
          data-testid="organize-split-output"
        />
        <div className="organize-toolbar-spacer" />
        <div className="organize-toolbar-end">
          <Button variant="secondary" size="sm" icon={X} onClick={() => actions.openTask(null)} data-testid="organize-split-cancel">
            Close
          </Button>
          <Button variant="primary" size="sm" icon={Scissors} disabled={!canRun} loading={running} onClick={() => void run()} data-testid="organize-split-run">
            {plan.groups.length >= 2 ? `Split into ${plan.groups.length}` : 'Split'}
          </Button>
        </div>
      </div>
      <SplitSummary plan={plan} />
      <div className="organize-split-body">
        <PageGrid docId={docId} editable={false} split={decoration} ariaLabel="Split preview" />
        <PartList plan={plan} />
      </div>
    </div>
  );
}

function SplitSummary({ plan }: { plan: SplitPlan }) {
  if (plan.error) {
    return (
      <div className="organize-banner is-warning" role="alert" data-testid="organize-split-error">
        <AlertTriangle size={16} aria-hidden />
        <span>{plan.error}</span>
      </div>
    );
  }
  if (plan.computing) {
    return (
      <div className="organize-banner is-info" role="status" data-testid="organize-split-summary">
        <Spinner size={14} label="Estimating" />
        <span>Estimating page sizes…</span>
      </div>
    );
  }
  return (
    <div className="organize-banner is-info" role="status" data-testid="organize-split-summary">
      <FileStack size={16} aria-hidden />
      <span>
        <strong>{plural(plan.groups.length, 'file', 'files')}</strong> will be created.
        {plan.skipped > 0 && ` ${plural(plan.skipped, 'page isn’t', 'pages aren’t')} in any range and won’t be included.`} Click between two pages to add or remove a
        split point.
      </span>
    </div>
  );
}

function PartList({ plan }: { plan: SplitPlan }) {
  if (!plan.groups.length) return null;
  return (
    <aside className="organize-split-parts" aria-label="Output files">
      <h3>Output files</h3>
      <ol data-testid="organize-split-parts">
        {plan.groups.map((g, k) => (
          <li key={k} className={clsx('organize-split-part', `organize-part-${k % 6}`)} data-testid="organize-split-part">
            <span className="organize-split-swatch" aria-hidden />
            <span className="organize-split-part-text">
              <span className="organize-split-part-name" data-testid="organize-split-part-name">
                {plan.names[k]}
              </span>
              <span className="organize-split-part-pages">
                {plan.titles[k] ? `${plan.titles[k]} · ` : ''}
                {g.length === 1 ? `Page ${g[0] + 1}` : `Pages ${formatRanges(g)}`} ({plural(g.length, 'page', 'pages')})
              </span>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
