/**
 * Pointer gestures of the Edit PDF page overlay: move / resize / reflow of base content (with a
 * pixel preview that stays until the page re-renders), move / resize of added objects (live, one
 * undo step), text selection while starting the editor, new text boxes, image placement and link
 * rectangles.
 */
import { actions, getDoc, newObject, useApp } from '@/core/store';
import { reg } from '@/core/registry';
import type { DocId, PageInfo, PageViewport, PdfObject, Point, Rect, Rotation, ViewBox } from '@/core/types';
import { rectToView, translateRect, viewToRect } from '@/core/geometry';
import { resizeBox } from '@/core/viewer/interaction';
import { viewDeltaToPdf } from '@/core/viewer/viewport';
import type { HandleId } from '@/core/viewer/PageView';
import { frameQuad, type Frame, type TextBlock } from '../content/blocks';
import { replaceBlock } from '../content/ops';
import { applyLinear, translate } from '../content/matrix';
import { caretOffsetAt } from '../caret';
import {
  boundsTransform, convertBaseLink, createLink, libFontLoader, moveTextBlock, readOnlyNotice, resolveBlockId, runEdit, transformTarget,
} from '../edits';
import { rectPoly, type Item } from '../hit';
import { KIND_IMAGE, TOOL_CONTENT, TOOL_IMAGE, type ContentImageObject, type ContentTextObject } from '../model';
import { pageCanvas, pageElement, paperColor, snapshot } from '../pagedom';
import { startBlockEdit, startNewText, startObjectEdit } from '../sessions';
import { coverQuad, ui, type Target } from '../state';
import { boxFrame, layoutTextBox, objectFrame } from '../textbox';
import { openLinkDialog } from '../ui/LinkDialog';
import type { LoadedImage } from '../images';
import { boxOfQuad, frameRect, uprightAxes, uprightImageMatrix, viewMatrix } from '../viewmath';
import type { LivePreview } from './Ghosts';
import { trackPointer } from './drag';

export interface GestureCtx {
  docId: DocId;
  pageIndex: number;
  page: PageInfo;
  vp: PageViewport;
  zoom: number;
  toPdf(clientX: number, clientY: number): Point;
  setPreview(p: LivePreview | null): void;
  setMarquee(b: ViewBox | null): void;
}

type Down = { clientX: number; clientY: number; pointerId: number };

const pad2 = (b: ViewBox, d: number): ViewBox => ({ left: b.left - d, top: b.top - d, width: b.width + 2 * d, height: b.height + 2 * d });
const coverPadOf = (b: TextBlock) => Math.max(0.5, b.style.size * 0.12);

/** Local (client px) offset → user-space delta. */
const userDelta = (c: GestureCtx, dx: number, dy: number) => viewDeltaToPdf(c.vp, dx, dy);

/** Keeps the preview on screen after a successful edit until the page shows the result. */
async function withGhost(c: GestureCtx, preview: LivePreview, canvas: Element | null, run: () => Promise<boolean>): Promise<boolean> {
  const id = ui.addGhost({ docId: c.docId, pageIndex: c.pageIndex, cover: preview.cover, snap: preview.snap ?? undefined, text: preview.text ?? undefined, paper: preview.paper });
  c.setPreview(null);
  const ok = await run();
  if (ok) ui.patchGhost(id, { settleFrom: canvas });
  else ui.removeGhost(id);
  return ok;
}

// ── base content: move ───────────────────────────────────────────────────────

/** Drag a base text block or image by its border / body. */
export function moveBaseItem(c: GestureCtx, down: Down, it: Item): void {
  const t = it.target;
  ui.setTarget(t);
  if (readOnlyNotice(c.docId)) return;
  const quad = it.kind === 'block' && it.block ? frameQuad(it.block.frame) : it.quad;
  const cover = it.kind === 'block' && it.block ? [coverQuad(it.block.frame, coverPadOf(it.block))] : [it.quad];
  const box = pad2(boxOfQuad(c.vp, quad), 2);
  const from = viewToRect(c.vp, box);
  const canvas = pageCanvas(c.pageIndex);
  let url: string | null = null;
  let paper = '#ffffff';
  let last: LivePreview | null = null;
  trackPointer(down, {
    cursor: 'move',
    onStart() {
      url = snapshot(c.pageIndex, box);
      paper = paperColor(c.pageIndex, box);
    },
    onMove(_ev, dx, dy) {
      const d = userDelta(c, dx, dy);
      last = { cover, paper, snap: url ? { url, to: translateRect(from, d.x, d.y) } : null, box: { ...box, left: box.left + dx, top: box.top + dy } };
      c.setPreview(last);
    },
    onEnd(_ev, moved) {
      if (!moved || !last) return;
      const preview: LivePreview = { ...last, box: null };
      const b = last.box!;
      const d = userDelta(c, b.left - box.left, b.top - box.top);
      void withGhost(c, preview, canvas, () =>
        t.type === 'block' ? moveTextBlock(t, d.x, d.y) : transformTarget(t, translate(d.x, d.y), 'Move image'),
      );
    },
    onCancel() {
      c.setPreview(null);
    },
  });
}

