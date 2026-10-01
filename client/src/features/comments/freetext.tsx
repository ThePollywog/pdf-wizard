/**
 * Text boxes and callouts (PDF /FreeText, /IT /FreeTextCallout). Text is edited in place; the box
 * grows with the text. Callouts: the box and the arrow's anchor move independently, dragging the
 * leader line moves both.
 */
import { useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { Type } from 'lucide-react';
import type { DocId, ObjectRenderProps, ObjectTypeDef, PageInfo, Point, Rect, Rotation } from '@/core/types';
import { actions, getDoc, getToolOptions, newObject, useApp, useDoc } from '@/core/store';
import { mapPoint, rectToView, viewToRect } from '@/core/geometry';
import { useViewerUi } from '@/core/viewer/viewerStore';
import { arrowHead, calloutBounds, calloutLeader, CSS_FONT, frameAt, frameSizeOf, layoutFreeText, MIN_BOX } from './layout';
import { borderOf, relayoutFreeText, withCalloutBox } from './freetextLayout';
import { exportFreeText } from './pdfExport';
import { BorderChip, FontControls, OpacityChip, Swatch } from './bars';
import { commentContextItems } from './menus';
import { addNewObject, isFresh } from './ops';
import { fmt, svgPolyline } from './render';
import { beginPdfDrag } from './drag';
import { screenAngle } from './note';
import {
  CALLOUT_DEFAULTS, canAnnotate, normRotation, TEXTBOX_DEFAULTS, TOOL, type Callout, type FreeTextData, type FreeTextObject,
} from './model';

type BoxHandle = 'nw' | 'ne' | 'se' | 'sw' | 'e' | 'w';
const BOX_HANDLES: BoxHandle[] = ['nw', 'ne', 'se', 'sw', 'e', 'w'];

function pageOf(docId: DocId, pageId: string): PageInfo | undefined {
  return getDoc(docId)?.pages.find((p) => p.id === pageId);
}

function current(docId: DocId, id: string): FreeTextObject | undefined {
  const o = getDoc(docId)?.objects[id];
  return o && o.kind === 'freetext' ? (o as FreeTextObject) : undefined;
}

function FreeTextRender({ obj, docId, page, viewport, scale, rotation, box, toLocal, selected, editing, setEditing }: ObjectRenderProps<FreeTextObject>) {
  const d = obj.data;
  const c = d.callout;
  const textBox = c ? c.box : obj.rect;
  const sw = borderOf(obj);
  const { w: fw, h: fh } = frameSizeOf(textBox, d.rotate);
  const L = useMemo(() => layoutFreeText(d, sw, fw), [d, sw, fw]);
  const s = scale;
  const theta = screenAngle(rotation, d.rotate);
  const vb = rectToView(viewport, textBox);
  const cx = vb.left - box.left + vb.width / 2;
  const cy = vb.top - box.top + vb.height / 2;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const single = useDoc(docId, (x) => (x?.selection.length ?? 0) === 1);
  const toolId = useApp((st) => st.activeToolId);
  const moving = useViewerUi((st) => st.interaction === 'move');
  const showHandles = !!c && selected && single && !editing && !obj.locked && toolId === 'select' && !moving;

  useLayoutEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, [editing]);

  const onInput = (text: string) => {
    const cur = current(docId, obj.id);
    if (!cur) return;
    const r = relayoutFreeText(cur, { text }, pageOf(docId, cur.pageId));
    // Typing into a box that was just added belongs to its "Add text box" step.
    const checkpoint = !isFresh(docId, obj.id);
    actions.updateObject(docId, obj.id, { ...r, contents: text }, { coalesce: `comments-type-${obj.id}`, label: 'Edit text', checkpoint });
  };
  const onKeyDown = (e: RKeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      setEditing(false);
    }
  };

  const frameStyle: CSSProperties = {
    left: cx - (fw * s) / 2,
    top: cy - (fh * s) / 2,
    width: fw * s,
    height: fh * s,
    transform: theta ? `rotate(${theta}deg)` : undefined,
    opacity: obj.opacity ?? 1,
    background: obj.fillColor ?? undefined,
  };
  const font: CSSProperties = {
    fontFamily: CSS_FONT[L.font],
    fontSize: L.fontSize * s,
    lineHeight: `${L.lineHeight * s}px`,
    color: d.textColor,
  };

  // Callout box drag (the box only; the leader re-attaches). Plain boxes use the viewer's move.
  const onBoxPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!c || editing || e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
    if (useApp.getState().activeToolId !== 'select') return;
    e.stopPropagation();
    const doc = getDoc(docId);
    if (!doc) return;
    if (doc.editingId && doc.editingId !== obj.id) actions.setEditing(docId, null);
    if (doc.selection.length !== 1 || doc.selection[0] !== obj.id) actions.setSelection(docId, [obj.id]);
    document.getSelection()?.removeAllRanges();
    if (obj.locked) return;
    e.preventDefault();
    const orig = obj;
    const oc = orig.data.callout!;
    beginPdfDrag(e, {
      docId,
      objectId: obj.id,
      viewport,
      label: 'Move callout box',
      onMove: (dl) => {
        const nb = clampRect({ ...oc.box, x: oc.box.x + dl.x, y: oc.box.y + dl.y }, page);
        actions.updateObject(docId, obj.id, withCalloutBox(orig, nb), { checkpoint: false });
      },
    });
  };

  const onAnchorPointerDown = (e: RPointerEvent<SVGElement>) => {
    if (!c || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const orig = obj;
    const oc = orig.data.callout!;
    const a0 = oc.points[0];
    beginPdfDrag(e, {
      docId,
      objectId: obj.id,
      viewport,
      label: 'Move callout arrow',
      onMove: (dl) => {
        const a = clampPoint({ x: a0.x + dl.x, y: a0.y + dl.y }, page);
        const callout: Callout = { box: oc.box, points: calloutLeader(oc.box, a) };
        actions.updateObject(docId, obj.id, { data: { ...orig.data, callout }, rect: calloutBounds(callout, orig.strokeWidth ?? 1) }, { checkpoint: false });
      },
    });
  };

  const onHandlePointerDown = (h: BoxHandle) => (e: RPointerEvent<HTMLDivElement>) => {
    if (!c || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const orig = obj;
    const b0 = rectToView(viewport, orig.data.callout!.box);
    const minPx = MIN_BOX * s;
    beginPdfDrag(e, {
      docId,
      objectId: obj.id,
      viewport,
      label: 'Resize callout box',
      interaction: 'resize',
      onMove: (_dl, _cur, v) => {
        let { left, top, width, height } = b0;
        if (h.includes('w')) {
          const nl = Math.min(left + v.dx, left + width - minPx);
          width += left - nl;
          left = nl;
        }
        if (h.includes('e')) width = Math.max(minPx, width + v.dx);
        if (h === 'nw' || h === 'ne') {
          const nt = Math.min(top + v.dy, top + height - minPx);
          height += top - nt;
          top = nt;
        }
        if (h === 'sw' || h === 'se') height = Math.max(minPx, height + v.dy);
        const nb = viewToRect(viewport, { left, top, width, height });
        const { h: frameH } = frameSizeOf(nb, orig.data.rotate);
        const moved: FreeTextObject = { ...orig, data: { ...orig.data, callout: { ...orig.data.callout!, box: nb } } };
        const r = relayoutFreeText(moved, { autoWidth: false, minHeight: h === 'e' || h === 'w' ? orig.data.minHeight : frameH }, page);
        actions.updateObject(docId, obj.id, r, { checkpoint: false });
      },
    });
  };

  const leader = c && c.points.length >= 2 && obj.color ? c.points : null;
  const lw = Math.max(0.5, obj.strokeWidth ?? 1) * s;
  const head = leader && (d.lineEnding ?? 'OpenArrow') !== 'None' ? arrowHead(leader[0], leader[1], Math.max(6, (obj.strokeWidth ?? 1) * 4)) : null;
  const anchorPt = c ? toLocal(c.points[0]) : null;
  const handleBox = { left: vb.left - box.left, top: vb.top - box.top, width: vb.width, height: vb.height };

  return (
    <div
      className={`comments-freetext${c ? ' comments-callout' : ''}${editing ? ' is-editing' : ''}`}
      data-testid={c ? 'comments-callout' : 'comments-textbox'}
    >
      {c && selected && (
        <style>{`.pdfwizard-handle[data-obj-id="${obj.id}"]{display:none}.pdfwizard-frame[data-frame-for="${obj.id}"]{box-shadow:none}`}</style>
      )}
      {c && (
        <svg className="comments-callout-svg" width="100%" height="100%" style={{ opacity: obj.opacity ?? 1 }}>
          {leader && (
            <>
              <path className="comments-callout-hit" d={svgPolyline(leader.map(toLocal))} />
              <path d={svgPolyline(leader.map(toLocal))} stroke={obj.color} strokeWidth={lw} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {head && <path d={svgPolyline([head[0], leader[0], head[1]].map(toLocal))} stroke={obj.color} strokeWidth={lw} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
            </>
          )}
          {showHandles && anchorPt && (
            <circle
              className="comments-anchor-handle"
              data-viewer-passthrough
              data-testid="comments-callout-anchor"
              cx={fmt(anchorPt.x)}
              cy={fmt(anchorPt.y)}
              r={5}
              onPointerDown={onAnchorPointerDown}
            />
          )}
        </svg>
      )}
      <div
        className="comments-ft-frame"
        style={frameStyle}
        onPointerDown={c ? onBoxPointerDown : undefined}
        data-testid={c ? 'comments-callout-box' : undefined}
      >
        {sw > 0 && obj.color && <div className="comments-ft-border" style={{ borderWidth: sw * s, borderColor: obj.color }} />}
        <div className="comments-ft-clip" style={{ inset: sw * s }}>
          {editing ? (
            <textarea
              ref={taRef}
              className="comments-ft-input"
              data-testid="comments-textbox-input"
              aria-label={c ? 'Callout text' : 'Text box text'}
              spellCheck
              value={d.text}
              onChange={(e) => onInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                ...font,
                left: (L.pad.x - sw) * s,
                top: (L.pad.y - sw) * s,
                width: Math.max(4, (fw - 2 * L.pad.x) * s + 1),
                height: Math.max(L.lineHeight * s, (fh - 2 * L.pad.y) * s),
                textAlign: d.align,
              }}
            />
          ) : (
            L.lines.map((l, i) => (
              <div key={i} className="comments-ft-line" style={{ ...font, left: (l.x - sw) * s, top: (l.top - sw) * s, height: L.lineHeight * s }}>
                {l.text}
              </div>
            ))
          )}
        </div>
        {!editing && !d.text && <div className="comments-ft-placeholder" style={font} />}
      </div>
      {c && selected && <div className="comments-callout-frame" style={{ ...handleBox }} />}
      {showHandles &&
        BOX_HANDLES.map((h) => (
          <div
            key={h}
            className={`comments-box-handle is-${h}`}
            data-viewer-passthrough
            data-testid={`comments-callout-handle-${h}`}
            style={{ left: handleBox.left + (h.includes('e') ? handleBox.width : h.includes('w') ? 0 : handleBox.width / 2), top: handleBox.top + (h === 'e' || h === 'w' ? handleBox.height / 2 : h.startsWith('n') ? 0 : handleBox.height) }}
            onPointerDown={onHandlePointerDown(h)}
          />
        ))}
    </div>
  );
}

function clampRect(r: Rect, page: PageInfo): Rect {
  const [x0, y0, x1, y1] = page.view;
  return {
    ...r,
    x: Math.min(Math.max(r.x, x0), Math.max(x0, x1 - r.width)),
    y: Math.min(Math.max(r.y, y0), Math.max(y0, y1 - r.height)),
  };
}
function clampPoint(p: Point, page: PageInfo): Point {
  const [x0, y0, x1, y1] = page.view;
  return { x: Math.min(Math.max(p.x, x0), x1), y: Math.min(Math.max(p.y, y0), y1) };
}

// ── properties bar ──────────────────────────────────────────────────────────

function FreeTextBar({ obj, docId, update }: { obj: FreeTextObject; docId: DocId; update(p: Partial<FreeTextObject>, o?: { label?: string }): void }) {
  const d = obj.data;
  const page = pageOf(docId, obj.pageId);
  const relayout = (patch: Partial<FreeTextData>, objPatch: Partial<Pick<FreeTextObject, 'color' | 'strokeWidth'>> = {}, label = 'Format text') => {
    const cur = current(docId, obj.id) ?? obj;
    update({ ...objPatch, ...relayoutFreeText(cur, patch, page, objPatch) }, { label });
  };
  return (
    <>
      <FontControls prefix="comments-bar" font={d.font} fontSize={d.fontSize} align={d.align} onChange={(p) => relayout(p)} />
      <Swatch testid="comments-bar-text-color" label="Text color" value={d.textColor} onChange={(v) => v && update({ data: { ...d, textColor: v } }, { label: 'Change text color' })} />
      <Swatch
        testid="comments-bar-border-color"
        label={d.callout ? 'Line color' : 'Border color'}
        value={obj.color ?? null}
        allowNone={!d.callout}
        onChange={(v) => relayout({}, { color: v ?? undefined }, 'Change border color')}
      />
      <BorderChip testid="comments-bar-border-width" value={obj.strokeWidth ?? 0} onChange={(v) => relayout({}, { strokeWidth: v }, 'Change border width')} />
      <Swatch testid="comments-bar-fill" label="Fill color" value={obj.fillColor ?? null} allowNone onChange={(v) => update({ fillColor: v }, { label: 'Change fill color' })} />
      <OpacityChip testid="comments-bar-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v }, { label: 'Change opacity' })} />
    </>
  );
}

// ── type ────────────────────────────────────────────────────────────────────

export const freeTextType: ObjectTypeDef<FreeTextObject> = {
  kind: 'freetext',
  label: 'Text box',
  icon: Type,
  category: 'comment',
  Render: FreeTextRender,
  hit: 'box',
  resizable: true,
  minSize: { width: MIN_BOX, height: MIN_BOX },
  translate: (o, dx, dy) => {
    const rect = { ...o.rect, x: o.rect.x + dx, y: o.rect.y + dy };
    const c = o.data.callout;
    if (!c) return { rect };
    const callout: Callout = { box: { ...c.box, x: c.box.x + dx, y: c.box.y + dy }, points: c.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    return { rect, data: { ...o.data, callout } };
  },
  resize: (o, rect) => {
    const c = o.data.callout;
    if (c) {
      const box = mapRect(c.box, o.rect, rect);
      const callout: Callout = { box, points: c.points.map((p) => mapPoint(p, o.rect, rect)) };
      const { h } = frameSizeOf(box, o.data.rotate);
      const moved: FreeTextObject = { ...o, data: { ...o.data, callout } };
      return relayoutFreeText(moved, { autoWidth: false, minHeight: h }, undefined);
    }
    const { h } = frameSizeOf(rect, o.data.rotate);
    return relayoutFreeText({ ...o, rect }, { autoWidth: false, minHeight: h }, undefined);
  },
  editable: true,
  summary: (o) => o.data.text,
  PropertiesBar: FreeTextBar,
  contextMenu: (o, docId) => commentContextItems(o, docId),
  exportToPdf: (o, ctx) => exportFreeText(o, ctx),
};

function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const a = mapPoint({ x: r.x, y: r.y }, from, to);
  const b = mapPoint({ x: r.x + r.width, y: r.y + r.height }, from, to);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(MIN_BOX, Math.abs(b.x - a.x)), height: Math.max(MIN_BOX, Math.abs(b.y - a.y)) };
}

