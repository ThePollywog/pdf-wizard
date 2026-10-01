/** Left panel of the "Draw & shapes" task: freehand, shape, stamp and measuring tools with tips. */
import { useMemo } from 'react';
import { Ruler, Stamp } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId, ToolDef } from '@/core/types';
import { Button, formatShortcut } from '@/core/ui';
import { DRAW_TOOL_IDS, SHAPE_TOOL_IDS } from './tools/register';
import { STAMP_TASK } from './tools/stamp';
import { ReadOnlyNotice } from './Notice';

export const DRAW_TASK = 'drawing';
export const MEASURE_TASK = 'measure';

const KINDS = ['ink', 'shape', 'line', 'poly', 'stamp', 'measure'] as const;
const KIND_LABELS: Record<(typeof KINDS)[number], [string, string]> = {
  ink: ['drawing', 'drawings'],
  shape: ['shape', 'shapes'],
  line: ['line', 'lines'],
  poly: ['polygon', 'polygons'],
  stamp: ['stamp', 'stamps'],
  measure: ['measurement', 'measurements'],
};

function ToolGrid({ ids, label }: { ids: string[]; label: string }) {
  const tools = useRegistry((s) => s.tools);
  const active = useApp((s) => s.activeToolId);
  const list = ids.map((id) => tools[id]).filter((t): t is ToolDef => !!t);
  return (
    <div className="drawing-tool-grid" role="group" aria-label={label}>
      {list.map((t) => {
        const on = active === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            className={`drawing-tool-btn${on ? ' is-active' : ''}`}
            aria-pressed={on}
            title={t.shortcut ? `${t.label} (${formatShortcut(t.shortcut)})` : t.label}
            data-testid={`drawing-panel-tool-${t.id}`}
            onClick={() => actions.setTool(on ? 'select' : t.id)}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Summary({ docId }: { docId: DocId }) {
  const objects = useDoc(docId, (d) => d?.objects);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of Object.values(objects ?? {})) c[o.kind] = (c[o.kind] ?? 0) + 1;
    return c;
  }, [objects]);
  const parts = KINDS.filter((k) => counts[k]).map((k) => `${counts[k]} ${KIND_LABELS[k][counts[k] === 1 ? 0 : 1]}`);
  return (
    <p className="drawing-panel-summary" data-testid="drawing-panel-summary">
      {parts.length ? parts.join(' · ') : 'No drawing markups in this document yet.'}
    </p>
  );
}

export function DrawPanel() {
  const docId = useApp((s) => s.activeDocId);
  return (
    <div className="drawing-panel" data-testid="drawing-draw-panel">
      <ReadOnlyNotice />
      <section className="drawing-panel-section">
        <h3 className="drawing-panel-title">Draw</h3>
        <ToolGrid ids={DRAW_TOOL_IDS} label="Drawing tools" />
        <p className="drawing-panel-tip">Strokes drawn in quick succession are grouped into one drawing. Hold Shift for a straight line.</p>
      </section>
      <section className="drawing-panel-section">
        <h3 className="drawing-panel-title">Shapes</h3>
        <ToolGrid ids={SHAPE_TOOL_IDS} label="Shape tools" />
        <p className="drawing-panel-tip">Shift draws squares, circles and 45° lines. For polygons, click to add points and double-click or press Enter to finish.</p>
      </section>
      <section className="drawing-panel-section drawing-panel-links">
        <Button size="sm" icon={Stamp} onClick={() => actions.openTask(STAMP_TASK)} data-testid="drawing-open-stamps">
          Stamps
        </Button>
        <Button size="sm" icon={Ruler} onClick={() => actions.openTask(MEASURE_TASK)} data-testid="drawing-open-measure">
          Measure
        </Button>
      </section>
      {docId && <Summary docId={docId} />}
    </div>
  );
}
