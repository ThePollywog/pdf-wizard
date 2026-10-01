/** Freehand ink / highlighter ink ("Drawing"). Exported as /Ink with /InkList. */
import { useMemo } from 'react';
import { PenLine } from 'lucide-react';
import type { ObjectRenderProps, ObjectTypeDef, Point } from '@/core/types';
import { translateRect } from '@/core/geometry';
import { HIGHLIGHT_WIDTHS, type InkObject } from '../model';
import { inkPaints, inkRect, widthOf } from '../looks';
import { translatePts } from '../geom';
import { flatPts, mapPoints, plural } from '../common';
import { PaintObject } from '../render';
import { exportPaints } from '../exporting';
import { ColorControl, OpacityControl, WidthControl } from '../controls';

function InkRender(p: ObjectRenderProps<InkObject>) {
  const { data, color, strokeWidth } = p.obj;
  const paints = useMemo(() => inkPaints(data, { color, strokeWidth }), [data, color, strokeWidth]);
  return <PaintObject p={p} paints={paints} blend={!!data.highlight} />;
}

function InkProps({ obj, update }: { obj: InkObject; update(patch: Partial<InkObject>): void }) {
  const w = widthOf(obj);
  return (
    <div className="drawing-props" data-testid="drawing-props-ink">
      <ColorControl testid="drawing-prop-color" value={obj.color ?? null} onChange={(c) => c && update({ color: c })} />
      <WidthControl
        testid="drawing-prop-width"
        value={w}
        widths={obj.data.highlight ? HIGHLIGHT_WIDTHS : undefined}
        onChange={(v) => update({ strokeWidth: v, rect: inkRect(obj.data.paths, v) })}
      />
      <OpacityControl testid="drawing-prop-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v })} />
    </div>
  );
}

const pad = (o: InkObject) => widthOf(o) / 2 + 1;

export const inkType: ObjectTypeDef<InkObject> = {
  kind: 'ink',
  label: 'Drawing',
  icon: PenLine,
  category: 'comment',
  Render: InkRender,
  hit: 'shape',
  minSize: { width: 2, height: 2 },
  translate: (o, dx, dy) => ({ rect: translateRect(o.rect, dx, dy), data: { ...o.data, paths: o.data.paths.map((p) => translatePts(p, dx, dy)) } }),
  resize: (o, rect) => ({ data: { ...o.data, paths: o.data.paths.map((p) => mapPoints(p, o.rect, rect, pad(o))) } }),
  PropertiesBar: InkProps,
  summary: (o) => `${o.data.highlight ? 'Highlighter' : 'Freehand drawing'} · ${plural(o.data.paths.length, 'stroke')}`,
  async exportToPdf(o, ctx) {
    const paths = o.data.paths.filter((p) => p.length > 0);
    if (paths.length === 0) return;
    const paints = inkPaints({ ...o.data, paths }, o);
    await exportPaints(o, ctx, paints, {
      subtype: 'Ink',
      subject: o.data.highlight ? 'Highlighter' : 'Pencil',
      multiply: !!o.data.highlight,
      rect: inkRect(paths, widthOf(o)),
      extra: { InkList: paths.map((p: Point[]) => flatPts(p.length === 1 ? [p[0], p[0]] : p)) },
    });
  },
};
