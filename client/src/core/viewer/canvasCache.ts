/**
 * LRU of detached page canvases. When a page scrolls out of the virtualized range its canvas is
 * parked here; scrolling back shows it immediately (CSS-scaled if the zoom changed) while a fresh
 * render is queued. Evicted canvases are shrunk to 0×0 so the browser frees their backing store.
 */
import type { Rotation } from '../types';

export interface CanvasMeta {
  /** pdf version the canvas was rendered from. */
  token: number;
  zoom: number;
  rotation: Rotation;
  /** Device px per CSS px used for the backing store. */
  outputScale: number;
  /** Identity of the render (token|zoom|rotation|scale). */
  key: string;
}

export interface CachedCanvas {
  canvas: HTMLCanvasElement;
  meta: CanvasMeta;
}

const MAX_ENTRIES = 10;
const MAX_PIXELS = 80_000_000;
const cache = new Map<string, CachedCanvas>();

const pixels = (c: HTMLCanvasElement) => c.width * c.height;

export function releaseCanvas(c: HTMLCanvasElement | null | undefined) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

export function stashCanvas(docId: string, pageId: string, entry: CachedCanvas) {
  const k = `${docId}:${pageId}`;
  const prev = cache.get(k);
  if (prev && prev.canvas !== entry.canvas) releaseCanvas(prev.canvas);
  cache.delete(k);
  cache.set(k, entry);
  let total = 0;
  for (const e of cache.values()) total += pixels(e.canvas);
  while (cache.size > MAX_ENTRIES || (total > MAX_PIXELS && cache.size > 1)) {
    const [oldKey, old] = cache.entries().next().value as [string, CachedCanvas];
    cache.delete(oldKey);
    total -= pixels(old.canvas);
    releaseCanvas(old.canvas);
  }
}

/** Remove and return the cached canvas for a page (the caller owns it afterwards). */
export function takeCanvas(docId: string, pageId: string): CachedCanvas | null {
  const k = `${docId}:${pageId}`;
  const e = cache.get(k);
  if (!e) return null;
  cache.delete(k);
  return e;
}

/** Drop every cached canvas of a document (e.g. when it is closed). */
export function purgeDocCanvases(docId: string) {
  for (const [k, e] of [...cache.entries()]) {
    if (k.startsWith(`${docId}:`)) {
      cache.delete(k);
      releaseCanvas(e.canvas);
    }
  }
}
