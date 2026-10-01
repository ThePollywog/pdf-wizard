/**
 * Draw freehand (pen) and Highlighter tools. Strokes are smoothed and simplified; strokes drawn one
 * after another (within 1.5 s, or overlapping the previous drawing) merge into one ink object.
 */
import { useRef, type PointerEvent as RPointerEvent } from 'react';
import type { DocId, PageOverlayProps, Point } from '@/core/types';
import { actions, getDoc, getToolOptions, newObject } from '@/core/store';
import { HIGHLIGHTER_DEFAULTS, PEN_DEFAULTS, type InkObject } from '../model';
import { inkPaints, inkRect } from '../looks';
import { bboxOf, dist, inflate, overlaps, simplify, snap45 } from '../geom';
import { canDraw } from '../common';
import { clampToPage, coalesced, focusScroller, isDrawStart, trackPointer } from './common';
import { OverlayPaints, useFrameTick } from './preview';

export const PEN_TOOL = 'draw-pen';
export const HIGHLIGHTER_TOOL = 'draw-highlighter';
export const MERGE_MS = 1500;

type InkOpts = typeof PEN_DEFAULTS;
export const inkOptions = (highlight: boolean): InkOpts =>
  highlight ? getToolOptions(HIGHLIGHTER_TOOL, HIGHLIGHTER_DEFAULTS) : getToolOptions(PEN_TOOL, PEN_DEFAULTS);

/** The ink object the next stroke may merge into. Reset when the tool changes. */
let lastInk: { docId: DocId; id: string; at: number; highlight: boolean } | null = null;
export function resetInkMerge() {
  lastInk = null;
}

function commitStroke(docId: DocId, pageId: string, stroke: Point[], highlight: boolean) {
  const o = inkOptions(highlight);
  const doc = getDoc(docId);
  if (!doc) return;
  const now = Date.now();
  const prev = lastInk && lastInk.docId === docId && lastInk.highlight === highlight ? (doc.objects[lastInk.id] as InkObject | undefined) : undefined;
  const sb = bboxOf(stroke);
  if (
    prev &&
    prev.kind === 'ink' &&
    !prev.locked &&
    prev.pageId === pageId &&
    prev.color === o.color &&
    prev.strokeWidth === o.width &&
    (prev.opacity ?? 1) === o.opacity &&
    !!prev.data.highlight === highlight &&
    sb &&
    (now - lastInk!.at < MERGE_MS || overlaps(inflate(sb, o.width), prev.rect))
  ) {
    const paths = [...prev.data.paths, stroke];
    actions.updateObject(docId, prev.id, { data: { ...prev.data, paths }, rect: inkRect(paths, o.width) }, { label: highlight ? 'Highlight' : 'Draw' });
    lastInk = { docId, id: prev.id, at: now, highlight };
    return;
  }
  const obj = newObject<InkObject>({
    kind: 'ink',
    pageId,
    rect: inkRect([stroke], o.width),
    color: o.color,
    fillColor: null,
    opacity: o.opacity,
    strokeWidth: o.width,
    data: { paths: [stroke], ...(highlight ? { highlight: true } : {}) },
  });
  actions.addObject(docId, obj, { select: false, label: highlight ? 'Add highlighter drawing' : 'Add drawing' });
  lastInk = { docId, id: obj.id, at: now, highlight };
}

export function InkOverlay({ docId, page, scale, toPdf, toView, highlight }: PageOverlayProps & { highlight: boolean }) {
  const pts = useRef<Point[] | null>(null);
  const tick = useFrameTick();
  const opts = inkOptions(highlight);

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!isDrawStart(e)) return;
    e.preventDefault();
    e.stopPropagation();
    focusScroller(e.currentTarget);
    if (!canDraw(docId)) return;
    const start = clampToPage(page, toPdf(e.clientX, e.clientY));
    const raw: Point[] = [start];
    pts.current = raw;
    tick();
    trackPointer(e, {
      move: (ev) => {
        if (ev.shiftKey) {
          pts.current = [start, snap45(start, clampToPage(page, toPdf(ev.clientX, ev.clientY)))];
        } else {
          if (pts.current !== raw) pts.current = raw;
          for (const c of coalesced(ev)) {
            const p = clampToPage(page, toPdf(c.clientX, c.clientY));
            if (dist(p, raw[raw.length - 1]) > 0.2 / scale) raw.push(p);
          }
        }
        tick();
      },
      up: () => {
        const all = pts.current ?? raw;
        pts.current = null;
        tick();
        let stroke = all.length > 2 ? simplify(all, Math.max(0.15, 0.6 / scale)) : all.slice();
        if (stroke.length === 1 || (stroke.length === 2 && dist(stroke[0], stroke[1]) < 0.05)) stroke = [stroke[0], { x: stroke[0].x + 0.05, y: stroke[0].y }];
        commitStroke(docId, page.id, stroke, highlight);
      },
      cancel: () => {
        pts.current = null;
        tick();
      },
    });
  };

  const live = pts.current;
  return (
    <div className="drawing-overlay" data-testid={highlight ? 'drawing-overlay-highlighter' : 'drawing-overlay-pen'} onPointerDown={onPointerDown}>
      {live && live.length > 0 && (
        <OverlayPaints
          toView={toView}
          paints={inkPaints({ paths: [live], highlight }, { color: opts.color, strokeWidth: opts.width })}
          opacity={opts.opacity}
          blend={highlight}
        />
      )}
    </div>
  );
}

export const PenOverlay = (p: PageOverlayProps) => <InkOverlay {...p} highlight={false} />;
export const HighlighterOverlay = (p: PageOverlayProps) => <InkOverlay {...p} highlight />;
