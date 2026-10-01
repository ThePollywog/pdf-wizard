/**
 * Advanced Search panel (right panel "Search"): full-document search with results grouped by page
 * and context snippets, plus optional search of comments and bookmarks.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { create } from 'zustand';
import { Bookmark, ChevronDown, ChevronRight, MessageSquare, Search, TextSearch, X } from 'lucide-react';
import type { DocId, ObjectId } from '@/core/types';
import { reg } from '@/core/registry';
import { actions, getDoc, pageIndexOf, useApp, useDoc } from '@/core/store';
import { Button, Checkbox, EmptyState, IconButton, ProgressBar } from '@/core/ui';
import { scrollToObject } from '@/core/viewer';
import { readLocal, writeLocal } from '../util';
import { scanDocument, unionRect, type ScanHandle, type TextMatch } from './search';
import { findAll, normalize, normalizeQuery, snippet } from './text';
import type { BmItem } from '../bookmarks/model';
import { goToBookmark } from '../bookmarks/dest';

export const SEARCH_DECO_KEY = 'navigation-search-panel';

interface TextResult extends TextMatch {
  before: string;
  match: string;
  after: string;
}
interface CommentResult {
  id: ObjectId;
  pageIndex: number;
  label: string;
  before: string;
  match: string;
  after: string;
}
interface BookmarkResult {
  id: string;
  title: string;
  before: string;
  match: string;
  after: string;
}

interface SearchOpts {
  matchCase: boolean;
  wholeWords: boolean;
  comments: boolean;
  bookmarks: boolean;
}

interface PanelState {
  input: string;
  /** The query of the displayed results ('' = no search yet). */
  query: string;
  docId: DocId | null;
  opts: SearchOpts;
  results: TextResult[];
  comments: CommentResult[];
  bookmarks: BookmarkResult[];
  searching: boolean;
  scanned: number;
  total: number;
  selected: string | null;
  collapsed: Record<number, boolean>;
  focusNonce: number;
}

const OPTS_KEY = 'navigation.search.options';
const defaults: SearchOpts = { matchCase: false, wholeWords: false, comments: false, bookmarks: false };
const loadOpts = (): SearchOpts => {
  try {
    return { ...defaults, ...(JSON.parse(readLocal(OPTS_KEY, '{}')) as Partial<SearchOpts>) };
  } catch {
    return defaults;
  }
};

export const useSearchPanel = create<PanelState>(() => ({
  input: '',
  query: '',
  docId: null,
  opts: loadOpts(),
  results: [],
  comments: [],
  bookmarks: [],
  searching: false,
  scanned: 0,
  total: 0,
  selected: null,
  collapsed: {},
  focusNonce: 0,
}));
const sp = () => useSearchPanel.getState();
const setSp = (p: Partial<PanelState>) => useSearchPanel.setState(p);

let handle: ScanHandle | null = null;

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function searchObjects(docId: DocId, q: string, o: SearchOpts): CommentResult[] {
  const doc = getDoc(docId);
  if (!doc) return [];
  const nq = normalizeQuery(q, o.matchCase);
  const out: CommentResult[] = [];
  for (const id of Object.keys(doc.objects)) {
    const obj = doc.objects[id];
    const def = reg.objectType(obj.kind);
    if (def?.category && def.category !== 'comment') continue;
    const data = (obj.data ?? {}) as Record<string, unknown>;
    const texts = [obj.contents, textOf(data.text), ...(obj.replies ?? []).map((r) => r.text)].filter((t): t is string => !!t);
    for (const t of texts) {
      const norm = normalize(t, o.matchCase);
      const hit = findAll(norm.text, nq, o.wholeWords)[0];
      if (!hit) continue;
      const s = norm.map[hit[0]];
      const e = norm.map[hit[1] - 1] + 1;
      out.push({ id, pageIndex: pageIndexOf(doc, obj.pageId), label: `${def?.label ?? 'Comment'}${obj.author ? ` · ${obj.author}` : ''}`, ...snippet(t, s, e, 30) });
      break;
    }
  }
  return out.sort((a, b) => a.pageIndex - b.pageIndex);
}

