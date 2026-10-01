/**
 * Lazily rendered page thumbnail. Shows an aspect-ratio placeholder (page rotation included)
 * until it scrolls near the viewport, then asks engine.getThumbnail (which shares in-flight requests
 * and caches per version/page/width). The previous image stays up while a newer one is produced.
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { DocId } from '../types';
import { useDoc } from '../store';
import * as engine from '../engine';
import { renderQueue, isCancellation } from './renderQueue';
import { totalRotation } from './viewport';

export interface PageThumbnailProps {
  docId: DocId;
  pageIndex: number;
  /** CSS width in px (height follows the page's aspect ratio). */
  width: number;
  className?: string;
  onClick?: () => void;
}

const MAX_CACHE = 600;
const cache = new Map<string, string>();
function cacheGet(key: string) {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}
function cachePut(key: string, url: string) {
  cache.set(key, url);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

function useInView<T extends Element>(ref: RefObject<T | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setInView(e.isIntersecting);
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

export function PageThumbnail({ docId, pageIndex, width, className, onClick }: PageThumbnailProps) {
  const page = useDoc(docId, (d) => d?.pages[pageIndex]);
  const pdfVersion = useDoc(docId, (d) => d?.pdfVersion ?? -1);
  const fresh = useDoc(docId, (d) => !!(d && d.pdf && d.pdfVersion === d.version));
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [img, setImg] = useState<{ src: string; pageId: string } | null>(null);
  const [failed, setFailed] = useState(false);

  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const pixelWidth = Math.max(16, Math.round(width * dpr));
  const pageId = page?.id;
  const rotation = page?.rotation ?? 0;

  useEffect(() => {
    if (!inView || !page || !fresh) return;
    const key = `${docId}:${page.id}:${pdfVersion}:${rotation}:${pixelWidth}`;
    const hit = cacheGet(key);
    if (hit) {
      setImg({ src: hit, pageId: page.id });
      setFailed(false);
      return;
    }
    const jobKey = `thumb:${key}`;
    let done = false;
    renderQueue.schedule(
      jobKey,
      () => 2e6 + pageIndex,
      async (ctx) => {
        let url: string | null = null;
        try {
          url = await engine.getThumbnail(docId, pageIndex, pixelWidth);
        } catch (e) {
          if (isCancellation(e) || ctx.cancelled) return;
          console.warn('[viewer] thumbnail failed', e);
        }
        if (ctx.cancelled) return;
        done = true;
        if (url) {
          cachePut(key, url);
          setImg({ src: url, pageId: page.id });
          setFailed(false);
        } else {
          setFailed(true);
        }
      },
    );
    return () => {
      if (!done) renderQueue.cancel(jobKey);
    };
    // `page` object identity changes for unrelated edits; key on what affects the image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, docId, pageId, pageIndex, pdfVersion, rotation, pixelWidth, fresh]);

  const r = page ? totalRotation(page, 0) : 0;
  const w = page ? (r % 180 === 0 ? page.width : page.height) : 612;
  const h = page ? (r % 180 === 0 ? page.height : page.width) : 792;
  const style: CSSProperties = { width, aspectRatio: `${w} / ${h}` };
  const src = img && img.pageId === pageId ? img.src : null;

  return (
    <div
      ref={ref}
      className={`pdfwizard-thumb${src ? ' is-loaded' : ''}${failed ? ' is-failed' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      onClick={onClick}
      data-page-index={pageIndex}
    >
      {src && <img src={src} alt={`Page ${page?.label ?? pageIndex + 1}`} draggable={false} />}
    </div>
  );
}
