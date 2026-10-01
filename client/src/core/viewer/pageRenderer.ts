/**
 * Imperative per-page renderer: owns the page canvas, the pdf.js text layer and the pdf.js
 * annotation layer (links + AcroForm widgets). PageView (React) drives it with `update()`.
 *
 *  - Canvases render at devicePixelRatio (capped to ~16M pixels); on zoom the current canvas is
 *    CSS-scaled at once and a sharp re-render is debounced. Stale renders are cancelled.
 *  - When the document bytes change (new pdf proxy) the old canvas / layers stay on screen until
 *    the new ones are ready, so edits don't flicker. A canvas rendered at another rotation is
 *    shown CSS-rotated meanwhile.
 *  - Above the capped full-page canvas a "detail" canvas re-renders only the visible region at full
 *    resolution, so high zoom levels stay crisp.
 */
import { AnnotationLayer, AnnotationMode } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { DocId, PageInfo, Rotation, ViewBox } from '../types';
import { captureViewportClass, makeViewport, normRotation } from './viewport';
import { isCancellation, renderQueue } from './renderQueue';
import { releaseCanvas, stashCanvas, takeCanvas, type CanvasMeta } from './canvasCache';
import { PageTextLayer } from './textLayer';
import { createLinkService, type ViewerLinkService } from './linkService';

export const MAX_CANVAS_PIXELS = 16_777_216;
const MAX_CANVAS_DIM = 32_767;
const ZOOM_RENDER_DELAY = 160;
const TEXT_RELAYOUT_DELAY = 180;

export interface PageRenderParams {
  docId: DocId;
  page: PageInfo;
  pageIndex: number;
  zoom: number;
  rotation: Rotation;
  /** Slot size in CSS px (already snapped to device pixels). */
  width: number;
  height: number;
  /** Fresh pdf proxy (pdfVersion === version) or null while the engine reloads. */
  pdf: PDFDocumentProxy | null;
  token: number;
  dpr: number;
  priority: () => number;
  /** Visible part of the page in page-local CSS px (null when off screen). */
  visibleRect: () => ViewBox | null;
  /** [navigation] Optional content (layer) visibility by group id; null/undefined = the document's defaults. */
  optionalContent?: Record<string, boolean> | null;
}

export interface PageRenderState {
  painted: boolean;
  error: string | null;
}

export function outputScaleFor(w: number, h: number, dpr: number): number {
  let s = dpr;
  if (w * h * s * s > MAX_CANVAS_PIXELS) s = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
  s = Math.min(s, MAX_CANVAS_DIM / Math.max(w, h, 1));
  return s;
}

const linkServices = new WeakMap<PDFDocumentProxy, Map<DocId, ViewerLinkService>>();
function linkServiceFor(docId: DocId, pdf: PDFDocumentProxy) {
  let m = linkServices.get(pdf);
  if (!m) linkServices.set(pdf, (m = new Map()));
  let s = m.get(docId);
  if (!s) m.set(docId, (s = createLinkService(docId, pdf)));
  return s;
}

const fieldObjectsCache = new WeakMap<PDFDocumentProxy, Promise<Map<string, object[]> | null>>();
function fieldObjectsFor(pdf: PDFDocumentProxy) {
  let p = fieldObjectsCache.get(pdf);
  if (!p) {
    p = pdf.getFieldObjects().catch(() => null) as Promise<Map<string, object[]> | null>;
    fieldObjectsCache.set(pdf, p);
  }
  return p;
}

// [navigation] Optional content configs per pdf proxy, keyed by the visibility overrides.
type OcConfigPromise = ReturnType<PDFDocumentProxy['getOptionalContentConfig']>;
const ocConfigs = new WeakMap<PDFDocumentProxy, Map<string, OcConfigPromise>>();
function ocTag(oc: Record<string, boolean> | null | undefined): string {
  if (!oc) return '';
  return Object.keys(oc).sort().map((k) => `${k}:${oc[k] ? 1 : 0}`).join(',');
}
function ocConfigFor(pdf: PDFDocumentProxy, oc: Record<string, boolean> | null | undefined): OcConfigPromise | undefined {
  const tag = ocTag(oc);
  if (!tag || !oc) return undefined;
  let m = ocConfigs.get(pdf);
  if (!m) ocConfigs.set(pdf, (m = new Map()));
  let job = m.get(tag);
  if (!job) {
    job = pdf.getOptionalContentConfig().then((cfg) => {
      for (const [id, visible] of Object.entries(oc)) if (cfg.getGroup(id)) cfg.setVisibility(id, visible, false);
      return cfg;
    });
    m.set(tag, job);
  }
  return job;
}

