/**
 * Stamp tool: a ghost of the current stamp follows the cursor; click places it at its natural
 * size, dragging sizes it (keeping the aspect ratio). Without a current stamp it opens the palette.
 */
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PageOverlayProps, Point, Rect, Rotation } from '@/core/types';
import { actions, newObject, useApp } from '@/core/store';
import type { StampData, StampObject } from '../model';
import { displayRectAt } from '../geom';
import { canDraw } from '../common';
import { stampDesign, stampPaints } from '../stamps/draw';
import { STAMP_TOOL, stampDataFor, useCurrentStamp, useCustomStamps, type StampRef } from '../stamps/custom';
import { TONES, toneOf } from '../stamps/catalog';
import { clampToPage, focusScroller, isDrawStart, trackPointer } from './common';
import { OverlayPaints } from './preview';

export { STAMP_TOOL };
export const STAMP_TASK = 'stamp';

const userName = () => useApp.getState().prefs.userName || 'Guest';

type PageBox = { view: [number, number, number, number] };

/**
 * Stamp rect for a drag from a to b keeping the design's aspect ratio (display orientation). The
 * stamp grows from `a` towards `b` to cover the dragged box, but never past the page edge.
 */
function dragRect(page: PageBox, a: Point, b: Point, design: { w: number; h: number }, rotation: Rotation): Rect {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  const [dw, dh] = rotation % 180 === 0 ? [dx, dy] : [dy, dx];
  const [x0, y0, x1, y1] = page.view;
  // Room between `a` and the page edge in the drag direction (display orientation).
  const roomX = b.x >= a.x ? x1 - a.x : a.x - x0;
  const roomY = b.y >= a.y ? y1 - a.y : a.y - y0;
  const [rw, rh] = rotation % 180 === 0 ? [roomX, roomY] : [roomY, roomX];
  const fit = Math.min(rw / design.w, rh / design.h);
  const k = Math.max(0.05, Math.min(Math.max(dw / design.w, dh / design.h), fit));
  const w = design.w * k, h = design.h * k;
  const [W, H] = rotation % 180 === 0 ? [w, h] : [h, w];
  const x = b.x >= a.x ? a.x : a.x - W;
  const y = b.y >= a.y ? a.y : a.y - H;
  return { x, y, width: W, height: H };
}

/** Shift a rect so it lies on the page (when it fits). */
function keepOnPage(page: PageBox, r: Rect): Rect {
  const [x0, y0, x1, y1] = page.view;
  const x = r.width <= x1 - x0 ? Math.min(x1 - r.width, Math.max(x0, r.x)) : r.x;
  const y = r.height <= y1 - y0 ? Math.min(y1 - r.height, Math.max(y0, r.y)) : r.y;
  return { ...r, x, y };
}

export function placeStamp(docId: string, pageId: string, data: StampData, rect: Rect) {
  const obj = newObject<StampObject>({
    kind: 'stamp',
    pageId,
    rect,
    color: data.image ? undefined : TONES[toneOf(data)],
    fillColor: null,
    opacity: 1,
    data,
  });
  actions.addObject(docId, obj, { select: true, label: 'Add stamp' });
  return obj;
}

export function StampOverlay({ docId, page, rotation, toPdf, toView }: PageOverlayProps) {
  const ref = useCurrentStamp();
  useCustomStamps((s) => s.list); // re-render when custom stamps change
  const [hover, setHover] = useState<Point | null>(null);
  const [drag, setDrag] = useState<Rect | null>(null);
  const dragging = useRef(false);

  const data = ref ? stampDataFor(ref, rotation, userName()) : null;
  const design = data ? stampDesign(data) : null;

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!isDrawStart(e)) return;
    e.preventDefault();
    e.stopPropagation();
    focusScroller(e.currentTarget);
    if (!canDraw(docId)) return;
    const cur: StampRef | null = ref;
    const d0 = cur ? stampDataFor(cur, rotation, userName(), new Date()) : null;
    if (!cur || !d0) {
      actions.toast('Choose a stamp from the Stamps panel first.', { kind: 'info' });
      actions.openTask(STAMP_TASK);
      return;
    }
    const des = stampDesign(d0);
    const a = clampToPage(page, toPdf(e.clientX, e.clientY));
    const sx = e.clientX, sy = e.clientY;
    dragging.current = false;
    trackPointer(e, {
      move: (ev) => {
        if (!dragging.current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        dragging.current = true;
        setDrag(dragRect(page, a, clampToPage(page, toPdf(ev.clientX, ev.clientY)), des, rotation));
      },
      up: (ev) => {
        const b = clampToPage(page, toPdf(ev.clientX, ev.clientY));
        const rect = dragging.current ? dragRect(page, a, b, des, rotation) : keepOnPage(page, displayRectAt(a, des.w, des.h, rotation));
        dragging.current = false;
        setDrag(null);
        if (rect.width < 4 || rect.height < 4) return;
        placeStamp(docId, page.id, d0, rect);
        actions.toolDone();
      },
      cancel: () => {
        dragging.current = false;
        setDrag(null);
      },
    });
  };

  const ghostRect = drag ?? (hover && design ? keepOnPage(page, displayRectAt(clampToPage(page, hover), design.w, design.h, rotation)) : null);
  return (
    <div
      className="drawing-overlay drawing-stamp-overlay"
      data-testid="drawing-overlay-stamp"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => !dragging.current && setHover(toPdf(e.clientX, e.clientY))}
      onPointerLeave={() => setHover(null)}
    >
      {data && ghostRect && <OverlayPaints toView={toView} paints={stampPaints(data, ghostRect)} opacity={drag ? 0.85 : 0.55} testid="drawing-stamp-ghost" />}
    </div>
  );
}
