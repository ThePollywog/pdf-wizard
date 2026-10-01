/** Transient UI state of the Redact task (not part of the document or its history). */
import { create } from 'zustand';
import type { DocId, Rect } from '@/core/types';

export type PanelView = 'main' | 'find' | 'properties';
export type FindMode = 'single' | 'multiple' | 'patterns';
export type PatternId = 'phone' | 'email' | 'credit-card' | 'ssn' | 'date';

export interface FindResult {
  id: string;
  pageIndex: number;
  pageId: string;
  /** Matched text. */
  text: string;
  /** Surrounding text for the results list. */
  before: string;
  after: string;
  rects: Rect[];
  /** What produced the match (the search term or pattern label). */
  source: string;
}

export interface FindState {
  mode: FindMode;
  single: string;
  multiple: string[];
  patterns: PatternId[];
  matchCase: boolean;
  wholeWords: boolean;
  running: boolean;
  progress: { done: number; total: number } | null;
  /** Results for (docId, version); stale results are dropped. */
  resultsFor: { docId: DocId; version: number } | null;
  results: FindResult[];
  checked: Record<string, boolean>;
  activeId: string | null;
  /** Search that produced the results (for the summary line). */
  summary: string;
}

interface UiState {
  hoverId: string | null;
  view: PanelView;
  find: FindState;
}

export const initialFind: FindState = {
  mode: 'single',
  single: '',
  multiple: [],
  patterns: [],
  matchCase: false,
  wholeWords: false,
  running: false,
  progress: null,
  resultsFor: null,
  results: [],
  checked: {},
  activeId: null,
  summary: '',
};

export const useRedactUi = create<UiState>(() => ({ hoverId: null, view: 'main', find: initialFind }));

export const redactUi = {
  get: useRedactUi.getState,
  setHover(id: string | null) {
    if (useRedactUi.getState().hoverId !== id) useRedactUi.setState({ hoverId: id });
  },
  setView(view: PanelView) {
    useRedactUi.setState({ view });
  },
  patchFind(patch: Partial<FindState> | ((f: FindState) => Partial<FindState>)) {
    useRedactUi.setState((s) => ({ find: { ...s.find, ...(typeof patch === 'function' ? patch(s.find) : patch) } }));
  },
};
