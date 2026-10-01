/**
 * Minimal pdf.js link service for the AnnotationLayer: internal destinations scroll the viewer
 * (actions.goToPage), external URLs open in a new tab with rel=noopener.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId, Point, Rect } from '../types';
import { actions, getDoc } from '../store';
import { printDoc } from '../engine';

type Dest = string | unknown[] | null;

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return ['http:', 'https:', 'mailto:', 'tel:', 'ftp:'].includes(u.protocol);
  } catch {
    return false;
  }
}

export interface ViewerLinkService {
  externalLinkEnabled: boolean;
  isInPresentationMode: boolean;
  readonly pagesCount: number;
  page: number;
  rotation: number;
  eventBus: null;
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void;
  getDestinationHash(dest: Dest): string;
  getAnchorUrl(anchor: string): string;
  goToDestination(dest: Dest): Promise<void>;
  goToPage(val: number | string): void;
  goToXY(pageNumber: number, x: number, y: number): void;
  navigateTo(dest: Dest): void;
  setHash(hash: string): void;
  executeNamedAction(action: string): void;
  executeSetOCGState(action: unknown): Promise<void>;
  isPageVisible(pageNumber: number): boolean;
  isPageCached(pageNumber: number): boolean;
}

export function createLinkService(docId: DocId, pdf: PDFDocumentProxy): ViewerLinkService {
  const pageCount = () => getDoc(docId)?.pages.length ?? pdf.numPages;

  async function resolve(dest: Dest): Promise<{ pageIndex: number; point?: Point; rect?: Rect } | null> {
    let explicit: unknown[] | null = null;
    if (typeof dest === 'string') explicit = await pdf.getDestination(dest);
    else if (Array.isArray(dest)) explicit = dest;
    if (!explicit || explicit.length === 0) return null;
    const ref = explicit[0];
    let pageIndex: number;
    if (ref && typeof ref === 'object') {
      try {
        pageIndex = await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
      } catch {
        return null;
      }
    } else if (Number.isInteger(ref)) {
      pageIndex = ref as number;
    } else return null;
    if (pageIndex < 0 || pageIndex >= pageCount()) return null;
    const page = getDoc(docId)?.pages[pageIndex];
    if (!page) return { pageIndex };
    const kind = (explicit[1] as { name?: string } | undefined)?.name;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const [x0, y0, x1, y1] = page.view;
    switch (kind) {
      case 'XYZ': {
        const left = num(explicit[2]);
        const top = num(explicit[3]);
        if (left === null && top === null) return { pageIndex };
        return { pageIndex, point: { x: left ?? x0, y: top ?? y1 } };
      }
      case 'FitH':
      case 'FitBH': {
        const top = num(explicit[2]);
        return top === null ? { pageIndex } : { pageIndex, point: { x: x0, y: top } };
      }
      case 'FitV':
      case 'FitBV': {
        const left = num(explicit[2]);
        return left === null ? { pageIndex } : { pageIndex, point: { x: left, y: y1 } };
      }
      case 'FitR': {
        const a = [explicit[2], explicit[3], explicit[4], explicit[5]].map(num);
        if (a.some((v) => v === null)) return { pageIndex };
        const [l, b, r, t] = a as number[];
        return {
          pageIndex,
          rect: { x: Math.min(l, r), y: Math.min(b, t), width: Math.abs(r - l), height: Math.abs(t - b) },
        };
      }
      default:
        return { pageIndex };
    }
  }

  const svc: ViewerLinkService = {
    externalLinkEnabled: true,
    isInPresentationMode: false,
    get pagesCount() {
      return pageCount();
    },
    get page() {
      return (getDoc(docId)?.view.currentPage ?? 0) + 1;
    },
    set page(n: number) {
      actions.goToPage(docId, n - 1);
    },
    rotation: 0,
    eventBus: null,

    addLinkAttributes(link, url, _newWindow = false) {
      if (!url || typeof url !== 'string' || !isSafeUrl(url)) {
        link.href = '';
        link.title = url ? `Blocked link: ${url}` : '';
        link.onclick = () => false;
        return;
      }
      link.href = url;
      link.title = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
    },
    getDestinationHash(dest) {
      if (typeof dest === 'string' && dest.length > 0) return `#${encodeURIComponent(dest)}`;
      if (Array.isArray(dest)) return `#dest`;
      return '';
    },
    getAnchorUrl(anchor) {
      return `#${anchor}`;
    },
    async goToDestination(dest) {
      const r = await resolve(dest);
      if (!r) return;
      actions.goToPage(docId, r.pageIndex, { point: r.point, rect: r.rect });
    },
    goToPage(val) {
      const n = typeof val === 'string' ? parseInt(val, 10) : val;
      if (Number.isInteger(n)) actions.goToPage(docId, n - 1);
    },
    goToXY(pageNumber, x, y) {
      actions.goToPage(docId, pageNumber - 1, { point: { x, y } });
    },
    navigateTo(dest) {
      void svc.goToDestination(dest);
    },
    setHash(hash) {
      const m = /page=(\d+)/.exec(hash);
      if (m) actions.goToPage(docId, parseInt(m[1], 10) - 1);
    },
    executeNamedAction(action) {
      const d = getDoc(docId);
      if (!d) return;
      const cur = d.view.currentPage;
      switch (action) {
        case 'NextPage':
          actions.goToPage(docId, cur + 1);
          break;
        case 'PrevPage':
          actions.goToPage(docId, cur - 1);
          break;
        case 'FirstPage':
          actions.goToPage(docId, 0);
          break;
        case 'LastPage':
          actions.goToPage(docId, d.pages.length - 1);
          break;
        case 'Print':
          void printDoc(docId).catch(() => undefined);
          break;
        default:
          break;
      }
    },
    async executeSetOCGState() {
      /* optional content toggling is not supported in the viewer */
    },
    isPageVisible() {
      return true;
    },
    isPageCached() {
      return true;
    },
  };
  return svc;
}
