/**
 * Measurements (distance / perimeter / area). Exported as /Line, /PolyLine or /Polygon with
 * /IT …Dimension and a /Measure (RL) dictionary; /Contents carries the formatted value.
 */
import { useMemo } from 'react';
import { ChevronDown, ClipboardCopy, Ruler } from 'lucide-react';
import type { DocId, MenuItem, ObjectRenderProps, ObjectTypeDef, Point } from '@/core/types';
import { translateRect } from '@/core/geometry';
import { actions } from '@/core/store';
import { Dropdown, promptDialog } from '@/core/ui';
import type { MeasureData, MeasureObject, MeasureScale, MeasureType } from '../model';
import { measurePaints, measureRect, widthOf } from '../looks';
import { translatePts } from '../geom';
import { flatPts, pdfText } from '../common';
import { PaintObject } from '../render';
import { VertexHandles } from '../VertexHandles';
import { borderStyle, exportPaints } from '../exporting';
import { ColorControl, OpacityControl, WidthControl } from '../controls';
import { formatMeasure, measureValue, parseRatio, ratioString, realPerPt, unitLabel } from '../measure/scale';

export const MEASURE_NAMES: Record<MeasureType, string> = { distance: 'Distance', perimeter: 'Perimeter', area: 'Area' };

export const measureText = (d: MeasureData) => formatMeasure(d.value, d.type, d.scale.realUnit, d.precision);

/** Patch for new points and/or scale: recomputes value and rect. */
export function measurePatch(o: MeasureObject, patch: Partial<Pick<MeasureData, 'points' | 'scale' | 'precision'>>): Partial<MeasureObject> {
  const next: MeasureData = { ...o.data, ...patch };
  next.value = measureValue(next.type, next.points, next.scale);
  return { data: next, rect: measureRect(next, widthOf(o)) };
}

function MeasureRender(p: ObjectRenderProps<MeasureObject>) {
  const { data, color, strokeWidth } = p.obj;
  const rotation = p.rotation;
  const paints = useMemo(() => measurePaints(data, { color, strokeWidth }, rotation), [data, color, strokeWidth, rotation]);
  const closed = data.type === 'area';
  return (
    <PaintObject p={p} paints={paints}>
      <VertexHandles
        docId={p.docId}
        obj={p.obj}
        page={p.page}
        viewport={p.viewport}
        selected={p.selected}
        points={data.points}
        closed={closed}
        minPoints={data.type === 'area' ? 3 : 2}
        apply={(pts) => measurePatch(p.obj, { points: data.type === 'distance' ? pts.slice(0, 2) : pts })}
        label="Edit measurement"
      />
    </PaintObject>
  );
}

export async function editScale(scale: MeasureScale): Promise<MeasureScale | null> {
  const v = await promptDialog({
    title: 'Scale ratio',
    label: 'Page distance = real-world distance',
    defaultValue: ratioString(scale),
    placeholder: '1 in = 10 ft',
    confirmLabel: 'Apply',
    help: 'Page units: pt, in, mm, cm. Real-world units: in, ft, mm, cm, m.',
    validate: (s) => (parseRatio(s) ? null : 'Use the form “1 in = 10 ft”.'),
  });
  return v ? parseRatio(v) : null;
}

const PRECISIONS = [0, 1, 2, 3, 4];

function MeasureProps({ obj, update }: { obj: MeasureObject; update(patch: Partial<MeasureObject>): void }) {
  const d = obj.data;
  const w = widthOf(obj);
  return (
    <div className="drawing-props" data-testid="drawing-props-measure">
      <span className="drawing-props-value" data-testid="drawing-prop-value" title={MEASURE_NAMES[d.type]}>
        {measureText(d)}
      </span>
      <ColorControl testid="drawing-prop-color" value={obj.color ?? null} onChange={(c) => c && update({ color: c })} />
      <WidthControl testid="drawing-prop-width" value={w} widths={[0.5, 1, 2, 3, 4]} onChange={(v) => update({ strokeWidth: v, rect: measureRect(d, v) })} />
      <button
        type="button"
        className="drawing-chip is-wide"
        data-testid="drawing-prop-scale"
        title="Scale ratio"
        aria-label="Scale ratio"
        onClick={async () => {
          const s = await editScale(d.scale);
          if (s) update(measurePatch(obj, { scale: s }));
        }}
      >
        <Ruler size={14} strokeWidth={1.75} />
        <span>{ratioString(d.scale)}</span>
      </button>
      <Dropdown
        label="Precision"
        items={PRECISIONS.map((p) => ({ id: `drawing-precision-${p}`, label: (1).toFixed(p), checked: p === d.precision, run: () => update({ data: { ...d, precision: p } }) }))}
        trigger={
          <button type="button" className="drawing-chip" data-testid="drawing-prop-precision" title="Precision" aria-label="Precision">
            <span>{(0).toFixed(d.precision)}</span>
            <ChevronDown size={12} strokeWidth={2} className="drawing-chip-caret" />
          </button>
        }
      />
      <OpacityControl testid="drawing-prop-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v })} />
    </div>
  );
}