// ── base images: resize ──────────────────────────────────────────────────────

export function resizeBaseImage(c: GestureCtx, down: Down, it: Item, handle: HandleId): void {
  const t = it.target;
  const im = it.image;
  if (!im || readOnlyNotice(c.docId)) return;
  const b0 = rectToView(c.vp, im.bounds);
  const src = pad2(b0, 0);
  const canvas = pageCanvas(c.pageIndex);
  let url: string | null = null;
  let paper = '#ffffff';
  let nb = b0;
  trackPointer(down, {
    threshold: 1,
    cursor: `${handleCursor(handle)}`,
    onStart() {
      url = snapshot(c.pageIndex, src);
      paper = paperColor(c.pageIndex, b0);
    },
    onMove(ev, dx, dy) {
      nb = resizeBox(b0, handle, dx, dy, { minW: 6, minH: 6, maxW: c.vp.width, maxH: c.vp.height, keepAspect: ev.shiftKey });
      c.setPreview({ cover: [it.quad], paper, snap: url ? { url, to: viewToRect(c.vp, nb) } : null, box: nb });
    },
    onEnd(_ev, moved) {
      if (!moved) return;
      const to = viewToRect(c.vp, nb);
      const m = boundsTransform(im.bounds, to);
      void withGhost(c, { cover: [it.quad], paper, snap: url ? { url, to } : null }, canvas, () => transformTarget(t, m, 'Resize image'));
    },
    onCancel() {
      c.setPreview(null);
    },
  });
}

export function handleCursor(h: HandleId): string {
  return h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize';
}

// ── base text: reflow ────────────────────────────────────────────────────────

/** Width drag on a selected base text block: the paragraph is rewritten with the new wrap width. */
export function reflowBlock(c: GestureCtx, down: Down, it: Item, side: 'e' | 'w'): void {
  const block = it.block;
  const t = it.target;
  if (!block || t.type !== 'block' || readOnlyNotice(c.docId)) return;
  if (!block.textReliable) {
    actions.toast('This text uses a font without character information, so it can’t be reflowed.', { kind: 'warning' });
    return;
  }
  const f0 = block.frame;
  const [ux, uy] = applyLinear(viewMatrix(c.vp), f0.u[0], f0.u[1]);
  const len = Math.hypot(ux, uy) || 1;
  const box = boxOfQuad(c.vp, frameQuad(f0));
  const canvas = pageCanvas(c.pageIndex);
  const cover = [coverQuad(f0, coverPadOf(block))];
  let paper = '#ffffff';
  let frame: Frame = f0;
  trackPointer(down, {
    threshold: 1,
    cursor: 'ew-resize',
    onStart() {
      paper = paperColor(c.pageIndex, box);
    },
    onMove(_ev, dx, dy) {
      const along = (dx * ux + dy * uy) / len / (c.zoom || 1);
      const width = Math.max(12, side === 'e' ? f0.width + along : f0.width - along);
      const shift = side === 'w' ? f0.width - width : 0;
      frame = { ...f0, width, origin: [f0.origin[0] + f0.u[0] * shift, f0.origin[1] + f0.u[1] * shift] };
      c.setPreview({ cover, paper, text: { text: block.text, style: block.style, frame, firstBaseline: block.firstBaseline, autoWidth: false } });
    },
    onEnd(_ev, moved) {
      if (!moved || Math.abs(frame.width - f0.width) < 0.5) {
        c.setPreview(null);
        return;
      }
      const target = frame;
      const lay = layoutTextBox(block.text, block.style, target.width, false);
      const text = { text: block.text, style: block.style, frame: target, firstBaseline: block.firstBaseline, autoWidth: false };
      void withGhost(c, { cover, paper, text }, canvas, async () => {
        const ok = await runEdit(c.docId, 'Resize text box', async (lib) => {
          const id = resolveBlockId(lib, c.pageIndex, block.id, block.text, block.bounds);
          await replaceBlock(lib, c.pageIndex, id, block.text, { text: block.text, style: block.style, frame: target, firstBaseline: block.firstBaseline, wrap: true }, libFontLoader(lib));
        });
        if (ok) ui.setReselect({ type: 'block', docId: c.docId, pageIndex: c.pageIndex, text: block.text, bounds: frameRect({ ...target, height: lay.height }) });
        return ok;
      });
    },
    onCancel() {
      c.setPreview(null);
    },
  });
}

