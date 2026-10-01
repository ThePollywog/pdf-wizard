/** Polygons, polylines and clouds. Exported as /Polygon (cloudy: /BE) or /PolyLine (/LE). */
import { useMemo } from 'react';
import { Pentagon, Spline } from 'lucide-react';
import type { MenuItem, ObjectRenderProps, ObjectTypeDef, Point } from '@/core/types';
import { translateRect } from '@/core/geometry';
import { actions } from '@/core/store';
import type { PolyData, PolyObject, StrokeStyle } from '../model';
import { dashFor, polyPaints, polyRect, widthOf } from '../looks';
import { translatePts } from '../geom';
import { flatPts, mapPoints, plural, pointsBox } from '../common';
import { PaintObject } from '../render';
import { VertexHandles } from '../VertexHandles';
import { borderStyle, cloudyEffect, exportPaints } from '../exporting';
import { ColorControl, EndingControl, IntensityControl, OpacityControl, StyleControl, WidthControl } from '../controls';

export function polyName(d: Pick<PolyData, 'type' | 'style'>): string {
  if (d.type === 'polyline') return 'Polyline';
  return d.style === 'cloudy' ? 'Cloud' : 'Polygon';
}

export function polyPatch(o: PolyObject, vertices: Point[]): Partial<PolyObject> {
  const data: PolyData = { ...o.data, vertices };
  return { data, rect: polyRect(data, widthOf(o)) };
}

function PolyRender(p: ObjectRenderProps<PolyObject>) {
  const { data, color, fillColor, strokeWidth } = p.obj;
  const paints = useMemo(() => polyPaints(data, { color, fillColor, strokeWidth }), [data, color, fillColor, strokeWidth]);
  const polygon = data.type === 'polygon';
  return (
    <PaintObject p={p} paints={paints}>
      <VertexHandles
        docId={p.docId}
        obj={p.obj}
        page={p.page}
        viewport={p.viewport}
        selected={p.selected}
        points={data.vertices}
        closed={polygon}
        minPoints={polygon ? 3 : 2}
        apply={(pts) => polyPatch(p.obj, pts)}
        label={`Edit ${polyName(data).toLowerCase()}`}
      />
    </PaintObject>
  );
}

function PolyProps({ obj, update }: { obj: PolyObject; update(patch: Partial<PolyObject>): void }) {
  const d = obj.data;
  const w = widthOf(obj);
  const setData = (patch: Partial<PolyData>) => {
    const data = { ...d, ...patch };
    update({ data, rect: polyRect(data, w) });
  };
  const polygon = d.type === 'polygon';
  const ends = d.endings ?? ['None', 'None'];
  return (
    <div className="drawing-props" data-testid="drawing-props-poly">
      <ColorControl testid="drawing-prop-color" value={obj.color ?? null} onChange={(c) => c && update({ color: c })} />
      {polygon && <ColorControl testid="drawing-prop-fill" label="Fill color" allowNone value={obj.fillColor ?? null} onChange={(c) => update({ fillColor: c })} />}
      <WidthControl testid="drawing-prop-width" value={w} onChange={(v) => update({ strokeWidth: v, rect: polyRect(d, v) })} />
      <StyleControl
        testid="drawing-prop-style"
        value={d.style}
        options={polygon ? ['solid', 'dashed', 'cloudy'] : ['solid', 'dashed']}
        onChange={(s: StrokeStyle) => setData({ style: s })}
      />
      {polygon && d.style === 'cloudy' && <IntensityControl testid="drawing-prop-intensity" value={d.intensity} onChange={(v) => setData({ intensity: v })} />}
      {!polygon && <EndingControl testid="drawing-prop-start" side={0} value={ends[0]} onChange={(e) => setData({ endings: [e, ends[1]] })} />}
      {!polygon && <EndingControl testid="drawing-prop-end" side={1} value={ends[1]} onChange={(e) => setData({ endings: [ends[0], e] })} />}
      <OpacityControl testid="drawing-prop-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v })} />
    </div>
  );
}

function polyMenu(o: PolyObject, docId: string): MenuItem[] {
  const d = o.data;
  const toPolygon = d.type === 'polyline';
  return [
    {
      id: 'drawing-poly-convert',
      label: toPolygon ? 'Close shape (polygon)' : 'Open shape (polyline)',
      icon: toPolygon ? Pentagon : Spline,
      disabled: !!o.locked || (toPolygon && d.vertices.length < 3),
      run: () => {
        const data: PolyData = toPolygon
          ? { ...d, type: 'polygon', endings: undefined }
          : { ...d, type: 'polyline', style: d.style === 'cloudy' ? 'solid' : d.style, endings: ['None', 'None'] };
        actions.updateObject(docId, o.id, { data, rect: polyRect(data, widthOf(o)), fillColor: toPolygon ? o.fillColor : null }, { label: 'Convert shape' });
      },
    },
  ];
}

export const polyType: ObjectTypeDef<PolyObject> = {
  kind: 'poly',
  label: 'Polygon',
  icon: Pentagon,
  category: 'comment',
  Render: PolyRender,
  hit: 'shape',
  minSize: { width: 4, height: 4 },
  translate: (o, dx, dy) => ({ rect: translateRect(o.rect, dx, dy), data: { ...o.data, vertices: translatePts(o.data.vertices, dx, dy) } }),
  resize: (o, rect) => {
    const b = pointsBox(o.data.vertices);
    const pad = Math.max(0, Math.min((o.rect.width - b.width) / 2, (o.rect.height - b.height) / 2));
    return { data: { ...o.data, vertices: mapPoints(o.data.vertices, o.rect, rect, pad) } };
  },
  PropertiesBar: PolyProps,
  summary: (o) => `${polyName(o.data)} · ${plural(o.data.vertices.length, 'vertex', 'vertices')}`,
  contextMenu: polyMenu,
  async exportToPdf(o, ctx) {
    const d = o.data;
    if (d.vertices.length < 2) return;
    const w = widthOf(o);
    const polygon = d.type === 'polygon';
    const cloudy = polygon && d.style === 'cloudy';
    const extra: Record<string, unknown> = {
      Vertices: flatPts(d.vertices),
      BS: borderStyle(w, cloudy ? 'solid' : d.style, dashFor(w)),
    };
    if (cloudy) extra.BE = cloudyEffect(d.intensity);
    if (!polygon && d.endings && d.endings.some((e) => e !== 'None')) extra.LE = [d.endings[0], d.endings[1]];
    await exportPaints(o, ctx, polyPaints(d, o), {
      subtype: polygon ? 'Polygon' : 'PolyLine',
      subject: polygon ? (cloudy ? 'Cloud' : 'Polygon') : 'Polygonal Line',
      rect: polyRect(d, w),
      extra,
    });
  },
};
