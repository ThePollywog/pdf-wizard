/**
 * Comment tools: page overlays (click / drag to create) and their tool options bars.
 *
 *  comment-note          click → sticky note, the pop-up note opens for typing
 *  comment-highlight     select text → highlight; drag over a non-text area → area highlight
 *  comment-underline / -strikeout / -squiggly   select text
 *  comment-insert-text   click in text → caret at that position; or select text → caret after it
 *  comment-replace-text  select text → strikethrough + caret, the note holds the replacement
 *  comment-textbox       click (auto-width box) or drag (fixed-width box), typed in place
 *  comment-callout       press at the arrow's anchor, release where the box goes
 *  comment-attach        click, then pick a file
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react';
import { Highlighter, MessageSquarePlus, Paperclip, Replace, Strikethrough, Underline } from 'lucide-react';
import type { PageInfo, PageOverlayProps, Point, Rect, TextSelectionInfo, ToolDef } from '@/core/types';
import { actions, getDoc, useApp, useToolOptions } from '@/core/store';
import { pickFiles } from '@/core/util';
import { viewerUi } from '@/core/viewer/viewerStore';
import { rectToView } from '@/core/geometry';
import { AttachIconSvg, CalloutIcon, CaretIcon, NoteIconSvg, SquigglyIcon, TextBoxIcon } from './icons';
import { BorderChip, ChipDropdown, FontControls, OpacityChip, Swatch } from './bars';
import { createNote } from './note';
import { createAreaHighlight, createMarkups } from './markup';
import { createCaret, createCaretAfterSelection, createReplace } from './caret';
import { createCallout, createTextBox, textBoxOptions } from './freetext';
import { createAttachment } from './attachment';
import { layoutFreeText } from './layout';
import { directionsFor, quadFromRect, quadList } from './quads';
import {
  ATTACH_DEFAULTS, ATTACH_ICONS, CALLOUT_DEFAULTS, canAnnotate, CARET_DEFAULTS, MARKUP_DEFAULTS, NOTE_DEFAULTS, NOTE_ICONS, normRotation,
  TEXTBOX_DEFAULTS, TOOL, type FontFamily, type MarkupType, type TextAlign, type TextDir,
} from './model';

const DRAG_PX = 4;

function clampToPage(p: Point, page: PageInfo): Point {
  const [x0, y0, x1, y1] = page.view;
  return { x: Math.min(Math.max(p.x, x0), x1), y: Math.min(Math.max(p.y, y0), y1) };
}

function rectOf(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

// ── click / drag overlay (note, text box, callout, attach) ─────────────────

type CreateMode = 'note' | 'textbox' | 'callout' | 'attach';

interface DragState {
  a: Point;
  b: Point;
}

function CreateOverlay({ mode, ...p }: PageOverlayProps & { mode: CreateMode }) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || viewerUi.get().spacePan) return;
    e.preventDefault();
    if (!canAnnotate(p.docId)) return;
    const el = e.currentTarget as HTMLElement;
    const pid = e.pointerId;
    try {
      el.setPointerCapture(pid);
    } catch {
      /* not capturable (synthetic) */
    }
    const sx = e.clientX;
    const sy = e.clientY;
    const a = clampToPage(p.toPdf(sx, sy), p.page);
    let b = a;
    let moved = false;
    const draggable = mode === 'textbox' || mode === 'callout';
    const ac = new AbortController();
    const end = (cancelled: boolean) => {
      ac.abort();
      cleanup.current = null;
      setDrag(null);
      try {
        el.releasePointerCapture(pid);
      } catch {
        /* already released */
      }
      if (!cancelled) finish(moved, a, b, sx, sy);
    };
    cleanup.current = () => {
      ac.abort();
      cleanup.current = null;
    };
    const opts = { signal: ac.signal };
    el.addEventListener(
      'pointermove',
      (ev) => {
        if (ev.pointerId !== pid || !draggable) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_PX) return;
        moved = true;
        b = clampToPage(p.toPdf(ev.clientX, ev.clientY), p.page);
        setDrag({ a, b });
      },
      opts,
    );
    el.addEventListener('pointerup', (ev) => ev.pointerId === pid && end(false), opts);
    el.addEventListener('pointercancel', (ev) => ev.pointerId === pid && end(true), opts);
    window.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        end(true);
      },
      { signal: ac.signal, capture: true },
    );
  };

  const finish = (moved: boolean, a: Point, b: Point, sx: number, sy: number) => {
    const { docId, page } = p;
    if (!getDoc(docId)) return;
    switch (mode) {
      case 'note':
        if (createNote(docId, page, a)) actions.toolDone();
        return;
      case 'attach':
        void pickFiles({}).then(async (files) => {
          const f = files[0];
          if (!f) return;
          const o = await createAttachment(docId, page, a, f);
          if (o && useApp.getState().activeToolId === TOOL.attach) actions.toolDone();
        });
        return;
      case 'textbox': {
        const r = rectOf(a, b);
        const tiny = r.width * p.scale < 12 || r.height * p.scale < 8;
        if (createTextBox(docId, page, moved && !tiny ? { rect: r } : { at: a })) actions.toolDone();
        return;
      }
      case 'callout': {
        const boxAt = moved ? calloutBoxAt(p, a, b) : calloutBoxAt(p, a, clampToPage(p.toPdf(sx + 48, sy - 72), page));
        if (createCallout(docId, page, a, boxAt)) actions.toolDone();
        return;
      }
    }
  };

  let preview: ReactNode = null;
  if (drag && mode === 'textbox') {
    const v = rectToView(p.viewport, rectOf(drag.a, drag.b));
    preview = <div className="comments-drag-rect" style={{ left: v.left, top: v.top, width: v.width, height: v.height }} />;
  } else if (drag && mode === 'callout') {
    const A = p.toView(drag.a);
    const B = p.toView(drag.b);
    preview = (
      <svg className="comments-drag-svg" width="100%" height="100%">
        <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} />
        <circle cx={A.x} cy={A.y} r={3} />
      </svg>
    );
  }
  return (
    <div className="comments-create-overlay" data-testid={`comments-overlay-${mode}`} onPointerDown={onPointerDown}>
      {preview}
    </div>
  );
}

