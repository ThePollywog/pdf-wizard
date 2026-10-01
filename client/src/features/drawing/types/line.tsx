/** Lines and arrows. Exported as /Line with /L, /LE, /IC and a dashed /BS when needed. */
import { useMemo } from 'react';
import { ArrowLeftRight, Slash } from 'lucide-react';
import type { MenuItem, ObjectRenderProps, ObjectTypeDef, Point } from '@/core/types';
import { translateRect } from '@/core/geometry';
import { actions } from '@/core/store';
import type { LineData, LineObject } from '../model';
import { dashFor, linePaints, lineRect, widthOf } from '../looks';
import { dist, translatePts } from '../geom';
import { flatPts, round } from '../common';
import { PaintObject } from '../render';
import { VertexHandles } from '../VertexHandles';
import { borderStyle, exportPaints } from '../exporting';
import { ColorControl, EndingControl, OpacityControl, StyleControl, WidthControl } from '../controls';

export const isArrow = (d: Pick<LineData, 'endings'>) => d.endings.some((e) => /Arrow/.test(e));

export function linePatch(o: LineObject, pts: Point[]): Partial<LineObject> {
  const data: LineData = { ...o.data, start: pts[0], end: pts[1] };
  return { data, rect: lineRect(data, widthOf(o)) };
}

function LineRender(p: ObjectRenderProps<LineObject>) {
  const { data, color, fillColor, strokeWidth } = p.obj;
  const paints = useMemo(() => linePaints(data, { color, fillColor, strokeWidth }), [data, color, fillColor, strokeWidth]);
  const points = useMemo(() => [data.start, data.end], [data]);
  return (
    <PaintObject p={p} paints={paints}>
      <VertexHandles
        docId={p.docId}
        obj={p.obj}
        page={p.page}
        viewport={p.viewport}
        selected={p.selected}
        points={points}
        apply={(pts) => linePatch(p.obj, pts)}
        label="Edit line"
      />
    </PaintObject>
  );
}

function LineProps({ obj, update }: { obj: LineObject; update(patch: Partial<LineObject>): void }) {
  const d = obj.data;
  const w = widthOf(obj);
  const closedEnd = d.endings.some((e) => ['ClosedArrow', 'RClosedArrow', 'Circle', 'Square', 'Diamond'].includes(e));
  const setData = (patch: Partial<LineData>) => {
    const data = { ...d, ...patch };
    update({ data, rect: lineRect(data, w) });
  };
  return (
    <div className="drawing-props" data-testid="drawing-props-line">
      <ColorControl testid="drawing-prop-color" value={obj.color ?? null} onChange={(c) => c && update({ color: c })} />
      {closedEnd && <ColorControl testid="drawing-prop-fill" label="Fill color" allowNone value={obj.fillColor ?? null} onChange={(c) => update({ fillColor: c })} />}
      <WidthControl testid="drawing-prop-width" value={w} onChange={(v) => update({ strokeWidth: v, rect: lineRect(d, v) })} />
      <StyleControl testid="drawing-prop-style" value={d.style} options={['solid', 'dashed']} onChange={(s) => setData({ style: s === 'dashed' ? 'dashed' : 'solid' })} />
      <EndingControl testid="drawing-prop-start" side={0} value={d.endings[0]} onChange={(e) => setData({ endings: [e, d.endings[1]] })} />
      <EndingControl testid="drawing-prop-end" side={1} value={d.endings[1]} onChange={(e) => setData({ endings: [d.endings[0], e] })} />
      <OpacityControl testid="drawing-prop-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v })} />
    </div>
  );
}

function lineMenu(o: LineObject, docId: string): MenuItem[] {
  return [
    {
      id: 'drawing-line-reverse',
      label: 'Reverse direction',
      icon: ArrowLeftRight,
      disabled: !!o.locked,
      run: () => {
        const d = o.data;
        actions.updateObject(docId, o.id, { data: { ...d, start: d.end, end: d.start, endings: [d.endings[1], d.endings[0]] } }, { label: 'Reverse line' });
      },
    },
  ];
}

export const lineType: ObjectTypeDef<LineObject> = {
  kind: 'line',
  label: 'Line',
  icon: Slash,
  category: 'comment',
  Render: LineRender,
  hit: 'shape',
  resizable: false,
  translate: (o, dx, dy) => {
    const [start, end] = translatePts([o.data.start, o.data.end], dx, dy);
    return { rect: translateRect(o.rect, dx, dy), data: { ...o.data, start, end } };
  },
  PropertiesBar: LineProps,
  summary: (o) => `${isArrow(o.data) ? 'Arrow' : 'Line'} · ${Math.round(dist(o.data.start, o.data.end))} pt`,
  contextMenu: lineMenu,
  async exportToPdf(o, ctx) {
    const d = o.data;
    const w = widthOf(o);
    await exportPaints(o, ctx, linePaints(d, o), {
      subtype: 'Line',
      subject: isArrow(d) ? 'Arrow' : 'Line',
      rect: lineRect(d, w),
      extra: {
        L: flatPts([d.start, d.end]).map(round),
        LE: [d.endings[0], d.endings[1]],
        BS: borderStyle(w, d.style, dashFor(w)),
      },
    });
  },
};
