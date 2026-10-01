/** Tool options bars (secondary toolbar) of the drawing, shape, measure and stamp tools. */
import { useLayoutEffect, useRef } from 'react';
import { ChevronDown, Ruler, Stamp as StampIcon } from 'lucide-react';
import { actions, useToolOptions } from '@/core/store';
import { Button, Dropdown, SegmentedControl, Switch } from '@/core/ui';
import {
  ARROW_DEFAULTS, ERASER_DEFAULTS, HIGHLIGHT_WIDTHS, HIGHLIGHTER_DEFAULTS, LINE_DEFAULTS, MEASURE_OPTS_KEY, PEN_DEFAULTS, SHAPE_DEFAULTS,
  type LineEnding, type StrokeStyle,
} from '../model';
import { ColorControl, EndingControl, IntensityControl, OpacityControl, Sep, StyleControl, WidthControl } from '../controls';
import { ERASER_TOOL } from './eraser';
import { HIGHLIGHTER_TOOL, PEN_TOOL } from './pen';
import { ARROW_TOOL } from './shapes';
import { CLOUD_DEFAULTS, CLOUD_TOOL, POLYGON_DEFAULTS, POLYLINE_DEFAULTS, POLYLINE_TOOL, PolyHint } from './poly';
import { useMeasureLive, useMeasureOptions } from '../measure/live';
import { ratioString } from '../measure/scale';
import { editScale } from '../types/measure';
import { stampLabelFor, useCurrentStamp, useCustomStamps } from '../stamps/custom';
import { STAMP_TASK } from './stamp';

const set = (toolId: string, key: string) => (v: unknown) => actions.setToolOption(toolId, key, v);

/**
 * The secondary toolbar scrolls horizontally when the task's tool chips don't fit: when a tool is
 * picked, bring its options into view (keeping as many chips visible as possible).
 */
function revealInRow(el: HTMLElement) {
  const row = el.closest<HTMLElement>('.tool-options');
  if (!row || row.scrollWidth <= row.clientWidth) return;
  const r = row.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  let dx = 0;
  if (b.right > r.right - 8) dx = b.right - r.right + 12;
  else if (b.left < r.left) dx = b.left - r.left - 12;
  if (!dx) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  row.scrollTo({ left: row.scrollLeft + dx, behavior: reduce ? 'auto' : 'smooth' });
}

function Bar({ children, testid }: { children: React.ReactNode; testid: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) revealInRow(ref.current);
  }, []);
  return (
    <div ref={ref} className="drawing-options" data-testid={testid}>
      {children}
    </div>
  );
}

// ── ink ──────────────────────────────────────────────────────────────────────
export function PenOptions() {
  const o = useToolOptions(PEN_TOOL, PEN_DEFAULTS);
  return (
    <Bar testid="drawing-options-pen">
      <ColorControl testid="drawing-opt-color" value={o.color} onChange={(c) => c && set(PEN_TOOL, 'color')(c)} />
      <WidthControl testid="drawing-opt-width" value={o.width} onChange={set(PEN_TOOL, 'width')} />
      <OpacityControl testid="drawing-opt-opacity" value={o.opacity} onChange={set(PEN_TOOL, 'opacity')} />
      <Sep />
      <span className="drawing-hint">Strokes drawn in a row become one drawing · Shift draws a straight line</span>
    </Bar>
  );
}

export function HighlighterOptions() {
  const o = useToolOptions(HIGHLIGHTER_TOOL, HIGHLIGHTER_DEFAULTS);
  return (
    <Bar testid="drawing-options-highlighter">
      <ColorControl testid="drawing-opt-color" value={o.color} onChange={(c) => c && set(HIGHLIGHTER_TOOL, 'color')(c)} />
      <WidthControl testid="drawing-opt-width" value={o.width} widths={HIGHLIGHT_WIDTHS} onChange={set(HIGHLIGHTER_TOOL, 'width')} />
      <OpacityControl testid="drawing-opt-opacity" value={o.opacity} onChange={set(HIGHLIGHTER_TOOL, 'opacity')} />
    </Bar>
  );
}