// ── added objects: move / resize (live, one undo step) ──────────────────────

function liveObjectDrag(c: GestureCtx, down: Down, obj: PdfObject, label: string, cursor: string, patchFor: (o0: PdfObject, dx: number, dy: number, ev: PointerEvent) => Partial<PdfObject> | null) {
  if (readOnlyNotice(c.docId)) return;
  const o0 = obj;
  let started = false;
  trackPointer(down, {
    threshold: 2,
    cursor,
    onStart() {
      started = true;
      actions.checkpoint(c.docId, label);
    },
    onMove(ev, dx, dy) {
      const p = patchFor(o0, dx, dy, ev);
      if (p) actions.updateObject(c.docId, o0.id, p, { checkpoint: false });
    },
    onCancel() {
      if (started) actions.updateObject(c.docId, o0.id, { rect: o0.rect, data: o0.data }, { checkpoint: false });
    },
  });
}

export function moveObject(c: GestureCtx, down: Down, obj: PdfObject): void {
  const type = reg.objectType(obj.kind);
  const label = obj.kind === KIND_IMAGE ? 'Move image' : obj.kind === 'link' ? 'Move link' : 'Move text';
  liveObjectDrag(c, down, obj, label, 'move', (o0, dx, dy) => {
    const d = userDelta(c, dx, dy);
    return type?.translate ? type.translate(o0, d.x, d.y) : { rect: translateRect(o0.rect, d.x, d.y) };
  });
}

/** 8-handle resize of an image / link object (images keep their aspect unless Shift is held). */
export function resizeObject(c: GestureCtx, down: Down, obj: PdfObject, handle: HandleId): void {
  const type = reg.objectType(obj.kind);
  const b0 = rectToView(c.vp, obj.rect);
  const keep = !!type?.keepAspectRatio;
  const min = type?.minSize ?? { width: 4, height: 4 };
  liveObjectDrag(c, down, obj, obj.kind === KIND_IMAGE ? 'Resize image' : 'Resize link', handleCursor(handle), (o0, dx, dy, ev) => {
    const nb = resizeBox(b0, handle, dx, dy, { minW: min.width * c.zoom, minH: min.height * c.zoom, maxW: c.vp.width, maxH: c.vp.height, keepAspect: keep !== ev.shiftKey });
    const rect = viewToRect(c.vp, nb);
    return type?.resize ? type.resize(o0, rect) : { rect };
  });
}

/** Width drag of an added text box (the text reflows). */
export function resizeTextObject(c: GestureCtx, down: Down, obj: ContentTextObject, side: 'e' | 'w'): void {
  const type = reg.objectType(obj.kind);
  const f0 = objectFrame(obj);
  const [ux, uy] = applyLinear(viewMatrix(c.vp), f0.u[0], f0.u[1]);
  const len = Math.hypot(ux, uy) || 1;
  liveObjectDrag(c, down, obj, 'Resize text box', 'ew-resize', (o0, dx, dy) => {
    const along = (dx * ux + dy * uy) / len / (c.zoom || 1);
    const width = Math.max(12, side === 'e' ? f0.width + along : f0.width - along);
    const shift = side === 'w' ? f0.width - width : 0;
    const frame: Frame = { ...f0, width, origin: [f0.origin[0] + f0.u[0] * shift, f0.origin[1] + f0.u[1] * shift] };
    const rect = frameRect(frame);
    return type?.resize ? type.resize(o0, rect) : { rect };
  });
}

// ── text editing with drag selection ─────────────────────────────────────────

/** Starts the editor on a text item with the caret at `p`; dragging selects text. */
export function editTextAt(c: GestureCtx, down: Down, it: Item, p: Point): boolean {
  let ok = false;
  if (it.kind === 'block' && it.block) {
    const box = boxOfQuad(c.vp, frameQuad(it.block.frame));
    ok = startBlockEdit(c.docId, c.pageIndex, it.block, p, paperColor(c.pageIndex, box));
  } else if (it.kind === 'text-object' && it.obj) {
    ok = startObjectEdit(c.docId, c.pageIndex, it.obj as ContentTextObject, p);
  }
  if (!ok) return false;
  const nonce = ui.get().edit?.nonce;
  const s0 = ui.get().edit;
  if (!s0) return true;
  const anchor = caretOffsetAt(s0, p);
  trackPointer(down, {
    threshold: 3,
    cursor: 'text',
    onMove(ev) {
      const s = ui.get().edit;
      if (!s || s.nonce !== nonce) return;
      const ta = pageElement(c.pageIndex)?.querySelector<HTMLTextAreaElement>('textarea.edit-pdf-textarea');
      if (!ta) return;
      const f = caretOffsetAt(s, c.toPdf(ev.clientX, ev.clientY));
      ta.setSelectionRange(Math.min(anchor, f), Math.max(anchor, f), f < anchor ? 'backward' : 'forward');
    },
    onEnd() {
      ui.focusEditor();
    },
  });
  return true;
}

