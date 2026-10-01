/**
 * Crop mode of an image: the area outside the crop is dimmed, eight handles resize the crop and
 * dragging inside moves it — always within the whole (uncropped) image.
 */
import type { PointerEvent as RPointerEvent } from 'react';
import type { PageViewport, ViewBox } from '@/core/types';
import { rectToView, viewToRect } from '@/core/geometry';
import { HANDLES, type HandleId } from '@/core/viewer/PageView';
import { ui, type CropState } from '../state';
import { trackPointer } from './drag';

const MIN = 6;

/** Crop box after dragging `handle` by (dx, dy), kept inside `full`. */
export function cropResize(b0: ViewBox, handle: HandleId | 'move', dx: number, dy: number, full: ViewBox): ViewBox {
  const fr = full.left + full.width;
  const fb = full.top + full.height;
  let l = b0.left;
  let t = b0.top;
  let r = b0.left + b0.width;
  let b = b0.top + b0.height;
  if (handle === 'move') {
    const mx = Math.max(full.left - l, Math.min(fr - r, dx));
    const my = Math.max(full.top - t, Math.min(fb - b, dy));
    return { left: l + mx, top: t + my, width: b0.width, height: b0.height };
  }
  if (handle.includes('w')) l = Math.max(full.left, Math.min(r - MIN, l + dx));
  if (handle.includes('e')) r = Math.min(fr, Math.max(l + MIN, r + dx));
  if (handle.includes('n')) t = Math.max(full.top, Math.min(b - MIN, t + dy));
  if (handle.includes('s')) b = Math.min(fb, Math.max(t + MIN, b + dy));
  return { left: l, top: t, width: r - l, height: b - t };
}

export function CropFrame({ crop, vp }: { crop: CropState; vp: PageViewport }) {
  const box = rectToView(vp, crop.rect);
  const full = rectToView(vp, crop.full);
  const start = (handle: HandleId | 'move') => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const b0 = rectToView(vp, crop.rect);
    const r0 = crop.rect;
    trackPointer(e, {
      threshold: 1,
      cursor: handle === 'move' ? 'move' : getComputedStyle(e.currentTarget as Element).cursor,
      onMove(_ev, dx, dy) {
        const c = ui.get().crop;
        if (!c) return;
        ui.setCrop({ ...c, rect: viewToRect(vp, cropResize(b0, handle, dx, dy, full)) });
      },
      onCancel() {
        const c = ui.get().crop;
        if (c) ui.setCrop({ ...c, rect: r0 });
      },
    });
  };
  const W = vp.width;
  const H = vp.height;
  return (
    <div className="edit-pdf-crop" data-testid="edit-pdf-crop" data-edit-pdf-keep="" onPointerDown={(e) => e.stopPropagation()}>
      <svg className="edit-pdf-crop-dim" width={W} height={H} aria-hidden="true">
        <path
          fillRule="evenodd"
          d={`M${full.left},${full.top}h${full.width}v${full.height}h${-full.width}Z M${box.left},${box.top}h${box.width}v${box.height}h${-box.width}Z`}
        />
      </svg>
      <div className="edit-pdf-crop-full" style={{ left: full.left, top: full.top, width: full.width, height: full.height }} />
      <div
        className="edit-pdf-crop-box"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        onPointerDown={start('move')}
        data-testid="edit-pdf-crop-box"
      >
        {HANDLES.map((h) => (
          <span key={h} className={`pdfwizard-handle pdfwizard-handle-${h} edit-pdf-crop-handle`} data-handle={h} data-testid={`edit-pdf-crop-handle-${h}`} onPointerDown={start(h)} />
        ))}
      </div>
    </div>
  );
}
