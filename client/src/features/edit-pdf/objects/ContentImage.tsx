/**
 * content-image — an image added with Edit PDF → Add image. Stored as the unit-square → user
 * space matrix (so rotations / flips are exact) plus a unit-space crop; exported as page content
 * (embedPng / embedJpg + cm / Do).
 */
import { useMemo } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { actions } from '@/core/store';
import type { ObjectRenderProps, ObjectTypeDef } from '@/core/types';
import { mul, quadBounds, translate, unitQuad, type Matrix } from '../content/matrix';
import { drawImageOnPage } from '../content/ops';
import { dataUrlBytes } from '../images';
import { KIND_IMAGE, type ContentImageObject } from '../model';
import { rectToRect, viewMatrix } from '../viewmath';

/** CSS transform drawing a 100×100 px element as the image (unit square → view px, relative to `origin`). */
export function imageCssTransform(matrix: Matrix, V: Matrix, origin: { left: number; top: number }): string {
  const unit: Matrix = [0.01, 0, 0, -0.01, 0, 1];
  const m = mul(mul(mul(unit, matrix), V), translate(-origin.left, -origin.top));
  return `matrix(${m.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)).join(', ')})`;
}

/** CSS clip-path of a unit-space crop on the 100×100 px element. */
export function imageClipPath(c: [number, number, number, number]): string | undefined {
  if (c[0] <= 0 && c[1] <= 0 && c[2] >= 1 && c[3] >= 1) return undefined;
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  return `inset(${pct(1 - c[3])} ${pct(1 - c[2])} ${pct(c[1])} ${pct(c[0])})`;
}

function ContentImageRender({ obj, viewport, box }: ObjectRenderProps<ContentImageObject>) {
  const d = obj.data;
  const transform = useMemo(() => imageCssTransform(d.matrix, viewMatrix(viewport), box), [d.matrix, viewport, box]);
  return (
    <div className="edit-pdf-obj-image" data-testid="edit-pdf-image-object">
      <img src={d.src} alt="" draggable={false} style={{ transform, clipPath: imageClipPath(d.clip) }} />
    </div>
  );
}

const withMatrix = (obj: ContentImageObject, matrix: Matrix): Partial<ContentImageObject> => {
  const c = obj.data.clip;
  return { rect: quadBounds(unitQuad(matrix, c[0], c[1], c[2], c[3])), data: { ...obj.data, matrix } };
};

export const contentImageType: ObjectTypeDef<ContentImageObject> = {
  kind: KIND_IMAGE,
  label: 'Image',
  icon: ImageIcon,
  category: 'content',
  Render: ContentImageRender,
  keepAspectRatio: true,
  minSize: { width: 4, height: 4 },
  translate: (obj, dx, dy) => withMatrix(obj, mul(obj.data.matrix, translate(dx, dy))),
  resize: (obj, rect) => withMatrix(obj, mul(obj.data.matrix, rectToRect(obj.rect, rect))),
  summary: () => 'Image',
  async exportToPdf(obj, ctx) {
    const d = obj.data;
    try {
      const bytes = dataUrlBytes(d.src);
      const img = d.mime === 'image/png' ? await ctx.pdfDoc.embedPng(bytes) : await ctx.pdfDoc.embedJpg(bytes);
      drawImageOnPage(ctx.pdfDoc, ctx.page(obj.pageId), img.ref, d.matrix, d.clip);
    } catch (e) {
      console.warn('[edit-pdf] image could not be written', e);
      actions.toast(`An image couldn’t be saved: ${e instanceof Error ? e.message : String(e)}`, { kind: 'warning' });
    }
  },
};
