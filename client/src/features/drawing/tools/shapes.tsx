/**
 * Drag tools: rectangle, oval, line and arrow. Shift constrains (square / circle / 45°),
 * Alt draws a box from its center. A click without dragging creates a default-size shape.
 */
import { useRef, type PointerEvent as RPointerEvent } from 'react';
import type { PageOverlayProps, Point, Rect } from '@/core/types';
import { actions, getToolOptions, newObject } from '@/core/store';
import { rectFromPoints } from '@/core/geometry';
import { ARROW_DEFAULTS, LINE_DEFAULTS, SHAPE_DEFAULTS, type LineData, type LineObject, type ShapeData, type ShapeObject } from '../model';
import { linePaints, lineRect, shapePaints } from '../looks';
import { add, displayAxes, displayRectAt, dist, mul, snap45, snapSquare } from '../geom';
import { canDraw } from '../common';
import { clampToPage, focusScroller, isDrawStart, trackPointer } from './common';
import { OverlayPaints, useFrameTick } from './preview';
import type { Paint } from '../paint';

export type BoxKind = 'rect' | 'ellipse';
export const RECT_TOOL = 'shape-rect';
export const ELLIPSE_TOOL = 'shape-ellipse';
export const LINE_TOOL = 'shape-line';
export const ARROW_TOOL = 'shape-arrow';

export const shapeOptions = (toolId: string) => getToolOptions(toolId, SHAPE_DEFAULTS);
export const lineOptions = (toolId: string) => getToolOptions(toolId, toolId === ARROW_TOOL ? ARROW_DEFAULTS : LINE_DEFAULTS);

function shapeData(kind: BoxKind, o: typeof SHAPE_DEFAULTS): ShapeData {
  const cloudy = o.style === 'cloudy';
  return { type: kind === 'ellipse' ? 'ellipse' : cloudy ? 'cloud-rect' : 'rect', style: o.style, intensity: o.intensity };
}

function boxRect(a: Point, b: Point, shift: boolean, alt: boolean): Rect {
  let p = b;
  if (shift) p = snapSquare(a, p);
  if (alt) {
    const d = { x: p.x - a.x, y: p.y - a.y };
    return rectFromPoints({ x: a.x - d.x, y: a.y - d.y }, p);
  }
  return rectFromPoints(a, p);
}

const MIN_DRAG_PX = 3;

export function BoxOverlay({ docId, page, rotation, toPdf, toView, kind, toolId }: PageOverlayProps & { kind: BoxKind; toolId: string }) {
  const drag = useRef<Rect | null>(null);
  const tick = useFrameTick();

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!isDrawStart(e)) return;
    e.preventDefault();
    e.stopPropagation();
    focusScroller(e.currentTarget);
    if (!canDraw(docId)) return;
    const a = clampToPage(page, toPdf(e.clientX, e.clientY));
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    trackPointer(e, {
      move: (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < MIN_DRAG_PX) return;
        moved = true;
        drag.current = boxRect(a, clampToPage(page, toPdf(ev.clientX, ev.clientY)), ev.shiftKey, ev.altKey);
        tick();
      },
      up: () => {
        const o = shapeOptions(toolId);
        let rect = moved ? drag.current : null;
        drag.current = null;
        tick();
        if (!rect || rect.width < 2 || rect.height < 2) {
          const w = kind === 'ellipse' ? 72 : 90, h = kind === 'ellipse' ? 72 : 60;
          rect = displayRectAt(a, w, h, rotation);
        }
        const obj = newObject<ShapeObject>({
          kind: 'shape',
          pageId: page.id,
          rect,
          color: o.color,
          fillColor: o.fill,
          opacity: o.opacity,
          strokeWidth: o.width,
          data: shapeData(kind, o),
        });
        actions.addObject(docId, obj, { select: true, label: kind === 'ellipse' ? 'Add oval' : 'Add rectangle' });
        actions.toolDone();
      },
      cancel: () => {
        drag.current = null;
        tick();
      },
    });
  };

  const r = drag.current;
  let paints: Paint[] = [];
  let opacity = 1;
  if (r) {
    const o = shapeOptions(toolId);
    opacity = o.opacity;
    paints = shapePaints(shapeData(kind, o), r, { color: o.color, fillColor: o.fill, strokeWidth: o.width });
  }
  return (
    <div className="drawing-overlay" data-testid={`drawing-overlay-${kind}`} onPointerDown={onPointerDown}>
      {r && <OverlayPaints toView={toView} paints={paints} opacity={opacity} />}
      {r && <SizeReadout toView={toView} rect={r} rotation={rotation} />}
    </div>
  );
}

