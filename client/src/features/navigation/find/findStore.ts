/**
 * Find bar state + runner: incremental search of the active document as the query is typed,
 * "3 of 17" navigation, and highlight decorations for the pages around the viewport.
 */
import { create } from 'zustand';
import type { Decoration, DocId } from '@/core/types';
import { actions, getDoc, useApp } from '@/core/store';
import { useViewerUi } from '@/core/viewer/viewerStore';
import { activeDocId, readLocal, writeLocal } from '../util';
import { mergeSorted, scanDocument, unionRect, type ScanHandle, type TextMatch } from './search';
import { normalizeQuery } from './text';

export const FIND_DECO_KEY = 'navigation-find';

interface FindState {
  open: boolean;
  query: string;
  matchCase: boolean;
  wholeWords: boolean;
  /** Document the results belong to. */
  docId: DocId | null;
  results: TextMatch[];
  currentKey: string | null;
  searching: boolean;
  scanned: number;
  total: number;
  /** Bumped to ask the find bar to focus + select its input. */
  focusNonce: number;
}

const OPTS_KEY = 'navigation.find.options';
const savedOpts = (() => {
  try {
    return JSON.parse(readLocal(OPTS_KEY, '{}')) as { matchCase?: boolean; wholeWords?: boolean };
  } catch {
    return {};
  }
})();

export const useFind = create<FindState>(() => ({
  open: false,
  query: '',
  matchCase: !!savedOpts.matchCase,
  wholeWords: !!savedOpts.wholeWords,
  docId: null,
  results: [],
  currentKey: null,
  searching: false,
  scanned: 0,
  total: 0,
  focusNonce: 0,
}));

const get = () => useFind.getState();
const set = (p: Partial<FindState>) => useFind.setState(p);

let handle: ScanHandle | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function scrollToMatch(docId: DocId, m: TextMatch) {
  actions.goToPage(docId, m.pageIndex, { rect: unionRect(m.rects), behavior: 'auto' });
}

/** (Re)start the search. `preserveKey` keeps the current match (e.g. after an edit re-renders). */
function run(preserveKey: string | null = null) {
  clearTimeout(timer);
  handle?.cancel();
  handle = null;
  const { open, query, matchCase, wholeWords } = get();
  const docId = activeDocId();
  const doc = docId ? getDoc(docId) : null;
  if (!open || !docId || !doc || !normalizeQuery(query, matchCase)) {
    set({ docId, results: [], currentKey: null, searching: false, scanned: 0, total: 0 });
    return;
  }
  set({ docId, results: [], currentKey: null, searching: true, scanned: 0, total: doc.pages.length });
  let picked = false;
  const h = scanDocument(
    docId,
    query,
    { matchCase, wholeWords },
    ({ matches, scanned }) => {
      const st = get();
      const results = mergeSorted(st.results, matches);
      let currentKey = st.currentKey;
      let jump: TextMatch | null = null;
      if (!picked) {
        if (preserveKey) {
          if (results.some((m) => m.key === preserveKey)) {
            currentKey = preserveKey;
            picked = true;
          }
        } else if (matches.length) {
          currentKey = matches[0].key;
          jump = matches[0];
          picked = true;
        }
      }
      set({ results, currentKey, scanned });
      if (jump) scrollToMatch(docId, jump);
    },
    { startPage: doc.view.currentPage },
  );
  handle = h;
  void h.done.then((ok) => {
    if (handle !== h) return;
    handle = null;
    const st = get();
    const patch: Partial<FindState> = { searching: false, scanned: st.total };
    if (ok && !picked && st.results.length) patch.currentKey = st.results[0].key;
    set(patch);
  });
}

function schedule(delay = 140, preserveKey: string | null = null) {
  clearTimeout(timer);
  handle?.cancel();
  handle = null;
  if (!normalizeQuery(get().query, get().matchCase)) {
    run();
    return;
  }
  set({ searching: true });
  timer = setTimeout(() => run(preserveKey), delay);
}

function persistOpts() {
  const { matchCase, wholeWords } = get();
  writeLocal(OPTS_KEY, JSON.stringify({ matchCase, wholeWords }));
}

