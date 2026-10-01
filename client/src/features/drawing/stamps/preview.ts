/**
 * Screen preview of an imported stamp's preserved appearance: the one-page PDF holding the /Ap form
 * is given a content stream that draws it, rendered by pdf.js to a transparent PNG and cached.
 */
import { useEffect, useState } from 'react';
import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from '@cantoo/pdf-lib';
import type { PreservedAppearance } from '@/core/annotations';
import { loadPdfjs } from '@/core/engine';

export interface Raster {
  src: string;
  w: number;
  h: number;
}

const cache = new WeakMap<Uint8Array, Promise<Raster | null>>();
const MAX_PX = 900;

async function rasterize(pa: PreservedAppearance): Promise<Raster | null> {
  const [x0, y0, x1, y1] = pa.bbox;
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const doc = await PDFDocument.load(pa.pdf, { updateMetadata: false });
  const page = doc.getPage(0);
  page.setMediaBox(0, 0, w, h);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, -x0, -y0), drawObject('Ap'), popGraphicsState());
  const bytes = await doc.save({ useObjectStreams: false });
  const pdf = await loadPdfjs(bytes);
  try {
    const p = await pdf.getPage(1);
    const scale = Math.max(0.5, Math.min(4, MAX_PX / Math.max(w, h)));
    const vp = p.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vp.width));
    c.height = Math.max(1, Math.round(vp.height));
    // pdf.js creates an opaque (alpha: false) context unless it is given one: keep the background transparent.
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available.');
    await p.render({ canvas: c, canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    return { src: c.toDataURL('image/png'), w: c.width, h: c.height };
  } finally {
    void pdf.loadingTask.destroy();
  }
}

export function preservedRaster(pa: PreservedAppearance): Promise<Raster | null> {
  let p = cache.get(pa.pdf);
  if (!p) {
    p = rasterize(pa).catch(() => null);
    cache.set(pa.pdf, p);
  }
  return p;
}

/** Raster of a preserved appearance (null while loading or when it can't be rendered). */
export function usePreservedRaster(pa: PreservedAppearance | undefined): Raster | null {
  const [state, setState] = useState<{ key: Uint8Array; r: Raster | null } | null>(null);
  useEffect(() => {
    if (!pa) return;
    let alive = true;
    void preservedRaster(pa).then((r) => {
      if (alive) setState({ key: pa.pdf, r });
    });
    return () => {
      alive = false;
    };
  }, [pa]);
  return pa && state && state.key === pa.pdf ? state.r : null;
}