/**
 * Visual top-left of a callout box released at `b` (screen space): the box extends away from the
 * anchor, so dragging to the left / upwards puts the release point at the box's near corner.
 */
function calloutBoxAt(p: PageOverlayProps, anchor: Point, b: Point): Point {
  const o = textBoxOptions(TOOL.callout);
  const sw = o.borderColor ? o.borderWidth : 0;
  const L = layoutFreeText(
    { text: '', font: o.font, fontSize: o.fontSize, align: o.align },
    sw,
    120,
  );
  const A = p.toView(anchor);
  const B = p.toView(b);
  const left = B.x < A.x ? B.x - L.fw * p.scale : B.x;
  const top = B.y < A.y ? B.y - L.fh * p.scale : B.y;
  const r = (p.viewport as { convertToPdfPoint(x: number, y: number): number[] }).convertToPdfPoint(left, top);
  return clampToPage({ x: r[0], y: r[1] }, p.page);
}

const NoteOverlay = (p: PageOverlayProps) => <CreateOverlay {...p} mode="note" />;
const TextBoxOverlay = (p: PageOverlayProps) => <CreateOverlay {...p} mode="textbox" />;
const CalloutOverlay = (p: PageOverlayProps) => <CreateOverlay {...p} mode="callout" />;
const AttachOverlay = (p: PageOverlayProps) => <CreateOverlay {...p} mode="attach" />;

// ── passthrough overlays (text selection tools) ────────────────────────────

/** Text-layer glyph spans (not the layer itself, its gaps or the end-of-content helper). */
function isTextTarget(t: Element): boolean {
  const layer = t.closest('.textLayer');
  if (!layer || t === layer) return false;
  if (t.classList.contains('endOfContent')) return false;
  return t.tagName === 'SPAN' || t.tagName === 'BR';
}

function ignoredTarget(t: Element): boolean {
  return !!t.closest('[data-viewer-passthrough], .annotationLayer section, .annotationLayer a, input, textarea, select, button, [contenteditable="true"]');
}

/** Finds the `.pdfwizard-page` the overlay is rendered into. */
function usePageElement(): [RefObject<HTMLSpanElement | null>, HTMLElement | null] {
  const probe = useRef<HTMLSpanElement>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(probe.current?.closest<HTMLElement>('.pdfwizard-page') ?? null);
  }, []);
  return [probe, el];
}

