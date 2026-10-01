/**
 * Converts the browser's DOM selection inside pdf.js text layers into TextSelectionInfo
 * (per page text + one PDF-space rect per line fragment).
 */
import type { DocId, Rect, TextSelectionInfo, ViewBox } from '../types';
import { viewToRect } from '../geometry';
import { getDoc } from '../store';
import type { ViewerController } from './controller';

interface Frag {
  left: number;
  top: number;
  right: number;
  bottom: number;
  horizontal: boolean;
}

function spanAngle(span: Element | null): number {
  if (!(span instanceof HTMLElement)) return 0;
  const raw = span.style.getPropertyValue('--rotate');
  const m = /(-?[\d.]+)deg/.exec(raw);
  return m ? parseFloat(m[1]) : 0;
}

/** Merge fragments that belong to the same visual line. */
function mergeLines(frags: Frag[]): Frag[] {
  const out: Frag[] = [];
  for (const f of frags) {
    const last = out[out.length - 1];
    if (last && last.horizontal === f.horizontal) {
      if (f.horizontal) {
        const h = Math.min(last.bottom - last.top, f.bottom - f.top);
        const overlap = Math.min(last.bottom, f.bottom) - Math.max(last.top, f.top);
        const gap = f.left - last.right;
        if (overlap > h * 0.5 && gap < h * 1.5 && f.right > last.left - h * 0.5) {
          last.left = Math.min(last.left, f.left);
          last.right = Math.max(last.right, f.right);
          last.top = Math.min(last.top, f.top);
          last.bottom = Math.max(last.bottom, f.bottom);
          continue;
        }
      } else {
        const w = Math.min(last.right - last.left, f.right - f.left);
        const overlap = Math.min(last.right, f.right) - Math.max(last.left, f.left);
        const gap = Math.max(f.top - last.bottom, last.top - f.bottom);
        if (overlap > w * 0.5 && gap < w * 1.5) {
          last.left = Math.min(last.left, f.left);
          last.right = Math.max(last.right, f.right);
          last.top = Math.min(last.top, f.top);
          last.bottom = Math.max(last.bottom, f.bottom);
          continue;
        }
      }
    }
    out.push({ ...f });
  }
  return out;
}

function pageSelection(
  ctrl: ViewerController,
  docId: DocId,
  pageEl: HTMLElement,
  textLayer: HTMLElement,
  ranges: Range[],
): TextSelectionInfo | null {
  const pageIndex = Number(pageEl.dataset.pageIndex);
  const doc = getDoc(docId);
  const page = doc?.pages[pageIndex];
  const vp = ctrl.viewport(pageIndex);
  if (!page || !vp) return null;
  const pageRect = pageEl.getBoundingClientRect();
  const pageRotation = Number(pageEl.dataset.rotation) || 0;
  let text = '';
  const frags: Frag[] = [];
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) {
        return (n.parentElement?.closest('.endOfContent') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
      }
      return (n as Element).tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const range = ranges.find((r) => r.intersectsNode(n!));
    if (!range) continue;
    if (n.nodeType !== Node.TEXT_NODE) {
      // <br> = end of line in pdf.js text layers
      if (text && !text.endsWith('\n')) text += '\n';
      continue;
    }
    const node = n as Text;
    const sub = document.createRange();
    sub.selectNodeContents(node);
    if (node === range.startContainer) sub.setStart(node, range.startOffset);
    if (node === range.endContainer) sub.setEnd(node, range.endOffset);
    if (sub.collapsed) continue;
    const s = sub.toString();
    if (!s) continue;
    text += s;
    const span = node.parentElement;
    const spanRect = span?.getBoundingClientRect();
    const angle = (((pageRotation + spanAngle(span)) % 360) + 360) % 360;
    const axisAligned = Math.abs(angle % 90) < 0.5 || Math.abs((angle % 90) - 90) < 0.5;
    const horizontal = Math.round(angle / 90) % 2 === 0;
    for (const cr of Array.from(sub.getClientRects())) {
      if (cr.width < 0.5 && cr.height < 0.5) continue;
      let { left, right, top, bottom } = cr;
      if (spanRect && axisAligned) {
        // Use the span's box for the cross axis: it matches the glyph height exactly.
        if (horizontal) {
          top = spanRect.top;
          bottom = spanRect.bottom;
        } else {
          left = spanRect.left;
          right = spanRect.right;
        }
      }
      frags.push({
        left: left - pageRect.left,
        right: right - pageRect.left,
        top: top - pageRect.top,
        bottom: bottom - pageRect.top,
        horizontal,
      });
    }
  }
  const lines = mergeLines(frags);
  if (lines.length === 0) return null;
  const rects: Rect[] = lines.map((l) => {
    const box: ViewBox = { left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top };
    return viewToRect(vp, box);
  });
  return { docId, pageId: page.id, pageIndex, text: text.replace(/\n+$/, ''), rects };
}

/** Current DOM text selection within this viewer, grouped per page (empty if none). */
export function collectTextSelection(ctrl: ViewerController): TextSelectionInfo[] {
  const sel = document.getSelection();
  const root = ctrl.sizer;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !root) return [];
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (!r.collapsed && r.intersectsNode(root)) ranges.push(r);
  }
  if (ranges.length === 0) return [];
  const out: TextSelectionInfo[] = [];
  const pages = Array.from(root.querySelectorAll<HTMLElement>('.pdfwizard-page')).sort(
    (a, b) => Number(a.dataset.pageIndex) - Number(b.dataset.pageIndex),
  );
  for (const pageEl of pages) {
    const tl = pageEl.querySelector<HTMLElement>('.textLayer');
    if (!tl || !ranges.some((r) => r.intersectsNode(tl))) continue;
    const info = pageSelection(ctrl, ctrl.docId, pageEl, tl, ranges);
    if (info) out.push(info);
  }
  return out;
}

/** Client-space bounding boxes of the first and last selected line (for positioning popups). */
export function selectionClientBounds(): { first: DOMRect; last: DOMRect; union: DOMRect } | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const rects: DOMRect[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of Array.from(sel.getRangeAt(i).getClientRects())) if (r.width > 0.5 && r.height > 0.5) rects.push(r);
  }
  if (rects.length === 0) return null;
  const l = Math.min(...rects.map((r) => r.left));
  const t = Math.min(...rects.map((r) => r.top));
  const rr = Math.max(...rects.map((r) => r.right));
  const b = Math.max(...rects.map((r) => r.bottom));
  return { first: rects[0], last: rects[rects.length - 1], union: new DOMRect(l, t, rr - l, b - t) };
}

/** Select all text of one page's text layer (Cmd+A fallback when the page has no objects). */
export function selectPageText(pageEl: HTMLElement | null): boolean {
  const tl = pageEl?.querySelector<HTMLElement>('.textLayer');
  const sel = document.getSelection();
  if (!tl || !sel || !tl.textContent?.trim()) return false;
  const r = document.createRange();
  const spans = tl.querySelectorAll('span:not(.markedContent)');
  if (spans.length === 0) return false;
  r.setStartBefore(spans[0]);
  r.setEndAfter(spans[spans.length - 1]);
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}
