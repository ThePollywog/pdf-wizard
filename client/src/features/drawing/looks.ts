/**
 * Paint builders per object kind (ink, shapes, lines, polygons, measurements) and the rect
 * conventions they rely on. Used by Render, tool previews and PDF export alike.
 */
import type { Point, Rect, Rotation } from '@/core/types';
import {
  add, bboxOf, centroid, cloudBulge, cloudChord, cloudSegs, deflate, dist, ellipsePolygon, ellipseSegs, endingSize, inflate,
  mul, norm, pointFrame, polySegs, rectSegs, rot, roundRectSegs, smoothSegs, sub, type Seg,
} from './geom';
import { text, type Paint, type PathPaint } from './paint';
import type { InkData, LineData, LineEnding, MeasureData, PolyData, ShapeData, StrokeStyle } from './model';
import { formatMeasure } from './measure/scale';

export interface StyleLike {
  color?: string;
  fillColor?: string | null;
  strokeWidth?: number;
}

const DEFAULT_COLOR = '#e34850';
export const widthOf = (o: StyleLike) => Math.max(0, o.strokeWidth ?? 1);
export const dashFor = (w: number) => [Math.max(3, 3 * w), Math.max(3, 3 * w)];

// ── ink ──────────────────────────────────────────────────────────────────────
export function inkPaints(data: InkData, o: StyleLike): Paint[] {
  const w = Math.max(0.1, widthOf(o));
  const color = o.color ?? DEFAULT_COLOR;
  const smooth = data.smooth !== false;
  return data.paths
    .filter((p) => p.length > 0)
    .map((p): PathPaint => ({ t: 'path', segs: smooth ? smoothSegs(p) : polySegs(p), stroke: color, width: w, cap: 'round', join: 'round' }));
}
export function inkRect(paths: Point[][], w: number): Rect {
  const b = bboxOf(paths.flat()) ?? { x: 0, y: 0, width: 0, height: 0 };
  return inflate(b, w / 2 + 1);
}

// ── line endings ─────────────────────────────────────────────────────────────
interface EndingResult {
  paints: PathPaint[];
  /** Distance to shorten the line at this end. */
  inset: number;
}
/** `dir` points from the line's interior out through `tip`. */
export function endingPaints(kind: LineEnding, tip: Point, dir: Point, w: number, color: string, fill: string | null | undefined, size?: number): EndingResult {
  if (kind === 'None') return { paints: [], inset: 0 };
  const s = size ?? endingSize(w);
  const perp = { x: -dir.y, y: dir.x };
  const base: Omit<PathPaint, 'segs'> = { t: 'path', stroke: color, width: Math.max(0.1, w), cap: 'butt', join: 'miter' };
  const closed = (pts: Point[]): PathPaint => ({ ...base, segs: polySegs(pts, true), fill: fill ?? undefined });
  const open = (pts: Point[]): PathPaint => ({ ...base, segs: polySegs(pts) });
  switch (kind) {
    case 'OpenArrow': {
      const a = sub(tip, mul(rot(dir, 30), s));
      const b = sub(tip, mul(rot(dir, -30), s));
      return { paints: [open([a, tip, b])], inset: w / 2 };
    }
    case 'ClosedArrow': {
      const a = sub(tip, mul(rot(dir, 30), s));
      const b = sub(tip, mul(rot(dir, -30), s));
      return { paints: [closed([tip, a, b])], inset: s * Math.cos(Math.PI / 6) };
    }
    case 'ROpenArrow': {
      const a = add(tip, mul(rot(dir, 30), s));
      const b = add(tip, mul(rot(dir, -30), s));
      return { paints: [open([a, tip, b])], inset: 0 };
    }
    case 'RClosedArrow': {
      const a = add(tip, mul(rot(dir, 30), s));
      const b = add(tip, mul(rot(dir, -30), s));
      return { paints: [closed([tip, a, b])], inset: 0 };
    }
    case 'Circle': {
      const r = s / 2;
      return { paints: [{ ...base, segs: ellipseSegs(tip.x, tip.y, r, r), fill: fill ?? undefined }], inset: r };
    }
    case 'Square': {
      const h = s / 2;
      const pts = [
        add(tip, add(mul(dir, h), mul(perp, h))),
        add(tip, add(mul(dir, -h), mul(perp, h))),
        add(tip, add(mul(dir, -h), mul(perp, -h))),
        add(tip, add(mul(dir, h), mul(perp, -h))),
      ];
      return { paints: [closed(pts)], inset: h };
    }
    case 'Diamond': {
      const h = s / 2;
      const pts = [add(tip, mul(dir, h)), add(tip, mul(perp, h)), sub(tip, mul(dir, h)), sub(tip, mul(perp, h))];
      return { paints: [closed(pts)], inset: h };
    }
    case 'Butt': {
      const h = s / 2;
      return { paints: [open([add(tip, mul(perp, h)), sub(tip, mul(perp, h))])], inset: 0 };
    }
    case 'Slash': {
      const d = rot(dir, 60);
      const h = s / 2;
      return { paints: [open([add(tip, mul(d, h)), sub(tip, mul(d, h))])], inset: 0 };
    }
  }
}