/** Highlight tool: a drag that starts off the text draws an area highlight. */
function HighlightOverlay(p: PageOverlayProps) {
  const [probe, pageEl] = usePageElement();
  const [box, setBox] = useState<Rect | null>(null);
  const pr = useRef(p);
  pr.current = p;

  useEffect(() => {
    if (!pageEl) return;
    const ac = new AbortController();
    let drag: AbortController | null = null;
    let suppressMouse = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === 'touch' || viewerUi.get().spacePan) return;
      const t = e.target instanceof Element ? e.target : null;
      if (!t || isTextTarget(t) || ignoredTarget(t)) return;
      e.preventDefault();
      e.stopPropagation();
      suppressMouse = true;
      const P = pr.current;
      document.getSelection()?.removeAllRanges();
      const d = getDoc(P.docId);
      if (d?.editingId) actions.setEditing(P.docId, null);
      if (d?.selection.length) actions.setSelection(P.docId, []);
      if (useApp.getState().activeDocId !== P.docId) actions.setActiveDoc(P.docId);
      const pid = e.pointerId;
      const sx = e.clientX;
      const sy = e.clientY;
      const a = clampToPage(P.toPdf(sx, sy), P.page);
      let b = a;
      let moved = false;
      drag?.abort();
      const dac = new AbortController();
      drag = dac;
      const end = (cancelled: boolean) => {
        dac.abort();
        if (drag === dac) drag = null;
        setBox(null);
        const r = rectOf(a, b);
        const s = pr.current.scale;
        if (!cancelled && moved && r.width * s > 3 && r.height * s > 3) createAreaHighlight(pr.current.docId, pr.current.page.id, r);
      };
      const o = { signal: dac.signal, capture: true };
      window.addEventListener(
        'pointermove',
        (ev) => {
          if (ev.pointerId !== pid) return;
          if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
          moved = true;
          ev.preventDefault();
          b = clampToPage(pr.current.toPdf(ev.clientX, ev.clientY), pr.current.page);
          setBox(rectOf(a, b));
        },
        o,
      );
      window.addEventListener('pointerup', (ev) => ev.pointerId === pid && end(false), o);
      window.addEventListener('pointercancel', (ev) => ev.pointerId === pid && end(true), o);
      window.addEventListener(
        'keydown',
        (ev) => {
          if (ev.key !== 'Escape') return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          end(true);
        },
        o,
      );
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!suppressMouse) return;
      suppressMouse = false;
      e.preventDefault();
    };
    pageEl.addEventListener('pointerdown', onDown, { capture: true, signal: ac.signal });
    pageEl.addEventListener('mousedown', onMouseDown, { capture: true, signal: ac.signal });
    return () => {
      ac.abort();
      drag?.abort();
    };
  }, [pageEl]);

  const v = box ? rectToView(p.viewport, box) : null;
  return (
    <>
      <span ref={probe} hidden />
      {v && <div className="comments-drag-rect is-highlight" style={{ left: v.left, top: v.top, width: v.width, height: v.height }} />}
    </>
  );
}

let lastTextSelected = 0;

/** Where a click in the text layer lands: the gap before (or after) the character under it. */
async function caretFromClick(p: PageOverlayProps, pageEl: HTMLElement, x: number, y: number): Promise<{ at: Point; height: number; dir: TextDir } | null> {
  type CaretPos = { offsetNode: Node; offset: number };
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): CaretPos | null; caretRangeFromPoint?(x: number, y: number): Range | null };
  let pos: CaretPos | null = null;
  if (doc.caretPositionFromPoint) pos = doc.caretPositionFromPoint(x, y);
  else if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) pos = { offsetNode: r.startContainer, offset: r.startOffset };
  }
  const node = pos?.offsetNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !pageEl.contains(node) || !node.parentElement?.closest('.textLayer')) return null;
  const text = (node as Text).data;
  if (!text.length) return null;
  const after = pos!.offset >= text.length;
  const i = after ? text.length - 1 : Math.max(0, pos!.offset);
  const range = document.createRange();
  range.setStart(node, i);
  range.setEnd(node, i + 1);
  const cr = range.getBoundingClientRect();
  if (cr.width <= 0 && cr.height <= 0) return null;
  const pts = [p.toPdf(cr.left, cr.top), p.toPdf(cr.right, cr.top), p.toPdf(cr.left, cr.bottom), p.toPdf(cr.right, cr.bottom)];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const rect = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  const [dir] = await directionsFor(p.docId, p.pageIndex, [rect]);
  const [q] = quadList(quadFromRect(rect, dir));
  const [tl, , bl, br] = q;
  const height = Math.hypot(tl.x - bl.x, tl.y - bl.y);
  return { at: after ? br : bl, height, dir };
}

