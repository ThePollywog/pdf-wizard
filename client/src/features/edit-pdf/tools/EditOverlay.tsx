/**
 * Page overlay shared by the four Edit PDF tools: outlines of the editable items, the selection
 * frame and its handles, the in-place text editor, drag previews, crop mode, the floating bar and
 * the pointer handling that turns clicks and drags into edits.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { getDoc, useApp, useDoc, useToolOptions } from '@/core/store';
import type { PageOverlayProps, Point, Rect, ViewBox } from '@/core/types';
import { rectToView } from '@/core/geometry';
import { HANDLES, type HandleId } from '@/core/viewer/PageView';
import { showContextMenu } from '@/core/ui';
import { usePageModel, type PageModel } from '../analysis';
import { frameQuad, type Frame } from '../content/blocks';
import { currentModel } from '../edits';
import { edgeDistance, hitItem, isTextItem, pageItems, type Item } from '../hit';
import { targetMenu } from '../menus';
import { CONTENT_DEFAULTS, TOOL_CONTENT, TOOL_IMAGE, TOOL_LINK, TOOL_TEXT, isEditTool, type ContentTextObject } from '../model';
import { paperColor, setDomDoc } from '../pagedom';
import { commitEdit, sessionChanged, startBlockEdit, startNewText, startObjectEdit } from '../sessions';
import { sameTarget, ui, useEditPdf, type EditSession, type Target } from '../state';
import { applyCrop, editLinkProperties, editTargetText } from '../targetActions';
import { layoutTextBox, objectFrame } from '../textbox';
import { boxOfQuad, frameCss, quadPoints } from '../viewmath';
import { CropFrame } from './CropFrame';
import { isDragging } from './drag';
import {
  dragBaseLink, editTextAt, moveBaseItem, moveObject, naturalSize, newLinkGesture, newTextGesture, placeImage, placeImageGesture, placeRect,
  reflowBlock, resizeBaseImage, resizeObject, resizeTextObject, type GestureCtx,
} from './gestures';
import { Ghosts, PreviewLayer, type LivePreview } from './Ghosts';
import { TargetBar, type BarMode } from './TargetBar';
import { EditCover, TextEditor } from './TextEditor';

/** Hit slack around items (CSS px). */
const HIT_PAD = 6;

/** Resolves once no byte edit started by this feature is running. */
function whenIdle(): Promise<void> {
  if (!ui.get().working) return Promise.resolve();
  return new Promise((resolve) => {
    const un = useEditPdf.subscribe((s) => {
      if (!s.working) {
        un();
        resolve();
      }
    });
  });
}

/** Item ↔ target (base blocks also compare their text: ids are positions in the content stream). */
function matches(it: Item, t: Target | null): boolean {
  if (!t || !sameTarget(it.target, t)) return false;
  if (t.type === 'block') return it.block?.text === t.text;
  return true;
}

/** The item belongs to the open text editor (its outline and frame are hidden meanwhile). */
function inSession(it: Item, s: EditSession | null): boolean {
  if (!s) return false;
  if (s.source.type === 'block') return it.kind === 'block' && it.block?.id === s.source.blockId && it.block.text === s.source.expectText;
  if (s.source.type === 'object') return it.kind === 'text-object' && it.obj?.id === s.source.objectId;
  return false;
}

function labelOf(it: Item): string {
  if (it.block) return it.block.text.slice(0, 80);
  if (it.image) return `Image ${it.image.name}`;
  if (it.link) return it.link.action?.type === 'url' ? it.link.action.url : 'Link';
  if (it.obj?.kind === 'content-text') return (it.obj as ContentTextObject).data.text.slice(0, 80);
  return it.obj?.kind ?? it.kind;
}

const kindClass = (it: Item) => (isTextItem(it) ? 'is-text' : it.kind === 'image' || it.kind === 'image-object' ? 'is-image' : 'is-link');

/** Pointer near the item's outline (drag to move) rather than inside it (place the caret). */
function onEdge(it: Item, p: Point, box: ViewBox, zoom: number): boolean {
  const band = Math.min(4, 0.25 * Math.min(box.width, box.height)) / (zoom || 1);
  return edgeDistance(it.quad, p) < band;
}