// ── creation ────────────────────────────────────────────────────────────────

export type TextBoxOptions = typeof TEXTBOX_DEFAULTS;

export function textBoxOptions(toolId: string): TextBoxOptions {
  return getToolOptions(toolId, toolId === TOOL.callout ? CALLOUT_DEFAULTS : TEXTBOX_DEFAULTS);
}

function baseFreeText(page: PageInfo, opts: TextBoxOptions, callout: boolean): Omit<FreeTextObject, 'id' | 'author' | 'createdAt' | 'modifiedAt' | 'rect'> {
  const rotate = normRotation(page.rotation);
  return {
    kind: 'freetext',
    pageId: page.id,
    color: opts.borderColor ?? (callout ? opts.textColor : undefined),
    strokeWidth: opts.borderWidth,
    fillColor: opts.fillColor,
    opacity: opts.opacity,
    data: {
      text: '',
      font: opts.font,
      fontSize: opts.fontSize,
      textColor: opts.textColor,
      align: opts.align,
      intent: callout ? 'FreeTextCallout' : 'FreeText',
      rotate: rotate || undefined,
      autoWidth: true,
      lineEnding: callout ? 'OpenArrow' : undefined,
    },
  };
}

/**
 * New text box whose visual top-left is at `at` (click) or filling `rect` (drag). Enters editing.
 */