/** Insert text tool: a plain click in text drops a caret there. */
function InsertTextOverlay(p: PageOverlayProps) {
  const [probe, pageEl] = usePageElement();
  const pr = useRef(p);
  pr.current = p;
  useEffect(() => {
    if (!pageEl) return;
    const ac = new AbortController();
    let timer = 0;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target instanceof Element ? e.target : null;
      if (!t || ignoredTarget(t)) return;
      window.clearTimeout(timer);
      if (e.detail !== 1) return; // double / triple click selects a word / line instead
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (Date.now() - lastTextSelected < 350) return;
      const x = e.clientX;
      const y = e.clientY;
      // Wait out a possible double click (which selects the word and puts the caret after it).
      timer = window.setTimeout(async () => {
        const P = pr.current;
        if (useApp.getState().activeToolId !== TOOL.insert || Date.now() - lastTextSelected < 400) return;
        const s2 = document.getSelection();
        if (s2 && !s2.isCollapsed) return;
        const hit = await caretFromClick(P, pageEl, x, y);
        const at = hit?.at ?? clampToPage(P.toPdf(x, y), P.page);
        const o = createCaret(P.docId, P.page.id, at, hit?.height ?? 12, hit?.dir ?? (normRotation(P.page.rotation) as TextDir));
        if (o) actions.toolDone();
      }, 260);
    };
    pageEl.addEventListener('click', onClick, { signal: ac.signal });
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [pageEl]);
  return <span ref={probe} hidden />;
}

let lastHint = 0;
/** Replace text tool: explain what to do when the user clicks without selecting text. */
function ReplaceTextOverlay(p: PageOverlayProps) {
  const [probe, pageEl] = usePageElement();
  useEffect(() => {
    if (!pageEl) return;
    const ac = new AbortController();
    pageEl.addEventListener(
      'click',
      (e) => {
        if (e.button !== 0 || e.detail !== 1) return;
        const t = e.target instanceof Element ? e.target : null;
        if (!t || ignoredTarget(t)) return;
        window.setTimeout(() => {
          const sel = document.getSelection();
          if ((sel && !sel.isCollapsed) || Date.now() - lastTextSelected < 400 || Date.now() - lastHint < 4000) return;
          if (useApp.getState().activeToolId !== TOOL.replace) return;
          lastHint = Date.now();
          actions.toast('Select the text you want to replace.', { kind: 'info' });
        }, 300);
      },
      { signal: ac.signal },
    );
    return () => ac.abort();
  }, [pageEl, p.docId]);
  return <span ref={probe} hidden />;
}

// ── options bars ───────────────────────────────────────────────────────────

function Hint({ children }: { children: ReactNode }) {
  return <span className="comments-options-hint">{children}</span>;
}

function NoteOptions() {
  const o = useToolOptions(TOOL.note, NOTE_DEFAULTS);
  const set = (k: string, v: unknown) => actions.setToolOption(TOOL.note, k, v);
  return (
    <div className="comments-options" data-testid="comments-options-note">
      <Swatch testid="comments-opt-color" label="Color" value={o.color} onChange={(c) => c && set('color', c)} />
      <ChipDropdown
        testid="comments-opt-icon"
        label="Icon"
        items={NOTE_ICONS.map((ic) => ({
          id: `comments-opt-icon-${ic.value}`,
          label: ic.label,
          checked: o.icon === ic.value,
          icon: ({ size = 16 }) => <NoteIconSvg icon={ic.value} color={o.color} width={size} height={size} />,
          run: () => set('icon', ic.value),
        }))}
      >
        <NoteIconSvg icon={o.icon} color={o.color} width={18} height={18} />
      </ChipDropdown>
      <OpacityChip testid="comments-opt-opacity" value={o.opacity} onChange={(v) => set('opacity', v)} />
      <Hint>Click where you want to add a comment.</Hint>
    </div>
  );
}