// ── new text ─────────────────────────────────────────────────────────────────

/** Add text: click for a growing box, drag horizontally for a wrapping box of that width. */
export function newTextGesture(c: GestureCtx, down: Down, p0: Point): void {
  if (readOnlyNotice(c.docId)) return;
  const rot = c.page.rotation;
  const { u, d } = uprightAxes(rot);
  let box: { width: number; top: Point } | null = null;
  trackPointer(down, {
    threshold: 5,
    cursor: 'crosshair',
    onMove(ev) {
      const p = c.toPdf(ev.clientX, ev.clientY);
      const du = (p.x - p0.x) * u[0] + (p.y - p0.y) * u[1];
      const dd = (p.x - p0.x) * d[0] + (p.y - p0.y) * d[1];
      const width = Math.abs(du);
      const top = { x: p0.x + u[0] * Math.min(0, du) + d[0] * Math.min(0, dd), y: p0.y + u[1] * Math.min(0, du) + d[1] * Math.min(0, dd) };
      box = { width, top };
      const f = boxFrame([top.x, top.y], rot, Math.max(1, width), Math.max(1, Math.abs(dd)));
      c.setMarquee(boxOfQuad(c.vp, frameQuad(f)));
    },
    onEnd(_ev, moved) {
      c.setMarquee(null);
      if (moved && box && box.width * c.zoom >= 12) startNewText(c.docId, c.pageIndex, p0, rot, box.width, box.top);
      else startNewText(c.docId, c.pageIndex, p0, rot, null);
    },
    onCancel() {
      c.setMarquee(null);
    },
  });
}

// ── add image ────────────────────────────────────────────────────────────────

/** Natural size (1 px = 0.75 pt), fitted into 90 % of the page. */
export function naturalSize(img: Pick<LoadedImage, 'width' | 'height'>, page: PageInfo): { w: number; h: number } {
  const upright = page.rotation === 90 || page.rotation === 270;
  const pw = (upright ? page.height : page.width) * 0.9;
  const ph = (upright ? page.width : page.height) * 0.9;
  let w = img.width * 0.75;
  let h = img.height * 0.75;
  const s = Math.min(1, pw / w, ph / h);
  w *= s;
  h *= s;
  return { w, h };
}

/** Rect of an upright box with top-left `top` and size (w, h) along the page's reading axes, kept on the page. */
export function placeRect(page: PageInfo, rot: Rotation, top: Point, w: number, h: number): Rect {
  const r = frameRect(boxFrame([top.x, top.y], rot, w, h));
  const [x0, y0, x1, y1] = page.view;
  const x = Math.max(x0, Math.min(x1 - r.width, r.x));
  const y = Math.max(y0, Math.min(y1 - r.height, r.y));
  return { x, y, width: r.width, height: r.height };
}

export function placeImage(docId: DocId, pageIndex: number, img: LoadedImage, rect: Rect): void {
  const doc = getDoc(docId);
  const page = doc?.pages[pageIndex];
  if (!doc || !page || readOnlyNotice(docId)) return;
  const obj = newObject<ContentImageObject>({
    kind: KIND_IMAGE,
    pageId: page.id,
    rect,
    data: { src: img.dataUrl, mime: img.mime, pxWidth: img.width, pxHeight: img.height, matrix: uprightImageMatrix(rect, page.rotation), clip: [0, 0, 1, 1] },
  });
  actions.addObject(docId, obj, { label: 'Add image' });
  const app = useApp.getState();
  if (app.activeToolId === TOOL_IMAGE && !app.toolLocked) {
    ui.setPendingImage(null);
    actions.setTool(TOOL_CONTENT);
  }
  ui.setTarget({ type: 'object', docId, pageIndex, id: obj.id });
}

