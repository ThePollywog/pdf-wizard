/**
 * Shared style controls used by the tool options bars and the floating properties bars
 * (color, fill, line width, opacity, line style, line endings, cloud intensity).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Blend, ChevronDown } from 'lucide-react';
import { ColorSwatchButton, Dropdown, type MenuEntry } from '@/core/ui';
import { LINE_ENDING_LABELS, LINE_ENDINGS, OPACITIES, STROKE_WIDTHS, type LineEnding, type StrokeStyle } from './model';
import { dashFor, endingPaints } from './looks';
import { PaintSvg } from './svg';
import type { Paint } from './paint';
import { cloudSegs, polySegs } from './geom';

interface Base {
  testid: string;
}

export function ColorControl({ value, onChange, label = 'Color', testid, allowNone }: Base & { value: string | null; onChange(v: string | null): void; label?: string; allowNone?: boolean }) {
  return (
    <div className="drawing-ctl" data-testid={testid}>
      <ColorSwatchButton size="sm" label={label} value={value} allowNone={allowNone} onChange={onChange} />
    </div>
  );
}

/** Dropdown trigger; `rest` carries the handlers/ARIA state that Dropdown clones onto its trigger. */
function Chip({ testid, label, children, wide, ...rest }: { testid: string; label: string; children: ReactNode; wide?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`drawing-chip${wide ? ' is-wide' : ''}`} aria-label={label} title={label} data-testid={testid}>
      {children}
      <ChevronDown size={12} strokeWidth={2} className="drawing-chip-caret" />
    </button>
  );
}

const fmtW = (w: number) => `${Number(w.toFixed(2))} pt`;

export function WidthControl({ value, onChange, testid, widths = STROKE_WIDTHS, label = 'Line thickness', allowZero }: Base & { value: number; onChange(v: number): void; widths?: number[]; label?: string; allowZero?: boolean }) {
  const list = allowZero ? [0, ...widths] : widths;
  const items: MenuEntry[] = list.map((w) => ({
    id: `drawing-w-${w}`,
    label: w === 0 ? 'No border' : fmtW(w),
    checked: Math.abs(w - value) < 1e-6,
    run: () => onChange(w),
  }));
  return (
    <Dropdown
      label={label}
      items={items}
      trigger={
        <Chip testid={testid} label={label}>
          <span className="drawing-chip-stroke" style={{ height: Math.max(1, Math.min(10, value)) }} />
          <span>{value === 0 ? 'None' : fmtW(value)}</span>
        </Chip>
      }
    />
  );
}

export function OpacityControl({ value, onChange, testid, values = OPACITIES }: Base & { value: number; onChange(v: number): void; values?: number[] }) {
  const list = values.some((v) => Math.abs(v - value) < 0.01) ? values : [...values, value].sort((a, b) => b - a);
  return (
    <Dropdown
      label="Opacity"
      items={list.map((v) => ({ id: `drawing-op-${Math.round(v * 100)}`, label: `${Math.round(v * 100)}%`, checked: Math.abs(v - value) < 0.01, run: () => onChange(v) }))}
      trigger={
        <Chip testid={testid} label="Opacity">
          <Blend size={15} strokeWidth={1.75} />
          <span>{Math.round(value * 100)}%</span>
        </Chip>
      }
    />
  );
}

const STYLE_LABEL: Record<StrokeStyle, string> = { solid: 'Solid', dashed: 'Dashed', cloudy: 'Cloudy' };

function StylePreview({ style }: { style: StrokeStyle }) {
  const paints: Paint[] =
    style === 'cloudy'
      ? [{ t: 'path', segs: cloudSegs([{ x: 2, y: 3 }, { x: 34, y: 3 }, { x: 34, y: 11 }, { x: 2, y: 11 }], 0.5).slice(0), stroke: 'currentColor', width: 1.2, join: 'round' }]
      : [{ t: 'path', segs: polySegs([{ x: 2, y: 7 }, { x: 34, y: 7 }]), stroke: 'currentColor', width: 2, dash: style === 'dashed' ? dashFor(1.3) : undefined }];
  return (
    <span className="drawing-preview-icon is-style">
      <PaintSvg paints={paints} m={[1, 0, 0, -1, 0, 14]} />
    </span>
  );
}

