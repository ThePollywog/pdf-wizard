/** Menu commands and page context-menu items of the drawing feature. */
import { Pencil, Ruler, Stamp } from 'lucide-react';
import type { MenuItem } from '@/core/types';
import { registerCommands, registerContextMenu } from '@/core/registry';
import { actions, getActiveDoc, getDoc, useApp } from '@/core/store';
import { totalRotation } from '@/core/viewer/viewport';
import { canDraw } from './common';
import { displayRectAt } from './geom';
import { stampDesign } from './stamps/draw';
import { getCurrentStamp, stampDataFor, stampLabelFor, titleCase } from './stamps/custom';
import { placeStamp, STAMP_TASK } from './tools/stamp';
import { DISTANCE_TOOL } from './tools/measure';
import { PEN_TOOL } from './tools/pen';
import { RECT_TOOL } from './tools/shapes';
import { DRAW_TASK, MEASURE_TASK } from './DrawPanel';

const hasDoc = () => !!getActiveDoc();

export function registerDrawingCommands() {
  registerCommands([
    { id: 'drawing-open-draw', label: 'Draw & shapes', icon: Pencil, menu: 'comment', group: 'drawing', order: 40, requiresDocument: true, enabled: hasDoc, run: () => actions.openTask(DRAW_TASK) },
    { id: 'drawing-open-stamps', label: 'Stamps', icon: Stamp, menu: 'comment', group: 'drawing', order: 41, requiresDocument: true, enabled: hasDoc, run: () => actions.openTask(STAMP_TASK) },
    { id: 'drawing-open-measure', label: 'Measure', icon: Ruler, menu: 'tools', group: 'drawing', order: 42, requiresDocument: true, enabled: hasDoc, run: () => actions.openTask(MEASURE_TASK) },
    { id: 'drawing-tool-pen', label: 'Draw freehand', icon: Pencil, group: 'drawing', requiresDocument: true, enabled: hasDoc, run: () => actions.setTool(PEN_TOOL) },
    { id: 'drawing-tool-rect', label: 'Draw rectangle', group: 'drawing', requiresDocument: true, enabled: hasDoc, run: () => actions.setTool(RECT_TOOL) },
    { id: 'drawing-tool-distance', label: 'Measure distance', icon: Ruler, group: 'drawing', requiresDocument: true, enabled: hasDoc, run: () => actions.setTool(DISTANCE_TOOL) },
  ]);

  registerContextMenu({
    id: 'drawing-ctx',
    target: 'page',
    order: 30, // after Comments (20); distinct orders keep the menu stable whatever order features load in
    items({ docId, pageIndex, point }) {
      if (pageIndex == null || !point || !canDraw(docId, true)) return [];
      const d = getDoc(docId);
      const page = d?.pages[pageIndex];
      if (!d || !page) return [];
      const items: MenuItem[] = [];
      const ref = getCurrentStamp();
      const data = ref ? stampDataFor(ref, totalRotation(page, d.view.rotation), useApp.getState().prefs.userName || 'Guest') : null;
      if (ref && data) {
        items.push({
          id: 'drawing-ctx-stamp',
          label: `Add stamp here (${titleCase(stampLabelFor(ref))})`,
          icon: Stamp,
          run: () => {
            const des = stampDesign(data);
            const r = displayRectAt(point, des.w, des.h, data.rotation);
            // keep it on the page
            const [x0, y0, x1, y1] = page.view;
            const x = Math.min(Math.max(r.x, x0), Math.max(x0, x1 - r.width));
            const y = Math.min(Math.max(r.y, y0), Math.max(y0, y1 - r.height));
            placeStamp(docId, page.id, data, { ...r, x, y });
          },
        });
      } else {
        items.push({ id: 'drawing-ctx-stamps', label: 'Add stamp…', icon: Stamp, run: () => actions.openTask(STAMP_TASK) });
      }
      return items;
    },
  });
}