function searchBookmarks(docId: DocId, q: string, o: SearchOpts): BookmarkResult[] {
  const nq = normalizeQuery(q, o.matchCase);
  const out: BookmarkResult[] = [];
  const walk = (items: BmItem[]) => {
    for (const it of items) {
      const norm = normalize(it.title, o.matchCase);
      const hit = findAll(norm.text, nq, o.wholeWords)[0];
      if (hit) out.push({ id: it.id, title: it.title, ...snippet(it.title, norm.map[hit[0]], norm.map[hit[1] - 1] + 1, 60) });
      if (it.children?.length) walk(it.children as BmItem[]);
    }
  };
  walk((getDoc(docId)?.outline ?? []) as BmItem[]);
  return out;
}

export function runPanelSearch(docId: DocId, query: string) {
  handle?.cancel();
  handle = null;
  const o = sp().opts;
  const q = query.trim();
  const doc = getDoc(docId);
  if (!doc || !normalizeQuery(q, o.matchCase)) {
    setSp({ query: '', docId, results: [], comments: [], bookmarks: [], searching: false, selected: null });
    actions.setDecorations(docId, SEARCH_DECO_KEY, null);
    return;
  }
  setSp({
    query: q,
    input: query,
    docId,
    results: [],
    comments: o.comments ? searchObjects(docId, q, o) : [],
    bookmarks: o.bookmarks ? searchBookmarks(docId, q, o) : [],
    searching: true,
    scanned: 0,
    total: doc.pages.length,
    selected: null,
    collapsed: {},
  });
  actions.setDecorations(docId, SEARCH_DECO_KEY, null);
  const h = scanDocument(
    docId,
    q,
    o,
    ({ matches, pages, scanned }) => {
      const byPage = new Map(pages.map((p) => [p.pageIndex, p]));
      const add: TextResult[] = matches.map((m) => ({ ...m, ...snippet(byPage.get(m.pageIndex)!.text, m.start, m.end) }));
      setSp({ results: add.length ? sp().results.concat(add) : sp().results, scanned });
    },
    { startPage: 0, batch: 6 },
  );
  handle = h;
  void h.done.then(() => {
    if (handle !== h) return;
    handle = null;
    setSp({ searching: false });
  });
}

export function stopPanelSearch() {
  handle?.cancel();
  handle = null;
  setSp({ searching: false });
}

/** Open the Search panel (mod+shift+f), optionally searching `query` right away. */
export function openAdvancedSearch(query?: string) {
  const s = useApp.getState();
  const docId = s.activeDocId;
  if (!docId || !getDoc(docId)) return;
  if (s.rightPanelId !== 'search') actions.setRightPanel('search');
  const q = query?.trim();
  setSp({ focusNonce: sp().focusNonce + 1, ...(q ? { input: q } : {}) });
  if (q && (q !== sp().query || sp().docId !== docId)) runPanelSearch(docId, q);
}

function selectText(docId: DocId, r: TextResult) {
  setSp({ selected: r.key });
  const doc = getDoc(docId);
  const page = doc?.pages[r.pageIndex];
  if (page) actions.setDecorations(docId, SEARCH_DECO_KEY, [{ pageId: page.id, rects: r.rects, active: true, className: 'navigation-search-hit' }]);
  actions.goToPage(docId, r.pageIndex, { rect: unionRect(r.rects), behavior: 'auto' });
}

function Snip({ before, match, after }: { before: string; match: string; after: string }) {
  return (
    <span className="navigation-snippet">
      {before}
      <mark>{match}</mark>
      {after}
    </span>
  );
}

const MAX_ROWS = 1000;

