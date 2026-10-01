/**
 * View › Read Out Loud: speaks page text with the Web Speech API (speechSynthesis), one sentence
 * per utterance, highlighting the sentence being read via viewer decorations. Degrades to a
 * friendly message when the browser has no speech synthesis.
 */
import { create } from 'zustand';
import type { DocId, Rect } from '@/core/types';
import * as engine from '@/core/engine';
import type { PageText, PageTextItem } from '@/core/engine/text';
import { actions, getDoc, useApp } from '@/core/store';
import { errMsg } from '../util';
import { textRects, unionRect } from '../find/search';

export const READ_DECO_KEY = 'navigation-readaloud';

export type ReadStatus = 'idle' | 'loading' | 'speaking' | 'paused';

interface ReadState {
  active: boolean;
  status: ReadStatus;
  docId: DocId | null;
  pageIndex: number;
  /** 'page' stops at the end of the page, 'end' continues to the end of the document. */
  mode: 'page' | 'end';
  sentence: string;
  rate: number;
}

export const useReadAloud = create<ReadState>(() => ({
  active: false,
  status: 'idle',
  docId: null,
  pageIndex: 0,
  mode: 'page',
  sentence: '',
  rate: 1,
}));

let focusRequested = false;
/** True once after activation: the floating control should focus its first button when it shows. */
export function takeFocusRequest(): boolean {
  const r = focusRequested;
  focusRequested = false;
  return r;
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function';
}

interface Sentence {
  start: number;
  end: number;
  speech: string;
}

const MAX_CHUNK = 280;

/**
 * Offsets of line breaks that end a block (heading, paragraph, list entry): the font changes, or the
 * next line is further away than normal line spacing. Headings have no final period, so without
 * this a title page would be read as one long "sentence".
 */
export function blockBreaks(text: string, items: PageTextItem[] | undefined): Set<number> {
  const out = new Set<number>();
  if (!items?.length) return out;
  let prev: PageTextItem | null = null;
  for (const it of items) {
    if (!it.str.trim()) continue;
    if (prev && text.lastIndexOf('\n', it.start) >= prev.start + prev.str.length) {
      const nl = text.lastIndexOf('\n', it.start);
      const t = prev.transform;
      const norm = Math.hypot(t[0], t[1]) || 1;
      const ux = t[0] / norm;
      const uy = t[1] / norm;
      const dx = it.transform[4] - t[4];
      const dy = it.transform[5] - t[5];
      const perp = Math.abs(dx * -uy + dy * ux);
      const size = Math.max(prev.fontSize, it.fontSize, 1);
      const sizeJump = Math.max(prev.fontSize, it.fontSize) / Math.max(1, Math.min(prev.fontSize, it.fontSize)) > 1.15;
      if (sizeJump || prev.fontName !== it.fontName || perp > size * 1.75) out.add(nl);
    }
    prev = it;
  }
  return out;
}

type SegmenterCtor = new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ index: number; segment: string }> };

function sentenceSpans(flat: string, from: number, to: number, out: [number, number][]) {
  const part = flat.slice(from, to);
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (Seg) {
    for (const s of new Seg(undefined, { granularity: 'sentence' }).segment(part)) out.push([from + s.index, from + s.index + s.segment.length]);
    return;
  }
  const re = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part))) {
    if (!m[0]) break;
    out.push([from + m.index, from + m.index + m[0].length]);
  }
}

