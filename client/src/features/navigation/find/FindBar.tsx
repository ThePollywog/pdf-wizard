/**
 * Floating Find bar (top-right of the document viewer): query, previous / next, "3 of 17",
 * Match case / Whole words options, and a link to Advanced Search.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, Search, Settings2, TextSearch, X } from 'lucide-react';
import { Dropdown, IconButton, Spinner } from '@/core/ui';
import { matchShortcut } from '@/core/ui';
import { find, useFind } from './findStore';
import { normalizeQuery } from './text';
import { openAdvancedSearch } from './SearchPanel';

export function FindBar({ docId }: { docId: string }) {
  const open = useFind((s) => s.open);
  if (!open) return null;
  return <FindBarInner docId={docId} />;
}

function FindBarInner({ docId }: { docId: string }) {
  const query = useFind((s) => s.query);
  const matchCase = useFind((s) => s.matchCase);
  const wholeWords = useFind((s) => s.wholeWords);
  const results = useFind((s) => s.results);
  const currentKey = useFind((s) => s.currentKey);
  const searching = useFind((s) => s.searching);
  const scanned = useFind((s) => s.scanned);
  const total = useFind((s) => s.total);
  const forDoc = useFind((s) => s.docId);
  const focusNonce = useFind((s) => s.focusNonce);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, [focusNonce]);

  const hasQuery = !!normalizeQuery(query, matchCase);
  const n = forDoc === docId ? results.length : 0;
  const idx = n ? results.findIndex((m) => m.key === currentKey) : -1;
  let count = '';
  if (hasQuery) {
    if (n) count = `${idx >= 0 ? idx + 1 : 0} of ${n}${searching ? '+' : ''}`;
    else count = searching ? 'Searching…' : 'No results';
  }
  const noResults = hasQuery && !searching && n === 0;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const ne = e.nativeEvent;
    if (e.key === 'Enter') {
      e.preventDefault();
      find.step(e.shiftKey ? -1 : 1);
    } else if (matchShortcut(ne, 'mod+shift+g')) {
      e.preventDefault();
      find.step(-1);
    } else if (matchShortcut(ne, 'mod+g')) {
      e.preventDefault();
      find.step(1);
    } else if (matchShortcut(ne, 'mod+f')) {
      e.preventDefault();
      e.currentTarget.select();
    } else if (matchShortcut(ne, 'mod+shift+f')) {
      e.preventDefault();
      openAdvancedSearch(query);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeAndFocusViewer();
    } else return;
    e.stopPropagation();
  };

  return (
    <div
      className="navigation-findbar"
      role="search"
      aria-label="Find in document"
      data-testid="navigation-findbar"
      data-viewer-passthrough=""
      data-no-shortcuts=""
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <label className={`navigation-find-field${noResults ? ' is-none' : ''}`}>
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Find text"
          aria-label="Find text"
          spellCheck={false}
          autoComplete="off"
          data-testid="navigation-find-input"
          onChange={(e) => find.setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="navigation-find-count" aria-live="polite" data-testid="navigation-find-count" title={searching && total ? `Searched ${scanned} of ${total} pages` : undefined}>
          {searching && hasQuery && <Spinner size={12} />}
          {count}
        </span>
      </label>
      <IconButton icon={ChevronUp} size="sm" label="Previous result" shortcut="shift+enter" disabled={!n} onClick={() => find.step(-1)} data-testid="navigation-find-prev" />
      <IconButton icon={ChevronDown} size="sm" label="Next result" shortcut="enter" disabled={!n} onClick={() => find.step(1)} data-testid="navigation-find-next" />
      <Dropdown
        align="end"
        label="Find options"
        items={[
          { id: 'navigation.find.matchCase', label: 'Match case', checked: matchCase, run: () => find.setOptions({ matchCase: !matchCase }) },
          { id: 'navigation.find.wholeWords', label: 'Whole words only', checked: wholeWords, run: () => find.setOptions({ wholeWords: !wholeWords }) },
          'divider',
          { id: 'navigation.find.advanced', label: 'Open full search', icon: TextSearch, shortcut: 'mod+shift+f', run: () => openAdvancedSearch(query) },
        ]}
        trigger={<IconButton icon={Settings2} size="sm" label="Find options" active={matchCase || wholeWords} data-testid="navigation-find-options" />}
      />
      <IconButton icon={X} size="sm" label="Close" shortcut="escape" onClick={closeAndFocusViewer} data-testid="navigation-find-close" />
    </div>
  );
}

function closeAndFocusViewer() {
  const docId = useFind.getState().docId;
  find.close();
  const scroller = document.querySelector<HTMLElement>(`.pdfwizard-viewer[data-doc-id="${CSS.escape(docId ?? '')}"] .pdfwizard-scroller`);
  scroller?.focus({ preventScroll: true });
}