const MARKUP_HINT: Record<MarkupType, string> = {
  highlight: 'Select text to highlight it, or drag over an area.',
  underline: 'Select text to underline it.',
  strikeout: 'Select text to strike it through.',
  squiggly: 'Select text to add a squiggly underline.',
};

function markupOptionsBar(type: MarkupType) {
  const toolId = `comment-${type}`;
  return function MarkupOptions() {
    const o = useToolOptions(toolId, MARKUP_DEFAULTS[type]);
    return (
      <div className="comments-options" data-testid={`comments-options-${type}`}>
        <Swatch testid="comments-opt-color" label="Color" value={o.color} onChange={(c) => c && actions.setToolOption(toolId, 'color', c)} />
        <OpacityChip testid="comments-opt-opacity" value={o.opacity} onChange={(v) => actions.setToolOption(toolId, 'opacity', v)} />
        <Hint>{MARKUP_HINT[type]}</Hint>
      </div>
    );
  };
}

function caretOptionsBar(toolId: string, hint: string) {
  return function CaretOptions() {
    const o = useToolOptions(toolId, CARET_DEFAULTS);
    return (
      <div className="comments-options" data-testid={`comments-options-${toolId === TOOL.insert ? 'insert' : 'replace'}`}>
        <Swatch testid="comments-opt-color" label="Color" value={o.color} onChange={(c) => c && actions.setToolOption(toolId, 'color', c)} />
        <Hint>{hint}</Hint>
      </div>
    );
  };
}

function textBoxOptionsBar(toolId: string) {
  const defaults = toolId === TOOL.callout ? CALLOUT_DEFAULTS : TEXTBOX_DEFAULTS;
  const callout = toolId === TOOL.callout;
  return function TextBoxOptionsBar() {
    const o = useToolOptions(toolId, defaults);
    const set = (k: string, v: unknown) => actions.setToolOption(toolId, k, v);
    return (
      <div className="comments-options" data-testid={`comments-options-${callout ? 'callout' : 'textbox'}`}>
        <FontControls
          prefix="comments-opt"
          font={o.font}
          fontSize={o.fontSize}
          align={o.align}
          onChange={(patch: Partial<{ font: FontFamily; fontSize: number; align: TextAlign }>) => {
            for (const [k, v] of Object.entries(patch)) set(k, v);
          }}
        />
        <Swatch testid="comments-opt-text-color" label="Text color" value={o.textColor} onChange={(c) => c && set('textColor', c)} />
        <Swatch testid="comments-opt-border-color" label={callout ? 'Line color' : 'Border color'} value={o.borderColor} allowNone={!callout} onChange={(c) => set('borderColor', c)} />
        <BorderChip testid="comments-opt-border-width" value={o.borderWidth} onChange={(v) => set('borderWidth', v)} />
        <Swatch testid="comments-opt-fill" label="Fill color" value={o.fillColor} allowNone onChange={(c) => set('fillColor', c)} />
        <OpacityChip testid="comments-opt-opacity" value={o.opacity} onChange={(v) => set('opacity', v)} />
        <Hint>{callout ? 'Drag from the point you’re commenting on to where the text goes.' : 'Click to type, or drag to set the width.'}</Hint>
      </div>
    );
  };
}

function AttachOptions() {
  const o = useToolOptions(TOOL.attach, ATTACH_DEFAULTS);
  const set = (k: string, v: unknown) => actions.setToolOption(TOOL.attach, k, v);
  return (
    <div className="comments-options" data-testid="comments-options-attach">
      <ChipDropdown
        testid="comments-opt-attach-icon"
        label="Icon"
        items={ATTACH_ICONS.map((ic) => ({
          id: `comments-opt-attach-icon-${ic.value}`,
          label: ic.label,
          checked: o.icon === ic.value,
          icon: ({ size = 16 }) => <AttachIconSvg icon={ic.value} color={o.color} width={size} height={size} />,
          run: () => set('icon', ic.value),
        }))}
      >
        <AttachIconSvg icon={o.icon} color={o.color} width={18} height={18} />
      </ChipDropdown>
      <Swatch testid="comments-opt-color" label="Color" value={o.color} onChange={(c) => c && set('color', c)} />
      <Hint>Click where the file should go, then choose the file.</Hint>
    </div>
  );
}

