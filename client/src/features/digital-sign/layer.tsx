/**
 * Page layer: while the Digitally sign task is open, empty signature fields get a clickable
 * "Sign here" box. And the place tool: drag a rectangle to create a new signature field.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { FileSignature } from 'lucide-react';
import { actions, useApp } from '@/core/store';
import type { PageOverlayProps, Point } from '@/core/types';
import { TASK_ID, useSignatures } from './model';
import { openSignDialog } from './SignDialog';

export function SignHereLayer(p: PageOverlayProps) {
  const open = useApp((s) => s.activeTaskId === TASK_ID && s.activeToolId === 'select');
  const st = useSignatures(open ? p.docId : null);
  if (!open || !st) return null;
  const fields = st.fields.filter((f) => !f.signed && f.rect && f.pageIndex === p.pageIndex);
  if (!fields.length) return null;
  return (
    <>
      {fields.map((f) => {
        const b = p.rectToView(f.rect!);
        return (
          <button
            key={f.fieldRef}
            type="button"
            className="digital-sign-here"
            style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
            title={`Sign “${f.name}”`}
            data-testid="digital-sign-here"
            data-field-name={f.name}
            onClick={() => void openSignDialog(p.docId, { kind: 'field', fieldRef: f.fieldRef })}
          >
            <span className="digital-sign-here-tab">
              <FileSignature size={12} aria-hidden /> Sign here
            </span>
          </button>
        );
      })}
    </>
  );
}

const MIN_W = 60;
const MIN_H = 20;

export function PlaceOverlay(p: PageOverlayProps) {
  const start = useRef<Point | null>(null);
  const [cur, setCur] = useState<{ a: Point; b: Point } | null>(null);
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = p.toPdf(e.clientX, e.clientY);
    setCur({ a: start.current, b: start.current });
  };
  const move = (e: ReactPointerEvent) => {
    if (start.current) setCur({ a: start.current, b: p.toPdf(e.clientX, e.clientY) });
  };
  const up = (e: ReactPointerEvent) => {
    const a = start.current;
    start.current = null;
    setCur(null);
    if (!a) return;
    const b = p.toPdf(e.clientX, e.clientY);
    let rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
    // A click (or a tiny drag) places a standard 200 × 50 pt box there.
    if (rect.width < MIN_W || rect.height < MIN_H) rect = { x: a.x, y: a.y - 50, width: 200, height: 50 };
    actions.toolDone();
    void openSignDialog(p.docId, { kind: 'new', pageIndex: p.pageIndex, rect });
  };
  const box = cur
    ? p.rectToView({ x: Math.min(cur.a.x, cur.b.x), y: Math.min(cur.a.y, cur.b.y), width: Math.abs(cur.a.x - cur.b.x), height: Math.abs(cur.a.y - cur.b.y) })
    : null;
  return (
    <div className="digital-sign-place" data-testid="digital-sign-place-overlay" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {box && <div className="digital-sign-place-box" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />}
    </div>
  );
}
