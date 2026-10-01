/** Tool definitions of the drawing feature (overlays + options bars, wired per tool id). */
import { Circle, Cloud, Eraser, Hexagon, Highlighter, Minus, MoveHorizontal, MoveUpRight, Pencil, Pentagon, Spline, Square, Stamp, Waypoints } from 'lucide-react';
import type { PageOverlayProps, ToolDef } from '@/core/types';
import { actions, useApp } from '@/core/store';
import { EraserOverlay, ERASER_TOOL } from './eraser';
import { HIGHLIGHTER_TOOL, HighlighterOverlay, PEN_TOOL, PenOverlay, resetInkMerge } from './pen';
import { ARROW_TOOL, BoxOverlay, ELLIPSE_TOOL, LineOverlay, LINE_TOOL, RECT_TOOL } from './shapes';
import { AREA_TOOL, cancelPolySession, CLOUD_TOOL, PERIMETER_TOOL, PolyOverlay, POLYGON_TOOL, POLYLINE_TOOL } from './poly';
import { DistanceOverlay, DISTANCE_TOOL } from './measure';
import { STAMP_TASK, STAMP_TOOL, StampOverlay } from './stamp';
import { EraserOptions, HighlighterOptions, LineOptions, MeasureOptions, PenOptions, PolyOptions, ShapeOptions, StampOptions } from './options';
import { setLive } from '../measure/live';
import { getCurrentStamp } from '../stamps/custom';

const named = <P,>(name: string, C: (p: P) => React.ReactNode) => Object.assign(C, { displayName: name });

const box = (kind: 'rect' | 'ellipse', toolId: string) => named(`Drawing${kind}Overlay`, (p: PageOverlayProps) => <BoxOverlay {...p} kind={kind} toolId={toolId} />);
const line = (toolId: string) => named('DrawingLineOverlay', (p: PageOverlayProps) => <LineOverlay {...p} toolId={toolId} />);
const poly = (toolId: string) => named('DrawingPolyOverlay', (p: PageOverlayProps) => <PolyOverlay {...p} toolId={toolId} />);
const shapeOpts = (toolId: string) => named('DrawingShapeOptions', () => <ShapeOptions toolId={toolId} />);
const lineOpts = (toolId: string) => named('DrawingLineOptions', () => <LineOptions toolId={toolId} />);
const polyOpts = (toolId: string) => named('DrawingPolyOptions', () => <PolyOptions toolId={toolId} />);
const measureOpts = (toolId: string) => named('DrawingMeasureOptions', () => <MeasureOptions toolId={toolId} />);

export const DRAW_TOOL_IDS = [PEN_TOOL, HIGHLIGHTER_TOOL, ERASER_TOOL];
export const SHAPE_TOOL_IDS = [RECT_TOOL, ELLIPSE_TOOL, LINE_TOOL, ARROW_TOOL, POLYLINE_TOOL, POLYGON_TOOL, CLOUD_TOOL];
export const MEASURE_TOOL_IDS = [DISTANCE_TOOL, PERIMETER_TOOL, AREA_TOOL];

/** Stamp tool without a current stamp: open the palette so the user can pick one. */
function activateStamp() {
  if (getCurrentStamp()) return;
  queueMicrotask(() => {
    const s = useApp.getState();
    if (s.activeToolId !== STAMP_TOOL || s.modals.length) return;
    if (s.activeTaskId === STAMP_TASK) actions.setLeftPanelOpen(true);
    else actions.openTask(STAMP_TASK); // (resets the tool to Select until a stamp is chosen)
    actions.toast('Choose a stamp, then click the page to place it.', { kind: 'info' });
  });
}