export const find = {
  /** Open (or focus) the find bar, optionally pre-filled with the selected text. */
  open(prefill?: string | null) {
    const st = get();
    const q = prefill && prefill.length <= 80 && !/\n/.test(prefill) ? prefill : null;
    const wasOpen = st.open;
    set({ open: true, focusNonce: st.focusNonce + 1, ...(q ? { query: q } : {}) });
    if (!wasOpen || (q && q !== st.query) || st.docId !== activeDocId()) run();
  },
  close() {
    clearTimeout(timer);
    handle?.cancel();
    handle = null;
    set({ open: false, results: [], currentKey: null, searching: false, scanned: 0, total: 0 });
  },
  setQuery(query: string) {
    if (query === get().query) return;
    set({ query });
    schedule();
  },
  setOptions(p: { matchCase?: boolean; wholeWords?: boolean }) {
    set(p);
    persistOpts();
    if (get().open) schedule(0);
  },
  /** Step to the next (+1) or previous (-1) match, wrapping around. */
  step(dir: 1 | -1) {
    const st = get();
    if (!st.open) {
      find.open();
      return;
    }
    if (st.docId !== activeDocId()) {
      run();
      return;
    }
    const { results } = st;
    if (!results.length) {
      if (!st.searching && normalizeQuery(st.query, st.matchCase)) actions.toast(`No matches were found for “${st.query.trim()}”.`, { kind: 'info', duration: 2500 });
      return;
    }
    let i = results.findIndex((m) => m.key === st.currentKey);
    if (i < 0) {
      // No current match yet: start from the current page.
      const doc = st.docId ? getDoc(st.docId) : null;
      const cur = doc?.view.currentPage ?? 0;
      i = dir > 0 ? results.findIndex((m) => m.pageIndex >= cur) : results.findLastIndex((m) => m.pageIndex <= cur);
      if (i < 0) i = dir > 0 ? 0 : results.length - 1;
    } else i = (i + dir + results.length) % results.length;
    const m = results[i];
    set({ currentKey: m.key });
    if (st.docId) scrollToMatch(st.docId, m);
  },
  /** Make `key` the current match and scroll to it. */
  select(key: string) {
    const st = get();
    const m = st.results.find((r) => r.key === key);
    if (!m || !st.docId) return;
    set({ currentKey: key });
    scrollToMatch(st.docId, m);
  },
};

// ── decorations ─────────────────────────────────────────────────────────────

let decoDoc: DocId | null = null;
let decoSig = '';
let raf = 0;

function syncDecorations() {
  raf = 0;
  const st = get();
  const docId = st.open ? st.docId : null;
  if (decoDoc && decoDoc !== docId && getDoc(decoDoc)?.decorations[FIND_DECO_KEY]) actions.setDecorations(decoDoc, FIND_DECO_KEY, null);
  decoDoc = docId;
  const doc = docId ? getDoc(docId) : null;
  if (!doc || !docId || !st.results.length) {
    decoSig = '';
    if (doc?.decorations[FIND_DECO_KEY]) actions.setDecorations(doc.id, FIND_DECO_KEY, null);
    return;
  }
  const visible = useViewerUi.getState().visible[docId] ?? [doc.view.currentPage];
  const want = new Set<number>();
  for (const v of visible) for (let k = v - 2; k <= v + 2; k++) want.add(k);
  const decos: Decoration[] = [];
  let sig = `${doc.pdfVersion}|`;
  for (const m of st.results) {
    const active = m.key === st.currentKey;
    if (!active && !want.has(m.pageIndex)) continue;
    const page = doc.pages[m.pageIndex];
    if (!page || !m.rects.length) continue;
    decos.push({ pageId: page.id, rects: m.rects, className: `navigation-find-hit${active ? ' is-current' : ''}`, active });
    sig += `${page.id}:${m.start}${active ? '*' : ''},`;
  }
  if (sig === decoSig && doc.decorations[FIND_DECO_KEY]) return;
  decoSig = sig;
  actions.setDecorations(docId, FIND_DECO_KEY, decos);
}

const scheduleDecorations = () => {
  if (!raf) raf = requestAnimationFrame(syncDecorations);
};

let started = false;
/** Wire the find runner to app state (called once from the feature's index). */
export function startFind() {
  if (started) return;
  started = true;
  useFind.subscribe((s, p) => {
    if (s.results !== p.results || s.currentKey !== p.currentKey || s.open !== p.open || s.docId !== p.docId) scheduleDecorations();
  });
  useViewerUi.subscribe((s, p) => {
    const d = get().docId;
    if (d && s.visible[d] !== p.visible[d]) scheduleDecorations();
  });
  // Active document switched / document re-rendered (bytes changed) / closed.
  useApp.subscribe((s, p) => {
    const st = get();
    if (!st.open) return;
    if (s.activeDocId !== p.activeDocId || s.route !== p.route) {
      if (s.route !== 'document' || !s.activeDocId) find.close();
      else run();
      return;
    }
    const d = st.docId ? s.docs[st.docId] : undefined;
    const pd = st.docId ? p.docs[st.docId] : undefined;
    if (!d) {
      if (pd) find.close();
      return;
    }
    if (pd && (d.pdfVersion !== pd.pdfVersion || d.pages !== pd.pages)) schedule(250, st.currentKey);
  });
}
