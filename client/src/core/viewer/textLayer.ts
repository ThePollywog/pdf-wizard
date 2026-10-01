/**
 * pdf.js TextLayer wrapper (equivalent of pdf.js' TextLayerBuilder, which can't be imported
 * without the full viewer bundle): streams text content, appends the `endOfContent` helper that
 * keeps drag-selections from jumping, normalizes copied text and installs the global selection
 * listeners that pin `endOfContent` next to the selection focus.
 */
import { TextLayer, normalizeUnicode } from 'pdfjs-dist';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';

const layers = new Map<HTMLDivElement, HTMLDivElement>();
let globalAC: AbortController | null = null;

function removeNulls(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x00/g, '');
}

function resetLayer(end: HTMLDivElement, layer: HTMLDivElement) {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  end.style.userSelect = '';
  layer.classList.remove('selecting');
}

function enableGlobalListeners() {
  if (globalAC) return;
  globalAC = new AbortController();
  const { signal } = globalAC;
  let pointerDown = false;
  let skipAnchorTrick: boolean | undefined;
  let prevRange: Range | null = null;

  document.addEventListener('pointerdown', () => (pointerDown = true), { signal });
  document.addEventListener(
    'pointerup',
    () => {
      pointerDown = false;
      layers.forEach(resetLayer);
    },
    { signal },
  );
  window.addEventListener(
    'blur',
    () => {
      pointerDown = false;
      layers.forEach(resetLayer);
    },
    { signal },
  );
  document.addEventListener(
    'keyup',
    () => {
      if (!pointerDown) layers.forEach(resetLayer);
    },
    { signal },
  );
  document.addEventListener(
    'selectionchange',
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(resetLayer);
        return;
      }
      const active = new Set<HTMLDivElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const div of layers.keys()) {
          if (!active.has(div) && range.intersectsNode(div)) active.add(div);
        }
      }
      for (const [div, end] of layers) {
        if (active.has(div)) div.classList.add('selecting');
        else resetLayer(end, div);
      }
      if (skipAnchorTrick === undefined) {
        const first = layers.keys().next().value;
        skipAnchorTrick = !!first && getComputedStyle(first).getPropertyValue('-moz-user-select') === 'none';
        if (!skipAnchorTrick) {
          const ua = navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[] } };
          const v = ua.userAgentData
            ? ua.userAgentData.brands.find((b) => b.brand === 'Chromium')?.version
            : /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
          skipAnchorTrick = !!v && parseInt(v, 10) >= 148;
        }
      }
      if (skipAnchorTrick) return;
      const range = selection.getRangeAt(0);
      const modifyStart =
        !!prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
      if (anchor && anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (anchor instanceof Element && anchor.classList.contains('highlight')) anchor = anchor.parentNode;
      if (!modifyStart && range.endOffset === 0 && anchor) {
        try {
          do {
            while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
            anchor = anchor?.previousSibling ?? null;
          } while (anchor && !anchor.childNodes.length);
        } catch {
          anchor = null;
        }
      }
      const parentLayer = (anchor as Element | null)?.parentElement?.closest('.textLayer') as HTMLDivElement | null;
      const end = parentLayer ? layers.get(parentLayer) : undefined;
      if (end && parentLayer && anchor?.parentElement) {
        end.style.width = parentLayer.style.width;
        end.style.height = parentLayer.style.height;
        end.style.userSelect = 'text';
        anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}

function unregister(div: HTMLDivElement) {
  layers.delete(div);
  if (layers.size === 0) {
    globalAC?.abort();
    globalAC = null;
  }
}

export class PageTextLayer {
  readonly div: HTMLDivElement;
  private layer: TextLayer | null = null;
  private done = false;
  private end: HTMLDivElement | null = null;
  private ac = new AbortController();

  constructor() {
    this.div = document.createElement('div');
    this.div.className = 'textLayer';
  }

  get rendered() {
    return this.done;
  }

  async render(page: PDFPageProxy, viewport: PageViewport): Promise<void> {
    this.layer = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: this.div,
      viewport,
    });
    await this.layer.render();
    this.done = true;
    const end = document.createElement('div');
    end.className = 'endOfContent';
    this.div.append(end);
    this.end = end;
    const opts = { signal: this.ac.signal };
    this.div.addEventListener('mousedown', () => this.div.classList.add('selecting'), opts);
    this.div.addEventListener(
      'copy',
      (e) => {
        const sel = document.getSelection();
        if (!sel || !e.clipboardData) return;
        e.clipboardData.setData('text/plain', removeNulls(normalizeUnicode(sel.toString())));
        e.preventDefault();
        e.stopPropagation();
      },
      opts,
    );
    layers.set(this.div, end);
    enableGlobalListeners();
  }

  /** Re-layout for a new scale / rotation (cheap for rotation, measures text for scale). */
  update(viewport: PageViewport) {
    if (!this.layer || !this.done) return;
    this.layer.update({ viewport });
  }

  destroy() {
    try {
      this.layer?.cancel();
    } catch {
      /* ignore */
    }
    this.layer = null;
    this.ac.abort();
    unregister(this.div);
    this.div.replaceChildren();
    this.div.remove();
    this.end = null;
  }
}
