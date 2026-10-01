/**
 * Vertex handles of a selected line / polygon / polyline / measurement: drag a point (Shift snaps
 * to 45° from the neighbouring point, Esc cancels), right-click to delete a point. Rendered into
 * the page's vertex layer, above the selection frame.
 */
import { useRef, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import type { DocId, PageInfo, PageViewport, PdfObject, Point } from '@/core/types';
import { actions, getDoc, useApp, useDoc } from '@/core/store';
import { toView } from '@/core/geometry';
import { useViewerUi, viewerUi } from '@/core/viewer/viewerStore';
import { showContextMenu } from '@/core/ui';
import { usePageLayer } from './layers';
import { add, snap45, sub } from './geom';

export interface VertexHandlesProps {
  docId: DocId;
  obj: PdfObject;
  page: PageInfo;
  viewport: PageViewport;
  selected: boolean;
  points: Point[];
  /** Object patch for new points (rect + data). */
  apply(points: Point[]): Partial<PdfObject>;
  /** Points can be deleted while there are more than this many. */
  minPoints?: number;
  /** The shape is closed (the first point's neighbour is the last one). */
  closed?: boolean;
  /** Undo label. */
  label?: string;
}

export function VertexHandles(props: VertexHandlesProps) {
  const { docId, obj, selected } = props;
  const toolId = useApp((s) => s.activeToolId);
  const single = useDoc(docId, (d) => (d?.selection.length ?? 0) === 1);
  const interaction = useViewerUi((s) => s.interaction);
  const show = selected && single && toolId === 'select' && !obj.locked && interaction !== 'move' && interaction !== 'marquee';
  const anchor = useRef<HTMLSpanElement>(null);
  const layer = usePageLayer(anchor, 'vertex', show);
  return (
    <>
      <span ref={anchor} hidden className="drawing-anchor" />
      {show && layer && createPortal(<Handles {...props} layer={layer} />, layer)}
    </>
  );
}

function Handles({ docId, obj, page, viewport, points, apply, minPoints = 2, closed, label = 'Edit points', layer }: VertexHandlesProps & { layer: HTMLElement }) {
  const toPdf = (cx: number, cy: number): Point => {
    const r = layer.getBoundingClientRect();
    const [x, y] = viewport.convertToPdfPoint(cx - r.left, cy - r.top);
    const [x0, y0, x1, y1] = page.view;
    return { x: Math.min(x1, Math.max(x0, x)), y: Math.min(y1, Math.max(y0, y)) };
  };

  const onPointerDown = (i: number) => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const orig = getDoc(docId)?.objects[obj.id];
    if (!orig) return;
    const start = points.slice();
    const offset = sub(start[i], toPdf(e.clientX, e.clientY));
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const ctrl = new AbortController();
    const neighbour = (): Point | undefined => {
      if (i > 0) return start[i - 1];
      if (closed) return start[start.length - 1];
      return start[1];
    };
    const move = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 2) return;
        moved = true;
        actions.checkpoint(docId, label);
        viewerUi.set({ interaction: 'resize' });
      }
      let p = add(toPdf(ev.clientX, ev.clientY), offset);
      const n = ev.shiftKey ? neighbour() : undefined;
      if (n) p = snap45(n, p);
      const next = start.slice();
      next[i] = p;
      actions.updateObject(docId, obj.id, apply(next), { checkpoint: false });
    };
    const finish = (cancel: boolean) => {
      ctrl.abort();
      if (!moved) return;
      viewerUi.set({ interaction: null });
      if (cancel) actions.updateObject(docId, obj.id, { rect: orig.rect, data: orig.data }, { checkpoint: false });
    };
    const opts = { signal: ctrl.signal, capture: true };
    window.addEventListener('pointermove', move, opts);
    window.addEventListener('pointerup', () => finish(false), opts);
    window.addEventListener('pointercancel', () => finish(true), opts);
    window.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
      },
      opts,
    );
  };

  const onContextMenu = (i: number) => (e: RMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (points.length <= minPoints) return;
    showContextMenu(e, [
      {
        id: 'drawing-vertex-delete',
        label: 'Delete point',
        icon: Trash2,
        run: () => {
          const next = points.filter((_, k) => k !== i);
          actions.updateObject(docId, obj.id, apply(next), { label: 'Delete point' });
        },
      },
    ]);
  };

  return (
    <>
      {points.map((p, i) => {
        const v = toView(viewport, p);
        return (
          <div
            key={i}
            className="drawing-vertex"
            style={{ left: v.x, top: v.y }}
            data-testid={`drawing-vertex-${i}`}
            data-viewer-passthrough=""
            role="presentation"
            onPointerDown={onPointerDown(i)}
            onContextMenu={onContextMenu(i)}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        );
      })}
    </>
  );
}
