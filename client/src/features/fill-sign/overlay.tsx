/**
 * Page overlay shared by every Fill & Sign tool.
 *
 *  - click → create (text / date / symbol / signature) at the click point
 *  - existing Fill & Sign items stay interactive while a fill tool is active: click to select
 *    (text: click to edit at the caret), drag to move, corner / edge handles to resize
 *  - form widgets stay fillable: the overlay lets the pointer through over AcroForm fields
 *    (except for signatures, which are commonly placed on signature lines / fields)
 *  - ghosts preview symbols, dates and signatures under the cursor
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import type { DocId, PageInfo, PageOverlayProps, Point, Rect, ViewBox } from '@/core/types';
import { actions, getDoc, getToolOptions, useApp, useDoc } from '@/core/store';
import { reg } from '@/core/registry';
import * as engine from '@/core/engine';
import { rectToView, viewToRect } from '@/core/geometry';
import { resizeBox } from '@/core/viewer/interaction';
import { viewerUi } from '@/core/viewer/viewerStore';
import { translatedPatch } from '@/core/viewer/clipboard';
import { openObjectContextMenu } from '@/core/viewer/contextMenus';
import { viewDeltaToPdf } from '@/core/viewer/viewport';
import { formatDate } from './date';
import { useFormInfo, type FormWidget } from './forms';
import { MarkGhost, createMark } from './marks';
import {
  FILL_MARK, FILL_TEXT, FONT_STACK, PAD_X, markDefaultSize, markKeepsAspect, signatureDefaultSize, textLayout, viewRotation,
  isFillObject, type FillObject, type FillTextObject, type SigRole,
} from './model';
import { DATE_DEFAULTS, DATE_OPTIONS_KEY, MARK_DEFAULTS, MARK_OPTIONS_KEY, MARK_TOOLS, SIG_TOOLS, TEXT_DEFAULTS, TEXT_OPTIONS_KEY, TOOL_DATE, TOOL_TEXT } from './options';
import { SigImage, createSignature } from './signature';
import { openSignatureManager } from './SignatureManager';
import { useFillSign } from './store';
import { caretAt, createFillText, removeIfEmpty, setPendingCaret } from './text';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw'];
const ALL: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const DRAG_THRESHOLD = 3;

function handlesFor(obj: FillObject, rotation: number): Handle[] {
  if (obj.kind === FILL_MARK) {
    if (obj.data.mark === 'line') return viewRotation(rotation, obj.data.rot) % 180 === 0 ? ['w', 'e'] : ['n', 's'];
    if (obj.data.mark === 'circle') return ALL;
  }
  return CORNERS;
}

function keepsAspect(obj: FillObject): boolean {
  if (obj.kind === FILL_MARK) return markKeepsAspect(obj.data.mark);
  return true;
}

const inBox = (b: ViewBox, x: number, y: number, pad = 0) =>
  x >= b.left - pad && x <= b.left + b.width + pad && y >= b.top - pad && y <= b.top + b.height + pad;
const inRect = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Topmost Fill & Sign item of the page under a point (CSS px relative to the page). */
function hitFill(docId: DocId, page: PageInfo, vp: PageOverlayProps['viewport'], x: number, y: number): FillObject | null {
  const d = getDoc(docId);
  if (!d) return null;
  for (let i = d.order.length - 1; i >= 0; i--) {
    const o = d.objects[d.order[i]];
    if (!o || o.pageId !== page.id || !isFillObject(o)) continue;
    if (inBox(rectToView(vp, o.rect), x, y, 2)) return o;
  }
  return null;
}

interface DragHandlers {
  move(dx: number, dy: number, ev: PointerEvent): void;
  end(cancelled: boolean, started: boolean): void;
}

