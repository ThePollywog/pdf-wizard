/** Rectangle / oval / cloud shapes. Exported as /Square or /Circle (cloudy: /BE /S /C + /RD). */
import { useMemo } from 'react';
import { Square } from 'lucide-react';
import type { ObjectRenderProps, ObjectTypeDef } from '@/core/types';
import type { ShapeData, ShapeObject, StrokeStyle } from '../model';
import { dashFor, isCloudy, shapePaints, widthOf } from '../looks';
import { cloudBulge } from '../geom';
import { PaintObject } from '../render';
import { borderStyle, cloudyEffect, exportPaints } from '../exporting';
import { ColorControl, IntensityControl, OpacityControl, StyleControl, WidthControl } from '../controls';
import { round } from '../common';

export function shapeName(d: ShapeData): string {
  if (d.type === 'ellipse') return isCloudy(d) ? 'Cloudy oval' : 'Oval';
  return isCloudy(d) ? 'Cloud' : 'Rectangle';
}

/** Keep `type` consistent with the style (rect ↔ cloud-rect). */
export function withStyle(d: ShapeData, style: StrokeStyle): ShapeData {
  const type = d.type === 'ellipse' ? 'ellipse' : style === 'cloudy' ? 'cloud-rect' : 'rect';
  return { ...d, style, type };
}

function ShapeRender(p: ObjectRenderProps<ShapeObject>) {
  const { data, rect, color, fillColor, strokeWidth } = p.obj;
  const paints = useMemo(() => shapePaints(data, rect, { color, fillColor, strokeWidth }), [data, rect, color, fillColor, strokeWidth]);
  return <PaintObject p={p} paints={paints} />;
}

function ShapeProps({ obj, update }: { obj: ShapeObject; update(patch: Partial<ShapeObject>): void }) {
  const d = obj.data;
  const style: StrokeStyle = isCloudy(d) ? 'cloudy' : d.style;
  return (
    <div className="drawing-props" data-testid="drawing-props-shape">
      <ColorControl testid="drawing-prop-color" label="Border color" value={obj.color ?? null} onChange={(c) => c && update({ color: c })} />
      <ColorControl testid="drawing-prop-fill" label="Fill color" allowNone value={obj.fillColor ?? null} onChange={(c) => update({ fillColor: c })} />
      <WidthControl testid="drawing-prop-width" allowZero value={widthOf(obj)} onChange={(v) => update({ strokeWidth: v })} />
      <StyleControl testid="drawing-prop-style" value={style} options={['solid', 'dashed', 'cloudy']} onChange={(s) => update({ data: withStyle(d, s) })} />
      {style === 'cloudy' && <IntensityControl testid="drawing-prop-intensity" value={d.intensity} onChange={(v) => update({ data: { ...d, intensity: v } })} />}
      <OpacityControl testid="drawing-prop-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v })} />
    </div>
  );
}

export const shapeType: ObjectTypeDef<ShapeObject> = {
  kind: 'shape',
  label: 'Shape',
  icon: Square,
  category: 'comment',
  Render: ShapeRender,
  hit: 'shape',
  minSize: { width: 4, height: 4 },
  PropertiesBar: ShapeProps,
  summary: (o) => shapeName(o.data),
  async exportToPdf(o, ctx) {
    const d = o.data;
    const w = widthOf(o);
    const cloudy = isCloudy(d);
    const extra: Record<string, unknown> = { BS: borderStyle(w, cloudy ? 'solid' : d.style, dashFor(w)) };
    if (cloudy) {
      const k = round(cloudBulge(d.intensity) + w / 2);
      extra.BE = cloudyEffect(d.intensity);
      extra.RD = [k, k, k, k];
    }
    await exportPaints(o, ctx, shapePaints(d, o.rect, o), {
      subtype: d.type === 'ellipse' ? 'Circle' : 'Square',
      subject: shapeName(d),
      bbox: o.rect,
      extra,
    });
  },
};