// ── tool definitions ───────────────────────────────────────────────────────

function markupSelected(type: MarkupType) {
  return (selections: TextSelectionInfo[]) => {
    lastTextSelected = Date.now();
    void createMarkups(type, selections, { select: false });
  };
}

export const COMMENT_TOOLS: ToolDef[] = [
  {
    id: TOOL.note,
    label: 'Add comment',
    icon: MessageSquarePlus,
    group: 'comment',
    shortcut: 's',
    quick: 10,
    order: 10,
    cursor: 'crosshair',
    oneShot: true,
    PageOverlay: NoteOverlay,
    OptionsBar: NoteOptions,
  },
  {
    id: TOOL.highlight,
    label: 'Highlight text',
    icon: Highlighter,
    group: 'markup',
    shortcut: 'u',
    quick: 11,
    order: 11,
    textSelection: true,
    onTextSelected: markupSelected('highlight'),
    PageOverlay: HighlightOverlay,
    OptionsBar: markupOptionsBar('highlight'),
  },
  {
    id: TOOL.underline,
    label: 'Underline text',
    icon: Underline,
    group: 'markup',
    order: 12,
    textSelection: true,
    onTextSelected: markupSelected('underline'),
    OptionsBar: markupOptionsBar('underline'),
  },
  {
    id: TOOL.strikeout,
    label: 'Strikethrough text',
    icon: Strikethrough,
    group: 'markup',
    order: 13,
    textSelection: true,
    onTextSelected: markupSelected('strikeout'),
    OptionsBar: markupOptionsBar('strikeout'),
  },
  {
    id: TOOL.squiggly,
    label: 'Squiggly underline',
    icon: SquigglyIcon,
    group: 'markup',
    order: 14,
    textSelection: true,
    onTextSelected: markupSelected('squiggly'),
    OptionsBar: markupOptionsBar('squiggly'),
  },
  {
    id: TOOL.insert,
    label: 'Insert text',
    icon: CaretIcon,
    group: 'markup',
    order: 15,
    textSelection: true,
    oneShot: true,
    onTextSelected: (selections) => {
      lastTextSelected = Date.now();
      const sel = selections[selections.length - 1];
      if (!sel) return;
      void createCaretAfterSelection(sel).then((o) => o && actions.toolDone());
    },
    PageOverlay: InsertTextOverlay,
    OptionsBar: caretOptionsBar(TOOL.insert, 'Click in the text where you want to insert text.'),
  },
  {
    id: TOOL.replace,
    label: 'Replace text',
    icon: Replace,
    group: 'markup',
    order: 16,
    textSelection: true,
    oneShot: true,
    onTextSelected: (selections) => {
      lastTextSelected = Date.now();
      void createReplace(selections).then((o) => o && actions.toolDone());
    },
    PageOverlay: ReplaceTextOverlay,
    OptionsBar: caretOptionsBar(TOOL.replace, 'Select the text to replace, then type the new text.'),
  },
  {
    id: TOOL.textbox,
    label: 'Add text box',
    icon: TextBoxIcon,
    group: 'comment',
    shortcut: 'x',
    order: 17,
    cursor: 'crosshair',
    oneShot: true,
    PageOverlay: TextBoxOverlay,
    OptionsBar: textBoxOptionsBar(TOOL.textbox),
  },
  {
    id: TOOL.callout,
    label: 'Add callout',
    icon: CalloutIcon,
    group: 'comment',
    order: 18,
    cursor: 'crosshair',
    oneShot: true,
    PageOverlay: CalloutOverlay,
    OptionsBar: textBoxOptionsBar(TOOL.callout),
  },
  {
    id: TOOL.attach,
    label: 'Attach file',
    icon: Paperclip,
    group: 'comment',
    order: 19,
    cursor: 'crosshair',
    oneShot: true,
    PageOverlay: AttachOverlay,
    OptionsBar: AttachOptions,
  },
];