export const TOOLS: ToolDef[] = [
  // ── freehand ──
  {
    id: PEN_TOOL,
    label: 'Draw freehand',
    icon: Pencil,
    group: 'draw',
    shortcut: 'd',
    order: 40,
    quick: 12,
    cursor: 'crosshair',
    PageOverlay: PenOverlay,
    OptionsBar: PenOptions,
    onDeactivate: resetInkMerge,
  },
  {
    id: HIGHLIGHTER_TOOL,
    label: 'Highlighter pen',
    icon: Highlighter,
    group: 'draw',
    order: 41,
    cursor: 'crosshair',
    PageOverlay: HighlighterOverlay,
    OptionsBar: HighlighterOptions,
    onDeactivate: resetInkMerge,
  },
  {
    id: ERASER_TOOL,
    label: 'Eraser',
    icon: Eraser,
    group: 'draw',
    order: 42,
    cursor: 'none',
    PageOverlay: EraserOverlay,
    OptionsBar: EraserOptions,
  },
  // ── shapes ──
  { id: RECT_TOOL, label: 'Rectangle', icon: Square, group: 'shape', shortcut: 'r', order: 50, cursor: 'crosshair', oneShot: true, PageOverlay: box('rect', RECT_TOOL), OptionsBar: shapeOpts(RECT_TOOL) },
  { id: ELLIPSE_TOOL, label: 'Oval', icon: Circle, group: 'shape', shortcut: 'o', order: 51, cursor: 'crosshair', oneShot: true, PageOverlay: box('ellipse', ELLIPSE_TOOL), OptionsBar: shapeOpts(ELLIPSE_TOOL) },
  { id: LINE_TOOL, label: 'Line', icon: Minus, group: 'shape', shortcut: 'l', order: 52, cursor: 'crosshair', oneShot: true, PageOverlay: line(LINE_TOOL), OptionsBar: lineOpts(LINE_TOOL) },
  { id: ARROW_TOOL, label: 'Arrow', icon: MoveUpRight, group: 'shape', shortcut: 'a', order: 53, cursor: 'crosshair', oneShot: true, PageOverlay: line(ARROW_TOOL), OptionsBar: lineOpts(ARROW_TOOL) },
  { id: POLYLINE_TOOL, label: 'Connected lines', icon: Waypoints, group: 'shape', order: 54, cursor: 'crosshair', oneShot: true, PageOverlay: poly(POLYLINE_TOOL), OptionsBar: polyOpts(POLYLINE_TOOL), onDeactivate: cancelPolySession },
  { id: POLYGON_TOOL, label: 'Polygon', icon: Pentagon, group: 'shape', order: 55, cursor: 'crosshair', oneShot: true, PageOverlay: poly(POLYGON_TOOL), OptionsBar: polyOpts(POLYGON_TOOL), onDeactivate: cancelPolySession },
  { id: CLOUD_TOOL, label: 'Cloud', icon: Cloud, group: 'shape', order: 56, cursor: 'crosshair', oneShot: true, PageOverlay: poly(CLOUD_TOOL), OptionsBar: polyOpts(CLOUD_TOOL), onDeactivate: cancelPolySession },
  // ── stamp ──
  {
    id: STAMP_TOOL,
    label: 'Stamp',
    icon: Stamp,
    group: 'comment',
    shortcut: 'k',
    order: 60,
    cursor: 'copy',
    oneShot: true,
    PageOverlay: StampOverlay,
    OptionsBar: StampOptions,
    onActivate: activateStamp,
  },
  // ── measure ──
  { id: DISTANCE_TOOL, label: 'Distance', icon: MoveHorizontal, group: 'measure', shortcut: 'm', order: 70, cursor: 'crosshair', PageOverlay: DistanceOverlay, OptionsBar: measureOpts(DISTANCE_TOOL), onDeactivate: () => setLive(null) },
  { id: PERIMETER_TOOL, label: 'Perimeter', icon: Spline, group: 'measure', shortcut: 'm', order: 71, cursor: 'crosshair', PageOverlay: poly(PERIMETER_TOOL), OptionsBar: measureOpts(PERIMETER_TOOL), onDeactivate: cancelPolySession },
  { id: AREA_TOOL, label: 'Area', icon: Hexagon, group: 'measure', shortcut: 'm', order: 72, cursor: 'crosshair', PageOverlay: poly(AREA_TOOL), OptionsBar: measureOpts(AREA_TOOL), onDeactivate: cancelPolySession },
];