/** Split the page text into speakable sentences with offsets into PageText.text. */
export function sentencesOf(text: string, items?: PageTextItem[]): Sentence[] {
  // Keep offsets: line breaks become spaces (they are line wraps, not sentence ends)…
  const flat = text.replace(/\n/g, ' ');
  const spans: [number, number][] = [];
  // …except at the end of a block.
  let from = 0;
  for (const nl of [...blockBreaks(text, items)].sort((a, b) => a - b)) {
    sentenceSpans(flat, from, nl, spans);
    from = nl + 1;
  }
  sentenceSpans(flat, from, flat.length, spans);
  const out: Sentence[] = [];
  const push = (s: number, e: number) => {
    const raw = text.slice(s, e);
    // …but a hyphen at a line end joins the word.
    const speech = raw.replace(/([A-Za-z])[-­‐]\n([a-z])/g, '$1$2').replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(speech)) return;
    // Trim the offsets to the visible characters.
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    out.push({ start: s, end: e, speech });
  };
  for (const [s, e] of spans) {
    if (e - s <= MAX_CHUNK) {
      push(s, e);
      continue;
    }
    // Long runs (tables, lists without punctuation): split at commas / spaces so each utterance stays short.
    let a = s;
    while (a < e) {
      let b = Math.min(e, a + MAX_CHUNK);
      if (b < e) {
        const slice = flat.slice(a, b);
        // Prefer a clause boundary (natural pause) over an arbitrary word break.
        const clause = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '), slice.lastIndexOf(': '));
        const cut = clause > MAX_CHUNK / 2 ? clause : slice.lastIndexOf(' ');
        if (cut > MAX_CHUNK / 3) b = a + cut + 1;
      }
      push(a, b);
      a = b;
    }
  }
  return out;
}

// ── playback ────────────────────────────────────────────────────────────────

/** Bumped on every stop/restart so events from cancelled utterances are ignored. */
let generation = 0;
let current: { docId: DocId; page: PageText; sentences: Sentence[]; index: number } | null = null;

const setState = (p: Partial<ReadState>) => useReadAloud.setState(p);

function clearHighlight(docId: DocId | null) {
  if (docId && getDoc(docId)) actions.setDecorations(docId, READ_DECO_KEY, null);
}

function highlight(docId: DocId, page: PageText, s: Sentence) {
  const doc = getDoc(docId);
  const pageInfo = doc?.pages[page.pageIndex];
  if (!doc || !pageInfo) return;
  const rects: Rect[] = textRects(page, s.start, s.end);
  if (!rects.length) {
    actions.setDecorations(docId, READ_DECO_KEY, null);
    return;
  }
  actions.setDecorations(docId, READ_DECO_KEY, [
    { pageId: pageInfo.id, rects, className: 'navigation-readaloud-hit', title: 'Reading' },
  ]);
  const u = unionRect(rects);
  if (u && useApp.getState().activeDocId === docId) actions.goToPage(docId, page.pageIndex, { rect: u, behavior: 'smooth' });
}

function finish(message?: string) {
  const { docId } = useReadAloud.getState();
  generation++;
  current = null;
  clearHighlight(docId);
  setState({ status: 'idle', sentence: '' });
  if (message) actions.toast(message, { kind: 'info' });
}

function speakNext(gen: number) {
  if (gen !== generation || !current) return;
  const synth = window.speechSynthesis;
  const c = current;
  if (c.index >= c.sentences.length) {
    const { mode } = useReadAloud.getState();
    const doc = getDoc(c.docId);
    if (mode === 'end' && doc && c.page.pageIndex + 1 < doc.pages.length) {
      void startPage(c.docId, c.page.pageIndex + 1, gen);
      return;
    }
    finish();
    return;
  }
  const s = c.sentences[c.index];
  const u = new SpeechSynthesisUtterance(s.speech);
  u.rate = useReadAloud.getState().rate;
  const lang = document.documentElement.lang;
  if (lang) u.lang = lang;
  u.onstart = () => {
    if (gen !== generation) return;
    highlight(c.docId, c.page, s);
  };
  u.onend = () => {
    if (gen !== generation || current !== c) return;
    c.index++;
    speakNext(gen);
  };
  u.onerror = (ev) => {
    if (gen !== generation) return;
    const err = (ev as SpeechSynthesisErrorEvent).error;
    if (err === 'interrupted' || err === 'canceled') return;
    console.warn('[navigation] speech synthesis error', err);
    finish(err === 'not-allowed' ? 'Read Out Loud was blocked by the browser. Click the page and try again.' : 'Read Out Loud stopped: the voice isn’t available.');
  };
  setState({ sentence: s.speech, status: synth.paused ? 'paused' : 'speaking', pageIndex: c.page.pageIndex });
  // Highlight right away too (some engines fire onstart late or never).
  highlight(c.docId, c.page, s);
  synth.speak(u);
}

