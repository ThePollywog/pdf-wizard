/**
 * One page of the document viewer. Layers, bottom to top:
 *   canvas → pdf.js textLayer → pdf.js annotationLayer (imperative, see PageRenderer)
 *   → decorations → 'under-objects' page layers → objects → active tool PageOverlay
 *   → 'over-objects' page layers → selection frames / handles / marquee.
 */
import {
  Component,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import { TriangleAlert } from 'lucide-react';
import type { Decoration, DocId, ObjectTypeDef, PageInfo, PageLayerDef, PdfObject, Point, Rect, Rotation, ToolDef, ViewBox } from '../types';
import { actions, getDoc, useApp, useDoc } from '../store';
import { useRegistry } from '../registry';
import { rectToView, toView } from '../geometry';
import { Spinner } from '../ui';
import type { Slot } from './layout';
import { makeViewport } from './viewport';
import { PageRenderer, type PageRenderState } from './pageRenderer';
import type { ViewerController } from './controller';
import { useViewerUi } from './viewerStore';

export interface PageViewProps {
  ctrl: ViewerController;
  docId: DocId;
  page: PageInfo;
  pageIndex: number;
  slot: Slot;
  zoom: number;
  /** Fresh pdf.js document (null while the engine reloads it). */
  pdf: PDFDocumentProxy | null;
  token: number;
  dpr: number;
  dark: boolean;
}

const EMPTY_OBJS: PdfObject[] = [];
const EMPTY_DECOS: Decoration[] = [];
const EMPTY_IDS: string[] = [];

export const PageView = memo(function PageView(props: PageViewProps) {
  const { ctrl, docId, page, pageIndex, slot, zoom, pdf, token, dpr, dark } = props;
  const baseRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PageRenderer | null>(null);
  const [rs, setRs] = useState<PageRenderState>({ painted: false, error: null });
  const vp = useMemo(() => makeViewport(page, zoom, slot.rotation), [page, zoom, slot.rotation]);

  // Keep the latest index for the (stable) priority callbacks.
  const indexRef = useRef(pageIndex);
  indexRef.current = pageIndex;
  const priority = useCallback(() => ctrl.pagePriority(indexRef.current), [ctrl]);
  const visibleRect = useCallback(() => ctrl.visiblePageRect(indexRef.current), [ctrl]);
  const optionalContent = useDoc(docId, (d) => (d?.ext.optionalContent as Record<string, boolean> | undefined) ?? null); // [navigation] layer visibility

  useLayoutEffect(() => {
    const base = baseRef.current!;
    const r = new PageRenderer(
      base,
      docId,
      page.id,
      (s) => setRs(s),
      () => {
        const d = getDoc(docId);
        if (d && !d.dirty) actions.updateDoc(docId, { dirty: true });
      },
    );
    rendererRef.current = r;
    ctrl.registerRenderer(page.id, r);
    setRs({ painted: r.painted, error: null });
    return () => {
      ctrl.registerRenderer(page.id, null);
      r.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, page.id, ctrl]);

  useLayoutEffect(() => {
    rendererRef.current?.update({
      docId,
      page,
      pageIndex,
      zoom,
      rotation: slot.rotation,
      width: slot.width,
      height: slot.height,
      pdf,
      token,
      dpr,
      priority,
      visibleRect,
      optionalContent, // [navigation]
    });
  }, [docId, page, pageIndex, zoom, slot.rotation, slot.width, slot.height, pdf, token, dpr, priority, visibleRect, optionalContent]);

  const style = {
    left: slot.left,
    top: slot.top,
    width: slot.width,
    height: slot.height,
    '--scale-factor': zoom,
    '--user-unit': 1,
    '--total-scale-factor': 'calc(var(--scale-factor) * var(--user-unit))',
    '--scale-round-x': `${1 / dpr}px`,
    '--scale-round-y': `${1 / dpr}px`,
  } as CSSProperties;

  return (
    <div
      className={`pdfwizard-page${dark ? ' is-dark' : ''}${rs.painted ? ' is-painted' : ''}`}
      data-testid="page"
      data-page-index={pageIndex}
      data-page-id={page.id}
      data-rotation={slot.rotation}
      data-painted={rs.painted ? 'true' : undefined}
      style={style}
      role="region"
      aria-label={`Page ${page.label ?? pageIndex + 1}`}
    >
      <div className="pdfwizard-page-base" ref={baseRef} />
      {!rs.painted && !rs.error && (
        <div className="pdfwizard-page-loading" aria-hidden="true">
          <Spinner size={28} label={`Loading page ${pageIndex + 1}`} />
        </div>
      )}
      {rs.error && (
        <div className="pdfwizard-page-error" role="alert">
          <TriangleAlert size={22} />
          <span>This page could not be displayed.</span>
          <small>{rs.error}</small>
        </div>
      )}
      <DecorationsLayer docId={docId} pageId={page.id} vp={vp} />
      <FeatureLayers placement="under-objects" ctrl={ctrl} docId={docId} page={page} pageIndex={pageIndex} vp={vp} zoom={zoom} rotation={slot.rotation} />
      <ObjectsLayer docId={docId} page={page} pageIndex={pageIndex} vp={vp} zoom={zoom} rotation={slot.rotation} />
      <ToolLayer ctrl={ctrl} docId={docId} page={page} pageIndex={pageIndex} vp={vp} zoom={zoom} rotation={slot.rotation} />
      <FeatureLayers placement="over-objects" ctrl={ctrl} docId={docId} page={page} pageIndex={pageIndex} vp={vp} zoom={zoom} rotation={slot.rotation} />
      <SelectionLayer docId={docId} page={page} pageIndex={pageIndex} vp={vp} slot={slot} />
    </div>
  );
});

// ── Decorations ─────────────────────────────────────────────────────────────

function DecorationsLayer({ docId, pageId, vp }: { docId: DocId; pageId: string; vp: PageViewport }) {
  const decos = useDoc(
    docId,
    useShallow((d) => {
      if (!d) return EMPTY_DECOS;
      const out: Decoration[] = [];
      for (const list of Object.values(d.decorations)) for (const x of list) if (x.pageId === pageId) out.push(x);
      return out.length ? out : EMPTY_DECOS;
    }),
  );
  if (decos.length === 0) return null;
  // Draw the active decoration last so it sits on top.
  const sorted = [...decos].sort((a, b) => Number(!!a.active) - Number(!!b.active));
  return (
    <div className="pdfwizard-decorations" aria-hidden="true">
      {sorted.map((d, i) =>
        d.rects.map((r, j) => {
          const b = rectToView(vp, r);
          return (
            <div
              key={`${i}-${j}`}
              className={`pdfwizard-deco${d.active ? ' is-active' : ''}${d.className ? ` ${d.className}` : ''}`}
              title={d.title}
              style={{
                left: b.left,
                top: b.top,
                width: Math.max(1, b.width),
                height: Math.max(1, b.height),
                ...(d.color ? { background: d.color } : null),
              }}
            />
          );
        }),
      )}
    </div>
  );
}

// ── Objects ─────────────────────────────────────────────────────────────────

class ObjectErrorBoundary extends Component<{ kind: string; quiet?: boolean; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[viewer] ${this.props.quiet ? 'page layer' : 'object'} "${this.props.kind}" failed to render`, error, info.componentStack);
  }
  render() {
    if (this.state.error) return this.props.quiet ? null : <div className="pdfwizard-obj-unknown" title={this.state.error.message}>!</div>;
    return this.props.children;
  }
}

interface LayerProps {
  docId: DocId;
  page: PageInfo;
  pageIndex: number;
  vp: PageViewport;
  zoom: number;
  rotation: Rotation;
}

function ObjectsLayer({ docId, page, pageIndex, vp, zoom, rotation }: LayerProps) {
  const objs = useDoc(
    docId,
    useShallow((d) => {
      if (!d || d.order.length === 0) return EMPTY_OBJS;
      const out: PdfObject[] = [];
      for (const id of d.order) {
        const o = d.objects[id];
        if (o && o.pageId === page.id) out.push(o);
      }
      return out.length ? out : EMPTY_OBJS;
    }),
  );
  const selection = useDoc(docId, (d) => d?.selection ?? EMPTY_IDS);
  const editingId = useDoc(docId, (d) => d?.editingId ?? null);
  const types = useRegistry((s) => s.objectTypes);
  const toolId = useApp((s) => s.activeToolId);
  const interactive = toolId === 'select' || toolId === 'hand';
  if (objs.length === 0) return null;
  return (
    <div className={`pdfwizard-objects${interactive ? '' : ' is-inert'}`}>
      {objs.map((o) => (
        <ObjectWrapper
          key={o.id}
          obj={o}
          type={types[o.kind]}
          docId={docId}
          page={page}
          pageIndex={pageIndex}
          vp={vp}
          zoom={zoom}
          rotation={rotation}
          selected={selection.includes(o.id)}
          editing={editingId === o.id}
        />
      ))}
    </div>
  );
}

interface WrapperProps extends LayerProps {
  obj: PdfObject;
  type: ObjectTypeDef | undefined;
  selected: boolean;
  editing: boolean;
}

const ObjectWrapper = memo(function ObjectWrapper({ obj, type, docId, page, pageIndex, vp, zoom, rotation, selected, editing }: WrapperProps) {
  const box = useMemo(() => rectToView(vp, obj.rect), [vp, obj.rect]);
  const id = obj.id;
  const toLocal = useCallback(
    (p: Point) => {
      const v = toView(vp, p);
      return { x: v.x - box.left, y: v.y - box.top };
    },
    [vp, box],
  );
  const setEditing = useCallback((e: boolean) => actions.setEditing(docId, e ? id : null), [docId, id]);
  const update = useCallback(
    (patch: Partial<PdfObject>, opts?: Parameters<typeof actions.updateObject>[3]) => actions.updateObject(docId, id, patch, opts),
    [docId, id],
  );
  const hit = type?.hit ?? 'box';
  const Render = type?.Render;
  return (
    <div
      className={`pdfwizard-obj${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}${obj.locked ? ' is-locked' : ''}`}
      data-obj-id={id}
      data-kind={obj.kind}
      data-hit={hit}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      {Render ? (
        <ObjectErrorBoundary kind={obj.kind}>
          <Render
            obj={obj}
            docId={docId}
            page={page}
            pageIndex={pageIndex}
            viewport={vp}
            scale={zoom}
            rotation={rotation}
            box={box}
            toLocal={toLocal}
            selected={selected}
            editing={editing}
            setEditing={setEditing}
            update={update}
          />
        </ObjectErrorBoundary>
      ) : (
        <div className="pdfwizard-obj-unknown" title={`Unsupported object type "${obj.kind}"`} />
      )}
    </div>
  );
});

// ── Tool overlay & feature page layers ──────────────────────────────────────

/** Coordinate helpers handed to tool overlays and page layers (stable while the page's viewport is). */
function useOverlayGeometry(ctrl: ViewerController, pageIndex: number, vp: PageViewport) {
  const idxRef = useRef(pageIndex);
  idxRef.current = pageIndex;
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const toPdf = useCallback(
    (clientX: number, clientY: number): Point => {
      const p = ctrl.clientToPage(idxRef.current, clientX, clientY) ?? { x: 0, y: 0 };
      const [x, y] = vpRef.current.convertToPdfPoint(p.x, p.y);
      return { x, y };
    },
    [ctrl],
  );
  const toViewFn = useCallback((p: Point) => toView(vp, p), [vp]);
  const rectToViewFn = useCallback((r: Rect): ViewBox => rectToView(vp, r), [vp]);
  return { toPdf, toView: toViewFn, rectToView: rectToViewFn };
}

function ToolLayer({ ctrl, docId, page, pageIndex, vp, zoom, rotation }: LayerProps & { ctrl: ViewerController }) {
  const toolId = useApp((s) => s.activeToolId);
  const tool = useRegistry((s) => s.tools[toolId]) as ToolDef | undefined;
  const Overlay = tool?.PageOverlay;
  const geo = useOverlayGeometry(ctrl, pageIndex, vp);
  if (!tool || !Overlay || toolId === 'select' || toolId === 'hand') return null;
  return (
    <div
      className={`pdfwizard-tool-overlay${tool.textSelection ? ' is-passthrough' : ''}`}
      data-tool={tool.id}
      style={tool.cursor ? { cursor: tool.cursor } : undefined}
    >
      <Overlay docId={docId} page={page} pageIndex={pageIndex} viewport={vp} scale={zoom} rotation={rotation} {...geo} />
    </div>
  );
}

const EMPTY_LAYERS: PageLayerDef[] = [];

/** registry.pageLayers of one placement, each in its own pointer-transparent container. */
function FeatureLayers({
  ctrl, docId, page, pageIndex, vp, zoom, rotation, placement,
}: LayerProps & { ctrl: ViewerController; placement: 'under-objects' | 'over-objects' }) {
  const layers = useRegistry(
    useShallow((s) => {
      const out = s.pageLayers.filter((l) => (l.placement ?? 'over-objects') === placement);
      return out.length ? out : EMPTY_LAYERS;
    }),
  );
  const geo = useOverlayGeometry(ctrl, pageIndex, vp);
  if (!layers.length) return null;
  return (
    <>
      {layers.map(({ id, Component: Layer }) => (
        <div key={id} className={`pdfwizard-page-layer is-${placement}`} data-layer={id}>
          <ObjectErrorBoundary kind={id} quiet>
            <Layer docId={docId} page={page} pageIndex={pageIndex} viewport={vp} scale={zoom} rotation={rotation} {...geo} />
          </ObjectErrorBoundary>
        </div>
      ))}
    </>
  );
}

// ── Selection frames, handles, marquee ──────────────────────────────────────

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type HandleId = (typeof HANDLES)[number];

function SelectionLayer({ docId, page, vp, slot }: { docId: DocId; page: PageInfo; pageIndex: number; vp: PageViewport; slot: Slot }) {
  const selected = useDoc(
    docId,
    useShallow((d) => {
      if (!d || d.selection.length === 0) return EMPTY_OBJS;
      const out: PdfObject[] = [];
      for (const id of d.selection) {
        const o = d.objects[id];
        if (o && o.pageId === page.id) out.push(o);
      }
      return out.length ? out : EMPTY_OBJS;
    }),
  );
  const totalSelected = useDoc(docId, (d) => d?.selection.length ?? 0);
  const editingId = useDoc(docId, (d) => d?.editingId ?? null);
  const types = useRegistry((s) => s.objectTypes);
  const marquee = useViewerUi((s) => (s.marquee && s.marquee.docId === docId && s.marquee.pageIndex === slot.index ? s.marquee.box : null));
  const interaction = useViewerUi((s) => s.interaction);
  const toolId = useApp((s) => s.activeToolId);
  if (selected.length === 0 && !marquee) return null;
  const showHandles = totalSelected === 1 && toolId === 'select' && interaction !== 'move';
  return (
    <div className="pdfwizard-selection" aria-hidden="true">
      {selected.map((o) => {
        const t = types[o.kind];
        const b = rectToView(vp, o.rect);
        const editing = editingId === o.id;
        const resizable = !o.locked && t?.resizable !== false && t?.movable !== false;
        const shapeHit = (t?.hit ?? 'box') === 'shape' && !editing;
        const small = b.width < 22 || b.height < 22;
        return (
          <div
            key={o.id}
            className={`pdfwizard-frame${o.locked ? ' is-locked' : ''}${editing ? ' is-editing' : ''}${shapeHit ? ' is-hit' : ''}`}
            data-frame-for={o.id}
            style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
          >
            {showHandles &&
              resizable &&
              !editing &&
              HANDLES.filter((h) => !small || h.length === 2).map((h) => (
                <div key={h} className={`pdfwizard-handle pdfwizard-handle-${h}`} data-handle={h} data-obj-id={o.id} />
              ))}
          </div>
        );
      })}
      {marquee && (
        <div className="pdfwizard-marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} />
      )}
    </div>
  );
}