const ERASER_SIZES = [6, 12, 20, 32, 48];
export function EraserOptions() {
  const o = useToolOptions(ERASER_TOOL, ERASER_DEFAULTS);
  return (
    <Bar testid="drawing-options-eraser">
      <Dropdown
        label="Eraser size"
        items={ERASER_SIZES.map((s) => ({ id: `drawing-eraser-size-${s}`, label: `${s} px`, checked: s === o.size, run: () => set(ERASER_TOOL, 'size')(s) }))}
        trigger={
          <button type="button" className="drawing-chip" data-testid="drawing-opt-eraser-size" aria-label="Eraser size" title="Eraser size">
            <span className="drawing-eraser-dot" style={{ width: Math.min(14, o.size / 3 + 4), height: Math.min(14, o.size / 3 + 4) }} />
            <span>{o.size} px</span>
            <ChevronDown size={12} strokeWidth={2} className="drawing-chip-caret" />
          </button>
        }
      />
      <span data-testid="drawing-opt-eraser-mode" className="drawing-seg">
        <SegmentedControl
          size="sm"
          label="Eraser mode"
          value={o.mode}
          onChange={set(ERASER_TOOL, 'mode')}
          options={[
            { value: 'partial', label: 'Partial', title: 'Erase only what the eraser touches' },
            { value: 'whole', label: 'Whole stroke', title: 'Erase entire strokes' },
          ]}
        />
      </span>
    </Bar>
  );
}

// ── shapes ───────────────────────────────────────────────────────────────────
export function ShapeOptions({ toolId }: { toolId: string }) {
  const o = useToolOptions(toolId, SHAPE_DEFAULTS);
  return (
    <Bar testid="drawing-options-shape">
      <ColorControl testid="drawing-opt-color" label="Border color" value={o.color} onChange={(c) => c && set(toolId, 'color')(c)} />
      <ColorControl testid="drawing-opt-fill" label="Fill color" allowNone value={o.fill} onChange={set(toolId, 'fill')} />
      <WidthControl testid="drawing-opt-width" allowZero value={o.width} onChange={set(toolId, 'width')} />
      <StyleControl testid="drawing-opt-style" value={o.style} options={['solid', 'dashed', 'cloudy']} onChange={set(toolId, 'style')} />
      {o.style === 'cloudy' && <IntensityControl testid="drawing-opt-intensity" value={o.intensity} onChange={set(toolId, 'intensity')} />}
      <OpacityControl testid="drawing-opt-opacity" value={o.opacity} onChange={set(toolId, 'opacity')} />
      <Sep />
      <span className="drawing-hint">Drag to draw · Shift keeps proportions · Alt draws from the center</span>
    </Bar>
  );
}

export function LineOptions({ toolId }: { toolId: string }) {
  const o = useToolOptions(toolId, toolId === ARROW_TOOL ? ARROW_DEFAULTS : LINE_DEFAULTS);
  return (
    <Bar testid="drawing-options-line">
      <ColorControl testid="drawing-opt-color" value={o.color} onChange={(c) => c && set(toolId, 'color')(c)} />
      <WidthControl testid="drawing-opt-width" value={o.width} onChange={set(toolId, 'width')} />
      <StyleControl testid="drawing-opt-style" value={o.style} options={['solid', 'dashed']} onChange={set(toolId, 'style')} />
      <EndingControl testid="drawing-opt-start" side={0} value={o.start} onChange={set(toolId, 'start')} />
      <EndingControl testid="drawing-opt-end" side={1} value={o.end} onChange={set(toolId, 'end')} />
      <OpacityControl testid="drawing-opt-opacity" value={o.opacity} onChange={set(toolId, 'opacity')} />
      <Sep />
      <span className="drawing-hint">Shift snaps to 45°</span>
    </Bar>
  );
}

