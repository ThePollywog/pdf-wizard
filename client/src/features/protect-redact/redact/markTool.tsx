/**
 * "Redact text & images" tool. Selecting text marks the selected lines; dragging anywhere else
 * (or with Alt held, even over text) marks a rectangular area, e.g. over images.
 */
import { useEffect, useRef, useState } from 'react';
import { actions, getDoc, useApp, useDoc } from '@/core/store';
import type { PageOverlayProps, Point, Rect, TextSelectionInfo } from '@/core/types';
import { inflateRect, rectFromPoints } from '@/core/geometry';
import { addMarks, makeMark, markAt, markDefaults } from './marks';
import { MARK_TOOL } from './types';
import { redactUi } from './uiStore';

const MIN_DRAG_PT = 3;

export function onTextSelected(selections: TextSelectionInfo[]) {
  const first = selections[0];
  if (!first) return;
  const doc = getDoc(first.docId);
  if (!doc) return;
  const defaults = markDefaults();
  const marks = selections.map((s) => {
    const page = doc.pages[s.pageIndex];
    if (!page || !s.rects.length) return null;
    // Pad slightly so glyph edges (ascenders, descenders, anti-aliasing) are covered too.
    const rects = s.rects.map((r) => inflateRect(r, Math.min(1, r.height * 0.06)));
    return makeMark(page, 'text', rects, { text: s.text, defaults });
  });
  // Like desktop PDF editors, the tool stays active so more text can be marked.
  addMarks(first.docId, marks, 'Mark text for redaction');
}

interface Drag {
  a: Point;
  b: Point;
  pointerId: number;
}

export function MarkOverlay({ docId, page, rectToView, toPdf }: PageOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const toPdfRef = useRef(toPdf);
  toPdfRef.current = toPdf;
  const pageRef = useRef(page);
  pageRef.current = page;
  const readOnly = useDoc(docId, (d) => !!d?.ext?.readOnly);

  useEffect(() => {
    const pageEl = ref.current?.closest<HTMLElement>('.pdfwizard-page');
    if (!pageEl) return;
    pageEl.classList.add('protect-redact-marking');
    let active: Drag | null = null;
    let suppressClick = false;
    const sig = new AbortController();

    const finish = (commit: boolean) => {
      const d = active;
      active = null;
      setDrag(null);
      if (!d || !commit) return;
      const r = rectFromPoints(d.a, d.b);
      const doc = getDoc(docId);
      if (r.width < MIN_DRAG_PT && r.height < MIN_DRAG_PT) {
        // A click: select the mark under the pointer, if any.
        const hit = markAt(doc, pageRef.current.id, d.a.x, d.a.y, 1);
        if (hit) {
          actions.setTool('select');
          actions.setSelection(docId, [hit.id]);
        }
        return;
      }
      if (r.width < 1 || r.height < 1) return;
      const mark = makeMark(pageRef.current, 'area', [r]);
      addMarks(docId, [mark], 'Mark area for redaction');
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === 'touch' || useApp.getState().activeToolId !== MARK_TOOL) return;
      const t = e.target as Element | null;
      if (!t || t.closest('[data-viewer-passthrough]')) return;
      const onText = !!t.closest('.textLayer span, .textLayer br');
      if (onText && !e.altKey) {
        // Text selection (handled by the viewer → onTextSelected). A plain click on an existing
        // mark selects it (marks created by this very gesture, e.g. a double click, don't count).
        const start = { x: e.clientX, y: e.clientY };
        const p0 = toPdfRef.current(start.x, start.y);
        const before = e.detail > 1 ? null : markAt(getDoc(docId), pageRef.current.id, p0.x, p0.y, 1);
        if (!before) return;
        const up = (ev: PointerEvent) => {
          const selected = () => {
            const sel = document.getSelection();
            return !!sel && !sel.isCollapsed;
          };
          if (selected() || ev.detail > 1 || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) return;
          setTimeout(() => {
            if (selected() || useApp.getState().activeToolId !== MARK_TOOL) return;
            if (!getDoc(docId)?.objects[before.id]) return;
            actions.setTool('select');
            actions.setSelection(docId, [before.id]);
          }, 0);
        };
        window.addEventListener('pointerup', up, { once: true, capture: true, signal: sig.signal });
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      document.getSelection()?.removeAllRanges();
      const p = toPdfRef.current(e.clientX, e.clientY);
      active = { a: p, b: p, pointerId: e.pointerId };
      setDrag(active);
      suppressClick = true;
      const move = (ev: PointerEvent) => {
        if (!active || ev.pointerId !== active.pointerId) return;
        const q = toPdfRef.current(ev.clientX, ev.clientY);
        const [x0, y0, x1, y1] = pageRef.current.view;
        active = { ...active, b: { x: Math.min(x1, Math.max(x0, q.x)), y: Math.min(y1, Math.max(y0, q.y)) } };
        setDrag(active);
      };
      const end = (ev: PointerEvent) => {
        if (!active || ev.pointerId !== active.pointerId) return;
        cleanup.abort();
        finish(ev.type === 'pointerup');
        setTimeout(() => (suppressClick = false), 0);
      };
      const key = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && active) {
          ev.preventDefault();
          ev.stopPropagation();
          cleanup.abort();
          finish(false);
        }
      };
      const cleanup = new AbortController();
      sig.signal.addEventListener('abort', () => cleanup.abort());
      window.addEventListener('pointermove', move, { capture: true, signal: cleanup.signal });
      window.addEventListener('pointerup', end, { capture: true, signal: cleanup.signal });
      window.addEventListener('pointercancel', end, { capture: true, signal: cleanup.signal });
      window.addEventListener('keydown', key, { capture: true, signal: cleanup.signal });
    };
    // Mouse compatibility events would start a native text selection / focus change.
    const onMouseDown = (e: MouseEvent) => {
      if (active) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (active || e.pointerType === 'touch') return;
      const p = toPdfRef.current(e.clientX, e.clientY);
      const hit = markAt(getDoc(docId), pageRef.current.id, p.x, p.y);
      redactUi.setHover(hit?.id ?? null);
    };
    const onLeave = () => redactUi.setHover(null);
    pageEl.addEventListener('pointerdown', onDown, { capture: true, signal: sig.signal });
    pageEl.addEventListener('mousedown', onMouseDown, { capture: true, signal: sig.signal });
    pageEl.addEventListener('click', onClick, { capture: true, signal: sig.signal });
    pageEl.addEventListener('pointermove', onMove, { passive: true, signal: sig.signal });
    pageEl.addEventListener('pointerleave', onLeave, { signal: sig.signal });
    return () => {
      sig.abort();
      pageEl.classList.remove('protect-redact-marking');
      redactUi.setHover(null);
    };
  }, [docId]);

  let preview: Rect | null = null;
  if (drag) preview = rectFromPoints(drag.a, drag.b);
  const box = preview ? rectToView(preview) : null;
  return (
    <div ref={ref} className="protect-redact-tool-overlay" data-testid="protect-redact-mark-overlay" data-readonly={readOnly ? 'true' : undefined}>
      {box && (
        <div
          className="protect-redact-drag"
          data-testid="protect-redact-drag"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, borderColor: markDefaults().outlineColor }}
        />
      )}
    </div>
  );
}
