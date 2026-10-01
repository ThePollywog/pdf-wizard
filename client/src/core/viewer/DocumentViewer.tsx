/**
 * <DocumentViewer docId/>: the scrollable page canvas. Owns one ViewerController (imperative
 * context), ViewerScroll (anchoring, scroll requests, current page, wheel/pinch zoom) and
 * ViewerInteraction (pointer + keyboard). Only pages within ±1 screen of the viewport are mounted.
 */
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { FileWarning } from 'lucide-react';
import type { DocId, PageInfo, ViewState } from '../types';
import { actions, defaultView, useApp, useDoc } from '../store';
import { useRegistry } from '../registry';
import { EmptyState } from '../ui';
import { ViewerController } from './controller';
import { ViewerScroll } from './scrolling';
import { ViewerInteraction } from './interaction';
import { computeFitZoom, computeLayout, isPagedMode, type Layout } from './layout';
import { PageView } from './PageView';
import { useViewerUi } from './viewerStore';
import { PropertiesBar } from './PropertiesBar';
import { TextSelectionPopup } from './TextSelectionPopup';
import { CommentPopover } from './CommentPopover';

const EMPTY_PAGES: PageInfo[] = [];
const FALLBACK_VIEW: ViewState = defaultView();

// ── device pixel ratio (re-renders when the window moves to another screen / browser zoom) ──

function subscribeDpr(cb: () => void) {
  let mq: MediaQueryList | null = null;
  const onChange = () => {
    listen();
    cb();
  };
  const listen = () => {
    mq?.removeEventListener('change', onChange);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', onChange);
  };
  listen();
  return () => mq?.removeEventListener('change', onChange);
}
const getDpr = () => window.devicePixelRatio || 1;

export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeDpr, getDpr, () => 1);
}

// ── component ───────────────────────────────────────────────────────────────