const ROT_CSS: Record<number, string> = {
  0: '',
  90: 'rotate(90deg) translateY(-100%)',
  180: 'rotate(180deg) translate(-100%, -100%)',
  270: 'rotate(270deg) translateX(-100%)',
};

let rendererSeq = 0;

interface AnnotState {
  token: number;
  div: HTMLDivElement;
  layer: AnnotationLayer;
}

interface DetailState {
  canvas: HTMLCanvasElement;
  box: ViewBox;
  key: string;
}

export class PageRenderer {
  readonly base: HTMLDivElement;
  private readonly wrap: HTMLDivElement;
  private readonly qid = `page-${++rendererSeq}`;
  private readonly detailQid = `${this.qid}-detail`;
  private params: PageRenderParams | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private meta: CanvasMeta | null = null;
  private scheduledKey: string | null = null;
  private debounceKey: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private text: PageTextLayer | null = null;
  private textToken = -1;
  private textPendingToken = -1;
  private textScale = 0;
  private textRotation: Rotation = 0;
  private textTimer: ReturnType<typeof setTimeout> | null = null;
  private annot: AnnotState | null = null;
  private annotPendingToken = -1;
  private annotRotation: Rotation = 0;
  private canvasMaps = new Map<number, Map<string, HTMLCanvasElement>>();
  private detail: DetailState | null = null;
  private detailTimer: ReturnType<typeof setTimeout> | null = null;
  private detailScheduledKey: string | null = null;
  private destroyed = false;
  private lastPdfPage: PDFPageProxy | null = null;
  private state: PageRenderState = { painted: false, error: null };

  constructor(
    base: HTMLDivElement,
    private readonly docId: DocId,
    private readonly pageId: string,
    private readonly onState: (s: PageRenderState) => void,
    private readonly onFormInput: () => void,
  ) {
    this.base = base;
    this.wrap = document.createElement('div');
    this.wrap.className = 'pdfwizard-canvasWrap';
    base.append(this.wrap);
    const cached = takeCanvas(docId, pageId);
    if (cached) {
      this.canvas = cached.canvas;
      this.meta = cached.meta;
      this.wrap.append(cached.canvas);
      this.setState({ painted: true });
    }
  }

  get painted() {
    return this.state.painted;
  }

  private setState(patch: Partial<PageRenderState>) {
    const next = { ...this.state, ...patch };
    if (next.painted === this.state.painted && next.error === this.state.error) return;
    this.state = next;
    this.onState(next);
  }

  private wantKey(p: PageRenderParams) {
    return `${p.token}|${p.zoom}|${p.rotation}|${outputScaleFor(p.width, p.height, p.dpr).toFixed(4)}|${ocTag(p.optionalContent)}`; // [navigation] oc tag
  }