function measureMenu(o: MeasureObject, docId: DocId): MenuItem[] {
  return [
    {
      id: 'drawing-measure-scale',
      label: 'Edit scale ratio…',
      icon: Ruler,
      disabled: !!o.locked,
      run: async () => {
        const s = await editScale(o.data.scale);
        if (s) actions.updateObject(docId, o.id, measurePatch(o, { scale: s }), { label: 'Change scale' });
      },
    },
    {
      id: 'drawing-measure-copy',
      label: 'Copy value',
      icon: ClipboardCopy,
      run: async () => {
        try {
          await navigator.clipboard.writeText(measureText(o.data));
          actions.toast('Measurement copied', { kind: 'success' });
        } catch {
          actions.toast('Couldn’t access the clipboard', { kind: 'error' });
        }
      },
    },
  ];
}

const IT: Record<MeasureType, string> = { distance: 'LineDimension', perimeter: 'PolyLineDimension', area: 'PolygonDimension' };
const SUBTYPE: Record<MeasureType, string> = { distance: 'Line', perimeter: 'PolyLine', area: 'Polygon' };

/** The /Measure RL dictionary for a scale and precision. */
export function measureDict(scale: MeasureScale, precision: number): Record<string, unknown> {
  const D = Math.pow(10, Math.max(0, Math.min(6, Math.round(precision))));
  const fmt = (u: string, C: number) => ({ Type: 'NumberFormat', U: pdfText(u), C: Number(C.toPrecision(8)), D, F: 'D', FD: false });
  return {
    Type: 'Measure',
    Subtype: 'RL',
    R: pdfText(ratioString(scale)),
    X: [fmt(scale.realUnit, realPerPt(scale))],
    D: [fmt(scale.realUnit, 1)],
    A: [fmt(unitLabel('area', scale.realUnit), 1)],
  };
}

export const measureType: ObjectTypeDef<MeasureObject> = {
  kind: 'measure',
  label: 'Measurement',
  icon: Ruler,
  category: 'comment',
  Render: MeasureRender,
  hit: 'shape',
  resizable: false,
  translate: (o, dx, dy) => ({ rect: translateRect(o.rect, dx, dy), data: { ...o.data, points: translatePts(o.data.points, dx, dy) } }),
  PropertiesBar: MeasureProps,
  summary: (o) => `${MEASURE_NAMES[o.data.type]}: ${measureText(o.data)}`,
  contextMenu: measureMenu,
  async exportToPdf(o, ctx) {
    const d = o.data;
    const min = d.type === 'area' ? 3 : 2;
    if (d.points.length < min) return;
    const w = widthOf(o);
    const rotation = ctx.pageInfo(o.pageId).rotation;
    const value = measureText(d);
    const extra: Record<string, unknown> = {
      IT: IT[d.type],
      Measure: measureDict(d.scale, d.precision),
      BS: borderStyle(w, 'solid'),
      Contents: pdfText(o.contents ? `${value}\n${o.contents}` : value),
    };
    const pts: Point[] = d.type === 'distance' ? d.points.slice(0, 2) : d.points;
    if (d.type === 'distance') {
      extra.L = flatPts(pts);
      extra.LE = ['ClosedArrow', 'ClosedArrow'];
      extra.Cap = true;
    } else {
      extra.Vertices = flatPts(pts);
    }
    await exportPaints(o, ctx, measurePaints({ ...d, points: pts }, o, rotation), {
      subtype: SUBTYPE[d.type],
      subject: MEASURE_NAMES[d.type],
      rect: measureRect(d, w),
      noContents: true,
      extra,
    });
  },
};