async function startPage(docId: DocId, pageIndex: number, gen: number) {
  setState({ status: 'loading', pageIndex, docId });
  let page: PageText;
  try {
    page = await engine.getPageText(docId, pageIndex);
  } catch (e) {
    if (gen === generation) finish(`Couldn’t read page ${pageIndex + 1}: ${errMsg(e)}`);
    return;
  }
  if (gen !== generation) return;
  const sentences = sentencesOf(page.text, page.items);
  if (!sentences.length) {
    const { mode } = useReadAloud.getState();
    const doc = getDoc(docId);
    if (mode === 'end' && doc && pageIndex + 1 < doc.pages.length) {
      void startPage(docId, pageIndex + 1, gen);
      return;
    }
    finish(mode === 'page' ? `Page ${pageIndex + 1} has no text to read.` : undefined);
    return;
  }
  current = { docId, page, sentences, index: 0 };
  setState({ status: 'speaking' });
  speakNext(gen);
}

function unsupported() {
  actions.toast('Read Out Loud isn’t available in this browser.', { kind: 'warning' });
}

export const readAloud = {
  activate() {
    if (!speechSupported()) {
      unsupported();
      return;
    }
    if (useReadAloud.getState().active) return;
    // The floating Read Out Loud control appears and takes focus so keyboard users land on its buttons.
    focusRequested = true;
    setState({ active: true });
  },
  deactivate() {
    readAloud.stop();
    setState({ active: false });
  },
  toggleActive() {
    if (useReadAloud.getState().active) readAloud.deactivate();
    else readAloud.activate();
  },
  read(mode: 'page' | 'end', docId?: DocId | null, fromPage?: number) {
    if (!speechSupported()) {
      unsupported();
      return;
    }
    const id = docId ?? useApp.getState().activeDocId;
    const doc = id ? getDoc(id) : undefined;
    if (!id || !doc) return;
    readAloud.stop();
    const gen = ++generation;
    const page = Math.max(0, Math.min(doc.pages.length - 1, fromPage ?? doc.view.currentPage));
    setState({ active: true, mode, docId: id, pageIndex: page });
    void startPage(id, page, gen);
  },
  readPage(docId?: DocId | null) {
    readAloud.read('page', docId);
  },
  readToEnd(docId?: DocId | null) {
    readAloud.read('end', docId);
  },
  pause() {
    if (!speechSupported() || useReadAloud.getState().status !== 'speaking') return;
    window.speechSynthesis.pause();
    setState({ status: 'paused' });
  },
  resume() {
    if (!speechSupported() || useReadAloud.getState().status !== 'paused') return;
    window.speechSynthesis.resume();
    setState({ status: 'speaking' });
  },
  togglePause() {
    const { status } = useReadAloud.getState();
    if (status === 'speaking') readAloud.pause();
    else if (status === 'paused') readAloud.resume();
  },
  stop() {
    const { status, docId } = useReadAloud.getState();
    generation++;
    current = null;
    if (speechSupported() && (status !== 'idle' || window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
      window.speechSynthesis.cancel();
      // A paused engine stays paused after cancel() in some browsers.
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    }
    clearHighlight(docId);
    setState({ status: 'idle', sentence: '' });
  },
  setRate(rate: number) {
    setState({ rate });
  },
};

let started = false;
/** Stop reading when the document is closed / switched, and on page unload. */
export function startReadAloud() {
  if (started) return;
  started = true;
  useApp.subscribe((s, p) => {
    const { docId, status } = useReadAloud.getState();
    if (!docId || status === 'idle') return;
    if (!s.docs[docId] || (s.activeDocId !== p.activeDocId && s.activeDocId !== docId) || (s.route !== 'document' && p.route === 'document')) {
      readAloud.stop();
    }
  });
  window.addEventListener('pagehide', () => {
    if (speechSupported() && useReadAloud.getState().status !== 'idle') window.speechSynthesis.cancel();
  });
}
