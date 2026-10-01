/**
 * Small controls shared by the floating properties bars (per object kind), the tool options bars
 * and the Comment task panel.
 */
import type { ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Blend, ChevronDown } from 'lucide-react';
import type { IconType } from '@/core/types';
import { ColorSwatchButton, Dropdown, SegmentedControl, Select, type MenuEntry } from '@/core/ui';
import { FONT_OPTIONS, FONT_SIZES } from './layout';
import { PALETTE, type FontFamily, type TextAlign } from './model';

export const OPACITIES = [1, 0.75, 0.5, 0.25];
export const BORDER_WIDTHS = [0, 0.5, 1, 2, 3, 4, 6];

export function Swatch({
  testid,
  label,
  value,
  onChange,
  allowNone,
  showLabel,
}: {
  testid: string;
  label: string;
  value: string | null;
  onChange(v: string | null): void;
  allowNone?: boolean;
  showLabel?: boolean;
}) {
  return (
    <span className="comments-swatch" data-testid={testid}>
      <ColorSwatchButton size="sm" label={label} value={value} allowNone={allowNone} palette={PALETTE} showLabel={showLabel} onChange={onChange} />
    </span>
  );
}

export function ChipDropdown({
  testid,
  label,
  icon: Icon,
  text,
  items,
  children,
}: {
  testid: string;
  label: string;
  icon?: IconType;
  text?: ReactNode;
  items: MenuEntry[] | (() => MenuEntry[]);
  children?: ReactNode;
}) {
  return (
    <Dropdown
      label={label}
      items={items}
      trigger={
        <button type="button" className="pdfwizard-props-chip comments-chip" aria-label={label} title={label} data-testid={testid}>
          {Icon && <Icon size={16} strokeWidth={1.75} />}
          {children}
          {text !== undefined && <span>{text}</span>}
          <ChevronDown size={12} strokeWidth={2} className="comments-chip-chevron" />
        </button>
      }
    />
  );
}

export function OpacityChip({ testid, value, onChange }: { testid: string; value: number; onChange(v: number): void }) {
  return (
    <ChipDropdown
      testid={testid}
      label="Opacity"
      icon={Blend}
      text={`${Math.round(value * 100)}%`}
      items={OPACITIES.map((v) => ({
        id: `comments-opacity-${v}`,
        label: `${Math.round(v * 100)}%`,
        checked: Math.abs(v - value) < 0.01,
        run: () => onChange(v),
      }))}
    />
  );
}

export function BorderChip({ testid, value, onChange }: { testid: string; value: number; onChange(v: number): void }) {
  return (
    <ChipDropdown
      testid={testid}
      label="Border width"
      text={value === 0 ? 'None' : `${value} pt`}
      items={BORDER_WIDTHS.map((w) => ({
        id: `comments-border-${w}`,
        label: w === 0 ? 'No border' : `${w} pt`,
        checked: Math.abs(w - value) < 1e-6,
        run: () => onChange(w),
      }))}
    >
      <span className="pdfwizard-props-stroke" style={{ height: Math.max(1, Math.min(6, value || 1)), opacity: value ? 1 : 0.3 }} />
    </ChipDropdown>
  );
}

const ALIGN_OPTIONS: { value: TextAlign; icon: IconType; title: string }[] = [
  { value: 'left', icon: AlignLeft, title: 'Align left' },
  { value: 'center', icon: AlignCenter, title: 'Align center' },
  { value: 'right', icon: AlignRight, title: 'Align right' },
];

/** Font family / size / alignment controls of text boxes and callouts. */
export function FontControls({
  prefix,
  font,
  fontSize,
  align,
  onChange,
}: {
  prefix: string;
  font: FontFamily;
  fontSize: number;
  align: TextAlign;
  onChange(patch: Partial<{ font: FontFamily; fontSize: number; align: TextAlign }>): void;
}) {
  const sizes = FONT_SIZES.includes(fontSize) ? FONT_SIZES : [...FONT_SIZES, fontSize].sort((a, b) => a - b);
  return (
    <>
      <Select
        size="sm"
        aria-label="Font"
        value={font}
        options={FONT_OPTIONS}
        onChange={(v) => onChange({ font: v as FontFamily })}
        data-testid={`${prefix}-font`}
        className="comments-font-select"
      />
      <Select
        size="sm"
        aria-label="Font size"
        value={fontSize}
        options={sizes.map((s) => ({ value: s, label: `${Math.round(s * 10) / 10}` }))}
        onChange={(v) => onChange({ fontSize: Number(v) })}
        data-testid={`${prefix}-size`}
        className="comments-size-select"
      />
      <span data-testid={`${prefix}-align`} className="comments-align">
        <SegmentedControl size="sm" label="Alignment" value={align} options={ALIGN_OPTIONS} onChange={(v) => onChange({ align: v })} />
      </span>
    </>
  );
}
