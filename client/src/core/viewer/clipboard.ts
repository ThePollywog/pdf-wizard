/**
 * Internal object clipboard (copy / cut / paste / duplicate of overlay objects).
 * Pasting targets the current page: on the same page copies are offset by 10pt per paste,
 * on another page they keep their position (clamped into the page).
 */
import type { DocId, ObjectId, PageInfo, PdfObject, Rect } from '../types';
import { actions, getDoc, newObject } from '../store';
import { reg } from '../registry';
import { translateRect } from '../geometry';

interface ClipState {
  items: PdfObject[];
  /** Number of pastes since the copy (for the cascading offset). */
  pastes: number;
  /** Set when the system clipboard got something newer (native copy). */
  stale: boolean;
}

let clip: ClipState | null = null;
const PASTE_OFFSET = 10;

if (typeof document !== 'undefined') {
  document.addEventListener('copy', () => {
    if (clip) clip.stale = true;
  });
  document.addEventListener('cut', () => {
    if (clip) clip.stale = true;
  });
}

const clone = <T,>(v: T): T => {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v)) as T;
  }
};

export function hasClipboardObjects(): boolean {
  return !!clip && !clip.stale && clip.items.length > 0;
}

/** Copy objects (in z-order). Returns the number copied. */
export function copyObjects(docId: DocId, ids: ObjectId[]): number {
  const d = getDoc(docId);
  if (!d) return 0;
  const set = new Set(ids);
  const items = d.order.filter((id) => set.has(id)).map((id) => clone(d.objects[id]));
  if (items.length === 0) return 0;
  clip = { items, pastes: 0, stale: false };
  return items.length;
}

export function cutObjects(docId: DocId, ids: ObjectId[]): number {
  const d = getDoc(docId);
  if (!d) return 0;
  const n = copyObjects(docId, ids);
  const deletable = ids.filter((id) => d.objects[id] && !d.objects[id].locked);
  if (deletable.length) actions.deleteObjects(docId, deletable, { label: 'Cut' });
  return n;
}

/** Move `obj` by (dx, dy) PDF points, honouring the type's translate(). */
export function translatedPatch(obj: PdfObject, dx: number, dy: number): Partial<PdfObject> {
  const t = reg.objectType(obj.kind);
  const extra = t?.translate ? t.translate(obj, dx, dy) : {};
  return { rect: translateRect(obj.rect, dx, dy), ...extra };
}

/** Delta that keeps `r` inside the page's visible box (after applying dx, dy). */
function clampDelta(r: Rect, page: PageInfo, dx: number, dy: number) {
  const [x0, y0, x1, y1] = page.view;
  const minDx = x0 - r.x;
  const maxDx = x1 - (r.x + r.width);
  const minDy = y0 - r.y;
  const maxDy = y1 - (r.y + r.height);
  const cx = minDx > maxDx ? (minDx + maxDx) / 2 : Math.min(maxDx, Math.max(minDx, dx));
  const cy = minDy > maxDy ? (minDy + maxDy) / 2 : Math.min(maxDy, Math.max(minDy, dy));
  return { dx: cx, dy: cy };
}

function materialize(src: PdfObject[], target: PageInfo, sameOffset: number): PdfObject[] {
  // Shift the group as a whole so relative positions survive.
  const first = src[0];
  let dx = 0;
  let dy = 0;
  const samePage = src.every((o) => o.pageId === target.id);
  if (samePage) {
    dx = sameOffset;
    dy = -sameOffset;
  }
  const groupRect = src.reduce<Rect>((acc, o) => {
    const x1 = Math.min(acc.x, o.rect.x);
    const y1 = Math.min(acc.y, o.rect.y);
    const x2 = Math.max(acc.x + acc.width, o.rect.x + o.rect.width);
    const y2 = Math.max(acc.y + acc.height, o.rect.y + o.rect.height);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }, { ...first.rect });
  const c = clampDelta(groupRect, target, dx, dy);
  return src.map((o) => {
    const base = clone(o);
    const moved = { ...base, pageId: target.id, ...translatedPatch({ ...base, pageId: target.id }, c.dx, c.dy) };
    const { id: _id, author: _a, createdAt: _c, modifiedAt: _m, ...rest } = moved;
    return newObject<PdfObject>({
      ...rest,
      replies: [],
      status: undefined,
      locked: false,
      imported: false,
    });
  });
}

/** Paste the clipboard onto the current page. Returns true if something was pasted. */
export function pasteObjects(docId: DocId): boolean {
  const d = getDoc(docId);
  if (!d || !clip || clip.stale || clip.items.length === 0) return false;
  const target = d.pages[d.view.currentPage] ?? d.pages[0];
  if (!target) return false;
  clip.pastes += 1;
  const objs = materialize(clip.items, target, PASTE_OFFSET * clip.pastes);
  actions.addObjects(docId, objs, { select: true, label: 'Paste' });
  return true;
}

/** Duplicate objects in place (offset by 10pt) and select the copies. */
export function duplicateObjects(docId: DocId, ids: ObjectId[]): boolean {
  const d = getDoc(docId);
  if (!d) return false;
  const set = new Set(ids);
  const src = d.order.filter((id) => set.has(id)).map((id) => d.objects[id]);
  if (src.length === 0) return false;
  const byPage = new Map<string, PdfObject[]>();
  for (const o of src) {
    const list = byPage.get(o.pageId) ?? [];
    list.push(o);
    byPage.set(o.pageId, list);
  }
  const out: PdfObject[] = [];
  for (const [pageId, list] of byPage) {
    const page = d.pages.find((p) => p.id === pageId);
    if (page) out.push(...materialize(list, page, PASTE_OFFSET));
  }
  if (out.length === 0) return false;
  actions.addObjects(docId, out, { select: true, label: 'Duplicate' });
  return true;
}
