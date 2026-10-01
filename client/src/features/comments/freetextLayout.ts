/**
 * Geometry updates of text boxes / callouts after their text or style changes (auto-grow).
 */
import type { PageInfo, PdfObject, Rect } from '@/core/types';
import { anchorFrame, availableWidth, calloutBounds, calloutLeader, frameSizeOf, layoutFreeText } from './layout';
import type { Callout, FreeTextData, FreeTextObject } from './model';

/** Effective border width (no border without a border color). */
export function borderOf(o: Pick<PdfObject, 'color' | 'strokeWidth'>): number {
  return o.color ? Math.max(0, o.strokeWidth ?? 0) : 0;
}

/** Box holding the text (the whole rect for plain text boxes). */
export function textBoxOf(o: FreeTextObject): Rect {
  return o.data.callout ? o.data.callout.box : o.rect;
}

/**
 * New `data` + `rect` of a text box after applying `patch` to its data (and optionally new
 * border settings): width follows the text for auto-width boxes, height always follows the text
 * (never below the user-set minimum), and the visual top-left corner stays put.
 */
export function relayoutFreeText(
  o: FreeTextObject,
  patch: Partial<FreeTextData>,
  page: PageInfo | undefined,
  objPatch: Partial<Pick<PdfObject, 'color' | 'strokeWidth'>> = {},
): { data: FreeTextData; rect: Rect } {
  const d: FreeTextData = { ...o.data, ...patch };
  const look = { color: 'color' in objPatch ? objPatch.color : o.color, strokeWidth: objPatch.strokeWidth ?? o.strokeWidth };
  const sw = borderOf(look);
  const box = d.callout ? d.callout.box : o.rect;
  const rot = d.rotate;
  const { w: curW } = frameSizeOf(box, rot);
  const maxW = page ? availableWidth(page, box, rot) : undefined;
  const L = layoutFreeText(d, sw, d.autoWidth ? null : curW, { maxW, minH: d.minHeight ?? 0 });
  const nextBox = anchorFrame(box, rot, L.fw, L.fh);
  if (d.callout) {
    const callout: Callout = { box: nextBox, points: calloutLeader(nextBox, d.callout.points[0] ?? { x: nextBox.x, y: nextBox.y }) };
    return { data: { ...d, callout }, rect: calloutBounds(callout, look.strokeWidth ?? 1) };
  }
  return { data: d, rect: nextBox };
}

/** Callout with a moved box (the leader re-attaches to the nearest side). */
export function withCalloutBox(o: FreeTextObject, box: Rect): { data: FreeTextData; rect: Rect } {
  const c = o.data.callout!;
  const callout: Callout = { box, points: calloutLeader(box, c.points[0]) };
  return { data: { ...o.data, callout }, rect: calloutBounds(callout, o.strokeWidth ?? 1) };
}