export function DocumentViewer({ docId }: { docId: DocId }) {
  const ctrl = useMemo(() => new ViewerController(docId), [docId]);
  const scroll = useMemo(() => new ViewerScroll(ctrl), [ctrl]);
  const inter = useMemo(() => new ViewerInteraction(ctrl), [ctrl]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);

  const exists = useDoc(docId, (d) => !!d);
  const pages = useDoc(docId, (d) => d?.pages ?? EMPTY_PAGES);
  const view = useDoc(docId, (d) => d?.view ?? FALLBACK_VIEW);
  const loadError = useDoc(docId, (d) => d?.loadError ?? null);
  const name = useDoc(docId, (d) => d?.name ?? '');
  // Paint only with a pdf.js document that matches the current bytes (the engine reloads it after edits).
  const pdf = useDoc(docId, (d) => (d && d.pdf && d.pdfVersion === d.version ? d.pdf : null));
  const token = useDoc(docId, (d) => d?.pdfVersion ?? -1);
  const toolId = useApp((s) => s.activeToolId);
  const spacePan = useViewerUi((s) => s.spacePan);
  const panning = useViewerUi((s) => s.interaction === 'pan');
  const dpr = useDevicePixelRatio();

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [range, setRange] = useState<number[]>([]);

  const paged = isPagedMode(view.layout);
  const currentRef = useRef(view.currentPage);
  currentRef.current = view.currentPage;
  // In continuous layouts the current page doesn't affect geometry; don't recompute on scroll.
  const layoutPageKey = paged ? view.currentPage : -1;

  const fitZoom = useMemo(() => {
    if (!view.fit || size.w <= 0 || size.h <= 0) return null;
    return computeFitZoom({
      pages,
      viewRotation: view.rotation,
      mode: view.layout,
      currentPage: currentRef.current,
      fit: view.fit,
      containerWidth: size.w,
      containerHeight: size.h,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.fit, view.rotation, view.layout, pages, size.w, size.h, layoutPageKey]);
  const zoom = fitZoom ?? view.zoom;

  const layout = useMemo<Layout | null>(() => {
    if (size.w <= 0 || size.h <= 0) return null;
    return computeLayout({
      pages,
      zoom,
      viewRotation: view.rotation,
      mode: view.layout,
      currentPage: currentRef.current,
      containerWidth: size.w,
      containerHeight: size.h,
      dpr,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, zoom, view.rotation, view.layout, layoutPageKey, size.w, size.h, dpr]);

  // Event handlers read the latest layout from the controller (children's layout effects run
  // before ours, so assign during render).
  const prevLayout = useRef<Layout | null>(null);
  if (layout) ctrl.layout = layout;

  // Attach controller / listeners.
  useLayoutEffect(() => {
    ctrl.root = rootRef.current;
    ctrl.scroller = scrollerRef.current;
    ctrl.sizer = sizerRef.current;
    ctrl.attach();
    scroll.onRange = setRange;
    if (scrollerRef.current) scroll.attach(scrollerRef.current);
    inter.attach();
    return () => {
      inter.detach();
      scroll.detach();
      scroll.onRange = null;
      ctrl.detach();
      ctrl.root = null;
      ctrl.scroller = null;
      ctrl.sizer = null;
      prevLayout.current = null;
    };
  }, [ctrl, scroll, inter]);

  // Container size.
  useLayoutEffect(() => {
    const s = scrollerRef.current;
    if (!s) return;
    const measure = () => {
      const w = s.clientWidth;
      const h = s.clientHeight;
      setSize((p) => (p.w === w && p.h === h ? p : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(s);
    return () => ro.disconnect();
  }, [exists, loadError]);

  // Keep the stored zoom in sync with the fitted zoom (the pill shows it; fit stays set).
  useLayoutEffect(() => {
    if (fitZoom != null && view.fit && Math.abs(fitZoom - view.zoom) > 1e-6) actions.setZoom(docId, fitZoom, view.fit);
  }, [fitZoom, view.fit, view.zoom, docId]);

  // Scroll anchoring + scroll requests after each committed layout.
  const req = view.scrollRequest;
  useLayoutEffect(() => {
    if (!layout) return;
    const prev = prevLayout.current;
    prevLayout.current = layout;
    ctrl.layout = layout;
    const resized = !!prev && (prev.containerWidth !== layout.containerWidth || prev.containerHeight !== layout.containerHeight);
    scroll.layoutChanged(prev, layout, req, { resized, fit: !!view.fit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, req, ctrl, scroll]);

  if (!exists) return <div className="pdfwizard-viewer is-empty" ref={rootRef} />;

  if (loadError) {
    return (
      <div className="pdfwizard-viewer is-error" ref={rootRef} data-testid="viewer-error">
        <EmptyState icon={FileWarning} title={`Couldn't open ${name || 'this document'}`} description={loadError} />
      </div>
    );
  }

  const dark = !!view.darkPages;
  const sizerStyle: CSSProperties = layout ? { width: layout.width, height: layout.height } : { width: '100%', height: '100%' };
  const cls = [
    'pdfwizard-viewer',
    `is-layout-${view.layout}`,
    toolId === 'hand' && 'is-hand',
    toolId === 'select' && 'is-select',
    spacePan && 'is-space-pan',
    panning && 'is-panning',
    dark && 'is-dark-pages',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} ref={rootRef} data-doc-id={docId} data-tool={toolId} data-testid="document-viewer">
      <div
        className="pdfwizard-scroller"
        ref={scrollerRef}
        tabIndex={0}
        role="document"
        aria-label={name ? `${name} pages` : 'Document pages'}
        onPointerDown={inter.onPointerDown}
        onMouseDown={inter.onMouseDown}
        onDoubleClick={inter.onDoubleClick}
        onContextMenu={inter.onContextMenu}
      >
        <div className="pdfwizard-sizer" ref={sizerRef} style={sizerStyle}>
          {layout &&
            range.map((i) => {
              const page = pages[i];
              const slot = layout.slots[i];
              if (!page || !slot) return null;
              return (
                <PageView
                  key={page.id}
                  ctrl={ctrl}
                  docId={docId}
                  page={page}
                  pageIndex={i}
                  slot={slot}
                  zoom={layout.zoom}
                  pdf={pdf}
                  token={token}
                  dpr={dpr}
                  dark={dark}
                />
              );
            })}
          {layout && <PropertiesBar ctrl={ctrl} docId={docId} layout={layout} />}
        </div>
      </div>
      <TextSelectionPopup docId={docId} />
      <CommentPopover ctrl={ctrl} docId={docId} />
      <ViewerOverlays ctrl={ctrl} docId={docId} scrollerRef={scrollerRef} />
    </div>
  );
}

// ── feature viewer overlays (registerViewerOverlay) ─────────────────────────

function ViewerOverlays({ ctrl, docId, scrollerRef }: { ctrl: ViewerController; docId: DocId; scrollerRef: RefObject<HTMLDivElement | null> }) {
  const overlays = useRegistry((s) => s.viewerOverlays);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Refs are attached before layout effects run (ctrl.scroller is only set in the parent's effect).
  useLayoutEffect(() => setScroller(scrollerRef.current), [scrollerRef]);
  const helpers = useMemo(() => {
    const pageClientRect = (pageIndex: number): DOMRect | null => {
      const el = ctrl.pageElement(pageIndex);
      if (el) return el.getBoundingClientRect();
      const slot = ctrl.slot(pageIndex);
      const s = ctrl.scroller;
      if (!slot || !s) return null;
      const sr = s.getBoundingClientRect();
      return new DOMRect(sr.left - s.scrollLeft + slot.left, sr.top - s.scrollTop + slot.top, slot.width, slot.height);
    };
    const pageAt = (clientX: number, clientY: number) => {
      const s = ctrl.scroller;
      const slots = ctrl.layout?.slots;
      if (!s || !slots) return null;
      const sr = s.getBoundingClientRect();
      const x = clientX - sr.left + s.scrollLeft;
      const y = clientY - sr.top + s.scrollTop;
      for (const slot of slots) {
        if (!slot || x < slot.left || x > slot.left + slot.width || y < slot.top || y > slot.top + slot.height) continue;
        const point = ctrl.clientToPdf(slot.index, clientX, clientY);
        return point ? { pageIndex: slot.index, point } : null;
      }
      return null;
    };
    return { pageAt, pageClientRect };
  }, [ctrl]);
  if (!overlays.length) return null;
  return (
    <>
      {overlays.map(({ id, Component: Overlay }) => (
        <div key={id} className="pdfwizard-viewer-overlay" data-overlay={id}>
          <Overlay docId={docId} scroller={scroller} {...helpers} />
        </div>
      ))}
    </>
  );
}
