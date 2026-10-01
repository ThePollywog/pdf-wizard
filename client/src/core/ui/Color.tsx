import { useEffect, useRef, useState } from 'react';
import { Ban, Check, ChevronDown, Pipette, Plus } from 'lucide-react';
import { Popover } from './Popover';
import { Tooltip } from './Tooltip';

export const DEFAULT_PALETTE = ['#000000', '#ffffff', '#e34850', '#f29423', '#ffd426', '#2dc653', '#1473e6', '#7e4cc7', '#e84a9a', '#6e6e6e'];

/** Extended palette shown below the main swatches. */
const EXTRA = ['#4b4b4b', '#b3b3b3', '#fce8e8', '#fff3cf', '#e3f6e5', '#e0efff', '#efe6fb', '#8a1b1b', '#0d5f3c', '#0b3f8c'];

const RECENT_KEY = 'pdfwizard.recentColors';
function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}
function pushRecent(c: string) {
  const list = [c, ...loadRecent().filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function normalizeHex(v: string): string | null {
  const m = v.trim().match(HEX_RE);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h}`;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

function Swatch({ color, selected, onClick, label }: { color: string | null; selected: boolean; onClick(): void; label: string }) {
  const light = color ? isLight(color) : true;
  return (
    <Tooltip label={label} delay={700}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={label}
        className={`swatch${selected ? ' is-selected' : ''}${color === null ? ' is-none' : ''}${light ? ' is-light' : ''}`}
        style={color ? { background: color } : undefined}
        onClick={onClick}
      >
        {color === null && <Ban size={14} strokeWidth={2} />}
        {selected && color !== null && <Check size={12} strokeWidth={3} color={light ? '#222' : '#fff'} />}
      </button>
    </Tooltip>
  );
}

export function isLight(hex: string): boolean {
  const h = normalizeHex(hex);
  if (!h) return true;
  const n = parseInt(h.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}

/** Swatch grid + recent colours + custom colour input + hex field. */
export function ColorPicker({
  value,
  onChange,
  palette = DEFAULT_PALETTE,
  allowNone,
  showCustom = true,
  showRecent = true,
  onCommit,
}: {
  value: string | null;
  onChange(hex: string | null): void;
  palette?: string[];
  allowNone?: boolean;
  showCustom?: boolean;
  showRecent?: boolean;
  /** Called after a discrete choice (swatch click / Enter in the hex field), e.g. to close a popover. */
  onCommit?(): void;
}) {
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [hex, setHex] = useState(value ?? '');
  const colorInput = useRef<HTMLInputElement>(null);
  useEffect(() => setHex(value ?? ''), [value]);

  const pick = (c: string | null, remember = false, commit = true) => {
    if (c && remember && !palette.some((p) => same(p, c))) {
      pushRecent(c);
      setRecent(loadRecent());
    }
    if (!same(c, value) || c === null) onChange(c);
    if (commit) onCommit?.();
  };
  const extras = palette === DEFAULT_PALETTE ? EXTRA : [];
  const recentShown = recent.filter((c) => !palette.some((p) => same(p, c)) && !extras.some((p) => same(p, c))).slice(0, 8);

  return (
    <div className="color-picker">
      <div className="swatch-grid" role="radiogroup" aria-label="Colors">
        {allowNone && <Swatch color={null} selected={value === null} onClick={() => pick(null)} label="No color" />}
        {palette.map((c) => (
          <Swatch key={c} color={c} selected={same(value, c)} onClick={() => pick(c)} label={c} />
        ))}
        {extras.map((c) => (
          <Swatch key={c} color={c} selected={same(value, c)} onClick={() => pick(c)} label={c} />
        ))}
      </div>
      {showRecent && recentShown.length > 0 && (
        <>
          <div className="color-picker-caption">Recent</div>
          <div className="swatch-grid">
            {recentShown.map((c) => (
              <Swatch key={c} color={c} selected={same(value, c)} onClick={() => pick(c)} label={c} />
            ))}
          </div>
        </>
      )}
      {showCustom && (
        <div className="color-picker-custom">
          <button type="button" className="swatch swatch-custom" aria-label="Custom color" onClick={() => colorInput.current?.click()}>
            <Plus size={14} strokeWidth={2.25} />
          </button>
          <input
            ref={colorInput}
            type="color"
            className="sr-only-input"
            tabIndex={-1}
            value={normalizeHex(value ?? '') ?? '#000000'}
            onChange={(e) => onChange(e.target.value)}
            onBlur={(e) => pick(e.target.value, true, false)}
          />
          <div className="input-wrap input-sm color-hex">
            <span className="color-hex-preview" style={{ background: normalizeHex(hex) ?? 'transparent' }} />
            <input
              className="input"
              aria-label="Hex color"
              value={hex}
              placeholder="#000000"
              spellCheck={false}
              onChange={(e) => setHex(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const n = normalizeHex(hex);
                  if (n) pick(n, true);
                }
              }}
              onBlur={() => {
                const n = normalizeHex(hex);
                if (n && !same(n, value)) pick(n, true, false);
                else setHex(value ?? '');
              }}
            />
          </div>
          {'EyeDropper' in window && (
            <Tooltip label="Pick a color from the screen">
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="Eyedropper"
                onClick={async () => {
                  try {
                    const ed = new (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper();
                    const r = await ed.open();
                    const n = normalizeHex(r.sRGBHex);
                    if (n) pick(n, true);
                  } catch {
                    /* cancelled */
                  }
                }}
              >
                <Pipette size={16} strokeWidth={1.75} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/** Button showing the current colour that opens a ColorPicker popover. */
export function ColorSwatchButton({
  value,
  onChange,
  label = 'Color',
  allowNone,
  palette,
  showLabel,
  disabled,
  size = 'md',
}: {
  value: string | null;
  onChange(hex: string | null): void;
  label?: string;
  allowNone?: boolean;
  palette?: string[];
  /** Show the label text next to the swatch. */
  showLabel?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const btn = (
    <button
      ref={ref}
      type="button"
      className={`color-swatch-btn color-swatch-btn-${size}${open ? ' is-open' : ''}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((o) => !o)}
    >
      <span className={`color-swatch-btn-chip${value === null ? ' is-none' : ''}`} style={value ? { background: value } : undefined} />
      {showLabel && <span className="color-swatch-btn-label">{label}</span>}
      <ChevronDown size={12} strokeWidth={2} className="color-swatch-btn-chevron" />
    </button>
  );
  return (
    <>
      {showLabel ? btn : <Tooltip label={label} side="bottom">{btn}</Tooltip>}
      <Popover open={open} anchor={ref.current} onClose={() => setOpen(false)} placement="bottom-start" className="color-popover" aria-label={label}>
        <ColorPicker
          value={value}
          allowNone={allowNone}
          palette={palette}
          onChange={onChange}
          onCommit={() => {
            setOpen(false);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      </Popover>
    </>
  );
}
