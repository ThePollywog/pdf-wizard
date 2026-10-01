/**
 * Stamps (standard, dynamic, sign-here, custom image/PDF and imported). Exported as /Stamp with
 * /Name and a vector appearance matching the screen; imported stamps keep their original /AP.
 */
import { useMemo } from 'react';
import { Maximize2, Stamp as StampIcon } from 'lucide-react';
import type { DocId, MenuItem, ObjectRenderProps, ObjectTypeDef, Rect } from '@/core/types';
import { actions } from '@/core/store';
import { preservedAppearanceSpec } from '@/core/annotations';
import type { StampData, StampObject } from '../model';
import type { Paint } from '../paint';
import { PaintObject } from '../render';
import { exportPaints } from '../exporting';
import { pdfText } from '../common';
import { OpacityControl } from '../controls';
import { displayRectAt, displaySize } from '../geom';
import { stampDesign, stampPaints } from '../stamps/draw';
import { SET_LABELS } from '../stamps/catalog';
import { titleCase } from '../stamps/custom';
import { usePreservedRaster } from '../stamps/preview';

export function stampTitle(d: StampData): string {
  if (d.set === 'custom' || d.set === 'imported') return d.label || d.name || 'Stamp';
  return titleCase(d.label);
}

/** Natural (design) rect of a stamp centered on `rect`'s center. */
export function naturalRect(d: StampData, rect: Rect): Rect {
  const c = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  if (d.preserved) {
    const [x0, y0, x1, y1] = d.preserved.bbox;
    return { x: c.x - (x1 - x0) / 2, y: c.y - (y1 - y0) / 2, width: x1 - x0, height: y1 - y0 };
  }
  const design = stampDesign(d);
  return displayRectAt(c, design.w, design.h, d.rotation);
}

function StampRender(p: ObjectRenderProps<StampObject>) {
  const { data, rect } = p.obj;
  const raster = usePreservedRaster(data.preserved);
  const paints = useMemo((): Paint[] => {
    if (data.preserved) return raster ? [{ t: 'image', src: raster.src, x: rect.x, y: rect.y, w: rect.width, h: rect.height }] : [];
    return stampPaints(data, rect);
  }, [data, rect, raster]);
  return <PaintObject p={p} paints={paints} hit={false} />;
}

function StampProps({ obj, update }: { obj: StampObject; update(patch: Partial<StampObject>): void }) {
  const d = obj.data;
  const { w, h } = displaySize(obj.rect, d.rotation);
  return (
    <div className="drawing-props" data-testid="drawing-props-stamp">
      <span className="drawing-props-value" title={SET_LABELS[d.set]}>
        {stampTitle(d)}
      </span>
      <OpacityControl testid="drawing-prop-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v })} />
      <button
        type="button"
        className="drawing-chip"
        data-testid="drawing-prop-reset-size"
        title={`Reset size (now ${Math.round(w)} × ${Math.round(h)} pt)`}
        aria-label="Reset size"
        onClick={() => update({ rect: naturalRect(d, obj.rect) })}
      >
        <Maximize2 size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function stampMenu(o: StampObject, docId: DocId): MenuItem[] {
  return [
    {
      id: 'drawing-stamp-reset-size',
      label: 'Reset size',
      icon: Maximize2,
      disabled: !!o.locked,
      run: () => actions.updateObject(docId, o.id, { rect: naturalRect(o.data, o.rect) }, { label: 'Reset stamp size' }),
    },
  ];
}

export const stampType: ObjectTypeDef<StampObject> = {
  kind: 'stamp',
  label: 'Stamp',
  icon: StampIcon,
  category: 'comment',
  Render: StampRender,
  hit: 'box',
  keepAspectRatio: true,
  minSize: { width: 12, height: 8 },
  PropertiesBar: StampProps,
  summary: (o) => `${stampTitle(o.data)}${o.data.subline ? ` · ${o.data.subline}` : ''}`,
  contextMenu: stampMenu,
  async exportToPdf(o, ctx) {
    const d = o.data;
    const extra: Record<string, unknown> = { Name: d.name || 'Draft' };
    if (d.preserved) {
      const appearance = await preservedAppearanceSpec(ctx, d.preserved, o.rect);
      extra.Subj = pdfText(stampTitle(d));
      ctx.annots.add(ctx.page(o.pageId), o, { subtype: 'Stamp', extra, appearance, rect: o.rect });
      return;
    }
    await exportPaints(o, ctx, stampPaints(d, o.rect), { subtype: 'Stamp', subject: stampTitle(d), bbox: o.rect, rect: o.rect, extra });
  },
};
