/** Lazily rendered thumbnail of a standalone source PDF page (combine / replace). */
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { getSource, sourceThumb } from './pdfThumbs';

export function SourceThumb({ sourceId, index, width, className }: { sourceId: string; index: number; width: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const page = getSource(sourceId)?.pages[index];
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const px = Math.max(16, Math.round(width * dpr));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setInView(e.isIntersecting);
    }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return;
    let alive = true;
    sourceThumb(sourceId, index, px).then(
      (url) => {
        if (alive) {
          setSrc(url);
          setFailed(false);
        }
      },
      (e) => {
        if (!alive) return;
        console.warn('[organize] thumbnail failed', e);
        setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [inView, sourceId, index, px]);

  const w = page?.width ?? 612;
  const h = page?.height ?? 792;
  return (
    <div
      ref={ref}
      className={clsx('pdfwizard-thumb organize-src-thumb', src && 'is-loaded', failed && 'is-failed', className)}
      style={{ width, aspectRatio: `${w} / ${h}` }}
    >
      {src && <img src={src} alt={`Page ${index + 1}`} draggable={false} />}
    </div>
  );
}

/** CSS width of a thumbnail that fits a `size`×`size*1.3` box keeping the page's aspect ratio. */
export function fitWidth(size: number, w: number, h: number): number {
  return Math.max(24, Math.round(Math.min(size, (size * 1.3 * w) / h)));
}
