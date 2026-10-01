/** "Find text & redact" view of the Redact panel. */
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, Search, SearchX, X } from 'lucide-react';
import { actions, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, Checkbox, EmptyState, IconButton, ProgressBar, Radio, TextField } from '@/core/ui';
import { plural } from '../shared';
import { PATTERNS, cancelFind, clearFind, markSelectedResults, runFind, showDecorations } from './search';
import { redactUi, useRedactUi, type FindMode, type FindResult, type PatternId } from './uiStore';

const MODES: { value: FindMode; label: string }[] = [
  { value: 'single', label: 'Single word or phrase' },
  { value: 'multiple', label: 'Multiple words or phrases' },
  { value: 'patterns', label: 'Patterns' },
];

const MAX_ROWS = 2000;

function TermsEditor() {
  const terms = useRedactUi((s) => s.find.multiple);
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(/[\n;]+/).map((t) => t.trim()).filter(Boolean);
    if (!parts.length) return;
    redactUi.patchFind((f) => ({ multiple: [...f.multiple, ...parts.filter((p) => !f.multiple.includes(p))] }));
    setDraft('');
  };
  return (
    <div className="protect-redact-terms">
      <div className="protect-redact-terms-add">
        <TextField
          size="sm"
          aria-label="Word or phrase to add"
          placeholder="Add a word or phrase"
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          data-testid="protect-redact-find-add-input"
        />
        <IconButton size="sm" icon={Plus} label="Add to the list" onClick={add} disabled={!draft.trim()} data-testid="protect-redact-find-add" />
      </div>
      {terms.length > 0 ? (
        <ul className="protect-redact-terms-list" data-testid="protect-redact-find-terms">
          {terms.map((t, i) => (
            <li key={`${t}-${i}`} className="protect-redact-term">
              <span title={t}>{t}</span>
              <button
                type="button"
                className="protect-redact-term-remove"
                aria-label={`Remove “${t}”`}
                onClick={() => redactUi.patchFind((f) => ({ multiple: f.multiple.filter((_, j) => j !== i) }))}
                data-testid={`protect-redact-find-term-remove-${i}`}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="protect-redact-muted">Add each word or phrase you want to find.</p>
      )}
    </div>
  );
}

function PatternsEditor() {
  const patterns = useRedactUi((s) => s.find.patterns);
  const toggle = (id: PatternId, on: boolean) =>
    redactUi.patchFind((f) => ({ patterns: on ? [...f.patterns.filter((p) => p !== id), id] : f.patterns.filter((p) => p !== id) }));
  return (
    <div className="protect-redact-patterns">
      {PATTERNS.map((p) => (
        <span key={p.id} data-testid={`protect-redact-find-pattern-${p.id}`}>
          <Checkbox label={p.label} description={p.example} checked={patterns.includes(p.id)} onChange={(on) => toggle(p.id, on)} />
        </span>
      ))}
    </div>
  );
}

interface Group {
  pageIndex: number;
  results: FindResult[];
}

function Results({ docId }: { docId: DocId }) {
  const results = useRedactUi((s) => s.find.results);
  const checked = useRedactUi((s) => s.find.checked);
  const activeId = useRedactUi((s) => s.find.activeId);
  const summary = useRedactUi((s) => s.find.summary);
  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const r of results.slice(0, MAX_ROWS)) {
      const last = out[out.length - 1];
      if (last && last.pageIndex === r.pageIndex) last.results.push(r);
      else out.push({ pageIndex: r.pageIndex, results: [r] });
    }
    return out;
  }, [results]);
  const nChecked = results.filter((r) => checked[r.id]).length;
  const pages = new Set(results.map((r) => r.pageIndex)).size;

  const setChecked = (ids: string[], on: boolean) => {
    redactUi.patchFind((f) => {
      const next = { ...f.checked };
      for (const id of ids) next[id] = on;
      return { checked: next };
    });
    showDecorations(docId);
  };
  const open = (r: FindResult) => {
    redactUi.patchFind({ activeId: r.id });
    showDecorations(docId);
    actions.goToPage(docId, r.pageIndex, { rect: r.rects[0], behavior: 'smooth' });
  };

  if (!results.length) {
    return (
      <EmptyState
        compact
        icon={SearchX}
        title="No matches found"
        description={summary ? `Nothing matched ${summary}. Scanned pages without a text layer can’t be searched; mark them with an area or page mark.` : undefined}
      />
    );
  }
  return (
    <div className="protect-redact-results" data-testid="protect-redact-find-results">
      <div className="protect-redact-results-head">
        <span data-testid="protect-redact-find-select-all">
          <Checkbox
            label={<span data-testid="protect-redact-find-summary">{`${plural(results.length, 'result')} on ${plural(pages, 'page')}`}</span>}
            checked={nChecked === results.length}
            indeterminate={nChecked > 0 && nChecked < results.length}
            onChange={(on) => setChecked(results.map((r) => r.id), on)}
          />
        </span>
      </div>
      <div className="protect-redact-results-list" role="list">
        {groups.map((g) => {
          const ids = g.results.map((r) => r.id);
          const n = ids.filter((id) => checked[id]).length;
          return (
            <div key={g.pageIndex} className="protect-redact-results-group" role="listitem" data-testid={`protect-redact-find-page-${g.pageIndex}`}>
              <div className="protect-redact-results-page">
                <Checkbox
                  label={`Page ${g.pageIndex + 1}`}
                  checked={n === ids.length}
                  indeterminate={n > 0 && n < ids.length}
                  onChange={(on) => setChecked(ids, on)}
                />
                <span className="protect-redact-badge">{g.results.length}</span>
              </div>
              {g.results.map((r) => (
                <div key={r.id} className={`protect-redact-result${activeId === r.id ? ' is-active' : ''}`} data-testid="protect-redact-find-result" data-result-id={r.id}>
                  <span data-testid="protect-redact-find-result-check">
                    <Checkbox label={<span className="sr-only">{`Select “${r.text}”`}</span>} checked={!!checked[r.id]} onChange={(on) => setChecked([r.id], on)} />
                  </span>
                  <button type="button" className="protect-redact-result-text" onClick={() => open(r)} title={`${r.before}${r.text}${r.after}`} data-testid="protect-redact-find-result-open">
                    {r.before && <span className="protect-redact-ctx">{r.before}</span>}
                    <mark>{r.text}</mark>
                    {r.after && <span className="protect-redact-ctx">{r.after}</span>}
                  </button>
                </div>
              ))}
            </div>
          );
        })}
        {results.length > MAX_ROWS && <p className="protect-redact-muted">Showing the first {MAX_ROWS} results; all {results.length} are marked when selected.</p>}
      </div>
      <Button variant="primary" className="protect-redact-wide" disabled={!nChecked} onClick={() => markSelectedResults(docId)} data-testid="protect-redact-find-mark">
        {nChecked ? `Mark ${plural(nChecked, 'result')} for redaction` : 'Mark selected results for redaction'}
      </Button>
    </div>
  );
}