/** Main segment + endings of a line from a to b. */
export function linePathPaints(a: Point, b: Point, endings: [LineEnding, LineEnding], o: StyleLike, style: StrokeStyle, size?: number): Paint[] {
  const w = Math.max(0.1, widthOf(o));
  const color = o.color ?? DEFAULT_COLOR;
  const d = norm(sub(b, a));
  const l = dist(a, b);
  const e0 = endingPaints(endings[0], a, mul(d, -1), w, color, o.fillColor, size);
  const e1 = endingPaints(endings[1], b, d, w, color, o.fillColor, size);
  const i0 = Math.min(e0.inset, l / 2), i1 = Math.min(e1.inset, l / 2);
  const p0 = add(a, mul(d, i0));
  const p1 = sub(b, mul(d, i1));
  const main: PathPaint = {
    t: 'path',
    segs: [['M', p0.x, p0.y], ['L', p1.x, p1.y]],
    stroke: color,
    width: w,
    cap: 'butt',
    dash: style === 'dashed' ? dashFor(w) : undefined,
  };
  return [main, ...e0.paints, ...e1.paints];
}

export function linePaints(data: LineData, o: StyleLike): Paint[] {
  return linePathPaints(data.start, data.end, data.endings, o, data.style);
}
export function lineRect(data: Pick<LineData, 'start' | 'end' | 'endings'>, w: number): Rect {
  const has = data.endings.some((e) => e !== 'None');
  return inflate(bboxOf([data.start, data.end])!, w / 2 + (has ? endingSize(w) : 0) + 1);
}

// ── shapes ───────────────────────────────────────────────────────────────────
export const isCloudy = (d: { type?: string; style: StrokeStyle }) => d.type === 'cloud-rect' || d.style === 'cloudy';

export function shapeSegs(data: ShapeData, rect: Rect, w: number): Seg[] {
  if (isCloudy(data)) {
    const inner = deflate(rect, cloudBulge(data.intensity) + w / 2);
    if (data.type === 'ellipse') {
      const poly = ellipsePolygon(inner.x + inner.width / 2, inner.y + inner.height / 2, inner.width / 2, inner.height / 2, cloudChord(data.intensity));
      return cloudSegs(poly, data.intensity);
    }
    return cloudSegs(
      [
        { x: inner.x, y: inner.y },
        { x: inner.x + inner.width, y: inner.y },
        { x: inner.x + inner.width, y: inner.y + inner.height },
        { x: inner.x, y: inner.y + inner.height },
      ],
      data.intensity,
    );
  }
  const r = deflate(rect, w / 2);
  if (data.type === 'ellipse') return ellipseSegs(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2);
  return rectSegs(r);
}

export function shapePaints(data: ShapeData, rect: Rect, o: StyleLike): Paint[] {
  const w = widthOf(o);
  const cloudy = isCloudy(data);
  return [
    {
      t: 'path',
      segs: shapeSegs(data, rect, w),
      stroke: w > 0 ? (o.color ?? DEFAULT_COLOR) : undefined,
      fill: o.fillColor ?? undefined,
      width: Math.max(0.1, w),
      join: cloudy ? 'round' : 'miter',
      dash: data.style === 'dashed' ? dashFor(w) : undefined,
    },
  ];
}

// ── polygons / polylines ─────────────────────────────────────────────────────
export function polyPaints(data: PolyData, o: StyleLike): Paint[] {
  const w = widthOf(o);
  const color = o.color ?? DEFAULT_COLOR;
  if (data.type === 'polygon') {
    const cloudy = data.style === 'cloudy' && data.vertices.length >= 3;
    return [
      {
        t: 'path',
        segs: cloudy ? cloudSegs(data.vertices, data.intensity) : polySegs(data.vertices, true),
        stroke: w > 0 ? color : undefined,
        fill: o.fillColor ?? undefined,
        width: Math.max(0.1, w),
        join: cloudy ? 'round' : 'miter',
        dash: data.style === 'dashed' ? dashFor(w) : undefined,
      },
    ];
  }
  const v = data.vertices;
  const out: Paint[] = [
    {
      t: 'path',
      segs: polySegs(v),
      stroke: color,
      width: Math.max(0.1, w),
      join: 'miter',
      dash: data.style === 'dashed' ? dashFor(w) : undefined,
    },
  ];
  const ends = data.endings;
  if (ends && v.length >= 2) {
    const e0 = endingPaints(ends[0], v[0], norm(sub(v[0], v[1])), w, color, o.fillColor);
    const e1 = endingPaints(ends[1], v[v.length - 1], norm(sub(v[v.length - 1], v[v.length - 2])), w, color, o.fillColor);
    out.push(...e0.paints, ...e1.paints);
  }
  return out;
}
export function polyRect(data: Pick<PolyData, 'vertices' | 'style' | 'intensity' | 'type' | 'endings'>, w: number): Rect {
  const cloudy = data.type === 'polygon' && data.style === 'cloudy';
  const ends = data.type === 'polyline' && data.endings?.some((e) => e !== 'None');
  const pad = w / 2 + 1 + (cloudy ? cloudBulge(data.intensity) : 0) + (ends ? endingSize(w) : 0) + (data.style === 'solid' || cloudy ? w : 0);
  return inflate(bboxOf(data.vertices) ?? { x: 0, y: 0, width: 0, height: 0 }, pad);
}

