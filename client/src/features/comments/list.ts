/**
 * The comments of a document as a flat list for the Comments panel, the summary and commands:
 * every object whose kind is in the 'comment' category, with its page, label, summary and
 * reading-order position on the page as displayed.
 */
import type { DocState, PdfObject } from '@/core/types';
import { totalRotation } from '@/core/viewer/viewport';
import { isCommentKind, kindLabel, typeOf } from './model';

export interface Item {
  o: PdfObject;
  pageIndex: number;
  pageLabel: string;
  label: string;
  summary: string;
  color: string;
  /** Reading order on the page as displayed (top → bottom, left → right). */
  pos: [number, number];
}

export function normColor(c: string | null | undefined): string {
  return (c ?? '').toLowerCase() || 'none';
}

export function readingKey(o: PdfObject, rot: number): [number, number] {
  const cx = o.rect.x + o.rect.width / 2;
  const cy = o.rect.y + o.rect.height / 2;
  switch (rot) {
    case 90:
      return [cx, cy];
    case 180:
      return [cy, -cx];
    case 270:
      return [-cx, -cy];
    default:
      return [-cy, cx];
  }
}

export function summaryOf(o: PdfObject): string {
  try {
    return typeOf(o)?.summary?.(o) ?? '';
  } catch {
    return '';
  }
}

export function commentItems(doc: DocState): Item[] {
  const pageIdx = new Map(doc.pages.map((p, i) => [p.id, i]));
  const out: Item[] = [];
  for (const id of doc.order) {
    const o = doc.objects[id];
    if (!o || !isCommentKind(o.kind)) continue;
    const pi = pageIdx.get(o.pageId);
    if (pi === undefined) continue;
    const page = doc.pages[pi];
    out.push({
      o,
      pageIndex: pi,
      pageLabel: page.label || String(pi + 1),
      label: kindLabel(o),
      summary: summaryOf(o),
      color: normColor(o.color ?? o.fillColor),
      pos: readingKey(o, totalRotation(page, doc.view.rotation)),
    });
  }
  return out;
}


export const byPosition = (a: Item, b: Item) => a.pageIndex - b.pageIndex || a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1] || a.o.createdAt - b.o.createdAt;