export function FindPanel({ docId }: { docId: DocId }) {
  const f = useRedactUi((s) => s.find);
  const version = useDoc(docId, (d) => d?.version ?? -1);

  // Results belong to one version of one document.
  useEffect(() => {
    const r = redactUi.get().find.resultsFor;
    if (r && (r.docId !== docId || r.version !== version)) clearFind(r.docId);
  }, [docId, version]);

  const canRun = f.mode === 'single' ? !!f.single.trim() : f.mode === 'multiple' ? f.multiple.length > 0 : f.patterns.length > 0;
  const run = () => {
    if (canRun && !f.running) void runFind(docId);
  };
  const hasResults = !!f.resultsFor && f.resultsFor.docId === docId;

  return (
    <div className="protect-redact-find" data-testid="protect-redact-find-panel">
      <div className="protect-redact-subhead">
        <IconButton size="sm" icon={ArrowLeft} label="Back to Redact" onClick={() => redactUi.setView('main')} data-testid="protect-redact-find-back" />
        <span>Find text & redact</span>
      </div>
      <section className="panel-section protect-redact-section">
        <div className="protect-redact-radios" role="radiogroup" aria-label="Search for">
          {MODES.map((m) => (
            <span key={m.value} data-testid={`protect-redact-find-mode-${m.value}`}>
              <Radio name="protect-redact-find-mode" value={m.value} label={m.label} checked={f.mode === m.value} onChange={() => redactUi.patchFind({ mode: m.value })} />
            </span>
          ))}
        </div>
        {f.mode === 'single' && (
          <TextField
            size="sm"
            icon={Search}
            aria-label="Word or phrase to find"
            placeholder="Enter a word or phrase"
            value={f.single}
            onChange={(single) => redactUi.patchFind({ single })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                run();
              }
            }}
            data-testid="protect-redact-find-input"
          />
        )}
        {f.mode === 'multiple' && <TermsEditor />}
        {f.mode === 'patterns' && <PatternsEditor />}
        {f.mode !== 'patterns' && (
          <div className="protect-redact-find-options">
            <span data-testid="protect-redact-find-match-case">
              <Checkbox label="Match case" checked={f.matchCase} onChange={(matchCase) => redactUi.patchFind({ matchCase })} />
            </span>
            <span data-testid="protect-redact-find-whole-words">
              <Checkbox label="Whole words only" checked={f.wholeWords} onChange={(wholeWords) => redactUi.patchFind({ wholeWords })} />
            </span>
          </div>
        )}
        <div className="protect-redact-row">
          {f.running ? (
            <>
              <ProgressBar
                className="protect-redact-grow"
                size="sm"
                value={f.progress ? f.progress.done / Math.max(1, f.progress.total) : null}
                label={f.progress ? `Searching page ${Math.min(f.progress.total, f.progress.done + 1)} of ${f.progress.total}…` : 'Searching…'}
              />
              <Button size="sm" onClick={cancelFind} data-testid="protect-redact-find-cancel">
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" icon={Search} disabled={!canRun} onClick={run} data-testid="protect-redact-find-run">
                Search
              </Button>
              {hasResults && (
                <Button variant="ghost" size="sm" onClick={() => clearFind(docId)} data-testid="protect-redact-find-clear">
                  Clear results
                </Button>
              )}
            </>
          )}
        </div>
      </section>
      {hasResults && !f.running && (
        <section className="panel-section protect-redact-section protect-redact-results-section">
          <Results docId={docId} />
        </section>
      )}
    </div>
  );
}
