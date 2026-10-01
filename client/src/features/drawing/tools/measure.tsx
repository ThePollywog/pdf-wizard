/**
 * Distance tool: drag, or click the start and click the end. Shift snaps to 45°, points snap to
 * existing vertices when snapping is on; the value is shown live next to the cursor.
 */
import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react';
import type { PageOverlayProps, Point } from '@/core/types';
import { actions, newObject } from '@/core/store';
import type { MeasureData, MeasureObject } from '../model';
import { measurePaints, measureRect } from '../looks';
import { snap45 } from '../geom';
import { canDraw } from '../common';
import { measureValue } from '../measure/scale';
import { getMeasureOptions, liveText, scaleOf, setLive, snapPoint, snapTargets } from '../measure/live';
import { clampToPage, focusScroller, isDrawStart, sessionKeyOk, trackPointer } from './common';
import { OverlayPaints, useFrameTick } from './preview';

export const DISTANCE_TOOL = 'measure-distance';

function distanceData(a: Point, b: Point): MeasureData {
  const o = getMeasureOptions();
  const scale = scaleOf(o);
  return { type: 'distance', points: [a, b], scale, precision: o.precision, value: measureValue('distance', [a, b], scale) };
}

export function DistanceOverlay({ docId, page, scale, rotation, toPdf, toView }: PageOverlayProps) {
  /** start: first point; end: current end; pending: waiting for the second click. */
  const st = useRef<{ start: Point; end: Point; pending: boolean; snapped: boolean } | null>(null);
  const tick = useFrameTick();

  const pick = (cx: number, cy: number, shift: boolean) => {
    let p = clampToPage(page, toPdf(cx, cy));
    const s = st.current;
    if (shift && s) return { p: clampToPage(page, snap45(s.start, p)), snapped: false };
    if (getMeasureOptions().snap) {
      const r = snapPoint(p, snapTargets(docId, page.id), scale);
      p = r.p;
      return r;
    }
    return { p, snapped: false };
  };

  const commit = (a: Point, b: Point) => {
    st.current = null;
    setLive(null);
    tick();
    if (Math.hypot(a.x - b.x, a.y - b.y) * scale < 3) return;
    const o = getMeasureOptions();
    const data = distanceData(a, b);
    const obj = newObject<MeasureObject>({
      kind: 'measure',
      pageId: page.id,
      rect: measureRect(data, o.width),
      color: o.color,
      fillColor: null,
      opacity: o.opacity,
      strokeWidth: o.width,
      data,
    });
    actions.addObject(docId, obj, { select: false, label: 'Add distance' });
  };

  const cancel = () => {
    st.current = null;
    setLive(null);
    tick();
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!st.current?.pending || ev.key !== 'Escape' || !sessionKeyOk(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (st.current) setLive(null);
    };
  }, []);

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!isDrawStart(e)) return;
    e.preventDefault();
    e.stopPropagation();
    focusScroller(e.currentTarget);
    if (!canDraw(docId)) return;
    const cur = st.current;
    if (cur?.pending) {
      const { p } = pick(e.clientX, e.clientY, e.shiftKey);
      commit(cur.start, p);
      return;
    }
    const { p: a, snapped } = pick(e.clientX, e.clientY, false);
    st.current = { start: a, end: a, pending: false, snapped };
    tick();
    const sx = e.clientX, sy = e.clientY;
    let dragged = false;
    trackPointer(e, {
      move: (ev) => {
        const s = st.current;
        if (!s) return;
        if (!dragged && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        dragged = true;
        const r = pick(ev.clientX, ev.clientY, ev.shiftKey);
        st.current = { ...s, end: r.p, snapped: r.snapped };
        setLive('distance', [s.start, r.p]);
        tick();
      },
      up: () => {
        const s = st.current;
        if (!s) return;
        if (dragged) commit(s.start, s.end);
        else {
          st.current = { ...s, pending: true };
          setLive('distance', [s.start, s.end]);
          tick();
        }
      },
      cancel,
    });
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const s = st.current;
    if (!s?.pending) return;
    const r = pick(e.clientX, e.clientY, e.shiftKey);
    st.current = { ...s, end: r.p, snapped: r.snapped };
    setLive('distance', [s.start, r.p]);
    tick();
  };

  const s = st.current;
  const o = getMeasureOptions();
  const data = s ? distanceData(s.start, s.end) : null;
  const label = s ? liveText('distance', [s.start, s.end], o) : '';
  const endV = s ? toView(s.end) : null;
  return (
    <div className="drawing-overlay" data-testid="drawing-overlay-distance" data-pending={s?.pending ? '' : undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
      {data && s && (s.pending || s.end !== s.start) && (
        <OverlayPaints toView={toView} paints={measurePaints(data, { color: o.color, strokeWidth: o.width }, rotation, label)} opacity={o.opacity} />
      )}
      {s && endV && (
        <>
          <div className="drawing-session-vertex" style={{ ...toViewStyle(toView(s.start)) }} />
          {s.snapped && <div className="drawing-snap-ring" style={toViewStyle(endV)} data-testid="drawing-snap-indicator" />}
        </>
      )}
    </div>
  );
}

const toViewStyle = (v: { x: number; y: number }) => ({ left: v.x, top: v.y });