/** Small "W × H" chip next to the box while dragging (display orientation). */
function SizeReadout({ toView, rect, rotation }: { toView(p: Point): { x: number; y: number }; rect: Rect; rotation: number }) {
  const a = toView({ x: rect.x, y: rect.y });
  const b = toView({ x: rect.x + rect.width, y: rect.y + rect.height });
  const left = Math.max(a.x, b.x) + 8, top = Math.max(a.y, b.y) + 8;
  const [w, h] = rotation % 180 === 0 ? [rect.width, rect.height] : [rect.height, rect.width];
  return (
    <div className="drawing-readout-chip" style={{ left, top }} data-testid="drawing-size-readout">
      {Math.round(w)} × {Math.round(h)} pt
    </div>
  );
}

export function LineOverlay({ docId, page, rotation, toPdf, toView, toolId }: PageOverlayProps & { toolId: string }) {
  const drag = useRef<LineData | null>(null);
  const tick = useFrameTick();

  const dataFor = (a: Point, b: Point): LineData => {
    const o = lineOptions(toolId);
    return { start: a, end: b, endings: [o.start, o.end], style: o.style };
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!isDrawStart(e)) return;
    e.preventDefault();
    e.stopPropagation();
    focusScroller(e.currentTarget);
    if (!canDraw(docId)) return;
    const a = clampToPage(page, toPdf(e.clientX, e.clientY));
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    trackPointer(e, {
      move: (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < MIN_DRAG_PX) return;
        moved = true;
        let b = clampToPage(page, toPdf(ev.clientX, ev.clientY));
        if (ev.shiftKey) b = clampToPage(page, snap45(a, b));
        drag.current = dataFor(a, b);
        tick();
      },
      up: () => {
        const o = lineOptions(toolId);
        let data = moved ? drag.current : null;
        drag.current = null;
        tick();
        if (!data || dist(data.start, data.end) < 1) {
          const { eu } = displayAxes(rotation);
          data = dataFor(a, clampToPage(page, add(a, mul(eu, 96))));
        }
        const obj = newObject<LineObject>({
          kind: 'line',
          pageId: page.id,
          rect: lineRect(data, o.width),
          color: o.color,
          fillColor: null,
          opacity: o.opacity,
          strokeWidth: o.width,
          data,
        });
        actions.addObject(docId, obj, { select: true, label: toolId === ARROW_TOOL ? 'Add arrow' : 'Add line' });
        actions.toolDone();
      },
      cancel: () => {
        drag.current = null;
        tick();
      },
    });
  };

  const d = drag.current;
  const o = lineOptions(toolId);
  return (
    <div className="drawing-overlay" data-testid={toolId === ARROW_TOOL ? 'drawing-overlay-arrow' : 'drawing-overlay-line'} onPointerDown={onPointerDown}>
      {d && <OverlayPaints toView={toView} paints={linePaints(d, { color: o.color, strokeWidth: o.width })} opacity={o.opacity} />}
      {d && <LengthReadout toView={toView} a={d.start} b={d.end} />}
    </div>
  );
}

function LengthReadout({ toView, a, b }: { toView(p: Point): { x: number; y: number }; a: Point; b: Point }) {
  const va = toView(a), v = toView(b);
  const deg = Math.round((Math.atan2(va.y - v.y, v.x - va.x) * 180) / Math.PI);
  return (
    <div className="drawing-readout-chip" style={{ left: v.x + 12, top: v.y + 12 }} data-testid="drawing-size-readout">
      {Math.round(dist(a, b))} pt · {((deg % 360) + 360) % 360}°
    </div>
  );
}
