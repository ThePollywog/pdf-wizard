/** Rendering pages to canvases and thumbnails with the document's current pdf.js proxy. */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId } from '../types';
import { getDoc } from '../store';
import { awaitPdf } from './sync';
import { onForgetDoc, requireDoc } from './state';
import { pdfjsLib } from './pdfjs';

/** Browsers refuse (or silently blank) canvases above ~16k px per side / ~268M px area; stay well below. */
const MAX_SIDE = 16384;
const MAX_AREA = 64e6;

export interface RenderOptions {
  /** CSS/device pixels per PDF point (default 1). Ignored when `width` is given. */
  scale?: number;
  /** Target canvas width in pixels (rotation included). */
  width?: number;
  /** Render as for printing (print intent: annotations flagged no-print are hidden). */
  forPrint?: boolean;
  /**
   * Draw form fields (with their current values) into the canvas. Default true; pass false when an
   * HTML form layer is drawn on top.
   */
  includeForms?: boolean;
}

function checkPage(pdf: PDFDocumentProxy, pageIndex: number) {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) throw new Error(`Page ${pageIndex + 1} doesn't exist.`);
}

async function renderWith(pdf: PDFDocumentProxy, pageIndex: number, opts: RenderOptions): Promise<HTMLCanvasElement> {
  checkPage(pdf, pageIndex);
  const page = await pdf.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  let scale = opts.width && opts.width > 0 ? opts.width / base.width : opts.scale && opts.scale > 0 ? opts.scale : 1;
  const w = base.width * scale;
  const h = base.height * scale;
  const shrink = Math.min(1, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)));
  scale *= shrink;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const forms = opts.forPrint || opts.includeForms !== false;
  const task = page.render({
    canvas,
    viewport,
    intent: opts.forPrint ? 'print' : 'display',
    annotationMode: forms ? pdfjsLib.AnnotationMode.ENABLE_STORAGE : pdfjsLib.AnnotationMode.ENABLE_FORMS,
    background: '#ffffff',
  });
  await task.promise;
  return canvas;
}

/** Render a page of the document's current bytes (overlay objects are not included). */
export async function renderPageToCanvas(docId: DocId, pageIndex: number, opts: RenderOptions = {}): Promise<HTMLCanvasElement> {
  const pdf = await awaitPdf(docId);
  return renderWith(pdf, pageIndex, opts);
}

// ── thumbnails ───────────────────────────────────────────────────────────────

const THUMB_CACHE = 300;
const THUMB_CONCURRENCY = 2;
/** key → image URL (most recently used last). */
const thumbs = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
let running = 0;
const waiting: (() => void)[] = [];

const thumbKey = (docId: DocId, version: number, pageId: string, width: number) => `${docId}:${version}:${pageId}:${width}`;

function touch(key: string): string | undefined {
  const v = thumbs.get(key);
  if (v !== undefined) {
    thumbs.delete(key);
    thumbs.set(key, v);
  }
  return v;
}

function put(key: string, url: string) {
  thumbs.delete(key);
  thumbs.set(key, url);
  while (thumbs.size > THUMB_CACHE) thumbs.delete(thumbs.keys().next().value as string);
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= THUMB_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function canvasToDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Couldn't create the page thumbnail."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("Couldn't create the page thumbnail."));
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

/**
 * PNG thumbnail of a page, `width` pixels wide (callers pass device pixels). Cached per
 * (version, page id, width), concurrent requests are shared and at most two render at a time.
 * Returns a `data:` URL: usable wherever an object URL is and never needs revoking, so callers may
 * keep it as long as they like.
 */
export function getThumbnail(docId: DocId, pageIndex: number, width: number): Promise<string> {
  let doc;
  try {
    doc = requireDoc(docId);
  } catch (e) {
    return Promise.reject(e);
  }
  const page = doc.pages[pageIndex];
  if (!page) return Promise.reject(new Error(`Page ${pageIndex + 1} doesn't exist.`));
  const px = Math.max(8, Math.min(4096, Math.round(Number(width) || 0)));
  const key = thumbKey(docId, doc.version, page.id, px);
  const hit = touch(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const pageId = page.id;
  const job = slot(async () => {
    // The bytes may move on while waiting: render the same page in whatever version is current.
    let pdf: PDFDocumentProxy | null = null;
    let cur = getDoc(docId);
    for (let attempt = 0; attempt < 5 && !pdf; attempt++) {
      const p = await awaitPdf(docId);
      cur = getDoc(docId);
      if (cur?.pdf === p && cur.pdfVersion === cur.version) pdf = p;
    }
    if (!cur) throw new Error('The document is no longer open.');
    if (!pdf) throw new Error('The document is still loading.');
    const version = cur.version;
    const index = cur.pages.findIndex((p) => p.id === pageId);
    if (index < 0) throw new Error('The page no longer exists.');
    const renderedKey = thumbKey(docId, version, pageId, px);
    const cached = touch(renderedKey);
    if (cached) return cached;
    const canvas = await renderWith(pdf, index, { width: px });
    try {
      const url = await canvasToDataUrl(canvas);
      put(renderedKey, url);
      return url;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  });
  inflight.set(key, job);
  const clear = () => {
    if (inflight.get(key) === job) inflight.delete(key);
  };
  job.then(clear, clear);
  return job;
}

onForgetDoc((id) => {
  const prefix = `${id}:`;
  for (const k of [...thumbs.keys()]) if (k.startsWith(prefix)) thumbs.delete(k);
});