export function StyleControl({ value, onChange, testid, options }: Base & { value: StrokeStyle; onChange(v: StrokeStyle): void; options: StrokeStyle[] }) {
  return (
    <Dropdown
      label="Line style"
      items={options.map((s) => ({ id: `drawing-style-${s}`, label: STYLE_LABEL[s], checked: s === value, run: () => onChange(s) }))}
      trigger={
        <Chip testid={testid} label="Line style">
          <StylePreview style={value} />
          <span>{STYLE_LABEL[value]}</span>
        </Chip>
      }
    />
  );
}

export function IntensityControl({ value, onChange, testid }: Base & { value: number; onChange(v: number): void }) {
  const opts = [
    { v: 1, label: 'Small scallops' },
    { v: 2, label: 'Large scallops' },
  ];
  return (
    <Dropdown
      label="Cloud intensity"
      items={opts.map((o) => ({ id: `drawing-intensity-${o.v}`, label: o.label, checked: Math.round(value) === o.v, run: () => onChange(o.v) }))}
      trigger={
        <Chip testid={testid} label="Cloud intensity">
          <span>{Math.round(value) >= 2 ? 'Large' : 'Small'}</span>
        </Chip>
      }
    />
  );
}

/** Small preview of a line ending; `side` 0 = start (left), 1 = end (right). */
export function EndingIcon({ kind, side, w = 34 }: { kind: LineEnding; side: 0 | 1; w?: number }) {
  const s = w < 24 ? 6 : 8;
  const a = { x: s / 2 + 1, y: 7 }, b = { x: w - s / 2 - 1, y: 7 };
  const tip = side === 0 ? a : b;
  const dir = side === 0 ? { x: -1, y: 0 } : { x: 1, y: 0 };
  const e = endingPaints(kind, tip, dir, 1.3, 'currentColor', 'currentColor', s);
  const shift = Math.min(e.inset, s);
  const from = side === 0 ? { x: a.x + shift, y: 7 } : { x: 0, y: 7 };
  const to = side === 0 ? { x: w, y: 7 } : { x: b.x - shift, y: 7 };
  const line: Paint = { t: 'path', segs: polySegs([from, to]), stroke: 'currentColor', width: 1.3 };
  return (
    <span className="drawing-preview-icon" style={{ width: w }}>
      <PaintSvg paints={[line, ...e.paints]} m={[1, 0, 0, -1, 0, 14]} />
    </span>
  );
}

const menuIcon = (kind: LineEnding, side: 0 | 1) => {
  const C = () => <EndingIcon kind={kind} side={side} w={18} />;
  C.displayName = `EndingIcon${side}${kind}`;
  return C;
};
const MENU_ICONS: Record<0 | 1, Record<LineEnding, () => ReactNode>> = {
  0: Object.fromEntries(LINE_ENDINGS.map((k) => [k, menuIcon(k, 0)])) as unknown as Record<LineEnding, () => ReactNode>,
  1: Object.fromEntries(LINE_ENDINGS.map((k) => [k, menuIcon(k, 1)])) as unknown as Record<LineEnding, () => ReactNode>,
};

export function EndingControl({ value, onChange, side, testid }: Base & { value: LineEnding; onChange(v: LineEnding): void; side: 0 | 1 }) {
  const label = side === 0 ? 'Line start' : 'Line end';
  return (
    <Dropdown
      label={label}
      minWidth={200}
      items={LINE_ENDINGS.map((k) => ({
        id: `drawing-${side === 0 ? 'start' : 'end'}-${k}`,
        label: LINE_ENDING_LABELS[k],
        checked: k === value,
        icon: MENU_ICONS[side][k],
        run: () => onChange(k),
      }))}
      trigger={
        <Chip testid={testid} label={label}>
          <EndingIcon kind={value} side={side} />
        </Chip>
      }
    />
  );
}

export function Sep() {
  return <span className="drawing-sep" aria-hidden="true" />;
}