// ── measurements ─────────────────────────────────────────────────────────────
export const MEASURE_LABEL_SIZE = 10;
export const measureTick = (w: number) => Math.max(6, 2 * w + 4);

function labelPaints(label: string, anchor: Point, rotation: Rotation, color: string): Paint {
  const t = text(label, 0, 0, MEASURE_LABEL_SIZE, color, true);
  const padX = 4;
  const h = MEASURE_LABEL_SIZE * 1.45;
  const bw = t.width + 2 * padX;
  const box: PathPaint = {
    t: 'path',
    segs: roundRectSegs({ x: -bw / 2, y: -h / 2, width: bw, height: h }, 3),
    fill: '#ffffff',
    fillOpacity: 0.92,
    stroke: color,
    width: 0.6,
  };
  return {
    t: 'group',
    m: pointFrame(anchor, rotation),
    items: [box, { ...t, x: -t.width / 2, y: -MEASURE_LABEL_SIZE * 0.35 }],
  };
}

/** Where the value label of a measurement sits (PDF space). */
export function measureLabelAnchor(data: Pick<MeasureData, 'type' | 'points'>, rotation: Rotation): Point | null {
  const p = data.points;
  if (p.length === 0) return null;
  if (data.type === 'distance') return p.length >= 2 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : null;
  if (data.type === 'area') return p.length >= 3 ? centroid(p) : null;
  if (p.length < 2) return null;
  // Perimeter: just past the last vertex, towards display bottom-right.
  const last = p[p.length - 1];
  const f = pointFrame(last, rotation);
  return { x: last.x + f[0] * 22 + f[2] * -12, y: last.y + f[1] * 22 + f[3] * -12 };
}

export function measurePaints(data: MeasureData, o: StyleLike, rotation: Rotation, label?: string): Paint[] {
  const w = Math.max(0.1, widthOf(o));
  const color = o.color ?? '#1473e6';
  const pts = data.points;
  const out: Paint[] = [];
  if (data.type === 'distance') {
    if (pts.length < 2) return out;
    const [a, b] = pts;
    const size = endingSize(w) * 0.8;
    out.push(...linePathPaints(a, b, ['ClosedArrow', 'ClosedArrow'], { ...o, fillColor: color }, 'solid', size));
    const d = norm(sub(b, a));
    const perp = { x: -d.y, y: d.x };
    const t = measureTick(w);
    for (const p of [a, b]) {
      out.push({ t: 'path', segs: polySegs([add(p, mul(perp, t)), sub(p, mul(perp, t))]), stroke: color, width: w, cap: 'butt' });
    }
  } else if (data.type === 'perimeter') {
    if (pts.length < 1) return out;
    out.push({ t: 'path', segs: polySegs(pts), stroke: color, width: w, join: 'miter', cap: 'butt' });
    for (const p of pts) {
      const r = Math.max(1.5, w * 1.2);
      out.push({ t: 'path', segs: ellipseSegs(p.x, p.y, r, r), fill: color, noHit: true });
    }
  } else {
    if (pts.length < 2) return out;
    out.push({ t: 'path', segs: polySegs(pts, pts.length >= 3), stroke: color, width: w, fill: pts.length >= 3 ? color : undefined, fillOpacity: 0.18, join: 'miter' });
  }
  const text = label ?? formatMeasure(data.value, data.type, data.scale.realUnit, data.precision);
  const anchor = measureLabelAnchor(data, rotation);
  if (anchor && text) out.push(labelPaints(text, anchor, rotation, color));
  return out;
}

export function measureRect(data: Pick<MeasureData, 'type' | 'points'>, w: number): Rect {
  const pad = data.type === 'distance' ? Math.max(endingSize(w) * 0.8, measureTick(w)) + w / 2 + 1 : w / 2 + 3;
  return inflate(bboxOf(data.points) ?? { x: 0, y: 0, width: 0, height: 0 }, pad);
}