export function createTextBox(docId: DocId, page: PageInfo, place: { at: Point } | { rect: Rect }): FreeTextObject | null {
  if (!canAnnotate(docId)) return null;
  const opts = textBoxOptions(TOOL.textbox);
  const base = baseFreeText(page, opts, false);
  const rot = base.data.rotate as Rotation | undefined;
  const sw = base.color ? base.strokeWidth ?? 0 : 0;
  let rect: Rect;
  let data = base.data;
  if ('rect' in place) {
    const { w, h } = frameSizeOf(place.rect, rot);
    data = { ...data, autoWidth: false, minHeight: h };
    const L = layoutFreeText(data, sw, w, { minH: h });
    rect = frameAt(topLeftOf(place.rect, rot), rot, L.fw, L.fh);
  } else {
    const L = layoutFreeText(data, sw, null);
    rect = clampRect(frameAt(place.at, rot, L.fw, L.fh), page);
  }
  const o = newObject<FreeTextObject>({ ...base, data, rect });
  addNewObject(docId, o, { select: true, edit: true, label: 'Add text box' });
  return o;
}

/** Visual top-left corner (as a user-space point) of a frame rotated by `rot`. */
export function topLeftOf(r: Rect, rot: Rotation | undefined): Point {
  switch (rot) {
    case 90:
      return { x: r.x, y: r.y };
    case 180:
      return { x: r.x + r.width, y: r.y };
    case 270:
      return { x: r.x + r.width, y: r.y + r.height };
    default:
      return { x: r.x, y: r.y + r.height };
  }
}

const CALLOUT_WIDTH = 120;

/** New callout pointing at `anchor` with its box's visual top-left at `boxAt`. Enters editing. */
export function createCallout(docId: DocId, page: PageInfo, anchor: Point, boxAt: Point): FreeTextObject | null {
  if (!canAnnotate(docId)) return null;
  const opts = textBoxOptions(TOOL.callout);
  const base = baseFreeText(page, opts, true);
  const rot = base.data.rotate as Rotation | undefined;
  const sw = base.color ? base.strokeWidth ?? 0 : 0;
  const data: FreeTextData = { ...base.data, autoWidth: false };
  const L = layoutFreeText(data, sw, CALLOUT_WIDTH);
  const box = clampRect(frameAt(boxAt, rot, L.fw, L.fh), page);
  const callout: Callout = { box, points: calloutLeader(box, anchor) };
  const o = newObject<FreeTextObject>({
    ...base,
    data: { ...data, callout },
    rect: calloutBounds(callout, base.strokeWidth ?? 1),
  });
  addNewObject(docId, o, { select: true, edit: true, label: 'Add callout' });
  return o;
}