function nearestBy<T>(items: T[], rect: (t: T) => Rect, to: Rect): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const it of items) {
    const r = rect(it);
    const d = Math.abs(r.x - to.x) + Math.abs(r.y - to.y) + Math.abs(r.width - to.width) + Math.abs(r.height - to.height);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

/** Below this size (CSS px) the edge-middle handles would cover the whole box and block moving it. */
const MIN_MID_HANDLE = 36;

/** Resize handles of a selection box: short / narrow boxes keep the corners (and the long sides). */
function handlesFor(box: ViewBox): readonly HandleId[] {
  const short = box.height < MIN_MID_HANDLE;
  const narrow = box.width < MIN_MID_HANDLE;
  if (!short && !narrow) return HANDLES;
  return HANDLES.filter((h) => !((short && (h === 'n' || h === 's')) || (narrow && (h === 'e' || h === 'w'))));
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function EditOverlay(props: PageOverlayProps) {
  const { docId, page, pageIndex, viewport: vp, scale: zoom, toPdf } = props;
  const toolId = useApp((s) => s.activeToolId);
  const needsModel = toolId === TOOL_CONTENT || toolId === TOOL_LINK;
  const pm = usePageModel(docId, pageIndex, needsModel);
  const lastModel = useRef<PageModel | null>(null);
  if (pm.model) lastModel.current = pm.model;
  const model = pm.model ?? (needsModel ? lastModel.current : null);
  const modelCurrent = !needsModel || !!pm.model;
  const objects = useDoc(docId, (d) => d?.objects);
  const order = useDoc(docId, (d) => d?.order);
  const items = useMemo(() => {
    const doc = getDoc(docId);
    return doc ? pageItems(doc, page, pageIndex, model, toolId) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, page, pageIndex, model, toolId, objects, order]);

  const target = useEditPdf((s) => (s.target && s.target.docId === docId && s.target.pageIndex === pageIndex ? s.target : null));
  const hover = useEditPdf((s) => s.hover);
  const session = useEditPdf((s) => (s.edit && s.edit.docId === docId && s.edit.pageIndex === pageIndex ? s.edit : null));
  const crop = useEditPdf((s) => (s.crop && s.crop.docId === docId && s.crop.pageIndex === pageIndex ? s.crop : null));
  const reselect = useEditPdf((s) => (s.reselect && s.reselect.docId === docId && s.reselect.pageIndex === pageIndex ? s.reselect : null));
  const working = useEditPdf((s) => s.working);
  const pendingImage = useEditPdf((s) => s.pendingImage);
  const { showBoxes } = useToolOptions(TOOL_CONTENT, CONTENT_DEFAULTS);

  const [preview, setPreview] = useState<LivePreview | null>(null);
  const [marquee, setMarquee] = useState<ViewBox | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [mouse, setMouse] = useState<Point | null>(null);

  const ctx: GestureCtx = { docId, pageIndex, page, vp, zoom, toPdf, setPreview, setMarquee };
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const selected = useMemo(() => (target ? (items.find((it) => matches(it, target)) ?? null) : null), [items, target]);

  // page lookups (snapshots, paper color) go to this document's viewer
  useEffect(() => {
    if (useApp.getState().activeDocId === docId) setDomDoc(docId);
  }, [docId]);

  // select the item again once the page shows the result of an edit
  useEffect(() => {
    if (!reselect || !pm.model || toolId !== TOOL_CONTENT) return;
    if (pm.model.bytes !== getDoc(docId)?.bytes) return;
    const m = pm.model;
    let next: Target | null = null;
    if (reselect.type === 'block') {
      const same = m.blocks.filter((b) => b.text === reselect.text);
      const b = nearestBy(same, (x) => x.bounds, reselect.bounds) ?? nearestBy(m.blocks.filter((x) => overlapArea(x.bounds, reselect.bounds) > 0), (x) => x.bounds, reselect.bounds);
      if (b) next = { type: 'block', docId, pageIndex, id: b.id, text: b.text, bounds: b.bounds };
    } else {
      // an empty name means "whatever image now sits there" (replace creates a new resource)
      const same = m.images.filter((x) => !reselect.name || x.name === reselect.name);
      const im = nearestBy(same, (x) => x.bounds, reselect.bounds) ?? nearestBy(m.images.filter((x) => overlapArea(x.bounds, reselect.bounds) > 0), (x) => x.bounds, reselect.bounds);
      if (im) next = { type: 'image', docId, pageIndex, id: im.id, name: im.name, bounds: im.bounds };
    }
    ui.setTarget(next);
    ui.setReselect(null);
  }, [reselect, pm.model, toolId, docId, pageIndex]);

  // drop a selection whose item is gone (deleted, undone, page changed)
  useEffect(() => {
    if (!target || working || reselect || !modelCurrent || preview) return;
    if (target.type === 'block' && session?.source.type === 'block') return;
    if (!items.some((it) => matches(it, target))) ui.setTarget(null);
  }, [target, items, working, reselect, modelCurrent, preview, session]);

  const layH = useMemo(() => (session ? layoutTextBox(session.text, session.style, session.frame.width, session.autoWidth).height : 0), [session]);

  // ── pointer handling ────────────────────────────────────────────────────

  const hitAt = (its: Item[], p: Point) => hitItem(its, p, HIT_PAD / (zoom || 1));

  const cursorFor = (it: Item | null, p: Point): string | undefined => {
    if (toolId === TOOL_LINK) return it ? 'move' : 'crosshair';
    if (toolId === TOOL_IMAGE) return 'copy';
    if (!it) return toolId === TOOL_TEXT ? 'text' : undefined;
    if (it.kind === 'block' && it.block && !it.block.textReliable) return 'move';
    if (isTextItem(it)) return onEdge(it, p, boxOfQuad(vp, it.quad), zoom) ? 'move' : 'text';
    return 'move';
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (isDragging() || e.buttons) return;
    if ((e.target as Element).closest('[data-edit-pdf-keep]')) {
      ui.setHover(null);
      return;
    }
    const p = toPdf(e.clientX, e.clientY);
    if (toolId === TOOL_IMAGE) {
      setMouse(p);
      setCursor('copy');
      return;
    }
    const it = hitAt(items, p);
    ui.setHover(it?.key ?? null);
    const c = cursorFor(it, p);
    if (c !== cursor) setCursor(c);
  };

  const onPointerLeave = () => {
    ui.setHover(null);
    setMouse(null);
  };

  /** Click / drag with fresh state (tool, items) — the normal path. */
  const gesture = (down: { clientX: number; clientY: number; pointerId: number }, p: Point, tool: string, its: Item[]) => {
    const c = ctxRef.current;
    const it = hitAt(its, p);
    if (tool === TOOL_CONTENT) {
      if (!it) {
        ui.setTarget(null);
        return;
      }
      if (isTextItem(it)) {
        const unreliable = it.kind === 'block' && !!it.block && !it.block.textReliable;
        if (unreliable || onEdge(it, p, boxOfQuad(vp, it.quad), zoom)) {
          if (it.kind === 'block') moveBaseItem(c, down, it);
          else if (it.obj) {
            ui.setTarget(it.target);
            moveObject(c, down, it.obj);
          }
          return;
        }
        editTextAt(c, down, it, p);
        return;
      }
      if (it.kind === 'image') {
        moveBaseItem(c, down, it);
        return;
      }
      if (it.obj) {
        ui.setTarget(it.target);
        moveObject(c, down, it.obj);
      }
      return;
    }
    if (tool === TOOL_TEXT) {
      if (it?.kind === 'text-object' && it.obj) {
        if (onEdge(it, p, boxOfQuad(vp, it.quad), zoom)) {
          ui.setTarget(it.target);
          moveObject(c, down, it.obj);
        } else editTextAt(c, down, it, p);
        return;
      }
      newTextGesture(c, down, p);
      return;
    }
    if (tool === TOOL_IMAGE) {
      const img = ui.get().pendingImage;
      if (img) placeImageGesture(c, down, p, img);
      return;
    }
    if (tool === TOOL_LINK) {
      if (it) {
        ui.setTarget(it.target);
        if (it.kind === 'link') dragBaseLink(c, down, it, 'move');
        else if (it.obj) moveObject(c, down, it.obj);
        return;
      }
      newLinkGesture(c, down);
    }
  };

  /** Click after an edit had to finish first (the page content may have changed meanwhile). */
  const deferredClick = async (p: Point) => {
    await commitEdit();
    await whenIdle();
    const tool = useApp.getState().activeToolId;
    if (!isEditTool(tool)) return;
    const doc = getDoc(docId);
    const pg = doc?.pages[pageIndex];
    if (!doc || !pg || pg.id !== page.id) return;
    const m = tool === TOOL_CONTENT || tool === TOOL_LINK ? await currentModel(docId, pageIndex) : null;
    const its = pageItems(doc, pg, pageIndex, m, tool);
    const it = hitAt(its, p);
    if (tool === TOOL_CONTENT) {
      if (!it) ui.setTarget(null);
      else if (it.kind === 'block' && it.block && it.block.textReliable && !onEdge(it, p, boxOfQuad(vp, it.quad), zoom)) {
        startBlockEdit(docId, pageIndex, it.block, p, paperColor(pageIndex, boxOfQuad(vp, frameQuad(it.block.frame))));
      } else if (it.kind === 'text-object' && it.obj && !onEdge(it, p, boxOfQuad(vp, it.quad), zoom)) {
        startObjectEdit(docId, pageIndex, it.obj as ContentTextObject, p);
      } else ui.setTarget(it.target);
    } else if (tool === TOOL_TEXT) {
      if (it?.kind === 'text-object' && it.obj) startObjectEdit(docId, pageIndex, it.obj as ContentTextObject, p);
      else startNewText(docId, pageIndex, p, pg.rotation, null);
    } else if (tool === TOOL_IMAGE) {
      const img = ui.get().pendingImage;
      if (img) {
        const { w, h } = naturalSize(img, pg);
        placeImage(docId, pageIndex, img, placeRect(pg, pg.rotation, p, w, h));
      }
    } else if (tool === TOOL_LINK) {
      ui.setTarget(it ? it.target : null);
    }
  };

  const onMouseDown = (e: RMouseEvent) => {
    // keeps the focus in the text editor / stops native text selection on the page
    if (!(e.target as Element).closest('[data-edit-pdf-keep]')) e.preventDefault();
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('[data-edit-pdf-keep]')) return;
    e.preventDefault();
    // commit a value being typed into a panel field first (it applies to the current selection)
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !active.closest('.edit-pdf-editor') && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) active.blur();

    const p = toPdf(e.clientX, e.clientY);
    const down = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId };
    const st = ui.get();
    if (st.crop) {
      void applyCrop();
      return;
    }
    const s = st.edit?.phase === 'editing' ? st.edit : null;
    const toolBefore = useApp.getState().activeToolId;
    if (s) {
      const doc = getDoc(s.docId);
      const async = s.source.type === 'block' && sessionChanged(s) && doc?.bytes === s.bytes;
      const wasNew = s.source.type === 'new';
      void commitEdit();
      if (async) {
        void deferredClick(p);
        return;
      }
      const tool = useApp.getState().activeToolId;
      if (tool !== toolBefore) {
        // the new text box was placed and the tool went back to Edit: this click only ends typing
        if (wasNew) ui.setTarget(null);
        else void deferredClick(p);
        return;
      }
    }
    if (st.edit?.phase === 'committing' || ui.get().working || !modelCurrent) {
      void deferredClick(p);
      return;
    }
    const tool = useApp.getState().activeToolId;
    const doc = getDoc(docId);
    if (!doc) return;
    const its = pageItems(doc, page, pageIndex, model, tool);
    gesture(down, p, tool, its);
  };

  const onDoubleClick = (e: RMouseEvent) => {
    if ((e.target as Element).closest('[data-edit-pdf-keep]')) return;
    const p = toPdf(e.clientX, e.clientY);
    const it = hitAt(items, p);
    if (!it) return;
    e.preventDefault();
    if (toolId === TOOL_LINK) void editLinkProperties(it.target);
    else if (toolId === TOOL_CONTENT && isTextItem(it) && !ui.get().edit) void editTargetText(it.target);
  };

  const onContextMenu = (e: RMouseEvent) => {
    if ((e.target as Element).closest('[data-edit-pdf-keep]')) return;
    const p = toPdf(e.clientX, e.clientY);
    const it = hitAt(items, p);
    if (!it) return; // the viewer's page menu
    void commitEdit();
    ui.setTarget(it.target);
    showContextMenu(e, targetMenu(it.target));
  };

  // ── rendering ───────────────────────────────────────────────────────────

  const handleDown = (fn: (down: { clientX: number; clientY: number; pointerId: number }) => void) => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    fn({ clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId });
  };

  const showSelection = !!selected && !preview && !crop && !(session && inSession(selected, session));
  let selectionEl: ReactNode = null;
  if (showSelection && selected) {
    const c = ctxRef.current;
    if (selected.kind === 'block' || selected.kind === 'text-object') {
      const frame: Frame | null = selected.block ? selected.block.frame : selected.obj ? objectFrame(selected.obj as ContentTextObject) : null;
      const canResize = selected.kind === 'text-object' || !!selected.block?.textReliable;
      if (frame) {
        selectionEl = (
          <div className="edit-pdf-selframe" style={{ ...frameCss(frame, vp, zoom), width: frame.width * zoom, height: frame.height * zoom }} data-testid="edit-pdf-selection">
            {canResize &&
              (['w', 'e'] as const).map((side) => (
                <span
                  key={side}
                  className={`pdfwizard-handle pdfwizard-handle-${side} edit-pdf-width-handle`}
                  data-testid={`edit-pdf-handle-${side}`}
                  data-edit-pdf-keep=""
                  onPointerDown={handleDown((down) =>
                    selected.kind === 'block' ? reflowBlock(c, down, selected, side) : resizeTextObject(c, down, selected.obj as ContentTextObject, side),
                  )}
                />
              ))}
          </div>
        );
      }
    } else {
      const box = boxOfQuad(vp, selected.quad);
      const onHandle = (h: HandleId) =>
        handleDown((down) => {
          if (selected.kind === 'image') resizeBaseImage(c, down, selected, h);
          else if (selected.kind === 'link') dragBaseLink(c, down, selected, h);
          else if (selected.obj) resizeObject(c, down, selected.obj, h);
        });
      selectionEl = (
        <div className="edit-pdf-selbox" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} data-testid="edit-pdf-selection">
          {handlesFor(box).map((h) => (
            <span key={h} className={`pdfwizard-handle pdfwizard-handle-${h}`} data-handle={h} data-testid={`edit-pdf-handle-${h}`} data-edit-pdf-keep="" onPointerDown={onHandle(h)} />
          ))}
        </div>
      );
    }
  }

  let bar: { mode: BarMode; box: ViewBox } | null = null;
  if (session?.phase === 'editing') bar = { mode: { type: 'editing', style: session.style }, box: boxOfQuad(vp, frameQuad({ ...session.frame, height: layH })) };
  else if (crop) bar = { mode: { type: 'crop' }, box: rectToView(vp, crop.rect) };
  else if (showSelection && selected && !marquee) bar = { mode: { type: 'target', target: selected.target }, box: boxOfQuad(vp, selected.quad) };

  const placeBox =
    toolId === TOOL_IMAGE && pendingImage && mouse && !marquee
      ? (() => {
          const { w, h } = naturalSize(pendingImage, page);
          return rectToView(vp, placeRect(page, page.rotation, mouse, w, h));
        })()
      : null;

  const faint = showBoxes && toolId === TOOL_CONTENT;
  return (
    <div
      className={`edit-pdf-overlay is-${toolId}`}
      style={cursor ? { cursor } : undefined}
      data-testid="edit-pdf-overlay"
      data-page-index={pageIndex}
      data-model={needsModel ? (pm.model ? 'ready' : pm.error ? 'error' : 'loading') : 'none'}
      onPointerDown={onPointerDown}
      onMouseDown={onMouseDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <Ghosts docId={docId} pageIndex={pageIndex} vp={vp} zoom={zoom} />
      {session && <EditCover session={session} vp={vp} />}
      {preview && <PreviewLayer preview={preview} vp={vp} zoom={zoom} />}
      <svg className="edit-pdf-outlines" width={vp.width} height={vp.height}>
        {items.map((it) => {
          if (inSession(it, session)) return null;
          const active = matches(it, target);
          const cls = `edit-pdf-outline ${kindClass(it)}${hover === it.key ? ' is-hover' : ''}${active ? ' is-active' : ''}${faint ? ' is-faint' : ''}${preview && active ? ' is-moving' : ''}`;
          return (
            <polygon
              key={it.key}
              className={cls}
              points={quadPoints(vp, it.quad)}
              data-testid="edit-pdf-item"
              data-item-kind={it.kind}
              data-item-key={it.key}
              data-label={labelOf(it)}
            />
          );
        })}
      </svg>
      {session && <TextEditor session={session} vp={vp} zoom={zoom} />}
      {selectionEl}
      {crop && <CropFrame crop={crop} vp={vp} />}
      {marquee && <div className="pdfwizard-marquee edit-pdf-marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} data-testid="edit-pdf-marquee" />}
      {placeBox && pendingImage && (
        <img className="edit-pdf-place-preview edit-pdf-paint" src={pendingImage.dataUrl} alt="" draggable={false} style={{ left: placeBox.left, top: placeBox.top, width: placeBox.width, height: placeBox.height }} />
      )}
      {bar && <TargetBar mode={bar.mode} box={bar.box} />}
      {needsModel && pm.error && (
        <div className="edit-pdf-status is-error" data-testid="edit-pdf-status" data-edit-pdf-keep="">
          This page’s content can’t be edited: {pm.error}
        </div>
      )}
      {needsModel && !model && !pm.error && (
        <div className="edit-pdf-status" data-testid="edit-pdf-status" data-edit-pdf-keep="">
          Analyzing page…
        </div>
      )}
    </div>
  );
}
