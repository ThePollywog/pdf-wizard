/**
 * Click-to-add-vertex tools: polyline, polygon, cloud, perimeter and area.
 * Click adds a vertex (Shift: 45° from the previous one), double-click / Enter finishes, clicking
 * the first vertex closes a polygon, Backspace removes the last vertex and Esc cancels.
 */
import { useEffect, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { create } from 'zustand';
import type { DocId, PageId, PageOverlayProps, Point } from '@/core/types';
import { actions, getDoc, getToolOptions, newObject, useApp } from '@/core/store';
import { LINE_DEFAULTS, SHAPE_DEFAULTS, type MeasureData, type MeasureObject, type MeasureType, type PolyData, type PolyObject } from '../model';
import { measurePaints, measureRect, polyPaints, polyRect } from '../looks';
import { dist, snap45 } from '../geom';
import { canDraw } from '../common';
import { measureValue } from '../measure/scale';
import { getMeasureOptions, liveText, scaleOf, setLive, snapPoint, snapTargets, useMeasureLive } from '../measure/live';
import { clampToPage, focusScroller, isDrawStart, sessionKeyOk } from './common';
import { OverlayPaints } from './preview';
import type { Paint } from '../paint';

export const POLYLINE_TOOL = 'shape-polyline';
export const POLYGON_TOOL = 'shape-polygon';
export const CLOUD_TOOL = 'shape-cloud';
export const PERIMETER_TOOL = 'measure-perimeter';
export const AREA_TOOL = 'measure-area';

export const POLYLINE_DEFAULTS = { color: LINE_DEFAULTS.color, width: 2, opacity: 1, style: 'solid' as 'solid' | 'dashed', start: LINE_DEFAULTS.start, end: LINE_DEFAULTS.end };
export const POLYGON_DEFAULTS = { ...SHAPE_DEFAULTS };
export const CLOUD_DEFAULTS = { ...SHAPE_DEFAULTS, style: 'cloudy' as const };

type Kind = 'polyline' | 'polygon' | 'cloud' | 'perimeter' | 'area';
const KIND: Record<string, Kind> = {
  [POLYLINE_TOOL]: 'polyline',
  [POLYGON_TOOL]: 'polygon',
  [CLOUD_TOOL]: 'cloud',
  [PERIMETER_TOOL]: 'perimeter',
  [AREA_TOOL]: 'area',
};
const closedKind = (k: Kind) => k === 'polygon' || k === 'cloud' || k === 'area';
const minPoints = (k: Kind) => (closedKind(k) ? 3 : 2);
const isMeasure = (k: Kind) => k === 'perimeter' || k === 'area';

export const polyToolOptions = (toolId: string) => {
  if (toolId === POLYLINE_TOOL) return { ...getToolOptions(toolId, POLYLINE_DEFAULTS), fill: null as string | null, intensity: 1 };
  if (toolId === CLOUD_TOOL) return { ...getToolOptions(toolId, CLOUD_DEFAULTS), style: 'cloudy' as const, start: 'None' as const, end: 'None' as const };
  return { ...getToolOptions(toolId, POLYGON_DEFAULTS), start: 'None' as const, end: 'None' as const };
};

interface Session {
  toolId: string;
  docId: DocId;
  pageId: PageId;
  points: Point[];
  hover: Point | null;
  /** Hovering the first vertex (click closes). */
  closing: boolean;
}
export const usePolySession = create<{ s: Session | null }>(() => ({ s: null }));
const setSession = (s: Session | null) => usePolySession.setState({ s });

export function cancelPolySession() {
  if (usePolySession.getState().s) setSession(null);
  setLive(null);
}

function polyData(kind: Kind, toolId: string, points: Point[]): PolyData {
  const o = polyToolOptions(toolId);
  if (kind === 'polyline') return { type: 'polyline', vertices: points, style: o.style === 'dashed' ? 'dashed' : 'solid', intensity: 1, endings: [o.start, o.end] };
  return { type: 'polygon', vertices: points, style: kind === 'cloud' ? 'cloudy' : o.style === 'cloudy' ? 'cloudy' : o.style, intensity: o.intensity };
}

function measureData(kind: 'perimeter' | 'area', points: Point[]): MeasureData {
  const o = getMeasureOptions();
  const scale = scaleOf(o);
  return { type: kind as MeasureType, points, scale, precision: o.precision, value: measureValue(kind, points, scale) };
}

const LABELS: Record<Kind, string> = { polyline: 'Add polyline', polygon: 'Add polygon', cloud: 'Add cloud', perimeter: 'Add perimeter', area: 'Add area' };

/** Create the object for the current session (if it has enough points) and end it. */
export function finishPolySession(): boolean {
  const s = usePolySession.getState().s;
  if (!s) return false;
  const kind = KIND[s.toolId];
  // Drop a trailing duplicate (second click of a double-click).
  const pts = s.points.filter((p, i, a) => i === 0 || dist(p, a[i - 1]) > 1e-6);
  setSession(null);
  setLive(null);
  // The page may have been deleted (or the document closed) while the session was open.
  if (!getDoc(s.docId)?.pages.some((pg) => pg.id === s.pageId)) return false;
  if (!kind || pts.length < minPoints(kind)) {
    if (kind && pts.length > 0) actions.toast(`A ${kind} needs at least ${minPoints(kind)} points.`, { kind: 'info' });
    return false;
  }
  if (isMeasure(kind)) {
    const o = getMeasureOptions();
    const data = measureData(kind as 'perimeter' | 'area', pts);
    const obj = newObject<MeasureObject>({
      kind: 'measure',
      pageId: s.pageId,
      rect: measureRect(data, o.width),
      color: o.color,
      fillColor: null,
      opacity: o.opacity,
      strokeWidth: o.width,
      data,
    });
    actions.addObject(s.docId, obj, { select: false, label: LABELS[kind] });
    return true;
  }
  const o = polyToolOptions(s.toolId);
  const data = polyData(kind, s.toolId, pts);
  const obj = newObject<PolyObject>({
    kind: 'poly',
    pageId: s.pageId,
    rect: polyRect(data, o.width),
    color: o.color,
    fillColor: kind === 'polyline' ? null : o.fill,
    opacity: o.opacity,
    strokeWidth: o.width,
    data,
  });
  actions.addObject(s.docId, obj, { select: true, label: LABELS[kind] });
  actions.toolDone();
  return true;
}

function previewPaints(kind: Kind, toolId: string, pts: Point[], rotation: PageOverlayProps['rotation'], label: string | null): { paints: Paint[]; opacity: number } {
  if (isMeasure(kind)) {
    const o = getMeasureOptions();
    const data = measureData(kind as 'perimeter' | 'area', pts);
    return { paints: measurePaints(data, { color: o.color, strokeWidth: o.width }, rotation, label ?? undefined), opacity: o.opacity };
  }
  const o = polyToolOptions(toolId);
  const data = polyData(kind, toolId, pts);
  return { paints: polyPaints(data, { color: o.color, fillColor: kind === 'polyline' ? null : o.fill, strokeWidth: o.width }), opacity: o.opacity };
}

const CLOSE_PX = 8;

export function PolyOverlay({ docId, page, scale, rotation, toPdf, toView, toolId }: PageOverlayProps & { toolId: string }) {
  const kind = KIND[toolId];
  const session = usePolySession((st) => (st.s && st.s.docId === docId && st.s.pageId === page.id && st.s.toolId === toolId ? st.s : null));
  const liveLabel = useMeasureLive((st) => st.text);
  const active = !!session;

  // Keys while a session is open on this page.
  useEffect(() => {
    if (!active) return;
    const onKey = (ev: KeyboardEvent) => {
      if (!sessionKeyOk(ev)) return;
      const s = usePolySession.getState().s;
      if (!s) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        finishPolySession();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cancelPolySession();
      } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
        ev.preventDefault();
        ev.stopPropagation();
        const points = s.points.slice(0, -1);
        if (points.length === 0) cancelPolySession();
        else {
          setSession({ ...s, points, closing: false });
          if (isMeasure(KIND[s.toolId])) setLive(KIND[s.toolId] as MeasureType, s.hover ? [...points, s.hover] : points);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);

  const pointAt = (cx: number, cy: number, shift: boolean, s: Session | null): { p: Point; closing: boolean } => {
    let p = clampToPage(page, toPdf(cx, cy));
    const pts = s?.points ?? [];
    if (s && closedKind(kind) && pts.length >= 3 && dist(p, pts[0]) * scale <= CLOSE_PX) return { p: pts[0], closing: true };
    if (shift && pts.length) p = clampToPage(page, snap45(pts[pts.length - 1], p));
    else if (isMeasure(kind) && getMeasureOptions().snap) p = snapPoint(p, [...snapTargets(docId, page.id), ...pts], scale).p;
    return { p, closing: false };
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!isDrawStart(e)) return;
    e.preventDefault();
    e.stopPropagation();
    focusScroller(e.currentTarget);
    if (!canDraw(docId)) return;
    const cur = usePolySession.getState().s;
    const s = cur && cur.docId === docId && cur.pageId === page.id && cur.toolId === toolId ? cur : null;
    // A click on another page ends a session that already has enough points (a shape stays on one page).
    if (cur && !s && KIND[cur.toolId] && cur.points.length >= minPoints(KIND[cur.toolId])) {
      finishPolySession();
      return;
    }
    const { p, closing } = pointAt(e.clientX, e.clientY, e.shiftKey, s);
    if (s && closing) {
      finishPolySession();
      return;
    }
    const points = s ? s.points : [];
    // Second click of a double-click lands on the same spot: ignore it.
    if (points.length && dist(points[points.length - 1], p) * scale < 3) return;
    const next = [...points, p];
    setSession({ toolId, docId, pageId: page.id, points: next, hover: p, closing: false });
    if (isMeasure(kind)) setLive(kind as MeasureType, next);
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const s = usePolySession.getState().s;
    if (!s || s.docId !== docId || s.pageId !== page.id || s.toolId !== toolId) return;
    const { p, closing } = pointAt(e.clientX, e.clientY, e.shiftKey, s);
    setSession({ ...s, hover: p, closing });
    if (isMeasure(kind)) setLive(kind as MeasureType, closing ? s.points : [...s.points, p]);
  };

  const onDoubleClick = (e: RMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (usePolySession.getState().s) finishPolySession();
  };

  let preview: { paints: Paint[]; opacity: number } | null = null;
  let pts: Point[] = [];
  if (session && kind) {
    pts = session.hover && !session.closing ? [...session.points, session.hover] : session.points;
    const label = isMeasure(kind) ? liveLabel ?? liveText(kind as MeasureType, pts) : null;
    preview = previewPaints(kind, toolId, pts, rotation, label);
  }

  return (
    <div
      className="drawing-overlay"
      data-testid={`drawing-overlay-${kind}`}
      data-session={session ? session.points.length : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={onDoubleClick}
    >
      {preview && <OverlayPaints toView={toView} paints={preview.paints} opacity={preview.opacity} />}
      {session?.points.map((p, i) => {
        const v = toView(p);
        return (
          <div
            key={i}
            className={`drawing-session-vertex${i === 0 && session.closing ? ' is-closing' : ''}`}
            style={{ left: v.x, top: v.y }}
            data-testid={`drawing-session-vertex-${i}`}
          />
        );
      })}
    </div>
  );
}

/** Hint shown in the options bar of the click-to-add tools. */
export function PolyHint({ toolId }: { toolId: string }) {
  const session = usePolySession((st) => (st.s && st.s.toolId === toolId ? st.s.points.length : 0));
  const kind = KIND[toolId];
  const tool = useApp((s) => s.activeToolId);
  if (tool !== toolId || !kind) return null;
  return (
    <span className="drawing-hint" data-testid="drawing-poly-hint">
      {session === 0
        ? 'Click to place the first point'
        : `${session} point${session === 1 ? '' : 's'} · Double-click or Enter to finish · Backspace removes the last point · Esc cancels`}
    </span>
  );
}
