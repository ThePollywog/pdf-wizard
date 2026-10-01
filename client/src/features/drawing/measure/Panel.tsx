/**
 * Left panel of the "Measure" task: measuring tools, the scale ratio, precision and snapping,
 * the live readout and the list of measurements in the document (with CSV export).
 */
import { useMemo } from 'react';
import { Download, Hexagon, MoveHorizontal, RefreshCw, Ruler, Spline } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, getActiveDoc, pageIndexOf, useApp, useDoc } from '@/core/store';
import { downloadBlob } from '@/core/util';
import { Button, EmptyState, NumberField, Select, Switch, confirmDialog } from '@/core/ui';
import { DOC_UNITS, MEASURE_OPTS_KEY, REAL_UNITS, type DocUnit, type MeasureObject, type RealUnit } from '../model';
import { MEASURE_NAMES, measurePatch, measureText } from '../types/measure';
import { canDraw } from '../common';
import { DISTANCE_TOOL } from '../tools/measure';
import { AREA_TOOL, PERIMETER_TOOL } from '../tools/poly';
import { MeasureReadout } from '../tools/options';
import { getMeasureOptions, scaleOf, useMeasureOptions } from './live';
import { ratioString } from './scale';
import { ReadOnlyNotice } from '../Notice';

const setM = (key: string, v: unknown) => actions.setToolOption(MEASURE_OPTS_KEY, key, v);

const TOOLS = [
  { id: DISTANCE_TOOL, label: 'Distance', icon: MoveHorizontal, key: 'distance' },
  { id: PERIMETER_TOOL, label: 'Perimeter', icon: Spline, key: 'perimeter' },
  { id: AREA_TOOL, label: 'Area', icon: Hexagon, key: 'area' },
];