export function PolyOptions({ toolId }: { toolId: string }) {
  const polyline = toolId === POLYLINE_TOOL;
  const cloud = toolId === CLOUD_TOOL;
  const o = useToolOptions(toolId, polyline ? { ...POLYLINE_DEFAULTS, fill: null as string | null, intensity: 1 } : cloud ? { ...CLOUD_DEFAULTS, start: 'None' as LineEnding, end: 'None' as LineEnding } : { ...POLYGON_DEFAULTS, start: 'None' as LineEnding, end: 'None' as LineEnding });
  const style = (cloud ? 'cloudy' : o.style) as StrokeStyle;
  return (
    <Bar testid="drawing-options-poly">
      <ColorControl testid="drawing-opt-color" value={o.color} onChange={(c) => c && set(toolId, 'color')(c)} />
      {!polyline && <ColorControl testid="drawing-opt-fill" label="Fill color" allowNone value={o.fill} onChange={set(toolId, 'fill')} />}
      <WidthControl testid="drawing-opt-width" value={o.width} onChange={set(toolId, 'width')} />
      {!cloud && <StyleControl testid="drawing-opt-style" value={style} options={polyline ? ['solid', 'dashed'] : ['solid', 'dashed', 'cloudy']} onChange={set(toolId, 'style')} />}
      {style === 'cloudy' && <IntensityControl testid="drawing-opt-intensity" value={o.intensity} onChange={set(toolId, 'intensity')} />}
      {polyline && <EndingControl testid="drawing-opt-start" side={0} value={o.start} onChange={set(toolId, 'start')} />}
      {polyline && <EndingControl testid="drawing-opt-end" side={1} value={o.end} onChange={set(toolId, 'end')} />}
      <OpacityControl testid="drawing-opt-opacity" value={o.opacity} onChange={set(toolId, 'opacity')} />
      <Sep />
      <PolyHint toolId={toolId} />
    </Bar>
  );
}

// ── measure ──────────────────────────────────────────────────────────────────
const setM = (key: string) => (v: unknown) => actions.setToolOption(MEASURE_OPTS_KEY, key, v);

export function ScaleChip({ testid = 'drawing-opt-scale' }: { testid?: string }) {
  const o = useMeasureOptions();
  return (
    <button
      type="button"
      className="drawing-chip is-wide"
      data-testid={testid}
      title="Scale ratio"
      aria-label="Scale ratio"
      onClick={async () => {
        const s = await editScale(o);
        if (!s) return;
        setM('docValue')(s.docValue);
        setM('docUnit')(s.docUnit);
        setM('realValue')(s.realValue);
        setM('realUnit')(s.realUnit);
      }}
    >
      <Ruler size={14} strokeWidth={1.75} />
      <span>{ratioString(o)}</span>
    </button>
  );
}

export function MeasureReadout({ testid = 'drawing-measure-readout' }: { testid?: string }) {
  const live = useMeasureLive((s) => s.text);
  return (
    <span className={`drawing-readout${live ? ' is-live' : ''}`} data-testid={testid} aria-live="polite">
      {live ?? '—'}
    </span>
  );
}

export function MeasureOptions({ toolId }: { toolId: string }) {
  const o = useMeasureOptions();
  return (
    <Bar testid="drawing-options-measure">
      <ScaleChip />
      <Dropdown
        label="Precision"
        items={[0, 1, 2, 3, 4].map((p) => ({ id: `drawing-precision-${p}`, label: (1).toFixed(p), checked: p === o.precision, run: () => setM('precision')(p) }))}
        trigger={
          <button type="button" className="drawing-chip" data-testid="drawing-opt-precision" title="Precision" aria-label="Precision">
            <span>{(0).toFixed(o.precision)}</span>
            <ChevronDown size={12} strokeWidth={2} className="drawing-chip-caret" />
          </button>
        }
      />
      <ColorControl testid="drawing-opt-color" value={o.color} onChange={(c) => c && setM('color')(c)} />
      <span data-testid="drawing-opt-snap" className="drawing-switch">
        <Switch label="Snap" checked={o.snap} onChange={setM('snap')} aria-label="Snap to points" />
      </span>
      <Sep />
      <MeasureReadout />
      {toolId !== 'measure-distance' ? <PolyHint toolId={toolId} /> : <span className="drawing-hint">Drag, or click the start and end points</span>}
    </Bar>
  );
}

// ── stamp ────────────────────────────────────────────────────────────────────
export function StampOptions() {
  const ref = useCurrentStamp();
  useCustomStamps((s) => s.list);
  return (
    <Bar testid="drawing-options-stamp">
      <span className="drawing-current-stamp" data-testid="drawing-current-stamp">
        <StampIcon size={14} strokeWidth={1.75} />
        {stampLabelFor(ref)}
      </span>
      <Button size="sm" variant="secondary" onClick={() => actions.openTask(STAMP_TASK)} data-testid="drawing-opt-choose-stamp">
        Choose stamp…
      </Button>
      <Sep />
      <span className="drawing-hint">{ref ? 'Click to place · Drag to size' : 'Pick a stamp in the Stamps panel'}</span>
    </Bar>
  );
}