/** Pointer drag relative to `root` (so scrolling during the drag keeps page coordinates right). */
function beginDrag(e: RPointerEvent, root: HTMLElement, h: DragHandlers, threshold = DRAG_THRESHOLD) {
  const r0 = root.getBoundingClientRect();
  const sx = e.clientX - r0.left;
  const sy = e.clientY - r0.top;
  const pid = e.pointerId;
  let started = false;
  let done = false;
  const ac = new AbortController();
  const opts = { signal: ac.signal };
  const finish = (cancelled: boolean) => {
    if (done) return;
    done = true;
    ac.abort();
    h.end(cancelled, started);
  };
  window.addEventListener(
    'pointermove',
    (ev) => {
      if (ev.pointerId !== pid) return;
      const r = root.getBoundingClientRect();
      const dx = ev.clientX - r.left - sx;
      const dy = ev.clientY - r.top - sy;
      if (!started && Math.hypot(dx, dy) < threshold) return;
      started = true;
      h.move(dx, dy, ev);
    },
    opts,
  );
  window.addEventListener('pointerup', (ev) => ev.pointerId === pid && finish(false), opts);
  window.addEventListener('pointercancel', (ev) => ev.pointerId === pid && finish(true), opts);
  window.addEventListener('blur', () => finish(true), opts);
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape' || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    },
    { signal: ac.signal, capture: true },
  );
}

/** Run `fn` once the pointer that pressed is released (or cancelled). */
function afterPointerUp(pointerId: number, fn: () => void) {
  const ac = new AbortController();
  const done = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    ac.abort();
    fn();
  };
  window.addEventListener('pointerup', done, { signal: ac.signal });
  window.addEventListener('pointercancel', done, { signal: ac.signal });
}

function readOnlyToast(docId: DocId): boolean {
  if (!engine.isReadOnly(docId)) return false;
  actions.toast('This document is read-only, so text and signatures can’t be added to it.', { kind: 'warning' });
  return true;
}

function focusScroller(root: HTMLElement) {
  const s = root.closest<HTMLElement>('.pdfwizard-scroller');
  if (s && document.activeElement !== s) s.focus({ preventScroll: true });
}

/** Choose the signature to place: pending one, else open the manager. */
async function ensurePending(role: SigRole): Promise<boolean> {
  if (useFillSign.getState().pending[role]) return true;
  const s = await openSignatureManager(role);
  return !!s;
}