  update(p: PageRenderParams) {
    if (this.destroyed) return;
    const prev = this.params;
    this.params = p;
    this.styleCanvas();
    this.styleDetail();
    if (!p.pdf) return;

    const key = this.wantKey(p);
    if (this.meta?.key !== key && this.scheduledKey !== key && this.debounceKey !== key) {
      const canScale = !!this.meta && this.meta.token === p.token && this.meta.rotation === p.rotation;
      this.cancelCanvasWork();
      if (canScale) {
        this.debounceKey = key;
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.debounceKey = null;
          this.scheduleCanvas();
        }, ZOOM_RENDER_DELAY);
      } else {
        this.scheduleCanvas();
      }
    }
    if (this.meta?.key === key) this.maybeDetail();

    // Layers follow rotation immediately; scale re-layout of the text layer is debounced.
    if (this.text && this.textRotation !== p.rotation) {
      this.text.update(makeViewport(p.page, this.textScale, p.rotation));
      this.textRotation = p.rotation;
    }
    if (this.text && this.textScale !== p.zoom) {
      if (this.textTimer) clearTimeout(this.textTimer);
      this.textTimer = setTimeout(() => {
        this.textTimer = null;
        const cur = this.params;
        if (!cur || !this.text) return;
        this.text.update(makeViewport(cur.page, cur.zoom, cur.rotation));
        this.textScale = cur.zoom;
        this.textRotation = cur.rotation;
      }, TEXT_RELAYOUT_DELAY);
    }
    if (this.annot && this.annotRotation !== p.rotation) {
      this.annot.layer.update({ viewport: makeViewport(p.page, p.zoom, p.rotation).clone({ dontFlip: true }) } as never);
      this.annotRotation = p.rotation;
    }
    if (this.painted || this.canvas) this.ensureLayers();
    void prev;
  }

  /** Called while scrolling so the high-resolution detail canvas follows the viewport. */
  onScroll() {
    if (this.destroyed || !this.params?.pdf) return;
    if (this.detailTimer) clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null;
      this.maybeDetail();
    }, 90);
  }

  private cancelCanvasWork() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.debounceKey = null;
    if (this.scheduledKey) renderQueue.cancel(this.qid);
    this.scheduledKey = null;
  }

  private canvasMapFor(token: number) {
    let m = this.canvasMaps.get(token);
    if (!m) {
      m = new Map();
      this.canvasMaps.set(token, m);
      for (const t of [...this.canvasMaps.keys()]) if (t < token) this.canvasMaps.delete(t);
    }
    return m;
  }

  private async getPage(p: PageRenderParams): Promise<PDFPageProxy> {
    const page = await p.pdf!.getPage(p.pageIndex + 1);
    captureViewportClass(page);
    this.lastPdfPage = page;
    return page;
  }

  private scheduleCanvas() {
    const p = this.params;
    if (!p || !p.pdf || this.destroyed) return;
    const key = this.wantKey(p);
    this.scheduledKey = key;
    renderQueue.schedule(this.qid, p.priority, async (ctx) => {
      const page = await this.getPage(p);
      if (ctx.cancelled || this.destroyed) return;
      const vp = makeViewport(p.page, p.zoom, p.rotation);
      const s = outputScaleFor(p.width, p.height, p.dpr);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(p.width * s));
      canvas.height = Math.max(1, Math.round(p.height * s));
      const task = page.render({
        canvas,
        viewport: vp,
        transform: [canvas.width / vp.width, 0, 0, canvas.height / vp.height, 0, 0],
        annotationMode: AnnotationMode.ENABLE_FORMS,
        annotationCanvasMap: this.canvasMapFor(p.token),
        optionalContentConfigPromise: ocConfigFor(p.pdf!, p.optionalContent), // [navigation]
      });
      ctx.onCancel(() => task.cancel());
      try {
        await task.promise;
      } catch (e) {
        releaseCanvas(canvas);
        if (this.scheduledKey === key) this.scheduledKey = null;
        if (isCancellation(e) || ctx.cancelled || this.destroyed) return;
        console.error('[viewer] page render failed', e);
        this.setState({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (this.scheduledKey === key) this.scheduledKey = null;
      if (ctx.cancelled || this.destroyed) {
        releaseCanvas(canvas);
        return;
      }
      this.swapCanvas(canvas, { token: p.token, zoom: p.zoom, rotation: p.rotation, outputScale: s, key });
      if (this.annot && this.annot.token === p.token) this.annot.layer.refreshCanvases();
      this.ensureLayers();
      this.maybeDetail();
    });
  }

  private swapCanvas(canvas: HTMLCanvasElement, meta: CanvasMeta) {
    const old = this.canvas;
    this.canvas = canvas;
    this.meta = meta;
    canvas.className = 'pdfwizard-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    if (old && old.parentNode === this.wrap) this.wrap.replaceChild(canvas, old);
    else this.wrap.prepend(canvas);
    if (old && old !== canvas) releaseCanvas(old);
    this.styleCanvas();
    // The detail canvas belongs to the previous render; drop it if the key changed.
    if (this.detail && !this.detail.key.startsWith(`${meta.token}|${meta.zoom}|${meta.rotation}|`)) this.dropDetail();
    this.setState({ painted: true, error: null });
  }

  private styleCanvas() {
    const c = this.canvas;
    const m = this.meta;
    const p = this.params;
    if (!c || !m || !p) return;
    const delta = normRotation(p.rotation - m.rotation);
    const swap = delta % 180 !== 0;
    c.style.width = `${swap ? p.height : p.width}px`;
    c.style.height = `${swap ? p.width : p.height}px`;
    c.style.transform = ROT_CSS[delta];
  }

  // ── detail (high zoom) canvas ────────────────────────────────────────────

  private styleDetail() {
    const d = this.detail;
    const p = this.params;
    if (!d || !p) return;
    const [token, zoom, rotation] = d.key.split('|');
    if (Number(token) !== p.token || Number(zoom) !== p.zoom || Number(rotation) !== p.rotation) {
      d.canvas.style.display = 'none';
    } else {
      d.canvas.style.display = '';
    }
  }

  private dropDetail() {
    if (this.detailScheduledKey) renderQueue.cancel(this.detailQid);
    this.detailScheduledKey = null;
    if (this.detail) {
      this.detail.canvas.remove();
      releaseCanvas(this.detail.canvas);
      this.detail = null;
    }
  }

  private maybeDetail() {
    const p = this.params;
    const m = this.meta;
    if (!p || !p.pdf || !m || this.destroyed) return;
    const full = outputScaleFor(p.width, p.height, p.dpr);
    if (full >= p.dpr * 0.98 || m.key !== this.wantKey(p)) {
      if (full >= p.dpr * 0.98) this.dropDetail();
      return;
    }
    const vis = p.visibleRect();
    if (!vis || vis.width <= 0 || vis.height <= 0) return;
    const prefix = `${p.token}|${p.zoom}|${p.rotation}|${ocTag(p.optionalContent)}|`; // [navigation] oc tag
    const d = this.detail;
    if (
      d &&
      d.key.startsWith(prefix) &&
      vis.left >= d.box.left - 1 &&
      vis.top >= d.box.top - 1 &&
      vis.left + vis.width <= d.box.left + d.box.width + 1 &&
      vis.top + vis.height <= d.box.top + d.box.height + 1
    ) {
      return; // current detail canvas still covers the viewport
    }
    // Render the visible region plus a margin, within the pixel budget.
    const dpr = p.dpr;
    let mx = vis.width * 0.35;
    let my = vis.height * 0.35;
    const budget = MAX_CANVAS_PIXELS / (dpr * dpr);
    while ((vis.width + 2 * mx) * (vis.height + 2 * my) > budget && (mx > 1 || my > 1)) {
      mx *= 0.7;
      my *= 0.7;
    }
    const left = Math.max(0, Math.floor(vis.left - mx));
    const top = Math.max(0, Math.floor(vis.top - my));
    const right = Math.min(p.width, Math.ceil(vis.left + vis.width + mx));
    const bottom = Math.min(p.height, Math.ceil(vis.top + vis.height + my));
    const box: ViewBox = { left, top, width: right - left, height: bottom - top };
    if (box.width * box.height * dpr * dpr > MAX_CANVAS_PIXELS * 1.05) return;
    const key = `${prefix}${left},${top},${box.width},${box.height}`;
    if (this.detailScheduledKey === key) return;
    this.detailScheduledKey = key;
    renderQueue.schedule(this.detailQid, () => p.priority() + 0.5, async (ctx) => {
      const page = await this.getPage(p);
      if (ctx.cancelled || this.destroyed) return;
      const vp = makeViewport(p.page, p.zoom, p.rotation);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      const task = page.render({
        canvas,
        viewport: vp,
        transform: [dpr, 0, 0, dpr, -box.left * dpr, -box.top * dpr],
        annotationMode: AnnotationMode.ENABLE_FORMS,
        optionalContentConfigPromise: ocConfigFor(p.pdf!, p.optionalContent), // [navigation]
      });
      ctx.onCancel(() => task.cancel());
      try {
        await task.promise;
      } catch (e) {
        releaseCanvas(canvas);
        if (this.detailScheduledKey === key) this.detailScheduledKey = null;
        if (!isCancellation(e) && !ctx.cancelled) console.warn('[viewer] detail render failed', e);
        return;
      }
      if (this.detailScheduledKey === key) this.detailScheduledKey = null;
      if (ctx.cancelled || this.destroyed) {
        releaseCanvas(canvas);
        return;
      }
      canvas.className = 'pdfwizard-canvas-detail';
      canvas.setAttribute('aria-hidden', 'true');
      Object.assign(canvas.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
      const old = this.detail;
      this.detail = { canvas, box, key };
      this.wrap.append(canvas);
      if (old) {
        old.canvas.remove();
        releaseCanvas(old.canvas);
      }
      this.styleDetail();
    });
  }

  // ── text + annotation layers ─────────────────────────────────────────────

  private ensureLayers() {
    const p = this.params;
    if (!p || !p.pdf || this.destroyed) return;
    if (this.textToken !== p.token && this.textPendingToken !== p.token) void this.buildText(p);
    if ((this.annot?.token ?? -1) !== p.token && this.annotPendingToken !== p.token) void this.buildAnnotations(p);
  }

  private async buildText(p: PageRenderParams) {
    this.textPendingToken = p.token;
    const layer = new PageTextLayer();
    try {
      const page = await this.getPage(p);
      if (this.destroyed || this.params?.token !== p.token) {
        layer.destroy();
        return;
      }
      const cur = this.params;
      const vp = makeViewport(cur.page, cur.zoom, cur.rotation);
      await layer.render(page, vp);
      if (this.destroyed || this.params?.token !== p.token) {
        layer.destroy();
        return;
      }
      const old = this.text;
      if (old) old.div.replaceWith(layer.div);
      else {
        const annotDiv = this.annot?.div;
        if (annotDiv && annotDiv.parentNode === this.base) this.base.insertBefore(layer.div, annotDiv);
        else this.base.append(layer.div);
      }
      old?.destroy();
      this.text = layer;
      this.textToken = p.token;
      this.textScale = cur.zoom;
      this.textRotation = cur.rotation;
      // Params may have moved on while streaming text.
      const now = this.params;
      if (now && (now.zoom !== this.textScale || now.rotation !== this.textRotation)) {
        layer.update(makeViewport(now.page, now.zoom, now.rotation));
        this.textScale = now.zoom;
        this.textRotation = now.rotation;
      }
    } catch (e) {
      layer.destroy();
      if (!isCancellation(e)) console.warn('[viewer] text layer failed', e);
    } finally {
      if (this.textPendingToken === p.token) this.textPendingToken = -1;
    }
  }

  private async buildAnnotations(p: PageRenderParams) {
    this.annotPendingToken = p.token;
    const pdf = p.pdf!;
    try {
      const page = await this.getPage(p);
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (this.destroyed || this.params?.token !== p.token) return;
      const div = document.createElement('div');
      div.className = 'annotationLayer';
      const cur = this.params;
      const vp = makeViewport(cur.page, cur.zoom, cur.rotation).clone({ dontFlip: true });
      const linkService = linkServiceFor(this.docId, pdf);
      const hasWidgets = annotations.some((a: { annotationType?: number }) => a.annotationType === 20);
      const fieldObjects = hasWidgets ? await fieldObjectsFor(pdf) : null;
      if (this.destroyed || this.params?.token !== p.token) return;
      const layer = new AnnotationLayer({
        div,
        accessibilityManager: null,
        annotationCanvasMap: this.canvasMapFor(p.token),
        annotationEditorUIManager: null,
        page,
        viewport: vp,
        structTreeLayer: null,
        commentManager: null,
        linkService,
        annotationStorage: pdf.annotationStorage,
      });
      if (annotations.length) {
        await layer.render({
          annotations,
          div,
          page,
          viewport: vp,
          linkService: linkService as never,
          annotationStorage: pdf.annotationStorage,
          renderForms: true,
          enableScripting: false,
          hasJSActions: false,
          fieldObjects: fieldObjects as never,
          imageResourcesPath: '',
        });
      }
      if (this.destroyed || this.params?.token !== p.token) {
        layer.destroy();
        return;
      }
      const onInput = () => this.onFormInput();
      div.addEventListener('input', onInput);
      div.addEventListener('change', onInput);
      const old = this.annot;
      if (old) old.div.replaceWith(div);
      else this.base.append(div);
      old?.layer.destroy();
      this.annot = { token: p.token, div, layer };
      this.annotRotation = cur.rotation;
      const now = this.params;
      if (now && now.rotation !== this.annotRotation) {
        layer.update({ viewport: makeViewport(now.page, now.zoom, now.rotation).clone({ dontFlip: true }) } as never);
        this.annotRotation = now.rotation;
      }
    } catch (e) {
      if (!isCancellation(e)) console.warn('[viewer] annotation layer failed', e);
    } finally {
      if (this.annotPendingToken === p.token) this.annotPendingToken = -1;
    }
  }

  /** The pdf.js text layer div (for text selection helpers). */
  get textLayerDiv(): HTMLDivElement | null {
    return this.text?.div ?? null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelCanvasWork();
    renderQueue.cancel(this.qid);
    this.dropDetail();
    if (this.textTimer) clearTimeout(this.textTimer);
    if (this.detailTimer) clearTimeout(this.detailTimer);
    this.text?.destroy();
    this.text = null;
    if (this.annot) {
      this.annot.layer.destroy();
      this.annot.div.remove();
      this.annot = null;
    }
    if (this.canvas && this.meta) {
      this.canvas.remove();
      stashCanvas(this.docId, this.pageId, { canvas: this.canvas, meta: this.meta });
    }
    this.canvas = null;
    try {
      this.lastPdfPage?.cleanup();
    } catch {
      /* ignore */
    }
    this.lastPdfPage = null;
    this.canvasMaps.clear();
  }
}

export type { PageViewport };