export function SearchPanel({ docId }: { docId: DocId }) {
  const st = useSearchPanel();
  const pdfVersion = useDoc(docId, (d) => d?.pdfVersion);
  const inputRef = useRef<HTMLInputElement>(null);
  const [limit, setLimit] = useState(MAX_ROWS);
  const forDoc = st.docId === docId;
  const results = forDoc ? st.results : [];
  const comments = forDoc ? st.comments : [];
  const bookmarks = forDoc ? st.bookmarks : [];

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [st.focusNonce]);

  // Results are stale after the document changes (pages edited, other doc activated).
  const lastVersion = useRef(pdfVersion);
  useEffect(() => {
    if (lastVersion.current === pdfVersion) return;
    lastVersion.current = pdfVersion;
    const s = sp();
    if (s.docId === docId && s.query) runPanelSearch(docId, s.query);
  }, [pdfVersion, docId]);

  // Clear the highlight when the panel closes.
  useEffect(
    () => () => {
      stopPanelSearch();
      if (getDoc(docId)?.decorations[SEARCH_DECO_KEY]) actions.setDecorations(docId, SEARCH_DECO_KEY, null);
    },
    [docId],
  );

  const groups = useMemo(() => {
    const out: { pageIndex: number; items: TextResult[] }[] = [];
    let shown = 0;
    for (const r of results) {
      if (shown >= limit) break;
      const last = out[out.length - 1];
      if (last && last.pageIndex === r.pageIndex) last.items.push(r);
      else out.push({ pageIndex: r.pageIndex, items: [r] });
      shown++;
    }
    return out.sort((a, b) => a.pageIndex - b.pageIndex);
  }, [results, limit]);
  const pageCount = useMemo(() => new Set(results.map((r) => r.pageIndex)).size, [results]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setLimit(MAX_ROWS);
    runPanelSearch(docId, st.input);
  };
  const setOpt = (p: Partial<SearchOpts>) => {
    const opts = { ...sp().opts, ...p };
    setSp({ opts });
    writeLocal(OPTS_KEY, JSON.stringify(opts));
    // Changing an option refreshes the results of the search on screen.
    const cur = sp();
    if (cur.docId === docId && cur.query) runPanelSearch(docId, cur.input.trim() ? cur.input : cur.query);
  };
  const pageLabel = (i: number) => {
    const p = getDoc(docId)?.pages[i];
    return p?.label && p.label !== String(i + 1) ? `Page ${p.label} (${i + 1})` : `Page ${i + 1}`;
  };
  const hasSearch = forDoc && !!st.query;
  const totalHits = results.length + comments.length + bookmarks.length;

  return (
    <div className="navigation-search" data-testid="navigation-search-panel">
      <form className="navigation-search-form" onSubmit={submit} role="search">
        <div className="navigation-search-field">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={st.input}
            onChange={(e) => setSp({ input: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && st.input) {
                e.preventDefault();
                e.stopPropagation();
                setSp({ input: '' });
              }
            }}
            placeholder="Search in document"
            aria-label="Search in document"
            data-testid="navigation-search-input"
          />
          {st.input && (
            <IconButton icon={X} size="sm" label="Clear" noTooltip onClick={() => (setSp({ input: '' }), inputRef.current?.focus())} data-testid="navigation-search-clear" />
          )}
        </div>
        <div className="navigation-search-opts">
          <span className="navigation-search-opt" data-testid="navigation-search-opt-whole">
            <Checkbox label="Whole words only" checked={st.opts.wholeWords} onChange={(v) => setOpt({ wholeWords: v })} />
          </span>
          <span className="navigation-search-opt" data-testid="navigation-search-opt-case">
            <Checkbox label="Case-sensitive" checked={st.opts.matchCase} onChange={(v) => setOpt({ matchCase: v })} />
          </span>
          <span className="navigation-search-opt" data-testid="navigation-search-opt-bookmarks">
            <Checkbox label="Include bookmarks" checked={st.opts.bookmarks} onChange={(v) => setOpt({ bookmarks: v })} />
          </span>
          <span className="navigation-search-opt" data-testid="navigation-search-opt-comments">
            <Checkbox label="Include comments" checked={st.opts.comments} onChange={(v) => setOpt({ comments: v })} />
          </span>
        </div>
        <div className="navigation-search-actions">
          {st.searching && forDoc ? (
            <Button size="sm" variant="secondary" onClick={stopPanelSearch} data-testid="navigation-search-stop">
              Stop
            </Button>
          ) : null}
          <Button size="sm" variant="primary" type="submit" icon={TextSearch} disabled={!st.input.trim()} data-testid="navigation-search-go">
            Search
          </Button>
        </div>
      </form>

      {hasSearch && (
        <div className="navigation-search-summary" aria-live="polite" data-testid="navigation-search-summary">
          {st.searching ? (
            <>
              <span>
                Searching… {results.length} {results.length === 1 ? 'instance' : 'instances'} so far
              </span>
              <ProgressBar value={st.total ? st.scanned / st.total : 0} />
            </>
          ) : (
            <span>
              {results.length} {results.length === 1 ? 'instance' : 'instances'} in {pageCount} {pageCount === 1 ? 'page' : 'pages'}
              {comments.length ? `, ${comments.length} in comments` : ''}
              {bookmarks.length ? `, ${bookmarks.length} in bookmarks` : ''}
            </span>
          )}
        </div>
      )}

      <div className="navigation-search-results" data-testid="navigation-search-results">
        {!hasSearch ? (
          <EmptyState compact icon={TextSearch} title="Search the document" description="Find every occurrence of a word or phrase, with the surrounding text." />
        ) : !st.searching && totalHits === 0 ? (
          <EmptyState compact icon={Search} title="No results" description={`“${st.query}” wasn’t found in this document.`} />
        ) : null}

        {bookmarks.length > 0 && (
          <section className="navigation-search-group" data-testid="navigation-search-group-bookmarks">
            <h3 className="navigation-search-group-head is-static">
              <Bookmark size={13} aria-hidden="true" /> Bookmarks
            </h3>
            {bookmarks.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`navigation-search-result${st.selected === `bm:${b.id}` ? ' is-selected' : ''}`}
                data-testid="navigation-search-bookmark-result"
                onClick={() => {
                  setSp({ selected: `bm:${b.id}` });
                  const it = findBm((getDoc(docId)?.outline ?? []) as BmItem[], b.id);
                  if (it) goToBookmark(docId, it);
                }}
              >
                <Snip before={b.before} match={b.match} after={b.after} />
              </button>
            ))}
          </section>
        )}

        {groups.map((g) => {
          const collapsed = !!st.collapsed[g.pageIndex];
          return (
            <section key={g.pageIndex} className="navigation-search-group" data-testid="navigation-search-group" data-page={g.pageIndex + 1}>
              <h3 className="navigation-search-group-head">
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => setSp({ collapsed: { ...sp().collapsed, [g.pageIndex]: !collapsed } })}
                  data-testid="navigation-search-group-toggle"
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>{pageLabel(g.pageIndex)}</span>
                  <span className="navigation-search-group-count">{g.items.length}</span>
                </button>
              </h3>
              {!collapsed &&
                g.items.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    className={`navigation-search-result${st.selected === r.key ? ' is-selected' : ''}`}
                    data-testid="navigation-search-result"
                    data-page={r.pageIndex + 1}
                    onClick={() => selectText(docId, r)}
                  >
                    <Snip before={r.before} match={r.match} after={r.after} />
                  </button>
                ))}
            </section>
          );
        })}
        {results.length > limit && (
          <div className="navigation-search-more">
            <Button size="sm" variant="secondary" onClick={() => setLimit((l) => l + MAX_ROWS)} data-testid="navigation-search-more">
              Show more results ({results.length - limit} more)
            </Button>
          </div>
        )}

        {comments.length > 0 && (
          <section className="navigation-search-group" data-testid="navigation-search-group-comments">
            <h3 className="navigation-search-group-head is-static">
              <MessageSquare size={13} aria-hidden="true" /> Comments
            </h3>
            {comments.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`navigation-search-result${st.selected === `c:${c.id}` ? ' is-selected' : ''}`}
                data-testid="navigation-search-comment-result"
                onClick={() => {
                  setSp({ selected: `c:${c.id}` });
                  scrollToObject(docId, c.id, { behavior: 'auto' });
                }}
              >
                <span className="navigation-search-meta">
                  {c.label} · {pageLabel(c.pageIndex)}
                </span>
                <Snip before={c.before} match={c.match} after={c.after} />
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function findBm(items: BmItem[], id: string): BmItem | null {
  for (const it of items) {
    if (it.id === id) return it;
    const c = it.children?.length ? findBm(it.children as BmItem[], id) : null;
    if (c) return c;
  }
  return null;
}
