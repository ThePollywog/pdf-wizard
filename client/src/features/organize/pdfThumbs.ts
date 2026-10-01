/**
 * Standalone source PDFs (files being combined, replacement files) with their own pdf.js proxy,
 * page geometry and a small thumbnail cache (two renders at a time).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { uid } from '@/core/util';
import { destroyProxy } from '@/core/engine/pdfjs';
import type { LoadedPdf } from './sources';

export interface SourcePage {
  /** Displayed size (rotation applied), points. */
  width: number;
  height: number;
  rotation: number;
}

export interface SourceDoc {
  id: string;
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  pages: SourcePage[];
}

const sources = new Map<string, SourceDoc>();

async function readGeometry(pdf: PDFDocumentProxy): Promise<SourcePage[]> {
  const out: SourcePage[] = [];
  const CHUNK = 40;
  for (let s = 0; s < pdf.numPages; s += CHUNK) {
    const idx = Array.from({ length: Math.min(CHUNK, pdf.numPages - s) }, (_, k) => s + k);
    const pages = await Promise.all(idx.map((i) => pdf.getPage(i + 1)));
    for (const p of pages) {
      const vp = p.getViewport({ scale: 1 });
      out.push({ width: vp.width, height: vp.height, rotation: p.rotate });
    }
  }
  return out;
}

export async function registerSource(loaded: LoadedPdf): Promise<SourceDoc> {
  const pages = await readGeometry(loaded.pdf);
  const src: SourceDoc = { id: uid('src'), name: loaded.name, bytes: loaded.bytes, pdf: loaded.pdf, pages };
  sources.set(src.id, src);
  return src;
}

export function getSource(id: string): SourceDoc | undefined {
  return sources.get(id);
}

export function closeSource(id: string) {
  const s = sources.get(id);
  if (!s) return;
  sources.delete(id);
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}:`)) cache.delete(k);
  destroyProxy(s.pdf);
}

// ── thumbnails ───────────────────────────────────────────────────────────────

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const MAX_CACHE = 400;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function toDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Couldn't create the thumbnail."));
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error ?? new Error("Couldn't create the thumbnail."));
      r.readAsDataURL(blob);
    }, 'image/png');
  });
}

/** PNG data URL of a source page, `px` device pixels wide. */
export function sourceThumb(sourceId: string, index: number, px: number): Promise<string> {
  const key = `${sourceId}:${index}:${px}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = slot(async () => {
    const src = sources.get(sourceId);
    if (!src) throw new Error('The file was removed.');
    const page = await src.pdf.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, px / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    try {
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      const url = await toDataUrl(canvas);
      if (sources.has(sourceId)) {
        cache.set(key, url);
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
      }
      return url;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  });
  inflight.set(key, job);
  void job.finally(() => inflight.delete(key)).catch(() => {});
  return job;
}