/** Add image: click places at natural size, a drag fits the image into the rectangle. */
export function placeImageGesture(c: GestureCtx, down: Down, p0: Point, img: LoadedImage): void {
  if (readOnlyNotice(c.docId)) return;
  const rot = c.page.rotation;
  const v0 = rectToView(c.vp, { x: p0.x, y: p0.y, width: 0, height: 0 });
  let box: ViewBox | null = null;
  trackPointer(down, {
    threshold: 5,
    cursor: 'crosshair',
    onMove(_ev, dx, dy) {
      box = { left: Math.min(v0.left, v0.left + dx), top: Math.min(v0.top, v0.top + dy), width: Math.abs(dx), height: Math.abs(dy) };
      // fit the image aspect inside the dragged box, anchored at the start corner
      const ar = viewAspect(img, rot);
      let w = box.width;
      let h = w / ar;
      if (h > box.height) {
        h = box.height;
        w = h * ar;
      }
      box = { left: dx < 0 ? v0.left - w : v0.left, top: dy < 0 ? v0.top - h : v0.top, width: w, height: h };
      c.setMarquee(box);
    },
    onEnd(_ev, moved) {
      c.setMarquee(null);
      if (moved && box && box.width >= 4 && box.height >= 4) {
        placeImage(c.docId, c.pageIndex, img, viewToRect(c.vp, box));
        return;
      }
      const { w, h } = naturalSize(img, c.page);
      placeImage(c.docId, c.pageIndex, img, placeRect(c.page, rot, p0, w, h));
    },
    onCancel() {
      c.setMarquee(null);
    },
  });
}

/** Width / height of the placed image as seen on screen with the page's own rotation. */
function viewAspect(img: Pick<LoadedImage, 'width' | 'height'>, _rot: Rotation): number {
  return img.width / img.height;
}

// ── links ────────────────────────────────────────────────────────────────────

/** Draw a rectangle on the page, then fill in the Create Link dialog. */
export function newLinkGesture(c: GestureCtx, down: Down): void {
  if (readOnlyNotice(c.docId)) return;
  const origin = c.toPdf(down.clientX, down.clientY);
  const v0 = rectToView(c.vp, { x: origin.x, y: origin.y, width: 0, height: 0 });
  let box: ViewBox | null = null;
  trackPointer(down, {
    threshold: 4,
    cursor: 'crosshair',
    onStart() {
      ui.setTarget(null);
    },
    onMove(_ev, dx, dy) {
      const l = Math.max(0, Math.min(v0.left, v0.left + dx));
      const t = Math.max(0, Math.min(v0.top, v0.top + dy));
      const r = Math.min(c.vp.width, Math.max(v0.left, v0.left + dx));
      const b = Math.min(c.vp.height, Math.max(v0.top, v0.top + dy));
      box = { left: l, top: t, width: r - l, height: b - t };
      c.setMarquee(box);
    },
    onEnd(_ev, moved) {
      if (!moved || !box || box.width < 6 || box.height < 6) {
        c.setMarquee(null);
        if (!moved) ui.setTarget(null);
        return;
      }
      const rect = viewToRect(c.vp, box);
      void openLinkDialog({ docId: c.docId, pageIndex: c.pageIndex, mode: 'create' }).then((data) => {
        c.setMarquee(null);
        if (data) createLink(c.docId, c.pageIndex, rect, data);
      });
    },
    onCancel() {
      c.setMarquee(null);
    },
  });
}

/** Move / resize of a link annotation from the file: previewed, then converted to a link object. */
export function dragBaseLink(c: GestureCtx, down: Down, it: Item, handle: HandleId | 'move'): void {
  const t = it.target;
  const link = it.link;
  if (!link || t.type !== 'link' || readOnlyNotice(c.docId)) return;
  ui.setTarget(t);
  const b0 = rectToView(c.vp, link.rect);
  let nb = b0;
  trackPointer(down, {
    threshold: handle === 'move' ? 3 : 1,
    cursor: handle === 'move' ? 'move' : handleCursor(handle),
    onMove(_ev, dx, dy) {
      nb =
        handle === 'move'
          ? { ...b0, left: b0.left + dx, top: b0.top + dy }
          : resizeBox(b0, handle, dx, dy, { minW: 4, minH: 4, maxW: c.vp.width, maxH: c.vp.height, keepAspect: false });
      c.setPreview({ cover: [], paper: 'transparent', box: nb });
    },
    onEnd(_ev, moved) {
      c.setPreview(null);
      if (!moved) return;
      void convertBaseLink(t, { rect: viewToRect(c.vp, nb) }, handle === 'move' ? 'Move link' : 'Resize link');
    },
    onCancel() {
      c.setPreview(null);
    },
  });
}

export const isBaseTarget = (t: Target) => t.type === 'block' || t.type === 'image' || t.type === 'link';
export { rectPoly };
