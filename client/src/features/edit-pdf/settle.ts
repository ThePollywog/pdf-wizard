/**
 * Keeps previews of committed edits (drag ghosts, the text editor after a commit) on screen until
 * the page canvas shows the new content: first the document's pdf.js proxy must catch up with the
 * new bytes, then the page canvas must be replaced by a render of it.
 */
import { getDoc } from '@/core/store';
import { pageCanvas } from './pagedom';
import { ui, useEditPdf } from './state';

const TIMEOUT = 4000;
/** Page canvas seen at the last tick while the pdf proxy was still stale, per ghost / session. */
const seen = new Map<string, Element | null>();
let timer: ReturnType<typeof setInterval> | null = null;

function ready(key: string, docId: string, pageIndex: number, from: Element | null | undefined): boolean {
  const doc = getDoc(docId);
  if (!doc) return true;
  const canvas = pageCanvas(pageIndex);
  if (!canvas) return true; // page scrolled away / unmounted
  if (doc.pdfVersion !== doc.version) {
    seen.set(key, canvas);
    return false;
  }
  const before = seen.has(key) ? seen.get(key) : from;
  return canvas !== before;
}

function tick() {
  const now = performance.now();
  const st = ui.get();
  for (const g of st.ghosts) {
    if (g.settleFrom === undefined) continue;
    const key = `g:${g.id}`;
    if (now - g.since > TIMEOUT || ready(key, g.docId, g.pageIndex, g.settleFrom)) {
      seen.delete(key);
      ui.removeGhost(g.id);
    }
  }
  const e = st.edit;
  if (e?.phase === 'settling') {
    const key = `e:${e.nonce}`;
    if (now - (e.settleSince ?? 0) > TIMEOUT || ready(key, e.docId, e.pageIndex, e.settleFrom)) {
      seen.delete(key);
      ui.endEdit(e.nonce);
    }
  }
  const pending = ui.get().ghosts.some((g) => g.settleFrom !== undefined) || ui.get().edit?.phase === 'settling';
  if (!pending && timer) {
    clearInterval(timer);
    timer = null;
    seen.clear();
  }
}

/** Starts watching (idempotent); called whenever something starts settling. */
export function watchSettling(): void {
  if (!timer) timer = setInterval(tick, 40);
}

useEditPdf.subscribe((s) => {
  if (s.ghosts.some((g) => g.settleFrom !== undefined) || s.edit?.phase === 'settling') watchSettling();
});
