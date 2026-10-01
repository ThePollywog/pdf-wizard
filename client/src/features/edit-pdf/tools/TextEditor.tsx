/**
 * In-place text editor: a transparent textarea laid exactly over the text being edited (same
 * frame, font, size, line spacing and baseline as the PDF writer will use), the paper-colored cover
 * hiding the original glyphs, and e / w handles that change the wrap width.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type ClipboardEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { PageViewport } from '@/core/types';
import { applyLinear } from '../content/matrix';
import { cssBaselineInLine, cssTextStyle } from '../fontMap';
import { caretOffsetAt, lineBoundsAt } from '../caret';
import { applyFormat } from '../sessions';
import { coverQuad, ui, useEditPdf, type EditSession } from '../state';
import { layoutTextBox } from '../textbox';
import { frameCss, quadPoints, viewMatrix } from '../viewmath';
import { trackPointer } from './drag';

const MIN_WIDTH = 12;

export function coverPad(s: { size: number }): number {
  return Math.max(0.5, s.size * 0.12);
}

/** Paper cover over the original text of a block session (page-sized SVG). */
export function EditCover({ session, vp }: { session: EditSession; vp: PageViewport }) {
  if (session.source.type !== 'block' || session.paper === 'transparent') return null;
  const q = coverQuad(session.original.frame, coverPad(session.original.style));
  return (
    <svg className="edit-pdf-cover edit-pdf-paint" aria-hidden="true">
      <polygon points={quadPoints(vp, q)} fill={session.paper} />
    </svg>
  );
}

export function TextEditor({ session, vp, zoom }: { session: EditSession; vp: PageViewport; zoom: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusNonce = useEditPdf((s) => s.focusNonce);
  const { text, style, frame, autoWidth, firstBaseline, phase } = session;
  const lay = useMemo(() => layoutTextBox(text, style, frame.width, autoWidth), [text, style, frame.width, autoWidth]);
  const editing = phase === 'editing';

  // focus + initial caret once per session
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const c = session.caret;
    if (c === 'all') ta.select();
    else if (c === 'end') ta.setSelectionRange(ta.value.length, ta.value.length);
    else {
      const at = caretOffsetAt(session, c);
      ta.setSelectionRange(at, at);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.nonce]);

  useEffect(() => {
    if (focusNonce && editing) ref.current?.focus({ preventScroll: true });
  }, [focusNonce, editing]);

  // the textarea never scrolls: keep the first line at the top
  useLayoutEffect(() => {
    const ta = ref.current;
    if (ta && ta.scrollTop) ta.scrollTop = 0;
    if (ta && ta.scrollLeft) ta.scrollLeft = 0;
  });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab') {
      e.preventDefault();
      return;
    }
    // Home / End / Page keys move the caret (by default macOS scrolls the page instead)
    if ((e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') && !mod && !e.altKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ui.get().edit;
      const back = ta.selectionDirection === 'backward';
      const focus = back ? ta.selectionStart : ta.selectionEnd;
      const anchor = back ? ta.selectionEnd : ta.selectionStart;
      let to: number;
      if (e.key === 'PageUp') to = 0;
      else if (e.key === 'PageDown') to = ta.value.length;
      else {
        const [a, b] = s ? lineBoundsAt({ text: ta.value, style: s.style, frame: s.frame, autoWidth: s.autoWidth }, focus) : [0, ta.value.length];
        to = e.key === 'Home' ? a : b;
      }
      if (e.shiftKey) ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward');
      else ta.setSelectionRange(to, to);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault();
        e.stopPropagation();
        const s = ui.get().edit?.style ?? style;
        void applyFormat({ style: k === 'b' ? { bold: !s.bold } : k === 'i' ? { italic: !s.italic } : { underline: !s.underline } });
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const raw = e.clipboardData.getData('text/plain');
    const clean = raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (clean === raw) return; // the browser inserts plain text already
    e.preventDefault();
    const ta = e.currentTarget;
    // keeps the textarea's own undo stack
    if (!document.execCommand('insertText', false, clean)) {
      ta.setRangeText(clean, ta.selectionStart, ta.selectionEnd, 'end');
      ui.patchEdit({ text: ta.value });
    }
  };

  const shift = firstBaseline - cssBaselineInLine(style);
  const W = lay.width * zoom;
  const H = Math.max(lay.height, style.lineHeight) * zoom;
  const tolerance = autoWidth ? 0 : Math.max(0.5, style.size * 0.02) * zoom;

  return (
    <div
      className={`edit-pdf-editor edit-pdf-paint${editing ? '' : ' is-busy'}`}
      style={{ ...frameCss({ ...frame, height: lay.height }, vp, zoom), width: W, height: H }}
      data-testid="edit-pdf-editor"
      data-phase={phase}
      data-edit-pdf-keep=""
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        className="edit-pdf-textarea"
        data-testid="edit-pdf-textarea"
        aria-label="Edit text"
        spellCheck={false}
        autoComplete="off"
        value={text}
        readOnly={!editing}
        wrap={autoWidth ? 'off' : 'soft'}
        style={{
          ...cssTextStyle(style, zoom),
          top: shift * zoom,
          width: W + tolerance,
          height: H + style.lineHeight * zoom,
          whiteSpace: autoWidth ? 'pre' : 'pre-wrap',
          overflowWrap: autoWidth ? 'normal' : 'anywhere',
          caretColor: editing ? style.color : 'transparent',
        }}
        onChange={(e) => ui.patchEdit({ text: e.target.value })}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {editing && <WidthHandles session={session} vp={vp} zoom={zoom} />}
    </div>
  );
}

/** e / w handles: drag to change the wrap width (the text reflows). */
function WidthHandles({ session, vp, zoom }: { session: EditSession; vp: PageViewport; zoom: number }) {
  const start = (side: 'e' | 'w') => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const s0 = ui.get().edit;
    if (!s0) return;
    const f0 = s0.frame;
    const w0 = layoutTextBox(s0.text, s0.style, f0.width, s0.autoWidth).width;
    // u direction on screen (CSS px per point along the text)
    const [ux, uy] = applyLinear(viewMatrix(vp), f0.u[0], f0.u[1]);
    const len = Math.hypot(ux, uy) || zoom || 1;
    trackPointer(e, {
      threshold: 1,
      cursor: 'ew-resize',
      onMove(_ev, dx, dy) {
        const along = (dx * ux + dy * uy) / len / (zoom || 1);
        const width = Math.max(MIN_WIDTH, side === 'e' ? w0 + along : w0 - along);
        const moved = side === 'w' ? w0 - width : 0;
        ui.patchEdit({
          autoWidth: false,
          frame: { ...f0, width, origin: [f0.origin[0] + f0.u[0] * moved, f0.origin[1] + f0.u[1] * moved] },
        });
      },
      onEnd() {
        ui.focusEditor();
      },
      onCancel() {
        ui.patchEdit({ frame: f0, autoWidth: s0.autoWidth });
        ui.focusEditor();
      },
    });
  };
  return (
    <>
      <span className="pdfwizard-handle pdfwizard-handle-w edit-pdf-width-handle" data-testid="edit-pdf-editor-handle-w" onPointerDown={start('w')} />
      <span className="pdfwizard-handle pdfwizard-handle-e edit-pdf-width-handle" data-testid="edit-pdf-editor-handle-e" onPointerDown={start('e')} />
    </>
  );
}