export function FillOverlay({ docId, page, pageIndex, viewport, scale, rotation, toPdf }: PageOverlayProps) {
  const toolId = useApp((s) => s.activeToolId);
  const rootRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);

  const markKind = MARK_TOOLS[toolId];
  const sigRole = SIG_TOOLS[toolId];
  const isText = toolId === TOOL_TEXT;
  const isDate = toolId === TOOL_DATE;

  const selected = useDoc(docId, (d) => {
    if (!d || d.selection.length !== 1) return null;
    const o = d.objects[d.selection[0]];
    return o && o.pageId === page.id && isFillObject(o) && d.editingId !== o.id ? o : null;
  });
  const editing = useDoc(docId, (d) => {
    const o = d?.editingId ? d.objects[d.editingId] : undefined;
    return o && o.pageId === page.id && o.kind === FILL_TEXT ? (o as FillTextObject) : null;
  });
  const pending = useFillSign((s) => (sigRole ? s.pending[sigRole] : null));
  const markColor = useApp((s) => (s.toolOptions[MARK_OPTIONS_KEY]?.color as string | undefined) ?? MARK_DEFAULTS.color);
  const textOpts = useApp((s) => s.toolOptions[TEXT_OPTIONS_KEY]);
  const dateFormat = useApp((s) => (s.toolOptions[DATE_OPTIONS_KEY]?.format as string | undefined) ?? DATE_DEFAULTS.format);

  // Form widgets of this page (pointer passes through to them, except for signatures).
  const info = useFormInfo(docId);
  const widgets = useMemo<FormWidget[]>(() => info?.widgets.filter((w) => w.pageIndex === pageIndex) ?? [], [info, pageIndex]);

  const live = useRef({ viewport, toPdf, widgets, sigRole, busy });
  live.current = { viewport, toPdf, widgets, sigRole, busy };

  useEffect(() => {
    const root = rootRef.current;
    const pageEl = root?.closest<HTMLElement>('.pdfwizard-page');
    if (!root || !pageEl) return;
    const onMove = (ev: PointerEvent) => {
      const l = live.current;
      if (l.busy) return;
      let pass = false;
      if (!l.sigRole && l.widgets.length) {
        const p = l.toPdf(ev.clientX, ev.clientY);
        if (l.widgets.some((w) => inRect(w.rect, p))) {
          const r = root.getBoundingClientRect();
          pass = !hitFill(docId, page, l.viewport, ev.clientX - r.left, ev.clientY - r.top);
        }
      }
      const want = pass ? 'none' : '';
      if (root.style.pointerEvents !== want) root.style.pointerEvents = want;
      if (pass) setGhost(null);
    };
    const onLeave = () => {
      root.style.pointerEvents = '';
    };
    pageEl.addEventListener('pointermove', onMove);
    pageEl.addEventListener('pointerleave', onLeave);
    return () => {
      pageEl.removeEventListener('pointermove', onMove);
      pageEl.removeEventListener('pointerleave', onLeave);
      root.style.pointerEvents = '';
    };
  }, [docId, page]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ── move / resize sessions ───────────────────────────────────────────────

  const startMove = (e: RPointerEvent, obj: FillObject, onClick: () => void) => {
    const root = rootRef.current!;
    const vp = viewport;
    const b0 = rectToView(vp, obj.rect);
    const W = vp.width;
    const H = vp.height;
    let checkpointed = false;
    beginDrag(e, root, {
      move(dx, dy) {
        if (obj.locked) return;
        if (!checkpointed) {
          checkpointed = true;
          actions.checkpoint(docId, 'Move');
          viewerUi.set({ interaction: 'move' });
          setBusy(true);
          setGhost(null);
        }
        const cdx = Math.min(Math.max(0, W - (b0.left + b0.width)), Math.max(Math.min(0, -b0.left), dx));
        const cdy = Math.min(Math.max(0, H - (b0.top + b0.height)), Math.max(Math.min(0, -b0.top), dy));
        const d = viewDeltaToPdf(vp, cdx, cdy);
        actions.updateObject(docId, obj.id, translatedPatch(obj, d.x, d.y), { checkpoint: false });
      },
      end(cancelled) {
        if (!checkpointed) {
          if (!cancelled) onClick();
          return;
        }
        viewerUi.set({ interaction: null });
        setBusy(false);
        if (cancelled) actions.updateObject(docId, obj.id, { rect: obj.rect, data: obj.data }, { checkpoint: false });
      },
    });
  };

  const startResize = (e: RPointerEvent, obj: FillObject, handle: Handle) => {
    const root = rootRef.current!;
    const vp = viewport;
    const type = reg.objectType(obj.kind);
    const b0 = rectToView(vp, obj.rect);
    const swap = rotation % 180 !== 0;
    const min = type?.minSize ?? { width: 2, height: 2 };
    const minW = Math.max(2, (swap ? min.height : min.width) * vp.scale);
    const minH = Math.max(2, (swap ? min.width : min.height) * vp.scale);
    const keepAspect = keepsAspect(obj);
    let checkpointed = false;
    beginDrag(
      e,
      root,
      {
        move(dx, dy) {
          if (!checkpointed) {
            checkpointed = true;
            actions.checkpoint(docId, 'Resize');
            viewerUi.set({ interaction: 'resize' });
            setBusy(true);
            setGhost(null);
          }
          const box = resizeBox(b0, handle, dx, dy, { minW, minH, maxW: vp.width, maxH: vp.height, keepAspect });
          const rect = viewToRect(vp, box);
          const extra = type?.resize ? type.resize(obj, rect) : {};
          actions.updateObject(docId, obj.id, { rect, ...extra }, { checkpoint: false });
        },
        end(cancelled) {
          if (!checkpointed) return;
          viewerUi.set({ interaction: null });
          setBusy(false);
          if (cancelled) actions.updateObject(docId, obj.id, { rect: obj.rect, data: obj.data }, { checkpoint: false });
        },
      },
      1,
    );
  };

  // ── pointer handlers ─────────────────────────────────────────────────────

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || viewerUi.get().spacePan) return;
    const root = rootRef.current;
    const doc = getDoc(docId);
    if (!root || !doc) return;
    e.preventDefault();
    if (useApp.getState().activeDocId !== docId) actions.setActiveDoc(docId);
    focusScroller(root);

    // Finish the text being edited (an empty one disappears without leaving an undo step).
    const prevEditing = doc.editingId;
    if (prevEditing) {
      actions.setEditing(docId, null);
      removeIfEmpty(docId, prevEditing);
    }

    const target = e.target as HTMLElement;
    const handleEl = target.closest<HTMLElement>('[data-fill-handle]');
    if (handleEl) {
      const obj = getDoc(docId)?.objects[handleEl.dataset.objId ?? ''];
      if (isFillObject(obj) && !obj.locked) startResize(e, obj, handleEl.dataset.fillHandle as Handle);
      return;
    }

    const { x, y } = local(e);
    const p = toPdf(e.clientX, e.clientY);

    if (!sigRole) {
      const hit = hitFill(docId, page, viewport, x, y);
      if (hit) {
        actions.setSelection(docId, [hit.id]);
        startMove(e, hit, () => {
          if (hit.kind === FILL_TEXT && (isText || isDate) && !hit.locked) {
            setPendingCaret(hit.id, caretAt(hit as FillTextObject, p));
            actions.setEditing(docId, hit.id);
          }
        });
        return;
      }
    }

    if (readOnlyToast(docId)) return;

    if (isText) {
      const o = { ...TEXT_DEFAULTS, ...(textOpts ?? {}) } as typeof TEXT_DEFAULTS;
      const obj = createFillText(docId, page, p, { fontSize: o.fontSize, letterSpacing: 0, rot: rotation }, { color: o.color, select: true, label: 'Add text' });
      afterPointerUp(e.pointerId, () => {
        if (getDoc(docId)?.objects[obj.id]) actions.setEditing(docId, obj.id);
      });
      return;
    }
    if (isDate) {
      const o = { ...TEXT_DEFAULTS, ...(textOpts ?? {}) } as typeof TEXT_DEFAULTS;
      const fmt = getToolOptions(DATE_OPTIONS_KEY, DATE_DEFAULTS).format;
      createFillText(docId, page, p, { fontSize: o.fontSize, letterSpacing: 0, rot: rotation, text: formatDate(new Date(), fmt) }, { color: o.color, select: true, label: 'Add date' });
      return;
    }
    if (markKind) {
      createMark(docId, page, p, markKind, rotation, markColor);
      return;
    }
    if (sigRole) {
      const sig = useFillSign.getState().pending[sigRole];
      if (!sig) {
        void ensurePending(sigRole);
        return;
      }
      createSignature(docId, page, p, sig, rotation);
      setGhost(null);
      // Switch back to the select tool only after this press: the viewer's own pointerdown
      // handler runs next and would treat it as a click on the empty page (clearing the selection).
      afterPointerUp(e.pointerId, () => actions.toolDone());
    }
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (busy || e.buttons) return;
    const { x, y } = local(e);
    const overHandle = !!(e.target as HTMLElement).closest('[data-fill-handle]');
    const over = !sigRole && !overHandle && !!hitFill(docId, page, viewport, x, y);
    if (over !== hover) setHover(over);
    if (over || overHandle || isText) {
      if (ghost) setGhost(null);
      return;
    }
    setGhost({ x, y });
  };

  const onPointerLeave = () => {
    setGhost(null);
    setHover(false);
  };

  const onContextMenu = (e: RMouseEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const hit = hitFill(docId, page, viewport, x, y);
    if (!hit) return; // the viewer shows the page menu
    e.preventDefault();
    e.stopPropagation();
    const d = getDoc(docId);
    if (d && !(d.selection.length === 1 && d.selection[0] === hit.id)) actions.setSelection(docId, [hit.id]);
    openObjectContextMenu(e, docId, [hit.id], pageIndex, toPdf(e.clientX, e.clientY));
  };

  const onDoubleClick = (e: RMouseEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const hit = hitFill(docId, page, viewport, x, y);
    if (hit && hit.kind === FILL_TEXT && !hit.locked) {
      e.stopPropagation();
      setPendingCaret(hit.id, caretAt(hit as FillTextObject, toPdf(e.clientX, e.clientY)));
      actions.setEditing(docId, hit.id);
    }
  };

  // ── rendering ────────────────────────────────────────────────────────────

  const style: CSSProperties = {};
  if (hover) style.cursor = 'move';
  if (editing) {
    // Let clicks reach the text being edited.
    const b = rectToView(viewport, editing.rect);
    const m = editing.data.fontSize * scale + 6;
    const l = Math.max(0, b.left - m);
    const t = Math.max(0, b.top - m);
    const r = Math.min(viewport.width, b.left + b.width + m);
    const bt = Math.min(viewport.height, b.top + b.height + m);
    style.clipPath = `path(evenodd, "M0 0 H${viewport.width} V${viewport.height} H0 Z M${l} ${t} H${r} V${bt} H${l} Z")`;
  }

  let ghostEl: ReactNode = null;
  if (ghost && !busy) {
    if (markKind) {
      const { w, h } = markDefaultSize(markKind, page);
      ghostEl = (
        <div className="fill-sign-ghost" style={{ left: ghost.x - (w * scale) / 2, top: ghost.y - (h * scale) / 2 }}>
          <MarkGhost mark={markKind} w={w} h={h} scale={scale} color={markColor} />
        </div>
      );
    } else if (sigRole && pending) {
      const { w, h } = signatureDefaultSize(sigRole, pending.aspect, page, rotation);
      ghostEl = (
        <div className="fill-sign-ghost fill-sign-ghost-sig" style={{ left: ghost.x - (w * scale) / 2, top: ghost.y - (h * scale) / 2, width: w * scale, height: h * scale }}>
          <SigImage src={pending.src} recolorable={pending.recolorable} color={pending.color} className="fill-sign-sig-fill" />
        </div>
      );
    } else if (isDate) {
      const o = { ...TEXT_DEFAULTS, ...(textOpts ?? {}) } as typeof TEXT_DEFAULTS;
      const text = formatDate(new Date(), dateFormat as typeof DATE_DEFAULTS.format);
      const lh = textLayout({ text, fontSize: o.fontSize, letterSpacing: 0 }).lh * scale;
      ghostEl = (
        <div
          className="fill-sign-ghost fill-sign-ghost-date"
          style={{ left: ghost.x - PAD_X * scale, top: ghost.y - lh / 2, fontFamily: FONT_STACK, fontSize: o.fontSize * scale, lineHeight: `${lh}px`, color: o.color }}
        >
          {text}
        </div>
      );
    }
  }

  let handles: ReactNode = null;
  if (selected && !selected.locked && !busy) {
    const b = rectToView(viewport, selected.rect);
    handles = (
      <div className="fill-sign-frame" style={{ left: b.left, top: b.top, width: b.width, height: b.height }}>
        {handlesFor(selected, rotation).map((h) => (
          <div
            key={h}
            className={`fill-sign-handle fill-sign-handle-${h}`}
            data-fill-handle={h}
            data-obj-id={selected.id}
            data-testid={`fill-sign-handle-${h}`}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`fill-sign-overlay${sigRole ? ' is-sign' : ''}`}
      data-testid="fill-sign-overlay"
      data-page-index={pageIndex}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      {handles}
      {ghostEl}
    </div>
  );
}

