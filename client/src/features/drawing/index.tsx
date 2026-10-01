/**
 * Drawing markup, shapes, stamps and measuring.
 *
 *  - tasks: "drawing" (Draw & shapes), "stamp" (stamp palette), "measure" (measuring tools + scale)
 *  - tools: draw-pen, draw-highlighter, draw-eraser, shape-rect/-ellipse/-line/-arrow/-polyline/
 *    -polygon/-cloud, stamp, measure-distance/-perimeter/-area
 *  - object kinds: ink, shape, line, poly, stamp, measure (all listed as comments)
 *  - PDF: exported as Ink / Square / Circle / Line / PolyLine / Polygon / Stamp annotations with
 *    matching appearance streams; the same subtypes are imported back.
 */
import { Pencil, Ruler, Stamp } from 'lucide-react';
import { registerObjectType, registerTask, registerTool } from '@/core/registry';
import { actions, useApp } from '@/core/store';
import { inkType } from './types/ink';
import { shapeType } from './types/shape';
import { lineType } from './types/line';
import { polyType } from './types/poly';
import { measureType } from './types/measure';
import { stampType } from './types/stamp';
import { DRAW_TOOL_IDS, MEASURE_TOOL_IDS, SHAPE_TOOL_IDS, TOOLS } from './tools/register';
import { resetInkMerge } from './tools/pen';
import { cancelPolySession, usePolySession } from './tools/poly';
import { DISTANCE_TOOL } from './tools/measure';
import { STAMP_TASK, STAMP_TOOL } from './tools/stamp';
import { setLive } from './measure/live';
import { DrawPanel, DRAW_TASK, MEASURE_TASK } from './DrawPanel';
import { StampsPanel } from './stamps/Panel';
import { MeasurePanel } from './measure/Panel';
import { registerImporters } from './importers';
import { registerDrawingCommands } from './commands';
import './styles.css';

registerObjectType(inkType);
registerObjectType(shapeType);
registerObjectType(lineType);
registerObjectType(polyType);
registerObjectType(measureType);
registerObjectType(stampType);

TOOLS.forEach(registerTool);

registerTask({
  id: DRAW_TASK,
  label: 'Draw & shapes',
  description: 'Draw freehand, highlight with a pen, and add rectangles, ovals, lines, arrows, polygons and clouds.',
  icon: Pencil,
  color: '#e8543f',
  category: 'comment',
  order: 20,
  keywords: ['draw', 'pen', 'pencil', 'ink', 'freehand', 'highlighter', 'eraser', 'shape', 'rectangle', 'square', 'oval', 'circle', 'ellipse', 'line', 'arrow', 'polygon', 'polyline', 'cloud', 'markup'],
  requiresDocument: true,
  Panel: DrawPanel,
  toolbar: [...DRAW_TOOL_IDS, ...SHAPE_TOOL_IDS],
});

registerTask({
  id: STAMP_TASK,
  label: 'Stamp',
  description: 'Stamp documents with Approved, Confidential, Sign here and dynamic stamps, or your own image.',
  icon: Stamp,
  color: '#d7373f',
  category: 'comment',
  order: 21,
  keywords: ['stamp', 'approved', 'confidential', 'draft', 'final', 'sign here', 'dynamic', 'custom stamp', 'rubber stamp'],
  requiresDocument: true,
  Panel: StampsPanel,
  toolbar: [STAMP_TOOL],
});

registerTask({
  id: MEASURE_TASK,
  label: 'Measure',
  description: 'Measure distances, perimeters and areas using a drawing scale.',
  icon: Ruler,
  color: '#0d66d0',
  category: 'review',
  order: 30,
  keywords: ['measure', 'distance', 'perimeter', 'area', 'ruler', 'scale', 'dimension', 'length'],
  requiresDocument: true,
  Panel: MeasurePanel,
  toolbar: MEASURE_TOOL_IDS,
  onOpen: () => actions.setTool(DISTANCE_TOOL),
});

registerImporters();
registerDrawingCommands();

// `openTask` switches tools without calling onDeactivate: clean up transient state on any change.
useApp.subscribe(
  (s) => s.activeToolId,
  (tool, prev) => {
    if (tool === prev) return;
    const s = usePolySession.getState().s;
    if (s && s.toolId !== tool) cancelPolySession();
    else if (!s) setLive(null);
    resetInkMerge();
  },
);
// Switching documents cancels an unfinished polygon too.
useApp.subscribe(
  (s) => s.activeDocId,
  () => cancelPolySession(),
);
// …and so does deleting its page (or closing its document).
useApp.subscribe(
  (s) => s.docs,
  (docs) => {
    const s = usePolySession.getState().s;
    if (s && !docs[s.docId]?.pages.some((p) => p.id === s.pageId)) cancelPolySession();
  },
);