function ToolButtons() {
  const tool = useApp((s) => s.activeToolId);
  return (
    <div className="drawing-tool-grid" role="group" aria-label="Measuring tools">
      {TOOLS.map((t) => {
        const active = tool === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            className={`drawing-tool-btn${active ? ' is-active' : ''}`}
            aria-pressed={active}
            title={`${t.label} (M)`}
            data-testid={`drawing-measure-tool-${t.key}`}
            onClick={() => actions.setTool(active ? 'select' : t.id)}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ScaleFields() {
  const o = useMeasureOptions();
  return (
    <div className="drawing-scale" data-testid="drawing-measure-scale">
      <div className="drawing-scale-ratio">
        <span className="drawing-scale-label" aria-hidden="true">Page</span>
        <span className="drawing-scale-field" data-testid="drawing-scale-doc-value">
          <NumberField size="sm" value={o.docValue} min={0.0001} step={0.01} precision={4} width="100%" aria-label="Page distance" onChange={(v) => v > 0 && setM('docValue', v)} />
        </span>
        <Select<DocUnit>
          size="sm"
          width="100%"
          value={o.docUnit}
          options={DOC_UNITS.map((u) => ({ value: u, label: u }))}
          onChange={(v) => setM('docUnit', v)}
          aria-label="Page unit"
          data-testid="drawing-scale-doc-unit"
        />
        <span className="drawing-scale-label" aria-hidden="true">Real world</span>
        <span className="drawing-scale-field" data-testid="drawing-scale-real-value">
          <NumberField size="sm" value={o.realValue} min={0.0001} step={0.01} precision={4} width="100%" aria-label="Real-world distance" onChange={(v) => v > 0 && setM('realValue', v)} />
        </span>
        <Select<RealUnit>
          size="sm"
          width="100%"
          value={o.realUnit}
          options={REAL_UNITS.map((u) => ({ value: u, label: u }))}
          onChange={(v) => setM('realUnit', v)}
          aria-label="Real-world unit"
          data-testid="drawing-scale-real-unit"
        />
      </div>
      <div className="drawing-scale-row">
        <Select<number>
          size="sm"
          label="Precision"
          inline
          value={o.precision}
          options={[0, 1, 2, 3, 4].map((p) => ({ value: p, label: (0).toFixed(p) }))}
          onChange={(v) => setM('precision', Number(v))}
          data-testid="drawing-measure-precision"
        />
        <span data-testid="drawing-measure-snap">
          <Switch label="Snap to points" checked={o.snap} onChange={(v) => setM('snap', v)} />
        </span>
      </div>
    </div>
  );
}

function csvCell(s: string) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(docId: DocId) {
  const doc = getActiveDoc();
  if (!doc || doc.id !== docId) return;
  const rows = [['Type', 'Page', 'Value', 'Unit', 'Scale', 'Author', 'Comment']];
  for (const id of doc.order) {
    const o = doc.objects[id];
    if (o?.kind !== 'measure') continue;
    const m = o as MeasureObject;
    const page = doc.pages[pageIndexOf(doc, m.pageId)];
    const [num, ...unit] = measureText(m.data).split(' ');
    rows.push([MEASURE_NAMES[m.data.type], page?.label ?? String(pageIndexOf(doc, m.pageId) + 1), num, unit.join(' '), ratioString(m.data.scale), m.author, m.contents ?? '']);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `${doc.name.replace(/\.pdf$/i, '')} measurements.csv`, 'text/csv');
}

async function applyScaleToAll(docId: DocId, list: MeasureObject[]) {
  if (!canDraw(docId)) return;
  const opts = getMeasureOptions();
  const scale = scaleOf(opts);
  const ok = await confirmDialog({
    title: 'Apply scale to all measurements',
    message: `Recalculate ${list.length} measurement${list.length === 1 ? '' : 's'} with the scale ${ratioString(scale)}?`,
    confirmLabel: 'Apply',
  });
  if (!ok) return;
  const patches: Record<string, Partial<MeasureObject>> = {};
  for (const m of list) patches[m.id] = measurePatch(m, { scale, precision: opts.precision });
  actions.updateObjects(docId, patches, { label: 'Change scale' });
  actions.toast('Scale applied', { kind: 'success' });
}

function MeasurementList({ docId }: { docId: DocId }) {
  const objects = useDoc(docId, (d) => d?.objects);
  const order = useDoc(docId, (d) => d?.order);
  const selection = useDoc(docId, (d) => d?.selection);
  const pages = useDoc(docId, (d) => d?.pages);
  const list = useMemo(
    () => (order && objects ? order.map((id) => objects[id]).filter((o): o is MeasureObject => o?.kind === 'measure') : []),
    [objects, order],
  );
  if (!list.length)
    return <EmptyState compact icon={Ruler} title="No measurements yet" description="Choose a tool above and click on the page to measure." />;
  const pageIndex = (pageId: string) => pages?.findIndex((p) => p.id === pageId) ?? -1;
  return (
    <>
      <ul className="drawing-measure-list" data-testid="drawing-measure-list">
        {list.map((m) => {
          const idx = pageIndex(m.pageId);
          const sel = selection?.includes(m.id);
          return (
            <li key={m.id}>
              <button
                type="button"
                className={`drawing-measure-item${sel ? ' is-selected' : ''}`}
                data-testid={`drawing-measure-item-${m.id}`}
                onClick={() => {
                  if (idx < 0) return;
                  actions.setTool('select');
                  actions.goToPage(docId, idx, { rect: m.rect });
                  actions.setSelection(docId, [m.id]);
                }}
              >
                <span className="drawing-measure-item-type">{MEASURE_NAMES[m.data.type]}</span>
                <span className="drawing-measure-item-value">{measureText(m.data)}</span>
                <span className="drawing-measure-item-page">p. {pages?.[idx]?.label ?? idx + 1}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="drawing-panel-actions">
        <Button size="sm" icon={Download} onClick={() => exportCsv(docId)} data-testid="drawing-measure-export">
          Export CSV
        </Button>
        <Button size="sm" icon={RefreshCw} onClick={() => void applyScaleToAll(docId, list)} data-testid="drawing-measure-apply-scale">
          Apply scale to all
        </Button>
      </div>
    </>
  );
}

export function MeasurePanel() {
  const docId = useApp((s) => s.activeDocId);
  return (
    <div className="drawing-panel drawing-measure-panel" data-testid="drawing-measure-panel">
      <ReadOnlyNotice />
      <ToolButtons />
      <section className="drawing-panel-section">
        <h3 className="drawing-panel-title">Scale ratio</h3>
        <ScaleFields />
      </section>
      <section className="drawing-panel-section">
        <h3 className="drawing-panel-title">Measurement</h3>
        <div className="drawing-readout-box">
          <MeasureReadout testid="drawing-panel-readout" />
        </div>
      </section>
      <section className="drawing-panel-section">
        <h3 className="drawing-panel-title">In this document</h3>
        {docId ? <MeasurementList docId={docId} /> : null}
      </section>
    </div>
  );
}
