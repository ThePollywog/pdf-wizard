/**
 * Find text & redact: search the document for words, phrases or patterns (phone numbers, e-mail
 * addresses, credit cards, SSNs, dates) and mark the chosen results for redaction.
 */
import * as engine from '@/core/engine';
import { actions, getDoc } from '@/core/store';
import type { Decoration, DocId, PageInfo } from '@/core/types';
import { FEATURE, errorMessage, plural } from '../shared';
import { addMarks, makeMark, markDefaults } from './marks';
import { getPageModel, rangeRects } from './textModel';
import { initialFind, redactUi, type FindResult, type FindState, type PatternId } from './uiStore';

export const DECORATION_KEY = 'protect-redact-find';

export interface PatternDef {
  id: PatternId;
  label: string;
  example: string;
  regex: RegExp;
  validate?(match: string): boolean;
}

const MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

function luhn(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export const PATTERNS: PatternDef[] = [
  {
    id: 'phone',
    label: 'Phone numbers',
    example: '(555) 123-4567, +1 555 123 4567',
    regex: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\w)|(?<![\w+])\+\d{1,3}(?:[\s.-]\d{1,4}){2,4}(?!\w)/g,
    validate: (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 10 && n <= 15;
    },
  },
  {
    id: 'email',
    label: 'E-mail addresses',
    example: 'name@example.com',
    regex: /(?<![\w.%+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w-])/g,
  },
  {
    id: 'credit-card',
    label: 'Credit card numbers',
    example: '4111 1111 1111 1111',
    regex: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    validate: luhn,
  },
  {
    id: 'ssn',
    label: 'U.S. Social Security numbers',
    example: '123-45-6789',
    regex: /(?<![\d-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/g,
  },
  {
    id: 'date',
    label: 'Dates',
    example: '12/31/2024, 2024-12-31, March 5, 2024',
    regex: new RegExp(
      [
        '(?<!\\d)(?:0?[1-9]|[12]\\d|3[01])[/.-](?:0?[1-9]|[12]\\d|3[01])[/.-](?:\\d{4}|\\d{2})(?!\\d)',
        '(?<!\\d)\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])(?!\\d)',
        `\\b${MONTHS}\\.?\\s+(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,
        `\\b(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+${MONTHS}\\.?,?\\s+\\d{4}\\b`,
      ].join('|'),
      'gi',
    ),
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex for a word or phrase; runs of whitespace match any whitespace (including line breaks). */
export function termRegex(term: string, opts: { matchCase: boolean; wholeWords: boolean }): RegExp | null {
  const t = term.trim();
  if (!t) return null;
  const body = t.split(/\s+/).map(escapeRe).join('\\s+');
  const src = opts.wholeWords ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(src, `g${opts.matchCase ? '' : 'i'}u`);
}

interface Query {
  label: string;
  regex: RegExp;
  validate?(m: string): boolean;
}

export function queriesFor(f: FindState): Query[] {
  const o = { matchCase: f.matchCase, wholeWords: f.wholeWords };
  if (f.mode === 'patterns') {
    return PATTERNS.filter((p) => f.patterns.includes(p.id)).map((p) => ({ label: p.label, regex: new RegExp(p.regex.source, p.regex.flags), validate: p.validate }));
  }
  const terms = f.mode === 'single' ? [f.single] : f.multiple;
  const seen = new Set<string>();
  const out: Query[] = [];
  for (const t of terms) {
    const key = f.matchCase ? t.trim() : t.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const regex = termRegex(t, o);
    if (regex) out.push({ label: t.trim(), regex });
  }
  return out;
}

export function describeQuery(f: FindState): string {
  if (f.mode === 'patterns') return PATTERNS.filter((p) => f.patterns.includes(p.id)).map((p) => p.label.toLowerCase()).join(', ');
  if (f.mode === 'single') return `“${f.single.trim()}”`;
  return f.multiple.map((t) => `“${t.trim()}”`).join(', ');
}

const clean = (s: string) => s.replace(/\s+/g, ' ');

let runId = 0;

export function cancelFind() {
  runId++;
  redactUi.patchFind({ running: false, progress: null });
}

/** Search the whole document; results replace the previous ones. */
export async function runFind(docId: DocId): Promise<number> {
  const doc = getDoc(docId);
  if (!doc) return 0;
  const f = redactUi.get().find;
  const queries = queriesFor(f);
  if (!queries.length) {
    actions.toast(f.mode === 'patterns' ? 'Choose at least one pattern.' : 'Enter the text to find.', { kind: 'info' });
    return 0;
  }
  const my = ++runId;
  const version = doc.version;
  const total = doc.pages.length;
  redactUi.patchFind({ running: true, progress: { done: 0, total }, results: [], checked: {}, activeId: null, resultsFor: null, summary: describeQuery(f) });
  actions.setDecorations(docId, DECORATION_KEY, null);
  const results: FindResult[] = [];
  let lastPaint = 0;
  try {
    const pdf = await engine.awaitPdf(docId);
    for (let i = 0; i < total; i++) {
      if (my !== runId) return results.length;
      const page = getDoc(docId)?.pages[i];
      if (!page) break;
      const model = await getPageModel(docId, i, pdf);
      const taken: [number, number][] = [];
      for (const q of queries) {
        q.regex.lastIndex = 0;
        for (const m of model.text.matchAll(q.regex)) {
          const s = m.index ?? 0;
          const e = s + m[0].length;
          if (e <= s) continue;
          if (q.validate && !q.validate(m[0])) continue;
          if (taken.some(([a, b]) => s < b && e > a)) continue;
          const rects = rangeRects(model, s, e);
          if (!rects.length) continue;
          taken.push([s, e]);
          results.push({
            id: `${page.id}:${s}:${e}`,
            pageIndex: i,
            pageId: page.id,
            text: clean(m[0]),
            before: clean(model.text.slice(Math.max(0, s - 32), s)).replace(/^\S*\s/, (x) => (s > 32 ? '' : x)),
            after: clean(model.text.slice(e, e + 32)).replace(/\s\S*$/, (x) => (e + 32 < model.text.length ? '' : x)),
            rects,
            source: q.label,
          });
        }
      }
      // Keep the results in reading order per page.
      const now = performance.now();
      if (now - lastPaint > 120 || i === total - 1) {
        lastPaint = now;
        redactUi.patchFind({ progress: { done: i + 1, total } });
        // Let the UI breathe on big documents.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } catch (e) {
    if (my !== runId) return 0;
    console.warn(`[${FEATURE}] find failed`, e);
    redactUi.patchFind({ running: false, progress: null });
    actions.toast(`Couldn’t search the document: ${errorMessage(e)}`, { kind: 'error' });
    return 0;
  }
  if (my !== runId) return 0;
  results.sort((a, b) => a.pageIndex - b.pageIndex || Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
  const checked: Record<string, boolean> = {};
  for (const r of results) checked[r.id] = true;
  redactUi.patchFind({ running: false, progress: null, results, checked, resultsFor: { docId, version } });
  showDecorations(docId);
  return results.length;
}

/** Highlight the results on the pages (checked ones stronger). */
export function showDecorations(docId: DocId) {
  const f = redactUi.get().find;
  if (!f.resultsFor || f.resultsFor.docId !== docId) {
    actions.setDecorations(docId, DECORATION_KEY, null);
    return;
  }
  const decorations: Decoration[] = f.results.map((r) => ({
    pageId: r.pageId,
    rects: r.rects,
    color: f.checked[r.id] ? 'rgba(224, 48, 30, 0.28)' : 'rgba(128, 128, 128, 0.22)',
    className: 'protect-redact-find-hit',
    active: f.activeId === r.id,
    title: r.text,
  }));
  actions.setDecorations(docId, DECORATION_KEY, decorations);
}

export function clearFind(docId: DocId | null, keepQuery = true) {
  runId++;
  const f = redactUi.get().find;
  redactUi.patchFind(
    keepQuery
      ? { running: false, progress: null, results: [], checked: {}, activeId: null, resultsFor: null, summary: '' }
      : { ...initialFind, mode: f.mode },
  );
  if (docId && getDoc(docId)) actions.setDecorations(docId, DECORATION_KEY, null);
}

/** Mark the checked results for redaction; they leave the results list. */
export function markSelectedResults(docId: DocId): number {
  const doc = getDoc(docId);
  const f = redactUi.get().find;
  if (!doc || !f.resultsFor || f.resultsFor.docId !== docId) return 0;
  const pages = new Map<string, PageInfo>(doc.pages.map((p) => [p.id, p]));
  const chosen = f.results.filter((r) => f.checked[r.id] && pages.has(r.pageId));
  if (!chosen.length) {
    actions.toast('Select the results to mark first.', { kind: 'info' });
    return 0;
  }
  const defaults = markDefaults();
  const marks = chosen.map((r) => makeMark(pages.get(r.pageId)!, 'text', r.rects, { text: r.text, defaults }));
  const n = addMarks(docId, marks, chosen.length === 1 ? 'Mark search result for redaction' : 'Mark search results for redaction');
  if (!n) return 0;
  const done = new Set(chosen.map((r) => r.id));
  const rest = f.results.filter((r) => !done.has(r.id));
  const checked: Record<string, boolean> = {};
  for (const r of rest) checked[r.id] = !!f.checked[r.id];
  redactUi.patchFind({ results: rest, checked, activeId: null });
  showDecorations(docId);
  // Everything found is now marked: back to the marks list instead of an empty result list.
  if (!rest.length) {
    clearFind(docId);
    redactUi.setView('main');
  }
  actions.toast(`Marked ${plural(n, 'result')} for redaction. Apply redactions to remove ${n === 1 ? 'it' : 'them'} permanently.`, { kind: 'success' });
  return n;
}
