/**
 * Eraser: removes the parts of ink strokes it passes over (splitting them), or whole strokes.
 * One undo step per drag.
 */
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { DocId, PageOverlayProps, Point } from '@/core/types';
import { actions, getDoc, getToolOptions, objectsOnPage, useToolOptions } from '@/core/store';
import { ERASER_DEFAULTS, type InkObject } from '../model';
import { inkRect, widthOf } from '../looks';
import { erasePaths, polylineHits } from '../geom';
import { canDraw } from '../common';
import { clampToPage, coalesced, focusScroller, isDrawStart, trackPointer } from './common';

export const ERASER_TOOL = 'draw-eraser';

/** Erase along a→b on one page. Returns true when something changed. */
function eraseAlong(docId: DocId, pageId: string, a: Point, b: Point, radiusPt: number, mode: 'partial' | 'whole', scale: number, begin: () => void): boolean {
  const doc = getDoc(docId);
  if (!doc) return false;
  const inks = objectsOnPage(doc, pageId).filter((o): o is InkObject => o.kind === 'ink' && !o.locked);
  let changed = false;
  const remove: string[] = [];
  for (const o of inks) {
    const w = widthOf(o);
    const r = radiusPt + w / 2;
    const paths = o.data.paths;
    let next: Point[][] | null;
    if (mode === 'whole') {
      const kept = paths.filter((p) => !polylineHits(p, a, b, r));
      next = kept.length === paths.length ? null : kept;
    } else {
      next = erasePaths(paths, a, b, r, Math.max(0.15, 0.6 / scale));
    }
    if (!next) continue;
    if (!changed) begin();
    changed = true;
    if (next.length === 0) remove.push(o.id);
    else actions.updateObject(docId, o.id, { data: { ...o.data, paths: next }, rect: inkRect(next, w) }, { checkpoint: false });
  }
  if (remove.length) actions.deleteObjects(docId, remove, { checkpoint: false });
  return changed;
}

export function EraserOverlay({ docId, page, scale, toPdf }: PageOverlayProps) {
  const opts = useToolOptions(ERASER_TOOL, ERASER_DEFAULTS);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const local = (cx: number, cy: number) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: cx - r.left, y: cy - r.top } : null;
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!isDrawStart(e)) return;
    e.preventDefault();
    e.stopPropagation();
    focusScroller(e.currentTarget);
    if (!canDraw(docId)) return;
    const o = getToolOptions(ERASER_TOOL, ERASER_DEFAULTS);
    const radius = Math.max(1, o.size) / 2 / scale;
    let last = clampToPage(page, toPdf(e.clientX, e.clientY));
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      actions.checkpoint(docId, 'Erase');
    };
    setActive(true);
    eraseAlong(docId, page.id, last, last, radius, o.mode, scale, begin);
    trackPointer(e, {
      move: (ev) => {
        setCursor(local(ev.clientX, ev.clientY));
        for (const c of coalesced(ev)) {
          const p = clampToPage(page, toPdf(c.clientX, c.clientY));
          eraseAlong(docId, page.id, last, p, radius, o.mode, scale, begin);
          last = p;
        }
      },
      up: () => setActive(false),
      cancel: () => setActive(false),
    });
  };

  const size = Math.max(4, opts.size);
  return (
    <div
      ref={ref}
      className="drawing-overlay drawing-eraser-overlay"
      data-testid="drawing-overlay-eraser"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => setCursor(local(e.clientX, e.clientY))}
      onPointerLeave={() => !active && setCursor(null)}
    >
      {cursor && <div className={`drawing-eraser-cursor${active ? ' is-active' : ''}`} style={{ left: cursor.x, top: cursor.y, width: size, height: size }} />}
    </div>
  );
}
