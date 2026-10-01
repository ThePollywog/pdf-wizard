/** Creating, listing and clearing redaction marks. */
import { Trash2 } from 'lucide-react';
import { actions, getDoc, getToolOptions, newObject } from '@/core/store';
import type { DocId, DocState, PageInfo, Rect } from '@/core/types';
import { confirmDialog } from '@/core/ui';
import { unionRects } from '@/core/geometry';
import { plural, readOnlyReason } from '../shared';
import {
  KIND, MARK_DEFAULTS, MARK_TOOL, isRedaction, type MarkDefaults, type OverlayProps, type RedactMode, type RedactionObject,
} from './types';

export function markDefaults(): MarkDefaults {
  const o = getToolOptions<MarkDefaults>(MARK_TOOL, MARK_DEFAULTS);
  return {
    fillColor: o.fillColor === null ? null : typeof o.fillColor === 'string' ? o.fillColor : MARK_DEFAULTS.fillColor,
    outlineColor: typeof o.outlineColor === 'string' ? o.outlineColor : MARK_DEFAULTS.outlineColor,
    overlay: { ...MARK_DEFAULTS.overlay, ...(o.overlay && typeof o.overlay === 'object' ? o.overlay : {}) },
  };
}

export function pageViewRect(page: PageInfo): Rect {
  const [x0, y0, x1, y1] = page.view;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Clip a rect to the page's visible box; null when nothing is left. */
export function clipToPage(r: Rect, page: PageInfo): Rect | null {
  const [vx0, vy0, vx1, vy1] = page.view;
  const x0 = Math.max(vx0, r.x);
  const y0 = Math.max(vy0, r.y);
  const x1 = Math.min(vx1, r.x + r.width);
  const y1 = Math.min(vy1, r.y + r.height);
  return x1 - x0 > 0.01 && y1 - y0 > 0.01 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export function makeMark(page: PageInfo, mode: RedactMode, rects: Rect[], extra: { text?: string; defaults?: MarkDefaults } = {}): RedactionObject | null {
  const clipped = rects.map((r) => clipToPage(r, page)).filter((r): r is Rect => !!r);
  if (!clipped.length) return null;
  const d = extra.defaults ?? markDefaults();
  const overlay: OverlayProps = { ...d.overlay };
  return newObject<RedactionObject>({
    kind: KIND,
    pageId: page.id,
    rect: unionRects(clipped),
    color: d.outlineColor,
    fillColor: d.fillColor,
    data: { mode, rects: clipped, text: extra.text?.trim() || undefined, overlay },
  });
}

export function addMarks(docId: DocId, marks: (RedactionObject | null)[], label: string, opts: { select?: boolean } = {}): number {
  const list = marks.filter((m): m is RedactionObject => !!m);
  if (!list.length) return 0;
  const reason = readOnlyReason(docId);
  if (reason) {
    actions.toast(reason, { kind: 'error' });
    return 0;
  }
  actions.addObjects(docId, list, { label, select: opts.select });
  return list.length;
}

export function marksOf(doc: DocState | undefined): RedactionObject[] {
  if (!doc) return [];
  const pageIndex = new Map(doc.pages.map((p, i) => [p.id, i]));
  const out: RedactionObject[] = [];
  for (const id of doc.order) {
    const o = doc.objects[id];
    if (isRedaction(o) && pageIndex.has(o.pageId)) out.push(o);
  }
  // Reading order: page, then top to bottom, then left to right.
  return out.sort((a, b) => {
    const pa = pageIndex.get(a.pageId)!;
    const pb = pageIndex.get(b.pageId)!;
    if (pa !== pb) return pa - pb;
    const ta = a.rect.y + a.rect.height;
    const tb = b.rect.y + b.rect.height;
    if (Math.abs(ta - tb) > 2) return tb - ta;
    return a.rect.x - b.rect.x;
  });
}

export function markIds(docId: DocId): string[] {
  return marksOf(getDoc(docId)).map((m) => m.id);
}

export async function clearAllMarks(docId: DocId): Promise<void> {
  const ids = markIds(docId);
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: 'Clear all marks',
    message: `Remove ${plural(ids.length, 'redaction mark')}? Nothing is removed from the document.`,
    confirmLabel: 'Clear marks',
    danger: true,
    icon: Trash2,
  });
  if (!ok) return;
  actions.deleteObjects(docId, ids, { label: 'Clear redaction marks' });
  actions.toast(`Cleared ${plural(ids.length, 'redaction mark')}.`, { kind: 'info' });
}

/** Whole-page marks for the given page indices (skips pages that already have one). */
export function markPages(docId: DocId, indices: number[]): number {
  const doc = getDoc(docId);
  if (!doc) return 0;
  const existing = new Set(marksOf(doc).filter((m) => m.data.mode === 'page').map((m) => m.pageId));
  const defaults = markDefaults();
  const marks = indices
    .map((i) => doc.pages[i])
    .filter((p): p is PageInfo => !!p && !existing.has(p.id))
    .map((p) => makeMark(p, 'page', [pageViewRect(p)], { defaults }));
  const n = addMarks(docId, marks, indices.length === 1 ? 'Mark page for redaction' : 'Mark pages for redaction');
  return n;
}

/** Copy an area mark onto other pages at the same position (like the usual "Repeat mark across pages"). */
export function repeatMark(docId: DocId, markId: string, indices: number[]): number {
  const doc = getDoc(docId);
  const src = doc?.objects[markId];
  if (!doc || !isRedaction(src)) return 0;
  const marks = indices
    .map((i) => doc.pages[i])
    .filter((p): p is PageInfo => !!p && p.id !== src.pageId)
    .map((p) => {
      const m = makeMark(p, src.data.mode === 'page' ? 'page' : 'area', src.data.mode === 'page' ? [pageViewRect(p)] : src.data.rects);
      if (!m) return null;
      return { ...m, color: src.color, fillColor: src.fillColor, data: { ...m.data, overlay: { ...src.data.overlay } } };
    });
  return addMarks(docId, marks, 'Repeat redaction mark');
}

/** Topmost mark on a page containing the point (PDF space). */
export function markAt(doc: DocState | undefined, pageId: string, x: number, y: number, tol = 0): RedactionObject | null {
  if (!doc) return null;
  for (let i = doc.order.length - 1; i >= 0; i--) {
    const o = doc.objects[doc.order[i]];
    if (!isRedaction(o) || o.pageId !== pageId) continue;
    for (const r of o.data.rects) {
      if (x >= r.x - tol && x <= r.x + r.width + tol && y >= r.y - tol && y <= r.y + r.height + tol) return o;
    }
  }
  return null;
}
